/**
 * Isolated span-provenance builder (issue #2333).
 *
 * Pure. Builds the ProvenanceSource quote/charStart/charEnd triple from
 * offsets and verifies a model-supplied quote equals the sliced text, so a
 * bad offset pair can never persist a quote absent from the source.
 */

export interface SpanProvenance {
  quote: string;
  charStart: number;
  charEnd: number;
}

export type SpanProvenanceResult =
  | { ok: true; provenance: SpanProvenance }
  | { ok: false; error: "empty_span" | "out_of_range" | "quote_mismatch" };

export function spanToProvenance(input: {
  text: string;
  start: number;
  end: number;
  /** Optional model-supplied quote to verify against the slice. */
  quote?: string;
}): SpanProvenanceResult {
  const { text, start, end, quote } = input;
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new TypeError("span offsets must be integers");
  }
  if (start < 0 || end > text.length || end < start) {
    return { ok: false, error: "out_of_range" };
  }
  if (start === end) {
    return { ok: false, error: "empty_span" };
  }
  const sliced = text.slice(start, end);
  if (quote !== undefined && quote !== sliced) {
    return { ok: false, error: "quote_mismatch" };
  }
  return { ok: true, provenance: { quote: sliced, charStart: start, charEnd: end } };
}
