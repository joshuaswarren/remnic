/**
 * Isolated span-join helper (issue #2333 leftover).
 *
 * Pure. Extraction wiring waits on the Phase A bench gate.
 */

export type SpanJoinOk = { start: number; end: number };
export type SpanJoinErr = { ok: false; error: "not_adjacent" };
export type SpanJoinResult = SpanJoinOk | SpanJoinErr;

export function joinAdjacentSpans(
  a: { start: number; end: number },
  b: { start: number; end: number },
): SpanJoinResult {
  if (
    !Number.isInteger(a.start) ||
    !Number.isInteger(a.end) ||
    !Number.isInteger(b.start) ||
    !Number.isInteger(b.end)
  ) {
    throw new TypeError("span offsets must be integers");
  }
  if (a.end < a.start || b.end < b.start) {
    throw new RangeError("span offsets inverted");
  }
  if (a.end !== b.start) {
    return { ok: false, error: "not_adjacent" };
  }
  return { start: a.start, end: b.end };
}
