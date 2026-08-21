/**
 * Isolated span-contains helper (issue #2333 leftover).
 *
 * Pure. Extraction wiring waits on the Phase A bench gate.
 */

export function spanContainsOffset(opts: {
  start: number;
  end: number;
  offset: number;
}): boolean {
  const { start, end, offset } = opts;
  if (!Number.isInteger(start) || !Number.isInteger(end) || !Number.isInteger(offset)) {
    throw new TypeError("span offsets must be integers");
  }
  if (end < start) {
    throw new RangeError("span offsets inverted");
  }
  return offset >= start && offset < end;
}
