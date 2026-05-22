import assert from "node:assert/strict";
import test from "node:test";

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { BenchResultSummary } from "../bench-data";
import { AssistantSpotCheckViewer } from "./AssistantSpotCheckViewer";

function summary(overrides: Partial<BenchResultSummary> = {}): BenchResultSummary {
  return {
    id: "run-1",
    benchmark: "assistant-quality",
    benchmarkTier: "remnic",
    timestamp: "2026-05-21T00:00:00.000Z",
    mode: "quick",
    totalLatencyMs: 0,
    meanQueryLatencyMs: 0,
    taskCount: 0,
    metricHighlights: [],
    primaryMetric: null,
    primaryScore: null,
    runCount: 1,
    estimatedCostUsd: null,
    totalTokens: null,
    inputTokens: null,
    outputTokens: null,
    systemProvider: "openai/gpt",
    judgeProvider: "openai/judge",
    providerKey: "openai/gpt",
    adapterMode: "direct",
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
    filePath: "benchmarks/results/run-1.json",
    ...overrides,
  };
}

test("AssistantSpotCheckViewer prompts for a selected run when summary is null", () => {
  const markup = renderToStaticMarkup(<AssistantSpotCheckViewer summary={null} />);

  assert.match(markup, /Select an Assistant benchmark run/);
});

test("AssistantSpotCheckViewer shows the empty state and run-id fallback path", () => {
  const markup = renderToStaticMarkup(
    <AssistantSpotCheckViewer
      summary={summary({
        assistantRunId: null,
        taskSummaries: [
          {
            taskId: "task-without-details",
            question: "",
            expected: "",
            actual: "",
            latencyMs: null,
            totalTokens: 0,
            primaryScore: null,
            scoreEntries: [],
          },
        ],
      })}
    />,
  );

  assert.match(markup, /no per-seed judge decisions available/);
  assert.match(markup, /benchmarks\/results\/spot-checks\/&lt;run-id&gt;\.jsonl/);
});

test("AssistantSpotCheckViewer renders per-seed scores and fallbacks", () => {
  const markup = renderToStaticMarkup(
    <AssistantSpotCheckViewer
      summary={summary({
        assistantRunId: "assistant-run-42",
        taskSummaries: [
          {
            taskId: "scenario-a",
            question: "",
            expected: "",
            actual: "",
            latencyMs: null,
            totalTokens: 0,
            primaryScore: null,
            scoreEntries: [],
            assistantDetails: {
              focus: "billing tone",
              rubricId: "rubric-v1",
              rubricSha256: "abc",
              judgeParseFailures: 1,
              perSeedScores: [
                {
                  seed: 7,
                  identityAccuracy: 0.8123,
                  stanceCoherence: null,
                  novelty: 0.5,
                  calibration: 1,
                  parseOk: false,
                  notes: "",
                  latencyMs: 12,
                },
              ],
            },
          },
        ],
      })}
    />,
  );

  assert.match(markup, /scenario-a/);
  assert.match(markup, /\(billing tone\)/);
  assert.match(markup, />7</);
  assert.match(markup, /0\.81/);
  assert.match(markup, /\u2014/);
  assert.match(markup, /0\.50/);
  assert.match(markup, /1\.00/);
  assert.match(markup, />no</);
  assert.match(markup, /benchmarks\/results\/spot-checks\/assistant-run-42\.jsonl/);
});
