/**
 * Unit tests for tier-stats helpers (issue #686 PR 5/6).
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  explainTierForMemory,
  formatTierExplainText,
  formatTierSummaryText,
  summarizeTiers,
  type TierExplainResult,
  type TierSummary,
} from "./tier-stats.js";
import type { MemoryFile, MemoryFrontmatter, PluginConfig } from "../types.js";

function makeMemory(
  overrides: Partial<MemoryFrontmatter>,
  pathOverride?: string,
): MemoryFile {
  return {
    path: pathOverride ?? `/tmp/mem/${overrides.id ?? "mem"}.md`,
    content: "synthetic",
    frontmatter: {
      id: overrides.id ?? "mem",
      category: "preference",
      created: "2026-01-01T00:00:00.000Z",
      updated: "2026-01-01T00:00:00.000Z",
      source: "test",
      ...overrides,
    } as MemoryFrontmatter,
  };
}

function makeStorageStub(
  memories: MemoryFile[],
  coldMemories: MemoryFile[] = [],
) {
  return {
    readAllMemories: async () => memories,
    readAllColdMemories: async () => coldMemories,
  };
}

function makeConfigStub(
  overrides: Partial<PluginConfig> = {},
): PluginConfig {
  return {
    memoryDir: "/tmp/remnic-tier-stats-test",
    qmdTierMigrationEnabled: true,
    qmdTierDemotionMinAgeDays: 14,
    qmdTierDemotionValueThreshold: 0.35,
    qmdTierPromotionValueThreshold: 0.7,
    memoryUtilityLearningEnabled: false,
    promotionByOutcomeEnabled: false,
    lifecyclePolicyEnabled: false,
    lifecycleStaleDecayThreshold: 0,
    lifecyclePromoteHeatThreshold: 0,
    ...overrides,
  } as unknown as PluginConfig;
}

test("summarizeTiers: counts tiers, statuses, and categories", async () => {
  const memories = [
    makeMemory({ id: "a", status: "active", category: "preference" }),
    makeMemory({ id: "b", status: "active", category: "decision" }),
    makeMemory({ id: "d", status: "forgotten" as MemoryFrontmatter["status"], category: "fact" }),
  ];
  const coldMemories = [
    makeMemory({ id: "c", status: "archived", category: "preference" }, "/tmp/mem/cold/c.md"),
    makeMemory({ id: "e" }, "/tmp/mem/cold/e.md"),
  ];
  const summary = await summarizeTiers(
    makeStorageStub(memories, coldMemories) as never,
  );
  assert.equal(summary.total, 5);
  assert.equal(summary.byTier.hot, 3);
  assert.equal(summary.byTier.cold, 2);
  // 3 active: a, b, e (e has no explicit status → defaults to active).
  assert.equal(summary.byStatus.active, 3);
  assert.equal(summary.byStatus.archived, 1);
  assert.equal(summary.byStatus.forgotten, 1);
  assert.equal(summary.forgottenCount, 1);
  // 3 preference: a, c, e (e inherits the makeMemory default).
  assert.equal(summary.byCategory.preference, 3);
  assert.equal(summary.byCategory.decision, 1);
  assert.equal(summary.byCategory.fact, 1);
});

test("summarizeTiers: handles empty store", async () => {
  const summary = await summarizeTiers(makeStorageStub([]) as never);
  assert.equal(summary.total, 0);
  assert.equal(summary.byTier.hot, 0);
  assert.equal(summary.byTier.cold, 0);
  assert.deepEqual(summary.byStatus, {});
  assert.equal(summary.forgottenCount, 0);
});

test("summarizeTiers: defaults missing status to active", async () => {
  const summary = await summarizeTiers(
    makeStorageStub([makeMemory({ id: "a" })]) as never,
  );
  assert.equal(summary.byStatus.active, 1);
});

test("summarizeTiers: treats hot scan memories as hot even under cold-named roots", async () => {
  const summary = await summarizeTiers(
    makeStorageStub([
      makeMemory({ id: "hot-cold-root" }, "/tmp/cold/remnic/facts/hot.md"),
    ]) as never,
  );

  assert.equal(summary.byTier.hot, 1);
  assert.equal(summary.byTier.cold, 0);
});

test("explainTierForMemory: finds cold memories and reports importance score", async () => {
  const coldMemory = makeMemory(
    {
      id: "cold-a",
      status: "active",
      confidence: 0.8,
      accessCount: 2,
      importance: {
        score: 0.91,
        level: "high",
        reasons: ["operator marked important"],
        keywords: ["operator"],
      },
    },
    "/tmp/mem/cold/facts/cold-a.md",
  );

  const explain = await explainTierForMemory(
    makeStorageStub([], [coldMemory]) as never,
    "cold-a",
    makeConfigStub(),
  );

  assert.equal(explain.id, "cold-a");
  assert.equal(explain.currentTier, "cold");
  assert.equal(explain.signals.importance, 0.91);
});

test("explainTierForMemory: reports scoring importance and feedback inputs", async () => {
  const memory = makeMemory({ id: "default-value-inputs" });

  const explain = await explainTierForMemory(
    makeStorageStub([memory]) as never,
    "default-value-inputs",
    makeConfigStub(),
  );

  assert.equal(explain.signals.importance, 0.5);
  assert.equal(explain.signals.feedback, 0.5);
});

test("explainTierForMemory: uses qmd tier migration policy for decisions", async () => {
  const memory = makeMemory({
    id: "hot-low-value",
    confidence: 0,
    updated: "2020-01-01T00:00:00.000Z",
  });

  const explain = await explainTierForMemory(
    makeStorageStub([memory]) as never,
    "hot-low-value",
    makeConfigStub({
      qmdTierMigrationEnabled: true,
      qmdTierDemotionMinAgeDays: 0,
      qmdTierDemotionValueThreshold: 1,
      qmdTierPromotionValueThreshold: 1,
      lifecyclePolicyEnabled: false,
      lifecycleStaleDecayThreshold: 0,
      lifecyclePromoteHeatThreshold: 0,
    }),
  );

  assert.equal(explain.decision.nextTier, "cold");
  assert.equal(explain.decision.changed, true);
  assert.equal(explain.decision.reason, "value_below_demotion_threshold");
});

test("explainTierForMemory: uses source scan tier instead of path substring", async () => {
  const memory = makeMemory(
    { id: "hot-cold-root" },
    "/tmp/cold/remnic/facts/hot.md",
  );

  const explain = await explainTierForMemory(
    makeStorageStub([memory]) as never,
    "hot-cold-root",
    makeConfigStub(),
  );

  assert.equal(explain.currentTier, "hot");
  assert.equal(explain.decision.currentTier, "hot");
});

test("explainTierForMemory: reports scoring confidence input", async () => {
  const memory = makeMemory({
    id: "explicit-confidence",
    confidence: 0.2,
    confidenceTier: "explicit",
  });

  const explain = await explainTierForMemory(
    makeStorageStub([memory]) as never,
    "explicit-confidence",
    makeConfigStub(),
  );

  assert.equal(explain.signals.confidence, 1);
});

test("explainTierForMemory: applies utility runtime tier deltas", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-tier-stats-"));
  try {
    const stateDir = path.join(memoryDir, "state", "utility-telemetry");
    const snapshot = {
      version: 1,
      updatedAt: "2026-04-25T00:00:00.000Z",
      windowDays: 14,
      minEventCount: 3,
      maxWeightMagnitude: 0.35,
      weights: [
        {
          target: "promotion",
          decision: "demote",
          eventCount: 10,
          learnedWeight: 0.35,
          averageUtilityScore: 0.35,
          confidence: 0.9,
          outcomeCounts: { helpful: 10 },
          updatedAt: "2026-04-25T00:00:00.000Z",
        },
      ],
    };
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, "learning-state.json"),
      `${JSON.stringify(snapshot, null, 2)}\n`,
      "utf8",
    );
    const memory = makeMemory({
      id: "runtime-borderline",
      category: "fact",
      confidence: 0,
      updated: "2020-01-01T00:00:00.000Z",
      importance: {
        score: 0,
        level: "low",
        reasons: [],
        keywords: [],
      },
    });

    const explain = await explainTierForMemory(
      makeStorageStub([memory]) as never,
      "runtime-borderline",
      makeConfigStub({
        memoryDir,
        memoryUtilityLearningEnabled: true,
        promotionByOutcomeEnabled: true,
        qmdTierMigrationEnabled: true,
        qmdTierDemotionMinAgeDays: 0,
        qmdTierDemotionValueThreshold: 0.04,
        qmdTierPromotionValueThreshold: 1,
      }),
    );

    assert.equal(explain.decision.nextTier, "cold");
    assert.equal(explain.decision.changed, true);
    assert.equal(explain.decision.reason, "value_below_demotion_threshold");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("formatTierSummaryText: renders headings and counts", () => {
  const summary: TierSummary = {
    total: 5,
    byTier: { hot: 3, cold: 2 },
    byStatus: { active: 4, archived: 1 },
    forgottenCount: 0,
    byCategory: { preference: 3, decision: 2 },
  };
  const text = formatTierSummaryText(summary);
  assert.match(text, /Memory Tier Distribution/);
  assert.match(text, /Total memories: 5/);
  assert.match(text, /hot: {2}3/);
  assert.match(text, /cold: 2/);
  assert.match(text, /active: 4/);
  assert.match(text, /preference: 3/);
});

test("formatTierSummaryText: sorts equal-count rows by key", () => {
  const summary: TierSummary = {
    total: 4,
    byTier: { hot: 4, cold: 0 },
    byStatus: { pending_review: 1, active: 1, archived: 2 },
    forgottenCount: 0,
    byCategory: { zebra: 1, decision: 2, alpha: 1 },
  };

  const text = formatTierSummaryText(summary);
  assert.match(text, /archived: 2[\s\S]*active: 1[\s\S]*pending_review: 1/);
  assert.match(text, /decision: 2[\s\S]*alpha: 1[\s\S]*zebra: 1/);
});

test("formatTierExplainText: renders score, decision, and signals", () => {
  const explain: TierExplainResult = {
    id: "alpha",
    path: "/tmp/mem/alpha.md",
    currentTier: "hot",
    status: "active",
    category: "preference",
    valueScore: 0.123456,
    decision: {
      currentTier: "hot",
      nextTier: "hot",
      valueScore: 0.123456,
      changed: false,
      reason: "demotion_min_age_not_met",
    },
    signals: {
      confidence: 0.7,
      accessCount: 4,
      lastAccessed: "2026-04-20T00:00:00.000Z",
      created: "2026-01-01T00:00:00.000Z",
      updated: "2026-04-19T00:00:00.000Z",
      importance: 0.5,
      feedback: 0.5,
    },
  };
  const text = formatTierExplainText(explain);
  assert.match(text, /alpha/);
  assert.match(text, /value score: {3}0\.123/);
  assert.match(text, /next tier: hot/);
  assert.match(text, /demotion_min_age_not_met/);
  assert.match(text, /confidence: {3}0\.7/);
  assert.match(text, /lastAccessed: 2026-04-20/);
});

test("formatTierExplainText: shows '(never)' and scoring defaults for missing signals", () => {
  const explain: TierExplainResult = {
    id: "bare",
    path: "/tmp/mem/bare.md",
    currentTier: "hot",
    status: "active",
    category: "fact",
    valueScore: 0,
    decision: {
      currentTier: "hot",
      nextTier: "hot",
      valueScore: 0,
      changed: false,
      reason: "tier_migration_disabled",
    },
    signals: {
      confidence: 0,
      accessCount: 0,
      lastAccessed: null,
      created: "",
      updated: "",
      importance: 0.5,
      feedback: 0.5,
    },
  };
  const text = formatTierExplainText(explain);
  assert.match(text, /lastAccessed: \(never\)/);
  assert.match(text, /importance: {3}0\.5/);
  assert.match(text, /feedback: {5}0\.5/);
});
