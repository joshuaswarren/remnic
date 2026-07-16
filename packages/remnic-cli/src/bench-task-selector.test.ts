import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { __benchDatasetTestHooks } from "./index.js";

const DIGEST = "a".repeat(64);

test("CLI loads an explicit LoCoMo selector and forwards no local path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-task-selector-"));
  const selectorPath = path.join(dir, "task-ids.json");
  fs.writeFileSync(selectorPath, JSON.stringify(["task-b", "task-a"]));
  try {
    const selector = __benchDatasetTestHooks.loadPinnedLoCoMoTaskSelectorForTest({
      taskIdsFile: selectorPath,
      expectedTaskIdListSha256: DIGEST,
    });
    assert.deepEqual(selector, {
      kind: "explicit-task-ids",
      taskIds: ["task-b", "task-a"],
      expectedSelectedTaskIdsSha256: DIGEST,
    });

    const options = __benchDatasetTestHooks.buildPublishedBenchmarkOptionsForTest(
      "locomo",
      {},
      selector,
    );
    assert.deepEqual(options?.taskSelector, selector);
    assert.equal(JSON.stringify(options).includes(selectorPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI rejects malformed or duplicate explicit LoCoMo selectors", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-task-selector-"));
  try {
    for (const [value, expected] of [
      [{ task: "task-a" }, /non-empty array of strings/],
      [[], /non-empty array of strings/],
      [["task-a", ""], /only non-empty strings/],
      [["task-a", "task-a"], /must not contain duplicate task IDs/],
    ] as const) {
      const selectorPath = path.join(dir, `${Math.random()}.json`);
      fs.writeFileSync(selectorPath, JSON.stringify(value));
      assert.throws(
        () => __benchDatasetTestHooks.loadPinnedLoCoMoTaskSelectorForTest({
          taskIdsFile: selectorPath,
          expectedTaskIdListSha256: DIGEST,
        }),
        expected,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI redacts the selector file path from persisted repro argv", () => {
  assert.deepEqual(
    __benchDatasetTestHooks.redactBenchTaskIdsFilePathForTest([
      "bench",
      "run",
      "locomo",
      "--task-ids-file",
      "/private/host/path/task-ids.json",
      "--expected-task-id-list-sha256",
      DIGEST,
    ]),
    [
      "bench",
      "run",
      "locomo",
      "--task-ids-file",
      "<task-ids-file>",
      "--expected-task-id-list-sha256",
      DIGEST,
    ],
  );
});
