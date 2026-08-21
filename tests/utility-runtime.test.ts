import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import {
  applyUtilityPromotionRuntimePolicy,
  applyUtilityRankingRuntimeDelta,
  loadUtilityRuntimeValues,
} from "../src/utility-runtime.js";

test("utility runtime stays disabled until both rollout gates are enabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-utility-runtime-disabled-"));
  try {
    await mkdir(path.join(memoryDir, "state", "utility-telemetry"), { recursive: true });
    await writeFile(
      path.join(memoryDir, "state", "utility-telemetry", "learning-state.json"),
      `${JSON.stringify({
        version: 1,
        updatedAt: "2026-03-08T10:00:00.000Z",
        windowDays: 7,
        minEventCount: 2,
        maxWeightMagnitude: 0.35,
        weights: [
          {
            target: "promotion",
            decision: "promote",
            eventCount: 3,
            learnedWeight: 0.3,
            averageUtilityScore: 0.8,
            confidence: 0.8,
            outcomeCounts: { helpful: 3 },
            updatedAt: "2026-03-08T10:00:00.000Z",
          },
        ],
      }, null, 2)}\n`,
      "utf8",
    );

    const disabled = await loadUtilityRuntimeValues({
      memoryDir,
      memoryUtilityLearningEnabled: true,
      promotionByOutcomeEnabled: false,
    });
    assert.equal(disabled, null);

    const enabled = await loadUtilityRuntimeValues({
      memoryDir,
      memoryUtilityLearningEnabled: true,
      promotionByOutcomeEnabled: true,
    });
    assert.ok(enabled);
    assert.equal(enabled.rankingBoostMultiplier, 1);
    assert.ok(enabled.promoteThresholdDelta < 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("utility runtime clamps learned weights into bounded ranking and promotion adjustments", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-utility-runtime-bounded-"));
  try {
    await mkdir(path.join(memoryDir, "state", "utility-telemetry"), { recursive: true });
    await writeFile(
      path.join(memoryDir, "state", "utility-telemetry", "learning-state.json"),
      `${JSON.stringify({
        version: 1,
        updatedAt: "2026-03-08T12:00:00.000Z",
        windowDays: 7,
        minEventCount: 2,
        maxWeightMagnitude: 0.35,
        weights: [
          {
            target: "ranking",
            decision: "boost",
            eventCount: 4,
            learnedWeight: 0.35,
            averageUtilityScore: 0.8,
            confidence: 0.9,
            outcomeCounts: { helpful: 4 },
            updatedAt: "2026-03-08T12:00:00.000Z",
          },
          {
            target: "ranking",
            decision: "suppress",
            eventCount: 4,
            learnedWeight: -0.35,
            averageUtilityScore: -0.8,
            confidence: 0.9,
            outcomeCounts: { harmful: 4 },
            updatedAt: "2026-03-08T12:00:00.000Z",
          },
          {
            target: "promotion",
            decision: "promote",
            eventCount: 3,
            learnedWeight: 0.35,
            averageUtilityScore: 0.75,
            confidence: 0.8,
            outcomeCounts: { helpful: 3 },
            updatedAt: "2026-03-08T12:00:00.000Z",
          },
          {
            target: "promotion",
            decision: "demote",
            eventCount: 3,
            learnedWeight: 0.35,
            averageUtilityScore: 0.75,
            confidence: 0.8,
            outcomeCounts: { helpful: 3 },
            updatedAt: "2026-03-08T12:00:00.000Z",
          },
        ],
      }, null, 2)}\n`,
      "utf8",
    );

    const runtime = await loadUtilityRuntimeValues({
      memoryDir,
      memoryUtilityLearningEnabled: true,
      promotionByOutcomeEnabled: true,
    });
    assert.ok(runtime);
    assert.equal(runtime.rankingBoostMultiplier, 1.12);
    assert.equal(runtime.rankingSuppressMultiplier, 0.88);
    assert.equal(runtime.promoteThresholdDelta, -0.07);
    assert.equal(runtime.demoteThresholdDelta, 0.07);

    assert.equal(applyUtilityRankingRuntimeDelta(0.1, runtime, "boost"), 0.112);
    assert.equal(applyUtilityRankingRuntimeDelta(-0.1, runtime, "suppress"), -0.088);

    const adjusted = applyUtilityPromotionRuntimePolicy(
      {
        enabled: true,
        demotionMinAgeDays: 14,
        demotionValueThreshold: 0.35,
        promotionValueThreshold: 0.7,
      },
      runtime,
    );
    assert.equal(adjusted.demotionValueThreshold, 0.42);
    assert.equal(adjusted.promotionValueThreshold, 0.63);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
