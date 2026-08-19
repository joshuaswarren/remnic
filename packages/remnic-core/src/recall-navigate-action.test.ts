import assert from "node:assert/strict";
import test from "node:test";

import { parseNavigateAction } from "./recall-navigate-action.js";

test("expand is allowed", () => {
  assert.deepEqual(parseNavigateAction("expand"), {
    ok: true,
    action: "expand",
  });
});

test("traverse is allowed", () => {
  assert.deepEqual(parseNavigateAction("traverse"), {
    ok: true,
    action: "traverse",
  });
});

test("unknown action is unknown_action", () => {
  assert.deepEqual(parseNavigateAction("refine"), {
    ok: false,
    error: "unknown_action",
  });
});

test("empty action is unknown_action", () => {
  assert.deepEqual(parseNavigateAction(""), {
    ok: false,
    error: "unknown_action",
  });
});
