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
