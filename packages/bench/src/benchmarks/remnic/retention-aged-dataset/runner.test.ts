import test from "node:test";
import assert from "node:assert/strict";
import {
  runRetentionAgedDatasetBenchmark,
  retentionAgedDatasetDefinition,
} from "./runner.js";
import { generateAgedDataset } from "./fixture.js";
import type { ResolvedRunBenchmarkOptions } from "../../../types.js";

function options(overrides: Partial<ResolvedRunBenchmarkOptions> = {}): ResolvedRunBenchmarkOptions {
  return {
    mode: "quick",
    benchmark: retentionAgedDatasetDefinition,
    system: { describe: () => "noop", store: async () => undefined, query: async () => "" },
    ...overrides,
  } as ResolvedRunBenchmarkOptions;
}

test("aged-dataset fixture is deterministic given a seed", () => {
  const a = generateAgedDataset({
    size: 50,
    horizonDays: 365,
    topicCount: 4,
    paretoAlpha: 1.16,
    ageSkew: 1.5,
    seed: 12345,
    nowIso: "2026-04-25T12:00:00.000Z",
  });
  const b = generateAgedDataset({
    size: 50,
    horizonDays: 365,
    topicCount: 4,
    paretoAlpha: 1.16,
    ageSkew: 1.5,
    seed: 12345,
    nowIso: "2026-04-25T12:00:00.000Z",
  });
  assert.equal(a.memories.length, b.memories.length);
  assert.equal(a.queries.length, b.queries.length);
  for (let i = 0; i < a.memories.length; i += 1) {
    assert.equal(a.memories[i].frontmatter.id, b.memories[i].frontmatter.id);
    assert.equal(
      a.memories[i].frontmatter.created,
      b.memories[i].frontmatter.created,
    );
    assert.equal(
      a.memories[i].frontmatter.accessCount,
      b.memories[i].frontmatter.accessCount,
    );
  }
});

test("aged-dataset bench runs in quick mode and emits expected metrics", async () => {
  const result = await runRetentionAgedDatasetBenchmark(options());
  assert.ok(result.results.tasks.length > 0, "must emit at least one task");
  for (const task of result.results.tasks) {
    assert.ok("recall_at_5_full" in task.scores);
    assert.ok("recall_at_5_hot_only" in task.scores);
    assert.ok("recall_at_5_delta" in task.scores);
    assert.ok("hot_share" in task.scores);
    assert.ok("cold_share" in task.scores);
    // recall@K is in [0, 1].
    assert.ok(task.scores.recall_at_5_full >= 0 && task.scores.recall_at_5_full <= 1);
    assert.ok(task.scores.recall_at_5_hot_only >= 0 && task.scores.recall_at_5_hot_only <= 1);
    // hot_share + cold_share should sum to 1 (within float epsilon).
    const sum = task.scores.hot_share + task.scores.cold_share;
    assert.ok(Math.abs(sum - 1) < 1e-9, `hot+cold share must sum to 1, got ${sum}`);
  }
  assert.ok(
    typeof result.cost.meanQueryLatencyMs === "number",
    "meanQueryLatencyMs must be a number",
  );
});

test("aged-dataset bench reports plausible hot/cold split for default policy", async () => {
  const result = await runRetentionAgedDatasetBenchmark(options());
  // The default policy demotes memories ≥14d old with value ≤ 0.35. With
  // ageSkew=1.5 and a 365d horizon, a meaningful fraction of memories
  // should land in the cold tier — but not all of them (recently-created
  // and high-value memories must stay hot). Use loose bounds so this
  // doesn't false-fail when defaults change in PR 3.
  const firstTask = result.results.tasks[0];
  assert.ok(firstTask, "expected at least one task");
  const coldShare = firstTask.scores.cold_share;
  assert.ok(
    coldShare > 0,
    `default policy must demote some memories at 1y horizon; cold_share=${coldShare}`,
  );
  assert.ok(
    coldShare < 1,
    `default policy must keep some memories hot; cold_share=${coldShare}`,
  );
});

test("aged-dataset bench applies options.limit to fixture queries", async () => {
  const unlimited = await runRetentionAgedDatasetBenchmark(options());
  const limited = await runRetentionAgedDatasetBenchmark(options({ limit: 1 }));
  assert.ok(unlimited.results.tasks.length >= 2);
  assert.equal(limited.results.tasks.length, 1);
});

test("aged-dataset bench reports task completion callbacks", async () => {
  const calls: Array<{ taskId: string; completed: number; total: number }> = [];
  const result = await runRetentionAgedDatasetBenchmark(options({
    limit: 2,
    onTaskComplete(task, completedCount, totalCount) {
      calls.push({ taskId: task.taskId, completed: completedCount, total: totalCount });
    },
  }));

  assert.equal(result.results.tasks.length, 2);
  assert.deepEqual(
    calls.map((call) => [call.taskId, call.completed, call.total]),
    result.results.tasks.map((task, index) => [task.taskId, index + 1, 2]),
  );
});

test("aged-dataset bench threads options.seed into the generator", async () => {
  const a = await runRetentionAgedDatasetBenchmark(options({ seed: 1234 }));
  const b = await runRetentionAgedDatasetBenchmark(options({ seed: 5678 }));
  // Different seed → different fixture → different first-task topFull.
  const aTopFull = JSON.parse(a.results.tasks[0].actual).topFull;
  const bTopFull = JSON.parse(b.results.tasks[0].actual).topFull;
  assert.notDeepEqual(
    aTopFull,
    bTopFull,
    "different seeds must produce different fixtures",
  );
  // And meta.seeds must reflect the seed actually used (not the
  // hardcoded baseOptions seed).
  assert.deepEqual(a.meta.seeds, [1234]);
  assert.deepEqual(b.meta.seeds, [5678]);
});

test("aged-dataset fixture rejects seeds the PRNG would truncate", () => {
  const baseOptions = {
    size: 10,
    horizonDays: 365,
    topicCount: 4,
    paretoAlpha: 1.16,
    ageSkew: 1.5,
    nowIso: "2026-04-25T12:00:00.000Z",
  };

  for (const seed of [-1, 1.5, Number.NaN, 0x1_0000_0000]) {
    assert.throws(
      () => generateAgedDataset({ ...baseOptions, seed }),
      /seed must be an integer in \[0, 4294967295\]/,
    );
  }
});

test("aged-dataset bench rejects invalid run seeds before reporting metadata", async () => {
  await assert.rejects(
    () => runRetentionAgedDatasetBenchmark(options({ seed: 1.5 })),
    /seed must be an integer in \[0, 4294967295\]/,
  );
});

test("aged-dataset bench produces non-empty aggregates", async () => {
  const result = await runRetentionAgedDatasetBenchmark(options());
  // Aggregate keys should include the per-task score names. If we used
  // buildTieredAggregates without setting details.tier, this object
  // would be empty.
  const keys = Object.keys(result.results.aggregates);
  assert.ok(
    keys.includes("recall_at_5_full"),
    `aggregates must include recall_at_5_full, got: ${keys.join(",")}`,
  );
  assert.ok(
    keys.includes("recall_at_5_hot_only"),
    `aggregates must include recall_at_5_hot_only, got: ${keys.join(",")}`,
  );
});

test("aged-dataset bench emits unique taskId per task", async () => {
  const result = await runRetentionAgedDatasetBenchmark(options());
  const taskIds = result.results.tasks.map((t) => t.taskId);
  const unique = new Set(taskIds);
  assert.equal(
    taskIds.length,
    unique.size,
    `taskIds must be unique; found ${taskIds.length - unique.size} duplicates among ${taskIds.length} tasks`,
  );
});

test("aged-dataset Pareto sampler produces a long-tail distribution (no clamping artifact)", () => {
  const fixture = generateAgedDataset({
    size: 4000,
    horizonDays: 365,
    topicCount: 16,
    paretoAlpha: 1.16,
    ageSkew: 1.5,
    seed: 0xa686,
    nowIso: "2026-04-25T12:00:00.000Z",
  });
  // Per-topic memory counts come from the memory frontmatter tags
  // (the first tag is the topic keyword).
  const TOPIC_KEYWORDS = [
    "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta",
    "iota", "kappa", "lambda", "mu", "nu", "xi", "omicron", "pi",
  ];
  const memoriesByTopic: number[] = new Array(16).fill(0);
  for (const m of fixture.memories) {
    const tag = m.frontmatter.tags?.[0] ?? "";
    const idx = TOPIC_KEYWORDS.indexOf(tag);
    if (idx >= 0) memoriesByTopic[idx] += 1;
  }
  // Topic 0 (highest-frequency) must have more memories than topic 15
  // (lowest). The previous clamped Pareto would have made topic 15 a
  // second hotspot rivaling topic 0.
  assert.ok(
    memoriesByTopic[0] > memoriesByTopic[15],
    `topic 0 must dominate over topic 15: topic0=${memoriesByTopic[0]} topic15=${memoriesByTopic[15]}`,
  );
  // And the last rank must not be a second hotspot.
  assert.ok(
    memoriesByTopic[15] <= memoriesByTopic[0] / 2,
    `last-rank topic must not be a second hotspot: topic0=${memoriesByTopic[0]} topic15=${memoriesByTopic[15]}`,
  );

  // Query-count distribution must also reflect the Pareto skew (P1 fix):
  // topic 0 should drive proportionally more queries than topic 15.
  const queriesByTopic: number[] = new Array(16).fill(0);
  for (const q of fixture.queries) {
    queriesByTopic[q.topicId] += 1;
  }
  assert.ok(
    queriesByTopic[0] > queriesByTopic[15],
    `query workload must Pareto-weight topic 0 above topic 15: topic0=${queriesByTopic[0]} topic15=${queriesByTopic[15]}`,
  );
});

test("aged-dataset bench enforces MAX_TOTAL_QUERIES cap", async () => {
  // The fixture must trim to MAX_TOTAL_QUERIES=200 even when rounding
  // would otherwise push the total over. (Codex P2 review on PR #698.)
  const fixture = generateAgedDataset({
    size: 4000,
    horizonDays: 365,
    topicCount: 32,
    paretoAlpha: 1.16,
    ageSkew: 1.5,
    seed: 0xa686,
    nowIso: "2026-04-25T12:00:00.000Z",
  });
  assert.ok(
    fixture.queries.length <= 200,
    `MAX_TOTAL_QUERIES cap must be honored; got ${fixture.queries.length} queries`,
  );
});
