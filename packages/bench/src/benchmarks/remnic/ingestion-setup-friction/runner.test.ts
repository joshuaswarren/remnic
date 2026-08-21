import assert from "node:assert/strict";
import test from "node:test";

import {
  ingestionSetupFrictionDefinition,
  runIngestionSetupFrictionBenchmark,
} from "./runner.ts";

test("setup friction reports missing ingestion adapter clearly", async () => {
  await assert.rejects(
    runIngestionSetupFrictionBenchmark({
      benchmark: ingestionSetupFrictionDefinition,
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
    }),
    /ingestionAdapter is required for ingestion benchmarks/,
  );
});

test("setup friction reports task completion progress", async () => {
  const completed: { taskId: string; completedCount: number; totalCount: number | undefined }[] = [];

  const result = await runIngestionSetupFrictionBenchmark({
    benchmark: ingestionSetupFrictionDefinition,
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
      async ingest() {
        return {
          commandsIssued: ["remnic ingest inbox"],
          promptsShown: ["Confirm source"],
          errors: [],
          durationMs: 12,
        };
      },
      async getMemoryGraph() {
        return { entities: [], links: [], pages: [] };
      },
      async destroy() {},
    },
    onTaskComplete(task, completedCount, totalCount) {
      completed.push({ taskId: task.taskId, completedCount, totalCount });
    },
  });

  assert.equal(result.results.tasks.length, 1);
  assert.deepEqual(completed, [
    {
      taskId: result.results.tasks[0]?.taskId,
      completedCount: 1,
      totalCount: 1,
    },
  ]);
});
