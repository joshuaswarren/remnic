import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";

test("parseConfig leaves memory preset undefined by default", () => {
  const cfg = parseConfig({ openaiApiKey: "sk-test" });

  assert.equal(cfg.memoryOsPreset, undefined);
  assert.equal(cfg.queryAwareIndexingEnabled, false);
  assert.equal(cfg.verbatimArtifactsEnabled, false);
  assert.equal(cfg.rerankEnabled, false);
});

test("parseConfig applies conservative preset defaults", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryOsPreset: "conservative",
  });

  assert.equal(cfg.memoryOsPreset, "conservative");
  assert.equal(cfg.maxMemoryTokens, 1500);
  assert.equal(cfg.recallPlannerMaxQmdResultsMinimal, 2);
  assert.equal(cfg.recallPlannerMaxQmdResultsFull, 5);
  assert.equal(cfg.queryAwareIndexingEnabled, false);
  assert.equal(cfg.verbatimArtifactsEnabled, false);
  assert.equal(cfg.maxProactiveQuestionsPerExtraction, 0);
  assert.equal(cfg.maxCompressionTokensPerHour, 0);
  assert.equal(cfg.graphAssistInFullModeEnabled, false);
});

test("parseConfig applies research-max preset defaults", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryOsPreset: "research-max",
  });

  assert.equal(cfg.memoryOsPreset, "research-max");
  assert.equal(cfg.maxMemoryTokens, 3200);
  assert.equal(cfg.queryAwareIndexingEnabled, true);
  assert.equal(cfg.verbatimArtifactsEnabled, true);
  assert.equal(cfg.multiGraphMemoryEnabled, true);
  assert.equal(cfg.graphRecallEnabled, true);
  assert.equal(cfg.proactiveExtractionEnabled, true);
  assert.equal(cfg.contextCompressionActionsEnabled, true);
  assert.equal(cfg.compressionGuidelineLearningEnabled, true);
  assert.equal(cfg.compressionGuidelineSemanticRefinementEnabled, true);
  assert.equal(cfg.explicitCueRecallEnabled, true);
  assert.equal(cfg.lcmEnabled, true);
  assert.equal(cfg.maxProactiveQuestionsPerExtraction, 4);
  assert.equal(cfg.maxCompressionTokensPerHour, 3000);
  assert.equal(cfg.behaviorLoopAutoTuneEnabled, true);
});

test("parseConfig applies local-llm-heavy preset defaults", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryOsPreset: "local-llm-heavy",
  });

  assert.equal(cfg.memoryOsPreset, "local-llm-heavy");
  assert.equal(cfg.localLlmEnabled, true);
  assert.equal(cfg.localLlmFastEnabled, true);
  assert.equal(cfg.embeddingFallbackProvider, "local");
  assert.equal(cfg.rerankEnabled, true);
  assert.equal(cfg.rerankProvider, "local");
});

test("parseConfig lets explicit config override preset defaults", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryOsPreset: "research-max",
    graphRecallEnabled: false,
    maxCompressionTokensPerHour: 0,
    localLlmEnabled: true,
  });

  assert.equal(cfg.memoryOsPreset, "research-max");
  assert.equal(cfg.graphRecallEnabled, false);
  assert.equal(cfg.maxCompressionTokensPerHour, 0);
  assert.equal(cfg.localLlmEnabled, true);
});

test("parseConfig accepts research alias for backward-compatible preset docs", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryOsPreset: "research",
  });

  assert.equal(cfg.memoryOsPreset, "research-max");
  assert.equal(cfg.graphRecallEnabled, true);
});
