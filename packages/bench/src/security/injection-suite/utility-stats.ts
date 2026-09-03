import { createSeededRandom, randomInt } from "../../seeded-random.js";
import { H5_DECISION_RULE } from "./decision-rule.js";
import type { InjectionSuiteArm } from "./types.js";

export interface InjectionSuiteUtilityObservation {
  benchmark: "locomo" | "longmemeval" | "drift-gen";
  itemId: string;
  seed: number;
  arm: InjectionSuiteArm;
  score: number;
}

export interface InjectionSuiteUtilityAnalysis {
  schemaVersion: 1;
  pairs: number;
  /** Expected (benchmark, item, seed, arm) observations that are absent; > 0 makes `equivalent` null. */
  missingObservations: number;
  baselineMean: number | null;
  fencingMean: number | null;
  relativeDelta: number | null;
  relativeBootstrap90: { lower: number; upper: number } | null;
  tost: { lowerP: number; upperP: number } | null;
  estimatedPower: number | null;
  equivalent: boolean | null;
}

function normalCdf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

function percentile(sorted: readonly number[], quantile: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(quantile * sorted.length)));
  return sorted[index] ?? 0;
}

/** The planned utility universe, recorded by the runner before any cell completes. */
export interface InjectionSuiteUtilityPlan {
  benchmarks: readonly InjectionSuiteUtilityObservation["benchmark"][];
  seeds: readonly number[];
  items: ReadonlyArray<Pick<InjectionSuiteUtilityObservation, "benchmark" | "itemId">>;
}

export function analyzeInjectionSuiteUtility(
  observations: readonly InjectionSuiteUtilityObservation[],
  plan?: InjectionSuiteUtilityPlan,
): InjectionSuiteUtilityAnalysis {
  const baseline = new Map<string, InjectionSuiteUtilityObservation>();
  const fencing = new Map<string, InjectionSuiteUtilityObservation>();
  for (const observation of observations) {
    const key = `${observation.benchmark}\0${observation.itemId}\0${observation.seed}`;
    if (observation.arm === "none") baseline.set(key, observation);
    if (observation.arm === "fencing") fencing.set(key, observation);
  }
  // Completeness: every planned (benchmark, item) x seed must be observed
  // for BOTH arms. The universe comes from the plan when the runner supplies
  // one (so a benchmark, item, or seed that never produced an observation
  // still counts as missing) and from the observations otherwise; observed
  // cells outside the plan are unexpected and count as missing too.
  const items = new Set<string>();
  const seeds = new Set<number>(plan?.seeds ?? []);
  for (const item of plan?.items ?? []) items.add(`${item.benchmark}\0${item.itemId}`);
  let missingObservations = 0;
  for (const observation of observations) {
    const item = `${observation.benchmark}\0${observation.itemId}`;
    if (plan && (!items.has(item) || !seeds.has(observation.seed))) missingObservations += 1;
    items.add(item);
    seeds.add(observation.seed);
  }
  for (const benchmark of plan?.benchmarks ?? []) {
    if (![...items].some((item) => item.startsWith(`${benchmark}\0`))) {
      missingObservations += seeds.size * 2;
    }
  }
  for (const item of items) {
    for (const seed of seeds) {
      const key = `${item}\0${seed}`;
      if (!baseline.has(key)) missingObservations += 1;
      if (!fencing.has(key)) missingObservations += 1;
    }
  }
  const pairs = [...baseline].flatMap(([key, baseObs]) => {
    const fencedObs = fencing.get(key);
    if (!fencedObs) return [];
    const base = baseObs.score;
    const fenced = fencedObs.score;
    return [{
      benchmark: baseObs.benchmark,
      itemId: baseObs.itemId,
      seed: baseObs.seed,
      base,
      fenced,
      difference: fenced - base,
    }];
  });
  if (pairs.length === 0 || missingObservations > 0) {
    return {
      schemaVersion: 1,
      pairs: pairs.length,
      missingObservations,
      baselineMean: null,
      fencingMean: null,
      relativeDelta: null,
      relativeBootstrap90: null,
      tost: null,
      estimatedPower: null,
      equivalent: null,
    };
  }
  const baselineMean = pairs.reduce((sum, pair) => sum + pair.base, 0) / pairs.length;
  const fencingMean = pairs.reduce((sum, pair) => sum + pair.fenced, 0) / pairs.length;
  if (baselineMean <= 0) {
    return {
      schemaVersion: 1,
      pairs: pairs.length,
      missingObservations,
      baselineMean,
      fencingMean,
      relativeDelta: null,
      relativeBootstrap90: null,
      tost: null,
      estimatedPower: null,
      equivalent: null,
    };
  }
  const meanDifference = fencingMean - baselineMean;

  const relativeDelta = meanDifference / baselineMean;
  const squared = pairs.reduce((sum, pair) => sum + (pair.difference - meanDifference) ** 2, 0);
  const standardDeviation = pairs.length > 1 ? Math.sqrt(squared / (pairs.length - 1)) : 0;
  const standardError = standardDeviation / Math.sqrt(pairs.length);
  const relativeMargin = H5_DECISION_RULE.thresholds.utilityRelativeEquivalenceMargin;
  const absoluteMargin = relativeMargin * baselineMean;
  const lowerP = standardError === 0
    ? meanDifference > -absoluteMargin ? 0 : 1
    : 1 - normalCdf((meanDifference + absoluteMargin) / standardError);
  const upperP = standardError === 0
    ? meanDifference < absoluteMargin ? 0 : 1
    : normalCdf((meanDifference - absoluteMargin) / standardError);
  const estimatedPower = standardError === 0
    ? 1
    : Math.max(0, Math.min(1, 2 * normalCdf(absoluteMargin / standardError - 1.6448536269514722) - 1));

  const rng = createSeededRandom(H5_DECISION_RULE.analysis.statisticsSeed);
  const draws: number[] = [];
  // Cluster-aware bootstrap: resample items (clusters) with replacement and
  // include every seed-level pair inside each resampled item, so repeated
  // seeds per item do not inflate effective n.
  const clusterBuckets = new Map<string, { base: number; fenced: number }[]>();
  for (const pair of pairs) {
    const cluster = `${pair.benchmark}\0${pair.itemId}`;
    const bucket = clusterBuckets.get(cluster) ?? [];
    bucket.push({ base: pair.base, fenced: pair.fenced });
    clusterBuckets.set(cluster, bucket);
  }
  const clusterKeys = [...clusterBuckets.keys()];
  if (clusterKeys.length === 0) {
    draws.push(0);
  } else {
    for (let draw = 0; draw < H5_DECISION_RULE.analysis.bootstrapDraws; draw += 1) {
      let baseSum = 0;
      let fencedSum = 0;
      for (let index = 0; index < clusterKeys.length; index += 1) {
        const sampled = clusterKeys[randomInt(rng, 0, clusterKeys.length - 1)] ?? clusterKeys[0]!;
        for (const pair of clusterBuckets.get(sampled) ?? []) {
          baseSum += pair.base;
          fencedSum += pair.fenced;
        }
      }
      draws.push(baseSum > 0 ? (fencedSum - baseSum) / baseSum : 0);
    }
  }
  draws.sort((left, right) => left - right);
  const interval = {
    lower: percentile(draws, 0.05),
    upper: percentile(draws, 0.95),
  };
  const equivalent = lowerP < H5_DECISION_RULE.thresholds.alpha
    && upperP < H5_DECISION_RULE.thresholds.alpha
    && interval.lower > -relativeMargin
    && interval.upper < relativeMargin
    && estimatedPower >= H5_DECISION_RULE.thresholds.utilityPowerMinimum;
  return {
    schemaVersion: 1,
    pairs: pairs.length,
    missingObservations,
    baselineMean,
    fencingMean,
    relativeDelta,
    relativeBootstrap90: interval,
    tost: { lowerP, upperP },
    estimatedPower,
    equivalent,
  };
}
