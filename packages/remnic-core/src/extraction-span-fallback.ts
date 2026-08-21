/**
 * Span-validation fallback-rate tally (issue #2333 Phase A).
 *
 * Counts per-fact extraction outcomes — "span" means the span validated,
 * "fallback" means validation fell back — and produces the `fallbackRatePct`
 * input that `evaluateSpanPhaseGate` consumes (finite, [0, 100]; the gate
 * refuses Phase B at >= SPAN_GATE_MAX_FALLBACK_RATE_PCT).
 *
 * An unrecognized outcome throws: bucketing it as a success would understate
 * the fallback rate and could wave a failing gate through. A zero-attempt
 * tally reports `fallbackRatePct: null`, which the gate's `number` input
 * cannot accept, so an unmeasured run cannot be handed to it as 0%.
 *
 * Pure. No I/O, no randomness. The input array is not mutated.
 */

export const SPAN_OUTCOMES = ["span", "fallback"] as const;
export type SpanOutcome = (typeof SPAN_OUTCOMES)[number];

export interface SpanFallbackTally {
  attempts: number;
  fallbacks: number;
  /**
   * Percentage in [0, 100] for the gate's `fallbackRatePct` input, or `null`
   * when there were no attempts.
   *
   * `null` rather than 0 is the enforcement: a 0 satisfies the gate's
   * `fallbackRatePct < 15` comparison, so an unmeasured run could have
   * approved Phase B. `null` is not assignable to the gate's `number`
   * parameter, so a caller must handle "no measurement" explicitly instead of
   * relying on a comment to tell it not to.
   */
  fallbackRatePct: number | null;
}

export function tallySpanFallbacks(outcomes: readonly string[]): SpanFallbackTally {
  if (!Array.isArray(outcomes)) {
    throw new TypeError(
      `tallySpanFallbacks expects an array of span outcomes, got ${typeof outcomes}`,
    );
  }
  let fallbacks = 0;
  for (const outcome of outcomes) {
    if (!SPAN_OUTCOMES.includes(outcome as SpanOutcome)) {
      throw new TypeError(
        `unknown span outcome ${JSON.stringify(outcome)}; expected one of [${SPAN_OUTCOMES.join(", ")}]`,
      );
    }
    if (outcome === "fallback") {
      fallbacks += 1;
    }
  }
  const attempts = outcomes.length;
  if (attempts === 0) {
    // No measurement. Never 0 and never NaN: 0 would pass the gate's
    // `< 15` check on no data, and NaN would fail it for the same absence.
    return { attempts: 0, fallbacks: 0, fallbackRatePct: null };
  }
  // Cap at 4 decimal places so repeated tallies are byte-identical.
  const fallbackRatePct = Math.round((fallbacks / attempts) * 100 * 10_000) / 10_000;
  return { attempts, fallbacks, fallbackRatePct };
}
