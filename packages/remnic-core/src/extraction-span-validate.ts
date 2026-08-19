/**
 * Isolated span-offset validator (issue #2333 leftover).
 *
 * Pure. Extraction wiring waits on the Phase A bench gate.
 */

export type SpanValidateOk = { ok: true };
export type SpanValidateErr = { ok: false; error: "out_of_range" | "empty" };
export type SpanValidateResult = SpanValidateOk | SpanValidateErr;

export function validateSpanOffsets(opts: {
  start: number;
  end: number;
  textLength: number;
}): SpanValidateResult {
  const { start, end, textLength } = opts;
  if (!Number.isInteger(start) || !Number.isInteger(end) || !Number.isInteger(textLength)) {
    throw new TypeError("span offsets must be integers");
  }
  if (start < 0 || end < start || end > textLength) {
    return { ok: false, error: "out_of_range" };
  }
  if (start === end) {
    return { ok: false, error: "empty" };
  }
  return { ok: true };
}
