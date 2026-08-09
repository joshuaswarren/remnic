import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";

test("parseConfig preserves zero graph limits", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    maxGraphTraversalSteps: 0,
    maxEntityGraphEdgesPerMemory: 0,
  });

  assert.equal(cfg.maxGraphTraversalSteps, 0);
  assert.equal(cfg.maxEntityGraphEdgesPerMemory, 0);
});

test("parseConfig clamps negative graph limits to zero", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    maxGraphTraversalSteps: -4,
    maxEntityGraphEdgesPerMemory: -9,
  });

  assert.equal(cfg.maxGraphTraversalSteps, 0);
  assert.equal(cfg.maxEntityGraphEdgesPerMemory, 0);
});

test("parseConfig keeps graphRecallEnabled opt-in", () => {
  const defaults = parseConfig({ openaiApiKey: "sk-test" });
  const enabled = parseConfig({ openaiApiKey: "sk-test", graphRecallEnabled: true });

  assert.equal(defaults.graphRecallEnabled, false);
  assert.equal(enabled.graphRecallEnabled, true);
});

test("parseConfig keeps graphAssistShadowEvalEnabled opt-in", () => {
  const defaults = parseConfig({ openaiApiKey: "sk-test" });
  const enabled = parseConfig({ openaiApiKey: "sk-test", graphAssistShadowEvalEnabled: true });

  assert.equal(defaults.graphAssistShadowEvalEnabled, false);
  assert.equal(enabled.graphAssistShadowEvalEnabled, true);
});

test("parseConfig applies graph expansion scoring defaults and clamps bounds", () => {
  const defaults = parseConfig({ openaiApiKey: "sk-test" });
  assert.equal(defaults.graphExpansionActivationWeight, 0.65);
  assert.equal(defaults.graphExpansionBlendMin, 0.05);
  assert.equal(defaults.graphExpansionBlendMax, 0.95);

  const clamped = parseConfig({
    openaiApiKey: "sk-test",
    graphExpansionActivationWeight: 2,
    graphExpansionBlendMin: -1,
    graphExpansionBlendMax: 9,
  });
  assert.equal(clamped.graphExpansionActivationWeight, 1);
  assert.equal(clamped.graphExpansionBlendMin, 0);
  assert.equal(clamped.graphExpansionBlendMax, 1);
});
test("parseConfig applies graphPathScoring defaults and boolean-like strings", () => {
  const defaults = parseConfig({ openaiApiKey: "sk-test" });
  assert.deepEqual(defaults.graphPathScoring, {
    enabled: false,
    invalidNodePenalty: 0.2,
    includePathInProvenance: true,
  });

  const disabled = parseConfig({
    openaiApiKey: "sk-test",
    graphPathScoring: {
      enabled: "false",
      invalidNodePenalty: "0.4",
      includePathInProvenance: "false",
    },
  });
  assert.deepEqual(disabled.graphPathScoring, {
    enabled: false,
    invalidNodePenalty: 0.4,
    includePathInProvenance: false,
  });
});

test("parseConfig rejects invalid graphPathScoring values", () => {
  assert.throws(
    () => parseConfig({ openaiApiKey: "sk-test", graphPathScoring: { invalidNodePenalty: 0 } }),
    /graphPathScoring\.invalidNodePenalty/,
  );
  assert.throws(
    () => parseConfig({ openaiApiKey: "sk-test", graphPathScoring: { invalidNodePenalty: 1.1 } }),
    /graphPathScoring\.invalidNodePenalty/,
  );
  assert.throws(
    () => parseConfig({ openaiApiKey: "sk-test", graphPathScoring: { invalidNodePenalty: "nope" } }),
    /graphPathScoring\.invalidNodePenalty/,
  );
});
