import assert from "node:assert/strict";
import test from "node:test";

import { isSundayIso } from "./week-sunday.js";

test("sunday UTC is true", () => {
  assert.equal(isSundayIso("2026-07-12"), true);
});

test("monday UTC is false", () => {
  assert.equal(isSundayIso("2026-07-13"), false);
});

test("invalid date throws", () => {
  assert.throws(() => isSundayIso("2026-02-30"), /YYYY-MM-DD/);
  assert.throws(() => isSundayIso("not-a-date"), /YYYY-MM-DD/);
});
