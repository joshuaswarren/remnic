import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { FileCalendarSource } from "../src/briefing.js";

async function makeTempFile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-briefing-cal-"));
  const filePath = path.join(dir, name);
  await writeFile(filePath, content, "utf-8");
  return filePath;
}

test("FileCalendarSource reads a JSON array of events and filters by date", async () => {
  const filePath = await makeTempFile(
    "events.json",
    JSON.stringify([
      {
        id: "evt-1",
        title: "Design review",
        start: "2026-04-11T14:00:00.000Z",
        end: "2026-04-11T15:00:00.000Z",
        location: "Room 3",
      },
      {
        id: "evt-2",
        title: "Old sync",
        start: "2026-04-10T10:00:00.000Z",
      },
    ]),
  );
  try {
    const source = new FileCalendarSource(filePath);
    const today = await source.eventsForDate("2026-04-11");
    assert.equal(today.length, 1);
    assert.equal(today[0].id, "evt-1");
    assert.equal(today[0].title, "Design review");
    assert.equal(today[0].location, "Room 3");

    const yesterday = await source.eventsForDate("2026-04-10");
    assert.equal(yesterday.length, 1);
    assert.equal(yesterday[0].id, "evt-2");

    const empty = await source.eventsForDate("2026-04-12");
    assert.deepEqual(empty, []);
  } finally {
    await rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

test("FileCalendarSource accepts the { events: [...] } wrapper form", async () => {
  const filePath = await makeTempFile(
    "events-wrapped.json",
    JSON.stringify({
      events: [
        {
          id: "evt-w",
          title: "Wrapped event",
          start: "2026-04-11T09:00:00.000Z",
        },
      ],
    }),
  );
  try {
    const source = new FileCalendarSource(filePath);
    const today = await source.eventsForDate("2026-04-11");
    assert.equal(today.length, 1);
    assert.equal(today[0].id, "evt-w");
  } finally {
    await rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

test("FileCalendarSource parses a minimal ICS file", async () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:synthetic-ics-1",
    "SUMMARY:Team standup",
    "DTSTART:20260411T143000Z",
    "DTEND:20260411T150000Z",
    "LOCATION:Virtual",
    "DESCRIPTION:Synthetic fixture",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:synthetic-ics-2",
    "SUMMARY:Yesterday sync",
    "DTSTART:20260410T100000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const filePath = await makeTempFile("synthetic.ics", ics);
  try {
    const source = new FileCalendarSource(filePath);
    const today = await source.eventsForDate("2026-04-11");
    assert.equal(today.length, 1);
    assert.equal(today[0].title, "Team standup");
    assert.equal(today[0].start, "2026-04-11T14:30:00Z");
    assert.equal(today[0].end, "2026-04-11T15:00:00Z");
    assert.equal(today[0].location, "Virtual");
    assert.equal(today[0].id, "synthetic-ics-1");
  } finally {
    await rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

test("FileCalendarSource returns [] when the file is unreadable", async () => {
  const source = new FileCalendarSource(
    path.join(os.tmpdir(), "does-not-exist-" + Math.random().toString(36).slice(2)),
  );
  const events = await source.eventsForDate("2026-04-11");
  assert.deepEqual(events, []);
});

test("FileCalendarSource returns [] when JSON is malformed", async () => {
  const filePath = await makeTempFile("broken.json", "{not valid json");
  try {
    const source = new FileCalendarSource(filePath);
    const events = await source.eventsForDate("2026-04-11");
    assert.deepEqual(events, []);
  } finally {
    await rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// #396 Codex follow-up: ICS DTSTART/DTEND must preserve TZID params. An event
// at 23:30 America/New_York on 2026-04-11 = 03:30 UTC on 2026-04-12, so it
// must appear in the 2026-04-12 briefing (not 2026-04-11).
// ──────────────────────────────────────────────────────────────────────────

test("FileCalendarSource preserves DTSTART TZID and shifts to the correct UTC date", async () => {
  // 2026-04-11 is inside US DST (second Sunday of March → first Sunday of
  // November), so America/New_York is UTC-4 (EDT). 23:30 ET → 03:30 UTC next day.
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:synthetic-ics-tz-1",
    "SUMMARY:Late night review",
    "DTSTART;TZID=America/New_York:20260411T233000",
    "DTEND;TZID=America/New_York:20260412T003000",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const filePath = await makeTempFile("tz.ics", ics);
  try {
    const source = new FileCalendarSource(filePath);

    // Must NOT appear on 2026-04-11 UTC.
    const apr11 = await source.eventsForDate("2026-04-11");
    assert.equal(
      apr11.length,
      0,
      "23:30 ET on 2026-04-11 is 03:30 UTC on 2026-04-12, not 2026-04-11",
    );

    // Must appear on 2026-04-12 UTC.
    const apr12 = await source.eventsForDate("2026-04-12");
    assert.equal(apr12.length, 1, "event must land on the 2026-04-12 UTC briefing");
    assert.equal(apr12[0].title, "Late night review");
    assert.equal(apr12[0].id, "synthetic-ics-tz-1");
    // DTSTART at 23:30 ET (UTC-4 during DST) → 03:30 UTC
    assert.equal(apr12[0].start, "2026-04-12T03:30:00.000Z");
    // DTEND at 00:30 ET (next day) → 04:30 UTC same day
    assert.equal(apr12[0].end, "2026-04-12T04:30:00.000Z");
  } finally {
    await rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

test("FileCalendarSource treats DTSTART without TZID as floating-local", async () => {
  // No TZID, no Z → floating. Must match its own calendar day regardless of
  // the server's local timezone.
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:synthetic-ics-floating",
    "SUMMARY:Floating event",
    "DTSTART:20260411T143000",
    "DTEND:20260411T150000",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const filePath = await makeTempFile("floating.ics", ics);
  try {
    const source = new FileCalendarSource(filePath);
    const apr11 = await source.eventsForDate("2026-04-11");
    assert.equal(apr11.length, 1, "floating event must match its own calendar day");
    assert.equal(apr11[0].title, "Floating event");
  } finally {
    await rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

test("FileCalendarSource falls back to UTC when TZID is unknown", async () => {
  // Unknown TZID: conservative behaviour is to treat the wallclock as UTC
  // (logged warning) rather than dropping the event entirely.
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:synthetic-ics-unknown-tz",
    "SUMMARY:Unknown-zone event",
    "DTSTART;TZID=Nowhere/NotReal:20260411T120000",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const filePath = await makeTempFile("unknown-tz.ics", ics);
  try {
    const source = new FileCalendarSource(filePath);
    // With the UTC fallback, 12:00 wallclock → 12:00 UTC, so it lands on 2026-04-11.
    const apr11 = await source.eventsForDate("2026-04-11");
    assert.equal(apr11.length, 1, "unknown TZID should fall back to UTC, not drop the event");
    assert.equal(apr11[0].title, "Unknown-zone event");
  } finally {
    await rm(path.dirname(filePath), { recursive: true, force: true });
  }
});
