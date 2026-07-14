import assert from "node:assert/strict";
import test from "node:test";

import { assertCompleteBenchmarkResult, runBenchmark } from "./benchmark.ts";
import type { BenchmarkResult } from "./types.ts";

function result(status?: "complete" | "partial"): BenchmarkResult {
  return {
    meta: {
      id: "run-status-test",
      benchmark: "locomo",
      benchmarkTier: "published",
      version: "1",
      remnicVersion: "1",
      gitSha: "abc",
      timestamp: "2026-07-14T00:00:00.000Z",
      mode: "full",
      runCount: 1,
      seeds: [1],
      ...(status ? { status } : {}),
      ...(status === "partial" ? { failureReason: "trial_execution_failure: provider unavailable" } : {}),
    },
    config: {
      systemProvider: null,
      judgeProvider: null,
      adapterMode: "direct",
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
    results: { tasks: [], aggregates: {} },
    environment: { os: "linux", nodeVersion: process.version },
  };
}

test("assertCompleteBenchmarkResult accepts complete and legacy-complete results", () => {
  assert.doesNotThrow(() => assertCompleteBenchmarkResult(result()));
  assert.doesNotThrow(() => assertCompleteBenchmarkResult(result("complete")));
});

test("assertCompleteBenchmarkResult rejects partial results for CLI failure handling", () => {
  assert.throws(
    () => assertCompleteBenchmarkResult(result("partial")),
    /locomo.*partial result.*provider unavailable/,
  );
});

test("runBenchmark rejects a published-harness provider failure after reporting its task", async () => {
  const completed: string[] = [];
  await assert.rejects(
    () => runBenchmark("longmemeval", {
      mode: "quick",
      system: {
        async store() {},
        async recall() { return "remembered context"; },
        async search() { return []; },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond() {
            throw new Error("provider transport failure");
          },
        },
      },
      onTaskComplete: (task) => completed.push(task.taskId),
    }),
    /longmemeval.*partial result.*provider transport failure/,
  );
  assert.equal(completed.length, 1, "the CLI catch path must receive a non-empty partial prefix");
});
