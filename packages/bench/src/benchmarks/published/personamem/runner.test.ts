import assert from "node:assert/strict";
import test from "node:test";

import { personaMemDefinition, runPersonaMemBenchmark } from "./runner.ts";

test("PersonaMem normalizes tea category nouns when recall supports the phrase", async () => {
  const result = await runPersonaMemBenchmark({
    benchmark: personaMemDefinition,
    mode: "quick",
    limit: 1,
    system: {
      async reset() {},
      async store() {},
      async recall() {
        return "I like to journal every morning with a mug of Earl Grey tea.";
      },
      async search() {
        return [
          {
            turnIndex: 1,
            role: "user",
            snippet: "Earl Grey tea",
            sessionId: "personamem-personamem-smoke-1",
          },
        ];
      },
      async destroy() {},
      async getStats() {
        return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
      },
      responder: {
        async respond() {
          return {
            text: "Earl Grey tea.",
            tokens: { input: 1, output: 1 },
            latencyMs: 1,
            model: "personamem-test-responder",
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
            model: "personamem-test-judge",
          };
        },
      },
    },
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.actual, "Earl Grey");
  assert.equal(task.scores.f1, 1);
  assert.equal(task.details.originalAnsweredText, "Earl Grey tea.");
});
