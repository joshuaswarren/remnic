import assert from "node:assert/strict";
import test from "node:test";

import {
  ingestionEntityRecallDefinition,
  runIngestionEntityRecallBenchmark,
} from "./runner.ts";

test("entity recall fails the task when ingestion reports errors", async () => {
  let getMemoryGraphCalls = 0;

  const result = await runIngestionEntityRecallBenchmark({
    benchmark: ingestionEntityRecallDefinition,
    mode: "quick",
    system: {
      async reset() {},
      async store() {},
      async recall() {
        return "";
      },
      async search() {
        return [];
      },
      async destroy() {},
      async getStats() {
        return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
      },
    },
    ingestionAdapter: {
      async reset() {},
      async destroy() {},
      async ingest() {
        return {
          commandsIssued: [],
          promptsShown: [],
          errors: ["store unavailable"],
          durationMs: 1,
        };
      },
      async getMemoryGraph() {
        getMemoryGraphCalls += 1;
        return {
          entities: [
            { name: "Marcus", type: "person", sourceFile: "Project Beacon.md" },
            { name: "Project Beacon", type: "project", sourceFile: "Project Beacon.md" },
          ],
          links: [],
          pages: [],
        };
      },
    },
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.entity_recall, -1);
  assert.equal(result.results.aggregates.entity_recall?.mean, -1);
  assert.match(task.actual, /ingestion error: store unavailable/);
  assert.deepEqual(task.details?.ingestionErrors, ["store unavailable"]);
  assert.equal(getMemoryGraphCalls, 0);
});
