/**
 * Buffer-surprise telemetry report (issue #563 PR 3).
 *
 * Reads the append-only `state/buffer-surprise-ledger.jsonl` file written
 * by `SmartBuffer` and summarizes the recent distribution of surprise
 * scores for the Doctor surface. This module is intentionally standalone
 * and pure — the only I/O is reading the ledger via the injected
 * `readEvents` callback, so it can be exercised directly in tests
 * without touching the filesystem.
 *
 * # Output shape
 *
 * `BufferSurpriseDistribution` has fields sized for a one-screen Doctor
 * display:
 *
 *   - `count`            — rows considered in the summary window.
 *   - `triggeredCount`   — rows whose `triggeredFlush === true`.
 *   - `triggeredRate`    — `triggeredCount / count`, or `0` when empty.
 *   - `mean`             — arithmetic mean of `surpriseScore`.
 *   - `median`           — middle value (50th percentile).
 *   - `p90`              — 90th percentile (tail of novelty).
 *   - `min`, `max`       — window extremes.
 *   - `currentThreshold` — threshold from the MOST RECENT row, or `null`.
 *
 * All percentile math uses the nearest-rank method (no interpolation) so
 * the report is stable across small windows.
 *
 * # Why a pure function + injected reader?
 *
 * The Doctor surface is exercised both at runtime (through the CLI and
 * gateway tools) and in tests. A pure distribution helper fed from an
 * arbitrary `readEvents` callback keeps the report logic trivially
 * testable without spinning up a real `StorageManager`.
 */

import type { BufferSurpriseEvent } from "./types.js";

export interface BufferSurpriseDistribution {
  count: number;
  triggeredCount: number;
  triggeredRate: number;
  mean: number;
  median: number;
  p90: number;
  min: number;
  max: number;
  currentThreshold: number | null;
}

export interface BufferSurpriseReportOptions {
  /**
   * Maximum number of recent rows to include. Defaults to `200` — large
   * enough to see a distribution, small enough to read in one sitting.
   */
  limit?: number;
  /** Lower-bound ISO timestamp; rows at or before this are excluded. */
  since?: string;
}

/**
 * Reader callback shape. The helper does not want to know whether the
 * rows come from a file, a queue, or an in-memory buffer.
 */
export type BufferSurpriseReader = (
  options: BufferSurpriseReportOptions,
) => Promise<readonly BufferSurpriseEvent[]>;

/**
 * Summarize the recent buffer-surprise distribution. Returns the empty
 * distribution shape when the ledger has no applicable rows — callers can
 * detect this via `count === 0` and render "no data yet".
 */
export async function reportBufferSurpriseDistribution(
  readEvents: BufferSurpriseReader,
  options: BufferSurpriseReportOptions = {},
): Promise<BufferSurpriseDistribution> {
  const limit = normalizeReportLimit(options.limit);
  const raw = await readEvents({ limit, since: options.since });

  // Filter for sanity: finite numeric scores in [0, 1], event tag match,
  // and the optional `since` lower bound. Malformed rows are skipped.
  const sinceMs =
    typeof options.since === "string" && options.since.length > 0
      ? Date.parse(options.since)
      : Number.NaN;
  const rows = raw.filter((row): row is BufferSurpriseEvent => {
    if (!row || row.event !== "BUFFER_SURPRISE") return false;
    const ts = Date.parse(row.timestamp);
    if (!Number.isFinite(ts)) return false;
    if (typeof row.surpriseScore !== "number") return false;
    if (!Number.isFinite(row.surpriseScore)) return false;
    if (row.surpriseScore < 0 || row.surpriseScore > 1) return false;
    // `triggeredFlush` must be a real boolean — not a string or other
    // truthy value. A row with `triggeredFlush: "false"` (string from a
    // JSON-parsing bug upstream) would otherwise be counted as
    // triggered, inflating the rate and misleading operators tuning the
    // threshold from real traffic.
    if (typeof row.triggeredFlush !== "boolean") return false;
    if (Number.isFinite(sinceMs)) {
      if (!Number.isFinite(ts) || ts <= sinceMs) return false;
    }
    return true;
  }).sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));

  const windowStart = Math.max(0, rows.length - limit);
  const windowRows = rows.slice(windowStart);

  if (windowRows.length === 0) {
    return {
      count: 0,
      triggeredCount: 0,
      triggeredRate: 0,
      mean: 0,
      median: 0,
      p90: 0,
      min: 0,
      max: 0,
      currentThreshold: null,
    };
  }

  const scores = windowRows.map((r) => r.surpriseScore).sort((a, b) => a - b);
  const triggeredCount = windowRows.reduce(
    (acc, r) => acc + (r.triggeredFlush ? 1 : 0),
    0,
  );
  const sum = scores.reduce((acc, v) => acc + v, 0);
  const mean = sum / scores.length;

  // Nearest-rank percentiles keep the output stable for small windows.
  const median = percentile(scores, 0.5);
  const p90 = percentile(scores, 0.9);

  // "Current" threshold is whichever was in force for the most recent row
  // — not necessarily the one configured right now, but the value the
  // ledger rows were judged against. That's what operators need to reason
  // about the distribution.
  const mostRecent = windowRows[windowRows.length - 1];
  const currentThreshold =
    mostRecent && typeof mostRecent.threshold === "number"
      ? mostRecent.threshold
      : null;

  return {
    count: scores.length,
    triggeredCount,
    triggeredRate: triggeredCount / scores.length,
    mean,
    median,
    p90,
    min: scores[0]!,
    max: scores[scores.length - 1]!,
    currentThreshold,
  };
}

function normalizeReportLimit(limit: number | undefined): number {
  if (limit === undefined) return 200;
  if (typeof limit !== "number" || !Number.isFinite(limit)) return 200;
  const floored = Math.floor(limit);
  return floored > 0 ? floored : 200;
}

/**
 * Nearest-rank percentile of a pre-sorted ascending array.
 *
 * Returns `sorted[ceil(p * n) - 1]`, with `p` clamped to `[0, 1]`.
 * This avoids the interpolation ambiguity of R-7/R-8 percentiles and is
 * stable when the window is small (e.g. 3-5 rows).
 */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const clamped = Math.max(0, Math.min(1, p));
  const rank = Math.max(1, Math.ceil(clamped * sorted.length));
  return sorted[rank - 1]!;
}
