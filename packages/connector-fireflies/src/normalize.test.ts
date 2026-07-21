import assert from "node:assert/strict";
import { test } from "node:test";

import type { FirefliesTranscript } from "./client.js";
import {
  FIREFLIES_SOURCE_ID,
  firefliesDayWindow,
  transcriptToConversation,
} from "./normalize.js";

test("maps sentences to segments with absolute UTC times from the meeting start", () => {
  // 2026-03-10T14:00:00Z in epoch ms.
  const start = Date.parse("2026-03-10T14:00:00.000Z");
  const transcript: FirefliesTranscript = {
    id: "t1",
    title: "Roadmap sync",
    date: start,
    duration: 30,
    summary: { overview: "Discussed Q3 roadmap." },
    sentences: [
      { index: 0, speaker_name: "Jane Doe", speaker_id: 0, text: "Let's start.", start_time: 5, end_time: 8 },
      { index: 1, speaker_name: "John Roe", speaker_id: 1, text: "Agenda first.", start_time: 9, end_time: 12 },
    ],
  };

  const conv = transcriptToConversation(transcript);
  assert.equal(conv.id, "t1");
  assert.equal(conv.source, FIREFLIES_SOURCE_ID);
  assert.equal(conv.title, "Roadmap sync");
  assert.equal(conv.summary, "Discussed Q3 roadmap.");
  assert.equal(conv.startIso, "2026-03-10T14:00:00.000Z");
  assert.equal(conv.endIso, "2026-03-10T14:30:00.000Z");
  assert.equal(conv.segments.length, 2);
  assert.deepEqual(conv.segments[0], {
    text: "Let's start.",
    speakerKey: "Jane Doe",
    speakerName: "Jane Doe",
    startIso: "2026-03-10T14:00:05.000Z",
    endIso: "2026-03-10T14:00:08.000Z",
  });
});

test("accepts an ISO string meeting date", () => {
  const transcript: FirefliesTranscript = {
    id: "t2",
    date: "2026-03-10T14:00:00.000Z",
    sentences: [{ text: "Hi", speaker_id: 3, start_time: 1, end_time: 2 }],
  };
  const conv = transcriptToConversation(transcript);
  assert.equal(conv.startIso, "2026-03-10T14:00:00.000Z");
  // No speaker_name → key falls back to the string speaker id.
  assert.equal(conv.segments[0]?.speakerKey, "3");
  assert.equal(conv.segments[0]?.speakerName, undefined);
});

test("never guesses isWearer", () => {
  const conv = transcriptToConversation({
    id: "t3",
    date: 0,
    sentences: [{ text: "hello", speaker_name: "Me", start_time: 0, end_time: 1 }],
  });
  assert.equal(conv.segments[0]?.isWearer, undefined);
});

test("degrades to a single note segment when a summary exists without a transcript", () => {
  const conv = transcriptToConversation({
    id: "t4",
    date: Date.parse("2026-03-10T09:00:00.000Z"),
    summary: { short_summary: "Quick standup, nothing blocking." },
    sentences: [],
  });
  assert.equal(conv.segments.length, 1);
  assert.deepEqual(conv.segments[0], {
    text: "Quick standup, nothing blocking.",
    speakerKey: "note",
  });
  assert.equal(conv.summary, "Quick standup, nothing blocking.");
});

test("empty transcript and empty summary yields zero segments", () => {
  const conv = transcriptToConversation({ id: "t5", date: 0, sentences: [], summary: {} });
  assert.equal(conv.segments.length, 0);
});

test("firefliesDayWindow returns half-open UTC bounds for a local day", () => {
  const window = firefliesDayWindow("2026-03-10", "America/Chicago");
  // CDT is UTC-5 in March (after the 2026-03-08 DST switch).
  assert.equal(window.fromDate, "2026-03-10T05:00:00.000Z");
  assert.equal(window.toDate, "2026-03-11T05:00:00.000Z");
});

test("firefliesDayWindow handles the spring-forward DST boundary", () => {
  // 2026-03-08 is the US spring-forward day: the day starts CST (UTC-6),
  // the next day starts CDT (UTC-5). Bounds must reflect the shift.
  const window = firefliesDayWindow("2026-03-08", "America/Chicago");
  assert.equal(window.fromDate, "2026-03-08T06:00:00.000Z");
  assert.equal(window.toDate, "2026-03-09T05:00:00.000Z");
});

test("UTC timezone yields plain UTC day bounds", () => {
  const window = firefliesDayWindow("2026-07-01", "UTC");
  assert.equal(window.fromDate, "2026-07-01T00:00:00.000Z");
  assert.equal(window.toDate, "2026-07-02T00:00:00.000Z");
});

test("firefliesDayWindow rejects an invalid timezone instead of coercing to UTC", () => {
  assert.throws(() => firefliesDayWindow("2026-03-10", "Not/AZone"), RangeError);
});

test("a transcript with no resolvable date yields an empty startIso (caller drops it)", () => {
  const conv = transcriptToConversation({ id: "bad", date: "not-a-date", sentences: [] });
  assert.equal(conv.startIso, "");
});
