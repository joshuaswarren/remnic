import assert from "node:assert/strict";
import test from "node:test";

import { memBenchDefinition, runMemBenchBenchmark } from "./runner.ts";

test("MemBench open-ended official accuracy tolerates terminal answer punctuation", async () => {
  const result = await runMemBenchBenchmark({
    benchmark: memBenchDefinition,
    mode: "quick",
    limit: 1,
    system: {
      async reset() {},
      async store() {},
      async recall() {
        return "I moved to Lisbon last spring to work from the waterfront.";
      },
      async search() {
        return [];
      },
      async destroy() {},
      async getStats() {
        return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
      },
      responder: {
        async respond() {
          return {
            text: "Lisbon.",
            tokens: { input: 1, output: 1 },
            latencyMs: 1,
            model: "membench-test-responder",
          };
        },
      },
      judge: {
        async score() {
          return 1;
        },
        async scoreWithMetrics() {
          return {
            score: 1,
            tokens: { input: 0, output: 0 },
            latencyMs: 0,
            model: "membench-test-judge",
          };
        },
      },
    },
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.actual, "Lisbon.");
  assert.equal(task.scores.membench_accuracy, 1);
  assert.equal(
    result.results.aggregates.membench_accuracy_factual_participant?.mean,
    1,
  );
});
