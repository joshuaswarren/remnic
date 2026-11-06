import assert from "node:assert/strict";
/**
 * PendingObserveExtractionTracker settle hygiene — issue: `track`'s settle
 * callback only removed the pending entry when the extraction SUCCEEDED or
 * was rejected with a preemption error. Any other rejection (a real
 * extraction failure) left the entry — and its ever-growing `controllers`
 * Set — in the map forever: the next observe for the key chained onto a
 * dead promise and every later `cancel` walked stale controllers.
 *
 * The fix deletes the entry on ANY settle (fulfillment or rejection) while
 * it is still the current entry. `wait`'s own overlap semantics are
 * unchanged: a flush that overlaps a failing extraction still surfaces the
 * error; only waits that arrive AFTER the extraction settled stop seeing
 * stale failures.
 */
import test from "node:test";

import { preemptedExtractionError } from "./abort-error.js";
import { PendingObserveExtractionTracker } from "./access-observe-helpers.js";

function settle(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

test("a settled non-preempted rejection clears the pending entry", async () => {
  const tracker = new PendingObserveExtractionTracker();
  const key = tracker.key("session-a", "alice", "default");
  tracker.track(key, Promise.reject(new Error("extraction failed")), new AbortController());
  await settle();

  // The entry is gone: the next wait finds nothing pending and returns
  // instead of rethrowing the already-settled stale failure.
  await tracker.wait("session-a", "alice", "default");
});

test("a settled success clears the pending entry for the next observe", async () => {
  const tracker = new PendingObserveExtractionTracker();
  const key = tracker.key("session-a", "alice", "default");
  tracker.track(key, Promise.resolve(), new AbortController());
  await settle();
  await tracker.wait("session-a", "alice", "default");
});

test("a chained non-preempted rejection clears the chained entry", async () => {
  const tracker = new PendingObserveExtractionTracker();
  const key = tracker.key("session-a", "alice", "default");
  tracker.track(key, Promise.resolve(), new AbortController());
  tracker.track(key, Promise.reject(new Error("second failed")), new AbortController());
  await settle();
  await tracker.wait("session-a", "alice", "default");
});

test("a preempted rejection still clears the pending entry", async () => {
  const tracker = new PendingObserveExtractionTracker();
  const key = tracker.key("session-a", "alice", "default");
  tracker.track(key, Promise.reject(preemptedExtractionError()), new AbortController());
  await settle();
  await tracker.wait("session-a", "alice", "default");
});

test("a wait overlapping a failing extraction still surfaces the error", async () => {
  const tracker = new PendingObserveExtractionTracker();
  const key = tracker.key("session-a", "alice", "default");
  const { promise: extraction, reject } = Promise.withResolvers<void>();
  tracker.track(key, extraction, new AbortController());
  const waiter = assert.rejects(() => tracker.wait("session-a", "alice", "default"), /extraction failed/);
  await Promise.resolve();
  reject(new Error("extraction failed"));
  await waiter;
});

/**
 * Controller retention — issue: `track` copied every prior controller of the
 * key into a fresh Set per tracked extraction, and never-settling promise
 * chains keep every generation reachable, so overlapping stalled tracks grew
 * quadratically (HeapRepro: ~543MB at 6000 tracks; measured 212.8MB at 4000
 * pre-fix vs 4.2MB with the shared per-key set). The fix reuses one Set per
 * key; `abortTracked` iterates a snapshot so a reentrant `track` fired from
 * an abort listener keeps prior semantics (not aborted by the in-flight
 * pass, iteration terminates).
 */
function stalled(): Promise<void> {
  const { promise } = Promise.withResolvers<void>();
  return promise;
}

function rejectingAfter(controller: AbortController): Promise<void> {
  const { promise, reject } = Promise.withResolvers<void>();
  controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
  return promise;
}

// Runs in CI (the root test runner exposes gc) and locally with
// NODE_OPTIONS=--expose-gc; skips under a bare tsx --test invocation.
// SAFETY: Node defines globalThis.gc as () => void only under --expose-gc
// and leaves it absent otherwise, so `{ gc?: () => void }` is exhaustive.
const { gc: gcFn } = globalThis as { gc?: () => void };
test(
  "retained heap stays bounded across overlapping stalled tracks",
  { skip: gcFn === undefined && "needs --expose-gc" },
  () => {
    const tracker = new PendingObserveExtractionTracker();
    const key = tracker.key("session-a", "alice", "default");
    gcFn();
    const before = process.memoryUsage().heapUsed;
    const tracks = 4000;
    for (let i = 0; i < tracks; i++) {
      tracker.track(key, stalled(), new AbortController());
    }
    gcFn();
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

test("wait surfaces a chained non-preempted rejection", async () => {
  const tracker = new PendingObserveExtractionTracker();
  const key = tracker.key("session-a", "alice", "default");
  tracker.track(key, Promise.resolve(), new AbortController());
  tracker.track(key, Promise.reject(new Error("extraction failed")), new AbortController());
  await assert.rejects(tracker.wait("session-a", "alice", "default"), /extraction failed/);
});

test("a wait overlapping a preempted rejection returns without throwing", { timeout: 2000 }, async () => {
  const tracker = new PendingObserveExtractionTracker();
  const key = tracker.key("session-a", "alice", "default");
  const controller = new AbortController();
  tracker.track(key, rejectingAfter(controller), controller);
  const waiter = tracker.wait("session-a", "alice", "default");
  await Promise.resolve();
  controller.abort(preemptedExtractionError());
  await waiter;
});
