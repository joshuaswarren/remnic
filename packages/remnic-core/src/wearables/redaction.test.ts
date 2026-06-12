import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyOffTheRecord,
  compileRedactionPatterns,
  redactText,
  REDACTION_PLACEHOLDER,
} from "./redaction.js";
import type { WearableConversation } from "./types.js";

test("redacts SSN-formatted numbers", () => {
  const result = redactText("my social is 123-45-6789 okay", []);
  assert.equal(result.text, `my social is ${REDACTION_PLACEHOLDER} okay`);
  assert.equal(result.redactions, 1);
});

test("redacts payment-card-like digit runs (spaced and contiguous)", () => {
  assert.equal(
    redactText("card 4111 1111 1111 1111 exp soon", []).text,
    `card ${REDACTION_PLACEHOLDER} exp soon`,
  );
  assert.equal(
    redactText("use 4111111111111111 today", []).text,
    `use ${REDACTION_PLACEHOLDER} today`,
  );
});

test("keeps short and ordinary numbers intact", () => {
  const text = "call 555 0125 about the 2026 budget of $1,250";
  const result = redactText(text, []);
  assert.equal(result.text, text);
  assert.equal(result.redactions, 0);
});

test("applies user patterns case-insensitively", () => {
  const patterns = compileRedactionPatterns(["secret project \\w+"]);
  const result = redactText("the Secret Project Falcon update", patterns);
  assert.equal(result.text, `the ${REDACTION_PLACEHOLDER} update`);
});

test("compileRedactionPatterns rejects invalid regexes loudly", () => {
  assert.throws(() => compileRedactionPatterns(["valid", "("]), /redactionPatterns\[1\]/);
  assert.throws(() => compileRedactionPatterns(["  "]), /non-empty/);
});

function conversation(texts: string[]): WearableConversation {
  return {
    id: "c1",
    source: "testsource",
    startIso: "2026-06-10T10:00:00Z",
    segments: texts.map((text, index) => ({
      speakerKey: index % 2 === 0 ? "a" : "b",
      text,
    })),
  };
}

test("off the record drops the span until back on the record", () => {
  const result = applyOffTheRecord(
    conversation([
      "Let me say this off the record for a second.",
      "The merger closes Friday.",
      "Seriously, do not repeat that.",
      "Okay, back on the record now.",
      "Lunch was great.",
    ]),
  );
  const texts = result.conversation.segments.map((segment) => segment.text);
  assert.deepEqual(texts, [
    "[off the record — segment elided]",
    "[back on the record]",
    "Lunch was great.",
  ]);
  assert.equal(result.droppedSegments, 2);
});

test("off the record without a closing marker drops through conversation end", () => {
  const result = applyOffTheRecord(
    conversation(["This is off the record.", "Private thing one.", "Private thing two."]),
  );
  assert.equal(result.conversation.segments.length, 1);
  assert.equal(result.droppedSegments, 2);
});

test("conversations without the marker pass through untouched", () => {
  const input = conversation(["Plain talk.", "More plain talk."]);
  const result = applyOffTheRecord(input);
  assert.deepEqual(
    result.conversation.segments.map((segment) => segment.text),
    ["Plain talk.", "More plain talk."],
  );
  assert.equal(result.droppedSegments, 0);
});
