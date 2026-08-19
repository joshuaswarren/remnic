import assert from "node:assert/strict";
import test from "node:test";

import { isMondayIso } from "./week-monday.js";

test("monday UTC is true", () => {
  assert.equal(isMondayIso("2026-07-13"), true);
});

test("tuesday UTC is false", () => {
  assert.equal(isMondayIso("2026-07-14"), false);
});

test("invalid date throws", () => {
  assert.throws(() => isMondayIso("2026-02-30"), /YYYY-MM-DD/);
  assert.throws(() => isMondayIso("not-a-date"), /YYYY-MM-DD/);
});
