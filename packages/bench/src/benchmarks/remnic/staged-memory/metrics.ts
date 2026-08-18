/**
 * Statistics extensions for the staged-memory benchmark (issue #2346):
 * paired sign-flip permutation p-values, Holm correction across declared
 * primary metrics, and zero-denominator `NA` accounting. `NA` values are
 * excluded from every mean, interval, permutation test, and correction —
 * they are recorded, never averaged around.
 */

import { createSeededRandom } from "../../../seeded-random.js";

export const STAGED_MEMORY_PERMUTATION_SAMPLES = 10_000;
/** Pinned so repeated runs reproduce identical p-values (no Math.random). */
export const STAGED_MEMORY_STATISTICS_SEED = 0x5eed5;

export interface PairedPermutationResult {
  pValue: number;
  samples: number;
}

/**
 * Two-sided paired permutation test on sign flips. Differences are paired by
 * case; pairs where either side is `NA` are excluded before testing. When
 * every difference is exactly zero the p-value is 1 (no observable
 * difference), which is descriptive evidence only — never a significance
 * claim.
 */
export function pairedPermutationTest(
  differences: readonly number[],
  options: { samples?: number; seed?: number } = {}
): PairedPermutationResult {
  const samples = options.samples ?? STAGED_MEMORY_PERMUTATION_SAMPLES;
  const rng = createSeededRandom((options.seed ?? STAGED_MEMORY_STATISTICS_SEED) >>> 0);
  const diffs = differences.filter((value) => Number.isFinite(value));
  if (diffs.length === 0) {
    return { pValue: 1, samples };
  }
  const observed = Math.abs(diffs.reduce((sum, value) => sum + value, 0));
  let extreme = 0;
  for (let iteration = 0; iteration < samples; iteration += 1) {
    let flipped = 0;
    for (const difference of diffs) {
      // Deterministic coin per pair; comparisons never touch Math.random.
      flipped += rng() < 0.5 ? difference : -difference;
    }
    if (Math.abs(flipped) >= observed) {
      extreme += 1;
    }
  }
  return { pValue: (extreme + 1) / (samples + 1), samples };
}

export interface NaMetricEntry {
  denominator: number;
  reason: string;
}

/**
 * Ratio metric with zero-denominator `NA` semantics. Returns either the
 * ratio or an `NA` record carrying the denominator and reason; callers put
 * the reason in `naMetrics` and skip the value in every aggregate.
 */
export function ratioMetric(
  numerator: number,
  denominator: number,
  naReason: string
): { value: number; na?: NaMetricEntry } | { value: "NA"; na: NaMetricEntry } {
  if (denominator === 0) {
    return {
      value: "NA",
      na: { denominator: 0, reason: naReason },
    };
  }
  return { value: numerator / denominator };
}

/**
 * Holm-Bonferroni step-down adjustment across the declared primary metrics.
 * Metrics whose p-value is `NA` (excluded pairs or zero denominator) are
 * skipped and reported as `NA`; they never consume correction budget.
 * pAdj is clamped to be monotone and <= 1.
 */
export function holmAdjust(
  pValues: ReadonlyMap<string, number | "NA">,
  primaryMetrics: readonly string[]
): { adjustedPValues: Record<string, number | "NA"> } {
  const adjusted: Record<string, number | "NA"> = {};
  const testable = [...pValues.entries()]
    .filter((entry): entry is [string, number] => entry[1] !== "NA")
    .map(([metric, pValue]) => ({ metric, pValue }))
    // Total order: p-value first, metric name as the tiebreaker so equal
    // p-values sort identically across runs.
    .sort((left, right) => {
      if (left.pValue !== right.pValue) return left.pValue - right.pValue;
      return left.metric < right.metric ? -1 : left.metric > right.metric ? 1 : 0;
    });

  const family = testable.length;
  let runningMax = 0;
  for (let index = 0; index < family; index += 1) {
    const { metric, pValue } = testable[index] as { metric: string; pValue: number };
    const step = Math.min(1, (family - index) * pValue);
    runningMax = Math.max(runningMax, step);
    adjusted[metric] = runningMax;
  }
  for (const metric of primaryMetrics) {
    if (pValues.get(metric) === "NA") {
      adjusted[metric] = "NA";
    }
  }
  return { adjustedPValues: adjusted };
}
