import test from "node:test";
import assert from "node:assert/strict";
import { isTemporalQuery, recencyWindowBoundsFromPrompt, recencyWindowFromPrompt } from "../src/temporal-index.ts";

// ── isTemporalQuery: existing patterns still work ──

test("isTemporalQuery detects 'today'", () => {
  assert.ok(isTemporalQuery("What happened today?"));
});

test("isTemporalQuery detects 'yesterday'", () => {
  assert.ok(isTemporalQuery("Tell me about yesterday's meeting"));
});

test("isTemporalQuery detects 'N days ago'", () => {
  assert.ok(isTemporalQuery("What did we discuss 3 days ago?"));
});

// ── isTemporalQuery: new patterns ──

test("isTemporalQuery detects specific months", () => {
  assert.ok(isTemporalQuery("What happened in March?"));
  assert.ok(isTemporalQuery("during January we decided..."));
  assert.ok(isTemporalQuery("since February"));
});

test("isTemporalQuery detects month + year", () => {
  assert.ok(isTemporalQuery("Tell me about January 2024 changes"));
});

test("isTemporalQuery detects 'N weeks ago'", () => {
  assert.ok(isTemporalQuery("What happened 2 weeks ago?"));
});

test("isTemporalQuery detects 'N months ago'", () => {
  assert.ok(isTemporalQuery("What changed 3 months ago?"));
});

test("isTemporalQuery detects ISO dates", () => {
  assert.ok(isTemporalQuery("What happened on 2024-03-15?"));
});

test("isTemporalQuery detects US date format", () => {
  assert.ok(isTemporalQuery("Meeting on 3/15/2024"));
});

test("isTemporalQuery detects 'last year' and 'this year'", () => {
  assert.ok(isTemporalQuery("What did we do last year?"));
  assert.ok(isTemporalQuery("This year has been busy"));
});

test("isTemporalQuery detects 'last Monday'", () => {
  assert.ok(isTemporalQuery("What happened last Tuesday?"));
});

test("isTemporalQuery detects seasonal references", () => {
  assert.ok(isTemporalQuery("during spring 2025 we launched"));
});

test("isTemporalQuery rejects non-temporal queries", () => {
  assert.ok(!isTemporalQuery("What is the API endpoint for users?"));
  assert.ok(!isTemporalQuery("How does the search algorithm work?"));
});

// ── recencyWindowFromPrompt: new patterns ──

test("recencyWindowFromPrompt handles 'N weeks ago'", () => {
  const now = new Date("2026-03-15T12:00:00Z").getTime();
  const result = recencyWindowFromPrompt("What happened 2 weeks ago?", now);
  assert.equal(result, "2026-03-01");
});

test("recencyWindowFromPrompt handles 'N months ago'", () => {
  const now = new Date("2026-03-15T12:00:00Z").getTime();
  const result = recencyWindowFromPrompt("Changes from 3 months ago", now);
  // 3 * 31 = 93 days back from March 15 → approximately Dec 12
  const resultDate = new Date(result);
  assert.ok(resultDate < new Date("2026-01-01"));
});

test("recencyWindowFromPrompt handles specific month names", () => {
  const now = new Date("2026-03-15T12:00:00Z").getTime();
  const result = recencyWindowFromPrompt("What happened in January?", now);
  assert.equal(result, "2026-01-01");
});

test("recencyWindowFromPrompt handles month + year", () => {
  const now = new Date("2026-03-15T12:00:00Z").getTime();
  const result = recencyWindowFromPrompt("Tell me about March 2025", now);
  assert.equal(result, "2025-03-01");
});

test("recencyWindowFromPrompt handles 'this year'", () => {
  const now = new Date("2026-03-15T12:00:00Z").getTime();
  const result = recencyWindowFromPrompt("What happened this year?", now);
  assert.equal(result, "2026-01-01");
});

test("recencyWindowFromPrompt handles 'last year'", () => {
  const now = new Date("2026-03-15T12:00:00Z").getTime();
  const result = recencyWindowFromPrompt("Projects from last year", now);
  assert.equal(result, "2025-01-01");
});

test("recencyWindowFromPrompt handles ISO dates", () => {
  const now = new Date("2026-03-15T12:00:00Z").getTime();
  const result = recencyWindowFromPrompt("What happened on 2024-03-15?", now);
  assert.equal(result, "2024-03-15");
});

test("recencyWindowFromPrompt handles US dates", () => {
  const now = new Date("2026-03-15T12:00:00Z").getTime();
  const result = recencyWindowFromPrompt("Meeting on 3/15/2024", now);
  assert.equal(result, "2024-03-15");
});

// ── recencyWindowBoundsFromPrompt: N-ago window consistency ──

test("recencyWindowBoundsFromPrompt: 'N days ago' creates 1-day window (toDate = fromDate + 1 day)", () => {
  const now = new Date("2026-03-15T12:00:00Z").getTime();
  const { fromDate, toDate } = recencyWindowBoundsFromPrompt("What happened 3 days ago?", now);
  // fromDate = 2026-03-12, toDate = 2026-03-13 (one-day window, not collapsed to single point)
  assert.equal(fromDate, "2026-03-12");
  assert.equal(toDate, "2026-03-13");
  assert.ok(toDate > fromDate, "toDate must be after fromDate");
});

test("recencyWindowBoundsFromPrompt: 'N weeks ago' creates 7-day window", () => {
  const now = new Date("2026-03-15T12:00:00Z").getTime();
  const { fromDate, toDate } = recencyWindowBoundsFromPrompt("What happened 2 weeks ago?", now);
  // fromDate = 2026-03-01, toDate = 2026-03-08 (one-week window)
  assert.equal(fromDate, "2026-03-01");
  assert.equal(toDate, "2026-03-08");
});

test("recencyWindowBoundsFromPrompt: '1 day ago' does not produce inverted window", () => {
  const now = new Date("2026-03-15T12:00:00Z").getTime();
  const { fromDate, toDate } = recencyWindowBoundsFromPrompt("What happened 1 day ago?", now);
  assert.ok(toDate >= fromDate, "toDate must not precede fromDate");
});

test("recencyWindowBoundsFromPrompt: 'before <month>' uses named month as exclusive upper bound", () => {
  const now = new Date("2026-03-15T12:00:00Z").getTime();
  const { fromDate, toDate } = recencyWindowBoundsFromPrompt("what happened before March?", now);
  // toDate = 2026-03-01 (first day of March, exclusive upper bound — nothing in March)
  // fromDate = 730 days back from now (open lookback)
  assert.equal(toDate, "2026-03-01", "toDate should be the first day of the named month");
  assert.ok(fromDate < toDate, "fromDate must precede toDate");
});

test("recencyWindowBoundsFromPrompt: 'before <month> <year>' uses named month as exclusive upper bound", () => {
  const now = new Date("2026-03-15T12:00:00Z").getTime();
  const { fromDate, toDate } = recencyWindowBoundsFromPrompt("anything before January 2025", now);
  assert.equal(toDate, "2025-01-01");
  assert.ok(fromDate < toDate, "fromDate must precede toDate");
});

test("recencyWindowBoundsFromPrompt: 'before <month> <year>' with explicitly past year does not produce inverted window", () => {
  // On 2026-03-22, "before January 2024" with naive daysBack=730 would give
  // fromDate=2024-03-22 which is AFTER toDate=2024-01-01 — inverted window.
  // The fix anchors fromDate 730 days before the named month start instead.
  const now = new Date("2026-03-22T12:00:00Z").getTime();
  const { fromDate, toDate } = recencyWindowBoundsFromPrompt("before January 2024", now);
  assert.equal(toDate, "2024-01-01", "toDate = first day of named month");
  assert.ok(fromDate < toDate, "fromDate must precede toDate (no inverted window)");
  // fromDate should be anchored ~730 days before 2024-01-01, not before today
  assert.ok(fromDate < "2024-01-01", "fromDate anchored before the named month, not before today");
});
