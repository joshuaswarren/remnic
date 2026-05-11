import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";

test("parseConfig sets recall pipeline defaults", () => {
  const cfg = parseConfig({ openaiApiKey: "sk-test" });

  assert.equal(cfg.recallBudgetChars, cfg.maxMemoryTokens * 4);
  assert.ok(Array.isArray(cfg.recallPipeline));
  assert.ok(cfg.recallPipeline.length > 0);

  const profile = cfg.recallPipeline.find((entry) => entry.id === "profile");
  assert.ok(profile);
  assert.equal(profile?.consolidateTriggerLines, 100);
  assert.equal(profile?.consolidateTargetLines, 50);

  assert.deepEqual(
    cfg.recallPipeline.find((entry) => entry.id === "event-order"),
    {
      id: "event-order",
      enabled: true,
      maxChars: 3200,
      maxResults: 24,
      maxTurns: 12,
      maxTokens: 24000,
    },
  );
  assert.deepEqual(
    cfg.recallPipeline.find((entry) => entry.id === "response-guidance"),
    {
      id: "response-guidance",
      enabled: true,
      maxChars: 2400,
      maxResults: 48,
      maxTurns: 64,
      maxTokens: 16000,
    },
  );
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

test("parseConfig coerces numeric strings for default specialized recall sections", () => {
  const cfg = parseConfig({
    targetedFactRecallMaxChars: "0",
    targetedFactRecallMaxResults: "7",
    targetedFactRecallScanWindowTurns: "3",
    targetedFactRecallScanWindowTokens: "1000",
    focusedListRecallMaxChars: "8",
    focusedListRecallMaxResults: "0",
    focusedListRecallScanWindowTurns: "5",
    focusedListRecallScanWindowTokens: "1200",
    responseGuidanceRecallMaxChars: "9",
    responseGuidanceRecallMaxResults: "10",
    responseGuidanceRecallScanWindowTurns: "6",
    responseGuidanceRecallScanWindowTokens: "1300",
    eventOrderRecallMaxChars: "11",
    eventOrderRecallMaxResults: "12",
    eventOrderRecallScanWindowTurns: "7",
    eventOrderRecallScanWindowTokens: "1400",
  });
  const section = (id: string) => {
    const found = cfg.recallPipeline.find((entry) => entry.id === id);
    assert.ok(found, `${id} section should exist`);
    return found;
  };

  assert.deepEqual(
    {
      maxChars: section("targeted-facts").maxChars,
      maxResults: section("targeted-facts").maxResults,
      maxTurns: section("targeted-facts").maxTurns,
      maxTokens: section("targeted-facts").maxTokens,
    },
    { maxChars: 0, maxResults: 7, maxTurns: 3, maxTokens: 1000 },
  );
  assert.deepEqual(
    {
      maxChars: section("focused-list").maxChars,
      maxResults: section("focused-list").maxResults,
      maxTurns: section("focused-list").maxTurns,
      maxTokens: section("focused-list").maxTokens,
    },
    { maxChars: 8, maxResults: 0, maxTurns: 5, maxTokens: 1200 },
  );
  assert.deepEqual(
    {
      maxChars: section("response-guidance").maxChars,
      maxResults: section("response-guidance").maxResults,
      maxTurns: section("response-guidance").maxTurns,
      maxTokens: section("response-guidance").maxTokens,
    },
    { maxChars: 9, maxResults: 10, maxTurns: 6, maxTokens: 1300 },
  );
  assert.deepEqual(
    {
      maxChars: section("event-order").maxChars,
      maxResults: section("event-order").maxResults,
      maxTurns: section("event-order").maxTurns,
      maxTokens: section("event-order").maxTokens,
    },
    { maxChars: 11, maxResults: 12, maxTurns: 7, maxTokens: 1400 },
  );
});

test("orchestrator honors top-level specialized recall gates with custom pipelines", () => {
  const cfg = parseConfig({
    targetedFactRecallEnabled: false,
    focusedListRecallEnabled: false,
    responseGuidanceRecallEnabled: false,
    eventOrderRecallEnabled: false,
    recallPipeline: [
      { id: "profile", enabled: true },
      { id: "memories", enabled: true },
      { id: "compounding", enabled: true },
    ],
  });
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  orchestrator.config = cfg;

  assert.equal(
    orchestrator.isTopLevelRecallSectionEnabled(
      "targeted-facts",
      cfg.targetedFactRecallEnabled,
    ),
    false,
  );
  assert.equal(
    orchestrator.isTopLevelRecallSectionEnabled(
      "focused-list",
      cfg.focusedListRecallEnabled,
    ),
    false,
  );
  assert.equal(
    orchestrator.isTopLevelRecallSectionEnabled(
      "response-guidance",
      cfg.responseGuidanceRecallEnabled,
    ),
    false,
  );
  assert.equal(
    orchestrator.isTopLevelRecallSectionEnabled(
      "event-order",
      cfg.eventOrderRecallEnabled,
    ),
    false,
  );
});
