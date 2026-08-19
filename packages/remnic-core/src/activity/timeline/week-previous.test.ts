import assert from "node:assert/strict";
import test from "node:test";

import { compareWeeklyPreviousPeriod } from "./week-previous.js";

const CURRENT = {
  activeMs: 3_600_000,
  idleMs: 600_000,
  pauseMs: 120_000,
  gapMs: 300_000,
  unclassifiedMs: 60_000,
};

const PREVIOUS = {
  activeMs: 1_800_000,
  idleMs: 900_000,
  pauseMs: 120_000,
  gapMs: 100_000,
  unclassifiedMs: 0,
};

test("null previous is unavailable, not zero", () => {
  const result = compareWeeklyPreviousPeriod({
    previous: null,
    current: CURRENT,
    previousStartUtc: "2026-07-06T00:00:00Z",
    previousEndUtc: "2026-07-13T00:00:00Z",
  });
  assert.deepEqual(result, { available: false });
  assert.equal("deltaActiveMs" in result, false);
});

test("undefined previous is unavailable", () => {
  const result = compareWeeklyPreviousPeriod({
    previous: undefined,
    current: CURRENT,
  });
  assert.deepEqual(result, { available: false });
});

test("previous without timestamps is unavailable", () => {
  const result = compareWeeklyPreviousPeriod({ previous: PREVIOUS, current: CURRENT });
  assert.deepEqual(result, { available: false });
});

test("previous with blank timestamps is unavailable", () => {
  const result = compareWeeklyPreviousPeriod({
    previous: PREVIOUS,
    current: CURRENT,
    previousStartUtc: "   ",
    previousEndUtc: "\t",
  });
  assert.deepEqual(result, { available: false });
});

test("mixed deltas keep sign and trim timestamps", () => {
  const result = compareWeeklyPreviousPeriod({
    previous: PREVIOUS,
    current: CURRENT,
    previousStartUtc: " 2026-07-06T00:00:00Z ",
    previousEndUtc: " 2026-07-13T00:00:00Z ",
  });
  assert.equal(result.available, true);
  if (!result.available) return;
  assert.equal(result.previousStartUtc, "2026-07-06T00:00:00Z");
  assert.equal(result.previousEndUtc, "2026-07-13T00:00:00Z");
  assert.equal(result.deltaActiveMs, 1_800_000);
  assert.equal(result.deltaIdleMs, -300_000);
  assert.equal(result.deltaPauseMs, 0);
  assert.equal(result.deltaGapMs, 200_000);
  assert.equal(result.deltaUnclassifiedMs, 60_000);
});

test("NaN duration on previous throws TypeError", () => {
  assert.throws(
    () =>
      compareWeeklyPreviousPeriod({
        previous: { ...PREVIOUS, gapMs: Number.NaN },
        current: CURRENT,
        previousStartUtc: "2026-07-06T00:00:00Z",
        previousEndUtc: "2026-07-13T00:00:00Z",
      }),
    TypeError,
  );
});

test("Infinity duration on current throws TypeError", () => {
  assert.throws(
    () =>
      compareWeeklyPreviousPeriod({
        previous: PREVIOUS,
        current: { ...CURRENT, activeMs: Number.POSITIVE_INFINITY },
      }),
    /current\.activeMs/,
  );
});

test("all-zero current with present previous is available with negative deltas", () => {
  const zeros = {
    activeMs: 0,
    idleMs: 0,
    pauseMs: 0,
    gapMs: 0,
    unclassifiedMs: 0,
  };
  const result = compareWeeklyPreviousPeriod({
    previous: PREVIOUS,
    current: zeros,
    previousStartUtc: "2026-07-06T00:00:00Z",
    previousEndUtc: "2026-07-13T00:00:00Z",
  });
  assert.equal(result.available, true);
  if (!result.available) return;
  assert.equal(result.deltaActiveMs, -PREVIOUS.activeMs);
  assert.equal(result.deltaIdleMs, -PREVIOUS.idleMs);
  assert.equal(result.deltaPauseMs, -PREVIOUS.pauseMs);
  assert.equal(result.deltaGapMs, -PREVIOUS.gapMs);
  assert.equal(result.deltaUnclassifiedMs, 0);
});
