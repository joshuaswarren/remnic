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

// Read the local wall clock and offset through Intl so the historical-LMT
// fixtures below derive every expectation from the runtime's own tzdata
// instead of hard-coding one tzdata release's seconds (ICU bundles differ:
// Asia/Manila's 1844 LMT is −15:56:08 on recent tzdata, −15:56:00 on older
// ones), mirroring the shared fixtures in @remnic/core's activity digest.
function localStampAt(ms: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year").padStart(4, "0")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}

function offsetMsAt(ms: number, timezone: string): number {
  return Date.parse(`${localStampAt(ms, timezone)}Z`) - ms;
}

test("second-granularity skipped date resolves the true transition instant and owns no interval (Asia/Manila 1844)", () => {
  // Regression for #2821: capture-screen's inlined copy truncated offsets to
  // whole minutes, so the skipped date owned a 60000 ms window instead of
  // none and the 1845-01-01 boundary landed a minute late.
  const tz = "Asia/Manila";
  const lmt = offsetMsAt(Date.parse("1844-12-15T12:00:00Z"), tz); // LMT in force mid-December
  const after = offsetMsAt(Date.parse("1845-06-01T12:00:00Z"), tz); // post-change LMT in force mid-1845
  const iso = (ms: number): string => new Date(ms).toISOString();
  const skip = activityDayWindow("1844-12-31", tz);
  assert.equal(skip.endUtc, skip.startUtc); // zero-width: the day never existed, syncs nothing
  assert.equal(skip.startUtc, iso(Date.parse("1844-12-31T00:00:00Z") - lmt)); // 15:56:08Z on recent tzdata
  const before = activityDayWindow("1844-12-30", tz);
  assert.equal(before.startUtc, iso(Date.parse("1844-12-30T00:00:00Z") - lmt));
  assert.equal(Date.parse(before.endUtc) - Date.parse(before.startUtc), 24 * 3_600_000);
  assert.equal(before.endUtc, skip.startUtc); // contiguous into the skip
  const next = activityDayWindow("1845-01-01", tz);
  assert.equal(next.startUtc, skip.startUtc); // no interval shared with the skip
  assert.equal(next.endUtc, iso(Date.parse("1845-01-02T00:00:00Z") - after));
});

test("repeated midnight at a seconds-carrying LMT starts at the first occurrence (America/Cancun 1922)", () => {
  // Regression for #2821: the inlined copy truncated the −05:47:04 LMT to
  // −05:47, so the day started 4 seconds late and 12m56s of it misattributed
  // to the prior date.
  const tz = "America/Cancun";
  const lmt = offsetMsAt(Date.parse("1921-12-15T12:00:00Z"), tz); // LMT in force mid-December
  const after = offsetMsAt(Date.parse("1922-06-01T12:00:00Z"), tz); // whole-minute offset in force mid-1922
  const iso = (ms: number): string => new Date(ms).toISOString();
  const firstMidnight = Date.parse("1922-01-01T00:00:00Z") - lmt; // 05:47:04Z on recent tzdata
  const repeatedMidnight = Date.parse("1922-01-01T00:00:00Z") - after;
  const w = activityDayWindow("1922-01-01", tz);
  assert.equal(localStampAt(Date.parse(w.startUtc), tz), "1922-01-01T00:00:00");
  if (localStampAt(firstMidnight, tz) === "1922-01-01T00:00:00") {
    assert.equal(w.startUtc, iso(firstMidnight)); // earliest exact midnight wins
    assert.ok(Date.parse(w.startUtc) < repeatedMidnight); // not the later repeated midnight
  }
  assert.equal(w.endUtc, iso(Date.parse("1922-01-02T00:00:00Z") - after));
  const dec31 = activityDayWindow("1921-12-31", tz);
  assert.equal(dec31.endUtc, w.startUtc); // Dec 31 ends at Jan 1's first midnight
});
