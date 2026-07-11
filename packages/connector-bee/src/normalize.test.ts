import assert from "node:assert/strict";
import { test } from "node:test";

import { conversationToWearable, factToNativeMemory } from "./normalize.js";

const BASE_MS = Date.UTC(2026, 5, 10, 14, 0, 0);

test("maps conversation metadata, epoch-ms timestamps, and location", () => {
  const conversation = conversationToWearable({
    id: 42,
    start_time: BASE_MS,
    end_time: BASE_MS + 30 * 60_000,
    state: "COMPLETED",
    short_summary: "Coffee catch-up\n",
    summary: "### Summary\nTalked about hiking.",
    primary_location: { address: "123 Example Ave", latitude: 0, longitude: 0 },
    transcriptions: [
      {
        utterances: [
          { text: "Try the east loop.", speaker: "1", spoken_at: BASE_MS + 60_000 },
          { text: "I will this weekend.", speaker: "0", spoken_at: BASE_MS + 90_000 },
        ],
      },
    ],
  });
  assert.equal(conversation.id, "42");
  assert.equal(conversation.source, "bee");
  assert.equal(conversation.title, "Coffee catch-up");
  assert.equal(conversation.startIso, new Date(BASE_MS).toISOString());
  assert.equal(conversation.endIso, new Date(BASE_MS + 30 * 60_000).toISOString());
  assert.equal(conversation.location, "123 Example Ave");
  assert.equal(conversation.segments.length, 2);
  assert.equal(conversation.segments[0].speakerKey, "1");
  assert.equal(conversation.segments[0].isWearer, undefined);
});

test("flattens and time-sorts utterances across transcription blocks", () => {
  const conversation = conversationToWearable({
    id: 7,
    start_time: BASE_MS,
    transcriptions: [
      { utterances: [{ text: "second", speaker: "0", spoken_at: BASE_MS + 2_000 }] },
      { utterances: [{ text: "first", speaker: "1", spoken_at: BASE_MS + 1_000 }] },
    ],
  });
  assert.deepEqual(
    conversation.segments.map((segment) => segment.text),
    ["first", "second"],
  );
});

test("skips empty utterances and tolerates missing fields", () => {
  const conversation = conversationToWearable({
    id: 8,
    start_time: BASE_MS,
    transcriptions: [
      { utterances: [{ text: "   ", speaker: "0" }, { text: "kept", speaker: "" }, {}] },
    ],
  });
  assert.equal(conversation.segments.length, 1);
  assert.equal(conversation.segments[0].text, "kept");
  assert.equal(conversation.segments[0].speakerKey, "unknown");
});

test("maps Bee facts to native memories", () => {
  const memory = factToNativeMemory({
    id: 99,
    text: "User volunteers monthly.",
    tags: ["habit"],
    created_at: BASE_MS,
    confirmed: true,
  });
  assert.deepEqual(memory, {
    id: "99",
    content: "User volunteers monthly.",
    createdIso: new Date(BASE_MS).toISOString(),
    tags: ["habit"],
  });
});


test("maps utterance start/end to segment timing, preferring start over spoken_at (#1811)", () => {
  const conversation = conversationToWearable({
    id: 11,
    start_time: BASE_MS,
    transcriptions: [
      {
        utterances: [
          {
            text: "First line.",
            speaker: "0",
            start: BASE_MS + 5_000,
            end: BASE_MS + 8_000,
            spoken_at: BASE_MS + 60_000,
          },
        ],
      },
    ],
  });
  assert.equal(conversation.segments.length, 1);
  const segment = conversation.segments[0];
  assert.equal(segment.startIso, new Date(BASE_MS + 5_000).toISOString());
  assert.equal(segment.endIso, new Date(BASE_MS + 8_000).toISOString());
});

test("keeps many Unknown-labeled utterances as distinct segments with end timing (#1811)", () => {
  const conversation = conversationToWearable({
    id: 12,
    start_time: BASE_MS,
    transcriptions: [
      {
        utterances: Array.from({ length: 6 }, (_, index) => ({
          text: `Utterance number ${index + 1}.`,
          speaker: "Unknown",
          start: BASE_MS + index * 10_000,
          end: BASE_MS + index * 10_000 + 4_000,
        })),
      },
    ],
  });
  // No mega-collapse at the normalizer: every utterance is its own segment.
  assert.equal(conversation.segments.length, 6);
  // Full transcript text is preserved across all segments.
  assert.deepEqual(
    conversation.segments.map((segment) => segment.text),
    Array.from({ length: 6 }, (_, index) => `Utterance number ${index + 1}.`),
  );
  // End timing is carried through for every segment.
  for (const [index, segment] of conversation.segments.entries()) {
    assert.equal(segment.speakerKey, "Unknown");
    assert.equal(segment.startIso, new Date(BASE_MS + index * 10_000).toISOString());
    assert.equal(segment.endIso, new Date(BASE_MS + index * 10_000 + 4_000).toISOString());
  }
});

test("falls back to spoken_at when start/end are absent (#1811)", () => {
  const conversation = conversationToWearable({
    id: 13,
    start_time: BASE_MS,
    transcriptions: [
      {
        utterances: [
          { text: "Only spoken_at.", speaker: "0", spoken_at: BASE_MS + 120_000 },
        ],
      },
    ],
  });
  assert.equal(conversation.segments.length, 1);
  const segment = conversation.segments[0];
  assert.equal(segment.startIso, new Date(BASE_MS + 120_000).toISOString());
  assert.equal(segment.endIso, undefined);
});

test("falls back to spoken_at when start is 0 instead of treating 0 as set (#1811)", () => {
  const conversation = conversationToWearable({
    id: 14,
    start_time: BASE_MS,
    transcriptions: [
      {
        utterances: [
          { text: "Zero start.", speaker: "0", start: 0, spoken_at: BASE_MS + 120_000 },
        ],
      },
    ],
  });
  assert.equal(conversation.segments.length, 1);
  const segment = conversation.segments[0];
  assert.equal(segment.startIso, new Date(BASE_MS + 120_000).toISOString());
  assert.equal(segment.endIso, undefined);
});
