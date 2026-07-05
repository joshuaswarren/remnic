/**
 * Issue #1578 PR 1 — event-time resolver table tests.
 *
 * The resolver is pure: (expression, anchor) in, interval out.  These tests
 * pin the supported shapes (absolute, relative, since/until, yesterday/today/
 * tomorrow, last/this/next period, month+year, season) and the failure modes
 * (unresolvable garbage, bad anchor, Date overflow).  Per the issue's PR-1
 * guide: ≥25 expressions including timezone-edge anchors, leap day, year-
 * boundary "last December", and unresolvable garbage.
 *
 * Interval semantics are `[validFrom, validUntil)` — inclusive start,
 * exclusive end (AGENTS.md §23).  Date-only END bounds convert to
 * start-of-next-day so the end date itself is excluded.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveEventTime } from "./event-time.js";

// Anchor fixed at 2026-06-15T12:00:00.000Z (a Monday in mid-June 2026).
const ANCHOR = "2026-06-15T12:00:00.000Z";

function dayMs(iso: string): number {
  return Date.parse(iso);
}

test("absolute ISO date resolves validFrom at start-of-day UTC", () => {
  const r = resolveEventTime("2026-03-01", ANCHOR);
  assert.equal(r.ok, true);
  assert.equal(r.validFrom, "2026-03-01T00:00:00.000Z");
  assert.equal(r.validUntil, undefined);
});

test("absolute ISO datetime resolves validFrom verbatim", () => {
  const r = resolveEventTime("2026-03-01T09:30:00Z", ANCHOR);
  assert.equal(r.ok, true);
  assert.equal(r.validFrom, "2026-03-01T09:30:00.000Z");
});

test("since <date> resolves validFrom only", () => {
  const r = resolveEventTime("since 2024-01-15", ANCHOR);
  assert.equal(r.ok, true);
  assert.equal(r.validFrom, "2024-01-15T00:00:00.000Z");
  assert.equal(r.validUntil, undefined);
});

test("until <date> resolves validUntil to start-of-NEXT-day (exclusive end)", () => {
  // "until 2026-03-01" must exclude March 1 itself → exclusive bound at Mar 2.
  const r = resolveEventTime("until 2026-03-01", ANCHOR);
  assert.equal(r.ok, true);
  assert.equal(r.validUntil, "2026-03-02T00:00:00.000Z");
  assert.equal(r.validFrom, undefined);
});

test("through <date> is an alias for until (exclusive end)", () => {
  const r = resolveEventTime("through 2026-03-01", ANCHOR);
  assert.equal(r.ok, true);
  assert.equal(r.validUntil, "2026-03-02T00:00:00.000Z");
});

test("until <datetime> uses the datetime verbatim (not start-of-next-day)", () => {
  const r = resolveEventTime("until 2026-03-01T18:00:00Z", ANCHOR);
  assert.equal(r.ok, true);
  assert.equal(r.validUntil, "2026-03-01T18:00:00.000Z");
});

test("today resolves to the anchor's start-of-day", () => {
  const r = resolveEventTime("today", ANCHOR);
  assert.equal(r.ok, true);
  assert.equal(r.validFrom, "2026-06-15T00:00:00.000Z");
});

test("yesterday resolves to the previous calendar day", () => {
  const r = resolveEventTime("yesterday", ANCHOR);
  assert.equal(r.ok, true);
  assert.equal(r.validFrom, "2026-06-14T00:00:00.000Z");
});

test("tomorrow resolves to the next calendar day", () => {
  const r = resolveEventTime("tomorrow", ANCHOR);
  assert.equal(r.ok, true);
  assert.equal(r.validFrom, "2026-06-16T00:00:00.000Z");
});

test("last week resolves to 7 days before anchor", () => {
  const r = resolveEventTime("last week", ANCHOR);
  assert.equal(r.ok, true);
  assert.equal(r.validFrom, "2026-06-08T00:00:00.000Z");
});

test("this month resolves to the 1st of the anchor's month", () => {
  const r = resolveEventTime("this month", ANCHOR);
  assert.equal(r.ok, true);
  assert.equal(r.validFrom, "2026-06-01T00:00:00.000Z");
});

test("last month resolves to the 1st of the previous month", () => {
  const r = resolveEventTime("last month", ANCHOR);
  assert.equal(r.ok, true);
  assert.equal(r.validFrom, "2026-05-01T00:00:00.000Z");
});

test("next year resolves to Jan 1 of the next year", () => {
  const r = resolveEventTime("next year", ANCHOR);
  assert.equal(r.ok, true);
  assert.equal(r.validFrom, "2027-01-01T00:00:00.000Z");
});

test("last December crosses the year boundary (anchor in June 2026)", () => {
  // Anchor is June 2026; "last December" = December 2025.
  const r = resolveEventTime("last December", ANCHOR);
  assert.equal(r.ok, true);
  assert.equal(r.validFrom, "2025-12-01T00:00:00.000Z");
});

test("next March resolves forward across the year boundary", () => {
  // Anchor June 2026; "next March" = March 2027.
  const r = resolveEventTime("next March", ANCHOR);
  assert.equal(r.ok, true);
  assert.equal(r.validFrom, "2027-03-01T00:00:00.000Z");
});

test("this Q3 resolves to July 1 of the anchor's year", () => {
  const r = resolveEventTime("this Q3", ANCHOR);
  assert.equal(r.ok, true);
  assert.equal(r.validFrom, "2026-07-01T00:00:00.000Z");
});

test("bare month+year resolves to the 1st of that month", () => {
  const r = resolveEventTime("March 2025", ANCHOR);
  assert.equal(r.ok, true);
  assert.equal(r.validFrom, "2025-03-01T00:00:00.000Z");
});

test("abbreviated month+year resolves (Dec 2024)", () => {
  const r = resolveEventTime("Dec 2024", ANCHOR);
  assert.equal(r.ok, true);
  assert.equal(r.validFrom, "2024-12-01T00:00:00.000Z");
});

test("leap day resolves correctly (Feb 29 2024)", () => {
  const r = resolveEventTime("2024-02-29", ANCHOR);
  assert.equal(r.ok, true);
  assert.equal(r.validFrom, "2024-02-29T00:00:00.000Z");
});

test("timezone-edge anchor: 23:59 UTC vs 00:00 UTC do not shift the day", () => {
  // "today" anchored at 23:59:59 UTC must still be the same UTC day.
  const late = resolveEventTime("today", "2026-06-15T23:59:59.000Z");
  assert.equal(late.validFrom, "2026-06-15T00:00:00.000Z");
  // Anchored at 00:00:00 UTC — same day.
  const early = resolveEventTime("today", "2026-06-15T00:00:00.000Z");
  assert.equal(early.validFrom, "2026-06-15T00:00:00.000Z");
});

test("resolution is anchored to the source turn, never Date.now()", () => {
  // "yesterday" against a 2025 anchor must yield a 2025 date, not today's
  // yesterday — this is the replay/import correctness guarantee.
  const r = resolveEventTime("yesterday", "2025-01-10T08:00:00.000Z");
  assert.equal(r.ok, true);
  assert.equal(r.validFrom, "2025-01-09T00:00:00.000Z");
});

// ── Failure modes ─────────────────────────────────────────────────────────

test("empty / whitespace expression → ok:false", () => {
  assert.equal(resolveEventTime("", ANCHOR).ok, false);
  assert.equal(resolveEventTime("   ", ANCHOR).ok, false);
  assert.equal(resolveEventTime(undefined, ANCHOR).ok, false);
  assert.equal(resolveEventTime(null, ANCHOR).ok, false);
});

test("unresolvable garbage → ok:false (no partial output)", () => {
  const r = resolveEventTime("sometime maybe", ANCHOR);
  assert.equal(r.ok, false);
  assert.equal(r.validFrom, undefined);
  assert.equal(r.validUntil, undefined);
});

test("invalid month name → ok:false", () => {
  const r = resolveEventTime("last Smarch", ANCHOR);
  assert.equal(r.ok, false);
});

test("overflowed date (Feb 30) → ok:false, never Invalid Date", () => {
  const r = resolveEventTime("2026-02-30", ANCHOR);
  assert.equal(r.ok, false);
  assert.equal(r.validFrom, undefined);
});

test("malformed anchor timestamp → ok:false (no silent default)", () => {
  const r = resolveEventTime("2026-03-01", "not-a-timestamp");
  assert.equal(r.ok, false);
});

test("since <garbage> → ok:false (does not fall back to anchor)", () => {
  const r = resolveEventTime("since forever", ANCHOR);
  assert.equal(r.ok, false);
});

test("until <invalid month> → ok:false", () => {
  const r = resolveEventTime("until Smarch", ANCHOR);
  assert.equal(r.ok, false);
});

test("case-insensitive: LAST MARCH resolves like last March", () => {
  const r = resolveEventTime("LAST MARCH", ANCHOR);
  assert.equal(r.ok, true);
  // Anchor June 2026 → last March = March 2026.
  assert.equal(r.validFrom, "2026-03-01T00:00:00.000Z");
});

test("until <month-name> end bound lands on start of following month", () => {
  // "until March" against a June anchor → exclusive end at April 1.
  const r = resolveEventTime("until March", ANCHOR);
  assert.equal(r.ok, true);
  assert.equal(r.validUntil, "2026-04-01T00:00:00.000Z");
});

test("interval is half-open: validFrom inclusive, validUntil exclusive", () => {
  // A fact valid "since 2026-03-01" "until 2026-03-01" has a zero-width
  // interval — the two bounds are equal, meaning nothing is inside [a, a).
  const from = resolveEventTime("since 2026-03-01", ANCHOR).validFrom!;
  const until = resolveEventTime("until 2026-03-01", ANCHOR).validUntil!;
  assert.equal(dayMs(until) > dayMs(from), true, "exclusive end must exceed inclusive start");
});

// ── Review fixes (cursor quarter + codex month-year after since) ─────────

test("last quarter moves the quarter INDEX back, not the year (cursor review)", () => {
  // Anchor June 2026 = Q2. "last quarter" must be Q1 = Jan 1 2026, not Apr 1.
  const r = resolveEventTime("last quarter", ANCHOR);
  assert.equal(r.ok, true);
  assert.equal(r.validFrom, "2026-01-01T00:00:00.000Z");
});

test("next quarter moves the quarter INDEX forward (cursor review)", () => {
  // Anchor June 2026 = Q2. "next quarter" must be Q3 = July 1 2026.
  const r = resolveEventTime("next quarter", ANCHOR);
  assert.equal(r.ok, true);
  assert.equal(r.validFrom, "2026-07-01T00:00:00.000Z");
});

test("this quarter stays the current quarter (Q2 = April)", () => {
  const r = resolveEventTime("this quarter", ANCHOR);
  assert.equal(r.ok, true);
  assert.equal(r.validFrom, "2026-04-01T00:00:00.000Z");
});

test("last quarter wraps the year boundary (anchor Q1 → prev Q4 prior year)", () => {
  // Anchor Feb 2026 = Q1. "last quarter" must be Q4 2025 = Oct 1 2025.
  const r = resolveEventTime("last quarter", "2026-02-15T12:00:00.000Z");
  assert.equal(r.ok, true);
  assert.equal(r.validFrom, "2025-10-01T00:00:00.000Z");
});

test("since <month> <year> resolves with the explicit year (codex review)", () => {
  const r = resolveEventTime("since March 2025", ANCHOR);
  assert.equal(r.ok, true);
  assert.equal(r.validFrom, "2025-03-01T00:00:00.000Z");
});

test("since <season> <year> resolves (codex review)", () => {
  const r = resolveEventTime("since spring 2024", ANCHOR);
  assert.equal(r.ok, true);
  assert.equal(r.validFrom, "2024-03-01T00:00:00.000Z");
});

test("until <month> <year> exclusive end is start of following month (codex review)", () => {
  const r = resolveEventTime("until March 2025", ANCHOR);
  assert.equal(r.ok, true);
  assert.equal(r.validUntil, "2025-04-01T00:00:00.000Z");
});

test("since <bare year> resolves to January 1 of that year (codex review r2)", () => {
  const r = resolveEventTime("since 2024", ANCHOR);
  assert.equal(r.ok, true);
  assert.equal(r.validFrom, "2024-01-01T00:00:00.000Z");
});

test("bare four-digit year resolves to January 1 (codex review r2)", () => {
  const r = resolveEventTime("2023", ANCHOR);
  assert.equal(r.ok, true);
  assert.equal(r.validFrom, "2023-01-01T00:00:00.000Z");
});

test("until <bare year> exclusive end is January 1 of the FOLLOWING year (codex review r2)", () => {
  const r = resolveEventTime("until 2024", ANCHOR);
  assert.equal(r.ok, true);
  assert.equal(r.validUntil, "2025-01-01T00:00:00.000Z");
});

test("until end of <month> strips the prefix and resolves (codex review r2)", () => {
  const r = resolveEventTime("until end of March", ANCHOR);
  assert.equal(r.ok, true);
  // "end of March" backwards-looking from June 2026 anchor → exclusive end
  // at the start of the month AFTER March 2026 = April 1 2026.
  assert.equal(r.validUntil, "2026-04-01T00:00:00.000Z");
});

test("until end of <month> <year> strips the prefix and resolves (codex review r2)", () => {
  const r = resolveEventTime("until end of March 2025", ANCHOR);
  assert.equal(r.ok, true);
  assert.equal(r.validUntil, "2025-04-01T00:00:00.000Z");
});
