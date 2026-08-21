/**
 * Isolated span-length helper (issue #2333 leftover).
 *
 * Pure. Extraction wiring waits on the Phase A bench gate.
 */

export function spanLength(opts: { start: number; end: number }): number {
  const { start, end } = opts;
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new TypeError("span offsets must be integers");
  }
  if (end < start) {
    throw new RangeError("span offsets inverted");
  }
  return end - start;
}
