import assert from "node:assert/strict";
import test from "node:test";

import { daysBetweenIso } from "./week-span.js";

test("seven-day week is [start, end)", () => {
  assert.equal(daysBetweenIso("2026-07-13", "2026-07-20"), 7);
});

test("same day throws", () => {
  assert.throws(() => daysBetweenIso("2026-07-13", "2026-07-13"), /end/);
});

test("inverted range throws", () => {
  assert.throws(() => daysBetweenIso("2026-07-20", "2026-07-13"), /end/);
});

test("invalid date throws", () => {
  assert.throws(() => daysBetweenIso("2026-02-30", "2026-03-02"), /YYYY-MM-DD/);
  assert.throws(() => daysBetweenIso("2026-07-13", "not-a-date"), /YYYY-MM-DD/);
});
