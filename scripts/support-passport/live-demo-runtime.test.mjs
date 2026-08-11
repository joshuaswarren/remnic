import assert from "node:assert/strict";
import test from "node:test";

import { runCleanupSteps, waitForResult } from "./live-demo-runtime.mjs";

test("waitForResult polls until an asynchronous result is durable", async () => {
  let clock = 0;
  let reads = 0;
  const result = await waitForResult(
    async () => {
      reads += 1;
      if (reads < 3) throw new Error("not durable yet");
      return "ready";
    },
    {
      timeoutMs: 100,
      pollIntervalMs: 10,
      now: () => clock,
      delay: async (milliseconds) => {
        clock += milliseconds;
      },
    }
  );

  assert.equal(result, "ready");
  assert.equal(reads, 3);
});

test("waitForResult returns the last error after its bounded deadline", async () => {
  let clock = 0;
  let reads = 0;
  await assert.rejects(
    waitForResult(
      async () => {
        reads += 1;
        throw new Error(`not ready ${reads}`);
      },
      {
        timeoutMs: 20,
        pollIntervalMs: 10,
        now: () => clock,
        delay: async (milliseconds) => {
          clock += milliseconds;
        },
      }
    ),
    /not ready 3/
  );
});

test("runCleanupSteps completes every cleanup and returns the first error", async () => {
  const completed = [];
  const firstError = new Error("server stop failed");
  const result = await runCleanupSteps([
    async () => {
      completed.push("server");
      throw firstError;
    },
    async () => {
      completed.push("environment");
    },
    async () => {
      completed.push("temp");
      throw new Error("temp cleanup failed");
    },
    async () => {
      completed.push("receipt");
    },
  ]);

  assert.equal(result, firstError);
  assert.deepEqual(completed, ["server", "environment", "temp", "receipt"]);
});
