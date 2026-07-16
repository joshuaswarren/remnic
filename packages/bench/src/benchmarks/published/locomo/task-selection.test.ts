import assert from "node:assert/strict";
import test from "node:test";

import {
  LOCOMO_TASK_SELECTION_VERSION,
  parseLoCoMoTaskSelectionManifest,
  selectLoCoMoTasks,
} from "./task-selection.js";

test("explicit LoCoMo selection canonicalizes requested ids into dataset order", () => {
  const tasks = ["task-c", "task-a", "task-b"].map((taskId) => ({ taskId }));
  const selection = selectLoCoMoTasks(tasks, {
    taskIds: ["task-b", "task-c"],
  });

  assert.deepEqual(selection, {
    algorithm: "explicit-task-ids",
    version: LOCOMO_TASK_SELECTION_VERSION,
    candidateCount: 3,
    selectedCount: 2,
    selectedTaskIds: ["task-c", "task-b"],
    selectedTaskIdsSha256:
      "c93eb02d11571fd2c219957db9928383c4b727b03b6b3bef4e1fec0ad74877d0",
  });
});

test("seeded LoCoMo selection has stable membership and dataset-order output", () => {
  const tasks = ["task-c", "task-a", "task-b"].map((taskId) => ({ taskId }));
  const first = selectLoCoMoTasks(tasks, { sampleSize: 2, seed: 42 });
  const reversed = selectLoCoMoTasks([...tasks].reverse(), {
    sampleSize: 2,
    seed: 42,
  });

  assert.deepEqual(new Set(first.selectedTaskIds), new Set(reversed.selectedTaskIds));
  assert.deepEqual(
    first.selectedTaskIds,
    tasks
      .map((task) => task.taskId)
      .filter((taskId) => first.selectedTaskIds.includes(taskId)),
  );
});

test("LoCoMo task selectors reject malformed, duplicate, and unknown ids", () => {
  const tasks = ["task-a", "task-b"].map((taskId) => ({ taskId }));
  assert.throws(
    () => selectLoCoMoTasks(tasks, { taskIds: [] }),
    /cannot be empty/,
  );
  assert.throws(
    () => selectLoCoMoTasks(tasks, { taskIds: ["task-a", "task-a"] }),
    /duplicates/,
  );
  assert.throws(
    () => selectLoCoMoTasks(tasks, { taskIds: ["unknown"] }),
    /Unknown/,
  );
  assert.throws(
    () => selectLoCoMoTasks(tasks, { sampleSize: 0, seed: 1 }),
    /sampleSize/,
  );
  assert.throws(
    () =>
      selectLoCoMoTasks(tasks, {
        taskIds: ["task-a"],
        sampleSize: 1,
        seed: 1,
      } as never),
    /exactly one/,
  );
  assert.throws(
    () => selectLoCoMoTasks([{ taskId: "task-a" }, { taskId: "task-a" }], {
      taskIds: ["task-a"],
    }),
    /candidate task ids must be unique/,
  );
});

test("persisted LoCoMo selection parser verifies schema, counts, order hash, and clones ids", () => {
  const source = selectLoCoMoTasks(
    [{ taskId: "task-a" }, { taskId: "task-b" }],
    { taskIds: ["task-b"] },
  );
  const parsed = parseLoCoMoTaskSelectionManifest(source);
  assert.deepEqual(parsed, source);
  assert.notEqual(parsed.selectedTaskIds, source.selectedTaskIds);

  assert.throws(
    () => parseLoCoMoTaskSelectionManifest({ ...source, selectedCount: 2 }),
    /selectedCount must equal/,
  );
  assert.throws(
    () =>
      parseLoCoMoTaskSelectionManifest({
        ...source,
        selectedTaskIdsSha256: "0".repeat(64),
      }),
    /does not match/,
  );
  assert.throws(
    () => parseLoCoMoTaskSelectionManifest({ ...source, future: true }),
    /unknown field/,
  );
});
