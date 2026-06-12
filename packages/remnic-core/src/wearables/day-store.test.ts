import assert from "node:assert/strict";
import { test } from "node:test";

import {
  composeDayTranscriptBody,
  composeDayTranscriptMeta,
  hashTranscriptBody,
  isValidTranscriptDate,
  parseDayTranscript,
  serializeDayTranscript,
} from "./day-store.js";
import { emptySpeakerRegistry } from "./speakers.js";
import type { WearableConversation } from "./types.js";

const REGISTRY = emptySpeakerRegistry();

const CONVERSATIONS: WearableConversation[] = [
  {
    id: "conv-2",
    source: "limitless",
    title: "Afternoon sync",
    startIso: "2026-06-10T14:00:00-05:00",
    endIso: "2026-06-10T14:30:00-05:00",
    segments: [
      { speakerKey: "user", isWearer: true, text: "Let's lock the agenda.", startIso: "2026-06-10T14:01:00-05:00" },
    ],
  },
  {
    id: "conv-1",
    source: "limitless",
    title: "Morning coffee",
    startIso: "2026-06-10T09:00:00-05:00",
    endIso: "2026-06-10T09:20:00-05:00",
    location: "Coffee shop",
    segments: [
      { speakerKey: "Speaker 2", speakerName: "Speaker 2", text: "Try the east loop trail." },
      { speakerKey: "user", isWearer: true, text: "I will this weekend." },
    ],
  },
];

test("isValidTranscriptDate accepts real dates and rejects everything else", () => {
  assert.equal(isValidTranscriptDate("2026-06-10"), true);
  assert.equal(isValidTranscriptDate("2026-13-01"), false);
  assert.equal(isValidTranscriptDate("2026-02-30"), false);
  assert.equal(isValidTranscriptDate("06/10/2026"), false);
  assert.equal(isValidTranscriptDate("../etc/passwd"), false);
});

test("body orders conversations chronologically with local clock times", () => {
  const body = composeDayTranscriptBody(
    "limitless",
    "2026-06-10",
    "America/Chicago",
    CONVERSATIONS,
    REGISTRY,
  );
  const morningIndex = body.indexOf("Morning coffee");
  const afternoonIndex = body.indexOf("Afternoon sync");
  assert.ok(morningIndex !== -1 && afternoonIndex !== -1);
  assert.ok(morningIndex < afternoonIndex, "expected chronological order");
  assert.match(body, /## 09:00–09:20 · Morning coffee \(conversation conv-1\)/);
  // Segments without timestamps render the --:-- placeholder.
  assert.match(body, /\*\*Me \(you\)\*\* \[--:--\]: I will this weekend\./);
  // Segments with timestamps render a local clock time.
  assert.match(body, /\*\*Me \(you\)\*\* \[14:01\]: Let's lock the agenda\./);
  assert.match(body, /\*Location: Coffee shop\*/);
});

test("composition is deterministic (same input → same hash)", () => {
  const compose = () =>
    composeDayTranscriptBody("limitless", "2026-06-10", "UTC", CONVERSATIONS, REGISTRY);
  assert.equal(hashTranscriptBody(compose()), hashTranscriptBody(compose()));
});

test("serialize → parse round-trips meta and body", () => {
  const body = composeDayTranscriptBody(
    "limitless",
    "2026-06-10",
    "America/Chicago",
    CONVERSATIONS,
    REGISTRY,
  );
  const meta = composeDayTranscriptMeta(
    "limitless",
    "2026-06-10",
    "America/Chicago",
    CONVERSATIONS,
    REGISTRY,
    body,
    "2026-06-11T01:00:00.000Z",
  );
  const parsed = parseDayTranscript(serializeDayTranscript(meta, body));
  assert.ok(parsed, "expected parseDayTranscript to succeed");
  assert.deepEqual(parsed.meta, meta);
  assert.equal(parsed.body, body);
  assert.equal(parsed.meta.conversationCount, 2);
  assert.equal(parsed.meta.segmentCount, 3);
  assert.equal(parsed.meta.durationMinutes, 50);
  assert.equal(parsed.meta.contentHash, hashTranscriptBody(body));
});

test("speakers list survives serialization including special characters", () => {
  const registry = emptySpeakerRegistry();
  registry.selfName = 'J "Quotes" O\'Sample: tester';
  const conversations: WearableConversation[] = [
    {
      id: "c",
      source: "bee",
      startIso: "2026-06-10T08:00:00Z",
      segments: [{ speakerKey: "0", isWearer: true, text: "hi there friend" }],
    },
  ];
  const body = composeDayTranscriptBody("bee", "2026-06-10", "UTC", conversations, registry);
  const meta = composeDayTranscriptMeta(
    "bee",
    "2026-06-10",
    "UTC",
    conversations,
    registry,
    body,
    "2026-06-11T01:00:00.000Z",
  );
  const parsed = parseDayTranscript(serializeDayTranscript(meta, body));
  assert.ok(parsed);
  assert.deepEqual(parsed.meta.speakers, [`J "Quotes" O'Sample: tester (you)`]);
});

test("parseDayTranscript returns null for non-transcript content", () => {
  assert.equal(parseDayTranscript("# just markdown\n"), null);
  assert.equal(parseDayTranscript("---\nid: fact-1\ncategory: fact\n---\n\nx\n"), null);
});

test("invalid timezone falls back to UTC clock rendering instead of crashing", () => {
  const body = composeDayTranscriptBody(
    "limitless",
    "2026-06-10",
    "Not/AZone",
    CONVERSATIONS,
    REGISTRY,
  );
  assert.match(body, /## \d{2}:\d{2}–\d{2}:\d{2} · Morning coffee/);
});
