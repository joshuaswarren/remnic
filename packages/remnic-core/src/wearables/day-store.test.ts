import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bodyIsEscaped,
  composeDayTranscriptBody,
  composeDayTranscriptMeta,
  decodeTranscriptBody,
  hashTranscriptBody,
  isValidTranscriptDate,
  parseDayTranscript,
  parseTranscriptSegmentLine,
  serializeDayTranscript,
  TRANSCRIPT_FORMAT_VERSION,
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
  const decoded = decodeTranscriptBody(body, true);
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
    decodeTranscriptBody(body, true).includes(original),
    "decoded body recovers the original segment text",
  );
});


test("speaker label with markdown delimiters round-trips through compose → parse and decodeTranscriptBody (#1849)", () => {
  // A speaker label containing `**`, `[`, `]` — the exact characters that
  // delimit a segment line. Without safe serialization the label breaks
  // parseTranscriptSegmentLine parsing; with escape/unescape it round-trips
  // losslessly through composition, parsing, and display decoding.
  const registry = emptySpeakerRegistry();
  registry.selfName = "Me";
  registry.speakers["bee:SPEAKER_01"] = {
    name: "A**B",
    updatedAt: "2026-06-10T00:00:00Z",
  };
  const conversations: WearableConversation[] = [
    {
      id: "c1",
      source: "bee",
      startIso: "2026-06-10T09:00:00Z",
      segments: [
        { speakerKey: "user", isWearer: true, text: "Hi there.", startIso: "2026-06-10T09:00:00Z" },
        { speakerKey: "SPEAKER_01", text: "Delimited label.", startIso: "2026-06-10T09:01:00Z" },
      ],
    },
  ];
  const body = composeDayTranscriptBody("bee", "2026-06-10", "UTC", conversations, registry);
  // The raw stored body escapes the delimiters so the parser never sees
  // a forged `**` or `[` boundary inside the label.
  assert.ok(
    body.includes("**A\\*\\*B**"),
    "label delimiters are escaped in the stored body: " + body,
  );
  // Display decoding recovers the ORIGINAL label for view/search surfaces.
  const decoded = decodeTranscriptBody(body, true);
  assert.ok(
    decoded.includes("**A**B** [09:01]: Delimited label."),
    "decoded body shows the original unescaped label: " + decoded,
  );
  // parseDayTranscript preserves the body bytes verbatim.
  const serialized = serializeDayTranscript(
    composeDayTranscriptMeta("bee", "2026-06-10", "UTC", conversations, registry, body, "2026-06-11T01:00:00.000Z"),
    body,
  );
  const parsed = parseDayTranscript(serialized);
  assert.ok(parsed);
  assert.equal(parsed!.body, body, "body survives serialization round-trip");
});

test("legacy raw label without escape sequences parses and decodes verbatim (#1849)", () => {
  // A hand-written stored body whose label was NEVER escaped (a pre-
  // escaper transcript). decodeTranscriptBody and the segment-line parser
  // must treat it as a no-op: no backslash sequences => unchanged label.
  const body =
    "# bee transcript — 2026-06-10\n" +
    "\n" +
    "## 09:00–09:10 (conversation c1)\n" +
    "\n" +
    "**Me (you)** [09:00]: Hello world.\n" +
    "**Guest** [09:01]: Good morning.\n";
  const decoded = decodeTranscriptBody(body);
  assert.equal(decoded, body, "legacy body with no escapes decodes verbatim");
});

test("legacy body with literal backslash-n/backslash-r is never decoded (#1849)", () => {
  // A pre-escaper transcript whose segment text contains the LITERAL
  // two-character sequences \n and \r (not escape sequences). The
  // format-aware decoder MUST leave them byte-for-byte unchanged so the
  // original content is never corrupted.
  const legacyBody =
    "# bee transcript — 2026-06-10\n" +
    "\n" +
    "## 09:00–09:10 (conversation c1)\n" +
    "\n" +
    "**Guest** [09:00]: A literal backslash-n \\n and backslash-r \\r here.\n";
  // Default (escaped=false): legacy body is a no-op.
  assert.equal(
    decodeTranscriptBody(legacyBody),
    legacyBody,
    "legacy body must not be decoded without an explicit format marker",
  );
  // Even when explicitly told the body IS escaped, the literal sequences
  // \n / \r WOULD be decoded — but only NEW-format bodies (meta carries
  // formatVersion >= 2) are ever passed escaped=true by the service.
  // Here we verify the SAFETY of the default: callers that forget the
  // flag never corrupt legacy content.
  assert.equal(
    decodeTranscriptBody(legacyBody, false),
    legacyBody,
    "escaped=false leaves legacy literal escapes unchanged",
  );
});

test("new-format body with formatVersion marker decodes correctly (#1849)", () => {
  const conversations: WearableConversation[] = [
    {
      id: "c1",
      source: "bee",
      startIso: "2026-06-10T09:00:00Z",
      segments: [{ speakerKey: "user", isWearer: true, text: "Line one.\nLine two." }],
    },
  ];
  const body = composeDayTranscriptBody("bee", "2026-06-10", "UTC", conversations, REGISTRY);
  const meta = composeDayTranscriptMeta(
    "bee", "2026-06-10", "UTC", conversations, REGISTRY, body, "2026-06-11T01:00:00.000Z",
  );
  // The meta carries the format version marker.
  assert.equal(meta.formatVersion, TRANSCRIPT_FORMAT_VERSION);
  assert.ok(bodyIsEscaped(meta), "new-format meta is recognized as escaped");
  // bodyIsEscaped returns false for legacy (no marker) and null.
  assert.equal(bodyIsEscaped(null), false);
  assert.equal(bodyIsEscaped(undefined), false);
  assert.equal(bodyIsEscaped({}), false);
  assert.equal(bodyIsEscaped({ formatVersion: 1 }), false);
  // Decoding with the escaped flag recovers the original newline.
  const decoded = decodeTranscriptBody(body, bodyIsEscaped(meta));
  assert.ok(decoded.includes("Line one.\nLine two."), "new-format body decodes the newline");
});

test("composeDayTranscriptMeta stamps formatVersion and serialize/parse round-trips it (#1849)", () => {
  const body = composeDayTranscriptBody(
    "limitless", "2026-06-10", "UTC", CONVERSATIONS, REGISTRY,
  );
  const meta = composeDayTranscriptMeta(
    "limitless", "2026-06-10", "UTC", CONVERSATIONS, REGISTRY, body, "2026-06-11T01:00:00.000Z",
  );
  assert.equal(meta.formatVersion, TRANSCRIPT_FORMAT_VERSION);
  const serialized = serializeDayTranscript(meta, body);
  assert.ok(serialized.includes("formatVersion: 2"), "serialized file carries the marker");
  const parsed = parseDayTranscript(serialized);
  assert.ok(parsed);
  assert.equal(parsed!.meta.formatVersion, TRANSCRIPT_FORMAT_VERSION);
  // A legacy file (hand-written, no formatVersion line) parses with
  // formatVersion undefined so bodyIsEscaped returns false.
  const legacyFile =
    "---\nkind: wearable-transcript\nsource: \"bee\"\ndate: \"2026-06-10\"\n" +
    "timezone: \"UTC\"\nconversationCount: 1\nsegmentCount: 1\n" +
    "speakers: []\ndurationMinutes: 0\ncontentHash: \"x\"\nsyncedAt: \"y\"\n" +
    "---\n\n# bee transcript — 2026-06-10\n";
  const legacyParsed = parseDayTranscript(legacyFile);
  assert.ok(legacyParsed);
  assert.equal(legacyParsed!.meta.formatVersion, undefined);
  assert.equal(bodyIsEscaped(legacyParsed!.meta), false);
});

test("parseTranscriptSegmentLine extracts label, clock, and text (#1849)", () => {
  const m = parseTranscriptSegmentLine("**Pat** [09:30]: Hello world.");
  assert.deepEqual(m, { label: "Pat", clock: "09:30", text: "Hello world." });
});

test("parseTranscriptSegmentLine handles single-char label and empty text", () => {
  const m = parseTranscriptSegmentLine("**X** [00:00]: ");
  assert.deepEqual(m, { label: "X", clock: "00:00", text: "" });
});

test("parseTranscriptSegmentLine preserves backslash escape sequences in label/text", () => {
  // Escaped labels/text from the escape-aware serializer carry literal
  // backslash sequences that must survive the linear parser unchanged.
  const m = parseTranscriptSegmentLine("**Pat \\*Smith\\*** [09:00]: Hello \\n world.");
  assert.ok(m);
  assert.equal(m!.label, "Pat \\*Smith\\*");
  assert.equal(m!.clock, "09:00");
  assert.equal(m!.text, "Hello \\n world.");
});

test("parseTranscriptSegmentLine returns null for non-segment lines", () => {
  assert.equal(parseTranscriptSegmentLine(""), null);
  assert.equal(parseTranscriptSegmentLine("not a segment"), null);
  assert.equal(parseTranscriptSegmentLine("**no close"), null);
  assert.equal(parseTranscriptSegmentLine("**label** no bracket"), null);
  assert.equal(parseTranscriptSegmentLine("**label** [clock] no colon-space"), null);
  assert.equal(parseTranscriptSegmentLine("**label** [clock]:no space"), null);
  assert.equal(parseTranscriptSegmentLine("**label** []: text"), null);
});

test("parseTranscriptSegmentLine is linear-safe on adversarial repeated delimiters (#1849)", () => {
  // A line with many '*' chars must not cause polynomial backtracking.
  // The linear scan finds the first '**' followed by \s[ — or returns
  // null — without exploring exponential alternatives.
  const longLabel = "a".repeat(10_000);
  const adversarial = `**${longLabel}** [09:00]: text`;
  const m = parseTranscriptSegmentLine(adversarial);
  assert.ok(m, "long label with valid delimiters must parse");
  assert.equal(m!.label, longLabel);
  assert.equal(m!.clock, "09:00");
  assert.equal(m!.text, "text");

  // All stars, no closing \s[ — must return null quickly.
  const noClose = "**" + "*".repeat(10_000);
  assert.equal(parseTranscriptSegmentLine(noClose), null);

  // All stars followed by valid suffix — the first '**' positions are
  // all stars (not followed by \s), so the scan walks the entire run
  // in O(n) and finds the '** ' before '['.
  const allStars = "**" + "*".repeat(10_000) + "** [09:00]: text";
  const m2 = parseTranscriptSegmentLine(allStars);
  assert.ok(m2, "star-prefixed line with valid delimiters must parse");
  assert.equal(m2!.clock, "09:00");
  assert.equal(m2!.text, "text");
});
