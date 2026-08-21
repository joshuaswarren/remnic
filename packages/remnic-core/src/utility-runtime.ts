import { clamp01 } from "./lifecycle.js";
import type { TierRoutingPolicy } from "./tier-routing.js";
import { readUtilityLearningSnapshot } from "./utility-learner.js";

const RANKING_MULTIPLIER_LIMIT = 0.12;
const PROMOTION_THRESHOLD_DELTA_LIMIT = 0.07;
const PROMOTION_THRESHOLD_WEIGHT_FACTOR = 0.2;

export interface UtilityRuntimeValues {
  rankingBoostMultiplier: number;
  rankingSuppressMultiplier: number;
  promoteThresholdDelta: number;
  demoteThresholdDelta: number;
  snapshotUpdatedAt: string;
}

function roundRuntimeValue(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clampSigned(value: number, limit: number): number {
  if (!Number.isFinite(value) || limit <= 0) return 0;
  return Math.max(-limit, Math.min(limit, value));
}

function learnedWeightFor(
  snapshot: NonNullable<Awaited<ReturnType<typeof readUtilityLearningSnapshot>>>,
  target: "promotion" | "ranking",
  decision: "promote" | "demote" | "boost" | "suppress",
): number {
  const entry = snapshot.weights.find((weight) => weight.target === target && weight.decision === decision);
  return entry?.learnedWeight ?? 0;
}

export async function loadUtilityRuntimeValues(options: {
  memoryDir: string;
  utilityTelemetryDir?: string;
  memoryUtilityLearningEnabled: boolean;
  promotionByOutcomeEnabled: boolean;
}): Promise<UtilityRuntimeValues | null> {
  if (!options.memoryUtilityLearningEnabled || !options.promotionByOutcomeEnabled) return null;
  const snapshot = await readUtilityLearningSnapshot(options.memoryDir, options.utilityTelemetryDir);
  if (!snapshot) return null;

  return {
    rankingBoostMultiplier: roundRuntimeValue(
      1 + clampSigned(learnedWeightFor(snapshot, "ranking", "boost"), RANKING_MULTIPLIER_LIMIT),
    ),
    rankingSuppressMultiplier: roundRuntimeValue(
      1 + clampSigned(learnedWeightFor(snapshot, "ranking", "suppress"), RANKING_MULTIPLIER_LIMIT),
    ),
    promoteThresholdDelta: roundRuntimeValue(
      clampSigned(
        learnedWeightFor(snapshot, "promotion", "promote") * -PROMOTION_THRESHOLD_WEIGHT_FACTOR,
        PROMOTION_THRESHOLD_DELTA_LIMIT,
      ),
    ),
    demoteThresholdDelta: roundRuntimeValue(
      clampSigned(
        learnedWeightFor(snapshot, "promotion", "demote") * PROMOTION_THRESHOLD_WEIGHT_FACTOR,
        PROMOTION_THRESHOLD_DELTA_LIMIT,
      ),
    ),
    snapshotUpdatedAt: snapshot.updatedAt,
  };
}

export function applyUtilityRankingRuntimeDelta(
  delta: number,
  runtime: UtilityRuntimeValues | null,
  mode: "boost" | "suppress",
): number {
  if (!runtime || !Number.isFinite(delta) || delta === 0) return delta;
  const multiplier = mode === "boost" ? runtime.rankingBoostMultiplier : runtime.rankingSuppressMultiplier;
  return roundRuntimeValue(delta * multiplier);
}

export function applyUtilityPromotionRuntimePolicy(
  policy: TierRoutingPolicy,
  runtime: UtilityRuntimeValues | null,
): TierRoutingPolicy {
  if (!runtime) return policy;
  return {
    ...policy,
    demotionValueThreshold: roundRuntimeValue(clamp01(policy.demotionValueThreshold + runtime.demoteThresholdDelta)),
    promotionValueThreshold: roundRuntimeValue(clamp01(policy.promotionValueThreshold + runtime.promoteThresholdDelta)),
  };
}
