import assert from "node:assert/strict";
import test from "node:test";

import type { BenchmarkResult, TaskResult } from "../types.js";
import { compareResults } from "./comparison.js";

function task(taskId: string, scores: Record<string, number>): TaskResult {
  return {
    taskId,
    question: taskId,
    expected: "",
    actual: "",
    scores,
    latencyMs: 0,
    tokens: { input: 0, output: 0 },
  };
}

function result(tasks: TaskResult[], mean: number): BenchmarkResult {
  return {
    meta: {
      id: "run",
      benchmark: "comparison-test",
      benchmarkTier: "custom",
      version: "0.0.0",
      remnicVersion: "0.0.0",
      gitSha: "test",
      timestamp: "2026-01-01T00:00:00.000Z",
      mode: "quick",
      runCount: 1,
      seeds: [],
    },
    config: {
      systemProvider: null,
      judgeProvider: null,
      adapterMode: "test",
      remnicConfig: {},
    },
    cost: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      totalLatencyMs: 0,
      meanQueryLatencyMs: 0,
    },
    results: {
      tasks,
      aggregates: {
        accuracy: {
          mean,
          median: mean,
          stdDev: 0,
          min: mean,
          max: mean,
        },
      },
    },
    environment: {
      os: "test",
      nodeVersion: process.version,
    },
  };
}

test("compareResults excludes missing task metric scores from paired statistics", () => {
  const baseline = result(
    [task("a", { accuracy: 1 }), task("b", { accuracy: 1 })],
    1,
  );
  const candidate = result(
    [task("a", { accuracy: 1 }), task("b", {})],
    0.5,
  );

  const comparison = compareResults(baseline, candidate);
  const metric = comparison.metricDeltas.accuracy;

  assert.equal(metric?.candidate, 0.5);
  assert.equal(metric?.baseline, 1);
  assert.equal(metric?.effectSize.cohensD, 0);
  assert.equal(metric?.effectSize.interpretation, "negligible");
  assert.deepEqual(metric?.ciOnDelta, { lower: 0, upper: 0, level: 0.95 });
});
