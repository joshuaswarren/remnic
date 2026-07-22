import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { __benchDatasetTestHooks } from "./index.js";
import { withTempDir, withTempDirSync } from "./testing/tmp-dir.js";
import { runCli } from "./run-cli.js";

const DIGEST = "a".repeat(64);

test("CLI loads an explicit LoCoMo selector and forwards no local path", () => {
  withTempDirSync("task-selector", (dir) => {
    const selectorPath = path.join(dir, "task-ids.json");
    fs.writeFileSync(selectorPath, JSON.stringify(["task-b", "task-a"]));
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
  });
});

test("CLI rejects malformed or duplicate explicit LoCoMo selectors", () => {
  withTempDirSync("task-selector", (dir) => {
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
  });
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

test("LoCoMo published dry-run validates a pinned selector through the runner", async () => {
  const selector = {
    kind: "explicit-task-ids" as const,
    taskIds: ["unknown-task"],
    expectedSelectedTaskIdsSha256: DIGEST,
  };
  let capturedOptions: Record<string, unknown> | undefined;
  const benchModule = {
    async runBenchmark(_id: string, options: Record<string, unknown>) {
      capturedOptions = options;
      throw new Error("Unknown LoCoMo task id: unknown-task");
    },
  };

  await assert.rejects(
    __benchDatasetTestHooks.validatePinnedLoCoMoPublishedDryRunSelectorWithModuleForTest(
      benchModule,
      "full",
      "/tmp/locomo",
      undefined,
      42,
      { taskSelector: selector },
      selector,
    ),
    /Unknown LoCoMo task id: unknown-task/,
  );
  assert.deepEqual(capturedOptions?.benchmarkOptions, { taskSelector: selector });
});

test("LoCoMo published dry-run does not invoke the runner without a pinned selector", async () => {
  let invoked = false;
  await __benchDatasetTestHooks.validatePinnedLoCoMoPublishedDryRunSelectorWithModuleForTest(
    {
      async runBenchmark() {
        invoked = true;
      },
    },
    "full",
    "/tmp/locomo",
    undefined,
    undefined,
    undefined,
    undefined,
  );
  assert.equal(invoked, false);
});

test("bench published LoCoMo dry-run rejects an unknown pinned task id", async () => {
  await withTempDir("task-selector-cli", async (dir) => {
    const selectorPath = path.join(dir, "task-ids.json");
    fs.writeFileSync(selectorPath, JSON.stringify(["unknown-task"]));
    fs.writeFileSync(
      path.join(dir, "locomo10.json"),
      JSON.stringify([
        {
          sample_id: "selector-dry-run",
          conversation: {
            speaker_a: "Maya",
            speaker_b: "Assistant",
            session_1: [
              { speaker: "Maya", dia_id: "D1:1", text: "I moved to Austin." },
            ],
          },
          qa: [
            {
              question: "Where did Maya move?",
              answer: "Austin",
              evidence: ["D1:1"],
              category: 1,
            },
          ],
        },
      ]),
    );

    const result = await runCli(
      [
        "bench",
        "published",
        "--name",
        "locomo",
        "--dataset",
        dir,
        "--model",
        "gpt-5.6-luna",
        "--provider",
        "codex-cli",
        "--task-ids-file",
        selectorPath,
        "--expected-task-id-list-sha256",
        DIGEST,
        "--trial-concurrency",
        "1",
        "--dry-run",
      ],
      { cwd: path.resolve(import.meta.dirname, "../../..") },
    );
    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /\[dry-run\] locomo: source=dataset/);
    assert.match(result.stderr, /Unknown LoCoMo task id: unknown-task/);
  });
});
