import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";
import { RecallSectionCoordinator } from "./orchestration/recall-section-coordinator.js";
import { estimateTokenCount } from "./token-estimate.js";

test("recall derived budget keeps Japanese injection within maxMemoryTokens", () => {
  const config = parseConfig({
    maxMemoryTokens: 12,
    recallPipeline: [{ id: "memories", enabled: true }],
  });
  const coordinator = new RecallSectionCoordinator({ getConfig: () => config });
  const buckets = new Map<string, string[]>();

  coordinator.appendRecallSection(buckets, "memories", "日本語の記憶。".repeat(20));
  const assembled = coordinator.assembleRecallSections(buckets);
  const injected = assembled.sections.join("\n\n---\n\n");

  assert.equal(config.recallBudgetChars, config.maxMemoryTokens * 4);
  assert.ok(estimateTokenCount(injected) <= config.maxMemoryTokens);
});
test("recall reserves one memory chunk that fits both character and token budgets", () => {
  const config = parseConfig({
    maxMemoryTokens: 50,
    recallBudgetChars: 150,
    recallPipeline: [
      { id: "profile", enabled: true },
      { id: "memories", enabled: true },
    ],
  });
  const coordinator = new RecallSectionCoordinator({ getConfig: () => config });
  const buckets = new Map<string, string[]>();

  coordinator.appendRecallSection(buckets, "profile", "x".repeat(90));
  coordinator.appendRecallSection(buckets, "memories", "日".repeat(51), {
    atomic: true,
    memoryId: "wide",
    memoryPath: "memories/wide.md",
  });
  coordinator.appendRecallSection(buckets, "memories", "a".repeat(100), {
    atomic: true,
    memoryId: "latin",
    memoryPath: "memories/latin.md",
  });

  const assembled = coordinator.assembleRecallSections(buckets);

  assert.deepEqual(assembled.includedMemoryIds, ["latin"]);
  assert.ok(estimateTokenCount(assembled.sections.join("\n\n---\n\n")) <= 50);
});
