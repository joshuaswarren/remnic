import assert from "node:assert/strict";
import test from "node:test";

import { parseEnvelopeId } from "./envelope-id.js";

test("ok id returns trimmed id", () => {
  assert.deepEqual(parseEnvelopeId("item-a"), { ok: true, id: "item-a" });
});

test("empty id is missing_id", () => {
  assert.deepEqual(parseEnvelopeId(""), { ok: false, error: "missing_id" });
  assert.deepEqual(parseEnvelopeId("   "), { ok: false, error: "missing_id" });
});

test("newline in id is invalid_id", () => {
  assert.deepEqual(parseEnvelopeId("item-a\nitem-b"), { ok: false, error: "invalid_id" });
});

test("trims surrounding whitespace", () => {
  assert.deepEqual(parseEnvelopeId("  item-a  "), { ok: true, id: "item-a" });
});
