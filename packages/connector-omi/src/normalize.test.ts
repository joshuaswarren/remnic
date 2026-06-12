import assert from "node:assert/strict";
import { test } from "node:test";

import {
  conversationToWearable,
  memoryToNativeMemory,
  nextIsoDate,
  timezoneOffsetIso,
  zonedDayBounds,
} from "./normalize.js";

test("timezoneOffsetIso resolves fixed and DST offsets", () => {
  const june = new Date("2026-06-10T12:00:00Z");
  const january = new Date("2026-01-10T12:00:00Z");
  assert.equal(timezoneOffsetIso(june, "UTC"), "+00:00");
  assert.equal(timezoneOffsetIso(june, "America/Chicago"), "-05:00");
  assert.equal(timezoneOffsetIso(january, "America/Chicago"), "-06:00");
  assert.equal(timezoneOffsetIso(june, "Asia/Kolkata"), "+05:30");
  // Unknown zone falls back to UTC instead of crashing the sync.
  assert.equal(timezoneOffsetIso(june, "Not/AZone"), "+00:00");
});

test("nextIsoDate handles month and year boundaries", () => {
  assert.equal(nextIsoDate("2026-06-10"), "2026-06-11");
  assert.equal(nextIsoDate("2026-06-30"), "2026-07-01");
  assert.equal(nextIsoDate("2026-12-31"), "2027-01-01");
  assert.equal(nextIsoDate("2028-02-28"), "2028-02-29");
});

test("zonedDayBounds produces a half-open local-day window", () => {
  const bounds = zonedDayBounds("2026-06-10", "America/Chicago");
  assert.equal(bounds.startIso, "2026-06-10T00:00:00-05:00");
  assert.equal(bounds.endIso, "2026-06-11T00:00:00-05:00");
  const utc = zonedDayBounds("2026-06-10", "UTC");
  assert.equal(utc.startIso, "2026-06-10T00:00:00+00:00");
  assert.equal(utc.endIso, "2026-06-11T00:00:00+00:00");
});

const CONVERSATION = {
  id: "omi-1",
  created_at: "2026-06-10T14:00:05+00:00",
  started_at: "2026-06-10T14:00:00+00:00",
  finished_at: "2026-06-10T14:20:00+00:00",
  structured: {
    title: "Walk and talk",
    overview: "Planned the trip.",
    category: "travel",
  },
  geolocation: { address: "Example Park" },
  status: "completed",
  transcript_segments: [
    { text: "Let's plan the August trip.", speaker: "SPEAKER_00", is_user: true, start: 10, end: 14 },
    { text: "Flights first, then the hotel.", speaker: "SPEAKER_01", is_user: false, person_id: "person-7", start: 15, end: 19 },
    { text: "   ", speaker: "SPEAKER_01", is_user: false },
  ],
};

test("maps conversation metadata and derives segment timestamps from offsets", () => {
  const conversation = conversationToWearable(CONVERSATION);
  assert.equal(conversation.id, "omi-1");
  assert.equal(conversation.source, "omi");
  assert.equal(conversation.title, "Walk and talk");
  assert.equal(conversation.summary, "Planned the trip.");
  assert.equal(conversation.location, "Example Park");
  assert.equal(conversation.startIso, "2026-06-10T14:00:00+00:00");
  assert.equal(conversation.segments.length, 2);
  assert.equal(conversation.segments[0].startIso, "2026-06-10T14:00:10.000Z");
  assert.equal(conversation.segments[0].endIso, "2026-06-10T14:00:14.000Z");
});

test("wearer keys as 'user'; known people key by person_id", () => {
  const conversation = conversationToWearable(CONVERSATION);
  const [wearer, other] = conversation.segments;
  assert.equal(wearer.isWearer, true);
  assert.equal(wearer.speakerKey, "user");
  assert.equal(other.isWearer, undefined);
  assert.equal(other.speakerKey, "person-7");
  assert.equal(other.speakerName, "SPEAKER_01");
});

test("tolerates absent optional fields (exclude_none serialization)", () => {
  const conversation = conversationToWearable({ id: "sparse-1" });
  assert.equal(conversation.segments.length, 0);
  assert.equal(conversation.startIso, "");
  assert.equal(conversation.title, undefined);
});

test("maps Omi memories and drops empty/locked-truncated-empty content", () => {
  assert.deepEqual(
    memoryToNativeMemory({
      id: "m1",
      content: "User prefers window seats.",
      created_at: "2026-06-01T00:00:00+00:00",
      tags: ["travel"],
    }),
    {
      id: "m1",
      content: "User prefers window seats.",
      createdIso: "2026-06-01T00:00:00+00:00",
      tags: ["travel"],
    },
  );
  assert.equal(memoryToNativeMemory({ id: "m2", content: "  " }), null);
  assert.equal(memoryToNativeMemory({ id: "m3" }), null);
});
