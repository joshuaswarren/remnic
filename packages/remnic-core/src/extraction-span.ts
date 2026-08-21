/**
 * Isolated span-offset parser (issue #2333 first slice).
 *
 * Default off. Extraction wiring waits on the Phase A bench gate.
 */

export interface SpanOffsets {
  start: number;
  end: number;
}

export interface ParsedSpan {
  text: string;
  start?: number;
  end?: number;
}

export function parseSpanOffsets(
  text: string,
  offsets: SpanOffsets,
  spanModeEnabled: boolean | 0 | 1 = false,
): ParsedSpan {
  if (spanModeEnabled !== true && spanModeEnabled !== 1) {
    return { text };
  }

  const { start, end } = offsets;
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new RangeError("invalid span: out of range");
  }
  if (start > end) {
    throw new RangeError("invalid span: reversed");
  }
  if (start < 0 || end > text.length) {
    throw new RangeError("invalid span: out of range");
  }

  return { text: text.slice(start, end), start, end };
}
