import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildMemCorrectLeaderboardRow,
  writeLeaderboardArtifactsForResult,
} from "../../../leaderboard-export.js";
import {
  runMemCorrectBenchmark,
  memcorrectDefinition,
} from "./runner.js";
import { PromptOnlyBaselineAdapter } from "./adapters.js";
import type { BenchmarkResult, ResolvedRunBenchmarkOptions } from "../../../types.js";

function options(
  overrides: Partial<ResolvedRunBenchmarkOptions> = {},
): ResolvedRunBenchmarkOptions {
  return {
    mode: "quick",
    benchmark: memcorrectDefinition,
    system: {
      describe: () => "fake",
      store: async () => undefined,
      query: async () => "",
      recall: async () => "",
      search: async () => [],
      reset: async () => undefined,
      getStats: async () => ({ totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 }),
      destroy: async () => undefined,
    },
    ...overrides,
  } as unknown as ResolvedRunBenchmarkOptions;
}

async function baselineResult(limit: number): Promise<BenchmarkResult> {
  return runMemCorrectBenchmark(
    options({
      benchmarkOptions: { adapter: new PromptOnlyBaselineAdapter() },
      limit,
    }),
  );
}

test("leaderboard: buildMemCorrectLeaderboardRow carries adapter + all 8 metrics", async () => {
  const result = await baselineResult(3);
  const row = buildMemCorrectLeaderboardRow(result);
  assert.ok(row, "row must be built from a memcorrect result");
  assert.equal(row.benchmark, "memcorrect-v1");
  assert.equal(row.adapter, "prompt-only-baseline");
  assert.equal(typeof row.uptake_at_next, "number");
  assert.equal(typeof row.non_resurrection, "number");
  assert.equal(typeof row.false_apply, "number");
  assert.equal(row.dataset_hash, result.meta.datasetHash);
  assert.equal(row.provenance_fidelity, null, "baseline does not surface provenance");
});

test("leaderboard: writeLeaderboardArtifactsForResult emits a memcorrect JSONL", async () => {
  const result = await baselineResult(2);
  const dir = await mkdtemp(path.join(tmpdir(), "memcorrect-lb-"));
  try {
    const writes = await writeLeaderboardArtifactsForResult(result, dir);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].benchmark, "memcorrect-v1");
    assert.equal(writes[0].format, "memcorrect-adapter-metrics-jsonl");
    const content = await readFile(writes[0].path, "utf8");
    const parsed = JSON.parse(content.trim());
    assert.equal(parsed.benchmark, "memcorrect-v1");
    assert.equal(parsed.adapter, "prompt-only-baseline");
    assert.ok("non_resurrection" in parsed);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("leaderboard: non-memcorrect result produces no writes", async () => {
  const other: BenchmarkResult = {
    meta: {
      id: "x",
      benchmark: "retention-aged-dataset",
      benchmarkTier: "remnic",
      version: "1.0.0",
      remnicVersion: "9.3.701",
      gitSha: "deadbeef",
      timestamp: "2026-07-05T00:00:00.000Z",
      mode: "quick",
      runCount: 1,
      seeds: [1],
    },
    config: {
      systemProvider: null,
      judgeProvider: null,
      adapterMode: "synthetic",
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
    environment: { os: "darwin", nodeVersion: process.version },
  };
  const writes = await writeLeaderboardArtifactsForResult(other, tmpdir());
  assert.deepEqual(writes, []);
});
