import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  readCalibrationIndex,
  runCalibrationConsolidation,
  synthesizeCalibrationRules,
  withAppliedCalibrationWeek,
  type CalibrationRule,
  type CorrectionMemory,
} from "./calibration.js";
import type { FallbackLlmClient } from "./fallback-llm.js";

const existingRule: CalibrationRule = {
  id: "cal-existing",
  ruleType: "model_tendency",
  condition: "When reporting status",
  modelTendency: "It overstates progress",
  userExpectation: "Report what finished",
  calibration: "Name the checks that finished.",
  confidence: 0.8,
  evidenceCount: 2,
  evidenceCorrectionIds: ["c1", "c2"],
  createdAt: "2026-03-16T00:00:00.000Z",
  lastReinforcedAt: "2026-03-16T00:00:00.000Z",
};

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

test("withAppliedCalibrationWeek commits the week stamp with the reinforced index", () => {
  const stamped = withAppliedCalibrationWeek({
    rules: [existingRule],
    updatedAt: "2026-03-16T00:00:00.000Z",
    totalCorrectionsAnalyzed: 4,
  }, " 2026-W11 ");
  assert.deepEqual(stamped.appliedWeekIds, ["2026-W11"]);
  assert.equal(stamped.rules[0]?.evidenceCount, 2);

  const preserved = withAppliedCalibrationWeek(stamped, " ");
  assert.deepEqual(preserved.appliedWeekIds, ["2026-W11"]);
  assert.deepEqual(withAppliedCalibrationWeek(stamped, "x".repeat(33)).appliedWeekIds, ["2026-W11"]);

  // A later week keeps the earlier stamp: an out-of-order retry of week A
  // after week B must still be recognized as already applied.
  assert.deepEqual(withAppliedCalibrationWeek(stamped, "2026-W13").appliedWeekIds, ["2026-W11", "2026-W13"]);
});

test("runCalibrationConsolidation does not reinforce an already-applied week", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "calibration-week-"));
  try {
    // Legacy on-disk shape: the pre-list index persisted a single appliedWeekId.
    const indexDir = path.join(memoryDir, "state", "calibration");
    await mkdir(indexDir, { recursive: true });
    const indexPath = path.join(indexDir, "calibration-index.json");
    const body = JSON.stringify(
      {
        rules: [existingRule],
        updatedAt: "2026-03-16T00:00:00.000Z",
        totalCorrectionsAnalyzed: 3,
        appliedWeekId: "2026-W11",
      },
      null,
      2
    );
    await writeFile(indexPath, body, "utf8");

    // Retry of the stamped week: no reinforcement, no rewrite.
    const rules = await runCalibrationConsolidation({
      memoryDir,
      idempotencyKey: "2026-W11",
    });
    assert.equal(rules[0]?.evidenceCount, 2);
    assert.equal(await readFile(indexPath, "utf8"), body);

    // A retry of an older week stays recognized after a newer week applied:
    // the reader folds the legacy single stamp into the applied-week list.
    const reread = await readCalibrationIndex(memoryDir);
    assert.deepEqual(reread.appliedWeekIds, ["2026-W11"]);
    assert.equal(reread.rules[0]?.evidenceCount, 2);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
