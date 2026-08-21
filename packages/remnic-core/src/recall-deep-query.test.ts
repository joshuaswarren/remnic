import assert from "node:assert/strict";
import test from "node:test";

import { parseDeepQuery } from "./recall-deep-query.js";

test("query is returned", () => {
  assert.deepEqual(parseDeepQuery("what happened"), {
    ok: true,
    query: "what happened",
  });
});

test("empty query is empty_query", () => {
  assert.deepEqual(parseDeepQuery(""), { ok: false, error: "empty_query" });
  assert.deepEqual(parseDeepQuery("   "), { ok: false, error: "empty_query" });
});

test("query is trimmed", () => {
  assert.deepEqual(parseDeepQuery("  what happened  "), {
    ok: true,
    query: "what happened",
  });
});
