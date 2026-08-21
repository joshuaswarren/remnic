/**
 * Sum half-open activity dwell spans (issue #2053).
 */
export interface DwellSpan {
  startMs: number;
  endMs: number;
}

/**
 * Sum span durations in seconds.
 * Half-open `[startMs, endMs)`. Negative duration is skipped.
 * Overlaps add. Empty input is 0.
 */
export function sumDwellSeconds(spans: readonly DwellSpan[]): number {
  let total = 0;
  for (const { startMs, endMs } of spans) {
    const durationMs = endMs - startMs;
    if (durationMs < 0) continue;
    total += durationMs / 1000;
  }
  return total;
}
