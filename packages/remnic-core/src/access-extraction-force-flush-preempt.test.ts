/**
 * The force-flush preemption callback must preempt the CALLER'S OWN session
 * extraction slot, never an arbitrary newest-armed slot.
 *
 * `preemptRunning(preferredKey?)` already prefers a key-matched slot and only
 * falls back to the newest armed slot when no key is given. The write surface
 * passed no key, so every force-flush killed whichever background task armed
 * last — typically the backlog scheduler's buffer drain — instead of the
 * caller's own queued extraction. That turned each force-flush into collateral
 * damage for the 8,972-turn extraction backlog (observed 2026-11-17: repeated
 * `extraction preempted for force-flush` failures on unrelated sessions).
 */
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
