import assert from "node:assert/strict";
import { test } from "node:test";

import type { GranolaNote } from "./client.js";
import { GRANOLA_SOURCE_ID, granolaDayWindow, noteToConversation } from "./normalize.js";

test("maps a macOS transcript: source→speakerKey, microphone→wearer, absolute times", () => {
  const note: GranolaNote = {
    id: "not_a",
    title: "Fallback title",
    created_at: "2026-03-10T13:00:00.000Z",
    calendar_event: {
      event_title: "Roadmap review",
      scheduled_start_time: "2026-03-10T14:00:00.000Z",
      scheduled_end_time: "2026-03-10T15:00:00.000Z",
    },
    summary_text: "Reviewed the roadmap.",
    transcript: [
      {
        speaker: { source: "microphone" },
        text: "Let's begin.",
        start_time: "2026-03-10T14:00:05.000Z",
        end_time: "2026-03-10T14:00:08.000Z",
      },
      {
        speaker: { source: "speaker" },
        text: "Sounds good.",
        start_time: "2026-03-10T14:00:09.000Z",
        end_time: "2026-03-10T14:00:12.000Z",
      },
    ],
  };
  const conv = noteToConversation(note);
  assert.equal(conv.id, "not_a");
  assert.equal(conv.source, GRANOLA_SOURCE_ID);
  // Calendar event title/time win over the note's own fields.
  assert.equal(conv.title, "Roadmap review");
  assert.equal(conv.summary, "Reviewed the roadmap.");
  assert.equal(conv.startIso, "2026-03-10T14:00:00.000Z");
  assert.equal(conv.endIso, "2026-03-10T15:00:00.000Z");
  assert.deepEqual(conv.segments[0], {
    text: "Let's begin.",
    speakerKey: "microphone",
    isWearer: true,
    startIso: "2026-03-10T14:00:05.000Z",
    endIso: "2026-03-10T14:00:08.000Z",
  });
  // "speaker" source is other audio — not the wearer.
  assert.equal(conv.segments[1]?.speakerKey, "speaker");
  assert.equal(conv.segments[1]?.isWearer, undefined);
});

test("iOS diarization_label becomes the speakerKey and suppresses the wearer guess", () => {
  const note: GranolaNote = {
    id: "not_b",
    created_at: "2026-03-10T09:00:00.000Z",
    transcript: [
      { speaker: { source: "microphone", diarization_label: "Speaker A" }, text: "Hi", start_time: "2026-03-10T09:00:01.000Z", end_time: "2026-03-10T09:00:02.000Z" },
      { speaker: { source: "microphone", diarization_label: "Speaker B" }, text: "Yo", start_time: "2026-03-10T09:00:03.000Z", end_time: "2026-03-10T09:00:04.000Z" },
    ],
  };
  const conv = noteToConversation(note);
  assert.equal(conv.segments[0]?.speakerKey, "Speaker A");
  assert.equal(conv.segments[0]?.isWearer, undefined);
  assert.equal(conv.segments[1]?.speakerKey, "Speaker B");
  // No calendar event → start falls back to the first transcript time.
  assert.equal(conv.startIso, "2026-03-10T09:00:01.000Z");
});

test("degrades to a single note segment when a summary exists without a transcript", () => {
  const note: GranolaNote = {
    id: "not_c",
    created_at: "2026-03-10T09:00:00.000Z",
    summary_text: "Quick standup, nothing blocking.",
    transcript: [],
  };
  const conv = noteToConversation(note);
  assert.equal(conv.segments.length, 1);
  assert.deepEqual(conv.segments[0], { text: "Quick standup, nothing blocking.", speakerKey: "note" });
  // No calendar/transcript time → falls back to created_at.
  assert.equal(conv.startIso, "2026-03-10T09:00:00.000Z");
});

test("falls back to summary_markdown when summary_text is absent", () => {
  const conv = noteToConversation({
    id: "not_d",
    created_at: "2026-03-10T09:00:00.000Z",
    summary_markdown: "## Notes\n- did a thing",
    transcript: null,
  });
  assert.equal(conv.summary, "## Notes\n- did a thing");
  assert.equal(conv.segments[0]?.text, "## Notes\n- did a thing");
});

test("a note with no resolvable time yields an empty startIso (caller drops it)", () => {
  const conv = noteToConversation({ id: "not_e", transcript: [] });
  assert.equal(conv.startIso, "");
  assert.equal(conv.segments.length, 0);
});

test("granolaDayWindow returns half-open UTC bounds for a local day", () => {
  const window = granolaDayWindow("2026-03-10", "America/Chicago");
  assert.equal(window.createdAfter, "2026-03-10T05:00:00.000Z");
  assert.equal(window.createdBefore, "2026-03-11T05:00:00.000Z");
});

test("granolaDayWindow handles the spring-forward DST boundary", () => {
  const window = granolaDayWindow("2026-03-08", "America/Chicago");
  assert.equal(window.createdAfter, "2026-03-08T06:00:00.000Z");
  assert.equal(window.createdBefore, "2026-03-09T05:00:00.000Z");
});

test("granolaDayWindow rejects an invalid timezone instead of coercing to UTC", () => {
  assert.throws(() => granolaDayWindow("2026-03-10", "Not/AZone"), RangeError);
});
