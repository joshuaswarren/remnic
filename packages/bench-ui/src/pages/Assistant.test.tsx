import assert from "node:assert/strict";
import test from "node:test";

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { BenchResultSummary, BenchResultSummaryPayload } from "../bench-data";
import { ASSISTANT_BENCHMARK_IDS } from "../bench-data";
import { Assistant, resolveAssistantUiSelection } from "./Assistant";

function makeRun(
  id: string,
  benchmark: string,
  timestamp: string,
  overrides: Partial<BenchResultSummary> = {},
): BenchResultSummary {
  return {
    id,
    benchmark,
    benchmarkTier: "remnic",
    timestamp,
    mode: "quick",
    totalLatencyMs: 0,
    meanQueryLatencyMs: 0,
    taskCount: 1,
    metricHighlights: [],
    primaryMetric: "overall",
    primaryScore: 0.75,
    runCount: 1,
    estimatedCostUsd: null,
    totalTokens: null,
    inputTokens: null,
    outputTokens: null,
    systemProvider: "openai/gpt",
    judgeProvider: "openai/judge",
    providerKey: "openai/gpt",
    adapterMode: "direct",
    aggregateMetrics: [
      { name: "identity_accuracy", mean: 0.8, median: 0.8, stdDev: 0, min: 0.8, max: 0.8, ciLower: 0.7, ciUpper: 0.9, ciLevel: 0.95, effectSize: null, effectInterpretation: null },
    ],
    taskSummaries: [
      {
        taskId: `${id}-task`,
        question: "",
        expected: "",
        actual: "",
        latencyMs: null,
        totalTokens: 0,
        primaryScore: null,
        scoreEntries: [],
        assistantDetails: {
          focus: "operator context",
          rubricId: "rubric-v1",
          rubricSha256: "abcdef",
          judgeParseFailures: 0,
          perSeedScores: [
            {
              seed: 1,
              identityAccuracy: 0.9,
              stanceCoherence: 0.8,
              novelty: 0.7,
              calibration: 0.6,
              parseOk: true,
              notes: "looks right",
              latencyMs: 1,
            },
          ],
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
    assistantRubricId: "rubric-v1",
    assistantRubricSha256: "1234567890abcdef",
    assistantRunId: id,
    filePath: `benchmarks/results/${id}.json`,
    ...overrides,
  };
}

function payload(summaries: BenchResultSummary[]): BenchResultSummaryPayload {
  return {
    resultsDir: "benchmarks/results",
    summaries,
  };
}

test("resolveAssistantUiSelection defaults to latest, honors selected run, and resets on benchmark switch", () => {
  const firstBenchmark = ASSISTANT_BENCHMARK_IDS[0];
  const secondBenchmark = ASSISTANT_BENCHMARK_IDS[1];
  const data = payload([
    makeRun("morning-old", firstBenchmark, "2026-05-20T00:00:00.000Z"),
    makeRun("morning-new", firstBenchmark, "2026-05-21T00:00:00.000Z"),
    makeRun("meeting-new", secondBenchmark, "2026-05-22T00:00:00.000Z"),
  ]);

  assert.equal(resolveAssistantUiSelection(data, firstBenchmark, null).selectedRun?.id, "morning-new");
  assert.equal(resolveAssistantUiSelection(data, firstBenchmark, "morning-old").selectedRun?.id, "morning-old");
  assert.equal(resolveAssistantUiSelection(data, secondBenchmark, null).selectedRun?.id, "meeting-new");
  assert.equal(resolveAssistantUiSelection(payload([]), firstBenchmark, null).selectedRun, null);
});

test("Assistant renders the latest first-benchmark run by default", () => {
  const firstBenchmark = ASSISTANT_BENCHMARK_IDS[0];
  const data = payload([
    makeRun("morning-old", firstBenchmark, "2026-05-20T00:00:00.000Z"),
    makeRun("morning-new", firstBenchmark, "2026-05-21T00:00:00.000Z"),
  ]);
  const markup = renderToStaticMarkup(<Assistant payload={data} />);

  assert.match(markup, /1234567890ab/);
  assert.match(markup, /morning-new-task/);
  assert.match(markup, /benchmarks\/results\/spot-checks\/morning-new\.jsonl/);
});

test("Assistant empty state disables run selection and passes null to child viewers", () => {
  const markup = renderToStaticMarkup(<Assistant payload={payload([])} />);

  assert.match(markup, /<select[^>]+disabled=""/);
  assert.match(markup, /No runs available/);
  assert.match(markup, /Select an Assistant benchmark run/);
});
