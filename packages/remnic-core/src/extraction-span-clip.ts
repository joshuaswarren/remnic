/**
 * Isolated span clipper (issue #2333 leftover).
 *
 * Pure. Extraction wiring waits on the Phase A bench gate.
 */

export type SpanClipOk = { ok: true; start: number; end: number };
export type SpanClipErr = { ok: false; error: "empty" };
export type SpanClipResult = SpanClipOk | SpanClipErr;

export function clipSpan(opts: {
  start: number;
  end: number;
  textLength: number;
}): SpanClipResult {
  const { start, end, textLength } = opts;
  if (!Number.isInteger(start) || !Number.isInteger(end) || !Number.isInteger(textLength)) {
    throw new TypeError("span offsets must be integers");
  }
  const clippedStart = Math.max(0, Math.min(start, textLength));
  const clippedEnd = Math.max(0, Math.min(end, textLength));
  if (clippedStart >= clippedEnd) {
    return { ok: false, error: "empty" };
  }
  return { ok: true, start: clippedStart, end: clippedEnd };
}
