import assert from "node:assert/strict";
import test from "node:test";

import { assertCurrentHasNoSuccessor } from "./recall-state-view-current.js";

test("current plus successor id is current_has_successor", () => {
  assert.deepEqual(assertCurrentHasNoSuccessor({ kind: "current", successorId: "mem-2" }), {
    ok: false,
    error: "current_has_successor",
  });
});

test("current plus empty successor id is ok", () => {
  assert.deepEqual(assertCurrentHasNoSuccessor({ kind: "current", successorId: "" }), { ok: true });
  assert.deepEqual(assertCurrentHasNoSuccessor({ kind: "current", successorId: "   " }), { ok: true });
  assert.deepEqual(assertCurrentHasNoSuccessor({ kind: "current" }), { ok: true });
});

test("historical plus successor id is ok", () => {
  assert.deepEqual(assertCurrentHasNoSuccessor({ kind: "historical", successorId: "mem-2" }), {
    ok: true,
  });
});
