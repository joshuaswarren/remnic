import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildHistogram,
  formatMetricValue,
  buildProviderRows,
  filterRuns,
  getBenchmarkCards,
  getTrendPoints,
  type BenchIntegritySummary,
  type BenchResultSummaryPayload,
} from "../packages/bench-ui/src/bench-data.js";
import {
  buildBenchmarkDetailTaskRows,
  resolveSelectedRunId,
  selectLowestScoringTasks,
} from "../packages/bench-ui/src/pages/BenchmarkDetail.js";
import { canCompareBenchRuns, filterComparableCandidateRuns } from "../packages/bench-ui/src/pages/Compare.js";
import { loadBenchResultSummaries } from "../packages/bench-ui/src/results.js";

const FIXTURE_INTEGRITY: BenchIntegritySummary = {
  split: "unknown",
  sealsPresent: false,
  canaryScore: null,
  canaryFloor: 0.1,
  canaryUnderFloor: null,
  qrelsSealedHashShort: null,
  judgePromptHashShort: null,
  datasetHashShort: null,
};

test("bench UI loader summarizes valid benchmark JSON files and ignores invalid entries", async () => {
  const resultsDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-ui-"));

  await writeFile(
    path.join(resultsDir, "latest.json"),
    JSON.stringify({
      meta: {
        id: "latest-run",
        benchmark: "longmemeval",
        timestamp: "2026-04-18T10:00:00.000Z",
        mode: "quick",
      },
      cost: {
        totalLatencyMs: 1234,
        meanQueryLatencyMs: 617,
      },
      results: {
        tasks: [{ taskId: "task-1" }, { taskId: "task-2" }],
        aggregates: {
          accuracy: { mean: 0.75 },
          f1: { mean: 0.63 },
          llm_judge: { mean: 0.9 },
          ignored: { mean: "bad" },
        },
      },
    }, null, 2),
  );

  await writeFile(
    path.join(resultsDir, "older.json"),
    JSON.stringify({
      meta: {
        id: "older-run",
        benchmark: "ama-bench",
        timestamp: "2026-04-17T10:00:00.000Z",
        mode: "full",
      },
      cost: {
        totalLatencyMs: 99,
        meanQueryLatencyMs: 33,
      },
      results: {
        tasks: [],
        aggregates: {},
      },
    }, null, 2),
  );

  await writeFile(path.join(resultsDir, "broken.json"), "{oops");
  await mkdir(path.join(resultsDir, "nested"));

  const payload = await loadBenchResultSummaries(resultsDir);

  assert.equal(payload.resultsDir, resultsDir);
  assert.equal(payload.summaries.length, 2);
  assert.deepEqual(payload.summaries.map((summary) => summary.id), [
    "latest-run",
    "older-run",
  ]);
  assert.equal(payload.summaries[0]?.taskCount, 2);
  assert.deepEqual(payload.summaries[0]?.metricHighlights, [
    { name: "accuracy", mean: 0.75 },
    { name: "f1", mean: 0.63 },
    { name: "llm_judge", mean: 0.9 },
  ]);
});

test("bench UI loader surfaces integrity metadata from result meta", async () => {
  const resultsDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-ui-integrity-"));
  await writeFile(
    path.join(resultsDir, "holdout.json"),
    JSON.stringify({
      meta: {
        id: "holdout-run",
        benchmark: "longmemeval",
        timestamp: "2026-04-18T10:00:00.000Z",
        mode: "full",
        splitType: "holdout",
        qrelsSealedHash: "a".repeat(64),
        judgePromptHash: "b".repeat(64),
        datasetHash: "c".repeat(64),
        canaryScore: 0.03,
      },
      cost: {},
      results: { tasks: [], aggregates: {} },
    }),
  );

  const payload = await loadBenchResultSummaries(resultsDir);
  const summary = payload.summaries[0];
  assert.ok(summary);
  assert.equal(summary.integrity.split, "holdout");
  assert.equal(summary.integrity.sealsPresent, true);
  assert.equal(summary.integrity.canaryScore, 0.03);
  assert.equal(summary.integrity.canaryUnderFloor, true);
  assert.equal(summary.integrity.qrelsSealedHashShort, "a".repeat(12));
});

test("bench UI loader honors a per-result canaryFloor when present", async () => {
  const resultsDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-ui-floor-"));
  // With a floor of 0.05 and a score of 0.08 the canary is OVER floor —
  // the badge must mark the result unverified even though the default
  // floor (0.1) would accept the same score.
  await writeFile(
    path.join(resultsDir, "custom-floor.json"),
    JSON.stringify({
      meta: {
        id: "custom-floor-run",
        benchmark: "longmemeval",
        timestamp: "2026-04-18T10:00:00.000Z",
        mode: "full",
        splitType: "holdout",
        qrelsSealedHash: "a".repeat(64),
        judgePromptHash: "b".repeat(64),
        datasetHash: "c".repeat(64),
        canaryScore: 0.08,
        canaryFloor: 0.05,
      },
      cost: {},
      results: { tasks: [], aggregates: {} },
    }),
  );

  const payload = await loadBenchResultSummaries(resultsDir);
  const summary = payload.summaries[0];
  assert.ok(summary);
  assert.equal(summary.integrity.canaryFloor, 0.05);
  assert.equal(summary.integrity.canaryUnderFloor, false);
});

test("bench UI loader marks legacy results without integrity metadata as unknown split", async () => {
  const resultsDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-ui-legacy-"));
  await writeFile(
    path.join(resultsDir, "legacy.json"),
    JSON.stringify({
      meta: {
        id: "legacy-run",
        benchmark: "longmemeval",
        timestamp: "2026-04-18T10:00:00.000Z",
        mode: "quick",
      },
      cost: {},
      results: { tasks: [], aggregates: {} },
    }),
  );

  const payload = await loadBenchResultSummaries(resultsDir);
  const summary = payload.summaries[0];
  assert.ok(summary);
  assert.equal(summary.integrity.split, "unknown");
  assert.equal(summary.integrity.sealsPresent, false);
  assert.equal(summary.integrity.canaryScore, null);
  assert.equal(summary.integrity.canaryUnderFloor, null);
});

test("bench UI loader returns an empty payload when the results directory is missing", async () => {
  const resultsDir = path.join(os.tmpdir(), "remnic-bench-ui-missing");
  const payload = await loadBenchResultSummaries(resultsDir);

  assert.equal(payload.resultsDir, resultsDir);
  assert.deepEqual(payload.summaries, []);
});

test("getBenchmarkCards keeps delta null when a benchmark has only one run", () => {
  const payload: BenchResultSummaryPayload = {
    resultsDir: "/tmp/results",
    summaries: [
      {
        id: "latest-run",
        benchmark: "longmemeval",
        benchmarkTier: "published",
        timestamp: "2026-04-18T10:00:00.000Z",
        mode: "quick",
        totalLatencyMs: 1234,
        meanQueryLatencyMs: 617,
        taskCount: 2,
        metricHighlights: [{ name: "accuracy", mean: 0.75 }],
        primaryMetric: "accuracy",
        primaryScore: 0.75,
        runCount: 1,
        estimatedCostUsd: 0.12,
        totalTokens: 100,
        inputTokens: 60,
        outputTokens: 40,
        systemProvider: "openai/gpt-5.4",
        judgeProvider: "openai/gpt-5.4-mini",
        providerKey: "openai/gpt-5.4__openai/gpt-5.4-mini",
        adapterMode: "standalone",
        aggregateMetrics: [],
        taskSummaries: [],
        integrity: FIXTURE_INTEGRITY,
        filePath: "/tmp/results/latest-run.json",
      },
    ],
  };

  const cards = getBenchmarkCards(payload);

  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.previous, null);
  assert.equal(cards[0]?.delta, null);
});

test("formatMetricValue keeps raw count metrics as counts", () => {
  assert.equal(formatMetricValue(7, "search_hits"), "7");
  assert.equal(formatMetricValue(0.75, "accuracy"), "75.0%");
});

test("getBenchmarkCards sorts benchmark runs before choosing latest and previous", () => {
  const payload: BenchResultSummaryPayload = {
    resultsDir: "/tmp/results",
    summaries: [
      {
        id: "older-run",
        benchmark: "longmemeval",
        benchmarkTier: "published",
        timestamp: "2026-04-17T10:00:00.000Z",
        mode: "quick",
        totalLatencyMs: 1400,
        meanQueryLatencyMs: 700,
        taskCount: 2,
        metricHighlights: [{ name: "accuracy", mean: 0.42 }],
        primaryMetric: "accuracy",
        primaryScore: 0.42,
        runCount: 1,
        estimatedCostUsd: 0.18,
        totalTokens: 120,
        inputTokens: 75,
        outputTokens: 45,
        systemProvider: "openai/gpt-5.4",
        judgeProvider: "openai/gpt-5.4-mini",
        providerKey: "openai/gpt-5.4__openai/gpt-5.4-mini",
        adapterMode: "standalone",
        aggregateMetrics: [],
        taskSummaries: [],
        integrity: FIXTURE_INTEGRITY,
        filePath: "/tmp/results/older-run.json",
      },
      {
        id: "latest-run",
        benchmark: "longmemeval",
        benchmarkTier: "published",
        timestamp: "2026-04-18T10:00:00.000Z",
        mode: "quick",
        totalLatencyMs: 1234,
        meanQueryLatencyMs: 617,
        taskCount: 2,
        metricHighlights: [{ name: "accuracy", mean: 0.91 }],
        primaryMetric: "accuracy",
        primaryScore: 0.91,
        runCount: 1,
        estimatedCostUsd: 0.14,
        totalTokens: 110,
        inputTokens: 70,
        outputTokens: 40,
        systemProvider: "openai/gpt-5.4",
        judgeProvider: "openai/gpt-5.4-mini",
        providerKey: "openai/gpt-5.4__openai/gpt-5.4-mini",
        adapterMode: "standalone",
        aggregateMetrics: [],
        taskSummaries: [],
        integrity: FIXTURE_INTEGRITY,
        filePath: "/tmp/results/latest-run.json",
      },
    ],
  };

  const cards = getBenchmarkCards(payload);

  assert.equal(cards[0]?.latest.id, "latest-run");
  assert.equal(cards[0]?.previous?.id, "older-run");
});

test("filterRuns uses wall-clock time for recency windows", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-04-18T12:00:00.000Z"));
  const payload: BenchResultSummaryPayload = {
    resultsDir: "/tmp/results",
    summaries: [
      {
        id: "stale-run",
        benchmark: "longmemeval",
        benchmarkTier: "published",
        timestamp: "2026-03-01T10:00:00.000Z",
        mode: "quick",
        totalLatencyMs: 1234,
        meanQueryLatencyMs: 617,
        taskCount: 2,
        metricHighlights: [{ name: "accuracy", mean: 0.75 }],
        primaryMetric: "accuracy",
        primaryScore: 0.75,
        runCount: 1,
        estimatedCostUsd: 0.12,
        totalTokens: 100,
        inputTokens: 60,
        outputTokens: 40,
        systemProvider: "openai/gpt-5.4",
        judgeProvider: "openai/gpt-5.4-mini",
        providerKey: "openai/gpt-5.4__openai/gpt-5.4-mini",
        adapterMode: "standalone",
        aggregateMetrics: [],
        taskSummaries: [],
        integrity: FIXTURE_INTEGRITY,
        filePath: "/tmp/results/stale-run.json",
      },
    ],
  };

  const runs = filterRuns(payload, {
    benchmark: "all",
    systemProvider: "all",
    judgeProvider: "all",
    mode: "all",
    range: "7d",
  });

  assert.deepEqual(runs, []);
});

test("getTrendPoints uses wall-clock time for recency windows", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-04-18T12:00:00.000Z"));
  const payload: BenchResultSummaryPayload = {
    resultsDir: "/tmp/results",
    summaries: [
      {
        id: "stale-run",
        benchmark: "longmemeval",
        benchmarkTier: "published",
        timestamp: "2026-03-01T10:00:00.000Z",
        mode: "quick",
        totalLatencyMs: 1234,
        meanQueryLatencyMs: 617,
        taskCount: 2,
        metricHighlights: [{ name: "accuracy", mean: 0.75 }],
        primaryMetric: "accuracy",
        primaryScore: 0.75,
        runCount: 1,
        estimatedCostUsd: 0.12,
        totalTokens: 100,
        inputTokens: 60,
        outputTokens: 40,
        systemProvider: "openai/gpt-5.4",
        judgeProvider: "openai/gpt-5.4-mini",
        providerKey: "openai/gpt-5.4__openai/gpt-5.4-mini",
        adapterMode: "standalone",
        aggregateMetrics: [],
        taskSummaries: [],
        integrity: FIXTURE_INTEGRITY,
        filePath: "/tmp/results/stale-run.json",
      },
    ],
  };

  assert.deepEqual(getTrendPoints(payload, "all", "7d"), []);
});

test("recency filters exclude future runs beyond the current wall-clock anchor", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-04-18T12:00:00.000Z"));
  const payload: BenchResultSummaryPayload = {
    resultsDir: "/tmp/results",
    summaries: [
      {
        id: "future-run",
        benchmark: "longmemeval",
        benchmarkTier: "published",
        timestamp: "2026-04-19T10:00:00.000Z",
        mode: "quick",
        totalLatencyMs: 1234,
        meanQueryLatencyMs: 617,
        taskCount: 2,
        metricHighlights: [{ name: "accuracy", mean: 0.75 }],
        primaryMetric: "accuracy",
        primaryScore: 0.75,
        runCount: 1,
        estimatedCostUsd: 0.12,
        totalTokens: 100,
        inputTokens: 60,
        outputTokens: 40,
        systemProvider: "openai/gpt-5.4",
        judgeProvider: "openai/gpt-5.4-mini",
        providerKey: "openai/gpt-5.4__openai/gpt-5.4-mini",
        adapterMode: "standalone",
        aggregateMetrics: [],
        taskSummaries: [],
        integrity: FIXTURE_INTEGRITY,
        filePath: "/tmp/results/future-run.json",
      },
    ],
  };

  assert.deepEqual(
    filterRuns(payload, {
      benchmark: "all",
      systemProvider: "all",
      judgeProvider: "all",
      mode: "all",
      range: "7d",
    }),
    [],
  );
  assert.deepEqual(getTrendPoints(payload, "all", "7d"), []);
});

test("benchmark detail helpers keep single-run deltas null and sort low scorers ascending", () => {
  const taskRows = buildBenchmarkDetailTaskRows({
    id: "latest-run",
    benchmark: "longmemeval",
    benchmarkTier: "published",
    timestamp: "2026-04-18T10:00:00.000Z",
    mode: "quick",
    totalLatencyMs: 1234,
    meanQueryLatencyMs: 617,
    taskCount: 6,
    metricHighlights: [{ name: "accuracy", mean: 0.75 }],
    primaryMetric: "accuracy",
    primaryScore: 0.75,
    runCount: 1,
    estimatedCostUsd: 0.12,
    totalTokens: 100,
    inputTokens: 60,
    outputTokens: 40,
    systemProvider: "openai/gpt-5.4",
    judgeProvider: "openai/gpt-5.4-mini",
    providerKey: "openai/gpt-5.4__openai/gpt-5.4-mini",
    adapterMode: "standalone",
    aggregateMetrics: [],
    taskSummaries: [
      { taskId: "task-1", question: "Q1", expected: "", actual: "", latencyMs: 10, totalTokens: 1, primaryScore: 0.55, scoreEntries: [] },
      { taskId: "task-2", question: "Q2", expected: "", actual: "", latencyMs: 10, totalTokens: 1, primaryScore: 0.11, scoreEntries: [] },
      { taskId: "task-3", question: "Q3", expected: "", actual: "", latencyMs: 10, totalTokens: 1, primaryScore: 0.44, scoreEntries: [] },
      { taskId: "task-4", question: "Q4", expected: "", actual: "", latencyMs: 10, totalTokens: 1, primaryScore: 0.25, scoreEntries: [] },
      { taskId: "task-5", question: "Q5", expected: "", actual: "", latencyMs: 10, totalTokens: 1, primaryScore: 0.35, scoreEntries: [] },
      { taskId: "task-6", question: "Q6", expected: "", actual: "", latencyMs: 10, totalTokens: 1, primaryScore: 0.05, scoreEntries: [] },
    ],
    integrity: FIXTURE_INTEGRITY,
    filePath: "/tmp/results/latest-run.json",
  });

  assert(taskRows.every((row) => row.delta === null));
  assert.deepEqual(
    selectLowestScoringTasks(taskRows).map((row) => row.taskId),
    ["task-6", "task-2", "task-4", "task-5", "task-3"],
  );
});

test("resolveSelectedRunId falls back to the current benchmark run list", () => {
  const runs = [
    {
      id: "run-b",
      benchmark: "longmemeval",
      benchmarkTier: "published",
      timestamp: "2026-04-18T10:00:00.000Z",
      mode: "quick" as const,
      totalLatencyMs: 1234,
      meanQueryLatencyMs: 617,
      taskCount: 1,
      metricHighlights: [],
      primaryMetric: "accuracy",
      primaryScore: 0.75,
      runCount: 1,
      estimatedCostUsd: 0.12,
      totalTokens: 100,
      inputTokens: 60,
      outputTokens: 40,
      systemProvider: "openai/gpt-5.4",
      judgeProvider: "openai/gpt-5.4-mini",
      providerKey: "openai/gpt-5.4__openai/gpt-5.4-mini",
      adapterMode: "standalone",
      aggregateMetrics: [],
      taskSummaries: [],
      integrity: FIXTURE_INTEGRITY,
      filePath: "/tmp/results/run-b.json",
    },
    {
      id: "run-a",
      benchmark: "longmemeval",
      benchmarkTier: "published",
      timestamp: "2026-04-17T10:00:00.000Z",
      mode: "quick" as const,
      totalLatencyMs: 1234,
      meanQueryLatencyMs: 617,
      taskCount: 1,
      metricHighlights: [],
      primaryMetric: "accuracy",
      primaryScore: 0.6,
      runCount: 1,
      estimatedCostUsd: 0.12,
      totalTokens: 100,
      inputTokens: 60,
      outputTokens: 40,
      systemProvider: "openai/gpt-5.4",
      judgeProvider: "openai/gpt-5.4-mini",
      providerKey: "openai/gpt-5.4__openai/gpt-5.4-mini",
      adapterMode: "standalone",
      aggregateMetrics: [],
      taskSummaries: [],
      integrity: FIXTURE_INTEGRITY,
      filePath: "/tmp/results/run-a.json",
    },
  ];

  assert.equal(resolveSelectedRunId(runs, "missing-run"), "run-b");
  assert.equal(resolveSelectedRunId(runs, "run-a"), "run-a");
  assert.equal(resolveSelectedRunId([], "missing-run"), "");
});

test("buildHistogram buckets boundary scores by floor semantics", () => {
  const summary = {
    id: "latest-run",
    benchmark: "longmemeval",
    benchmarkTier: "published",
    timestamp: "2026-04-18T10:00:00.000Z",
    mode: "quick" as const,
    totalLatencyMs: 1234,
    meanQueryLatencyMs: 617,
    taskCount: 6,
    metricHighlights: [],
    primaryMetric: "accuracy",
    primaryScore: 0.75,
    runCount: 1,
    estimatedCostUsd: 0.12,
    totalTokens: 100,
    inputTokens: 60,
    outputTokens: 40,
    systemProvider: "openai/gpt-5.4",
    judgeProvider: "openai/gpt-5.4-mini",
    providerKey: "openai/gpt-5.4__openai/gpt-5.4-mini",
    adapterMode: "standalone",
    aggregateMetrics: [],
    taskSummaries: [
      { taskId: "task-1", question: "", expected: "", actual: "", latencyMs: null, totalTokens: 0, primaryScore: 0.199, scoreEntries: [] },
      { taskId: "task-2", question: "", expected: "", actual: "", latencyMs: null, totalTokens: 0, primaryScore: 0.2, scoreEntries: [] },
      { taskId: "task-3", question: "", expected: "", actual: "", latencyMs: null, totalTokens: 0, primaryScore: 0.399, scoreEntries: [] },
      { taskId: "task-4", question: "", expected: "", actual: "", latencyMs: null, totalTokens: 0, primaryScore: 0.4, scoreEntries: [] },
      { taskId: "task-5", question: "", expected: "", actual: "", latencyMs: null, totalTokens: 0, primaryScore: 0.8, scoreEntries: [] },
      { taskId: "task-6", question: "", expected: "", actual: "", latencyMs: null, totalTokens: 0, primaryScore: 1, scoreEntries: [] },
    ],
    integrity: FIXTURE_INTEGRITY,
    filePath: "/tmp/results/latest-run.json",
  };

  assert.deepEqual(
    buildHistogram(summary).map((bucket) => bucket.count),
    [1, 2, 1, 0, 2],
  );
});

test("compare helpers constrain candidate options to the selected benchmark", () => {
  const payload: BenchResultSummaryPayload = {
    resultsDir: "/tmp/results",
    summaries: [
      {
        id: "baseline-run",
        benchmark: "longmemeval",
        benchmarkTier: "published",
        timestamp: "2026-04-18T10:00:00.000Z",
        mode: "quick",
        totalLatencyMs: 1234,
        meanQueryLatencyMs: 617,
        taskCount: 2,
        metricHighlights: [{ name: "accuracy", mean: 0.75 }],
        primaryMetric: "accuracy",
        primaryScore: 0.75,
        runCount: 1,
        estimatedCostUsd: 0.12,
        totalTokens: 100,
        inputTokens: 60,
        outputTokens: 40,
        systemProvider: "openai/gpt-5.4",
        judgeProvider: "openai/gpt-5.4-mini",
        providerKey: "openai/gpt-5.4__openai/gpt-5.4-mini",
        adapterMode: "standalone",
        aggregateMetrics: [],
        taskSummaries: [],
        integrity: FIXTURE_INTEGRITY,
        filePath: "/tmp/results/baseline-run.json",
      },
      {
        id: "candidate-run",
        benchmark: "longmemeval",
        benchmarkTier: "published",
        timestamp: "2026-04-17T10:00:00.000Z",
        mode: "quick",
        totalLatencyMs: 1234,
        meanQueryLatencyMs: 617,
        taskCount: 2,
        metricHighlights: [{ name: "accuracy", mean: 0.80 }],
        primaryMetric: "accuracy",
        primaryScore: 0.80,
        runCount: 1,
        estimatedCostUsd: 0.12,
        totalTokens: 100,
        inputTokens: 60,
        outputTokens: 40,
        systemProvider: "openai/gpt-5.4",
        judgeProvider: "openai/gpt-5.4-mini",
        providerKey: "openai/gpt-5.4__openai/gpt-5.4-mini",
        adapterMode: "standalone",
        aggregateMetrics: [],
        taskSummaries: [],
        integrity: FIXTURE_INTEGRITY,
        filePath: "/tmp/results/candidate-run.json",
      },
      {
        id: "other-run",
        benchmark: "ama-bench",
        benchmarkTier: "published",
        timestamp: "2026-04-17T09:00:00.000Z",
        mode: "quick",
        totalLatencyMs: 1234,
        meanQueryLatencyMs: 617,
        taskCount: 2,
        metricHighlights: [{ name: "accuracy", mean: 0.33 }],
        primaryMetric: "accuracy",
        primaryScore: 0.33,
        runCount: 1,
        estimatedCostUsd: 0.12,
        totalTokens: 100,
        inputTokens: 60,
        outputTokens: 40,
        systemProvider: "openai/gpt-5.4",
        judgeProvider: "openai/gpt-5.4-mini",
        providerKey: "openai/gpt-5.4__openai/gpt-5.4-mini",
        adapterMode: "standalone",
        aggregateMetrics: [],
        taskSummaries: [],
        integrity: FIXTURE_INTEGRITY,
        filePath: "/tmp/results/other-run.json",
      },
    ],
  };

  const baselineSummary = payload.summaries[0] ?? null;
  const candidateSummary = payload.summaries[1] ?? null;
  const otherSummary = payload.summaries[2] ?? null;

  assert.deepEqual(
    filterComparableCandidateRuns(payload, baselineSummary).map((summary) => summary.id),
    ["candidate-run"],
  );
  assert.equal(canCompareBenchRuns(baselineSummary, candidateSummary), true);
  assert.equal(canCompareBenchRuns(baselineSummary, otherSummary), false);
});

test("buildProviderRows keeps the newest benchmark score for each provider", () => {
  const payload: BenchResultSummaryPayload = {
    resultsDir: "/tmp/results",
    summaries: [
      {
        id: "latest-run",
        benchmark: "longmemeval",
        benchmarkTier: "published",
        timestamp: "2026-04-18T10:00:00.000Z",
        mode: "quick",
        totalLatencyMs: 1234,
        meanQueryLatencyMs: 617,
        taskCount: 2,
        metricHighlights: [{ name: "accuracy", mean: 0.91 }],
        primaryMetric: "accuracy",
        primaryScore: 0.91,
        runCount: 1,
        estimatedCostUsd: 0.14,
        totalTokens: 110,
        inputTokens: 70,
        outputTokens: 40,
        systemProvider: "openai/gpt-5.4",
        judgeProvider: "openai/gpt-5.4-mini",
        providerKey: "openai/gpt-5.4__openai/gpt-5.4-mini",
        adapterMode: "standalone",
        aggregateMetrics: [],
        taskSummaries: [],
        integrity: FIXTURE_INTEGRITY,
        filePath: "/tmp/results/latest-run.json",
      },
      {
        id: "older-run",
        benchmark: "longmemeval",
        benchmarkTier: "published",
        timestamp: "2026-04-17T10:00:00.000Z",
        mode: "quick",
        totalLatencyMs: 1400,
        meanQueryLatencyMs: 700,
        taskCount: 2,
        metricHighlights: [{ name: "accuracy", mean: 0.42 }],
        primaryMetric: "accuracy",
        primaryScore: 0.42,
        runCount: 1,
        estimatedCostUsd: 0.18,
        totalTokens: 120,
        inputTokens: 75,
        outputTokens: 45,
        systemProvider: "openai/gpt-5.4",
        judgeProvider: "openai/gpt-5.4-mini",
        providerKey: "openai/gpt-5.4__openai/gpt-5.4-mini",
        adapterMode: "standalone",
        aggregateMetrics: [],
        taskSummaries: [],
        integrity: FIXTURE_INTEGRITY,
        filePath: "/tmp/results/older-run.json",
      },
    ],
  };

  const rows = buildProviderRows(payload);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.benchmarkScores.longmemeval, 0.91);
  assert.equal(rows[0]?.runCount, 2);
  assert.equal(rows[0]?.averageScore, (0.91 + 0.42) / 2);
  assert.equal(rows[0]?.averageCostUsd, (0.14 + 0.18) / 2);
});

test("benchmark detail helpers rank lower-is-better raw counts by highest friction", () => {
  const taskRows: import("../packages/bench-ui/src/bench-data.js").TaskDeltaRow[] = [
    { taskId: "setup-1", baseline: null, candidate: 1, delta: null, question: "Q1", latencyMs: 10 },
    { taskId: "setup-4", baseline: null, candidate: 4, delta: null, question: "Q4", latencyMs: 10 },
    { taskId: "setup-8", baseline: null, candidate: 8, delta: null, question: "Q8", latencyMs: 10 },
    { taskId: "setup-0", baseline: null, candidate: 0, delta: null, question: "Q0", latencyMs: 10 },
  ];

  const frictionTasks = selectLowestScoringTasks(taskRows, "setup_friction");
  assert.equal(frictionTasks.length, 3);
  assert.equal(frictionTasks[0]?.taskId, "setup-8");
  assert.equal(frictionTasks[1]?.taskId, "setup-4");
  assert.equal(frictionTasks[2]?.taskId, "setup-1");
  assert.equal(formatMetricValue(taskRows[0]?.candidate ?? null, "setup_friction"), "1");
});
