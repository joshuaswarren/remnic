import * as React from "react";
import assert from "node:assert/strict";
import test from "node:test";

import type { BenchResultSummary, BenchResultSummaryPayload, RunFilters } from "../bench-data";
import { reconcileRunFilters } from "./Runs";

function summary(overrides: Partial<BenchResultSummary>): BenchResultSummary {
  return {
    id: "run",
    benchmark: "alpha",
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

function payload(summaries: BenchResultSummary[]): BenchResultSummaryPayload {
  return { resultsDir: "/tmp/results", summaries };
}

test("reconcileRunFilters resets dynamic filter values missing after payload refresh", () => {
  const filters: RunFilters = {
    benchmark: "alpha",
    systemProvider: "system-a",
    judgeProvider: "judge-a",
    mode: "full",
    range: "30d",
  };

  assert.deepEqual(
    reconcileRunFilters(
      payload([
        summary({
          benchmark: "beta",
          systemProvider: "system-b",
          judgeProvider: "judge-b",
        }),
      ]),
      filters,
    ),
    {
      benchmark: "all",
      systemProvider: "all",
      judgeProvider: "all",
      mode: "full",
      range: "30d",
    },
  );
});
