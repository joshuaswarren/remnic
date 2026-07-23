/**
 * `--replay <dir>` ingestion. Feeds synthetic candidate snapshots through the
 * FULL capture pipeline (deny-lists, AX/secure-field extraction, OCR routing,
 * redaction, dedup, supersession) into the spool — the CI-friendly, hardware-
 * free path that exercises every capture-time rule without a native helper.
 *
 * Each `*.json` fixture is either a single candidate or an array of them:
 *
 *   {
 *     "capturedAtUtc": "2026-07-20T15:00:00.000Z",
 *     "app": "Safari",
 *     "windowTitle": "Example",
 *     "browserUrl": "https://example.com",      // optional
 *     "text": "already extracted text",          // optional; OR provide "ax"
 *     "textSource": "ax",                        // optional; "ax" | "ocr"
 *     "ax": { "role": "AXWindow", "children": [ ... ] }  // optional AX tree
 *   }
 *
 * Candidates are processed in ascending capturedAt order (ties broken by file
 * order) so dedup/TTL behave deterministically regardless of how fixtures are
 * split across files. Ingestion is idempotent by content hash.
 */

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { CaptureCandidate, CaptureProcessor, OcrFn } from "./capture.js";
import { CaptureProcessor as Processor } from "./capture.js";
import type { DaemonConfig } from "./config.js";
import { CaptureConfigError } from "./errors.js";
import type { AxNode } from "./axtree.js";
import type { Spool } from "./spool.js";

export interface ReplayResult {
  files: number;
  candidates: number;
  stored: number;
  denied: number;
  deduped: number;
  ocrSkipped: number;
  superseded: number;
  /** True when a cooperative cancel (AbortSignal) stopped ingestion early. */
  aborted: boolean;
}

const REPLAY_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CaptureConfigError(`${where}: expected a snapshot object`);
  }
  return value as Record<string, unknown>;
}

function parseTimestamp(value: unknown, where: string): string {
  if (typeof value !== "string" || !REPLAY_INSTANT.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new CaptureConfigError(`${where}: expected an ISO instant with a Z or numeric offset`);
  }
  const [cy, cm, cd] = value.slice(0, 10).split("-").map(Number);
  const probe = new Date(Date.UTC(cy, cm - 1, cd));
  probe.setUTCFullYear(cy);
  if (probe.getUTCFullYear() !== cy || probe.getUTCMonth() !== cm - 1 || probe.getUTCDate() !== cd) {
    throw new CaptureConfigError(`${where}: '${value}' is not a real calendar date`);
  }
  // Canonicalize to UTC (Z) so an offset instant sorts correctly under the keyset.
  return new Date(value).toISOString();
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== "string") throw new CaptureConfigError(`${where}: expected a string`);
  return value;
}

function parseCandidate(raw: unknown, where: string): CaptureCandidate {
  const obj = asObject(raw, where);
  const capturedAtUtc = parseTimestamp(obj.capturedAtUtc, `${where}.capturedAtUtc`);
  const candidate: CaptureCandidate = {
    capturedAtUtc,
    app: requireString(obj.app, `${where}.app`),
    windowTitle: requireString(obj.windowTitle, `${where}.windowTitle`),
  };
  if (obj.browserUrl !== undefined && obj.browserUrl !== null) {
    candidate.browserUrl = requireString(obj.browserUrl, `${where}.browserUrl`);
  }
  if (obj.text !== undefined) candidate.text = requireString(obj.text, `${where}.text`);
  if (obj.textSource !== undefined) {
    if (obj.textSource !== "ax" && obj.textSource !== "ocr") {
      throw new CaptureConfigError(`${where}.textSource: expected 'ax' or 'ocr'`);
    }
    candidate.textSource = obj.textSource;
  }
  if (obj.ax !== undefined) candidate.ax = asObject(obj.ax, `${where}.ax`) as AxNode;
  return candidate;
}

function listFixtureFiles(dir: string): string[] {
  let entries: string[];
  try {
    if (lstatSync(dir).isSymbolicLink()) {
      throw new CaptureConfigError(`replay dir ${dir} is a symlink; refusing to follow it`);
    }
    entries = readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch (err) {
    if (err instanceof CaptureConfigError) throw err;
    throw new CaptureConfigError(`replay dir not found or unreadable: ${dir}`);
  }
  if (entries.length === 0) {
    throw new CaptureConfigError(`replay dir ${dir} contains no *.json fixtures`);
  }
  return entries;
}

/** Parse + validate every fixture without touching the spool (atomic failure). */
function parseReplayDir(dir: string): { candidates: CaptureCandidate[]; files: number } {
  const entries = listFixtureFiles(dir);
  const candidates: CaptureCandidate[] = [];
  for (const name of entries) {
    const filePath = path.join(dir, name);
    if (lstatSync(filePath).isSymbolicLink()) {
      throw new CaptureConfigError(`replay fixture ${name} is a symlink; refusing to follow it`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(filePath, "utf8"));
    } catch (err) {
      throw new CaptureConfigError(`replay fixture ${name} is not valid JSON: ${(err as Error).message}`);
    }
    const docs = Array.isArray(raw) ? raw : [raw];
    docs.forEach((doc, i) => candidates.push(parseCandidate(doc, `${name}[${i}]`)));
  }
  // Stable ascending capture order (tie: original index) — deterministic dedup.
  const indexed = candidates.map((candidate, index) => ({ candidate, index }));
  indexed.sort((a, b) => {
    const at = Date.parse(a.candidate.capturedAtUtc);
    const bt = Date.parse(b.candidate.capturedAtUtc);
    return at !== bt ? at - bt : a.index - b.index;
  });
  return { candidates: indexed.map((entry) => entry.candidate), files: entries.length };
}

function seedProcessor(processor: CaptureProcessor, spool: Spool): void {
  for (const fp of spool.latestFingerprints()) {
    processor.seed(fp.app, fp.windowTitle, fp.simhash, fp.capturedAtUtc);
  }
}

function commit(processor: CaptureProcessor, spool: Spool, config: DaemonConfig, candidate: CaptureCandidate, result: ReplayResult): void {
  const decision = processor.process(candidate);
  if (decision.action === "denied") {
    result.denied += 1;
  } else if (decision.action === "skipped") {
    if (decision.reason === "dedup") result.deduped += 1;
    else result.ocrSkipped += 1;
  } else {
    const inserted = spool.insertSnapshot(decision.snapshot, config.sessionGapSeconds);
    if (inserted.inserted) {
      result.stored += 1;
      if (inserted.supersededId !== null) result.superseded += 1;
    }
  }
}

/** Commit size between event-loop yields in the responsive ingester. */
export const REPLAY_COMMIT_BATCH = 25;

/** Synchronous ingest: validate the whole directory, then process it all. */
export function ingestReplayDir(spool: Spool, dir: string, config: DaemonConfig, ocr?: OcrFn): ReplayResult {
  const { candidates, files } = parseReplayDir(dir);
  const processor = new Processor(config, ocr);
  seedProcessor(processor, spool);
  const result: ReplayResult = {
    files,
    candidates: candidates.length,
    stored: 0,
    denied: 0,
    deduped: 0,
    ocrSkipped: 0,
    superseded: 0,
    aborted: false,
  };
  for (const candidate of candidates) commit(processor, spool, config, candidate, result);
  return result;
}

/**
 * Responsive ingest: validate up front (atomic), then process in bounded
 * batches with an event-loop yield between them so a co-hosted HTTP server
 * stays responsive during a large replay.
 */
export async function ingestReplayDirResponsive(
  spool: Spool,
  dir: string,
  config: DaemonConfig,
  options: { signal?: AbortSignal; ocr?: OcrFn } = {},
): Promise<ReplayResult> {
  const { candidates, files } = parseReplayDir(dir);
  const processor = new Processor(config, options.ocr);
  seedProcessor(processor, spool);
  const result: ReplayResult = {
    files,
    candidates: candidates.length,
    stored: 0,
    denied: 0,
    deduped: 0,
    ocrSkipped: 0,
    superseded: 0,
    aborted: false,
  };
  for (let i = 0; i < candidates.length; i += REPLAY_COMMIT_BATCH) {
    if (options.signal?.aborted) {
      result.aborted = true;
      break;
    }
    for (const candidate of candidates.slice(i, i + REPLAY_COMMIT_BATCH)) {
      commit(processor, spool, config, candidate, result);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return result;
}
