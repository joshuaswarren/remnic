import assert from "node:assert/strict";
import test from "node:test";

import type { TaskResult } from "../../../types.js";
import {
  proceduralRecallDefinition,
  runProceduralRecallBenchmark,
} from "./runner.ts";

test("procedural recall quick mode covers positive and rejection paths and emits progress", async () => {
  const callbacks: Array<{
    task: TaskResult;
    completedCount: number;
    totalCount?: number;
  }> = [];

  const result = await runProceduralRecallBenchmark({
    benchmark: proceduralRecallDefinition,
    mode: "quick",
    system: {} as never,
    onTaskComplete(task, completedCount, totalCount) {
      callbacks.push({ task, completedCount, totalCount });
    },
  });

  const taskIds = result.results.tasks.map((task) => task.taskId);
  assert.deepEqual(taskIds, [
    "intent:deploy-gateway",
    "intent:memory-question",
    "e2e:ranked-deploy",
    "e2e:no-task-init",
    "e2e:disabled-gate",
  ]);
  assert.equal(result.results.tasks.find((task) => task.taskId === "intent:deploy-gateway")?.expected, "true");
  assert.equal(result.results.tasks.find((task) => task.taskId === "intent:memory-question")?.expected, "false");
  assert.equal(result.results.tasks.find((task) => task.taskId === "e2e:ranked-deploy")?.expected, "true");
  assert.equal(result.results.tasks.find((task) => task.taskId === "e2e:no-task-init")?.expected, "false");
  assert.equal(result.results.tasks.find((task) => task.taskId === "e2e:disabled-gate")?.expected, "false");

  assert.equal(callbacks.length, result.results.tasks.length);
  for (const [index, callback] of callbacks.entries()) {
    assert.equal(callback.task.taskId, result.results.tasks[index]!.taskId);
    assert.equal(callback.completedCount, index + 1);
    assert.equal(callback.totalCount, result.results.tasks.length);
  }
});
