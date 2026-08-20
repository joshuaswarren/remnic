/**
 * Span-validation fallback-rate tally (issue #2333 Phase A).
 *
 * Counts per-fact extraction outcomes — "span" means the span validated,
 * "fallback" means validation fell back — and produces the `fallbackRatePct`
 * input that `evaluateSpanPhaseGate` consumes (finite, [0, 100]; the gate
 * refuses Phase B at >= SPAN_GATE_MAX_FALLBACK_RATE_PCT).
 *
 * An unrecognized outcome throws: bucketing it as a success would understate
 * the fallback rate and could wave a failing gate through.
 *
 * Pure. No I/O, no randomness. The input array is not mutated.
 */

export const SPAN_OUTCOMES = ["span", "fallback"] as const;
export type SpanOutcome = (typeof SPAN_OUTCOMES)[number];

export interface SpanFallbackTally {
  attempts: number;
  fallbacks: number;
  /** Percentage in [0, 100], matching the gate's fallbackRatePct input. */
  fallbackRatePct: number;
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
  // Zero attempts means "no measurement", not "0% fallbacks". Returning 0
  // keeps the gate's `fallbackRatePct < 15` comparison defined (0/0 is NaN,
  // and NaN < 15 is false, which would fail a gate that merely has no data
  // yet). Callers must not read this 0 as a passing measurement.
  const rate = attempts === 0 ? 0 : (fallbacks / attempts) * 100;
  // Cap at 4 decimal places so repeated tallies are byte-identical.
  const fallbackRatePct = Math.round(rate * 10_000) / 10_000;
  return { attempts, fallbacks, fallbackRatePct };
}
