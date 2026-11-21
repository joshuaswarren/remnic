import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";
import {
  ExtractionQueueCoordinator,
  type ExtractionQueueTask,
} from "./orchestration/extraction-queue-coordinator.js";

/**
 * Bounded-concurrency default regressions: the extraction queue ships
 * bounded-parallel instead of serial, an explicit operator value — including
 * a deployed serial `1` — always wins over the default, and the default
 * limit still serializes work sharing a session key.
 */

/** Parked queue task with deterministic start/release handles. */
function makeParkedTask() {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let didStart = false;
  const task: ExtractionQueueTask = async () => {
    didStart = true;
    started.resolve();
    await release.promise;
  };
  return {
    task,
    startedPromise: started.promise,
    release: () => release.resolve(),
    get started() {
      return didStart;
    },
  };
}

async function startedWithin(promise: Promise<void>, timeoutMs = 1_000): Promise<boolean> {
  const result = Promise.withResolvers<boolean>();
  const timeout = setTimeout(() => result.resolve(false), timeoutMs);
  void promise.then(() => result.resolve(true));
  try {
    return await result.promise;
  } finally {
    clearTimeout(timeout);
  }
}

test("parseConfig: extractionQueueConcurrency defaults to bounded-parallel 2", () => {
  assert.equal(parseConfig({}).extractionQueueConcurrency, 2);
});

test("parseConfig: an explicit operator value wins over the default (serial 1 stays serial)", () => {
  assert.equal(parseConfig({ extractionQueueConcurrency: 1 }).extractionQueueConcurrency, 1);
  assert.equal(parseConfig({ extractionQueueConcurrency: 4 }).extractionQueueConcurrency, 4);
  for (const invalid of [0, -1, 1.5, "two"]) {
    assert.throws(
      () => parseConfig({ extractionQueueConcurrency: invalid }),
      /extractionQueueConcurrency must be a positive integer/,
      `expected rejection for ${JSON.stringify(invalid)}`,
    );
  }
});

test("default coordinator limit is 2", () => {
  assert.equal(new ExtractionQueueCoordinator().maxConcurrency, 2);
});

test("default coordinator runs two distinct sessions concurrently, not three", async () => {
  const coordinator = new ExtractionQueueCoordinator();
  const first = makeParkedTask();
  const second = makeParkedTask();
  const third = makeParkedTask();
  coordinator.enqueue(first.task, { key: "session-a" });
  coordinator.enqueue(second.task, { key: "session-b" });
  coordinator.enqueue(third.task, { key: "session-c" });
  try {
    assert.equal(await startedWithin(first.startedPromise), true, "first session should start");
    assert.equal(await startedWithin(second.startedPromise), true, "second session should start in parallel");
    assert.equal(third.started, false, "the third task must stay queued: the default limit is 2, not unbounded");
    first.release();
    assert.equal(await startedWithin(third.startedPromise), true, "a freed slot should start the third task");
  } finally {
    first.release();
    second.release();
    third.release();
    assert.equal(await coordinator.waitForIdle(5_000), true);
  }
  assert.equal(coordinator.isProcessing, false);
});

test("default coordinator still serializes tasks sharing a session key", async () => {
  const coordinator = new ExtractionQueueCoordinator();
  const busy = makeParkedTask();
  const sameKey = makeParkedTask();
  coordinator.enqueue(busy.task, { key: "s1" });
  await busy.startedPromise;
  coordinator.enqueue(sameKey.task, { key: "s1" });
  assert.equal(
    sameKey.started,
    false,
    "same-session work must never run concurrently, even under the default limit",
  );
  busy.release();
  await sameKey.startedPromise;
  sameKey.release();
  assert.equal(await coordinator.waitForIdle(5_000), true);
});
