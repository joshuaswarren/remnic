/**
 * Capture-time processing pipeline (pure, hardware-free). A raw candidate —
 * frontmost app/window plus either an AX tree or pre-extracted text — is turned
 * into a decision: dropped by a deny rule, skipped (OCR unavailable / deduped),
 * or a fully-formed spool snapshot. The steps, in order:
 *
 *   1. Deny-lists FIRST — a match records NOTHING (not even metadata).
 *   2. Text: pre-extracted text is used as-is; otherwise the AX tree is walked
 *      (secure fields + off-screen nodes excluded, bounded to maxNodes). A
 *      terminal-class window, or an AX tree with no visible text, routes to the
 *      OCR seam; when OCR is unavailable the snapshot is skipped (reflected in
 *      health) rather than crashing.
 *   3. Redaction — SSN/card + user patterns, before hashing or storage.
 *   4. Dedup — per-window SimHash gate (threshold / TTL).
 *   5. Content hash — length-prefixed SHA-256 so control chars can't collide.
 *
 * The OCR step is a seam (an injected callback), so the daemon wires the native
 * helper while tests inject a fake without any macOS binary.
 */

import { createHash } from "node:crypto";

import { extractAxText, type AxNode } from "./axtree.js";
import { DedupCache } from "./dedup.js";
import { matchDenyRule, matchesAnyGlob } from "./denylist.js";
import { compileRedactionPatterns, redactText } from "./redact.js";
import { simhash, simhashToHex } from "./simhash.js";
import type { DaemonConfig } from "./config.js";
import type { DaemonSnapshot, SnapshotInput, TextSource } from "./spool.js";

/** Terminal-class apps whose windows expose no useful AX text (route to OCR). */
export const DEFAULT_TERMINAL_APPS: readonly string[] = [
  "Terminal",
  "iTerm2",
  "iTerm",
  "Alacritty",
  "kitty",
  "WezTerm",
  "Warp",
  "Hyper",
  "Konsole",
  "gnome-terminal*",
];

/**
 * True when `app` is a terminal-class window (routes to OCR — terminals expose
 * no useful AX text). `includeDefaults` prepends DEFAULT_TERMINAL_APPS; pass
 * false when `terminalApps` is already the merged list.
 */
export function isTerminalApp(app: string, terminalApps: readonly string[], includeDefaults = true): boolean {
  const patterns = includeDefaults ? [...DEFAULT_TERMINAL_APPS, ...terminalApps] : terminalApps;
  return matchesAnyGlob(patterns, app);
}

/** A raw capture candidate before processing. Provide `text` OR `ax`. */
export interface CaptureCandidate {
  capturedAtUtc: string;
  app: string;
  windowTitle: string;
  browserUrl?: string | null;
  /** Pre-extracted text (skips AX walking); source defaults to "ax". */
  text?: string;
  textSource?: TextSource;
  /** Accessibility tree to extract from when `text` is absent. */
  ax?: AxNode;
}

export type CaptureDecision =
  | { action: "denied"; rule: string }
  | { action: "skipped"; reason: "ocr-unavailable" | "dedup" }
  | { action: "store"; snapshot: SnapshotInput };

/** OCR seam: returns extracted text for a candidate, or null when unavailable. */
export type OcrFn = (candidate: CaptureCandidate) => string | null;

interface ContentHashFields {
  capturedAtUtc: string;
  app: string;
  windowTitle: string;
  browserUrl: string | null;
  text: string;
  textSource: string;
}

/**
 * SHA-256 over length-prefixed fields so control characters (incl. NUL) in the
 * captured text cannot make two distinct snapshots collide — a collision would
 * silently drop a valid capture via the UNIQUE content_hash + INSERT OR IGNORE.
 */
export function contentHash(fields: ContentHashFields): string {
  const hash = createHash("sha256");
  const parts = [fields.capturedAtUtc, fields.app, fields.windowTitle, fields.browserUrl ?? "", fields.text, fields.textSource];
  for (const field of parts) {
    hash.update(`${Buffer.byteLength(field)}:`).update(field);
  }
  return hash.digest("hex");
}

export class CaptureProcessor {
  readonly #denyApps: string[];
  readonly #denyTitles: string[];
  readonly #denyUrls: string[];
  readonly #terminalApps: string[];
  readonly #maxNodes: number;
  readonly #redaction: RegExp[];
  readonly #cache: DedupCache;
  readonly #ocr: OcrFn | undefined;

  constructor(config: DaemonConfig, ocr?: OcrFn) {
    this.#denyApps = config.denyApps;
    this.#denyTitles = config.denyTitles;
    this.#denyUrls = config.denyUrls;
    this.#terminalApps = [...DEFAULT_TERMINAL_APPS, ...config.terminalApps];
    this.#maxNodes = config.maxNodes;
    this.#redaction = compileRedactionPatterns(config.redactionPatterns);
    this.#cache = new DedupCache(config.simhashThreshold, config.dedupTtlSeconds);
    this.#ocr = ocr;
  }

  /** Seed the dedup cache from prior spool state so restarts don't re-store. */
  seed(app: string, windowTitle: string, simhashHex: string, capturedAtUtc: string): void {
    this.#cache.seed(app, windowTitle, BigInt(`0x${simhashHex}`), Date.parse(capturedAtUtc));
  }

  process(candidate: CaptureCandidate): CaptureDecision {
    const denyRule = matchDenyRule(
      { app: candidate.app, windowTitle: candidate.windowTitle, browserUrl: candidate.browserUrl },
      { apps: this.#denyApps, titles: this.#denyTitles, urls: this.#denyUrls },
    );
    if (denyRule !== null) return { action: "denied", rule: denyRule };

    const extracted = this.#extractText(candidate);
    if (extracted === null) return { action: "skipped", reason: "ocr-unavailable" };
    const { source } = extracted;
    const text = redactText(extracted.text, this.#redaction);

    const fingerprint = simhash(text);
    const atMs = Date.parse(candidate.capturedAtUtc);
    if (!this.#cache.shouldStore(candidate.app, candidate.windowTitle, fingerprint, atMs)) {
      return { action: "skipped", reason: "dedup" };
    }

    const browserUrl = candidate.browserUrl ?? null;
    return {
      action: "store",
      snapshot: {
        capturedAtUtc: candidate.capturedAtUtc,
        app: candidate.app,
        windowTitle: candidate.windowTitle,
        browserUrl,
        text,
        textSource: source,
        contentHash: contentHash({
          capturedAtUtc: candidate.capturedAtUtc,
          app: candidate.app,
          windowTitle: candidate.windowTitle,
          browserUrl,
          text,
          textSource: source,
        }),
        simhash: simhashToHex(fingerprint),
      },
    };
  }

  /** Resolve visible text + its source, or null when OCR was needed but unavailable. */
  #extractText(candidate: CaptureCandidate): { text: string; source: TextSource } | null {
    if (typeof candidate.text === "string") {
      return { text: candidate.text, source: candidate.textSource ?? "ax" };
    }
    const axText = candidate.ax === undefined ? "" : extractAxText(candidate.ax, this.#maxNodes).text;
    const needsOcr = isTerminalApp(candidate.app, this.#terminalApps, false) || axText.trim() === "";
    if (!needsOcr) return { text: axText, source: "ax" };
    const ocrText = this.#ocr === undefined ? null : this.#ocr(candidate);
    if (ocrText !== null && ocrText.trim() !== "") return { text: ocrText, source: "ocr" };
    return null;
  }
}

export interface AppStat {
  app: string;
  seconds: number;
  snapshotCount: number;
}

export interface DayStats {
  date: string;
  timezone: string;
  snapshotCount: number;
  totalSeconds: number;
  apps: AppStat[];
}

/**
 * Per-app time attribution for a day. Each snapshot is credited the gap to the
 * next snapshot (capped at maxDwellSeconds); the final snapshot contributes no
 * dwell (no following instant to bound it). Apps sort by seconds desc, then name.
 */
export function computeStats(
  snapshots: DaemonSnapshot[],
  date: string,
  timezone: string,
  maxDwellSeconds: number,
): DayStats {
  const ordered = [...snapshots].sort((a, b) => {
    const at = Date.parse(a.capturedAtUtc);
    const bt = Date.parse(b.capturedAtUtc);
    if (at !== bt) return at - bt;
    return a.id - b.id;
  });
  const seconds = new Map<string, number>();
  const counts = new Map<string, number>();
  let totalSeconds = 0;
  for (let i = 0; i < ordered.length; i++) {
    const snap = ordered[i];
    counts.set(snap.app, (counts.get(snap.app) ?? 0) + 1);
    if (i + 1 < ordered.length) {
      const gap = (Date.parse(ordered[i + 1].capturedAtUtc) - Date.parse(snap.capturedAtUtc)) / 1000;
      const dwell = Math.max(0, Math.min(gap, maxDwellSeconds));
      seconds.set(snap.app, (seconds.get(snap.app) ?? 0) + dwell);
      totalSeconds += dwell;
    }
  }
  const apps: AppStat[] = [...counts.keys()]
    .map((app) => ({ app, seconds: seconds.get(app) ?? 0, snapshotCount: counts.get(app) ?? 0 }))
    .sort((a, b) => (b.seconds !== a.seconds ? b.seconds - a.seconds : a.app < b.app ? -1 : a.app > b.app ? 1 : 0));
  return { date, timezone, snapshotCount: ordered.length, totalSeconds, apps };
}
