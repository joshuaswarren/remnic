import assert from "node:assert/strict";
import test from "node:test";

import { parseRecapDate } from "./recap-date.js";

test("accepts a trimmed YYYY-MM-DD date", () => {
  assert.deepEqual(parseRecapDate("2026-08-19"), { ok: true, date: "2026-08-19" });
  assert.deepEqual(parseRecapDate("  2026-08-19  "), { ok: true, date: "2026-08-19" });
});

test("empty and whitespace-only values are missing_date", () => {
  assert.deepEqual(parseRecapDate(""), { ok: false, error: "missing_date" });
  assert.deepEqual(parseRecapDate("   "), { ok: false, error: "missing_date" });
});

test("rejects strings that are not YYYY-MM-DD", () => {
  assert.deepEqual(parseRecapDate("20260819"), { ok: false, error: "invalid_date" });
  assert.deepEqual(parseRecapDate("2026-8-19"), { ok: false, error: "invalid_date" });
  assert.deepEqual(parseRecapDate("2026-08-19T00:00:00Z"), { ok: false, error: "invalid_date" });
  assert.deepEqual(parseRecapDate("not-a-date"), { ok: false, error: "invalid_date" });
});
