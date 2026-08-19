import assert from "node:assert/strict";
import test from "node:test";

import { parseEnvelopeAt } from "./envelope-at.js";

const AT = "2026-08-18T12:00:00.000Z";

test("ok at returns ISO string", () => {
  assert.deepEqual(parseEnvelopeAt(AT), { ok: true, at: AT });
});

test("empty at is missing_at", () => {
  assert.deepEqual(parseEnvelopeAt(""), { ok: false, error: "missing_at" });
  assert.deepEqual(parseEnvelopeAt("   "), { ok: false, error: "missing_at" });
});

test("invalid at is invalid_at", () => {
  assert.deepEqual(parseEnvelopeAt("not-a-date"), { ok: false, error: "invalid_at" });
});
