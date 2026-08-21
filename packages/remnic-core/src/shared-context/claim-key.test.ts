import assert from "node:assert/strict";
import test from "node:test";

import { parseClaimKey } from "./claim-key.js";

test("ok key returns trimmed key", () => {
  assert.deepEqual(parseClaimKey("claim-a"), { ok: true, key: "claim-a" });
});

test("empty key is missing_key", () => {
  assert.deepEqual(parseClaimKey(""), { ok: false, error: "missing_key" });
  assert.deepEqual(parseClaimKey("   "), { ok: false, error: "missing_key" });
});

test("newline in key is invalid_key", () => {
  assert.deepEqual(parseClaimKey("claim-a\nclaim-b"), { ok: false, error: "invalid_key" });
});

test("trims surrounding whitespace", () => {
  assert.deepEqual(parseClaimKey("  claim-a  "), { ok: true, key: "claim-a" });
});
