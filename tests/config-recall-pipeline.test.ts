import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";

test("parseConfig sets recall pipeline defaults", () => {
  const cfg = parseConfig({ openaiApiKey: "sk-test" });

  assert.equal(cfg.recallBudgetChars, cfg.maxMemoryTokens * 4);
  assert.ok(Array.isArray(cfg.recallPipeline));
  assert.ok(cfg.recallPipeline.length > 0);

  const profile = cfg.recallPipeline.find((entry) => entry.id === "profile");
  assert.ok(profile);
  assert.equal(profile?.consolidateTriggerLines, 100);
  assert.equal(profile?.consolidateTargetLines, 50);
});

test("parseConfig preserves explicit recallBudgetChars including zero", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    recallBudgetChars: 0,
  });

  assert.equal(cfg.recallBudgetChars, 0);
});

test("parseConfig accepts custom recall pipeline entries", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    recallPipeline: [
      { id: "profile", enabled: true, consolidateTriggerLines: 75, consolidateTargetLines: 35 },
      { id: "memories", enabled: true, maxResults: 3, maxChars: 900 },
      { id: "compounding", enabled: false },
    ],
  });

  assert.equal(cfg.recallPipeline.length, 3);
  assert.deepEqual(cfg.recallPipeline[0], {
    id: "profile",
    enabled: true,
    maxChars: undefined,
    maxHints: undefined,
    consolidateTriggerLines: 75,
    consolidateTargetLines: 35,
    maxSupportingFacts: undefined,
    maxRelatedEntities: undefined,
    maxEntities: undefined,
    maxResults: undefined,
    recentTurns: undefined,
    maxTurns: undefined,
    maxTokens: undefined,
    lookbackHours: undefined,
    maxCount: undefined,
    topK: undefined,
    timeoutMs: undefined,
    maxPatterns: undefined,
    maxRubrics: undefined,
  });
  assert.equal(cfg.recallPipeline[1]?.maxResults, 3);
  assert.equal(cfg.recallPipeline[2]?.enabled, false);
});

test("parseConfig coerces string false for default specialized recall sections", () => {
  const cfg = parseConfig({
    targetedFactRecallEnabled: "false",
    focusedListRecallEnabled: "0",
    responseGuidanceRecallEnabled: "no",
    eventOrderRecallEnabled: "off",
  });

  for (const id of [
    "targeted-facts",
    "focused-list",
    "response-guidance",
    "event-order",
  ]) {
    assert.equal(
      cfg.recallPipeline.find((entry) => entry.id === id)?.enabled,
      false,
      `${id} should honor string false config`,
    );
  }
});
