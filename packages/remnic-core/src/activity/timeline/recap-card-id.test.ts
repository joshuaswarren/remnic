import assert from "node:assert/strict";
import test from "node:test";

import { parseRecapCardId } from "./recap-card-id.js";

test("ok card id returns trimmed id", () => {
  assert.deepEqual(parseRecapCardId("card-1"), { ok: true, id: "card-1" });
});

test("empty card id is missing_id", () => {
  assert.deepEqual(parseRecapCardId(""), { ok: false, error: "missing_id" });
  assert.deepEqual(parseRecapCardId("   "), { ok: false, error: "missing_id" });
});

test("newline in card id is invalid_id", () => {
  assert.deepEqual(parseRecapCardId("card-1\ncard-2"), { ok: false, error: "invalid_id" });
});

test("trims surrounding whitespace", () => {
  assert.deepEqual(parseRecapCardId("  card-1  "), { ok: true, id: "card-1" });
});
