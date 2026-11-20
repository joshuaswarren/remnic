import assert from "node:assert/strict";
import test from "node:test";

import { createTaskExit } from "./task-exit.js";

test("task-exit: a task settled before it started reports exit immediately", () => {
  let exited = 0;
  const task = createTaskExit(() => exited++);

  task.settled();

  assert.equal(exited, 1);
});

test("task-exit: a started task reports exit only when it finishes", () => {
  let exited = 0;
  const task = createTaskExit(() => exited++);

  task.start();
  task.settled();
  assert.equal(exited, 0, "settled() is a no-op once the closure is running");

  task.report();
  assert.equal(exited, 1);
});

test("task-exit: the callback fires exactly once no matter the order", () => {
  let exited = 0;
  const task = createTaskExit(() => exited++);

  task.settled();
  task.report();
  task.report();

  assert.equal(exited, 1);
});

test("task-exit: no callback means no crash", () => {
  const task = createTaskExit();
  assert.doesNotThrow(() => {
    task.start();
    task.settled();
    task.report();
  });
});
