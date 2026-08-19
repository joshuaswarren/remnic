import assert from "node:assert/strict";
import test from "node:test";

import { listWeekDates } from "./week-days.js";

test("monday week is seven inclusive dates from start", () => {
  assert.deepEqual(listWeekDates({ weekStartIso: "2026-07-13" }), [
    "2026-07-13",
    "2026-07-14",
    "2026-07-15",
    "2026-07-16",
    "2026-07-17",
    "2026-07-18",
    "2026-07-19",
  ]);
});

test("invalid date throws", () => {
  assert.throws(() => listWeekDates({ weekStartIso: "2026-02-30" }), /YYYY-MM-DD/);
  assert.throws(() => listWeekDates({ weekStartIso: "not-a-date" }), /YYYY-MM-DD/);
});

test("week always has length 7", () => {
  assert.equal(listWeekDates({ weekStartIso: "2026-07-13" }).length, 7);
  assert.equal(listWeekDates({ weekStartIso: "2026-01-28" }).length, 7);
});
