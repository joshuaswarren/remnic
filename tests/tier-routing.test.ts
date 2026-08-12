import test from "node:test";
import assert from "node:assert/strict";
import { computeTierValueScore, decideTierTransition } from "../src/tier-routing.js";

function memory(overrides?: Record<string, unknown>): any {
  return {
    frontmatter: {
      id: "m1",
      category: "fact",
      confidence: 0.8,
      confidenceTier: "implied",
      accessCount: 6,
      created: "2026-01-01T00:00:00.000Z",
      updated: "2026-01-01T00:00:00.000Z",
      lastAccessed: "2026-01-12T00:00:00.000Z",
      importance: { score: 0.6 },
      verificationState: "unverified",
      ...(overrides ?? {}),
    },
  };
}

const policy = {
  enabled: true,
  demotionMinAgeDays: 14,
  demotionValueThreshold: 0.35,
  promotionValueThreshold: 0.7,
} as const;

test("computeTierValueScore is lower for disputed memories", () => {
  const now = new Date("2026-02-01T00:00:00.000Z");
  const stable = computeTierValueScore(memory(), now);
  const disputed = computeTierValueScore(memory({ verificationState: "disputed" }), now);
  assert.ok(disputed < stable);
});

test("computeTierValueScore boosts correction and confirmed memory signals", () => {
  const now = new Date("2026-02-01T00:00:00.000Z");
  const baseline = computeTierValueScore(memory(), now);
  const boosted = computeTierValueScore(
    memory({ category: "correction", verificationState: "user_confirmed" }),
    now,
  );
  assert.ok(boosted > baseline);
});

test("decideTierTransition demotes hot tier at threshold boundary when old enough", () => {
  const now = new Date("2026-02-01T00:00:00.000Z");
  const decision = decideTierTransition(
    memory({
      confidence: 0,
      confidenceTier: "speculative",
      accessCount: 0,
      lastAccessed: "2025-01-01T00:00:00.000Z",
      importance: { score: 0.1 },
      verificationState: "unverified",
    }),
    "hot",
    policy,
    now,
  );
  assert.equal(decision.nextTier, "cold");
  assert.equal(decision.changed, true);
  assert.equal(decision.reason, "value_below_demotion_threshold");
});

test("decideTierTransition does not demote when minimum age is not met", () => {
  const now = new Date("2026-01-10T00:00:00.000Z");
  const decision = decideTierTransition(
    memory({
      created: "2026-01-08T00:00:00.000Z",
      updated: "2026-01-08T00:00:00.000Z",
      confidence: 0.1,
      confidenceTier: "speculative",
      accessCount: 0,
      importance: { score: 0.1 },
    }),
    "hot",
    policy,
    now,
  );
  assert.equal(decision.nextTier, "hot");
  assert.equal(decision.reason, "demotion_min_age_not_met");
});

test("decideTierTransition promotes cold tier at promotion boundary", () => {
  const now = new Date("2026-02-01T00:00:00.000Z");
  const decision = decideTierTransition(
    memory({
      confidence: 1,
      confidenceTier: "explicit",
      accessCount: 20,
      lastAccessed: "2026-01-31T00:00:00.000Z",
      importance: { score: 1 },
      verificationState: "user_confirmed",
    }),
    "cold",
    policy,
    now,
  );
  assert.equal(decision.nextTier, "hot");
  assert.equal(decision.changed, true);
  assert.equal(decision.reason, "value_above_promotion_threshold");
});

test("decideTierTransition keeps live support passport cards in the hot tier", () => {
  const now = new Date("2026-02-01T00:00:00.000Z");
  for (const status of ["active", "pending_review"] as const) {
    const supportCard = memory({
      status,
      tags: ["support-passport-card"],
      confidence: 0,
      confidenceTier: "speculative",
      accessCount: 0,
      lastAccessed: "2025-01-01T00:00:00.000Z",
      importance: { score: 0 },
    });
    const hot = decideTierTransition(supportCard, "hot", policy, now);
    assert.equal(hot.nextTier, "hot");
    assert.equal(hot.changed, false);
    assert.equal(hot.reason, "support_passport_card_requires_hot_tier");

    const cold = decideTierTransition(supportCard, "cold", policy, now);
    assert.equal(cold.nextTier, "hot");
    assert.equal(cold.changed, true);
    assert.equal(cold.reason, "support_passport_card_requires_hot_tier");
  }
});

test("decideTierTransition is no-op when policy is disabled", () => {
  const now = new Date("2026-02-01T00:00:00.000Z");
  const decision = decideTierTransition(memory(), "cold", { ...policy, enabled: false }, now);
  assert.equal(decision.nextTier, "cold");
  assert.equal(decision.changed, false);
  assert.equal(decision.reason, "tier_migration_disabled");
});
