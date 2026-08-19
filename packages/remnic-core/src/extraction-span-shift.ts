/**
 * Isolated span-shift helper (issue #2333 leftover).
 *
 * Pure. Extraction wiring waits on the Phase A bench gate.
 */

export function shiftSpan(opts: {
  start: number;
  end: number;
  delta: number;
}): { start: number; end: number } {
  const { start, end, delta } = opts;
  if (!Number.isInteger(start) || !Number.isInteger(end) || !Number.isInteger(delta)) {
    throw new TypeError("span offsets must be integers");
  }
  if (end < start) {
    throw new RangeError("span offsets inverted");
  }
  return { start: start + delta, end: end + delta };
}
