import assert from "node:assert/strict";
import test from "node:test";

import { synthesizeCalibrationRules, type CorrectionMemory } from "./calibration.js";
import type { FallbackLlmClient } from "./fallback-llm.js";

const corrections: CorrectionMemory[] = [
  {
    id: "c1",
    content: "The model assumed too broad a scope.",
    created: "2026-05-21T00:00:00.000Z",
    confidence: 0.9,
    entityRefs: [],
    tags: ["correction"],
  },
  {
    id: "c2",
    content: "The model should verify before claiming completion.",
    created: "2026-05-21T00:01:00.000Z",
    confidence: 0.9,
    entityRefs: [],
    tags: ["correction"],
  },
];

function llmWithContent(content: string): FallbackLlmClient {
  return {
    async chatCompletion() {
      return { content, modelUsed: "test" };
    },
  } as unknown as FallbackLlmClient;
}

test("synthesizeCalibrationRules rejects invalid LLM rule contracts", async () => {
  const rules = await synthesizeCalibrationRules(
    corrections,
    llmWithContent(JSON.stringify({
      rules: [
        {
          ruleType: "bad",
          condition: "When the model is uncertain",
          modelTendency: "It guesses",
          userExpectation: "Ask first",
          calibration: "Ask for clarification.",
          confidence: 0.8,
          evidenceIds: ["c1"],
        },
        {
          ruleType: "model_tendency",
          condition: "When claiming completion",
          modelTendency: "It overstates verification",
          userExpectation: "Report actual checks",
          calibration: "Name the checks that actually ran.",
          confidence: "0.9",
          evidenceIds: ["c2"],
        },
      ],
    })),
    [],
  );

  assert.deepEqual(rules, []);
});

test("synthesizeCalibrationRules clamps confidence and filters evidence IDs", async () => {
  const rules = await synthesizeCalibrationRules(
    corrections,
    llmWithContent(JSON.stringify({
      rules: [
        {
          ruleType: "verification_required",
          condition: "When reporting test status",
          modelTendency: "It treats planned checks as completed",
          userExpectation: "Only completed checks count",
          calibration: "Distinguish planned checks from completed checks.",
          confidence: 999,
          evidenceIds: [123, "c1", "", "c2"],
        },
        {
          ruleType: "scope_boundary",
          condition: "When loading context",
          modelTendency: "It reads too broadly",
          userExpectation: "Use targeted reads",
          calibration: "Start with the smallest relevant files.",
          confidence: 0.8,
          evidenceIds: "c1",
        },
      ],
    })),
    [],
  );

  assert.equal(rules.length, 2);
  assert.equal(rules[0]?.confidence, 1);
  assert.deepEqual(rules[0]?.evidenceCorrectionIds, ["c1", "c2"]);
  assert.equal(rules[0]?.evidenceCount, 2);
  assert.deepEqual(rules[1]?.evidenceCorrectionIds, []);
  assert.equal(rules[1]?.evidenceCount, 0);
});
