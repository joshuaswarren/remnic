import assert from "node:assert/strict";
import test from "node:test";

import { preemptedExtractionError } from "./abort-error.js";
import { PendingObserveExtractionTracker } from "./access-observe-helpers.js";

function stalled(): Promise<void> {
  const { promise } = Promise.withResolvers<void>();
  return promise;
}

function rejectingAfter(controller: AbortController): Promise<void> {
  const { promise, reject } = Promise.withResolvers<void>();
  controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
  return promise;
}

// Cleanup reactions are pure microtasks (no macrotask involved), so a fixed
// microtask drain is deterministic; a wall-clock timer would only guess at it.
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

// HeapRepro: 6000 stalled tracks retained ~543MB of per-generation copied
// controller sets (each track copies every prior controller into a fresh Set,
// and never-settling promise chains keep every generation reachable); a shared
// per-key set retains ~43MB. 4000 tracks keeps the quadratic signature with a
// smaller peak. Needs --expose-gc (NODE_OPTIONS=--expose-gc).
test(
  "retained heap stays bounded across overlapping stalled tracks",
  { skip: typeof gc !== "function" && "needs --expose-gc" },
  () => {
    const tracker = new PendingObserveExtractionTracker();
    const key = tracker.key("session-a", "alice", "default");
    gc();
    const before = process.memoryUsage().heapUsed;
    const tracks = 4000;
    for (let i = 0; i < tracks; i++) {
      tracker.track(key, stalled(), new AbortController());
    }
    gc();
    const retained = process.memoryUsage().heapUsed - before;
    assert.ok(
      retained < 32 * 1024 * 1024,
      `retained ${(retained / 1048576).toFixed(1)}MB for ${tracks} tracks; quadratic controller-set copies keep dead generations alive`,
    );
  },
);

test("cancel still aborts every distinct controller across overlapping tracks", () => {
  const tracker = new PendingObserveExtractionTracker();
  const key = tracker.key("session-a", "alice", "default");
  const controllers = Array.from({ length: 50 }, () => new AbortController());
  for (const controller of controllers) {
    tracker.track(key, stalled(), controller);
  }
  tracker.cancel("session-a", "alice", "default");
  for (const controller of controllers) {
    assert.ok(controller.signal.aborted, "every tracked controller must be aborted");
  }
});

test("a controller admitted by a reentrant track during cancel is not aborted by that pass", () => {
  const tracker = new PendingObserveExtractionTracker();
  const key = tracker.key("session-a", "alice", "default");
  const first = new AbortController();
  const reentrant = new AbortController();
  first.signal.addEventListener(
    "abort",
    () => {
      tracker.track(key, stalled(), reentrant);
    },
    { once: true },
  );
  tracker.track(key, stalled(), first);
  tracker.cancel("session-a", "alice", "default");
  assert.ok(first.signal.aborted);
  assert.equal(reentrant.signal.aborted, false, "prior behavior: the in-flight abort pass must not abort later admissions");
});

test("each key aborts and cleans up in isolation", { timeout: 2000 }, async () => {
  const tracker = new PendingObserveExtractionTracker();
  const keyA = tracker.key("session-a", "alice", "default");
  const keyB = tracker.key("session-b", "bob", "default");
  const controllerA = new AbortController();
  const controllerB = new AbortController();
  tracker.track(keyA, rejectingAfter(controllerA), controllerA);
  tracker.track(keyB, stalled(), controllerB);
  tracker.cancel("session-a", "alice", "default");
  assert.ok(controllerA.signal.aborted);
  assert.equal(controllerB.signal.aborted, false);
  await settle();
  await tracker.wait("session-a", "alice", "default");
});

test("an aborted chain entry settles once every generation settles and cleans up", { timeout: 2000 }, async () => {
  const tracker = new PendingObserveExtractionTracker();
  const key = tracker.key("session-a", "alice", "default");
  const first = new AbortController();
  tracker.track(key, rejectingAfter(first), first);
  const second = new AbortController();
  const { promise: secondExtraction, resolve } = Promise.withResolvers<void>();
  tracker.track(key, secondExtraction, second);
  first.abort(preemptedExtractionError());
  resolve();
  await settle();
  await tracker.wait("session-a", "alice", "default");
});

test("a settled success clears the entry for the next observe", { timeout: 2000 }, async () => {
  const tracker = new PendingObserveExtractionTracker();
  const key = tracker.key("session-a", "alice", "default");
  tracker.track(key, Promise.resolve(), new AbortController());
  await settle();
  await tracker.wait("session-a", "alice", "default");
});

test("wait surfaces a chained non-preempted rejection", async () => {
  const tracker = new PendingObserveExtractionTracker();
  const key = tracker.key("session-a", "alice", "default");
  tracker.track(key, Promise.resolve(), new AbortController());
  tracker.track(key, Promise.reject(new Error("extraction failed")), new AbortController());
  await assert.rejects(tracker.wait("session-a", "alice", "default"), /extraction failed/);
});

test("wait returns through a preempted rejection without throwing", { timeout: 2000 }, async () => {
  const tracker = new PendingObserveExtractionTracker();
  const key = tracker.key("session-a", "alice", "default");
  const controller = new AbortController();
  tracker.track(key, rejectingAfter(controller), controller);
  controller.abort(preemptedExtractionError());
  await tracker.wait("session-a", "alice", "default");
});
