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

  assert.equal(config.recallBudgetChars, config.maxMemoryTokens);
  assert.ok(estimateTokenCount(injected) <= config.maxMemoryTokens);
});
