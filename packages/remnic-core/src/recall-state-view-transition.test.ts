import assert from "node:assert/strict";
import test from "node:test";

import { assertTransitionHasSuccessor } from "./recall-state-view-transition.js";

test("transition plus empty successor id is transition_missing_successor", () => {
  assert.deepEqual(assertTransitionHasSuccessor({ kind: "transition", successorId: "" }), {
    ok: false,
    error: "transition_missing_successor",
  });
  assert.deepEqual(assertTransitionHasSuccessor({ kind: "transition", successorId: "   " }), {
    ok: false,
    error: "transition_missing_successor",
  });
  assert.deepEqual(assertTransitionHasSuccessor({ kind: "transition" }), {
    ok: false,
    error: "transition_missing_successor",
  });
});

test("transition plus successor id is ok", () => {
  assert.deepEqual(assertTransitionHasSuccessor({ kind: "transition", successorId: "mem-2" }), {
    ok: true,
  });
});

test("current plus empty successor id is ok", () => {
  assert.deepEqual(assertTransitionHasSuccessor({ kind: "current", successorId: "" }), { ok: true });
  assert.deepEqual(assertTransitionHasSuccessor({ kind: "current" }), { ok: true });
});
