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

/**
 * Regression (issue #1957 review round 3): permissive `Date.parse` accepted
 * these and silently reinterpreted them — "2026-02-30" as March 2 2026, "1"
 * as January 1 2001 — so the persisted governance deadline differed from the
 * caller's input. The calendar components are validated against the exact
 * value now, and an out-of-range or non-string input is rejected.
 */
test("Date.parse-permissive expiries are rejected, not reinterpreted", () => {
  for (const value of ["2026-02-30T00:00:00.000Z", "2026-02-30", "1", "2026-13-01T00:00:00Z", "2026-08-18T25:00:00Z"]) {
    assert.deepEqual(parseEnvelopeAt(value), { ok: false, error: "invalid_at" }, value);
  }
  // Non-finite / non-string inputs an in-process JS caller can still pass.
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 1, null, undefined, {}]) {
    assert.deepEqual(parseEnvelopeAt(value as never), { ok: false, error: "invalid_at" }, String(value));
  }
  // A whitespace-padded timestamp is not the value the caller supplied.
  assert.deepEqual(parseEnvelopeAt(` ${AT} `), { ok: false, error: "invalid_at" });
  // Valid ISO instants still pass through unchanged.
  assert.deepEqual(parseEnvelopeAt(AT), { ok: true, at: AT });
  assert.deepEqual(parseEnvelopeAt("2026-02-28T23:59:59Z"), { ok: true, at: "2026-02-28T23:59:59.000Z" });
  assert.deepEqual(parseEnvelopeAt("2024-02-29T00:00:00Z"), { ok: true, at: "2024-02-29T00:00:00.000Z" });
});
