import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import {
  readCalibrationIndex,
  buildCalibrationRecallSection,
  getCalibrationRulesForRecall,
  type CalibrationRule,
} from "../src/calibration.js";

// ─── readCalibrationIndex ────────────────────────────────────────────────────

test("readCalibrationIndex returns empty index when no file exists", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cal-empty-"));
  const index = await readCalibrationIndex(memoryDir);
  assert.equal(index.rules.length, 0);
  assert.equal(index.totalCorrectionsAnalyzed, 0);
});

// ─── buildCalibrationRecallSection ───────────────────────────────────────────

test("buildCalibrationRecallSection returns null for empty rules", () => {
  const section = buildCalibrationRecallSection([], "test query");
  assert.equal(section, null);
});

test("buildCalibrationRecallSection formats rules correctly", () => {
  const rules: CalibrationRule[] = [
    {
      id: "cal-test1",
      ruleType: "model_tendency",
      condition: "When discussing project scope",
      modelTendency: "Assumes broader scope than intended",
      userExpectation: "Prefers narrow task definitions",
      calibration: "Ask for clarification rather than assuming broader scope",
      confidence: 0.85,
      evidenceCount: 5,
      evidenceCorrectionIds: ["c1", "c2", "c3", "c4", "c5"],
      createdAt: "2026-03-17T00:00:00Z",
      lastReinforcedAt: "2026-03-17T00:00:00Z",
    },
  ];

  const section = buildCalibrationRecallSection(rules, "help me plan the project scope");
  assert.ok(section !== null);
  assert.ok(section.includes("Model Calibration"));
  assert.ok(section.includes("project scope"));
  assert.ok(section.includes("Ask for clarification"));
});

test("buildCalibrationRecallSection respects maxChars", () => {
  const rules: CalibrationRule[] = Array.from({ length: 20 }, (_, i) => ({
    id: `cal-${i}`,
    ruleType: "model_tendency" as const,
    condition: `Condition ${i} with some extra text to make it longer`,
    modelTendency: `Tendency ${i} with additional description`,
    userExpectation: `Expectation ${i}`,
    calibration: `Calibration ${i} with detailed instructions for the model to follow`,
    confidence: 0.8,
    evidenceCount: 3,
    evidenceCorrectionIds: [],
    createdAt: "2026-03-17T00:00:00Z",
    lastReinforcedAt: "2026-03-17T00:00:00Z",
  }));

  const section = buildCalibrationRecallSection(rules, "test", 500);
  assert.ok(section !== null);
  assert.ok(section.length <= 550); // some slack for header
});

// ─── getCalibrationRulesForRecall ────────────────────────────────────────────

test("getCalibrationRulesForRecall returns empty for new memoryDir", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cal-recall-"));
  const rules = await getCalibrationRulesForRecall(memoryDir);
  assert.equal(rules.length, 0);
});

test("getCalibrationRulesForRecall reads pre-computed rules", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cal-precomp-"));
  const calDir = path.join(memoryDir, "state", "calibration");
  await mkdir(calDir, { recursive: true });

  const index = {
    rules: [
      {
        id: "cal-precomp",
        ruleType: "scope_boundary",
        condition: "When user mentions a specific task",
        modelTendency: "Expands scope beyond what was asked",
        userExpectation: "Wants exactly what was asked, no more",
        calibration: "Stay within the stated scope. Ask before expanding.",
        confidence: 0.9,
        evidenceCount: 4,
        evidenceCorrectionIds: ["c1", "c2", "c3", "c4"],
        createdAt: "2026-03-17T00:00:00Z",
        lastReinforcedAt: "2026-03-17T00:00:00Z",
      },
    ],
    updatedAt: "2026-03-17T00:00:00Z",
    totalCorrectionsAnalyzed: 10,
  };

  await writeFile(path.join(calDir, "calibration-index.json"), JSON.stringify(index), "utf8");

  const rules = await getCalibrationRulesForRecall(memoryDir);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, "cal-precomp");
  assert.equal(rules[0].ruleType, "scope_boundary");
});
