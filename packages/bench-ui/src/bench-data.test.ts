import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCompareModel,
  buildProviderRows,
  deltaPolarityClass,
  getRecentRuns,
  pickDefaultCompareIds,
  type BenchResultSummary,
} from "./bench-data";

function task(taskId: string, primaryScore: number | null) {
  return {
    taskId,
    question: `${taskId} question`,
    expected: "",
    actual: "",
    latencyMs: null,
    totalTokens: 0,
    primaryScore,
    scoreEntries: [],
  };
}

function summary(overrides: Partial<BenchResultSummary>): BenchResultSummary {
  return {
    id: "run",
    benchmark: "bench-a",
    benchmarkTier: "local",
    timestamp: "2026-05-21T00:00:00.000Z",
    mode: "quick",
    totalLatencyMs: null,
    meanQueryLatencyMs: null,
    taskCount: 0,
    metricHighlights: [],
    primaryMetric: "accuracy",
    primaryScore: null,
    runCount: 1,
    estimatedCostUsd: null,
    totalTokens: null,
    inputTokens: null,
    outputTokens: null,
    systemProvider: "system-a",
    judgeProvider: "judge-a",
    providerKey: "system-a::judge-a",
    adapterMode: "memory",
    aggregateMetrics: [],
    taskSummaries: [],
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
    filePath: "/tmp/run.json",
    ...overrides,
  };
}

test("deltaPolarityClass inverts polarity for lower-is-better metrics", () => {
  assert.equal(
    deltaPolarityClass(2, "errors_count"),
    "delta-pill--negative",
  );
  assert.equal(
    deltaPolarityClass(-2, "errors_count"),
    "delta-pill--positive",
  );
});

test("deltaPolarityClass preserves polarity for higher-is-better metrics", () => {
  assert.equal(deltaPolarityClass(0.1, "accuracy"), "delta-pill--positive");
  assert.equal(deltaPolarityClass(-0.1, "accuracy"), "delta-pill--negative");
  assert.equal(deltaPolarityClass(0, "accuracy"), "");
  assert.equal(deltaPolarityClass(null, "accuracy"), "");
});

test("buildProviderRows aggregates duplicate benchmark cells independent of input order", () => {
  const low = summary({ id: "low", primaryScore: 0.1 });
  const high = summary({ id: "high", primaryScore: 0.9 });
  const other = summary({
    id: "other",
    benchmark: "bench-b",
    primaryScore: null,
  });

  const firstOrder = buildProviderRows({ resultsDir: "/tmp/results", summaries: [low, high, other] });
  const secondOrder = buildProviderRows({ resultsDir: "/tmp/results", summaries: [high, other, low] });

  assert.equal(firstOrder[0]?.averageScore, 0.5);
  assert.equal(firstOrder[0]?.benchmarkScores["bench-a"], 0.5);
  assert.equal(firstOrder[0]?.benchmarkScores["bench-b"], null);
  assert.deepEqual(secondOrder[0]?.benchmarkScores, firstOrder[0]?.benchmarkScores);
});

test("getRecentRuns returns globally newest runs instead of one latest run per benchmark", () => {
  const runs = [
    summary({
      id: "a-10",
      benchmark: "bench-a",
      timestamp: "2026-05-21T10:00:00.000Z",
      primaryScore: 3,
    }),
    summary({
      id: "a-09",
      benchmark: "bench-a",
      timestamp: "2026-05-21T09:00:00.000Z",
      primaryScore: 2,
    }),
    summary({
      id: "a-08",
      benchmark: "bench-a",
      timestamp: "2026-05-21T08:00:00.000Z",
      primaryScore: 1,
    }),
    summary({
      id: "b-07",
      benchmark: "bench-b",
      timestamp: "2026-05-21T07:00:00.000Z",
      primaryScore: 10,
    }),
  ];

  const recent = getRecentRuns({ resultsDir: "/tmp/results", summaries: runs });

  assert.deepEqual(
    recent.map((run) => run.id),
    ["a-10", "a-09", "a-08", "b-07"],
  );
  assert.equal(recent[0]?.delta, 1);
  assert.equal(recent[1]?.delta, 1);
  assert.equal(recent[2]?.delta, null);
});

test("pickDefaultCompareIds chooses newest comparable benchmark pair", () => {
  const payload = {
    resultsDir: "/tmp/results",
    summaries: [
      summary({
        id: "a-latest",
        benchmark: "bench-a",
        timestamp: "2026-05-21T10:00:00.000Z",
      }),
      summary({
        id: "b-latest",
        benchmark: "bench-b",
        timestamp: "2026-05-21T09:00:00.000Z",
      }),
      summary({
        id: "a-older",
        benchmark: "bench-a",
        timestamp: "2026-05-21T08:00:00.000Z",
      }),
    ],
  };

  assert.deepEqual(pickDefaultCompareIds(payload), {
    candidateId: "a-latest",
    baselineId: "a-older",
  });
});

test("buildCompareModel orders task rows by largest absolute score movement", () => {
  const baselineTasks = [
    task("large-positive", 0.5),
    ...Array.from({ length: 9 }, (_, index) => task(`small-negative-${index}`, 0.5)),
  ];
  const candidateTasks = [
    task("large-positive", 0.9),
    ...Array.from({ length: 9 }, (_, index) => task(`small-negative-${index}`, 0.49)),
  ];
  const comparison = buildCompareModel(
    {
      resultsDir: "/tmp/results",
      summaries: [
        summary({ id: "baseline", taskSummaries: baselineTasks }),
        summary({ id: "candidate", taskSummaries: candidateTasks }),
      ],
    },
    "baseline",
    "candidate",
  );

  assert.ok(comparison);
  assert.equal(comparison.taskRows[0]?.taskId, "large-positive");
  assert.equal(comparison.taskRows[0]?.delta, 0.4);
});
