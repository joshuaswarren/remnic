/**
 * Extraction-LLM availability tracking surfaced on `/health` (issue #3140).
 *
 * A failing extraction LLM (unreachable endpoint, gateway with no models)
 * used to surface only as debug-level lines while extraction silently skipped
 * persistence and the buffer grew for days. The extraction run records every
 * attempt outcome here; the access `/health` payload reads the last outcome so
 * an unavailable extractor is visible without debug logs, and each distinct
 * failure reason logs at ERROR level at most once per window instead of once
 * per failed flush.
 */

import { log } from "./logger.js";

export interface ExtractionLlmHealth {
  /** Whether the LAST extraction attempt completed without a failure marker. */
  llmReachable: boolean;
  /** `failureReason` of the last failed attempt; null while reachable. */
  lastFailureReason: string | null;
  /** ISO timestamp of the last failed attempt; null while reachable. */
  lastFailureAt: string | null;
}

/** One ERROR line per distinct reason per window; repeats stay at debug. */
const DEDUP_WINDOW_MS = 3_600_000;

let lastFailureReason: string | null = null;
let lastFailureAtMs: number | null = null;
const lastErrorEmitByReason = new Map<string, number>();

export function recordExtractionLlmSuccess(): void {
  lastFailureReason = null;
  lastFailureAtMs = null;
}

export function recordExtractionLlmFailure(reason: string, atMs: number = Date.now()): void {
  lastFailureReason = reason;
  lastFailureAtMs = atMs;
}

export function getExtractionLlmHealth(): ExtractionLlmHealth {
  return {
    llmReachable: lastFailureReason === null,
    lastFailureReason,
    lastFailureAt: lastFailureAtMs === null ? null : new Date(lastFailureAtMs).toISOString(),
  };
}

/**
 * ERROR-level, deduplicated failure event (issue #3140): the first failure of
 * a given reason inside the window logs at error level; repeats inside the
 * window log at debug so the backoff retry loop cannot flood the transcript
 * while the outage stays visible. Returns whether the error line was emitted.
 */
export function emitExtractionLlmFailureError(reason: string, detail?: string, nowMs: number = Date.now()): boolean {
  const suffix = detail ? `: ${detail}` : "";
  const last = lastErrorEmitByReason.get(reason);
  if (last !== undefined && nowMs - last < DEDUP_WINDOW_MS) {
    log.debug(`extraction failure repeat suppressed for ${DEDUP_WINDOW_MS / 60_000}m: ${reason}${suffix}`);
    return false;
  }
  lastErrorEmitByReason.set(reason, nowMs);
  log.error(`extraction failed with no durable outputs (buffer retained for retry): ${reason}${suffix}`);
  return true;
}

/** Test seam: restore pristine singleton state. */
export function resetExtractionLlmHealthForTests(): void {
  recordExtractionLlmSuccess();
  lastErrorEmitByReason.clear();
}
