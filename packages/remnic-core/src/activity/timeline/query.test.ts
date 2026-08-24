import assert from "node:assert/strict";
import test from "node:test";

import { parseActivityConfig } from "../config.js";
import {
  queryTimelineRange,
  queryTimelineSearch,
  runTimelineCliCommand,
  type TimelineQueryCard,
} from "./query.js";
import type { TimelineCard } from "./types.js";

function card(overrides: Partial<TimelineQueryCard> & Pick<TimelineCard, "id" | "startUtc" | "endUtc">): TimelineQueryCard {
  return {
    kind: "activity",
    title: "Untitled",
    summary: "none",
    categoryId: "development",
    confidence: 1,
    dayKey: overrides.startUtc.slice(0, 10),
    timezone: "UTC",
    machine: "ws-a",
    evidenceIds: [],
    evidenceRange: null,
    ...overrides,
  };
}

const BOUNDARY_A = card({
  id: "a",
  title: "Morning editor",
  summary: "typed in vscode",
  startUtc: "2026-07-10T10:00:00.000Z",
  endUtc: "2026-07-10T11:00:00.000Z",
});
const BOUNDARY_B = card({
  id: "b",
  title: "Standup call",
  summary: "zoom standup",
  categoryId: "communication",
  startUtc: "2026-07-10T11:00:00.000Z",
  endUtc: "2026-07-10T12:00:00.000Z",
});
const LATER = card({
  id: "c",
  title: "Docs writeup",
  summary: "edited the standup notes",
  detailedSummary: "longer writeup about the morning editor session",
  startUtc: "2026-07-11T09:00:00.000Z",
  endUtc: "2026-07-11T10:00:00.000Z",
});
const DISTRACTION = card({
  id: "d",
  title: "Video break",
  summary: "watched a clip",
  categoryId: "entertainment",
  distraction: true,
  startUtc: "2026-07-10T12:00:00.000Z",
  endUtc: "2026-07-10T12:30:00.000Z",
});

const CARDS = [BOUNDARY_A, BOUNDARY_B, LATER, DISTRACTION];

test("range at a boundary instant returns only the containing card", () => {
  const instant = "2026-07-10T11:00:00.000Z";
  const result = queryTimelineRange(CARDS, { from: instant, to: instant, format: "cards" });
  assert.ok(Array.isArray(result));
  assert.deepEqual(
    result.map((item) => item.id),
    ["b"],
  );
});

test("range rejects a reversed window and names the limit", () => {
  assert.throws(
    () =>
      queryTimelineRange(CARDS, {
        from: "2026-07-11T00:00:00.000Z",
        to: "2026-07-10T00:00:00.000Z",
        format: "cards",
      }),
    /reversed range/,
  );
});

test("range rejects a 400-day window and names maxRangeDays", () => {
  assert.throws(
    () =>
      queryTimelineRange(CARDS, {
        from: "2026-01-01T00:00:00.000Z",
        to: "2027-02-05T00:00:00.000Z",
        format: "cards",
      }),
    /maxRangeDays \(31\)/,
  );
});

test("range format cards and compact both round-trip the fixture", () => {
  const from = "2026-07-10T10:00:00.000Z";
  const to = "2026-07-10T12:00:00.000Z";
  const full = queryTimelineRange(CARDS, { from, to, format: "cards", includeDistractions: true });
  assert.ok(Array.isArray(full));
  assert.deepEqual(
    full.map((item) => item.id),
    ["a", "b"],
  );
  const compact = queryTimelineRange(CARDS, { from, to, format: "compact", includeDistractions: true });
  assert.ok(!Array.isArray(compact));
  assert.equal(compact.day, "2026-07-10");
  assert.deepEqual(compact.cards, [
    { start: BOUNDARY_A.startUtc, end: BOUNDARY_A.endUtc, category: "development", title: "Morning editor", summary: "typed in vscode" },
    { start: BOUNDARY_B.startUtc, end: BOUNDARY_B.endUtc, category: "communication", title: "Standup call", summary: "zoom standup" },
  ]);
});

test("range rejects an unknown format against the allow-list", () => {
  assert.throws(
    () =>
      queryTimelineRange(CARDS, {
        from: "2026-07-10T10:00:00.000Z",
        to: "2026-07-10T11:00:00.000Z",
        format: "markdown" as "cards",
      }),
    /format must be one of: cards, compact/,
  );
});

test("search empty results stay ok and unreadable store is distinct", () => {
  assert.deepEqual(queryTimelineSearch(CARDS, { query: "no-such-token" }), { ok: true, results: [] });
  assert.deepEqual(queryTimelineSearch(null, { query: "editor" }), { ok: false, error: "store_unreadable" });
  assert.deepEqual(queryTimelineSearch(undefined, { query: "editor" }), { ok: false, error: "store_unreadable" });
});

test("search rank is match count then recency then id", () => {
  const shuffled = [LATER, DISTRACTION, BOUNDARY_B, BOUNDARY_A];
  const found = queryTimelineSearch(shuffled, { query: "standup editor" });
  assert.equal(found.ok, true);
  if (!found.ok) return;
  assert.deepEqual(
    found.results.map((item) => item.id),
    ["c", "b", "a"],
  );
});

test("search honors detailedSummary and a 1..50 limit", () => {
  const found = queryTimelineSearch(CARDS, { query: "writeup", limit: 1 });
  assert.equal(found.ok, true);
  if (!found.ok) return;
  assert.deepEqual(
    found.results.map((item) => item.id),
    ["c"],
  );
  assert.throws(() => queryTimelineSearch(CARDS, { query: "editor", limit: 0 }), /limit must be an integer from 1 to 50/);
  assert.throws(() => queryTimelineSearch(CARDS, { query: "editor", limit: 51 }), /limit must be an integer from 1 to 50/);
});

test("timeline.qa defaults off and honors 0-style disable plus maxRangeDays bounds", () => {
  const defaults = parseActivityConfig(undefined).timeline.qa;
  assert.deepEqual(defaults, { enabled: false, maxRangeDays: 31 });
  assert.equal(parseActivityConfig({ timeline: { qa: { enabled: 0 } } }).timeline.qa.enabled, false);
  assert.equal(parseActivityConfig({ timeline: { qa: { enabled: "off" } } }).timeline.qa.enabled, false);
  assert.equal(parseActivityConfig({ timeline: { qa: { enabled: true, maxRangeDays: 1 } } }).timeline.qa.maxRangeDays, 1);
  assert.throws(
    () => parseActivityConfig({ timeline: { qa: { maxRangeDays: 0 } } }),
    /maxRangeDays must be an integer from 1 to 366/,
  );
  assert.throws(
    () => parseActivityConfig({ timeline: { qa: { maxRangeDays: 367 } } }),
    /maxRangeDays must be an integer from 1 to 366/,
  );
});

test("CLI runner accepts in-memory cards and does not need a store", async () => {
  const qa = { enabled: true, maxRangeDays: 31 };
  let out = "";
  let err = "";
  const io = {
    stdout: { write: (chunk: string) => (out += chunk) },
    stderr: { write: (chunk: string) => (err += chunk) },
  };
  const rangeCode = await runTimelineCliCommand(
    { cards: CARDS, qa, timelineEnabled: true },
    ["range", "--from", "2026-07-10T11:00:00.000Z", "--to", "2026-07-10T11:00:00.000Z", "--format", "cards"],
    io,
  );
  assert.equal(rangeCode, 0);
  assert.deepEqual(JSON.parse(out).map((item: TimelineCard) => item.id), ["b"]);

  out = "";
  const unread = await runTimelineCliCommand(
    { cards: null, qa, timelineEnabled: true },
    ["search", "--query", "editor"],
    io,
  );
  assert.equal(unread, 1);
  assert.deepEqual(JSON.parse(out), { ok: false, error: "store_unreadable" });
  assert.equal(err, "");
});

test("CLI range validates the full request before loading production cards", async () => {
  const windows: Array<{ from?: string; to?: string }> = [];
  let err = "";
  const io = {
    stdout: { write: () => true },
    stderr: { write: (chunk: string) => (err += chunk) },
  };
  const deps = {
    cards: null,
    qa: { enabled: true, maxRangeDays: 1 },
    timelineEnabled: true,
    loadCards: async (window: { from?: string; to?: string }) => {
      windows.push(window);
      return [];
    },
  };
  const overWide = await runTimelineCliCommand(
    deps,
    ["range", "--from", "2026-01-01T00:00:00.000Z", "--to", "2026-06-01T00:00:00.000Z"],
    io,
  );
  assert.equal(overWide, 1);
  assert.match(err, /maxRangeDays \(1\)/);
  err = "";
  const reversed = await runTimelineCliCommand(
    deps,
    ["range", "--from", "2026-06-01T00:00:00.000Z", "--to", "2026-01-01T00:00:00.000Z"],
    io,
  );
  assert.equal(reversed, 1);
  assert.match(err, /reversed range/);
  err = "";
  const malformed = await runTimelineCliCommand(
    deps,
    ["range", "--from", "not-a-date", "--to", "2026-01-02T00:00:00.000Z"],
    io,
  );
  assert.equal(malformed, 1);
  assert.match(err, /must be an ISO date or datetime/);
  assert.deepEqual(windows, [], "an invalid range must never reach the card loader");
});

test("CLI search validates bounds before loading and passes an unbounded window through", async () => {
  const windows: Array<{ from?: string; to?: string }> = [];
  let err = "";
  const io = {
    stdout: { write: () => true },
    stderr: { write: (chunk: string) => (err += chunk) },
  };
  const deps = {
    cards: null,
    qa: { enabled: true, maxRangeDays: 31 },
    timelineEnabled: true,
    loadCards: async (window: { from?: string; to?: string }) => {
      windows.push(window);
      return [];
    },
  };
  const reversed = await runTimelineCliCommand(
    deps,
    ["search", "--query", "x", "--from", "2027-01-05T00:00:00.000Z", "--to", "2026-01-01T00:00:00.000Z"],
    io,
  );
  assert.equal(reversed, 1);
  assert.match(err, /reversed range/);
  assert.deepEqual(windows, [], "invalid search bounds must never reach the card loader");
  const unbounded = await runTimelineCliCommand(deps, ["search", "--query", "x"], io);
  assert.equal(unbounded, 0);
  assert.deepEqual(windows, [{ from: undefined, to: undefined }]);
});
