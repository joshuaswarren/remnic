import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RECURRENCE_MIN_DAYS,
  findRecurringPatterns,
  type WeekDayOccurrence,
} from "./week-recurring.js";

function rangeErrorMatching(pattern: RegExp): (err: unknown) => boolean {
  return (err: unknown) => err instanceof RangeError && pattern.test((err as Error).message);
}

test("default minDays is 3; a key on exactly minDays distinct dates qualifies", () => {
  assert.equal(DEFAULT_RECURRENCE_MIN_DAYS, 3);
  const result = findRecurringPatterns({
    occurrences: [
      { date: "2026-08-10", key: "code", durationMs: 100 },
      { date: "2026-08-11", key: "code", durationMs: 100 },
      { date: "2026-08-12", key: "code", durationMs: 100 },
    ],
  });
  assert.deepEqual(result, [{ key: "code", dayCount: 3, totalDurationMs: 300 }]);
});

test("a key on minDays - 1 distinct dates does not qualify", () => {
  const result = findRecurringPatterns({
    occurrences: [
      { date: "2026-08-10", key: "code", durationMs: 999_999 },
      { date: "2026-08-11", key: "code", durationMs: 999_999 },
    ],
  });
  assert.deepEqual(result, []);
});

test("same-date occurrences count as one day but all durations sum", () => {
  const result = findRecurringPatterns({
    occurrences: [
      { date: "2026-08-10", key: "code", durationMs: 100 },
      { date: "2026-08-10", key: "code", durationMs: 40 },
      { date: "2026-08-11", key: "code", durationMs: 100 },
      { date: "2026-08-12", key: "code", durationMs: 100 },
    ],
  });
  assert.deepEqual(result, [{ key: "code", dayCount: 3, totalDurationMs: 340 }]);
});

test("blank keys are ignored", () => {
  const result = findRecurringPatterns({
    occurrences: [
      { date: "2026-08-10", key: "", durationMs: 100 },
      { date: "2026-08-11", key: "   ", durationMs: 100 },
      { date: "2026-08-12", key: "\t", durationMs: 100 },
    ],
  });
  assert.deepEqual(result, []);
});

test("keys are compared trimmed and case-sensitively", () => {
  const result = findRecurringPatterns({
    occurrences: [
      { date: "2026-08-10", key: "code", durationMs: 100 },
      { date: "2026-08-11", key: " code ", durationMs: 100 },
      { date: "2026-08-12", key: "code", durationMs: 100 },
      { date: "2026-08-10", key: "Code", durationMs: 100 },
      { date: "2026-08-11", key: "Code", durationMs: 100 },
    ],
  });
  // " code " folds into "code" (3 distinct days); "Code" stays separate at 2 days.
  assert.deepEqual(result, [{ key: "code", dayCount: 3, totalDurationMs: 300 }]);
});

test("minDays must be an integer >= 1", () => {
  for (const bad of [0, -3, 1.5]) {
    assert.throws(
      () => findRecurringPatterns({ occurrences: [], minDays: bad }),
      rangeErrorMatching(/minDays/),
    );
  }
  assert.doesNotThrow(() =>
    findRecurringPatterns({
      occurrences: [{ date: "2026-08-10", key: "code", durationMs: 1 }],
      minDays: 1,
    }),
  );
});

test("minDays 1 reports every non-blank key", () => {
  const result = findRecurringPatterns({
    occurrences: [{ date: "2026-08-10", key: "code", durationMs: 5 }],
    minDays: 1,
  });
  assert.deepEqual(result, [{ key: "code", dayCount: 1, totalDurationMs: 5 }]);
});

test("durationMs must be a finite number >= 0", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    assert.throws(
      () =>
        findRecurringPatterns({
          occurrences: [{ date: "2026-08-10", key: "code", durationMs: bad }],
        }),
      rangeErrorMatching(/durationMs/),
    );
  }
});

test("date must be a valid YYYY-MM-DD calendar date", () => {
  for (const bad of ["", "not-a-date", "2026-8-10", "2026-02-30"]) {
    assert.throws(
      () =>
        findRecurringPatterns({
          occurrences: [{ date: bad, key: "code", durationMs: 0 }],
        }),
      rangeErrorMatching(/date/),
    );
  }
});

test("ordering: dayCount desc, then totalDurationMs desc, then key asc", () => {
  const result = findRecurringPatterns({
    minDays: 2,
    occurrences: [
      // alpha: 2 days, biggest total — dayCount still ranks it last.
      { date: "2026-08-10", key: "alpha", durationMs: 999_999 },
      { date: "2026-08-11", key: "alpha", durationMs: 999_999 },
      // beta: 3 days, 10 total — wins the dayCount tie on duration.
      { date: "2026-08-10", key: "beta", durationMs: 4 },
      { date: "2026-08-11", key: "beta", durationMs: 4 },
      { date: "2026-08-12", key: "beta", durationMs: 2 },
      // gamma: 3 days, 8 total — ties delta on both, loses on key ascending.
      { date: "2026-08-10", key: "gamma", durationMs: 8 },
      { date: "2026-08-11", key: "gamma", durationMs: 0 },
      { date: "2026-08-12", key: "gamma", durationMs: 0 },
      // delta: 3 days, 8 total.
      { date: "2026-08-10", key: "delta", durationMs: 8 },
      { date: "2026-08-11", key: "delta", durationMs: 0 },
      { date: "2026-08-12", key: "delta", durationMs: 0 },
    ],
  });
  assert.deepEqual(result.map((p) => p.key), ["beta", "delta", "gamma", "alpha"]);
  assert.deepEqual(result[0], { key: "beta", dayCount: 3, totalDurationMs: 10 });
  assert.deepEqual(result[3], { key: "alpha", dayCount: 2, totalDurationMs: 1_999_998 });
});

test("empty input and no-qualifier input return []", () => {
  assert.deepEqual(findRecurringPatterns({ occurrences: [] }), []);
  assert.deepEqual(
    findRecurringPatterns({
      occurrences: [{ date: "2026-08-10", key: "code", durationMs: 5000 }],
    }),
    [],
  );
});

test("pure: two calls deep-equal and the input is not mutated", () => {
  const occurrences: WeekDayOccurrence[] = [
    { date: "2026-08-10", key: "code", durationMs: 100 },
    { date: "2026-08-10", key: "code", durationMs: 50 },
    { date: "2026-08-11", key: "mail", durationMs: 10 },
    { date: "2026-08-11", key: "code", durationMs: 100 },
    { date: "2026-08-12", key: "code", durationMs: 100 },
  ];
  const snapshot = structuredClone(occurrences);
  const first = findRecurringPatterns({ occurrences });
  const second = findRecurringPatterns({ occurrences });
  assert.deepEqual(first, second);
  assert.deepEqual(first, [{ key: "code", dayCount: 3, totalDurationMs: 350 }]);
  assert.deepEqual(occurrences, snapshot);
});
