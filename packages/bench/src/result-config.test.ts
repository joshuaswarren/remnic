import assert from "node:assert/strict";
import test from "node:test";

import { finalizeBenchmarkResultConfig } from "./result-config.ts";
import type { BenchmarkResult } from "./types.js";

function buildResult(): BenchmarkResult {
  return {
    meta: {
      id: "result-1",
      benchmark: "assistant-morning-brief",
      benchmarkTier: "remnic",
      version: "1.0.0",
      remnicVersion: "0.0.0-test",
      gitSha: "deadbeef",
      timestamp: "2026-04-19T20:00:00.000Z",
      mode: "quick",
      runCount: 1,
      seeds: [1234],
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
    results: {
      tasks: [],
      aggregates: {},
    },
    environment: {
      os: process.platform,
      nodeVersion: process.version,
    },
  };
}

test("finalizeBenchmarkResultConfig applies runtime profile when missing", () => {
  const result = buildResult();

  const finalized = finalizeBenchmarkResultConfig(result, {
    runtimeProfile: "openclaw-chain",
  });

  assert.equal(finalized.config.runtimeProfile, "openclaw-chain");
});

test("finalizeBenchmarkResultConfig preserves an explicit runtime profile", () => {
  const result = buildResult();
  result.config.runtimeProfile = "real";

  const finalized = finalizeBenchmarkResultConfig(result, {
    runtimeProfile: "baseline",
  });

  assert.equal(finalized.config.runtimeProfile, "real");
});

test("finalizeBenchmarkResultConfig normalizes omitted runtime profile to null", () => {
  const result = buildResult();

  const finalized = finalizeBenchmarkResultConfig(result, {});

  assert.equal(finalized.config.runtimeProfile, null);
});

test("finalizeBenchmarkResultConfig records internal provider when missing", () => {
  const result = buildResult();

  const finalized = finalizeBenchmarkResultConfig(result, {
    internalProvider: {
      provider: "codex-cli",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
    },
  });

  assert.deepEqual(finalized.config.internalProvider, {
    provider: "codex-cli",
    model: "gpt-5.5",
    reasoningEffort: "xhigh",
  });
});
