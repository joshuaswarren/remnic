import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildAmaBenchLeaderboardRows,
  serializeJsonl,
  writeLeaderboardArtifactsForResult,
} from "./leaderboard-export.ts";
import type { BenchmarkResult } from "./types.ts";

function amaResult(): BenchmarkResult {
  return {
    meta: {
      id: "run-1",
      benchmark: "ama-bench",
      benchmarkTier: "published",
      version: "2.0.0",
      remnicVersion: "9.3.231",
      gitSha: "abc1234",
      timestamp: "2026-04-28T01:22:39.635Z",
      mode: "full",
      runCount: 1,
      seeds: [20260427],
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
          taskId: "q1",
          question: "What happened first?",
          expected: "opened the app",
          actual: "opened the app",
          scores: { llm_judge: 1 },
          latencyMs: 1,
          tokens: { input: 0, output: 0 },
          details: { episodeId: 101 },
        },
        {
          taskId: "q2",
          question: "What happened second?",
          expected: "changed settings",
          actual: " changed settings ",
          scores: { llm_judge: 1 },
          latencyMs: 1,
          tokens: { input: 0, output: 0 },
          details: { episode_id: 101 },
        },
        {
          taskId: "q3",
          question: "What happened?",
          expected: "unknown",
          actual: "(error: recall failed)",
          scores: { llm_judge: 0 },
          latencyMs: 1,
          tokens: { input: 0, output: 0 },
          details: { episodeId: 102 },
        },
      ],
      aggregates: {},
    },
    environment: { os: "darwin", nodeVersion: "v25.9.0", hardware: "arm64" },
  };
}

test("buildAmaBenchLeaderboardRows groups answers by episode in task order", () => {
  assert.deepEqual(buildAmaBenchLeaderboardRows(amaResult()), [
    {
      episode_id: 101,
      answer_list: ["opened the app", "changed settings"],
    },
    {
      episode_id: 102,
      answer_list: ["unknown"],
    },
  ]);
});

test("buildAmaBenchLeaderboardRows rejects missing episode ids instead of undercounting", () => {
  const result = amaResult();
  result.results.tasks[0]!.details = undefined;

  assert.throws(() => buildAmaBenchLeaderboardRows(result), /requires details\.episodeId/);
});

test("serializeJsonl emits one valid JSON object per line", () => {
  const serialized = serializeJsonl(buildAmaBenchLeaderboardRows(amaResult()));
  const lines = serialized.trimEnd().split("\n");

  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]!), {
    episode_id: 101,
    answer_list: ["opened the app", "changed settings"],
  });
});

test("writeLeaderboardArtifactsForResult writes AMA-Bench answer-list JSONL", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-leaderboard-"));
  try {
    const writes = await writeLeaderboardArtifactsForResult(amaResult(), tempDir);

    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.benchmark, "ama-bench");
    assert.equal(writes[0]?.format, "ama-bench-answer-list-jsonl");
    assert.equal(writes[0]?.records, 2);

    const raw = await readFile(writes[0]?.path, "utf8");
    assert.match(raw, /"episode_id":101/);
    assert.match(raw, /"answer_list":\["opened the app","changed settings"\]/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("writeLeaderboardArtifactsForResult skips unsupported benchmark results", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-leaderboard-"));
  try {
    const result = amaResult();
    result.meta.benchmark = "locomo";
    assert.deepEqual(await writeLeaderboardArtifactsForResult(result, tempDir), []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
