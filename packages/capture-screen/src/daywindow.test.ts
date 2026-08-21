import assert from "node:assert/strict";
import { test } from "node:test";

import { activityDayWindow } from "./daywindow.js";
import { CaptureInputError } from "./errors.js";

const hours = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 3_600_000;

test("a UTC day is a plain [00:00, next 00:00) window", () => {
  const w = activityDayWindow("2026-07-20", "UTC");
  assert.equal(w.startUtc, "2026-07-20T00:00:00.000Z");
  assert.equal(w.endUtc, "2026-07-21T00:00:00.000Z");
  assert.equal(hours(w.startUtc, w.endUtc), 24);
});

test("the window is half-open: end equals the next day's start", () => {
  const day = activityDayWindow("2026-07-20", "America/New_York");
  const next = activityDayWindow("2026-07-21", "America/New_York");
  assert.equal(day.endUtc, next.startUtc);
});

test("spring-forward local day is 23 hours (DST begins)", () => {
  const w = activityDayWindow("2026-03-08", "America/New_York");
  assert.equal(w.startUtc, "2026-03-08T05:00:00.000Z");
  assert.equal(w.endUtc, "2026-03-09T04:00:00.000Z");
  assert.equal(hours(w.startUtc, w.endUtc), 23);
});

test("fall-back local day is 25 hours (DST ends)", () => {
  const w = activityDayWindow("2026-11-01", "America/New_York");
  assert.equal(w.startUtc, "2026-11-01T04:00:00.000Z");
  assert.equal(w.endUtc, "2026-11-02T05:00:00.000Z");
  assert.equal(hours(w.startUtc, w.endUtc), 25);
});

test("a positive-offset zone shifts the window east of UTC", () => {
  const w = activityDayWindow("2026-07-20", "Asia/Tokyo");
  assert.equal(w.startUtc, "2026-07-19T15:00:00.000Z");
  assert.equal(w.endUtc, "2026-07-20T15:00:00.000Z");
});

test("invalid date and timezone are rejected", () => {
  assert.throws(() => activityDayWindow("2026-02-30", "UTC"), CaptureInputError);
  assert.throws(() => activityDayWindow("2026-07-20", "Not/AZone"), CaptureInputError);
});
