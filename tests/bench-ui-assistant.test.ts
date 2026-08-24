import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ASSISTANT_BENCHMARK_IDS,
  ASSISTANT_RUBRIC_DIMENSION_KEYS,
  flattenAssistantSpotChecks,
  getAssistantDimensionBars,
  getAssistantRuns,
  getLatestAssistantRunByBenchmark,
  isAssistantBenchmark,
  type BenchResultSummary,
  type BenchResultSummaryPayload,
} from "../packages/bench-ui/src/bench-data.js";
import { loadBenchResultSummaries } from "../packages/bench-ui/src/results.js";
import type { MetricAggregate } from "@remnic/bench";
import { validResultFixture } from "../packages/bench-ui/src/testing/result-fixture.js";

/** Mean-only aggregate: the parser coerces the missing stats to nulls. */
function meanOnlyAggregate(mean: number): MetricAggregate {
  return { mean } as MetricAggregate;
}

function buildAssistantSummary(overrides: Partial<BenchResultSummary> = {}): BenchResultSummary {
  const base: BenchResultSummary = {
    id: "assistant-morning-brief-run-1",
    benchmark: "assistant-morning-brief",
    benchmarkTier: "remnic",
    timestamp: "2026-04-18T10:00:00.000Z",
    mode: "full",
    totalLatencyMs: 1000,
    meanQueryLatencyMs: 200,
    taskCount: 3,
    metricHighlights: [
      { name: "identity_accuracy", mean: 4.1 },
      { name: "stance_coherence", mean: 3.2 },
      { name: "novelty", mean: 3.9 },
    ],
    primaryMetric: "identity_accuracy",
    primaryScore: 4.1,
    runCount: 5,
    estimatedCostUsd: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    systemProvider: "openai/gpt-5.4",
    judgeProvider: "openai/gpt-5.4-mini",
    providerKey: "openai/gpt-5.4__openai/gpt-5.4-mini",
    adapterMode: "direct",
    aggregateMetrics: [
      {
        name: "identity_accuracy",
        mean: 4.1,
        median: 4,
        stdDev: 0.3,
        min: 3.6,
        max: 4.5,
        ciLower: 3.9,
        ciUpper: 4.3,
        ciLevel: 0.95,
        effectSize: null,
        effectInterpretation: null,
      },
      {
        name: "stance_coherence",
        mean: 3.2,
        median: 3,
        stdDev: 0.5,
        min: 2.5,
        max: 4,
        ciLower: 2.9,
        ciUpper: 3.5,
        ciLevel: 0.95,
        effectSize: null,
        effectInterpretation: null,
      },
      {
        name: "novelty",
        mean: 3.9,
        median: 4,
        stdDev: 0.4,
        min: 3.2,
        max: 4.3,
        ciLower: 3.6,
        ciUpper: 4.2,
        ciLevel: 0.95,
        effectSize: null,
        effectInterpretation: null,
      },
      {
        name: "calibration",
        mean: 4.5,
        median: 5,
        stdDev: 0.4,
        min: 3.8,
        max: 5,
        ciLower: 4.2,
        ciUpper: 4.8,
        ciLevel: 0.95,
        effectSize: null,
        effectInterpretation: null,
      },
      {
        name: "overall",
        mean: 3.925,
        median: 4,
        stdDev: 0.35,
        min: 3.4,
        max: 4.3,
        ciLower: 3.7,
        ciUpper: 4.15,
        ciLevel: 0.95,
        effectSize: null,
        effectInterpretation: null,
      },
    ],
    taskSummaries: [
      {
        taskId: "morning-brief.monday-priorities",
        question: "Morning brief",
        expected: "<rubric-judged>",
        actual: "synthesized",
        latencyMs: 120,
        totalTokens: 0,
        primaryScore: 4.1,
        scoreEntries: [],
        assistantDetails: {
          focus: "priority_surfacing",
          rubricId: "assistant-rubric-v1",
          rubricSha256: "abc123",
          perSeedScores: [
            {
              seed: 1,
              identityAccuracy: 4,
              stanceCoherence: 3,
              novelty: 4,
              calibration: 5,
              parseOk: true,
              notes: "scripted:morning-brief.monday-priorities#seed-1",
              latencyMs: 120,
            },
            {
              seed: 2,
              identityAccuracy: 4,
              stanceCoherence: 3,
              novelty: 4,
              calibration: 4,
              parseOk: true,
              notes: "scripted:morning-brief.monday-priorities#seed-2",
              latencyMs: 110,
            },
          ],
          judgeParseFailures: 0,
        },
      },
    ],
    integrity: {
      split: "unknown",
      sealsPresent: false,
      canaryUnderFloor: null,
      canaryScore: null,
      canaryFloor: 0.1,
      qrelsSealedHashShort: null,
      judgePromptHashShort: null,
      datasetHashShort: null,
    },
    assistantRubricId: "assistant-rubric-v1",
    assistantRubricSha256: "abc123",
    assistantRunId: "assistant-morning-brief-2026-04-18T10-00-00-000Z",
    filePath: "/tmp/assistant-run-1.json",
  };
  return { ...base, ...overrides };
}

test("isAssistantBenchmark recognises the registered assistant ids", () => {
  for (const id of ASSISTANT_BENCHMARK_IDS) {
    assert.equal(isAssistantBenchmark(id), true);
  }
  assert.equal(isAssistantBenchmark("longmemeval"), false);
  assert.equal(isAssistantBenchmark(""), false);
});

test("getAssistantDimensionBars surfaces all five rubric dimension keys with CI bounds", () => {
  const summary = buildAssistantSummary();
  const bars = getAssistantDimensionBars(summary);
  assert.equal(bars.length, ASSISTANT_RUBRIC_DIMENSION_KEYS.length);
  assert.deepEqual(
    bars.map((bar) => bar.dimension),
    [...ASSISTANT_RUBRIC_DIMENSION_KEYS],
  );
  const identity = bars.find((bar) => bar.dimension === "identity_accuracy")!;
  assert.equal(identity.mean, 4.1);
  assert.equal(identity.ciLower, 3.9);
  assert.equal(identity.ciUpper, 4.3);
});

test("getAssistantDimensionBars returns null means when summary is missing", () => {
  const bars = getAssistantDimensionBars(null);
  assert.equal(bars.length, ASSISTANT_RUBRIC_DIMENSION_KEYS.length);
  for (const bar of bars) {
    assert.equal(bar.mean, null);
    assert.equal(bar.ciLower, null);
    assert.equal(bar.ciUpper, null);
  }
});

test("getAssistantRuns filters to Assistant-tier benchmarks only", () => {
  const summary = buildAssistantSummary();
  const nonAssistant = buildAssistantSummary({
    id: "longmemeval-1",
    benchmark: "longmemeval",
    benchmarkTier: "published",
  });
  const payload: BenchResultSummaryPayload = {
    resultsDir: "/tmp/results",
    summaries: [summary, nonAssistant],
  };
  assert.deepEqual(
    getAssistantRuns(payload).map((run) => run.benchmark),
    ["assistant-morning-brief"],
  );
});

test("getLatestAssistantRunByBenchmark picks the newest run per benchmark", () => {
  const older = buildAssistantSummary({
    id: "mb-old",
    timestamp: "2026-04-17T10:00:00.000Z",
  });
  const newer = buildAssistantSummary({
    id: "mb-new",
    timestamp: "2026-04-18T11:00:00.000Z",
  });
  const payload: BenchResultSummaryPayload = {
    resultsDir: "/tmp/results",
    summaries: [older, newer],
  };
  const latest = getLatestAssistantRunByBenchmark(payload);
  assert.equal(latest["assistant-morning-brief"]?.id, "mb-new");
  assert.equal(latest["assistant-meeting-prep"], null);
});

test("flattenAssistantSpotChecks expands per-seed decisions with task context", () => {
  const summary = buildAssistantSummary();
  const rows = flattenAssistantSpotChecks(summary);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.taskId, "morning-brief.monday-priorities");
  assert.equal(rows[0]?.seed, 1);
  assert.equal(rows[0]?.focus, "priority_surfacing");
  assert.equal(rows[0]?.parseOk, true);
});

test("bench UI loader surfaces assistant rubric metadata and per-seed details", async () => {
  const resultsDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-ui-assistant-"),
  );
  const artifact = validResultFixture("assistant-run-1");
  artifact.meta.benchmark = "assistant-morning-brief";
  artifact.meta.timestamp = "2026-04-18T10:00:00.000Z";
  artifact.config.remnicConfig = {
    assistantRubricId: "assistant-rubric-v1",
    assistantRubricSha256: "deadbeef".repeat(8),
    assistantRunId: "assistant-morning-brief-2026-04-18T10-00-00-000Z",
  };
  artifact.cost.totalLatencyMs = 100;
  artifact.cost.meanQueryLatencyMs = 50;
  artifact.results = {
    tasks: [
      {
        taskId: "morning-brief.monday-priorities",
        question: "Morning brief",
        expected: "<rubric-judged>",
        actual: "synthesized",
        scores: {
          identity_accuracy: 4,
          calibration: 4.5,
          overall: 4.2,
        },
        latencyMs: 120,
        tokens: { input: 0, output: 0 },
        details: {
          focus: "priority_surfacing",
          rubricId: "assistant-rubric-v1",
          rubricSha256: "deadbeef".repeat(8),
          perSeedScores: [
            {
              seed: 1,
              scores: {
                identity_accuracy: 4,
                stance_coherence: 3,
                novelty: 4,
                calibration: 5,
              },
              parseOk: true,
              notes: "seed 1",
              latencyMs: 120,
            },
          ],
          judgeParseFailures: 0,
        },
      },
    ],
    aggregates: {
      identity_accuracy: meanOnlyAggregate(4),
      calibration: meanOnlyAggregate(4.5),
      overall: meanOnlyAggregate(4.2),
    },
    statistics: {
      bootstrapSamples: 1000,
      confidenceIntervals: {
        identity_accuracy: { lower: 3.8, upper: 4.2, level: 0.95 },
        calibration: { lower: 4.3, upper: 4.7, level: 0.95 },
        overall: { lower: 4.0, upper: 4.4, level: 0.95 },
      },
    },
  };
  await writeFile(path.join(resultsDir, "assistant.json"), JSON.stringify(artifact, null, 2));

  const payload = await loadBenchResultSummaries(resultsDir);
  assert.equal(payload.summaries.length, 1);
  const summary = payload.summaries[0]!;
  assert.equal(summary.assistantRubricId, "assistant-rubric-v1");
  assert.equal(summary.assistantRubricSha256?.length, 64);
  assert.equal(summary.assistantRunId, "assistant-morning-brief-2026-04-18T10-00-00-000Z");

  const task = summary.taskSummaries[0]!;
  assert.ok(task.assistantDetails, "assistantDetails should be populated");
  assert.equal(task.assistantDetails?.focus, "priority_surfacing");
  assert.equal(task.assistantDetails?.perSeedScores.length, 1);
  assert.equal(task.assistantDetails?.perSeedScores[0]?.seed, 1);
  assert.equal(task.assistantDetails?.perSeedScores[0]?.identityAccuracy, 4);
  assert.equal(task.assistantDetails?.perSeedScores[0]?.parseOk, true);

  const aggregate = summary.aggregateMetrics.find(
    (metric) => metric.name === "identity_accuracy",
  );
  assert.ok(aggregate);
  assert.equal(aggregate?.ciLower, 3.8);
  assert.equal(aggregate?.ciUpper, 4.2);
  assert.equal(aggregate?.ciLevel, 0.95);
});
