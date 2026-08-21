/**
 * Cohen's kappa — inter-rater agreement for the cross-tier judge calibration
 * (issue #1573 PR3).
 *
 * The local-lab protocol (#1573) needs a single number that says whether the
 * cheap local judge agrees with the expensive frontier judge closely enough to
 * trust it for regression runs. Cohen's kappa is the standard measure: it
 * corrects raw agreement for the agreement you would see by chance, so a
 * reported 0.9 on a binary task where both judges say "correct" 95% of the
 * time is not actually impressive.
 *
 * This module is pure: it operates on parallel arrays of category labels and
 * has no I/O, no globals, and no module-level mutable state (rule 11). The
 * calibration orchestration that turns numeric judge scores into labels and
 * drives both judges lives in `./calibration-slice.ts`.
 */

/** A rater-assigned category label. Free-form string (e.g. "correct"). */
export type JudgeCategory = string;

export interface CohenKappaResult {
  /** Cohen's kappa in [-1, 1]. 1 = perfect agreement, 0 = chance, <0 = systematic disagreement. */
  kappa: number;
  /** Observed proportional agreement (fraction of identical labels). In [0, 1]. */
  observedAgreement: number;
  /** Expected chance agreement given the marginal distributions. In [0, 1]. */
  expectedAgreement: number;
  /** Number of paired judgements. */
  sampleSize: number;
  /** Distinct category labels seen across both raters (sorted). */
  categories: readonly JudgeCategory[];
}

export interface KappaConfidenceInterval {
  lower: number;
  upper: number;
  level: number;
}

export interface BootstrapKappaOptions {
  /** Number of paired bootstrap resamples. */
  iterations?: number;
  /** Confidence level in (0, 1). */
  level?: number;
  /** Optional deterministic seed. Derived from the labels when omitted. */
  seed?: number;
}

export interface BootstrapKappaResult {
  confidenceInterval: KappaConfidenceInterval;
  bootstrapSamples: number;
}

export const DEFAULT_KAPPA_BOOTSTRAP_SAMPLES = 2_000;
export const DEFAULT_KAPPA_CONFIDENCE_LEVEL = 0.95;

/**
 * Compute Cohen's kappa from two parallel arrays of category labels.
 *
 * Throws when the arrays have mismatched lengths or are empty — kappa on zero
 * samples is meaningless and callers should surface that as an operator error
 * rather than a fabricated 0.
 *
 * Degenerate case: when every item lands in a single category for both raters,
 * the chance-agreement denominator collapses to zero. By convention perfect
 * agreement in that case returns kappa = 1 (the raters agreed on everything;
 * there just was nothing to distinguish). Imperfect agreement with a zero
 * denominator is impossible (a single shared category forces agreement), so
 * the branch is unreachable for well-formed input — but the guard keeps the
 * function total and returns 0 defensively.
 */
export function computeCohensKappa(
  raterA: readonly JudgeCategory[],
  raterB: readonly JudgeCategory[],
): CohenKappaResult {
  if (raterA.length !== raterB.length) {
    throw new Error(
      `computeCohensKappa: rater arrays must have equal length; got ${raterA.length} and ${raterB.length}.`,
    );
  }
  const sampleSize = raterA.length;
  if (sampleSize === 0) {
    throw new Error("computeCohensKappa: cannot compute kappa over zero paired judgements.");
  }

  // Marginal counts: how many times each rater used each category.
  const countA = new Map<JudgeCategory, number>();
  const countB = new Map<JudgeCategory, number>();
  let observedAgreements = 0;
  for (let index = 0; index < sampleSize; index += 1) {
    const labelA = raterA[index];
    const labelB = raterB[index];
    if (labelA === labelB) {
      observedAgreements += 1;
    }
    countA.set(labelA, (countA.get(labelA) ?? 0) + 1);
    countB.set(labelB, (countB.get(labelB) ?? 0) + 1);
  }

  const categories = new Set<JudgeCategory>([...countA.keys(), ...countB.keys()]);
  const observedAgreement = observedAgreements / sampleSize;

  // Expected chance agreement = Σ_c P(A=c) * P(B=c).
  let expectedAgreement = 0;
  for (const category of categories) {
    const probA = (countA.get(category) ?? 0) / sampleSize;
    const probB = (countB.get(category) ?? 0) / sampleSize;
    expectedAgreement += probA * probB;
  }

  const denominator = 1 - expectedAgreement;
  let kappa: number;
  if (denominator === 0) {
    // Single-category collapse: every judgement from both raters is the same
    // label. Perfect agreement → kappa = 1 by convention.
    kappa = observedAgreement === 1 ? 1 : 0;
  } else {
    kappa = (observedAgreement - expectedAgreement) / denominator;
  }

  return {
    kappa,
    observedAgreement,
    expectedAgreement,
    sampleSize,
    categories: [...categories].sort(),
  };
}

/**
 * Deterministic paired-bootstrap percentile interval for Cohen's kappa.
 *
 * Each resample draws paired verdict indexes, preserving the dependence
 * between the two raters. The default seed is derived from the complete label
 * vectors, so the same calibration answer set and verdicts produce byte-for-
 * byte identical confidence bounds across reruns.
 */
export function bootstrapCohensKappaConfidenceInterval(
  raterA: readonly JudgeCategory[],
  raterB: readonly JudgeCategory[],
  options: BootstrapKappaOptions = {},
): BootstrapKappaResult {
  if (raterA.length !== raterB.length) {
    throw new Error(
      `bootstrapCohensKappaConfidenceInterval: rater arrays must have equal length; got ${raterA.length} and ${raterB.length}.`,
    );
  }
  if (raterA.length === 0) {
    throw new Error("bootstrapCohensKappaConfidenceInterval: cannot bootstrap zero paired judgements.");
  }
  const iterations = options.iterations ?? DEFAULT_KAPPA_BOOTSTRAP_SAMPLES;
  const level = options.level ?? DEFAULT_KAPPA_CONFIDENCE_LEVEL;
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new Error(`bootstrapCohensKappaConfidenceInterval: iterations must be a positive integer; got ${String(iterations)}.`);
  }
  if (!(level > 0 && level < 1)) {
    throw new Error(`bootstrapCohensKappaConfidenceInterval: level must be between 0 and 1; got ${String(level)}.`);
  }

  const derivedSeed = options.seed ?? hashLabelsToSeed(raterA, raterB);
  const random = mulberry32(derivedSeed >>> 0);
  const kappas: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sampleA: JudgeCategory[] = [];
    const sampleB: JudgeCategory[] = [];
    for (let index = 0; index < raterA.length; index += 1) {
      const picked = Math.floor(random() * raterA.length);
      sampleA.push(raterA[picked]!);
      sampleB.push(raterB[picked]!);
    }
    kappas.push(computeCohensKappa(sampleA, sampleB).kappa);
  }
  kappas.sort((left, right) => left - right);
  const tail = (1 - level) / 2;
  return {
    confidenceInterval: {
      lower: percentile(kappas, tail),
      upper: percentile(kappas, 1 - tail),
      level,
    },
    bootstrapSamples: iterations,
  };
}

function percentile(sortedValues: readonly number[], fraction: number): number {
  const position = (sortedValues.length - 1) * fraction;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sortedValues[lowerIndex]!;
  const upper = sortedValues[upperIndex]!;
  return lowerIndex === upperIndex ? lower : lower + (upper - lower) * (position - lowerIndex);
}

function hashLabelsToSeed(
  raterA: readonly JudgeCategory[],
  raterB: readonly JudgeCategory[],
): number {
  const value = JSON.stringify([raterA, raterB]);
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Default correct/incorrect decision threshold for a 0..1 judge score. */
export const DEFAULT_JUDGE_BINARIZATION_THRESHOLD = 0.5;

/**
 * Map a numeric judge score to a binary "correct"/"incorrect" category label.
 * Scores ≥ threshold → "correct"; otherwise "incorrect". Non-finite scores
 * (NaN/Infinity from a broken judge) are bucketed as "incorrect" so a single
 * bad verdict does not crash calibration — they still count as disagreement
 * against a finite frontier verdict.
 */
export function binarizeJudgeScore(
  score: number,
  threshold: number = DEFAULT_JUDGE_BINARIZATION_THRESHOLD,
): JudgeCategory {
  if (typeof score !== "number" || !Number.isFinite(score)) {
    return "incorrect";
  }
  return score >= threshold ? "correct" : "incorrect";
}
