import assert from "node:assert/strict";
import test from "node:test";

import { countWeekDays } from "./week-count.js";

test("empty list is 0", () => {
  assert.equal(countWeekDays([]), 0);
});

test("counts unique YYYY-MM-DD dates", () => {
  assert.equal(countWeekDays(["2026-08-17", "2026-08-18", "2026-08-17"]), 2);
  assert.equal(countWeekDays(["2026-08-17", "2026-08-18", "2026-08-19"]), 3);
});

test("drops empty strings and does not mutate", () => {
  const dates = ["2026-08-17", "", "2026-08-18", "", "2026-08-17"];
  assert.equal(countWeekDays(dates), 2);
  assert.deepEqual(dates, ["2026-08-17", "", "2026-08-18", "", "2026-08-17"]);
});
