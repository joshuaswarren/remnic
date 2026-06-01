import assert from "node:assert/strict";
import test from "node:test";

import type { BenchResultSummary, BenchResultSummaryPayload, RunFilters } from "../bench-data";

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

test("reconcileRunFilters clears selected values that disappear from payload options", async () => {
  // @ts-ignore This TS test imports a TSX page module in the root test-typecheck baseline.
  const module = await import("./Runs") as {
    reconcileRunFilters(
      payload: BenchResultSummaryPayload,
      filters: RunFilters,
    ): RunFilters;
  };
  const filters: RunFilters = {
    benchmark: "missing-benchmark",
    systemProvider: "missing-system",
    judgeProvider: "missing-judge",
    mode: "full",
    range: "30d",
  };

  const next = module.reconcileRunFilters(
    {
      resultsDir: "/tmp/results",
      summaries: [
        summary({
          benchmark: "bench-a",
          systemProvider: "system-a",
          judgeProvider: "judge-a",
        }),
      ],
    },
    filters,
  );

  assert.deepEqual(next, {
    benchmark: "all",
    systemProvider: "all",
    judgeProvider: "all",
    mode: "all",
    range: "30d",
  });
});
