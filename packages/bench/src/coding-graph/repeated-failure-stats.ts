import path from "node:path";
import { writeFileAtomically } from "@remnic/core/maintenance/atomic-file";
import { compareCodePoints } from "../codepoint-order.js";
import { resolveContainedPath } from "../filename-safety.js";
import { createSeededRandom, type SeededRandom } from "../seeded-random.js";
import type {
  RepeatedFailureArm,
  RepeatedFailureEpisodeRow,
  RepeatedFailureExpectedDesign,
  RepeatedFailureRowIdentity,
} from "./repeated-failure-types.js";

export const REPEATED_FAILURE_STATISTICS_DRAWS = 10_000;
export const REPEATED_FAILURE_CONFIDENCE_LEVEL = 0.95;

export interface AnalyzeRepeatedFailureOptions {
  expectedDesign: RepeatedFailureExpectedDesign;
  timidityDesign?: RepeatedFailureExpectedDesign;
  seed: number;
  draws?: number;
  level?: number;
  alpha?: number;
  timingMinimumRrr?: number;
  timingMinimumAbsoluteBenefit?: number;
  timingMinimumBenefitIntervalLower?: number;
  contentMinimumRepeatedFailureBenefitIntervalLower?: number;
  contentMinimumTaskPassBenefitIntervalLower?: number;
  timidityPassMargin?: number;
  timidityStepsMargin?: number;
}

export interface RepeatedFailureInterval {
  lower: number;
  upper: number;
  level: number;
}

export interface RepeatedFailureNullableInterval {
  lower: number | null;
  upper: number | null;
  level: number;
}

export interface RepeatedFailureTaskCut {
  hypothesis: "TIMING" | "CONTENT" | "TIMIDITY";
  taskId: string;
  reasons: string[];
}

export interface RepeatedFailureEffectAnalysis {
  taskCount: number;
  baselineArm: RepeatedFailureArm;
  candidateArm: RepeatedFailureArm;
  interpretation: "CONFIRMATORY" | "EXPLORATORY_COMPLETE_TASKS";
  repeatedFailureBenefit: number | null;
  repeatedFailureBenefitInterval: RepeatedFailureInterval | null;
  relativeRiskReduction: number | null;
  relativeRiskReductionInterval: RepeatedFailureNullableInterval | null;
  nonEstimableRrrDraws: number;
  repeatedFailureP: number | null;
  taskPassBenefit: number | null;
  taskPassBenefitInterval: RepeatedFailureInterval | null;
  taskPassP: number | null;
}

export interface RepeatedFailureHolmResult {
  id: "TIMING" | "CONTENT";
  rawP: number;
  adjustedP: number;
  rank: number;
}

export interface RepeatedFailureTimidityAnalysis {
  taskCount: number;
  intervalLevel: 0.9;
  passRateDifference: number | null;
  passRateInterval: RepeatedFailureInterval | null;
  stepsDifference: number | null;
  stepsInterval: RepeatedFailureInterval | null;
  passMargin: number;
  stepsMargin: number;
  equivalent: boolean | null;
}

export type RepeatedFailureSupportDecision = "SUPPORTED" | "REJECTED" | "NOT_ESTIMABLE";

export interface RepeatedFailureStatisticalAnalysis {
  schemaVersion: 1;
  seed: number;
  draws: number;
  level: number;
  alpha: number;
  cuts: RepeatedFailureTaskCut[];
  timing: RepeatedFailureEffectAnalysis;
  content: RepeatedFailureEffectAnalysis;
  contentCompoundP: number | null;
  holm: RepeatedFailureHolmResult[];
  decisions: {
    timing: RepeatedFailureSupportDecision;
    content: RepeatedFailureSupportDecision;
  };
  studyDecision: "PASS" | "PARTIAL" | "REJECT" | "NOT_ESTIMABLE";
  timidity: RepeatedFailureTimidityAnalysis;
}

interface TaskArmMean {
  taskId: string;
  baselineRepeatedFailure: number;
  candidateRepeatedFailure: number;
  baselineTaskPass: number;
  candidateTaskPass: number;
  baselineSteps: number;
  candidateSteps: number;
}

interface ComparisonPreparation {
  groups: TaskArmMean[];
  cuts: RepeatedFailureTaskCut[];
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(sortedValues: readonly number[], quantile: number): number {
  const index = (sortedValues.length - 1) * Math.min(1, Math.max(0, quantile));
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);
  const lower = sortedValues[lowerIndex];
  const upper = sortedValues[upperIndex];
  if (lower === undefined || upper === undefined) {
    throw new Error("percentile requires at least one finite value");
  }
  if (lowerIndex === upperIndex) return lower;
  return lower + (upper - lower) * (index - lowerIndex);
}

function interval(values: number[], level: number): RepeatedFailureInterval {
  values.sort((left, right) => left - right);
  const tail = (1 - level) / 2;
  return {
    lower: percentile(values, tail),
    upper: percentile(values, 1 - tail),
    level,
  };
}

function identityKey(identity: RepeatedFailureRowIdentity): string {
  return JSON.stringify([
    identity.suiteVersion,
    identity.taskId,
    identity.variantId,
    identity.modelProfileId,
    identity.modelProfileHash,
    identity.seed,
    identity.arm,
  ]);
}

function cellKey(identity: RepeatedFailureRowIdentity): string {
  return JSON.stringify([
    identity.suiteVersion,
    identity.taskId,
    identity.variantId,
    identity.modelProfileId,
    identity.modelProfileHash,
    identity.seed,
  ]);
}

function assertCompatibleTimidityDesign(design: RepeatedFailureExpectedDesign): void {
  if (design.rows.length === 0) {
    throw new Error("timidityDesign must contain paired no-trap rows");
  }
  const cells = new Map<string, Set<RepeatedFailureArm>>();
  for (const identity of design.rows) {
    if (identity.arm !== "NO_MEMORY" && identity.arm !== "PRE_ACTION_FAILURE") {
      throw new Error("timidityDesign may contain only NO_MEMORY and PRE_ACTION_FAILURE rows");
    }
    const key = cellKey(identity);
    const arms = cells.get(key) ?? new Set<RepeatedFailureArm>();
    if (arms.has(identity.arm)) {
      throw new Error(`timidityDesign has a duplicate ${identity.arm} row for ${key}`);
    }
    arms.add(identity.arm);
    cells.set(key, arms);
  }
  for (const [key, arms] of cells) {
    if (!arms.has("NO_MEMORY") || !arms.has("PRE_ACTION_FAILURE")) {
      throw new Error(`timidityDesign has an incomplete no-trap pair for ${key}`);
    }
  }
}

function prepareComparison(
  rows: readonly RepeatedFailureEpisodeRow[],
  expectedDesign: RepeatedFailureExpectedDesign,
  baselineArm: RepeatedFailureArm,
  candidateArm: RepeatedFailureArm,
  hypothesis: RepeatedFailureTaskCut["hypothesis"],
  requireMatchedFacts: boolean
): ComparisonPreparation {
  const actualByIdentity = new Map<string, RepeatedFailureEpisodeRow[]>();
  for (const row of rows) {
    const key = identityKey(row.identity);
    const existing = actualByIdentity.get(key) ?? [];
    existing.push(row);
    actualByIdentity.set(key, existing);
  }

  const expectedByTask = new Map<string, RepeatedFailureRowIdentity[]>();
  for (const identity of expectedDesign.rows) {
    if (identity.arm !== baselineArm && identity.arm !== candidateArm) continue;
    const taskRows = expectedByTask.get(identity.taskId) ?? [];
    taskRows.push(identity);
    expectedByTask.set(identity.taskId, taskRows);
  }

  const groups: TaskArmMean[] = [];
  const cuts: RepeatedFailureTaskCut[] = [];
  for (
    const [taskId, expected] of [...expectedByTask.entries()].sort(
      ([left], [right]) => compareCodePoints(left, right),
    )
  ) {
    const reasons = new Set<string>();
    const expectedCells = new Map<string, Partial<Record<RepeatedFailureArm, RepeatedFailureRowIdentity>>>();
    for (const identity of expected) {
      const key = cellKey(identity);
      const cell = expectedCells.get(key) ?? {};
      if (cell[identity.arm]) reasons.add(`DUPLICATE_EXPECTED:${identity.arm}:${key}`);
      cell[identity.arm] = identity;
      expectedCells.set(key, cell);
    }

    const baselineRows: RepeatedFailureEpisodeRow[] = [];
    const candidateRows: RepeatedFailureEpisodeRow[] = [];
    for (const [key, cell] of expectedCells) {
      for (const arm of [baselineArm, candidateArm] as const) {
        const expectedIdentity = cell[arm];
        if (!expectedIdentity) {
          reasons.add(`MISSING_DESIGN_CELL:${arm}:${key}`);
          continue;
        }
        const matches = actualByIdentity.get(identityKey(expectedIdentity)) ?? [];
        if (matches.length === 0) {
          reasons.add(`MISSING_ROW:${arm}:${key}`);
          continue;
        }
        if (matches.length > 1) reasons.add(`DUPLICATE_ROW:${arm}:${key}`);
        const row = matches[0];
        if (!row) {
          reasons.add(`MISSING_ROW:${arm}:${key}`);
          continue;
        }
        if (row.status !== "VALID") {
          reasons.add(`INVALID_ROW:${arm}:${row.invalidReason ?? "UNKNOWN"}`);
          continue;
        }
        if (
          typeof row.repeatedFailure !== "boolean" ||
          typeof row.taskPassed !== "boolean" ||
          typeof row.steps !== "number" ||
          !Number.isFinite(row.steps)
        ) {
          reasons.add(`MALFORMED_METRICS:${arm}`);
          continue;
        }
        if (requireMatchedFacts && row.factPairAudit !== "MATCHED") {
          reasons.add(`UNMATCHED_FACTS:${arm}`);
          continue;
        }
        (arm === baselineArm ? baselineRows : candidateRows).push(row);
      }
    }

    if (reasons.size > 0 || baselineRows.length === 0 || candidateRows.length === 0) {
      cuts.push({
        hypothesis,
        taskId,
        reasons: [...reasons].sort(compareCodePoints),
      });
      continue;
    }
    groups.push({
      taskId,
      baselineRepeatedFailure: mean(baselineRows.map((row) => Number(row.repeatedFailure))),
      candidateRepeatedFailure: mean(candidateRows.map((row) => Number(row.repeatedFailure))),
      baselineTaskPass: mean(baselineRows.map((row) => Number(row.taskPassed))),
      candidateTaskPass: mean(candidateRows.map((row) => Number(row.taskPassed))),
      baselineSteps: mean(baselineRows.map((row) => {
        if (typeof row.steps !== "number") throw new Error("validated baseline row lost steps");
        return row.steps;
      })),
      candidateSteps: mean(candidateRows.map((row) => {
        if (typeof row.steps !== "number") throw new Error("validated candidate row lost steps");
        return row.steps;
      })),
    });
  }
  return { groups, cuts };
}

function bootstrapGroups(
  groups: readonly TaskArmMean[],
  draws: number,
  level: number,
  random: SeededRandom
): {
  repeatedFailureBenefitInterval: RepeatedFailureInterval;
  taskPassBenefitInterval: RepeatedFailureInterval;
  rrrInterval: RepeatedFailureNullableInterval | null;
  nonEstimableRrrDraws: number;
  stepsDifferenceInterval: RepeatedFailureInterval;
} {
  const failureBenefits: number[] = [];
  const passBenefits: number[] = [];
  const rrrs: number[] = [];
  const stepsDifferences: number[] = [];
  let nonEstimableRrrDraws = 0;
  for (let draw = 0; draw < draws; draw += 1) {
    const sampled: TaskArmMean[] = [];
    for (let index = 0; index < groups.length; index += 1) {
      const sampledGroup = groups[Math.floor(random() * groups.length)];
      if (!sampledGroup) throw new Error("grouped bootstrap sampled an empty task set");
      sampled.push(sampledGroup);
    }
    const baselineRisk = mean(sampled.map((group) => group.baselineRepeatedFailure));
    const candidateRisk = mean(sampled.map((group) => group.candidateRepeatedFailure));
    failureBenefits.push(baselineRisk - candidateRisk);
    passBenefits.push(mean(sampled.map((group) => group.candidateTaskPass - group.baselineTaskPass)));
    stepsDifferences.push(mean(sampled.map((group) => group.candidateSteps - group.baselineSteps)));
    if (baselineRisk === 0) {
      nonEstimableRrrDraws += 1;
    } else {
      rrrs.push((baselineRisk - candidateRisk) / baselineRisk);
    }
  }
  return {
    repeatedFailureBenefitInterval: interval(failureBenefits, level),
    taskPassBenefitInterval: interval(passBenefits, level),
    rrrInterval:
      rrrs.length > 0
        ? {
            ...interval(rrrs, level),
            level,
          }
        : null,
    nonEstimableRrrDraws,
    stepsDifferenceInterval: interval(stepsDifferences, level),
  };
}

function groupedShuffleP(
  groups: readonly TaskArmMean[],
  draws: number,
  random: SeededRandom,
  metric: "REPEATED_FAILURE" | "TASK_PASS"
): number {
  const observed =
    metric === "REPEATED_FAILURE"
      ? mean(groups.map((group) => group.baselineRepeatedFailure - group.candidateRepeatedFailure))
      : mean(groups.map((group) => group.candidateTaskPass - group.baselineTaskPass));
  let extreme = 0;
  for (let draw = 0; draw < draws; draw += 1) {
    let shuffledEffect = 0;
    for (const group of groups) {
      const sign = random() < 0.5 ? 1 : -1;
      const effect =
        metric === "REPEATED_FAILURE"
          ? group.baselineRepeatedFailure - group.candidateRepeatedFailure
          : group.candidateTaskPass - group.baselineTaskPass;
      shuffledEffect += sign * effect;
    }
    if (shuffledEffect / groups.length >= observed) extreme += 1;
  }
  return (extreme + 1) / (draws + 1);
}

function analyzeComparison(
  preparation: ComparisonPreparation,
  baselineArm: RepeatedFailureArm,
  candidateArm: RepeatedFailureArm,
  draws: number,
  level: number,
  seed: number
): RepeatedFailureEffectAnalysis {
  const { groups } = preparation;
  if (groups.length === 0) {
    return {
      taskCount: 0,
      baselineArm,
      candidateArm,
      interpretation: preparation.cuts.length === 0 ? "CONFIRMATORY" : "EXPLORATORY_COMPLETE_TASKS",
      repeatedFailureBenefit: null,
      repeatedFailureBenefitInterval: null,
      relativeRiskReduction: null,
      relativeRiskReductionInterval: null,
      nonEstimableRrrDraws: 0,
      repeatedFailureP: null,
      taskPassBenefit: null,
      taskPassBenefitInterval: null,
      taskPassP: null,
    };
  }
  const baselineRisk = mean(groups.map((group) => group.baselineRepeatedFailure));
  const candidateRisk = mean(groups.map((group) => group.candidateRepeatedFailure));
  const bootstrapped = bootstrapGroups(groups, draws, level, createSeededRandom(seed));
  return {
    taskCount: groups.length,
    baselineArm,
    candidateArm,
    interpretation: preparation.cuts.length === 0 ? "CONFIRMATORY" : "EXPLORATORY_COMPLETE_TASKS",
    repeatedFailureBenefit: baselineRisk - candidateRisk,
    repeatedFailureBenefitInterval: bootstrapped.repeatedFailureBenefitInterval,
    relativeRiskReduction: baselineRisk === 0 ? null : (baselineRisk - candidateRisk) / baselineRisk,
    relativeRiskReductionInterval: bootstrapped.rrrInterval,
    nonEstimableRrrDraws: bootstrapped.nonEstimableRrrDraws,
    repeatedFailureP: groupedShuffleP(
      groups,
      draws,
      createSeededRandom((seed ^ 0x7f4a7c15) >>> 0),
      "REPEATED_FAILURE"
    ),
    taskPassBenefit: mean(groups.map((group) => group.candidateTaskPass - group.baselineTaskPass)),
    taskPassBenefitInterval: bootstrapped.taskPassBenefitInterval,
    taskPassP: groupedShuffleP(
      groups,
      draws,
      createSeededRandom((seed ^ 0x9e3779b9) >>> 0),
      "TASK_PASS"
    ),
  };
}

export function holmAdjust(
  hypotheses: readonly { id: "TIMING" | "CONTENT"; p: number }[]
): RepeatedFailureHolmResult[] {
  const sorted = [...hypotheses].sort(
    (left, right) => left.p - right.p || compareCodePoints(left.id, right.id),
  );
  let priorAdjusted = 0;
  const adjustedById = new Map<"TIMING" | "CONTENT", RepeatedFailureHolmResult>();
  sorted.forEach((hypothesis, index) => {
    const adjustedP = Math.min(1, Math.max(priorAdjusted, (sorted.length - index) * hypothesis.p));
    priorAdjusted = adjustedP;
    adjustedById.set(hypothesis.id, {
      id: hypothesis.id,
      rawP: hypothesis.p,
      adjustedP,
      rank: index + 1,
    });
  });
  return hypotheses.map((hypothesis) => {
    const adjusted = adjustedById.get(hypothesis.id);
    if (!adjusted) throw new Error(`missing Holm result for ${hypothesis.id}`);
    return adjusted;
  });
}
export function decideRepeatedFailureTiming(
  timing: RepeatedFailureEffectAnalysis,
  adjustedP: number | undefined,
  minimumRrr: number,
  minimumAbsoluteBenefit: number,
  minimumBenefitIntervalLower: number,
  alpha: number,
): RepeatedFailureSupportDecision {
  if (
    timing.taskCount === 0 ||
    timing.repeatedFailureBenefit === null ||
    timing.relativeRiskReduction === null ||
    timing.relativeRiskReductionInterval === null ||
    timing.repeatedFailureBenefitInterval === null ||
    timing.repeatedFailureP === null ||
    adjustedP === undefined
  ) {
    return "NOT_ESTIMABLE";
  }
  return timing.repeatedFailureBenefit >= minimumAbsoluteBenefit &&
    timing.relativeRiskReduction >= minimumRrr &&
    timing.repeatedFailureBenefitInterval.lower > minimumBenefitIntervalLower &&
    adjustedP < alpha
    ? "SUPPORTED"
    : "REJECTED";
}

export function decideRepeatedFailureContent(
  content: RepeatedFailureEffectAnalysis,
  compoundP: number | null,
  adjustedP: number | undefined,
  minimumRepeatedFailureBenefitIntervalLower: number,
  minimumTaskPassBenefitIntervalLower: number,
  alpha: number,
): RepeatedFailureSupportDecision {
  if (
    content.taskCount === 0 ||
    content.repeatedFailureBenefitInterval === null ||
    content.taskPassBenefitInterval === null ||
    compoundP === null ||
    adjustedP === undefined
  ) {
    return "NOT_ESTIMABLE";
  }
  return content.repeatedFailureBenefitInterval.lower > minimumRepeatedFailureBenefitIntervalLower &&
    content.taskPassBenefitInterval.lower > minimumTaskPassBenefitIntervalLower &&
    adjustedP < alpha
    ? "SUPPORTED"
    : "REJECTED";
}

export function decideRepeatedFailureStudy(
  timing: RepeatedFailureSupportDecision,
  content: RepeatedFailureSupportDecision,
): RepeatedFailureStatisticalAnalysis["studyDecision"] {
  if (timing === "NOT_ESTIMABLE" || content === "NOT_ESTIMABLE") return "NOT_ESTIMABLE";
  if (timing === "SUPPORTED" && content === "SUPPORTED") return "PASS";
  if (timing === "SUPPORTED" || content === "SUPPORTED") return "PARTIAL";
  return "REJECT";
}

export function relativeRiskReduction(baselineRisk: number, candidateRisk: number): number | null {
  return baselineRisk === 0 ? null : (baselineRisk - candidateRisk) / baselineRisk;
}

export function isRepeatedFailureTimidityEquivalent(
  passRateInterval: RepeatedFailureInterval,
  stepsInterval: RepeatedFailureInterval,
  passMargin: number,
  stepsMargin: number
): boolean {
  return (
    passRateInterval.lower > -passMargin &&
    passRateInterval.upper < passMargin &&
    stepsInterval.lower > -stepsMargin &&
    stepsInterval.upper < stepsMargin
  );
}

export function analyzeRepeatedFailureRows(
  rows: readonly RepeatedFailureEpisodeRow[],
  options: AnalyzeRepeatedFailureOptions
): RepeatedFailureStatisticalAnalysis {
  const draws = options.draws ?? REPEATED_FAILURE_STATISTICS_DRAWS;
  const level = options.level ?? REPEATED_FAILURE_CONFIDENCE_LEVEL;
  const alpha = options.alpha ?? 0.05;
  const timingMinimumRrr = options.timingMinimumRrr ?? 0.3;
  const timingMinimumAbsoluteBenefit = options.timingMinimumAbsoluteBenefit ?? 0.05;
  const timingMinimumBenefitIntervalLower = options.timingMinimumBenefitIntervalLower ?? 0;
  const contentMinimumRepeatedFailureBenefitIntervalLower =
    options.contentMinimumRepeatedFailureBenefitIntervalLower ?? 0;
  const contentMinimumTaskPassBenefitIntervalLower =
    options.contentMinimumTaskPassBenefitIntervalLower ?? 0;
  const timidityPassMargin = options.timidityPassMargin ?? 0.02;
  const timidityStepsMargin = options.timidityStepsMargin ?? 2;
  if (!Number.isSafeInteger(draws) || draws <= 0) throw new Error("draws must be a positive safe integer");
  if (!(level > 0 && level < 1) || !(alpha > 0 && alpha < 1)) throw new Error("level and alpha must be in (0, 1)");
  if (!Number.isSafeInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff) {
    throw new Error("seed must be an integer in [0, 2^32 - 1]");
  }

  const timingPreparation = prepareComparison(
    rows,
    options.expectedDesign,
    "TURN_START_FAILURE",
    "PRE_ACTION_FAILURE",
    "TIMING",
    false
  );
  const contentPreparation = prepareComparison(
    rows,
    options.expectedDesign,
    "TURN_START_SUCCESS",
    "TURN_START_FAILURE",
    "CONTENT",
    true
  );
  const timidityRequested =
    options.timidityDesign !== undefined ||
    options.timidityPassMargin !== undefined ||
    options.timidityStepsMargin !== undefined;
  if (timidityRequested && !options.timidityDesign) {
    throw new Error("timidity analysis requires a compatible timidityDesign");
  }
  let timidityPreparation: ComparisonPreparation = { groups: [], cuts: [] };
  if (options.timidityDesign) {
    assertCompatibleTimidityDesign(options.timidityDesign);
    timidityPreparation = prepareComparison(
      rows,
      options.timidityDesign,
      "NO_MEMORY",
      "PRE_ACTION_FAILURE",
      "TIMIDITY",
      false
    );
  }
  const timing = analyzeComparison(
    timingPreparation,
    "TURN_START_FAILURE",
    "PRE_ACTION_FAILURE",
    draws,
    level,
    (options.seed ^ 0x13579bdf) >>> 0
  );
  const content = analyzeComparison(
    contentPreparation,
    "TURN_START_SUCCESS",
    "TURN_START_FAILURE",
    draws,
    level,
    (options.seed ^ 0x2468ace0) >>> 0
  );
  const contentCompoundP =
    content.repeatedFailureP === null || content.taskPassP === null
      ? null
      : Math.max(content.repeatedFailureP, content.taskPassP);
  const primaries: { id: "TIMING" | "CONTENT"; p: number }[] = [];
  if (timing.repeatedFailureP !== null) primaries.push({ id: "TIMING", p: timing.repeatedFailureP });
  if (contentCompoundP !== null) primaries.push({ id: "CONTENT", p: contentCompoundP });
  const holm = primaries.length === 2 ? holmAdjust(primaries) : [];
  const timingAdjustedP = holm.find((entry) => entry.id === "TIMING")?.adjustedP;
  const contentAdjustedP = holm.find((entry) => entry.id === "CONTENT")?.adjustedP;

  const timidityGroups = timidityPreparation.groups;
  let timidity: RepeatedFailureTimidityAnalysis;
  if (timidityGroups.length === 0) {
    timidity = {
      taskCount: 0,
      intervalLevel: 0.9,
      passRateDifference: null,
      passRateInterval: null,
      stepsDifference: null,
      stepsInterval: null,
      passMargin: timidityPassMargin,
      stepsMargin: timidityStepsMargin,
      equivalent: null,
    };
  } else {
    const bootstrap = bootstrapGroups(
      timidityGroups,
      draws,
      0.9,
      createSeededRandom((options.seed ^ 0x5a5a5a5a) >>> 0)
    );
    const passRateDifference = mean(
      timidityGroups.map((group) => group.candidateTaskPass - group.baselineTaskPass)
    );
    const stepsDifference = mean(
      timidityGroups.map((group) => group.candidateSteps - group.baselineSteps)
    );
    timidity = {
      taskCount: timidityGroups.length,
      intervalLevel: 0.9,
      passRateDifference,
      passRateInterval: bootstrap.taskPassBenefitInterval,
      stepsDifference,
      stepsInterval: bootstrap.stepsDifferenceInterval,
      passMargin: timidityPassMargin,
      stepsMargin: timidityStepsMargin,
      equivalent: timidityPreparation.cuts.length > 0
        ? null
        : isRepeatedFailureTimidityEquivalent(
          bootstrap.taskPassBenefitInterval,
          bootstrap.stepsDifferenceInterval,
          timidityPassMargin,
          timidityStepsMargin,
        ),
    };
  }

  const timingDecision = timingPreparation.cuts.length > 0
    ? "NOT_ESTIMABLE"
    : decideRepeatedFailureTiming(
      timing,
      timingAdjustedP,
      timingMinimumRrr,
      timingMinimumAbsoluteBenefit,
      timingMinimumBenefitIntervalLower,
      alpha,
    );
  const contentDecision = contentPreparation.cuts.length > 0
    ? "NOT_ESTIMABLE"
    : decideRepeatedFailureContent(
      content,
      contentCompoundP,
      contentAdjustedP,
      contentMinimumRepeatedFailureBenefitIntervalLower,
      contentMinimumTaskPassBenefitIntervalLower,
      alpha,
    );
  return {
    schemaVersion: 1,
    seed: options.seed,
    draws,
    level,
    alpha,
    cuts: [...timingPreparation.cuts, ...contentPreparation.cuts, ...timidityPreparation.cuts].sort(
      (left, right) => compareCodePoints(left.hypothesis, right.hypothesis)
        || compareCodePoints(left.taskId, right.taskId),
    ),
    timing,
    content,
    contentCompoundP,
    holm,
    decisions: {
      timing: timingDecision,
      content: contentDecision,
    },
    studyDecision: decideRepeatedFailureStudy(timingDecision, contentDecision),
    timidity,
  };
}

export async function writeRepeatedFailureStatistics(
  outputDir: string,
  analysis: RepeatedFailureStatisticalAnalysis,
  fileName = "statistics.json"
): Promise<string> {
  const filePath = resolveContainedPath(path.resolve(outputDir), fileName);
  await writeFileAtomically(filePath, `${JSON.stringify(analysis, null, 2)}\n`);
  return filePath;
}
