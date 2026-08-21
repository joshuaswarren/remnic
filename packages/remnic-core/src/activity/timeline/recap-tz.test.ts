import assert from "node:assert/strict";
import test from "node:test";

import { normalizeRecapTimezone } from "./recap-tz.js";

test("accepts a trimmed IANA-shaped timezone", () => {
  assert.deepEqual(normalizeRecapTimezone("America/Chicago"), {
    ok: true,
    timezone: "America/Chicago",
  });
});

test("empty and whitespace-only values are missing_timezone", () => {
  assert.deepEqual(normalizeRecapTimezone(""), { ok: false, error: "missing_timezone" });
  assert.deepEqual(normalizeRecapTimezone("   "), { ok: false, error: "missing_timezone" });
});

test("rejects characters outside the bounded class", () => {
  assert.deepEqual(normalizeRecapTimezone("America/Chicago!"), {
    ok: false,
    error: "invalid_timezone",
  });
  assert.deepEqual(normalizeRecapTimezone("America Chicago"), {
    ok: false,
    error: "invalid_timezone",
  });
  assert.deepEqual(normalizeRecapTimezone("A".repeat(65)), {
    ok: false,
    error: "invalid_timezone",
  });
});

test("trims surrounding whitespace before validating", () => {
  assert.deepEqual(normalizeRecapTimezone("  UTC  "), { ok: true, timezone: "UTC" });
});
