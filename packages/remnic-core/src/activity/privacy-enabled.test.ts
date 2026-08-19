import assert from "node:assert/strict";
import test from "node:test";

import { parsePrivacyEnabled } from "./privacy-enabled.js";

test("boolean passthrough returns enabled", () => {
  assert.deepEqual(parsePrivacyEnabled(true), { ok: true, enabled: true });
  assert.deepEqual(parsePrivacyEnabled(false), { ok: true, enabled: false });
});

test("string false tokens return enabled false", () => {
  assert.deepEqual(parsePrivacyEnabled("false"), { ok: true, enabled: false });
  assert.deepEqual(parsePrivacyEnabled("0"), { ok: true, enabled: false });
  assert.deepEqual(parsePrivacyEnabled("no"), { ok: true, enabled: false });
  assert.deepEqual(parsePrivacyEnabled("off"), { ok: true, enabled: false });
});

test("string true tokens return enabled true", () => {
  assert.deepEqual(parsePrivacyEnabled("true"), { ok: true, enabled: true });
  assert.deepEqual(parsePrivacyEnabled("1"), { ok: true, enabled: true });
  assert.deepEqual(parsePrivacyEnabled("yes"), { ok: true, enabled: true });
  assert.deepEqual(parsePrivacyEnabled("on"), { ok: true, enabled: true });
});

test("unknown values are invalid_enabled", () => {
  assert.deepEqual(parsePrivacyEnabled("maybe"), { ok: false, error: "invalid_enabled" });
  assert.deepEqual(parsePrivacyEnabled(2), { ok: false, error: "invalid_enabled" });
  assert.deepEqual(parsePrivacyEnabled(null), { ok: false, error: "invalid_enabled" });
  assert.deepEqual(parsePrivacyEnabled({}), { ok: false, error: "invalid_enabled" });
});
