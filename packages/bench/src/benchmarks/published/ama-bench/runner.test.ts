import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildAmaBenchLeaderboardRows } from "../../../leaderboard-export.ts";
import { amaBenchDefinition, runAmaBenchBenchmark } from "./runner.ts";

test("AMA-Bench normalizes sparse null trajectory fields from the official dataset", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-ama-bench-"));
  const datasetPath = path.join(tempDir, "open_end_qa_set.jsonl");
  const storedMessages: Array<{ role: string; content: string }> = [];

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        episode_id: 1,
        task: "Sparse AMA fixture",
        task_type: "web",
        domain: "WEB",
        success: true,
        num_turns: 2,
        total_tokens: 32,
        trajectory: [
          {
            turn_idx: 0,
            action: null,
            observation: "Observed the profile language.",
          },
          {
            turn_idx: 1,
            action: "Checked notification settings.",
            observation: null,
          },
        ],
        qa_pairs: [
          {
            question: "What language was observed?",
            answer: "Spanish",
            type: "recall",
            question_uuid: "ama-null-q1",
          },
        ],
      }) + "\n",
      "utf8",
    );

    const result = await runAmaBenchBenchmark({
      benchmark: amaBenchDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store(_sessionId, messages) {
          storedMessages.push(...messages);
        },
        async recall() {
          return "Spanish";
        },
        async search() {
          return [];
        },
        async reset() {},
        async getStats() {
          return {
            totalMessages: 4,
            totalSummaryNodes: 0,
            maxDepth: 0,
          };
        },
        async destroy() {},
        judge: {
          async score() {
            return 1;
          },
          async scoreWithMetrics() {
            return {
              score: 1,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    assert.equal(result.results.tasks.length, 1);
    assert.equal(storedMessages.length, 4);
    assert.equal(storedMessages[0]?.content, "[Action 0]: ");
    assert.equal(storedMessages[1]?.content, "[Observation 0]: Observed the profile language.");
    assert.equal(storedMessages[2]?.content, "[Action 1]: Checked notification settings.");
    assert.equal(storedMessages[3]?.content, "[Observation 1]: ");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("AMA-Bench fails fast when trajectory drain fails before scoring", async () => {
  let completedTasks = 0;
  let recallCalls = 0;

  await assert.rejects(
    () =>
      runAmaBenchBenchmark({
        benchmark: amaBenchDefinition,
        mode: "quick",
        onTaskComplete() {
          completedTasks += 1;
        },
        system: {
          async store() {},
          async recall() {
            recallCalls += 1;
            return "Spanish";
          },
          async search() {
            return [];
          },
          async reset() {},
          async getStats() {
            return {
              totalMessages: 4,
              totalSummaryNodes: 0,
              maxDepth: 0,
            };
          },
          async drain() {
            throw new Error("drain timed out");
          },
          async destroy() {},
        },
      }),
    /AMA-Bench drain failed for episode 1: drain timed out/,
  );

  assert.equal(recallCalls, 0);
  assert.equal(completedTasks, 0);
});

test("AMA-Bench records recommended and cross-judge protocol metrics", async () => {
  const result = await runAmaBenchBenchmark({
    benchmark: amaBenchDefinition,
    mode: "quick",
    amaBenchJudgeProtocol: "recommended",
    amaBenchCrossJudgeProvider: {
      provider: "ollama",
      model: "qwen3:32b",
    },
    amaBenchCrossJudge: {
      async score() {
        return 0;
      },
      async scoreWithMetrics() {
        return {
          score: 0,
          tokens: { input: 1, output: 1 },
          latencyMs: 2,
          model: "cross-qwen3-32b",
        };
      },
    },
    system: {
      async store() {},
      async recall() {
        return "## Explicit Cue Evidence\nSpanish\n## Embedded user note\n\n## Remnic recall pipeline\nSpanish";
      },
      async search() {
        return [];
      },
      async reset() {},
      async getStats() {
        return {
          totalMessages: 4,
          totalSummaryNodes: 0,
          maxDepth: 0,
        };
      },
      async destroy() {},
      judge: {
        async score() {
          return 1;
        },
        async scoreWithMetrics() {
          return {
            score: 1,
            tokens: { input: 1, output: 1 },
            latencyMs: 2,
            model: "primary-qwen3-32b",
          };
        },
      },
    },
  });

  const first = result.results.tasks[0]!;
  assert.equal(first.scores.ama_bench_recommended_accuracy, 1);
  assert.equal(first.scores.ama_bench_cross_accuracy, 0);
  assert.equal(first.scores.ama_bench_cross_agreement, 0);
  assert.equal(first.latencyMs >= 4, true);
  assert.equal(first.tokens.input >= 2, true);
  assert.equal(first.tokens.output >= 2, true);
  assert.equal(first.details?.amaBenchJudgeProtocol, "recommended");
  assert.equal(first.details?.amaBenchCrossJudgeModel, "cross-qwen3-32b");
  assert.deepEqual(first.details?.recallSections, [
    "Explicit Cue Evidence",
    "Remnic recall pipeline",
  ]);
  assert.equal(
    result.config.benchmarkOptions?.amaBenchJudgeProtocol,
    "recommended",
  );
  assert.deepEqual(result.config.benchmarkOptions?.amaBenchCrossJudgeProvider, {
    provider: "ollama",
    model: "qwen3:32b",
  });
});

test("AMA-Bench failed tasks retain episode metadata for leaderboard export", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-ama-bench-"));
  const datasetPath = path.join(tempDir, "open_end_qa_set.jsonl");

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        episode_id: 77,
        task: "Failing AMA fixture",
        task_type: "web",
        domain: "WEB",
        success: true,
        num_turns: 1,
        total_tokens: 12,
        trajectory: [
          {
            turn_idx: 0,
            action: "Open the settings page.",
            observation: "Settings opened.",
          },
        ],
        qa_pairs: [
          {
            question: "What page opened?",
            answer: "settings",
            type: "recall",
            question_uuid: "ama-fail-q1",
          },
        ],
      }) + "\n",
      "utf8",
    );

    const result = await runAmaBenchBenchmark({
      benchmark: amaBenchDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          throw new Error("recall unavailable");
        },
        async search() {
          return [];
        },
        async reset() {},
        async getStats() {
          return {
            totalMessages: 2,
            totalSummaryNodes: 0,
            maxDepth: 0,
          };
        },
        async destroy() {},
        judge: {
          async score() {
            return 0;
          },
          async scoreWithMetrics() {
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    assert.equal(result.results.tasks[0]?.details?.episodeId, 77);
    assert.deepEqual(buildAmaBenchLeaderboardRows(result), [
      {
        episode_id: 77,
        answer_list: ["unknown"],
      },
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("AMA-Bench omits cross-judge agreement for scalar primary protocol", async () => {
  const result = await runAmaBenchBenchmark({
    benchmark: amaBenchDefinition,
    mode: "quick",
    amaBenchJudgeProtocol: "default",
    amaBenchCrossJudge: {
      async score() {
        return 1;
      },
      async scoreWithMetrics() {
        return {
          score: 1,
          tokens: { input: 1, output: 1 },
          latencyMs: 2,
          model: "cross-qwen3-32b",
        };
      },
    },
    system: {
      async store() {},
      async recall() {
        return "Spanish";
      },
      async search() {
        return [];
      },
      async reset() {},
      async getStats() {
        return {
          totalMessages: 4,
          totalSummaryNodes: 0,
          maxDepth: 0,
        };
      },
      async destroy() {},
      judge: {
        async score() {
          return 0.7;
        },
        async scoreWithMetrics() {
          return {
            score: 0.7,
            tokens: { input: 1, output: 1 },
            latencyMs: 2,
            model: "primary-scalar",
          };
        },
      },
    },
  });

  const first = result.results.tasks[0]!;
  assert.equal(first.scores.ama_bench_cross_accuracy, 1);
  assert.equal("ama_bench_cross_agreement" in first.scores, false);
});
