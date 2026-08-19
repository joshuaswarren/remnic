/**
 * Extraction seam for span mode (issue #2333 leftover slice).
 *
 * Default off. Callers pass `enabled`. This module does not touch
 * extraction.ts; Phase A still gates production wiring.
 */

import { parseSpanOffsets, type ParsedSpan } from "./extraction-span.js";

export function applySpanMode(opts: {
  enabled?: boolean | 0 | 1;
  text: string;
  start: number;
  end: number;
}): ParsedSpan {
  return parseSpanOffsets(opts.text, { start: opts.start, end: opts.end }, opts.enabled);
}
