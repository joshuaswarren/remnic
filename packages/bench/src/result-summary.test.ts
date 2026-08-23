import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CANARY_SCORE_FLOOR,
  loadBenchmarkResultSummaries,
  summarizeBenchmarkResult,
  type BenchmarkResult,
} from "./index.ts";

function validResult(): BenchmarkResult {
  return {
    meta: {
      id: "run-1",
      benchmark: "assistant-synthesis",
      benchmarkTier: "remnic",
      version: "1.0.0",
      remnicVersion: "9.0.0",
      gitSha: "0123456789abcdef",
      timestamp: "2026-05-21T00:00:00.000Z",
      mode: "quick",
      runCount: 2,
      seeds: [1, 2],
    },
    config: {
      systemProvider: { provider: "ollama", model: "llama3" },
      judgeProvider: null,
      adapterMode: "direct",
      remnicConfig: {},
    },
    cost: {
      totalTokens: 100,
      inputTokens: 60,
      outputTokens: 40,
      estimatedCostUsd: 0.01,
      totalLatencyMs: 500,
      meanQueryLatencyMs: 250,
    },
    results: {
      tasks: [
        {
          taskId: "b-task",
          question: "q2",
          expected: "e2",
          actual: "a2",
          scores: { f1: 0.5, score: 0.9 },
          latencyMs: 300,
          tokens: { input: 10, output: 4 },
        },
        {
          taskId: "a-task",
          question: "q1",
          expected: "e1",
          actual: "a1",
          scores: { accuracy: 0.61 },
          latencyMs: 200,
          tokens: { input: 50, output: 36 },
          details: {
            focus: "calendar",
            rubricId: "assistant-v1",
            rubricSha256: "rubric-sha",
            judgeParseFailures: 1,
            perSeedScores: [
              {
                seed: 1,
                scores: { identity_accuracy: 5, stance_coherence: 4 },
                parseOk: true,
                notes: "solid",
                latencyMs: 900,
              },
              { seed: "not-a-number", scores: {}, parseOk: false },
            ],
          },
        },
      ],
      aggregates: {
        zzz_custom: { mean: 1.25, median: 1.2, stdDev: 0.1, min: 1, max: 1.4 },
        score: { mean: 0.82, median: 0.8, stdDev: 0.05, min: 0.7, max: 0.9 },
        accuracy: { mean: 0.75, median: 0.74, stdDev: 0.03, min: 0.6, max: 0.8 },
      },
      statistics: {
        bootstrapSamples: 1000,
        confidenceIntervals: {
          score: { lower: 0.78, upper: 0.86, level: 0.95 },
        },
        effectSizes: {
          score: { cohensD: 0.4, interpretation: "medium" },
        },
      },
    },
    environment: {
      os: "linux",
      nodeVersion: "v22.13.0",
      hardware: "x64",
    },
  };
}

test("summarizeBenchmarkResult orders metrics by priority and tasks by id", () => {
  const summary = summarizeBenchmarkResult(validResult(), "/tmp/run-1.json");

  assert.deepEqual(
    summary.aggregateMetrics.map((metric) => metric.name),
    ["score", "accuracy", "zzz_custom"],
  );
  assert.deepEqual(summary.taskSummaries.map((task) => task.taskId), ["a-task", "b-task"]);

  const scoreMetric = summary.aggregateMetrics[0];
  assert.equal(scoreMetric?.ciLower, 0.78);
  assert.equal(scoreMetric?.ciUpper, 0.86);
  assert.equal(scoreMetric?.ciLevel, 0.95);
  assert.equal(scoreMetric?.effectSize, 0.4);
  assert.equal(scoreMetric?.effectInterpretation, "medium");

  const accuracyMetric = summary.aggregateMetrics[1];
  assert.equal(accuracyMetric?.ciLower, null);
  assert.equal(accuracyMetric?.effectInterpretation, null);

  assert.deepEqual(summary.metricHighlights, [
    { name: "score", mean: 0.82 },
    { name: "accuracy", mean: 0.75 },
    { name: "zzz_custom", mean: 1.25 },
  ]);
  assert.equal(summary.primaryMetric, "score");
  assert.equal(summary.primaryScore, 0.82);
});

test("summarizeBenchmarkResult flattens per-task scores and assistant details", () => {
  const summary = summarizeBenchmarkResult(validResult(), "/tmp/run-1.json");

  const aTask = summary.taskSummaries[0];
  assert.equal(aTask?.primaryScore, 0.61);
  assert.deepEqual(aTask?.scoreEntries, [{ name: "accuracy", value: 0.61 }]);

  const bTask = summary.taskSummaries[1];
  assert.deepEqual(bTask?.scoreEntries, [
    { name: "score", value: 0.9 },
    { name: "f1", value: 0.5 },
  ]);
  assert.equal(bTask?.primaryScore, 0.9);
  assert.equal(bTask?.totalTokens, 14);
  assert.equal(bTask?.assistantDetails, null);

  assert.deepEqual(aTask?.assistantDetails, {
    focus: "calendar",
    rubricId: "assistant-v1",
    rubricSha256: "rubric-sha",
    judgeParseFailures: 1,
    perSeedScores: [
      {
        seed: 1,
        identityAccuracy: 5,
        stanceCoherence: 4,
        novelty: null,
        calibration: null,
        parseOk: true,
        notes: "solid",
        latencyMs: 900,
      },
    ],
  });
});

test("summarizeBenchmarkResult defaults integrity fields on legacy results", () => {
  const summary = summarizeBenchmarkResult(validResult(), "/tmp/run-1.json");

  assert.equal(summary.integrity.split, "unknown");
  assert.equal(summary.integrity.sealsPresent, false);
  assert.equal(summary.integrity.canaryScore, null);
  assert.equal(summary.integrity.canaryUnderFloor, null);
  assert.equal(summary.integrity.canaryFloor, CANARY_SCORE_FLOOR);
  assert.equal(summary.integrity.qrelsSealedHashShort, null);
  assert.equal(summary.systemProvider, "ollama/llama3");
  assert.equal(summary.judgeProvider, "unconfigured");
  assert.equal(summary.providerKey, "ollama/llama3__unconfigured");
});

test("summarizeBenchmarkResult honors a persisted canary floor and rejects bad ones", () => {
  const floored = validResult();
  floored.meta.canaryScore = 0.15;
  floored.meta.canaryFloor = 0.2;
  const flooredSummary = summarizeBenchmarkResult(floored, "/tmp/run-1.json");
  assert.equal(flooredSummary.integrity.canaryFloor, 0.2);
  assert.equal(flooredSummary.integrity.canaryUnderFloor, true);

  const negative = validResult();
  negative.meta.canaryScore = 0.15;
  negative.meta.canaryFloor = -1;
  const negativeSummary = summarizeBenchmarkResult(negative, "/tmp/run-1.json");
  assert.equal(negativeSummary.integrity.canaryFloor, CANARY_SCORE_FLOOR);
  assert.equal(negativeSummary.integrity.canaryUnderFloor, false);
});

test("summarizeBenchmarkResult coerces malformed unvalidated regions to nulls", () => {
  const malformed = validResult() as unknown as {
    results: { aggregates: Record<string, unknown>; statistics?: unknown };
  };
  malformed.results.aggregates = {
    broken: null,
    weird: "not-a-record",
  };
  malformed.results.statistics = "garbage";

  const summary = summarizeBenchmarkResult(
    malformed as unknown as BenchmarkResult,
    "/tmp/run-1.json",
  );

  assert.deepEqual(summary.aggregateMetrics, [
    {
      name: "broken",
      mean: null,
      median: null,
      stdDev: null,
      min: null,
      max: null,
      ciLower: null,
      ciUpper: null,
      ciLevel: null,
      effectSize: null,
      effectInterpretation: null,
    },
    {
      name: "weird",
      mean: null,
      median: null,
      stdDev: null,
      min: null,
      max: null,
      ciLower: null,
      ciUpper: null,
      ciLevel: null,
      effectSize: null,
      effectInterpretation: null,
    },
  ]);
  assert.equal(summary.primaryMetric, "broken");
  assert.equal(summary.primaryScore, null);
});

test("loadBenchmarkResultSummaries loads valid artifacts and skips the rest", async () => {
  const resultsDir = await mkdtemp(path.join(tmpdir(), "remnic-result-summary-"));
  try {
    await writeFile(
      path.join(resultsDir, "valid.json"),
      JSON.stringify(validResult()),
      "utf8",
    );
    await writeFile(
      path.join(resultsDir, "partial.json"),
      JSON.stringify({ meta: { id: "partial", benchmark: "locomo" } }),
      "utf8",
    );
    await writeFile(path.join(resultsDir, "malformed.json"), "{not-json", "utf8");
    await writeFile(path.join(resultsDir, "notes.txt"), "ignored", "utf8");

    const payload = await loadBenchmarkResultSummaries(resultsDir);

    assert.equal(payload.summaries.length, 1);
    assert.equal(payload.summaries[0]?.id, "run-1");
    assert.equal(payload.skippedFiles?.length, 2);
    const partial = payload.skippedFiles?.find((skip) => skip.filePath.endsWith("partial.json"));
    const malformed = payload.skippedFiles?.find((skip) => skip.filePath.endsWith("malformed.json"));
    assert.match(partial?.reason ?? "", /Invalid benchmark result file/);
    assert.match(malformed?.reason ?? "", /JSON|Expected|property/i);
  } finally {
    await rm(resultsDir, { recursive: true, force: true });
  }
});

test("loadBenchmarkResultSummaries returns an empty payload for a missing directory", async () => {
  const payload = await loadBenchmarkResultSummaries(path.join(tmpdir(), "remnic-absent-dir"));

  assert.deepEqual(payload.summaries, []);
  assert.deepEqual(payload.skippedFiles, []);
});
