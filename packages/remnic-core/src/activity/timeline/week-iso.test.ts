import assert from "node:assert/strict";
import test from "node:test";

import { parseIsoDate } from "./week-iso.js";

test("accepts a trimmed YYYY-MM-DD date", () => {
  assert.deepEqual(parseIsoDate("2026-08-19"), { ok: true, date: "2026-08-19" });
  assert.deepEqual(parseIsoDate("  2026-08-19  "), { ok: true, date: "2026-08-19" });
});

test("empty and whitespace-only values are missing_date", () => {
  assert.deepEqual(parseIsoDate(""), { ok: false, error: "missing_date" });
  assert.deepEqual(parseIsoDate("   "), { ok: false, error: "missing_date" });
});

test("rejects strings that are not YYYY-MM-DD", () => {
  assert.deepEqual(parseIsoDate("20260819"), { ok: false, error: "invalid_date" });
  assert.deepEqual(parseIsoDate("2026-8-19"), { ok: false, error: "invalid_date" });
  assert.deepEqual(parseIsoDate("2026-08-19T00:00:00Z"), { ok: false, error: "invalid_date" });
  assert.deepEqual(parseIsoDate("not-a-date"), { ok: false, error: "invalid_date" });
});
