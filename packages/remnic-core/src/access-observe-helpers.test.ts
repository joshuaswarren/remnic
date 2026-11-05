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
