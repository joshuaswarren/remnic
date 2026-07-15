import assert from "node:assert/strict";
import test from "node:test";

import { XrayCaptureQueue } from "./xray-capture-queue.js";

test("initial snapshot read failure releases the next queued capture", async () => {
  const queue = new XrayCaptureQueue();
  let failNextRead = true;
  let snapshot: string | null = "prior";
  const operations: string[] = [];
  const state = {
    read(): string | null {
      if (failNextRead) {
        failNextRead = false;
        throw new Error("snapshot clone failed");
      }
      return snapshot;
    },
    clear(): void {
      snapshot = null;
    },
    restore(value: string | null): void {
      snapshot = value;
    },
  };

  const failed = queue.run(async () => {
    operations.push("failed");
    return "unexpected";
  }, state);
  const next = queue.run(async () => {
    operations.push("next");
    snapshot = "fresh";
    return "next-result";
  }, state);

  await assert.rejects(failed, /snapshot clone failed/);
  const result = await next;
  assert.deepEqual(operations, ["next"]);
  assert.equal(result.result, "next-result");
  assert.equal(result.snapshot, "fresh");
});
