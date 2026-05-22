import assert from "node:assert/strict";
import test from "node:test";

import type { BenchResultSummary } from "../bench-data";
import { canCompareBenchRuns, filterComparableCandidateRuns } from "./Compare";

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

test("canCompareBenchRuns rejects comparing a run against itself", () => {
  const run = summary({ id: "same-run", benchmark: "bench-a" });
  const other = summary({ id: "other-run", benchmark: "bench-a" });

  assert.equal(canCompareBenchRuns(run, run), false);
  assert.equal(canCompareBenchRuns(run, other), true);
});

test("filterComparableCandidateRuns excludes the selected baseline", () => {
  const baseline = summary({ id: "baseline", benchmark: "bench-a" });
  const candidate = summary({ id: "candidate", benchmark: "bench-a" });
  const otherBenchmark = summary({ id: "other", benchmark: "bench-b" });

  const filtered = filterComparableCandidateRuns(
    {
      resultsDir: "/tmp/results",
      summaries: [baseline, candidate, otherBenchmark],
    },
    baseline,
  );

  assert.deepEqual(
    filtered.map((run) => run.id),
    ["candidate"],
  );
});
