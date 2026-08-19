/**
 * Isolated span-gap helper (issue #2333 leftover).
 *
 * Pure. Extraction wiring waits on the Phase A bench gate.
 */

export function spanGap(
  a: { start: number; end: number },
  b: { start: number; end: number },
): number {
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
  if (a.end <= b.start) return b.start - a.end;
  if (b.end <= a.start) return a.start - b.end;
  return 0;
}
