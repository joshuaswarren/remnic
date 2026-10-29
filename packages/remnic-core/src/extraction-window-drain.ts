/**
 * Trigger-drain helpers (extraction trigger stall fix).
 *
 * A session whose buffered window outgrows the extraction model's context
 * never drains: the trigger fires `extract_batch` on every observe, the
 * oversized request fails, nothing is cleared, and the window only grows.
 * These helpers split such a window into budget-fitting chunks and classify
 * each extraction run so the caller can drain successes, defer on breaker/
 * backoff retention, and drop repeatedly failing chunks.
 */

import type { ExtractionRunResult } from "./orchestration/extraction-run.js";

/**
 * Split `turns` into chunks whose summed content length stays within
 * `maxChars`. Chunks keep turn order and never split a turn; a single turn
 * longer than the budget becomes its own chunk (the extraction prompt still
 * clamps per-turn content). A non-positive or non-finite budget, or an empty
 * window, yields at most one chunk (no chunking).
 */
export function chunkExtractionWindow<T extends { content: string }>(
  turns: readonly T[],
  maxChars: number,
): T[][] {
  if (turns.length === 0) return [];
  const budget =
    Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : Number.POSITIVE_INFINITY;
  const chunks: T[][] = [];
  let current: T[] = [];
  let currentChars = 0;
  for (const turn of turns) {
    const turnChars = turn.content.length;
    if (current.length > 0 && currentChars + turnChars > budget) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(turn);
    currentChars += turnChars;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export type DrainVerdict = "drained" | "deferred" | "failed";

/**
 * Run results that deliberately RETAIN the buffer (provider breaker open,
 * per-fingerprint backoff) are deferrals, not chunk failures — counting them
 * would drop good content during a provider outage.
 */
const DRAIN_DEFERRAL_REASONS = {
  provider_circuit_open: true,
  extraction_backoff: true,
};

export function classifyDrainResult(result: ExtractionRunResult): DrainVerdict {
  if (result.status !== "skipped") return "drained";
  if (result.reason === "empty_extraction_result") return "failed";
  if (result.reason !== undefined && result.reason in DRAIN_DEFERRAL_REASONS) return "deferred";
  return "drained";
}

/**
 * Combine chunk results into the single `ExtractionRunResult` the queue
 * contract settles with: counts sum, any completed chunk completes the drain,
 * and the last non-completed reason wins.
 */
export function mergeDrainResults(
  previous: ExtractionRunResult | null,
  next: ExtractionRunResult,
): ExtractionRunResult {
  if (previous === null) return next;
  const completed = previous.status === "completed" || next.status === "completed";
  const merged: ExtractionRunResult = {
    status: completed ? "completed" : "skipped",
    persistedCount: previous.persistedCount + next.persistedCount,
    durableOutputCount: previous.durableOutputCount + next.durableOutputCount,
  };
  if (!completed) merged.reason = next.reason ?? previous.reason;
  if (previous.postPersistMetadataFailed === true || next.postPersistMetadataFailed === true) {
    merged.postPersistMetadataFailed = true;
  }
  return merged;
}
