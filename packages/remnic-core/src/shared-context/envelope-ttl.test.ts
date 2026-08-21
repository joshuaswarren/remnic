import assert from "node:assert/strict";
import { test } from "node:test";

import { remainingTtlMs } from "./envelope-ttl.js";

const EXPIRES_AT = "2026-08-18T12:00:00.000Z";
const AT = Date.parse(EXPIRES_AT);

test("remainingTtlMs returns null when expiresAt is missing", () => {
  assert.equal(remainingTtlMs({ nowMs: AT }), null);
  assert.equal(remainingTtlMs({ expiresAt: undefined, nowMs: AT }), null);
});

test("remainingTtlMs returns 0 at and after expiry", () => {
  assert.equal(remainingTtlMs({ expiresAt: EXPIRES_AT, nowMs: AT }), 0);
  assert.equal(remainingTtlMs({ expiresAt: EXPIRES_AT, nowMs: AT + 1 }), 0);
  assert.equal(remainingTtlMs({ expiresAt: AT, nowMs: AT }), 0);
});

test("remainingTtlMs returns expiresAt minus nowMs before expiry", () => {
  assert.equal(remainingTtlMs({ expiresAt: EXPIRES_AT, nowMs: AT - 1 }), 1);
  assert.equal(remainingTtlMs({ expiresAt: AT, nowMs: AT - 25 }), 25);
});

test("remainingTtlMs throws on an invalid expiresAt", () => {
  assert.throws(() => remainingTtlMs({ expiresAt: "not-a-date", nowMs: AT }), /expiresAt/);
  assert.throws(() => remainingTtlMs({ expiresAt: "", nowMs: AT }), /expiresAt/);
  assert.throws(() => remainingTtlMs({ expiresAt: Number.NaN, nowMs: AT }), /expiresAt/);
});
