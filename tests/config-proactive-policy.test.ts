import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";

test("parseConfig sets proactive/policy-learning defaults", () => {
  const cfg = parseConfig({ openaiApiKey: "sk-test" });
  assert.equal(cfg.proactiveExtractionEnabled, false);
  assert.equal(cfg.contextCompressionActionsEnabled, false);
  assert.equal(cfg.compressionGuidelineLearningEnabled, false);
  assert.equal(cfg.compressionGuidelineSemanticRefinementEnabled, false);
  assert.equal(cfg.compressionGuidelineSemanticTimeoutMs, 2500);
  assert.equal(cfg.maxProactiveQuestionsPerExtraction, 2);
  assert.equal(cfg.proactiveExtractionTimeoutMs, 2500);
  assert.equal(cfg.proactiveExtractionMaxTokens, 900);
  assert.equal(cfg.proactiveExtractionCategoryAllowlist, undefined);
  assert.equal(cfg.maxCompressionTokensPerHour, 1500);
  assert.equal(cfg.behaviorLoopAutoTuneEnabled, false);
  assert.equal(cfg.behaviorLoopLearningWindowDays, 14);
  assert.equal(cfg.behaviorLoopMinSignalCount, 10);
  assert.equal(cfg.behaviorLoopMaxDeltaPerCycle, 0.1);
  assert.deepEqual(cfg.behaviorLoopProtectedParams, [
    "maxMemoryTokens",
    "qmdMaxResults",
    "qmdColdMaxResults",
    "qmdEmbeddingBacklogThreshold",
    "recallPlannerMaxQmdResultsMinimal",
    "verbatimArtifactsMaxRecall",
  ]);
});

test("parseConfig supports explicit proactive/policy-learning settings and preserves zero limits", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    proactiveExtractionEnabled: true,
    contextCompressionActionsEnabled: true,
    compressionGuidelineLearningEnabled: true,
    compressionGuidelineSemanticRefinementEnabled: true,
    compressionGuidelineSemanticTimeoutMs: 1,
    maxProactiveQuestionsPerExtraction: 0,
    proactiveExtractionTimeoutMs: 0,
    proactiveExtractionMaxTokens: 0,
    proactiveExtractionCategoryAllowlist: ["decision", "invalid", "fact"],
    maxCompressionTokensPerHour: 0,
    behaviorLoopAutoTuneEnabled: true,
    behaviorLoopLearningWindowDays: 0,
    behaviorLoopMinSignalCount: 0,
    behaviorLoopMaxDeltaPerCycle: 0,
    behaviorLoopProtectedParams: ["a", "", "b"],
  });

  assert.equal(cfg.proactiveExtractionEnabled, true);
  assert.equal(cfg.contextCompressionActionsEnabled, true);
  assert.equal(cfg.compressionGuidelineLearningEnabled, true);
  assert.equal(cfg.compressionGuidelineSemanticRefinementEnabled, true);
  assert.equal(cfg.compressionGuidelineSemanticTimeoutMs, 1);
  assert.equal(cfg.maxProactiveQuestionsPerExtraction, 0);
  assert.equal(cfg.proactiveExtractionTimeoutMs, 0);
  assert.equal(cfg.proactiveExtractionMaxTokens, 0);
  assert.deepEqual(cfg.proactiveExtractionCategoryAllowlist, ["decision", "fact"]);
  assert.equal(cfg.maxCompressionTokensPerHour, 0);
  assert.equal(cfg.behaviorLoopAutoTuneEnabled, true);
  assert.equal(cfg.behaviorLoopLearningWindowDays, 0);
  assert.equal(cfg.behaviorLoopMinSignalCount, 0);
  assert.equal(cfg.behaviorLoopMaxDeltaPerCycle, 0);
  assert.deepEqual(cfg.behaviorLoopProtectedParams, ["a", "b"]);
});

test("parseConfig clamps proactive/policy-learning numeric limits to non-negative integers", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    compressionGuidelineSemanticTimeoutMs: -50,
    maxProactiveQuestionsPerExtraction: -1.7,
    proactiveExtractionTimeoutMs: -2,
    proactiveExtractionMaxTokens: -9.4,
    maxCompressionTokensPerHour: -500.9,
    behaviorLoopLearningWindowDays: -1,
    behaviorLoopMinSignalCount: -7.9,
    behaviorLoopMaxDeltaPerCycle: 4,
  });

  assert.equal(cfg.compressionGuidelineSemanticTimeoutMs, 1);
  assert.equal(cfg.maxProactiveQuestionsPerExtraction, 0);
  assert.equal(cfg.proactiveExtractionTimeoutMs, 0);
  assert.equal(cfg.proactiveExtractionMaxTokens, 0);
  assert.equal(cfg.maxCompressionTokensPerHour, 0);
  assert.equal(cfg.behaviorLoopLearningWindowDays, 0);
  assert.equal(cfg.behaviorLoopMinSignalCount, 0);
  assert.equal(cfg.behaviorLoopMaxDeltaPerCycle, 1);
});

test("parseConfig returns a fresh default behaviorLoopProtectedParams array per call", () => {
  const first = parseConfig({ openaiApiKey: "sk-test" });
  first.behaviorLoopProtectedParams.push("mutated-default");

  const second = parseConfig({ openaiApiKey: "sk-test" });
  assert.equal(second.behaviorLoopProtectedParams.includes("mutated-default"), false);
});
