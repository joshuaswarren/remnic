import assert from "node:assert/strict";
import test from "node:test";
import { forceFlushPreemptCallback } from "./access-extraction-force-flush-preempt.js";

test("forwards the caller session key as keyed-only preemption", () => {
  const keyed: string[] = [];
  const unkeyed: number[] = [];
  const callback = forceFlushPreemptCallback("pi:session-a", {
    preemptRunning: () => void unkeyed.push(1),
    preemptKeyed: (key) => void keyed.push(key),
  });
  callback();
  assert.deepEqual(keyed, ["pi:session-a"]);
  assert.deepEqual(unkeyed, []);
});

test("falls back to newest-slot preemption when no session key is known", () => {
  const unkeyed: number[] = [];
  const callback = forceFlushPreemptCallback(undefined, {
    preemptRunning: () => void unkeyed.push(1),
  });
  callback();
  assert.deepEqual(unkeyed, [1]);
});

test("a missing coordinator is a no-op, not a throw", () => {
  const callback = forceFlushPreemptCallback("pi:session-a", undefined);
  assert.doesNotThrow(() => callback());
});
