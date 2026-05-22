import assert from "node:assert/strict";
import test from "node:test";

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import type { BenchResultSummary, BenchResultSummaryPayload } from "../bench-data";
import { Ingestion } from "./Ingestion";

function makeRun(
  id: string,
  timestamp: string,
  primaryScore: number,
): BenchResultSummary {
  return {
    id,
    benchmark: "ingestion-setup-friction",
    benchmarkTier: "remnic",
    timestamp,
    mode: "quick",
    totalLatencyMs: 0,
    meanQueryLatencyMs: 0,
    taskCount: 1,
    metricHighlights: [],
    primaryMetric: "setup_friction",
    primaryScore,
    runCount: 1,
    estimatedCostUsd: null,
    totalTokens: null,
    inputTokens: null,
    outputTokens: null,
    systemProvider: "system",
    judgeProvider: "judge",
    providerKey: "system::judge",
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
    filePath: `benchmarks/results/${id}.json`,
  };
}

test("Ingestion marks higher setup friction deltas as regressions", () => {
  const payload: BenchResultSummaryPayload = {
    resultsDir: "benchmarks/results",
    summaries: [
      makeRun("old", "2026-05-20T00:00:00.000Z", 2),
      makeRun("new", "2026-05-21T00:00:00.000Z", 4),
    ],
  };

  const markup = renderToStaticMarkup(
    <MemoryRouter>
      <Ingestion payload={payload} />
    </MemoryRouter>,
  );

  assert.match(markup, /delta-pill delta-pill--negative/);
  assert.doesNotMatch(markup, /delta-pill delta-pill--positive/);
  assert.match(markup, /\+2/);
});
