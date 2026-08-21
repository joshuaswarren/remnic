import assert from "node:assert/strict";
import test from "node:test";

import { parseSuccessorId } from "./recall-state-view-successor.js";

test("ok successor id returns trimmed successorId", () => {
  assert.deepEqual(parseSuccessorId("mem-2"), { ok: true, successorId: "mem-2" });
});

test("empty successor id is missing_successor", () => {
  assert.deepEqual(parseSuccessorId(""), { ok: false, error: "missing_successor" });
  assert.deepEqual(parseSuccessorId("   "), { ok: false, error: "missing_successor" });
});

test("newline in successor id is invalid_successor", () => {
  assert.deepEqual(parseSuccessorId("mem-1\nmem-2"), { ok: false, error: "invalid_successor" });
});

test("trims surrounding whitespace", () => {
  assert.deepEqual(parseSuccessorId("  mem-2  "), { ok: true, successorId: "mem-2" });
});
