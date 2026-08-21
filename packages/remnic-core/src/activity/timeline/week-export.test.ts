import assert from "node:assert/strict";
import test from "node:test";

import { exportDeterministicWeek } from "./week-export.js";

const WEEK_START = "2026-07-13";

test("empty days export weekStart and timezone with an empty day list", () => {
  const week = exportDeterministicWeek({
    weekStart: WEEK_START,
    timezone: "UTC",
    days: [],
  });
  assert.deepEqual(week, { weekStart: WEEK_START, timezone: "UTC", days: [] });
  assert.equal(
    JSON.stringify(week),
    `{"weekStart":"${WEEK_START}","timezone":"UTC","days":[]}`,
  );
});

test("days are sorted by date regardless of input order", () => {
  const week = exportDeterministicWeek({
    weekStart: WEEK_START,
    timezone: "UTC",
    days: [{ date: "2026-07-15" }, { date: "2026-07-13" }, { date: "2026-07-14" }],
  });
  assert.deepEqual(
    week.days.map((day) => day.date),
    ["2026-07-13", "2026-07-14", "2026-07-15"],
  );
});

test("timezone is echoed verbatim, not normalized", () => {
  const week = exportDeterministicWeek({
    weekStart: WEEK_START,
    timezone: "America/Chicago",
    days: [],
  });
  assert.equal(week.timezone, "America/Chicago");
});

test("input days are not mutated and reruns are stable", () => {
  const input = [{ date: "2026-07-15" }, { date: "2026-07-13" }];
  const first = exportDeterministicWeek({
    weekStart: WEEK_START,
    timezone: "UTC",
    days: input,
  });
  const second = exportDeterministicWeek({
    weekStart: WEEK_START,
    timezone: "UTC",
    days: input,
  });
  assert.deepEqual(
    input.map((day) => day.date),
    ["2026-07-15", "2026-07-13"],
  );
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});
