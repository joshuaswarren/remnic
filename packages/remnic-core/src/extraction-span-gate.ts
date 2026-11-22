
export const SPAN_GATE_MIN_WALLCLOCK_REDUCTION_PCT = 20;
export const SPAN_GATE_MAX_JUDGE_DROP_POINTS = 2;
export const SPAN_GATE_MAX_FALLBACK_RATE_PCT = 15;

export interface SpanGateConditions {
  wallClockReduction: boolean;
  judgeQuality: boolean;
  fallbackRate: boolean;
}

export interface SpanGateVerdict {
  pass: boolean;
  conditions: SpanGateConditions;
  /** Condition names that failed, in declaration order. Empty when pass. */
  failed: string[];
}

function requireFinite(value: number, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(`span gate input ${field} must be a finite number, got ${value}`);
  }
}

export function evaluateSpanPhaseGate(input: {
  wallClockReductionPct: number;
  judgeScoreDropPoints: number;
  fallbackRatePct: number;
}): SpanGateVerdict {
  requireFinite(input.wallClockReductionPct, "wallClockReductionPct");
  requireFinite(input.judgeScoreDropPoints, "judgeScoreDropPoints");
  requireFinite(input.fallbackRatePct, "fallbackRatePct");
  if (input.fallbackRatePct < 0 || input.fallbackRatePct > 100) {
    throw new RangeError(
      `span gate input fallbackRatePct must be within [0, 100], got ${input.fallbackRatePct}`,
    );
  }

  const conditions: SpanGateConditions = {
    wallClockReduction: input.wallClockReductionPct >= SPAN_GATE_MIN_WALLCLOCK_REDUCTION_PCT,
    judgeQuality: input.judgeScoreDropPoints < SPAN_GATE_MAX_JUDGE_DROP_POINTS,
    fallbackRate: input.fallbackRatePct < SPAN_GATE_MAX_FALLBACK_RATE_PCT,
  };
  const failed = (Object.keys(conditions) as (keyof SpanGateConditions)[]).filter(
    (name) => !conditions[name],
  );
  return { pass: failed.length === 0, conditions, failed };
}
