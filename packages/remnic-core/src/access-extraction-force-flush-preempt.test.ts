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

test("forwards the caller session key as the preferred preemption key", () => {
  const seen: (string | undefined)[] = [];
  const callback = forceFlushPreemptCallback("pi:session-a", {
    preemptRunning: (key) => void seen.push(key),
  });
  callback();
  assert.deepEqual(seen, ["pi:session-a"]);
});

test("falls back to newest-slot preemption when no session key is known", () => {
  const seen: (string | undefined)[] = [];
  const callback = forceFlushPreemptCallback(undefined, {
    preemptRunning: (key) => void seen.push(key),
  });
  callback();
  assert.deepEqual(seen, [undefined]);
});

test("a missing coordinator is a no-op, not a throw", () => {
  const callback = forceFlushPreemptCallback("pi:session-a", undefined);
  assert.doesNotThrow(() => callback());
});
