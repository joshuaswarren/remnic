import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  runBenchmark,
  type AssistantAgent,
  type BenchMemoryAdapter,
  type Message,
  type SearchResult,
  type StructuredJudge,
  type ConfidenceInterval,
} from "../packages/bench/src/index.js";

class NoopMemoryAdapter implements BenchMemoryAdapter {
  async store(_sessionId: string, _messages: Message[]): Promise<void> {}
  async recall(
    _sessionId: string,
    _query: string,
    _budgetChars?: number,
  ): Promise<string> {
    return "";
  }
  async search(
    _query: string,
    _limit: number,
    _sessionId?: string,
  ): Promise<SearchResult[]> {
    return [];
  }
  async reset(_sessionId?: string): Promise<void> {}
  async getStats() {
    return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
  }
  async destroy(): Promise<void> {}
}

function createScriptedJudge(scoreByTask: Record<string, number>): StructuredJudge {
  return {
    async evaluate({ taskId }) {
      // Scripted judge returns a constant JSON shape — one score per
      // dimension. Some tasks get a lower score to exercise variance.
      const baseline = scoreByTask[normalizeTaskId(taskId)] ?? 4;
      return JSON.stringify({
        identity_accuracy: baseline,
        stance_coherence: Math.max(0, baseline - 1),
        novelty: baseline,
        calibration: Math.min(5, baseline + 1),
        notes: `scripted:${taskId}`,
      });
    },
  };
}

function normalizeTaskId(taskId: string): string {
  const hash = taskId.indexOf("#");
  return hash >= 0 ? taskId.slice(0, hash) : taskId;
}

const scriptedAgent: AssistantAgent = {
  async respond({ scenarioId }) {
    return `[scripted] ${scenarioId}: synthesized assistant answer.`;
  },
};

const assistantBenchmarks = [
  "assistant-morning-brief",
  "assistant-meeting-prep",
  "assistant-next-best-action",
  "assistant-synthesis",
] as const;

for (const benchmarkId of assistantBenchmarks) {
  test(`runBenchmark executes ${benchmarkId} in quick mode with scripted judge`, async () => {
    const system = new NoopMemoryAdapter();
    const spotCheckDir = mkdtempSync(
      path.join(tmpdir(), `remnic-${benchmarkId}-`),
    );
    const judge = createScriptedJudge({
      "morning-brief.monday-priorities": 5,
      "morning-brief.stale-content-guard": 4,
      "meeting-prep.aurora-sync": 5,
      "meeting-prep.skip-level-intro": 3,
      "nba.what-next": 4,
      "nba.abstain-when-weak": 5,
      "synthesis.caching-view": 4,
      "synthesis.stance-disambiguation": 5,
    });

    const result = await runBenchmark(benchmarkId, {
      mode: "quick",
      system,
      remnicConfig: {
        assistantAgent: scriptedAgent,
        assistantJudge: judge,
        assistantSeeds: [1, 2, 3],
        assistantSpotCheckDir: spotCheckDir,
      },
    });

    assert.equal(result.meta.benchmark, benchmarkId);
    assert.equal(result.meta.benchmarkTier, "remnic");
    assert.equal(result.meta.runCount, 3);
    assert.deepEqual(result.meta.seeds, [1, 2, 3]);
    assert.ok(result.results.tasks.length >= 2);

    // Every task should carry all four rubric dimensions plus overall.
    for (const task of result.results.tasks) {
      assert.ok(typeof task.scores.identity_accuracy === "number");
      assert.ok(typeof task.scores.stance_coherence === "number");
      assert.ok(typeof task.scores.novelty === "number");
      assert.ok(typeof task.scores.calibration === "number");
      assert.ok(typeof task.scores.overall === "number");

      const perSeed = (task.details as Record<string, unknown>).perSeedScores;
      assert.ok(Array.isArray(perSeed), "perSeedScores should be an array");
      assert.equal(perSeed.length, 3);

      // Per-seed latencies must sum to the task-level latency so
      // `cost.totalLatencyMs` reflects real runtime across seeds. See
      // codex review P2 on PR #508.
      const perSeedLatencies = perSeed.map(
        (entry) => (entry as { latencyMs: number }).latencyMs,
      );
      const latencySum = perSeedLatencies.reduce(
        (sum, value) => sum + value,
        0,
      );
      assert.equal(
        task.latencyMs,
        latencySum,
        "task.latencyMs should be the sum of per-seed latencies",
      );
    }

    // Statistical block should include CI for each dimension.
    const stats = result.results.statistics;
    assert.ok(stats, "statistics block should be present");
    for (const dimension of [
      "identity_accuracy",
      "stance_coherence",
      "novelty",
      "calibration",
      "overall",
    ]) {
      const ci: ConfidenceInterval | undefined = stats?.confidenceIntervals[dimension];
      assert.ok(ci, `expected CI for dimension ${dimension}`);
      assert.ok(ci.lower <= ci.upper);
      assert.equal(ci.level, 0.95);
    }

    // Rubric provenance must land in remnicConfig for downstream consumers.
    const cfg = result.config.remnicConfig as Record<string, unknown>;
    assert.equal(cfg.assistantRubricId, "assistant-rubric-v1");
    assert.equal(typeof cfg.assistantRubricSha256, "string");
    assert.equal((cfg.assistantRubricSha256 as string).length, 64);
    assert.equal(typeof cfg.assistantRunId, "string");
  });
}

test("assistant runner surfaces parse_error decisions when judge is not wired", async () => {
  const system = new NoopMemoryAdapter();
  const spotCheckDir = mkdtempSync(
    path.join(tmpdir(), "remnic-no-judge-"),
  );

  const result = await runBenchmark("assistant-morning-brief", {
    mode: "quick",
    system,
    remnicConfig: {
      assistantAgent: scriptedAgent,
      assistantSeeds: [10],
      assistantSpotCheckDir: spotCheckDir,
    },
  });

  assert.equal(result.meta.runCount, 1);
  const parseFailures = result.results.tasks.map(
    (task) => (task.details as Record<string, unknown>).judgeParseFailures,
  );
  // Every seed should produce a parse failure when no judge is wired.
  for (const count of parseFailures) {
    assert.equal(count, 1);
  }
  // Scores should all be zero in the absence of a judge.
  for (const task of result.results.tasks) {
    assert.equal(task.scores.identity_accuracy, 0);
    assert.equal(task.scores.overall, 0);
  }
});
