import assert from "node:assert/strict";
import test from "node:test";

import {
  memoryAgentBenchDefinition,
  runMemoryAgentBenchBenchmark,
} from "./runner.ts";

test("MemoryAgentBench refines EventQA destinations from recalled event evidence", async () => {
  const result = await runMemoryAgentBenchBenchmark({
    benchmark: memoryAgentBenchDefinition,
    mode: "quick",
    limit: 1,
    system: {
      async reset() {},
      async store() {},
      async recall() {
        return [
          "Event log:",
          "1. Maya boarded the blue tram to the museum.",
          "2. She bought a ticket for the modern art exhibit.",
          "3. After lunch, she walked to the riverside market.",
        ].join("\n");
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
            text: "She walked to the riverside market.",
            tokens: { input: 1, output: 1 },
            latencyMs: 1,
            model: "mab-test-responder",
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
            model: "mab-test-judge",
          };
        },
      },
    },
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.actual, "the riverside market");
  assert.equal(task.scores.official_exact_match, 1);
  assert.equal(task.scores.official_f1, 1);
  assert.equal(task.details.originalAnsweredText, "She walked to the riverside market.");
});
