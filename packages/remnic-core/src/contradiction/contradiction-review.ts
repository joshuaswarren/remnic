/**
 * Contradiction Review Queue — storage for detected contradiction pairs (issue #520).
 *
 * Stores candidate pairs as JSON files under `memoryDir/.review/contradictions/`.
 * Pair IDs are deterministic (sha256 of sorted memory IDs) so reruns are idempotent.
 *
 * Lifecycle:
 *   - `contradicts` → awaiting user review
 *   - `duplicates` → auto-flagged for dedup (still needs user approval)
 *   - `independent` / `both-valid` → dormant with cooldown
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { log } from "../logger.js";
import type { ContradictionVerdict } from "./contradiction-judge.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export type ResolutionVerb = "keep-a" | "keep-b" | "merge" | "both-valid" | "needs-more-context";

export interface ContradictionPair {
  /** Deterministic pair ID: sha256(sorted(memoryIdA, memoryIdB)). */
  pairId: string;
  /** Memory IDs (sorted). */
  memoryIds: [string, string];
  /** Judge verdict. */
  verdict: ContradictionVerdict;
  /** Judge rationale. */
  rationale: string;
  /** Judge confidence in [0, 1]. */
  confidence: number;
  /** ISO timestamp when detected. */
  detectedAt: string;
  /** ISO timestamp when last reviewed by user. */
  lastReviewedAt?: string;
  /** Resolution verb applied by user. */
  resolution?: ResolutionVerb;
  /** ISO timestamp until which a non-terminal deferral remains hidden from review. */
  deferredUntil?: string;
  /** Namespace scope. */
  namespace?: string;
}

export interface ContradictionListResult {
  pairs: ContradictionPair[];
  total: number;
  durationMs: number;
}

export type ContradictionFilter = ContradictionVerdict | "all" | "unresolved";
const NEEDS_MORE_CONTEXT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// ── Helpers ────────────────────────────────────────────────────────────────────

export function computePairId(memoryIdA: string, memoryIdB: string): string {
  const sorted = [memoryIdA, memoryIdB].sort();
  return createHash("sha256").update(sorted.join("::")).digest("hex").slice(0, 24);
}

function isTerminalResolution(resolution: ResolutionVerb | undefined): boolean {
  return Boolean(resolution && resolution !== "needs-more-context");
}

function parseIsoMillis(value: string | undefined): number | null {
  if (!value) return null;
  const millis = new Date(value).getTime();
  return Number.isFinite(millis) ? millis : null;
}

function isDeferred(pair: Pick<ContradictionPair, "resolution" | "deferredUntil">): boolean {
  return pair.resolution === "needs-more-context" || Boolean(pair.deferredUntil);
}

function deferralUntilMillis(pair: ContradictionPair): number | null {
  const deferredUntil = parseIsoMillis(pair.deferredUntil);
  if (deferredUntil !== null) return deferredUntil;

  if (pair.resolution === "needs-more-context") {
    const lastReviewed = parseIsoMillis(pair.lastReviewedAt);
    return lastReviewed === null ? null : lastReviewed + NEEDS_MORE_CONTEXT_COOLDOWN_MS;
  }

  return null;
}

function isDeferralActive(pair: ContradictionPair): boolean {
  const deferredUntil = deferralUntilMillis(pair);
  return deferredUntil !== null && Date.now() < deferredUntil;
}

function reviewDir(memoryDir: string): string {
  return path.join(memoryDir, ".review", "contradictions");
}

function pairPath(memoryDir: string, pairId: string): string {
  if (pairId.includes("/") || pairId.includes("\\") || pairId.includes("..")) {
    throw new Error(`Invalid pairId: ${pairId}`);
  }
  return path.join(reviewDir(memoryDir), `${pairId}.json`);
}

function ensureDir(memoryDir: string): void {
  const dir = reviewDir(memoryDir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ── Write ──────────────────────────────────────────────────────────────────────

/**
 * Write a contradiction pair to the review queue.
 * Idempotent: if the pair already exists with a higher or equal confidence,
 * the existing entry is preserved.
 */
export function writePair(memoryDir: string, pair: Omit<ContradictionPair, "pairId"> & { memoryIds: [string, string] }): ContradictionPair {
  ensureDir(memoryDir);
  const pairId = computePairId(pair.memoryIds[0], pair.memoryIds[1]);
  const existing = readPair(memoryDir, pairId);

  // Preserve terminal user resolutions if already reviewed.
  if (isTerminalResolution(existing?.resolution)) {
    return existing!;
  }

  // Preserve active deferrals, but allow expired deferrals to be refreshed.
  const existingDeferralExpired = Boolean(existing && isDeferred(existing) && !isDeferralActive(existing));
  if (existing && isDeferralActive(existing)) {
    return existing;
  }

  // Preserve cooldown: don't overwrite a cooled-down entry with lower confidence
  if (existing && !existingDeferralExpired && existing.confidence >= pair.confidence) {
    return existing;
  }

  const full: ContradictionPair = {
    ...pair,
    pairId,
    lastReviewedAt: existingDeferralExpired ? pair.lastReviewedAt : (existing?.lastReviewedAt ?? pair.lastReviewedAt),
    resolution: undefined,
    deferredUntil: existingDeferralExpired ? undefined : existing?.deferredUntil,
  };

  const filePath = pairPath(memoryDir, pairId);
  const tmpPath = `${filePath}.tmp`;

  // Atomic write: temp then rename (rule 54)
  fs.writeFileSync(tmpPath, JSON.stringify(full, null, 2), "utf-8");
  fs.renameSync(tmpPath, filePath);

  return full;
}

/**
 * Write multiple pairs, deduplicating inputs first (rule 49).
 */
export function writePairs(memoryDir: string, pairs: Array<Omit<ContradictionPair, "pairId"> & { memoryIds: [string, string] }>): ContradictionPair[] {
  const seen = new Set<string>();
  const results: ContradictionPair[] = [];

  for (const pair of pairs) {
    const key = computePairId(pair.memoryIds[0], pair.memoryIds[1]);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(writePair(memoryDir, pair));
  }

  return results;
}

// ── Read ───────────────────────────────────────────────────────────────────────

/**
 * Read a single pair by ID. Returns null if not found.
 */
export function readPair(memoryDir: string, pairId: string): ContradictionPair | null {
  const filePath = pairPath(memoryDir, pairId);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && Array.isArray(parsed.memoryIds)) {
      return parsed as ContradictionPair;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * List pairs in the review queue, optionally filtered by verdict.
 */
export function listPairs(
  memoryDir: string,
  options?: {
    filter?: ContradictionFilter;
    namespace?: string;
    limit?: number;
  },
): ContradictionListResult {
  const startTime = Date.now();
  const dir = reviewDir(memoryDir);
  const { filter = "all", namespace, limit = 50 } = options ?? {};
  const pairs: ContradictionPair[] = [];
  let total = 0;

  if (!fs.existsSync(dir)) {
    return { pairs: [], total: 0, durationMs: Date.now() - startTime };
  }

  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;

    try {
      const raw = fs.readFileSync(path.join(dir, entry), "utf-8");
      const pair = JSON.parse(raw) as ContradictionPair;

      if (typeof pair !== "object" || pair === null) continue;
      if (!Array.isArray(pair.memoryIds)) continue;

      // Namespace filter
      if (namespace && pair.namespace !== namespace) continue;

      // Verdict filter
      if (filter === "unresolved") {
        if (isTerminalResolution(pair.resolution)) continue;
        if (isDeferralActive(pair)) continue;
        if (pair.verdict === "independent") continue;
      } else if (filter !== "all" && pair.verdict !== filter) {
        continue;
      }

      total++;
      if (pairs.length < limit) pairs.push(pair);
    } catch {
      continue;
    }
  }

  return { pairs, total, durationMs: Date.now() - startTime };
}

// ── Cooldown ───────────────────────────────────────────────────────────────────

/**
 * Check if a pair is within its cooldown window.
 * Returns true if the pair should be SKIPPED (still cooling down).
 */
export function isCoolingDown(pair: ContradictionPair, cooldownDays: number): boolean {
  if (cooldownDays <= 0) return false; // rule 27: guard against 0

  const deferredUntil = deferralUntilMillis(pair);
  if (deferredUntil !== null) {
    return Date.now() < deferredUntil;
  }

  if (!pair.lastReviewedAt) return false;

  const lastReviewed = parseIsoMillis(pair.lastReviewedAt);
  if (lastReviewed === null) return false;

  const cooldownMs = cooldownDays * 24 * 60 * 60 * 1000;
  return Date.now() < lastReviewed + cooldownMs;
}

/**
 * Mark a pair as reviewed (sets lastReviewedAt and, for terminal verbs, resolution).
 */
export function resolvePair(
  memoryDir: string,
  pairId: string,
  verb: ResolutionVerb,
): ContradictionPair | null {
  if (verb === "needs-more-context") {
    return deferPair(memoryDir, pairId);
  }

  const existing = readPair(memoryDir, pairId);
  if (!existing) return null;

  const updated: ContradictionPair = {
    ...existing,
    lastReviewedAt: new Date().toISOString(),
    resolution: verb,
    deferredUntil: undefined,
  };

  const filePath = pairPath(memoryDir, pairId);
  const tmpPath = `${filePath}.tmp`;

  fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2), "utf-8");
  fs.renameSync(tmpPath, filePath);

  return updated;
}

/**
 * Defer a pair without terminally resolving it.
 */
export function deferPair(
  memoryDir: string,
  pairId: string,
  deferredUntil = new Date(Date.now() + NEEDS_MORE_CONTEXT_COOLDOWN_MS).toISOString(),
): ContradictionPair | null {
  const existing = readPair(memoryDir, pairId);
  if (!existing) return null;
  if (isTerminalResolution(existing.resolution)) return existing;

  const updated: ContradictionPair = {
    ...existing,
    lastReviewedAt: new Date().toISOString(),
    resolution: undefined,
    deferredUntil,
  };

  const filePath = pairPath(memoryDir, pairId);
  const tmpPath = `${filePath}.tmp`;

  fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2), "utf-8");
  fs.renameSync(tmpPath, filePath);

  return updated;
}

/**
 * Check whether a pair's referenced memories have changed since detection,
 * which should override cooldown.
 */
export function memoryHashesChanged(
  _memoryDir: string,
  _pair: ContradictionPair,
  _getCurrentHash: (memoryId: string) => string | null,
): boolean {
  // Intentionally a stub for now — the full implementation would compare
  // content hashes stored at detection time with current hashes.
  return false;
}
