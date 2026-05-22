import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadBenchmarkResult } from "./results-store.js";
import type { BenchmarkResult } from "./types.js";

test("loadBenchmarkResult rejects files missing required BenchmarkResult meta fields", async () => {
  await withResultFile(
    {
      ...validResult(),
      meta: {
        id: "run-minimal",
        benchmark: "sample",
        timestamp: "2026-05-21T00:00:00.000Z",
        mode: "quick",
      },
    },
    async (filePath) => {
      await assert.rejects(
        () => loadBenchmarkResult(filePath),
        /Invalid benchmark result file/,
      );
    },
  );
});

test("loadBenchmarkResult rejects files missing required cost fields", async () => {
  const result = validResult() as Record<string, unknown>;
  result.cost = {
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    totalLatencyMs: 0,
    meanQueryLatencyMs: 0,
  };

  await withResultFile(result, async (filePath) => {
    await assert.rejects(
      () => loadBenchmarkResult(filePath),
      /Invalid benchmark result file/,
    );
  });
});

test("loadBenchmarkResult accepts a complete BenchmarkResult payload", async () => {
  await withResultFile(validResult(), async (filePath) => {
    const loaded = await loadBenchmarkResult(filePath);
    assert.equal(loaded.meta.id, "run-valid");
    assert.equal(loaded.cost.totalTokens, 0);
  });
});

async function withResultFile(
  payload: unknown,
  callback: (filePath: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-bench-result-store-"));
  try {
    const filePath = path.join(dir, "result.json");
    await writeFile(filePath, `${JSON.stringify(payload)}\n`);
    await callback(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function validResult(): BenchmarkResult {
  return {
    meta: {
      id: "run-valid",
      benchmark: "sample",
      benchmarkTier: "remnic",
      version: "1.0.0",
      remnicVersion: "1.1.12",
      gitSha: "abc123",
      timestamp: "2026-05-21T00:00:00.000Z",
      mode: "quick",
      runCount: 1,
      seeds: [0],
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
      tasks: [
        {
          taskId: "task-1",
          question: "question",
          expected: "expected",
          actual: "actual",
          scores: { exact_match: 1 },
          latencyMs: 0,
          tokens: { input: 0, output: 0 },
        },
      ],
      aggregates: {},
    },
    environment: {
      os: "darwin",
      nodeVersion: "v24.0.0",
      hardware: "arm64",
    },
  };
}
