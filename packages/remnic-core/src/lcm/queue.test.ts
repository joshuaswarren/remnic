import test from "node:test";
import assert from "node:assert/strict";
import { LcmWorkQueue } from "./queue.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("LcmWorkQueue coalesces duplicate pending jobs per session", async () => {
  const blocker = deferred();
  const executionOrder: string[] = [];

  const queue = new LcmWorkQueue({
    concurrency: 1,
    worker: async (sessionId) => {
      executionOrder.push(sessionId);
      if (sessionId === "blocked") {
        await blocker.promise;
      }
    },
  });

  queue.enqueue("blocked", [{ role: "user", content: "hold" }]);
  queue.enqueue("session-a", [{ role: "user", content: "one" }]);
  queue.enqueue("session-a", [{ role: "assistant", content: "two" }]);

  await Promise.resolve();

  assert.equal(queue.inFlightCount, 1);
  assert.equal(queue.depth, 1);

  blocker.resolve();
  await queue.whenIdle();

  assert.deepEqual(executionOrder, ["blocked", "session-a"]);
  assert.equal(queue.inFlightCount, 0);
  assert.equal(queue.depth, 0);
});

test("LcmWorkQueue continues after a worker failure", async () => {
  const seen: string[] = [];

  const queue = new LcmWorkQueue({
    concurrency: 1,
    worker: async (sessionId) => {
      seen.push(sessionId);
      if (sessionId === "session-a") {
        throw new Error("boom");
      }
    },
  });

  queue.enqueue("session-a", [{ role: "user", content: "one" }]);
  queue.enqueue("session-b", [{ role: "assistant", content: "two" }]);

  await queue.whenIdle();

  assert.deepEqual(seen, ["session-a", "session-b"]);
  assert.equal(queue.inFlightCount, 0);
  assert.equal(queue.depth, 0);
});

test("LcmWorkQueue preserves first enqueue time when pending jobs coalesce", async () => {
  const realNow = Date.now;
  let now = 100;
  const blocker = deferred();
  const waits = new Map<string, number>();

  Date.now = () => now;

  try {
    const queue = new LcmWorkQueue({
      concurrency: 1,
      worker: async (sessionId) => {
        if (sessionId === "blocked") {
          await blocker.promise;
        }
      },
      hooks: {
        onJobStart: ({ sessionId, waitMs }) => waits.set(sessionId, waitMs),
      },
    });

    queue.enqueue("blocked", [{ role: "user", content: "hold" }]);
    await Promise.resolve();

    now = 110;
    queue.enqueue("session-a", [{ role: "user", content: "one" }]);

    now = 150;
    queue.enqueue("session-a", [{ role: "assistant", content: "two" }]);

    now = 200;
    blocker.resolve();
    await queue.whenIdle();

    assert.equal(waits.get("session-a"), 90);
  } finally {
    Date.now = realNow;
  }
});

test("LcmWorkQueue does not start a second job for a session already in flight", async () => {
  const blocker = deferred();
  const started: string[] = [];
  let concurrentSameSession = false;
  const activeSessions = new Set<string>();

  const queue = new LcmWorkQueue({
    concurrency: 2,
    worker: async (sessionId) => {
      if (activeSessions.has(sessionId)) {
        concurrentSameSession = true;
      }
      activeSessions.add(sessionId);
      started.push(sessionId);
      if (sessionId === "session-a") {
        await blocker.promise;
      }
      activeSessions.delete(sessionId);
    },
  });

  queue.enqueue("session-a", [{ role: "user", content: "first" }]);
  await Promise.resolve();
  queue.enqueue("session-a", [{ role: "assistant", content: "second" }]);
  queue.enqueue("session-b", [{ role: "user", content: "other" }]);

  await Promise.resolve();
  await Promise.resolve();

  assert.equal(concurrentSameSession, false);
  assert.deepEqual(started, ["session-a", "session-b"]);
  assert.equal(queue.depth, 1);

  blocker.resolve();
  await queue.whenIdle();

  assert.equal(concurrentSameSession, false);
  assert.deepEqual(started, ["session-a", "session-b", "session-a"]);
});

test("LcmWorkQueue waits for a specific session without waiting for unrelated idle work", async () => {
  const blocker = deferred();
  let sessionIdleResolved = false;

  const queue = new LcmWorkQueue({
    concurrency: 1,
    worker: async (sessionId) => {
      if (sessionId === "blocked") {
        await blocker.promise;
      }
    },
  });

  queue.enqueue("blocked", [{ role: "user", content: "hold" }]);
  queue.enqueue("session-a", [{ role: "assistant", content: "queued" }]);

  await Promise.resolve();
  const sessionIdlePromise = queue.whenSessionIdle("session-a").then(() => {
    sessionIdleResolved = true;
  });

  await Promise.resolve();
  assert.equal(sessionIdleResolved, false);

  blocker.resolve();
  await sessionIdlePromise;

  assert.equal(sessionIdleResolved, true);
  await queue.whenIdle();
});
