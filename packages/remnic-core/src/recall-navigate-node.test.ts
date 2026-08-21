import assert from "node:assert/strict";
import test from "node:test";

import { parseNavigateNodeId } from "./recall-navigate-node.js";

test("ok node id returns trimmed nodeId", () => {
  assert.deepEqual(parseNavigateNodeId("mem-1"), { ok: true, nodeId: "mem-1" });
});

test("empty node id is missing_node", () => {
  assert.deepEqual(parseNavigateNodeId(""), { ok: false, error: "missing_node" });
  assert.deepEqual(parseNavigateNodeId("   "), { ok: false, error: "missing_node" });
});

test("newline in node id is invalid_node", () => {
  assert.deepEqual(parseNavigateNodeId("mem-1\nmem-2"), { ok: false, error: "invalid_node" });
});

test("trims surrounding whitespace", () => {
  assert.deepEqual(parseNavigateNodeId("  mem-1  "), { ok: true, nodeId: "mem-1" });
});
