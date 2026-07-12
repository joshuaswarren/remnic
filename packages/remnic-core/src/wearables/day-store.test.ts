import assert from "node:assert/strict";
import { test } from "node:test";

import {
  composeDayTranscriptBody,
  composeDayTranscriptMeta,
  decodeTranscriptBody,
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


test("decodeTranscriptBody decodes segment text but leaves headings/locations untouched (#1849)", () => {
  // Hand-written stored body: segment text carries the escaped forms
  // (backslash-n for a newline) exactly as composeDayTranscriptBody
  // serializes them, while the title/location are NOT escaped on write.
  const body =
    "# bee transcript — 2026-06-10\n" +
    "\n" +
    "## 09:00–09:10 · C:\\roadmap (conversation c1)\n" +
    "\n" +
    "*Location: D:\\data*\n" +
    "\n" +
    '**Me (you)** [09:00]: Line one.\\nLine two.\n';
  const decoded = decodeTranscriptBody(body);
  // Segment text IS decoded: backslash-n -> real newline.
  assert.ok(decoded.includes("Line one.\nLine two."), "segment newline decoded");
  assert.ok(!decoded.includes("Line one.\\nLine two."), "no escaped-newline leak in segment");
  // Title and location are NOT escaped on write, so a literal backslash
  // there must pass through verbatim (only segment text is decoded).
  assert.ok(decoded.includes("· C:\\roadmap (conversation c1)"), "title backslash untouched");
  assert.ok(decoded.includes("*Location: D:\\data*"), "location backslash untouched");
});

test("decodeTranscriptBody recovers original segment text from a composed body (#1849)", () => {
  const original = "First line.\nSecond line with a backslash \\ here.";
  const conversations: WearableConversation[] = [
    {
      id: "c1",
      source: "bee",
      startIso: "2026-06-10T09:00:00Z",
      segments: [{ speakerKey: "user", isWearer: true, text: original }],
    },
  ];
  const body = composeDayTranscriptBody("bee", "2026-06-10", "UTC", conversations, REGISTRY);
  // The stored body carries the ESCAPED form, not the original...
  assert.ok(!body.includes(original), "stored body is escaped, not the raw original");
  assert.ok(body.includes("First line.\\nSecond line"), "stored body has the escaped newline");
  // ...and decoding recovers the original utterance verbatim.
  assert.ok(
    decodeTranscriptBody(body).includes(original),
    "decoded body recovers the original segment text",
  );
});
