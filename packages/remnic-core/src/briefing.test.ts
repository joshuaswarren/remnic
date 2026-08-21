/**
 * Regression tests for 5 reviewer findings on the daily briefing module.
 * All fixtures are synthetic — no real user data.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  filterMemoriesByWindow,
  buildRecentEntities,
  eventFallsOnDate,
  parseIcsEvents,
  parseBriefingWindow,
  validateBriefingFormat,
  focusMatchesMemory,
  buildActiveThreads,
  buildBriefing,
  buildChainFollowupGenerator,
  buildOpenCommitments,
  BRIEFING_FOLLOWUP_DEFAULT_MODEL,
} from "./briefing.js";
import type {
  MemoryFile,
  EntityFile,
  CalendarEvent,
  BriefingFocus,
  CalendarSource,
} from "./types.js";
import type { StorageManager } from "./storage.js";

// ──────────────────────────────────────────────────────────────────────────
// Helpers — synthetic fixtures
// ──────────────────────────────────────────────────────────────────────────

function makeMemory(updated: string): MemoryFile {
  return {
    path: "/synthetic/mem.md",
    frontmatter: {
      id: "test-mem",
      category: "fact",
      created: updated,
      updated,
      source: "test",
      confidence: 0.9,
      confidenceTier: "explicit",
      tags: [],
    },
    content: "synthetic memory",
  };
}

function makeEntity(updated: string): EntityFile {
  return {
    name: "SyntheticEntity",
    type: "project",
    updated,
    facts: ["synthetic fact"],
    timeline: [],
    relationships: [],
    activity: [],
    aliases: [],
  };
}

function makeWindow(fromIso: string, toIso: string) {
  return {
    from: new Date(fromIso),
    to: new Date(toIso),
    label: "test-window",
  };
}

function makeCalendarEvent(start: string): CalendarEvent {
  return { id: "evt-synthetic-1", title: "Test Event", start };
}

// ──────────────────────────────────────────────────────────────────────────
// Finding 1 — window upper bound uses exclusive check (ts < toMs)
// ──────────────────────────────────────────────────────────────────────────

test("filterMemoriesByWindow: memory at exact window.to is excluded (exclusive upper bound)", () => {
  // Window: [2026-04-10T00:00:00Z, 2026-04-11T00:00:00Z)
  const window = makeWindow("2026-04-10T00:00:00.000Z", "2026-04-11T00:00:00.000Z");

  // A memory timestamped exactly at midnight — must NOT appear in yesterday's window,
  // or it would double-count against today's window.
  const atMidnight = makeMemory("2026-04-11T00:00:00.000Z");
  const insideWindow = makeMemory("2026-04-10T12:00:00.000Z");

  const result = filterMemoriesByWindow([atMidnight, insideWindow], window);
  assert.equal(result.length, 1, "only the memory inside the window should be included");
  assert.equal(result[0], insideWindow);
});

test("filterMemoriesByWindow: memory at window.from (inclusive) is included", () => {
  const window = makeWindow("2026-04-10T00:00:00.000Z", "2026-04-11T00:00:00.000Z");
  const atFrom = makeMemory("2026-04-10T00:00:00.000Z");
  const result = filterMemoriesByWindow([atFrom], window);
  assert.equal(result.length, 1);
});

// ──────────────────────────────────────────────────────────────────────────
// Finding 2 — runBriefingTool removed (verify no public export)
// ──────────────────────────────────────────────────────────────────────────

test("runBriefingTool is not exported from briefing module", async () => {
  const mod = await import("./briefing.js");
  assert.equal(
    (mod as Record<string, unknown>)["runBriefingTool"],
    undefined,
    "runBriefingTool should not be exported",
  );
});

// ──────────────────────────────────────────────────────────────────────────
// Finding 4 — buildRecentEntities respects upper bound (window.to exclusive)
// ──────────────────────────────────────────────────────────────────────────

test("buildRecentEntities: entity updated after window.to is excluded", () => {
  const window = makeWindow("2026-04-10T00:00:00.000Z", "2026-04-11T00:00:00.000Z");

  // Entity updated today (after window end) — should be excluded from yesterday's briefing.
  const futureEntity = makeEntity("2026-04-11T08:00:00.000Z");
  const inWindowEntity = makeEntity("2026-04-10T15:00:00.000Z");

  const result = buildRecentEntities([futureEntity, inWindowEntity], window, null);
  assert.equal(result.length, 1, "entity updated after window.to should be excluded");
  assert.equal(result[0]!.name, "SyntheticEntity");
  assert.equal(result[0]!.updatedAt, "2026-04-10T15:00:00.000Z");
});

test("buildRecentEntities: entity updated exactly at window.to is excluded (exclusive)", () => {
  const window = makeWindow("2026-04-10T00:00:00.000Z", "2026-04-11T00:00:00.000Z");
  const atTo = makeEntity("2026-04-11T00:00:00.000Z");
  const result = buildRecentEntities([atTo], window, null);
  assert.equal(result.length, 0, "entity at exact window.to must be excluded");
});

// ──────────────────────────────────────────────────────────────────────────
// Finding 5 — eventFallsOnDate uses UTC date, not raw slice
// ──────────────────────────────────────────────────────────────────────────

test("eventFallsOnDate: ISO timestamp with negative UTC offset is normalised to UTC date", () => {
  // 2026-04-10T23:30:00-02:00 is 2026-04-11T01:30:00Z — should match 2026-04-11, not 2026-04-10
  const event = makeCalendarEvent("2026-04-10T23:30:00-02:00");
  assert.equal(eventFallsOnDate(event, "2026-04-11"), true, "UTC date should be 2026-04-11");
  assert.equal(eventFallsOnDate(event, "2026-04-10"), false, "local date slice would give wrong result");
});

test("eventFallsOnDate: plain UTC ISO timestamp matches target date", () => {
  const event = makeCalendarEvent("2026-04-11T01:30:00Z");
  assert.equal(eventFallsOnDate(event, "2026-04-11"), true);
  assert.equal(eventFallsOnDate(event, "2026-04-10"), false);
});

// ──────────────────────────────────────────────────────────────────────────
// Regression — Bug 3 (#396): invalid event.start must not throw RangeError
// ──────────────────────────────────────────────────────────────────────────

test("eventFallsOnDate: invalid start string returns false and does not throw", () => {
  const event = makeCalendarEvent("not-a-date");
  assert.doesNotThrow(() => {
    const result = eventFallsOnDate(event, "2026-04-11");
    assert.equal(result, false, "invalid start should be treated as non-matching");
  });
});

test("eventFallsOnDate: empty start string returns false and does not throw", () => {
  const event = makeCalendarEvent("");
  assert.doesNotThrow(() => {
    const result = eventFallsOnDate(event, "2026-04-11");
    assert.equal(result, false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Finding 2 (#396): ICS floating-time events must not be shifted by server TZ
// ──────────────────────────────────────────────────────────────────────────

test("eventFallsOnDate: floating time 01:00 (early morning) matches its calendar day", () => {
  // "20260411T010000" → normalizeIcsDate → "2026-04-11T01:00:00" (no Z).
  // On a server at UTC-8 this would incorrectly become 2026-04-10 if
  // round-tripped through new Date().toISOString().
  const event = makeCalendarEvent("2026-04-11T01:00:00");
  assert.equal(
    eventFallsOnDate(event, "2026-04-11"),
    true,
    "01:00 floating time must match its own calendar day",
  );
  assert.equal(
    eventFallsOnDate(event, "2026-04-10"),
    false,
    "01:00 floating time must NOT match the previous calendar day",
  );
});

test("eventFallsOnDate: floating time 23:00 (late night) matches its calendar day", () => {
  const event = makeCalendarEvent("2026-04-11T23:00:00");
  assert.equal(
    eventFallsOnDate(event, "2026-04-11"),
    true,
    "23:00 floating time must match its own calendar day",
  );
  assert.equal(
    eventFallsOnDate(event, "2026-04-12"),
    false,
    "23:00 floating time must NOT match the following calendar day",
  );
});

test("eventFallsOnDate: Z-suffixed UTC time compares against UTC date", () => {
  // 2026-04-11T01:30:00Z — UTC date is 2026-04-11
  const event = makeCalendarEvent("2026-04-11T01:30:00Z");
  assert.equal(eventFallsOnDate(event, "2026-04-11"), true);
  assert.equal(eventFallsOnDate(event, "2026-04-10"), false);
});

// ──────────────────────────────────────────────────────────────────────────
// Finding 4 (#396): superseded/archived memories must not appear in briefing
// ──────────────────────────────────────────────────────────────────────────

function makeMemoryWithStatus(
  updated: string,
  status?:
    | "active"
    | "superseded"
    | "archived"
    | "forgotten"
    | "pending_review"
    | "rejected"
    | "quarantined",
): MemoryFile {
  return {
    path: "/synthetic/mem.md",
    frontmatter: {
      id: "test-mem-status",
      category: "commitment",
      created: updated,
      updated,
      source: "test",
      confidence: 0.9,
      confidenceTier: "explicit",
      tags: ["pending"],
      status,
    },
    content: "Follow up on this commitment.",
  };
}

test("filterMemoriesByWindow: superseded commitment within window is excluded", () => {
  const window = makeWindow("2026-04-10T00:00:00.000Z", "2026-04-11T00:00:00.000Z");
  const superseded = makeMemoryWithStatus("2026-04-10T10:00:00.000Z", "superseded");
  const active = makeMemoryWithStatus("2026-04-10T11:00:00.000Z", "active");
  const noStatus = makeMemoryWithStatus("2026-04-10T12:00:00.000Z", undefined);

  const result = filterMemoriesByWindow([superseded, active, noStatus], window);
  assert.equal(result.length, 2, "superseded memory must be excluded");
  assert.ok(!result.some((m) => m.frontmatter.status === "superseded"), "no superseded in result");
});

test("filterMemoriesByWindow: archived memory within window is excluded", () => {
  const window = makeWindow("2026-04-10T00:00:00.000Z", "2026-04-11T00:00:00.000Z");
  const archived = makeMemoryWithStatus("2026-04-10T10:00:00.000Z", "archived");
  const result = filterMemoriesByWindow([archived], window);
  assert.equal(result.length, 0, "archived memory must be excluded from briefing");
});

test("filterMemoriesByWindow: rejected memory within window is excluded from briefing", () => {
  // Governance/disposition workflows mark unsafe or invalid memories as
  // `rejected`. filterMemoriesByWindow must NOT leak them into briefings or
  // downstream follow-up generation, since they represent content explicitly
  // flagged as not-actionable.
  const window = makeWindow("2026-04-10T00:00:00.000Z", "2026-04-11T00:00:00.000Z");
  const rejected = makeMemoryWithStatus("2026-04-10T10:00:00.000Z", "rejected");
  const active = makeMemoryWithStatus("2026-04-10T11:00:00.000Z", "active");
  const result = filterMemoriesByWindow([rejected, active], window);
  assert.equal(result.length, 1, "rejected memory must be excluded from briefing");
  assert.equal(result[0]!.frontmatter.status, "active");
});

test("filterMemoriesByWindow: quarantined memory within window is excluded from briefing", () => {
  // Quarantined memories have been flagged as unsafe by governance review.
  // They must not surface in the briefing, even within the time window.
  const window = makeWindow("2026-04-10T00:00:00.000Z", "2026-04-11T00:00:00.000Z");
  const quarantined = makeMemoryWithStatus("2026-04-10T10:00:00.000Z", "quarantined");
  const active = makeMemoryWithStatus("2026-04-10T11:00:00.000Z", "active");
  const result = filterMemoriesByWindow([quarantined, active], window);
  assert.equal(result.length, 1, "quarantined memory must be excluded from briefing");
  assert.equal(result[0]!.frontmatter.status, "active");
});

test("filterMemoriesByWindow: forgotten memory within window is excluded from briefing", () => {
  const window = makeWindow("2026-04-10T00:00:00.000Z", "2026-04-11T00:00:00.000Z");
  const forgotten = makeMemoryWithStatus("2026-04-10T10:00:00.000Z", "forgotten");
  const active = makeMemoryWithStatus("2026-04-10T11:00:00.000Z", "active");
  const result = filterMemoriesByWindow([forgotten, active], window);
  assert.equal(result.length, 1, "forgotten memory must be excluded from briefing");
  assert.equal(result[0]!.frontmatter.status, "active");
});

test("filterMemoriesByWindow: active and undefined-status memories within window are included", () => {
  const window = makeWindow("2026-04-10T00:00:00.000Z", "2026-04-11T00:00:00.000Z");
  const active = makeMemoryWithStatus("2026-04-10T10:00:00.000Z", "active");
  const noStatus = makeMemoryWithStatus("2026-04-10T11:00:00.000Z", undefined);
  const result = filterMemoriesByWindow([active, noStatus], window);
  assert.equal(result.length, 2, "active and status-less memories must be included");
});

// ──────────────────────────────────────────────────────────────────────────
// Finding A (#396): pending_review memories must be included in briefings
// ──────────────────────────────────────────────────────────────────────────

test("filterMemoriesByWindow: pending_review memory within window is included", () => {
  const window = makeWindow("2026-04-10T00:00:00.000Z", "2026-04-11T00:00:00.000Z");
  const pendingReview = makeMemoryWithStatus("2026-04-10T10:00:00.000Z", "pending_review");
  const result = filterMemoriesByWindow([pendingReview], window);
  assert.equal(result.length, 1, "pending_review memory must be included in briefing");
  assert.equal(result[0]!.frontmatter.status, "pending_review");
});

test("filterMemoriesByWindow: archived memory is excluded but pending_review is included together", () => {
  const window = makeWindow("2026-04-10T00:00:00.000Z", "2026-04-11T00:00:00.000Z");
  const archived = makeMemoryWithStatus("2026-04-10T09:00:00.000Z", "archived");
  const superseded = makeMemoryWithStatus("2026-04-10T10:00:00.000Z", "superseded");
  const pendingReview = makeMemoryWithStatus("2026-04-10T11:00:00.000Z", "pending_review");
  const active = makeMemoryWithStatus("2026-04-10T12:00:00.000Z", "active");

  const result = filterMemoriesByWindow([archived, superseded, pendingReview, active], window);
  assert.equal(result.length, 2, "only archived and superseded should be excluded");
  assert.ok(result.some((m) => m.frontmatter.status === "pending_review"), "pending_review must be present");
  assert.ok(result.some((m) => m.frontmatter.status === "active"), "active must be present");
  assert.ok(!result.some((m) => m.frontmatter.status === "archived"), "archived must not be present");
  assert.ok(!result.some((m) => m.frontmatter.status === "superseded"), "superseded must not be present");
});

// ──────────────────────────────────────────────────────────────────────────
// Finding 7 (#396): --format flag must reject invalid values
// ──────────────────────────────────────────────────────────────────────────

test("validateBriefingFormat: returns null for valid format values", () => {
  assert.equal(validateBriefingFormat("markdown"), null);
  assert.equal(validateBriefingFormat("json"), null);
});

test("validateBriefingFormat: rejects 'text' (not a supported output format)", () => {
  const err = validateBriefingFormat("text");
  assert.ok(typeof err === "string" && err.length > 0, "'text' is not a supported format and must be rejected");
  assert.match(err, /text/, "error message should include the rejected value");
});

test("validateBriefingFormat: returns null when value is undefined (flag not supplied)", () => {
  assert.equal(validateBriefingFormat(undefined), null, "absent flag must not produce an error");
});

test("validateBriefingFormat: returns error string for invalid values like 'jsno'", () => {
  const err = validateBriefingFormat("jsno");
  assert.ok(typeof err === "string" && err.length > 0, "typo should produce an error message");
  assert.match(err, /jsno/, "error should include the invalid value");
});

// ──────────────────────────────────────────────────────────────────────────
// Finding C (#396): compact timezone offsets (±HHMM) must be treated as
// offset-aware (not floating) so events land on the correct UTC date.
// ──────────────────────────────────────────────────────────────────────────

test("eventFallsOnDate: compact negative offset (-0200) is treated as offset-aware", () => {
  // 2026-04-10T23:30:00-0200 = 2026-04-11T01:30:00Z — must match 2026-04-11, not 2026-04-10
  const event = makeCalendarEvent("2026-04-10T23:30:00-0200");
  assert.equal(eventFallsOnDate(event, "2026-04-11"), true, "compact -0200 should land on 2026-04-11 UTC");
  assert.equal(eventFallsOnDate(event, "2026-04-10"), false, "must not match the local date slice");
});

test("eventFallsOnDate: compact positive offset (+0530) is treated as offset-aware", () => {
  // 2026-04-11T04:00:00+0530 = 2026-04-10T22:30:00Z — must match 2026-04-10, not 2026-04-11
  const event = makeCalendarEvent("2026-04-11T04:00:00+0530");
  assert.equal(eventFallsOnDate(event, "2026-04-10"), true, "compact +0530 should land on 2026-04-10 UTC");
  assert.equal(eventFallsOnDate(event, "2026-04-11"), false, "must not match the local date slice");
});

test("eventFallsOnDate: compact +0000 is treated as offset-aware (same as Z)", () => {
  // 2026-04-11T12:00:00+0000 = 2026-04-11T12:00:00Z
  const event = makeCalendarEvent("2026-04-11T12:00:00+0000");
  assert.equal(eventFallsOnDate(event, "2026-04-11"), true, "compact +0000 must match 2026-04-11");
});

test("eventFallsOnDate: floating string without any offset suffix is still treated as floating", () => {
  // 2026-04-10T23:30:00 has no offset — floating, compares date portion directly
  const event = makeCalendarEvent("2026-04-10T23:30:00");
  assert.equal(eventFallsOnDate(event, "2026-04-10"), true, "floating time must match its calendar day");
  assert.equal(eventFallsOnDate(event, "2026-04-11"), false, "floating time must not shift to next day");
});

test("validateBriefingFormat: rejects empty string as invalid", () => {
  const err = validateBriefingFormat("");
  assert.ok(typeof err === "string" && err.length > 0, "empty string is not a valid format");
});

test("validateBriefingFormat: rejects arbitrary strings", () => {
  for (const bad of ["xml", "html", "plain", "MARKDOWN"]) {
    const err = validateBriefingFormat(bad);
    assert.ok(typeof err === "string", `"${bad}" should be rejected`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Finding 1 (#396 new): parseBriefingWindow must reject overflow/huge values
// ──────────────────────────────────────────────────────────────────────────

test("parseBriefingWindow: rejects hugely large week value that would overflow Date", () => {
  // 99999999w far exceeds 100 years — must return null, not Invalid Date.
  const result = parseBriefingWindow("99999999w");
  assert.equal(result, null, "99999999w should be rejected as out-of-bounds");
});

test("parseBriefingWindow: rejects hugely large day value that would overflow Date", () => {
  const result = parseBriefingWindow("99999999d");
  assert.equal(result, null, "99999999d should be rejected as out-of-bounds");
});

test("parseBriefingWindow: rejects hugely large hour value that would overflow Date", () => {
  const result = parseBriefingWindow("99999999h");
  assert.equal(result, null, "99999999h should be rejected as out-of-bounds");
});

test("parseBriefingWindow: rejects a window exactly above the 100-year cap", () => {
  // 36501 days = ~100.003 years — just above the 100-year limit.
  const result = parseBriefingWindow("36501d");
  assert.equal(result, null, "36501d exceeds 100-year cap and must be rejected");
});

test("parseBriefingWindow: accepts a reasonable 10-year (3650d) window", () => {
  // 3650d ≈ 10 years — well within the 100-year cap.
  const result = parseBriefingWindow("3650d");
  assert.ok(result !== null, "3650d (≈10 years) should be accepted");
  assert.equal(result.label, "last 3650d");
  assert.ok(Number.isFinite(result.from.getTime()), "from must be a valid Date");
});

test("parseBriefingWindow: from date is always a valid finite Date for normal inputs", () => {
  for (const token of ["1h", "7d", "2w", "365d", "52w"]) {
    const result = parseBriefingWindow(token);
    assert.ok(result !== null, `"${token}" should parse successfully`);
    assert.ok(Number.isFinite(result.from.getTime()), `"${token}" from must be a valid Date`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// PR #396 Finding 1: eventFallsOnDate — overlapping / multi-day events
// ──────────────────────────────────────────────────────────────────────────

function makeCalendarEventWithEnd(start: string, end: string): CalendarEvent {
  return { id: "evt-synthetic-span", title: "Span Event", start, end };
}

test("eventFallsOnDate: midnight-crossing event appears on both dates (UTC)", () => {
  // Event 2026-04-10T23:30:00Z → 2026-04-11T01:00:00Z spans midnight UTC.
  // It should be visible on both 2026-04-10 and 2026-04-11.
  const event = makeCalendarEventWithEnd("2026-04-10T23:30:00Z", "2026-04-11T01:00:00Z");
  assert.equal(eventFallsOnDate(event, "2026-04-10"), true, "spans midnight — must appear on start date");
  assert.equal(eventFallsOnDate(event, "2026-04-11"), true, "spans midnight — must appear on end date");
  assert.equal(eventFallsOnDate(event, "2026-04-09"), false, "must not appear before start date");
  assert.equal(eventFallsOnDate(event, "2026-04-12"), false, "must not appear after end date");
});

test("eventFallsOnDate: multi-day event appears on every day it spans", () => {
  // Event from 2026-04-09T00:00:00Z to 2026-04-12T00:00:00Z spans 3 full days.
  const event = makeCalendarEventWithEnd("2026-04-09T00:00:00Z", "2026-04-12T00:00:00Z");
  assert.equal(eventFallsOnDate(event, "2026-04-09"), true, "must appear on day 1");
  assert.equal(eventFallsOnDate(event, "2026-04-10"), true, "must appear on day 2");
  assert.equal(eventFallsOnDate(event, "2026-04-11"), true, "must appear on day 3");
  // end is exactly midnight of 2026-04-12 — half-open [start, end) means it
  // does NOT count as active on 2026-04-12.
  assert.equal(eventFallsOnDate(event, "2026-04-12"), false, "event ending at midnight must not appear on that day");
  assert.equal(eventFallsOnDate(event, "2026-04-08"), false, "must not appear before start");
});

test("eventFallsOnDate: event ending exactly at day boundary (midnight) excluded from next day", () => {
  // An event ending at exactly 2026-04-11T00:00:00Z ends at the first instant
  // of 2026-04-11 — half-open semantics means it is NOT active on 2026-04-11.
  const event = makeCalendarEventWithEnd("2026-04-10T22:00:00Z", "2026-04-11T00:00:00Z");
  assert.equal(eventFallsOnDate(event, "2026-04-10"), true, "must appear on start date");
  assert.equal(eventFallsOnDate(event, "2026-04-11"), false, "end-at-midnight must NOT appear on next day");
});

test("eventFallsOnDate: point event (no end) still works correctly after refactor", () => {
  const event = makeCalendarEvent("2026-04-11T10:00:00Z");
  assert.equal(eventFallsOnDate(event, "2026-04-11"), true);
  assert.equal(eventFallsOnDate(event, "2026-04-10"), false);
});

// PR #396 round 5 — PRRT_kwDORJXyws56UJ14: same-day floating spans were dropped
// because the original fix used pure `target < endDate` lexicographic compare
// on date prefixes. A DTSTART:20260411T143000 / DTEND:20260411T150000 event
// has startDate == endDate == "2026-04-11", so `target < endDate` was false
// and the event vanished from its own calendar day.
test("eventFallsOnDate: same-day floating span (no TZID) appears on its calendar day", () => {
  const event = makeCalendarEventWithEnd("2026-04-11T14:30:00", "2026-04-11T15:00:00");
  assert.equal(
    eventFallsOnDate(event, "2026-04-11"),
    true,
    "same-day floating span must match its own calendar day",
  );
  assert.equal(eventFallsOnDate(event, "2026-04-10"), false);
  assert.equal(eventFallsOnDate(event, "2026-04-12"), false);
});

test("eventFallsOnDate: floating span ending exactly at midnight excludes next day", () => {
  // Floating 2026-04-10T22:00:00 → 2026-04-11T00:00:00 — half-open semantics
  // means the end-day (2026-04-11) must NOT be included.
  const event = makeCalendarEventWithEnd("2026-04-10T22:00:00", "2026-04-11T00:00:00");
  assert.equal(eventFallsOnDate(event, "2026-04-10"), true);
  assert.equal(eventFallsOnDate(event, "2026-04-11"), false);
});

test("eventFallsOnDate: floating span crossing midnight appears on both dates", () => {
  // Floating 2026-04-10T23:30:00 → 2026-04-11T01:00:00 crosses the day
  // boundary with a non-zero end time, so the end day is still active.
  const event = makeCalendarEventWithEnd("2026-04-10T23:30:00", "2026-04-11T01:00:00");
  assert.equal(eventFallsOnDate(event, "2026-04-10"), true);
  assert.equal(eventFallsOnDate(event, "2026-04-11"), true);
  assert.equal(eventFallsOnDate(event, "2026-04-12"), false);
});

// ──────────────────────────────────────────────────────────────────────────
// PR #396 Finding 2: parseIcsEvents — RFC 5545 line unfolding
// ──────────────────────────────────────────────────────────────────────────

test("parseIcsEvents: folded SUMMARY line (space continuation) is unfolded correctly", () => {
  // RFC 5545 §3.1 line folding: CRLF followed by a single whitespace character
  // is a fold — the CRLF + that one whitespace byte are removed entirely when
  // unfolding.  Real ICS encoders place the fold at a convenient byte boundary;
  // any space that is part of the content appears at the END of the first
  // physical line (before the CRLF), NOT at the start of the continuation.
  // The leading space on the continuation line is purely the fold indicator
  // and is discarded.  The fixture below reflects that: the first physical line
  // ends with " physical" (space is part of the value) and the continuation
  // starts with " lines" (leading space is the fold marker, discarded).
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:test-fold-1@synthetic",
    "DTSTART:20260411T100000Z",
    "DTEND:20260411T110000Z",
    // Content space is at end of first line; continuation space is fold marker.
    "SUMMARY:This is a long summary folded across two physical ",
    " lines by the ICS encoder",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const events = parseIcsEvents(ics);
  assert.equal(events.length, 1, "should parse exactly one event");
  assert.equal(
    events[0]!.title,
    "This is a long summary folded across two physical lines by the ICS encoder",
    "folded SUMMARY must be unfolded into a single string (fold marker space discarded)",
  );
});

test("parseIcsEvents: folded SUMMARY line (tab continuation) is unfolded correctly", () => {
  // RFC 5545 allows either a space or tab as the fold whitespace character.
  // The leading tab on the continuation line is the fold marker and is discarded.
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:test-fold-tab@synthetic",
    "DTSTART:20260412T090000Z",
    "DTEND:20260412T100000Z",
    "SUMMARY:Tab-folded summary part one ",
    "\tcontinued after a tab",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const events = parseIcsEvents(ics);
  assert.equal(events.length, 1);
  assert.equal(
    events[0]!.title,
    "Tab-folded summary part one continued after a tab",
    "tab-folded SUMMARY must be joined without the fold-marker tab",
  );
});

test("parseIcsEvents: unfolded ICS (no folds) is parsed unchanged", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:test-no-fold@synthetic",
    "DTSTART:20260413T080000Z",
    "DTEND:20260413T090000Z",
    "SUMMARY:Simple one-line title",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const events = parseIcsEvents(ics);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.title, "Simple one-line title");
});

// ──────────────────────────────────────────────────────────────────────────
// Regression — Bug (round 6): zonedFormatToMs must not clamp hour 24 to 0.
//
// Some Intl.DateTimeFormat implementations return "24" when the probed
// instant displays as midnight (00:00) in the target zone.  The old code
// clamped this to 0 without incrementing the day, producing a wallclock-
// as-UTC value that was 24 hours behind the true value.  That corrupted the
// offset calculation in icsWallclockToUtc and placed TZID-bearing ICS events
// on the wrong calendar day.
//
// The fix: pass Number(hh) directly to Date.UTC, which natively rolls
// hour=24 to 00:00:00 of the next day.
//
// Test strategy: exercise icsWallclockToUtc (private) via parseIcsEvents with
// a TZID-bearing event at exactly midnight local time in a UTC-offset zone.
// UTC+05:30 (Asia/Kolkata, no DST) is a reliable probe: midnight local is
// 18:30 the previous UTC day, so the UTC date is always one day behind the
// local date.  This forces icsWallclockToUtc to perform a non-trivial offset
// calculation through zonedFormatToMs.  A 24-hour clamp error in
// zonedFormatToMs would skew the offset by ±86400000 ms, landing the event
// on the wrong UTC day.
// ──────────────────────────────────────────────────────────────────────────

test("parseIcsEvents: TZID midnight event (UTC+5:30) lands on correct UTC day", () => {
  // DTSTART;TZID=Asia/Kolkata:20260412T000000 = 2026-04-11T18:30:00Z
  // Expected UTC date: 2026-04-11.
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:test-tzid-midnight-kolkata@synthetic",
    "DTSTART;TZID=Asia/Kolkata:20260412T000000",
    "DTEND;TZID=Asia/Kolkata:20260412T010000",
    "SUMMARY:Midnight Kolkata event",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const events = parseIcsEvents(ics);
  assert.equal(events.length, 1, "should parse one event");
  const ev = events[0]!;
  // The start must be a UTC-aware ISO string (has Z or offset suffix).
  assert.ok(
    ev.start.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(ev.start),
    `start "${ev.start}" must be UTC-aware (has Z or offset)`,
  );
  // Midnight Asia/Kolkata (+05:30) = 18:30 UTC the *previous* calendar day.
  // So 2026-04-12T00:00:00+05:30 → 2026-04-11T18:30:00Z.
  // The UTC date must be 2026-04-11, NOT 2026-04-12.
  const utcDate = new Date(ev.start).toISOString().slice(0, 10);
  assert.equal(
    utcDate,
    "2026-04-11",
    `midnight Kolkata (UTC+5:30) must land on 2026-04-11 UTC, got "${utcDate}" from start="${ev.start}"`,
  );
});

test("parseIcsEvents: TZID midnight event (UTC-5) lands on correct UTC day", () => {
  // DTSTART;TZID=America/New_York:20260411T000000 in April = EDT (UTC-4).
  // 2026-04-11T00:00:00 EDT = 2026-04-11T04:00:00Z.
  // The UTC date must remain 2026-04-11.
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:test-tzid-midnight-nyc@synthetic",
    "DTSTART;TZID=America/New_York:20260411T000000",
    "DTEND;TZID=America/New_York:20260411T010000",
    "SUMMARY:Midnight New York event",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const events = parseIcsEvents(ics);
  assert.equal(events.length, 1, "should parse one event");
  const ev = events[0]!;
  assert.ok(
    ev.start.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(ev.start),
    `start "${ev.start}" must be UTC-aware`,
  );
  // Midnight EDT (UTC-4): 2026-04-11T00:00:00-04:00 = 2026-04-11T04:00:00Z.
  const utcDate = new Date(ev.start).toISOString().slice(0, 10);
  assert.equal(
    utcDate,
    "2026-04-11",
    `midnight New York (EDT=UTC-4) must land on 2026-04-11 UTC, got "${utcDate}" from start="${ev.start}"`,
  );
});

// ──────────────────────────────────────────────────────────────────────────
// Round 5 Finding 2 (chatgpt-codex-connector): zonedFormatToMs must clamp
// Intl hour "24" to 0 on the same calendar day.
//
// Some Intl.DateTimeFormat implementations return hour="24" for midnight while
// keeping the same calendar date (rather than rolling the date forward and
// returning hour="0").  If the raw "24" is passed to Date.UTC it would roll
// the day forward, producing a UTC timestamp 24 h later than the actual
// midnight, corrupting the zone-offset calculation and misplacing TZID
// midnight events in the daily briefing.
//
// The fix: normalise hour 24 → 0 without touching the day digits so the
// resulting ms is the same midnight, not next-day midnight.
//
// Test strategy: use UTC+1 (Europe/London in summer, BST) where midnight
// local = 23:00 the prior UTC day.  Verifying the UTC date is one day
// behind the local date confirms the offset calculation used the correct
// midnight, not a next-day midnight.
// ──────────────────────────────────────────────────────────────────────────

test("parseIcsEvents: TZID midnight event (UTC+1, Europe/London BST) lands on correct UTC day", () => {
  // 2026-07-01T00:00:00 BST (Europe/London, UTC+1) = 2026-06-30T23:00:00Z.
  // The UTC date must be 2026-06-30, one day behind the local date.
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:test-tzid-midnight-bst@synthetic",
    "DTSTART;TZID=Europe/London:20260701T000000",
    "DTEND;TZID=Europe/London:20260701T010000",
    "SUMMARY:Midnight BST event",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const events = parseIcsEvents(ics);
  assert.equal(events.length, 1, "should parse one event");
  const ev = events[0]!;
  assert.ok(
    ev.start.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(ev.start),
    `start "${ev.start}" must be UTC-aware`,
  );
  // 2026-07-01T00:00 BST = 2026-06-30T23:00Z — UTC date is 2026-06-30.
  const utcDate = new Date(ev.start).toISOString().slice(0, 10);
  assert.equal(
    utcDate,
    "2026-06-30",
    `midnight BST (UTC+1) must land on 2026-06-30 UTC, got "${utcDate}" from start="${ev.start}"`,
  );
});

// ──────────────────────────────────────────────────────────────────────────
// Round 7 Finding 1 (UNBW): BRIEFING_FOLLOWUP_DEFAULT_MODEL constant must be
// exported and must be the same model string used by the extraction engine.
// ──────────────────────────────────────────────────────────────────────────

test("BRIEFING_FOLLOWUP_DEFAULT_MODEL is exported and matches canonical extraction model", () => {
  // The constant must be a non-empty string.
  assert.ok(
    typeof BRIEFING_FOLLOWUP_DEFAULT_MODEL === "string" && BRIEFING_FOLLOWUP_DEFAULT_MODEL.length > 0,
    "BRIEFING_FOLLOWUP_DEFAULT_MODEL must be a non-empty string",
  );
  // Must match the same model family the extraction engine defaults to ("gpt-5.5").
  assert.equal(
    BRIEFING_FOLLOWUP_DEFAULT_MODEL,
    "gpt-5.5",
    "default model must align with the extraction engine default in config.ts",
  );
});

// ──────────────────────────────────────────────────────────────────────────
// Round 7 Finding 3 (UQZW): Midnight fractional end-times must be treated as
// day-exclusive, i.e. "2026-04-11T00:00:00.000" must NOT appear on 2026-04-11.
// ──────────────────────────────────────────────────────────────────────────

test("eventFallsOnDate: floating end '2026-04-11T00:00:00.000' (fractional midnight) is day-exclusive", () => {
  // A cross-day floating event ending at exactly midnight WITH a fractional
  // suffix (.000) was previously treated as "after midnight" by the lexicographic
  // `endTime > "00:00:00"` check (because ".000" makes the string longer).
  // The correct result is: the end day must be excluded (half-open [start, end)).
  const event: CalendarEvent = {
    id: "evt-fractional-midnight",
    title: "Overnight synthetic event",
    start: "2026-04-10T22:00:00",
    end: "2026-04-11T00:00:00.000",
  };
  assert.equal(
    eventFallsOnDate(event, "2026-04-10"),
    true,
    "event must appear on the start day",
  );
  assert.equal(
    eventFallsOnDate(event, "2026-04-11"),
    false,
    "end time '00:00:00.000' is midnight — end day must be excluded under [start, end) semantics",
  );
});

test("eventFallsOnDate: floating end '2026-04-11T00:00:00.001' (just after midnight) includes end day", () => {
  // One millisecond past midnight — the event is still running at the start of
  // 2026-04-11 and should therefore be included on that day.
  const event: CalendarEvent = {
    id: "evt-just-after-midnight",
    title: "Just-past-midnight synthetic event",
    start: "2026-04-10T22:00:00",
    end: "2026-04-11T00:00:00.001",
  };
  assert.equal(eventFallsOnDate(event, "2026-04-11"), true,
    "end time '00:00:00.001' is just past midnight — end day must be included");
  assert.equal(eventFallsOnDate(event, "2026-04-10"), true, "must appear on start day too");
});

// ──────────────────────────────────────────────────────────────────────────
// Round 7 Finding 4 (UQZa): Focus tokens must be normalised to slug form
// before matching entityRef so `person:Jane Doe` matches entityRef
// `"person-jane-doe"`.
// ──────────────────────────────────────────────────────────────────────────

function makeMemoryWithEntityRef(entityRef: string, content = "synthetic"): MemoryFile {
  return {
    path: "/synthetic/entity-ref-mem.md",
    frontmatter: {
      id: "test-slug-mem",
      category: "fact",
      created: "2026-04-10T10:00:00.000Z",
      updated: "2026-04-10T10:00:00.000Z",
      source: "test",
      confidence: 0.9,
      confidenceTier: "explicit",
      tags: [],
      entityRef,
    },
    content,
  };
}

test("focusMatchesMemory: person:Jane Doe matches entityRef 'person-jane-doe' via slug", () => {
  // entityRef is stored as a slug; the raw focus value "Jane Doe" would never
  // appear in the entityRef string.  The fix derives the slug form
  // "person-jane-doe" and matches it against the entityRef.
  const memory = makeMemoryWithEntityRef("person-jane-doe");
  const focus: BriefingFocus = { type: "person", value: "Jane Doe" };
  assert.equal(
    focusMatchesMemory(memory, focus),
    true,
    "person:Jane Doe must match entityRef 'person-jane-doe' after slug normalization",
  );
});

test("focusMatchesMemory: project:My Project matches entityRef 'project-my-project' via slug", () => {
  const memory = makeMemoryWithEntityRef("project-my-project");
  const focus: BriefingFocus = { type: "project", value: "My Project" };
  assert.equal(
    focusMatchesMemory(memory, focus),
    true,
    "project focus slug must match stored entityRef",
  );
});

test("focusMatchesMemory: slug match does not produce false positives for unrelated entityRef", () => {
  const memory = makeMemoryWithEntityRef("person-john-smith");
  const focus: BriefingFocus = { type: "person", value: "Jane Doe" };
  assert.equal(
    focusMatchesMemory(memory, focus),
    false,
    "person-jane-doe slug must not match person-john-smith entityRef",
  );
});

test("focusMatchesMemory: raw content match still works alongside slug fix", () => {
  // The existing raw-substring path must remain intact.
  const memory = makeMemoryWithEntityRef("", "Jane Doe signed the contract.");
  const focus: BriefingFocus = { type: "person", value: "Jane Doe" };
  assert.equal(
    focusMatchesMemory(memory, focus),
    true,
    "raw content match must still work after adding slug logic",
  );
});

// ──────────────────────────────────────────────────────────────────────────
// Round 8 Finding UQZW+UXE5: Midnight end-time HH:MM form must be excluded
// ──────────────────────────────────────────────────────────────────────────

test("eventFallsOnDate: floating end '2026-04-11T00:00' (HH:MM, no seconds) is day-exclusive", () => {
  // ISO floating-time values with no seconds component (e.g. "2026-04-11T00:00")
  // are valid and must be treated as exact midnight — the end day must be excluded
  // under half-open [start, end) semantics.
  const event: CalendarEvent = {
    id: "evt-hhmm-midnight",
    title: "Overnight event HH:MM end",
    start: "2026-04-10T22:00:00",
    end: "2026-04-11T00:00",
  };
  assert.equal(
    eventFallsOnDate(event, "2026-04-10"),
    true,
    "event must appear on start day",
  );
  assert.equal(
    eventFallsOnDate(event, "2026-04-11"),
    false,
    "end time '00:00' (HH:MM midnight) must be treated as day-exclusive",
  );
});

test("eventFallsOnDate: floating end '2026-04-11T01:00' (HH:MM, non-midnight) includes end day", () => {
  // Non-midnight HH:MM end-time: the event is still running on the end day.
  const event: CalendarEvent = {
    id: "evt-hhmm-non-midnight",
    title: "Cross-day event non-midnight HH:MM end",
    start: "2026-04-10T22:00:00",
    end: "2026-04-11T01:00",
  };
  assert.equal(eventFallsOnDate(event, "2026-04-11"), true, "non-midnight HH:MM end must include end day");
  assert.equal(eventFallsOnDate(event, "2026-04-10"), true, "must appear on start day too");
});

// ──────────────────────────────────────────────────────────────────────────
// Round 8 Finding UNBW: Model-not-found errors must produce user-friendly message
// ──────────────────────────────────────────────────────────────────────────

// Minimal StorageManager stub that returns empty arrays (no memories/entities).
function makeEmptyStorage(): StorageManager {
  return {
    readAllMemories: async () => [],
    readAllEntityFiles: async () => [],
  } as unknown as StorageManager;
}
test("buildBriefing reads only memories updated inside the briefing window", async () => {
  let readWindowOptions: { updatedAfter?: Date } | undefined;
  const atWindowStart = makeMemory("2026-04-10T00:00:00.000Z");
  const atWindowEnd = makeMemory("2026-04-11T00:00:00.000Z");
  const storage = {
    readAllMemories: async () => {
      throw new Error("full corpus read must not be used by briefing");
    },
    readMemoriesWindow: async (options: { updatedAfter?: Date }) => {
      readWindowOptions = options;
      return {
        memories: [atWindowStart, atWindowEnd],
        filePaths: [atWindowStart.path, atWindowEnd.path],
      };
    },
    readAllEntityFiles: async () => [],
  } as unknown as StorageManager;

  const result = await buildBriefing({
    storage,
    window: makeWindow("2026-04-10T00:00:00.000Z", "2026-04-11T00:00:00.000Z"),
    allowLlm: false,
    now: new Date("2026-04-11T10:00:00.000Z"),
  });

  assert.equal(readWindowOptions?.updatedAfter?.toISOString(), "2026-04-10T00:00:00.000Z");
  assert.equal(result.sections.activeThreads.length, 1);
});


test("buildBriefing excludes support passport records from generated context", async () => {
  const generatedPrompts: unknown[] = [];
  const privateMemory: MemoryFile = {
    ...makeMemory("2026-04-10T12:00:00.000Z"),
    frontmatter: {
      ...makeMemory("2026-04-10T12:00:00.000Z").frontmatter,
      tags: ["support-passport-card"],
    },
    content: "Private support statement",
  };
  const publicMemory: MemoryFile = {
    ...makeMemory("2026-04-10T13:00:00.000Z"),
    frontmatter: {
      ...makeMemory("2026-04-10T13:00:00.000Z").frontmatter,
      id: "public-memory",
    },
    content: "Public project update",
  };
  const storage = {
    readAllMemories: async () => [privateMemory, publicMemory],
    readAllEntityFiles: async () => [],
  } as unknown as StorageManager;

  const result = await buildBriefing({
    storage,
    window: makeWindow("2026-04-10T00:00:00.000Z", "2026-04-11T00:00:00.000Z"),
    followupGenerator: async (prompt) => {
      generatedPrompts.push(prompt);
      return [];
    },
    now: new Date("2026-04-11T10:00:00.000Z"),
  });

  assert.equal(result.markdown.includes(privateMemory.content), false);
  assert.equal(JSON.stringify(generatedPrompts).includes(privateMemory.content), false);
  assert.equal(result.markdown.includes(publicMemory.content), true);
});

test("buildBriefing: model-not-found 400 error produces user-friendly followupsUnavailableReason", async () => {
  // Inject a mock generator that throws an error resembling a Responses API
  // 400 "model does not exist" response.
  const result = await buildBriefing({
    storage: makeEmptyStorage(),
    allowLlm: true,
    openaiApiKey: "sk-synthetic-key",
    followupGenerator: async () => {
      throw new Error("The model 'gpt-5.5' does not exist");
    },
    now: new Date("2026-04-11T10:00:00.000Z"),
  });

  assert.ok(
    typeof result.followupsUnavailableReason === "string",
    "followupsUnavailableReason must be set on model error",
  );
  assert.ok(
    result.followupsUnavailableReason!.includes("model"),
    `reason must mention 'model': got "${result.followupsUnavailableReason}"`,
  );
  assert.ok(
    result.followupsUnavailableReason!.includes("not available"),
    `reason must include 'not available': got "${result.followupsUnavailableReason}"`,
  );
});

test("buildBriefing: model 'not found' phrasing also produces user-friendly message", async () => {
  const result = await buildBriefing({
    storage: makeEmptyStorage(),
    allowLlm: true,
    openaiApiKey: "sk-synthetic-key",
    followupGenerator: async () => {
      throw new Error("model not found: gpt-5.5");
    },
    now: new Date("2026-04-11T10:00:00.000Z"),
  });

  assert.ok(result.followupsUnavailableReason!.includes("not available"),
    `'not found' phrasing must trigger friendly message: got "${result.followupsUnavailableReason}"`);
});

test("buildBriefing: unrelated LLM errors still produce generic message (no false positive)", async () => {
  const result = await buildBriefing({
    storage: makeEmptyStorage(),
    allowLlm: true,
    openaiApiKey: "sk-synthetic-key",
    followupGenerator: async () => {
      throw new Error("network timeout");
    },
    now: new Date("2026-04-11T10:00:00.000Z"),
  });

  assert.ok(
    result.followupsUnavailableReason!.includes("LLM follow-ups failed"),
    `unrelated errors must use generic message: got "${result.followupsUnavailableReason}"`,
  );
  assert.ok(
    !result.followupsUnavailableReason!.includes("not available"),
    "unrelated errors must NOT produce model-not-available message",
  );
});

test("buildChainFollowupGenerator accepts markdown-fenced followup JSON", async () => {
  const generator = buildChainFollowupGenerator({
    chatCompletion: async () => ({
      content: [
        "```json",
        "{",
        '  "followups": [',
        '    { "text": "Check the launch plan", "rationale": "Open commitment found" }',
        "  ]",
        "}",
        "```",
      ].join("\n"),
    }),
  });

  const followups = await generator({
    sections: {
      activeThreads: [],
      recentEntities: [],
      openCommitments: [{ id: "commit-1", kind: "commitment", text: "Finish launch plan" }],
      suggestedFollowups: [],
    },
    windowLabel: "today",
    maxFollowups: 3,
  });

  assert.deepEqual(followups, [
    {
      text: "Check the launch plan",
      rationale: "Open commitment found",
    },
  ]);
});

test("buildChainFollowupGenerator skips parseable non-followup JSON candidates", async () => {
  const generator = buildChainFollowupGenerator({
    chatCompletion: async () => ({
      content: [
        '{ "metadata": "not followups" }',
        "```json",
        "{",
        '  "followups": [',
        '    { "text": "Review the launch plan", "rationale": "Actual follow-up block" }',
        "  ]",
        "}",
        "```",
      ].join("\n"),
    }),
  });

  const followups = await generator({
    sections: {
      activeThreads: [],
      recentEntities: [],
      openCommitments: [{ id: "commit-1", kind: "commitment", text: "Finish launch plan" }],
      suggestedFollowups: [],
    },
    windowLabel: "today",
    maxFollowups: 3,
  });

  assert.deepEqual(followups, [
    {
      text: "Review the launch plan",
      rationale: "Actual follow-up block",
    },
  ]);
});

// ──────────────────────────────────────────────────────────────────────────
// Round 8 Finding UXE4: buildActiveThreads must recompute reason from newer memory
// ──────────────────────────────────────────────────────────────────────────

function makeMemoryWithCategory(
  id: string,
  category: "fact" | "commitment" | "decision" | "correction",
  updated: string,
  entityRef?: string,
): MemoryFile {
  return {
    path: `/synthetic/${id}.md`,
    frontmatter: {
      id,
      category,
      created: updated,
      updated,
      source: "test",
      confidence: 0.9,
      confidenceTier: "explicit",
      tags: entityRef ? [] : ["topic:synthetic-thread"],
      entityRef,
    },
    content: `Content for ${id}`,
  };
}

test("buildActiveThreads: reason is updated when a newer memory replaces an older one", () => {
  // Both memories share the same thread key (same entityRef → same bucket).
  // The first is a 'fact' (reason="recent activity"), the newer is a 'decision'
  // (reason="recent decision").  The resulting thread must reflect the newer reason.
  const olderFact = makeMemoryWithCategory("mem-old", "fact", "2026-04-10T08:00:00.000Z", "topic-alpha");
  const newerDecision = makeMemoryWithCategory("mem-new", "decision", "2026-04-10T12:00:00.000Z", "topic-alpha");

  const threads = buildActiveThreads([olderFact, newerDecision]);

  assert.equal(threads.length, 1, "both memories share a thread key — expect one thread");
  assert.equal(
    threads[0]!.reason,
    "recent decision",
    "reason must reflect the newer memory's category, not the older one",
  );
});

test("buildActiveThreads: reason of first (only) memory is preserved correctly", () => {
  const commitment = makeMemoryWithCategory("mem-commit", "commitment", "2026-04-10T09:00:00.000Z", "topic-beta");
  const threads = buildActiveThreads([commitment]);
  assert.equal(threads[0]!.reason, "open commitment");
});

test("buildActiveThreads: older memory processed first does not win reason when newer arrives", () => {
  // Process older memory first in the array — the newer one that arrives second
  // should update both updatedAt AND reason.
  const olderCorrection = makeMemoryWithCategory(
    "mem-correction", "correction", "2026-04-09T10:00:00.000Z", "topic-gamma",
  );
  const newerFact = makeMemoryWithCategory(
    "mem-fact", "fact", "2026-04-10T14:00:00.000Z", "topic-gamma",
  );

  const threads = buildActiveThreads([olderCorrection, newerFact]);
  assert.equal(threads[0]!.reason, "recent activity", "newer memory is a fact → 'recent activity'");
  assert.equal(threads[0]!.updatedAt, "2026-04-10T14:00:00.000Z");
});

// ──────────────────────────────────────────────────────────────────────────
// Round 8 Finding UXJH: Failing calendar source must suppress calendar section
// ──────────────────────────────────────────────────────────────────────────

test("buildBriefing: failing calendar source suppresses Today's calendar section in markdown", async () => {
  const throwingCalendar: CalendarSource = {
    eventsForDate: async (_dateIso: string) => {
      throw new Error("synthetic calendar fetch failure");
    },
  };

  const result = await buildBriefing({
    storage: makeEmptyStorage(),
    allowLlm: false,
    calendarSource: throwingCalendar,
    now: new Date("2026-04-11T10:00:00.000Z"),
  });

  assert.ok(
    !result.markdown.includes("Today's calendar"),
    "markdown must NOT include 'Today's calendar' when the calendar source throws",
  );
});

test("buildBriefing: empty calendar (no events) still renders Today's calendar section", async () => {
  const emptyCalendar: CalendarSource = {
    eventsForDate: async (_dateIso: string) => [],
  };

  const result = await buildBriefing({
    storage: makeEmptyStorage(),
    allowLlm: false,
    calendarSource: emptyCalendar,
    now: new Date("2026-04-11T10:00:00.000Z"),
  });

  // Empty calendar = source responded with [] — section should appear with "no events" placeholder.
  assert.ok(
    result.markdown.includes("Today's calendar"),
    "markdown must include 'Today's calendar' section even when there are no events",
  );
});

// ──────────────────────────────────────────────────────────────────────────
// Round 9 Finding UZTO: Validate floating-event end timestamps before range checks
// ──────────────────────────────────────────────────────────────────────────

test("eventFallsOnDate: floating event with malformed end only appears on its start date", () => {
  // A JSON calendar feed emits end: "invalid" for a floating-time event.
  // Without validation, end.slice(0, 10) produces "invalid   " and lexicographic
  // comparison treats the event as active on every day after start.
  const event = makeCalendarEventWithEnd("2026-04-11T09:00", "invalid");

  // Must appear on its start date (event is rendered, not dropped).
  assert.equal(
    eventFallsOnDate(event, "2026-04-11"),
    true,
    "malformed-end event must still appear on its start date",
  );

  // Must NOT bleed into subsequent days.
  assert.equal(
    eventFallsOnDate(event, "2026-04-12"),
    false,
    "malformed-end event must NOT appear on the day after start",
  );
  assert.equal(
    eventFallsOnDate(event, "2026-04-13"),
    false,
    "malformed-end event must NOT appear two days after start",
  );

  // Must not appear before start either.
  assert.equal(
    eventFallsOnDate(event, "2026-04-10"),
    false,
    "malformed-end event must NOT appear before its start date",
  );
});

test("eventFallsOnDate: floating event with empty-string end is treated as single-day", () => {
  // Edge case: end is present but is an empty string (structurally invalid).
  const event: CalendarEvent = {
    id: "evt-synthetic-empty-end",
    title: "Empty End Event",
    start: "2026-04-11T10:00",
    end: "",
  };

  assert.equal(
    eventFallsOnDate(event, "2026-04-11"),
    true,
    "empty-end event must appear on its start date",
  );
  assert.equal(
    eventFallsOnDate(event, "2026-04-12"),
    false,
    "empty-end event must NOT bleed into the next day",
  );
});

// Round 10 Finding UhLg: Date-only floating end values must enforce [start, end) semantics
// ──────────────────────────────────────────────────────────────────────────

test("eventFallsOnDate: floating all-day event with date-only end excludes end date ([start, end))", () => {
  // A JSON calendar feed emits date-only start/end (no time component).
  // e.g. start: "2026-04-10", end: "2026-04-11" should render only on 2026-04-10.
  // Before UhLg fix: endTime was "" which did not match the midnight regex, so
  // endActiveOnEndDay was true and the event incorrectly appeared on 2026-04-11.
  const event = makeCalendarEventWithEnd("2026-04-10", "2026-04-11");

  assert.equal(
    eventFallsOnDate(event, "2026-04-10"),
    true,
    "date-only all-day event must appear on its start date",
  );
  assert.equal(
    eventFallsOnDate(event, "2026-04-11"),
    false,
    "date-only end must be exclusive — event must NOT appear on end date",
  );
  assert.equal(
    eventFallsOnDate(event, "2026-04-09"),
    false,
    "date-only all-day event must NOT appear before its start date",
  );
});

test("eventFallsOnDate: floating multi-day all-day event with date-only end spans [start, end)", () => {
  // A two-day all-day event: start "2026-04-10", end "2026-04-12"
  // Should appear on 2026-04-10 and 2026-04-11, but NOT on 2026-04-12.
  const event = makeCalendarEventWithEnd("2026-04-10", "2026-04-12");

  assert.equal(
    eventFallsOnDate(event, "2026-04-09"),
    false,
    "must not appear before start",
  );
  assert.equal(
    eventFallsOnDate(event, "2026-04-10"),
    true,
    "must appear on start date",
  );
  assert.equal(
    eventFallsOnDate(event, "2026-04-11"),
    true,
    "must appear on intermediate day",
  );
  assert.equal(
    eventFallsOnDate(event, "2026-04-12"),
    false,
    "date-only end must be exclusive — must NOT appear on end date",
  );
  assert.equal(
    eventFallsOnDate(event, "2026-04-13"),
    false,
    "must not appear after end",
  );
});

// Round 10 Finding UhLh: Impossible end dates (passing regex but not real) must fall back
// ──────────────────────────────────────────────────────────────────────────

test("eventFallsOnDate: floating event with impossible end date '2026-99-99' is treated as single-day", () => {
  // The regex /^\d{4}-\d{2}-\d{2}.../ accepts month 99 and day 99.
  // Without real-date validation, JavaScript auto-corrects "2026-99-99" to a
  // future date and the event appears on many unrelated days.
  const event = makeCalendarEventWithEnd("2026-04-11T09:00", "2026-99-99");

  assert.equal(
    eventFallsOnDate(event, "2026-04-11"),
    true,
    "impossible-end event must still appear on its start date",
  );
  assert.equal(
    eventFallsOnDate(event, "2026-04-12"),
    false,
    "impossible-end event must NOT bleed into subsequent days",
  );
  // Verify it does not appear on the auto-corrected future date either.
  assert.equal(
    eventFallsOnDate(event, "2035-03-09"),
    false,
    "impossible-end event must NOT appear on the JavaScript-autocorrected date",
  );
});

test("eventFallsOnDate: floating event with impossible end date '2026-01-99' is treated as single-day", () => {
  // "2026-01-99" passes the regex but is impossible; Date auto-corrects to "2026-04-09".
  const event = makeCalendarEventWithEnd("2026-01-10T09:00", "2026-01-99");

  assert.equal(
    eventFallsOnDate(event, "2026-01-10"),
    true,
    "impossible-end event must appear on its start date",
  );
  assert.equal(
    eventFallsOnDate(event, "2026-04-09"),
    false,
    "impossible-end event must NOT appear on the JS-autocorrected date",
  );
});

// Round 11 Finding PRRT_kwDORJXyws56U7at: Validate time components of floating-event end timestamps
// ──────────────────────────────────────────────────────────────────────────────────────────────────
// The regex and date-round-trip checks (UhLh) only cover the YYYY-MM-DD portion.
// Invalid time fields (hour > 23, minute > 59, second > 59) pass those checks
// but cause JavaScript's Date to roll over into unrelated future dates, polluting
// the daily calendar output.

test("eventFallsOnDate: floating event with bad month '2026-13-01T10:00:00' is treated as single-day", () => {
  // Month 13 passes the shape regex (\d{2}) but is not a real calendar month.
  // The date round-trip check must catch this and fall back to single-day semantics.
  const event = makeCalendarEventWithEnd("2026-04-11T09:00", "2026-13-01T10:00:00");

  assert.equal(
    eventFallsOnDate(event, "2026-04-11"),
    true,
    "bad-month end event must still appear on its start date",
  );
  assert.equal(
    eventFallsOnDate(event, "2026-04-12"),
    false,
    "bad-month end event must NOT bleed into subsequent days",
  );
  // JS auto-corrects 2026-13-01 to 2027-01-01 — verify that date is excluded too.
  assert.equal(
    eventFallsOnDate(event, "2027-01-01"),
    false,
    "bad-month end event must NOT appear on the JS-autocorrected date",
  );
});

test("eventFallsOnDate: floating event with bad day '2026-02-30T10:00:00' is treated as single-day", () => {
  // February 30 passes the shape regex but is never a real date.
  // The date round-trip check catches this and falls back to single-day semantics.
  const event = makeCalendarEventWithEnd("2026-02-10T09:00", "2026-02-30T10:00:00");

  assert.equal(
    eventFallsOnDate(event, "2026-02-10"),
    true,
    "bad-day end event must still appear on its start date",
  );
  assert.equal(
    eventFallsOnDate(event, "2026-02-11"),
    false,
    "bad-day end event must NOT bleed into subsequent days",
  );
  // JS auto-corrects 2026-02-30 to 2026-03-02 — verify that date is excluded too.
  assert.equal(
    eventFallsOnDate(event, "2026-03-02"),
    false,
    "bad-day end event must NOT appear on the JS-autocorrected date",
  );
});

test("eventFallsOnDate: floating event with bad hour '2026-04-11T25:00:00' is treated as single-day", () => {
  // Hour 25 passes the shape regex (\d{2}) and the date portion "2026-04-11" is
  // real, but 25:00:00 is not a valid time.  Without the time-range guard, JS
  // rolls this over to the next day and the event bleeds into 2026-04-12.
  const event = makeCalendarEventWithEnd("2026-04-11T09:00", "2026-04-11T25:00:00");

  assert.equal(
    eventFallsOnDate(event, "2026-04-11"),
    true,
    "bad-hour end event must still appear on its start date",
  );
  assert.equal(
    eventFallsOnDate(event, "2026-04-12"),
    false,
    "bad-hour end event must NOT bleed into the JS-autocorrected next day",
  );
});

// ──────────────────────────────────────────────────────────────────────────
// Round 12 PRRT_kwDORJXyws56U_7O: Validate floating START timestamp before
// date-slice comparisons (symmetric with end validation added in earlier rounds)
// ──────────────────────────────────────────────────────────────────────────
// JavaScript normalizes impossible dates silently: new Date("2026-02-30T10:00")
// returns a valid Date object pointing to 2026-03-02, so the old
// "isFinite(probe.getTime())" guard allowed malformed starts through.
// With an end present the bad start date slice was then used in lexicographic
// overlap logic, placing the event on unrelated real days.

test("eventFallsOnDate: floating event with impossible start date '2026-02-30T10:00:00' is skipped", () => {
  // February 30 is not a real date; JavaScript auto-corrects to 2026-03-02.
  // The old guard (isFinite check) did not catch this.
  // After the fix the event must be silently skipped (returns false for all dates).
  const event = makeCalendarEventWithEnd("2026-02-30T10:00:00", "2026-02-30T11:00:00");

  assert.equal(
    eventFallsOnDate(event, "2026-02-28"),
    false,
    "impossible-start event must NOT appear on surrounding real days",
  );
  assert.equal(
    eventFallsOnDate(event, "2026-03-02"),
    false,
    "impossible-start event must NOT appear on the JS-autocorrected date",
  );
});

test("eventFallsOnDate: floating event with impossible start date '2026-99-99T00:00:00' is skipped", () => {
  // Month 99 / day 99 passes the shape regex but is not a real date.
  const event = makeCalendarEvent("2026-99-99T00:00:00");

  assert.equal(
    eventFallsOnDate(event, "2026-04-11"),
    false,
    "impossible start month/day must result in event being skipped",
  );
});

test("eventFallsOnDate: floating event with impossible start month '2026-13-01T10:00:00' is skipped", () => {
  // Month 13 passes the shape regex but is not a real month.
  const event = makeCalendarEvent("2026-13-01T10:00:00");

  assert.equal(
    eventFallsOnDate(event, "2026-04-11"),
    false,
    "impossible start month must result in event being skipped",
  );
  // JS auto-corrects 2026-13-01 to 2027-01-01 — also excluded.
  assert.equal(
    eventFallsOnDate(event, "2027-01-01"),
    false,
    "impossible start month must NOT appear on JS-autocorrected date",
  );
});

test("eventFallsOnDate: floating event with out-of-range start hour '2026-04-11T25:00:00' is skipped", () => {
  // Hour 25 passes the shape regex and date round-trip, but is not a valid time.
  // Without the time-range check this would bleed into 2026-04-12.
  const event = makeCalendarEvent("2026-04-11T25:00:00");

  assert.equal(
    eventFallsOnDate(event, "2026-04-11"),
    false,
    "out-of-range start hour must result in event being skipped",
  );
  assert.equal(
    eventFallsOnDate(event, "2026-04-12"),
    false,
    "out-of-range start hour must NOT appear on the JS-autocorrected date",
  );
});

test("eventFallsOnDate: floating event with out-of-range start time '2026-04-11T10:99:00' is skipped", () => {
  // Minute 99 passes the shape regex but is an invalid time component.
  const event = makeCalendarEventWithEnd("2026-04-11T10:99:00", "2026-04-11T11:00:00");

  assert.equal(
    eventFallsOnDate(event, "2026-04-11"),
    false,
    "out-of-range start minute must result in event being skipped",
  );
});

// ──────────────────────────────────────────────────────────────────────────
// Round 8 P2 Finding 2 (briefing.ts:254): Surface calendar source failures
// ──────────────────────────────────────────────────────────────────────────

test("buildBriefing: failing calendar source populates calendarSourceErrors in result", async () => {
  const throwingCalendar: CalendarSource = {
    eventsForDate: async (_dateIso: string) => {
      throw new Error("synthetic permission denied");
    },
  };

  const result = await buildBriefing({
    storage: makeEmptyStorage(),
    allowLlm: false,
    calendarSource: throwingCalendar,
    now: new Date("2026-04-11T10:00:00.000Z"),
  });

  assert.ok(
    Array.isArray(result.calendarSourceErrors) && result.calendarSourceErrors.length > 0,
    "calendarSourceErrors must be non-empty when a calendar source throws",
  );
  assert.ok(
    result.calendarSourceErrors![0]!.error.includes("synthetic permission denied"),
    "calendarSourceErrors[0].error must contain the original error message",
  );
  assert.ok(
    typeof result.calendarSourceErrors![0]!.source === "string",
    "calendarSourceErrors[0].source must be a string",
  );
});

test("buildBriefing: healthy calendar source produces no calendarSourceErrors", async () => {
  const healthyCalendar: CalendarSource = {
    eventsForDate: async (_dateIso: string) => [],
  };

  const result = await buildBriefing({
    storage: makeEmptyStorage(),
    allowLlm: false,
    calendarSource: healthyCalendar,
    now: new Date("2026-04-11T10:00:00.000Z"),
  });

  assert.ok(
    !result.calendarSourceErrors || result.calendarSourceErrors.length === 0,
    "calendarSourceErrors must be absent or empty when the calendar source succeeds",
  );
});

test("buildBriefing: no calendar source configured produces no calendarSourceErrors", async () => {
  const result = await buildBriefing({
    storage: makeEmptyStorage(),
    allowLlm: false,
    now: new Date("2026-04-11T10:00:00.000Z"),
  });

  assert.ok(
    !result.calendarSourceErrors || result.calendarSourceErrors.length === 0,
    "calendarSourceErrors must be absent when no calendarSource is configured",
  );
});

// ──────────────────────────────────────────────────────────────────────────
// Round 8 P2 Finding 3 (briefing.ts:988): Stable sort for equal-timestamp threads
// ──────────────────────────────────────────────────────────────────────────

test("buildActiveThreads: threads with identical updatedAt are sorted deterministically by id", () => {
  // All three memories have exactly the same updatedAt but different entity thread keys.
  // Running buildActiveThreads twice on different input orderings must produce
  // the same output ordering, thanks to the id tiebreaker.
  const ts = "2026-04-10T12:00:00.000Z";

  function makeEntityMemory(id: string, entityRef: string): MemoryFile {
    return {
      path: `/synthetic/${id}.md`,
      frontmatter: {
        id,
        category: "fact",
        created: ts,
        updated: ts,
        source: "test",
        confidence: 0.9,
        confidenceTier: "explicit",
        tags: [],
        entityRef,
      },
      content: `Content for ${id}`,
    };
  }

  const memA = makeEntityMemory("mem-alpha", "alpha");
  const memB = makeEntityMemory("mem-beta", "beta");
  const memC = makeEntityMemory("mem-gamma", "gamma");

  const resultForward = buildActiveThreads([memA, memB, memC]);
  const resultReverse = buildActiveThreads([memC, memB, memA]);

  assert.equal(resultForward.length, 3, "should produce 3 threads");
  assert.deepEqual(
    resultForward.map((t) => t.id),
    resultReverse.map((t) => t.id),
    "order must be identical regardless of input order when timestamps are equal",
  );
});

test("buildActiveThreads: primary sort by updatedAt overrides id tiebreaker", () => {
  // "beta" sorts after "alpha" lexicographically (tiebreaker would place alpha first).
  // But beta has a later updatedAt, so beta must appear first in the output.
  function makeEntityMemory2(id: string, entityRef: string, updated: string): MemoryFile {
    return {
      path: `/synthetic/${id}.md`,
      frontmatter: {
        id,
        category: "fact",
        created: updated,
        updated,
        source: "test",
        confidence: 0.9,
        confidenceTier: "explicit",
        tags: [],
        entityRef,
      },
      content: `Content for ${id}`,
    };
  }

  const olderAlpha = makeEntityMemory2("mem-alpha", "alpha", "2026-04-10T08:00:00.000Z");
  const newerBeta = makeEntityMemory2("mem-beta", "beta", "2026-04-10T12:00:00.000Z");

  const threads = buildActiveThreads([olderAlpha, newerBeta]);
  assert.equal(threads[0]!.id, "entity:beta", "newer timestamp must rank first, overriding id tiebreaker");
  assert.equal(threads[1]!.id, "entity:alpha");
});

// ──────────────────────────────────────────────────────────────────────────
// buildOpenCommitments — non-English content (issue #2198)
// ──────────────────────────────────────────────────────────────────────────
function makeCommitmentMemory(overrides: {
  content: string;
  category?: MemoryFile["frontmatter"]["category"];
  tags?: string[];
}): MemoryFile {
  return {
    path: "/synthetic/mem.md",
    frontmatter: {
      id: "synthetic-commitment",
      category: overrides.category ?? "fact",
      created: "2026-08-17T00:00:00.000Z",
      updated: "2026-08-17T00:00:00.000Z",
      source: "test",
      confidence: 0.9,
      confidenceTier: "explicit",
      tags: overrides.tags ?? [],
    },
    content: overrides.content,
  };
}

test("buildOpenCommitments: fullwidth and Arabic question marks surface questions (issue #2198)", () => {
  const fullwidth = makeCommitmentMemory({ content: "このAPIのレート制限はいくつですか？" });
  const arabic = makeCommitmentMemory({ content: "ما هو موعد الاجتماع؟" });
  const english = makeCommitmentMemory({ content: "What is the rate limit?" });

  const commitments = buildOpenCommitments([fullwidth, arabic, english]);
  assert.equal(commitments.length, 3);
  assert.ok(commitments.every((c) => c.kind === "question"));
});

test("buildOpenCommitments: structured category is language-neutral (issue #2198)", () => {
  const japanese = makeCommitmentMemory({
    content: "金曜日までにレビューを提出する",
    category: "commitment",
  });
  const commitments = buildOpenCommitments([japanese]);
  assert.equal(commitments.length, 1);
  assert.equal(commitments[0]!.kind, "commitment");
});

test("buildOpenCommitments: plain non-English statement without markers is not flagged", () => {
  const plain = makeCommitmentMemory({ content: "会議は終わりました" });
  assert.equal(buildOpenCommitments([plain]).length, 0);
});
