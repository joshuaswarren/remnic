import assert from "node:assert/strict";
import test from "node:test";

import { parseNavigateLinkType } from "./recall-navigate-link.js";

test("parses each allowed link type", () => {
  for (const type of ["supports", "contradicts", "elaborates", "causes", "caused_by"] as const) {
    assert.deepEqual(parseNavigateLinkType(type), { ok: true, type });
  }
});

test("unknown link is unknown_link", () => {
  assert.deepEqual(parseNavigateLinkType("supersedes"), { ok: false, error: "unknown_link" });
  assert.deepEqual(parseNavigateLinkType("related"), { ok: false, error: "unknown_link" });
});

test("empty link is unknown_link", () => {
  assert.deepEqual(parseNavigateLinkType(""), { ok: false, error: "unknown_link" });
});
