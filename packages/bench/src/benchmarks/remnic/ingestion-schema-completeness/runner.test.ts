import assert from "node:assert/strict";
import test from "node:test";

import type { TaskResult } from "../../../types.js";
import { createSyntheticEmailIngestionAdapter } from "../../../ingestion-adapters/synthetic-email-adapter.ts";
import {
  ingestionSchemaCompletenessDefinition,
  runIngestionSchemaCompletenessBenchmark,
} from "./runner.ts";

test("schema completeness reports completed task progress", async () => {
  const progress: Array<{
    task: TaskResult;
    completedCount: number;
    totalCount?: number;
  }> = [];

  const result = await runIngestionSchemaCompletenessBenchmark({
    benchmark: ingestionSchemaCompletenessDefinition,
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
      judge: {
        async score() {
          return 1;
        },
      },
    },
    ingestionAdapter: createSyntheticEmailIngestionAdapter(),
    onTaskComplete(task, completedCount, totalCount) {
      progress.push({ task, completedCount, totalCount });
    },
  });

  assert.equal(result.results.tasks.length, 1);
  assert.equal(progress.length, 1);
  assert.equal(progress[0]!.task, result.results.tasks[0]);
  assert.equal(progress[0]!.completedCount, 1);
  assert.equal(progress[0]!.totalCount, 1);
});

test("schema completeness reports ingestion errors as a failed task", async () => {
  const progress: Array<{
    task: TaskResult;
    completedCount: number;
    totalCount?: number;
  }> = [];
  let getMemoryGraphCalled = false;

  const result = await runIngestionSchemaCompletenessBenchmark({
    benchmark: ingestionSchemaCompletenessDefinition,
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
      judge: {
        async score() {
          return 1;
        },
      },
    },
    ingestionAdapter: {
      async reset() {},
      async ingest() {
        return {
          commandsIssued: ["read-input-files", "system.store"],
          promptsShown: ["extract inbox schema"],
          errors: ["store unavailable"],
          durationMs: 12,
        };
      },
      async getMemoryGraph() {
        getMemoryGraphCalled = true;
        return {
          entities: [],
          links: [],
          pages: [],
        };
      },
      async destroy() {},
    },
    onTaskComplete(task, completedCount, totalCount) {
      progress.push({ task, completedCount, totalCount });
    },
  });

  const task = result.results.tasks[0]!;
  assert.equal(getMemoryGraphCalled, false);
  assert.equal(task.scores.schema_completeness, -1);
  assert.equal(task.scores.field_title, undefined);
  assert.match(task.actual, /store unavailable/);
  assert.deepEqual(task.details.ingestionErrors, ["store unavailable"]);
  assert.deepEqual(task.details.commandsIssued, ["read-input-files", "system.store"]);
  assert.deepEqual(task.details.promptsShown, ["extract inbox schema"]);
  assert.equal(result.results.aggregates.schema_completeness?.mean, -1);
  assert.equal(progress.length, 1);
  assert.equal(progress[0]!.task, task);
  assert.equal(progress[0]!.completedCount, 1);
  assert.equal(progress[0]!.totalCount, 1);
});
