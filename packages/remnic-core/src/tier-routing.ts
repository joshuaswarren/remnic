import { type LifecycleSignals, clamp01, computeLifecycleValueInputs, daysSince } from "./lifecycle.js";
import { SUPPORT_PASSPORT_ATTRIBUTE_KEYS, SUPPORT_PASSPORT_CARD_TAG } from "./support-passport/card-projection.js";
import { SupportPassportCardCategorySchema, SupportPassportNamespaceSchema } from "./support-passport/contracts.js";
import type { MemoryFile } from "./types.js";

export type MemoryTier = "hot" | "cold";

export interface TierRoutingPolicy {
  enabled: boolean;
  demotionMinAgeDays: number;
  demotionValueThreshold: number;
  promotionValueThreshold: number;
}

export interface TierTransitionDecision {
  currentTier: MemoryTier;
  nextTier: MemoryTier;
  valueScore: number;
  changed: boolean;
  reason: string;
}

function requiresHotTier(memory: Pick<MemoryFile, "frontmatter">): boolean {
  const { category, status, structuredAttributes, tags } = memory.frontmatter;
  if (
    category !== "preference" ||
    (status !== "active" && status !== "pending_review") ||
    tags?.includes(SUPPORT_PASSPORT_CARD_TAG) !== true ||
    !structuredAttributes
  ) {
    return false;
  }
  const namespace = structuredAttributes[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.namespace];
  const owner = structuredAttributes[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.owner];
  const title = structuredAttributes[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.title];
  const cardCategory = structuredAttributes[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.category];
  return (
    SupportPassportNamespaceSchema.safeParse(namespace).success &&
    typeof owner === "string" &&
    /^[a-f0-9]{64}$/.test(owner) &&
    typeof title === "string" &&
    title.length > 0 &&
    SupportPassportCardCategorySchema.safeParse(cardCategory).success
  );
}

export function computeTierValueScore(
  memory: Pick<MemoryFile, "frontmatter">,
  now: Date,
  signals?: LifecycleSignals
): number {
  const fm = memory.frontmatter;
  const inputs = computeLifecycleValueInputs(memory, now, signals);
  const correctionBoost = fm.category === "correction" ? 0.08 : 0;
  const confirmedBoost = fm.verificationState === "user_confirmed" ? 0.05 : 0;

  const score =
    inputs.confidence * 0.24 +
    inputs.access * 0.26 +
    inputs.recency * 0.2 +
    inputs.importance * 0.2 +
    inputs.feedback * 0.1 +
    correctionBoost +
    confirmedBoost -
    inputs.disputedPenalty * 0.5;

  return clamp01(score);
}

export function decideTierTransition(
  memory: Pick<MemoryFile, "frontmatter">,
  currentTier: MemoryTier,
  policy: TierRoutingPolicy,
  now: Date,
  signals?: LifecycleSignals
): TierTransitionDecision {
  const valueScore = computeTierValueScore(memory, now, signals);
  if (!policy.enabled) {
    return {
      currentTier,
      nextTier: currentTier,
      valueScore,
      changed: false,
      reason: "tier_migration_disabled",
    };
  }

  if (requiresHotTier(memory)) {
    return {
      currentTier,
      nextTier: "hot",
      valueScore,
      changed: currentTier !== "hot",
      reason: "support_passport_card_requires_hot_tier",
    };
  }

  if (currentTier === "hot") {
    const ageDays = daysSince(memory.frontmatter.updated ?? memory.frontmatter.created, now.getTime());
    if (ageDays >= policy.demotionMinAgeDays && valueScore <= policy.demotionValueThreshold) {
      return {
        currentTier,
        nextTier: "cold",
        valueScore,
        changed: true,
        reason: "value_below_demotion_threshold",
      };
    }
    return {
      currentTier,
      nextTier: currentTier,
      valueScore,
      changed: false,
      reason: ageDays < policy.demotionMinAgeDays ? "demotion_min_age_not_met" : "value_above_demotion_threshold",
    };
  }

  if (valueScore >= policy.promotionValueThreshold) {
    return {
      currentTier,
      nextTier: "hot",
      valueScore,
      changed: true,
      reason: "value_above_promotion_threshold",
    };
  }
  return {
    currentTier,
    nextTier: currentTier,
    valueScore,
    changed: false,
    reason: "value_below_promotion_threshold",
  };
}
