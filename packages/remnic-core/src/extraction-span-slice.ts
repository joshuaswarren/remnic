/**
 * Isolated span slicer (issue #2333 leftover).
 *
 * Pure. Extraction wiring waits on the Phase A bench gate.
 */

export function sliceSpanText(opts: {
  text: string;
  start: number;
  end: number;
}): string {
  const { text, start, end } = opts;
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new TypeError("span offsets must be integers");
  }
  if (start < 0 || end < start || end > text.length) {
    throw new RangeError("span offsets out of range");
  }
  return text.slice(start, end);
}
