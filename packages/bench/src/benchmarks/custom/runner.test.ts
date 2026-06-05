import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { runCustomBenchmarkFile } from "./runner.ts";

test("custom benchmark latency includes reported judge latency outside the search timer", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-custom-bench-"));
  const benchmarkPath = path.join(tempDir, "latency.yaml");

  try {
    await writeFile(
      benchmarkPath,
      [
        "name: Custom Latency",
        "scoring: llm_judge",
        "tasks:",
        "  - question: What happened?",
        "    expected: It happened.",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await runCustomBenchmarkFile(benchmarkPath, {
      mode: "quick",
      system: {
        async store() {},
        async recall() {
          return "";
        },
        async search(query) {
          assert.equal(query, "What happened?");
          return [
            {
              turnIndex: 0,
              role: "assistant",
              snippet: "It happened.",
              sessionId: "session-1",
            },
          ];
        },
        async reset() {},
        async getStats() {
          return {
            totalMessages: 0,
            totalSummaryNodes: 0,
            maxDepth: 0,
          };
        },
        async destroy() {},
        judge: {
          async score() {
            return 0.75;
          },
          async scoreWithMetrics(question, predicted, expected) {
            assert.equal(question, "What happened?");
            assert.equal(predicted, "It happened.");
            assert.equal(expected, "It happened.");
            return {
              score: 0.75,
              tokens: { input: 12, output: 4 },
              latencyMs: 50,
              model: "judge-model",
            };
          },
        },
      },
    });

    assert.equal(result.results.tasks.length, 1);
    assert.equal(result.results.tasks[0]?.scores.llm_judge, 0.75);
    assert.equal(result.results.tasks[0]?.tokens.input, 12);
    assert.equal(result.results.tasks[0]?.tokens.output, 4);
    assert.equal(result.results.tasks[0]?.details?.judgeModel, "judge-model");
    assert.ok(
      (result.results.tasks[0]?.latencyMs ?? 0) >= 50,
      `expected task latency to include the reported judge latency, received ${result.results.tasks[0]?.latencyMs}`,
    );
    assert.equal(
      result.cost.totalLatencyMs,
      result.results.tasks[0]?.latencyMs,
    );
    assert.equal(
      result.cost.meanQueryLatencyMs,
      result.results.tasks[0]?.latencyMs,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("custom benchmark latency includes fallback judge wall time", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-custom-bench-"));
  const benchmarkPath = path.join(tempDir, "latency-fallback.yaml");

  try {
    await writeFile(
      benchmarkPath,
      [
        "name: Custom Latency Fallback",
        "scoring: llm_judge",
        "tasks:",
        "  - question: What happened?",
        "    expected: It happened.",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await runCustomBenchmarkFile(benchmarkPath, {
      mode: "quick",
      system: {
        async store() {},
        async recall() {
          return "";
        },
        async search(query) {
          assert.equal(query, "What happened?");
          return [
            {
              turnIndex: 0,
              role: "assistant",
              snippet: "It happened.",
              sessionId: "session-1",
            },
          ];
        },
        async reset() {},
        async getStats() {
          return {
            totalMessages: 0,
            totalSummaryNodes: 0,
            maxDepth: 0,
          };
        },
        async destroy() {},
        judge: {
          async score(question, predicted, expected) {
            assert.equal(question, "What happened?");
            assert.equal(predicted, "It happened.");
            assert.equal(expected, "It happened.");
            await delay(40);
            return 0.75;
          },
        },
      },
    });

    assert.equal(result.results.tasks.length, 1);
    assert.equal(result.results.tasks[0]?.scores.llm_judge, 0.75);
    assert.ok(
      (result.results.tasks[0]?.latencyMs ?? 0) >= 10,
      `expected task latency to include fallback judge wall time, received ${result.results.tasks[0]?.latencyMs}`,
    );
    assert.equal(
      result.cost.totalLatencyMs,
      result.results.tasks[0]?.latencyMs,
    );
    assert.equal(
      result.cost.meanQueryLatencyMs,
      result.results.tasks[0]?.latencyMs,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("custom benchmarks score responder output and include responder usage", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-custom-bench-"));
  const benchmarkPath = path.join(tempDir, "responder.yaml");

  try {
    await writeFile(
      benchmarkPath,
      [
        "name: Custom Responder",
        "scoring: exact_match",
        "tasks:",
        "  - question: What happened?",
        "    expected: The generated answer.",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await runCustomBenchmarkFile(benchmarkPath, {
      mode: "quick",
      runtimeProfile: "openclaw-chain",
      system: {
        async store() {},
        async recall() {
          return "";
        },
        async search(query) {
          assert.equal(query, "What happened?");
          return [
            {
              turnIndex: 0,
              role: "assistant",
              snippet: "The recalled memory.",
              sessionId: "session-1",
            },
          ];
        },
        async reset() {},
        async getStats() {
          return {
            totalMessages: 0,
            totalSummaryNodes: 0,
            maxDepth: 0,
          };
        },
        async destroy() {},
        responder: {
          async respond(question, recalledText) {
            assert.equal(question, "What happened?");
            assert.equal(recalledText, "The recalled memory.");
            return {
              text: "The generated answer.",
              tokens: { input: 9, output: 3 },
              latencyMs: 25,
              model: "responder-model",
            };
          },
        },
      },
    });

    assert.equal(result.results.tasks.length, 1);
    assert.equal(result.results.tasks[0]?.actual, "The generated answer.");
    assert.equal(result.results.tasks[0]?.scores.exact_match, 1);
    assert.equal(result.config.runtimeProfile, "openclaw-chain");
    assert.equal(result.results.tasks[0]?.tokens.input, 9);
    assert.equal(result.results.tasks[0]?.tokens.output, 3);
    assert.equal(result.results.tasks[0]?.details?.recalledText, "The recalled memory.");
    assert.equal(result.results.tasks[0]?.details?.answeredText, "The generated answer.");
    assert.equal(result.results.tasks[0]?.details?.responderModel, "responder-model");
    assert.ok(
      (result.results.tasks[0]?.latencyMs ?? 0) >= 25,
      `expected task latency to include responder latency, received ${result.results.tasks[0]?.latencyMs}`,
    );
    assert.equal(
      result.cost.totalLatencyMs,
      result.results.tasks[0]?.latencyMs,
    );
    assert.equal(
      result.cost.meanQueryLatencyMs,
      result.results.tasks[0]?.latencyMs,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("custom benchmark full mode honors requested iterations", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-custom-bench-"));
  const benchmarkPath = path.join(tempDir, "iterations.yaml");
  const completions: Array<{ completed: number; total: number | undefined }> = [];

  try {
    await writeFile(
      benchmarkPath,
      [
        "name: Custom Iterations",
        "scoring: exact_match",
        "tasks:",
        "  - question: What is alpha?",
        "    expected: alpha",
        "  - question: What is beta?",
        "    expected: beta",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await runCustomBenchmarkFile(benchmarkPath, {
      mode: "full",
      iterations: 2,
      seed: 7,
      system: {
        async store() {},
        async recall() {
          return "";
        },
        async search(query) {
          return [
            {
              turnIndex: 0,
              role: "assistant",
              snippet: query.includes("alpha") ? "alpha" : "beta",
              sessionId: "session-1",
            },
          ];
        },
        async reset() {},
        async getStats() {
          return {
            totalMessages: 0,
            totalSummaryNodes: 0,
            maxDepth: 0,
          };
        },
        async destroy() {},
      },
      onTaskComplete(_task, completedCount, totalCount) {
        completions.push({ completed: completedCount, total: totalCount });
      },
    });

    assert.equal(result.meta.runCount, 2);
    assert.deepEqual(result.meta.seeds, [7, 8]);
    assert.equal(result.results.tasks.length, 4);
    assert.deepEqual(
      result.results.tasks.map((task) => task.question),
      [
        "What is alpha?",
        "What is beta?",
        "What is alpha?",
        "What is beta?",
      ],
    );
    assert.deepEqual(
      result.results.tasks.map((task) => task.details?.runIndex),
      [0, 0, 1, 1],
    );
    assert.deepEqual(
      result.results.tasks.map((task) => task.details?.seed),
      [7, 7, 8, 8],
    );
    assert.deepEqual(completions, [
      { completed: 1, total: 4 },
      { completed: 2, total: 4 },
      { completed: 3, total: 4 },
      { completed: 4, total: 4 },
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
