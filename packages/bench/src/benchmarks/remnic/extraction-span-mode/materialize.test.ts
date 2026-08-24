/**
 * materializeSpanFact contract tests (issue #2333 Phase A).
 *
 * Covers: [charStart, charEnd) exclusive-end off-by-one at both ends,
 * out-of-range/blank/oversized/reversed intervals, frame word-count limits,
 * source-hash drift rejection, Unicode (UTF-16 code-unit) indexing convention,
 * and per-fact fail-open to generated content.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { stampSpanSource } from "@remnic/core/extraction-span-source-hash";
import { materializeSpanFact, SPAN_MAX_SLICE_CHARS } from "./materialize.ts";
import type { SegmentMessage } from "./segment.ts";
import type { SpanModeFact } from "./schema.ts";

function segment(text: string): SegmentMessage[] {
  return [{ index: 0, speaker: "Maya", text, stamp: stampSpanSource(text) }];
}

function spanFact(overrides: {
  charStart: number;
  charEnd: number;
  frame?: string;
  content?: string;
  sourceMessageIndex?: number;
}): SpanModeFact {
  return {
    category: "fact",
    confidence: 0.9,
    tags: ["t"],
    content: overrides.content ?? "generated fallback content",
    span: {
      sourceMessageIndex: overrides.sourceMessageIndex ?? 0,
      charStart: overrides.charStart,
      charEnd: overrides.charEnd,
      frame: overrides.frame ?? "Maya relocated",
    },
  };
}

const MSG = "Maya moved to Seattle last spring for a new role.";

test("valid span materializes frame + verbatim slice", () => {
  const start = MSG.indexOf("Seattle");
  const result = materializeSpanFact(
    spanFact({ charStart: start, charEnd: start + "Seattle".length }),
    segment(MSG),
  );
  assert.equal(result.outcome, "span");
  assert.equal(result.quote, "Seattle");
  assert.equal(result.content, "Maya relocated: Seattle");
  assert.equal(result.charStart, start);
  assert.equal(result.charEnd, start + "Seattle".length);
});

test("[charStart, charEnd) is end-exclusive at both ends — off-by-one slices differ", () => {
  const start = MSG.indexOf("Seattle");
  const inclusive = materializeSpanFact(
    spanFact({ charStart: start, charEnd: start + "Seattle".length }),
    segment(MSG),
  );
  const shiftedStart = materializeSpanFact(
    spanFact({ charStart: start + 1, charEnd: start + "Seattle".length }),
    segment(MSG),
  );
  assert.equal(inclusive.quote, "Seattle");
  assert.equal(shiftedStart.quote, "eattle");
  const atEnd = materializeSpanFact(
    spanFact({ charStart: MSG.length - 1, charEnd: MSG.length }),
    segment(MSG),
  );
  assert.equal(atEnd.outcome, "span");
  assert.equal(atEnd.quote, ".");
  assert.equal(
    materializeSpanFact(spanFact({ charStart: 0, charEnd: MSG.length + 1 }), segment(MSG)).reason,
    "offsets_out_of_range",
  );
  assert.equal(
    materializeSpanFact(spanFact({ charStart: -1, charEnd: 5 }), segment(MSG)).reason,
    "offsets_out_of_range",
  );
});

test("empty, reversed, and equal intervals fall back", () => {
  const messages = segment(MSG);
  assert.equal(materializeSpanFact(spanFact({ charStart: 0, charEnd: 0 }), messages).reason, "empty_interval");
  assert.equal(materializeSpanFact(spanFact({ charStart: 5, charEnd: 5 }), messages).reason, "empty_interval");
  assert.equal(materializeSpanFact(spanFact({ charStart: 9, charEnd: 4 }), messages).reason, "empty_interval");
});

test("whitespace-only slice falls back", () => {
  const gap = MSG.indexOf(" ") + 1; // " moved" — slice the space between words
  const messages = segment(MSG);
  assert.equal(
    materializeSpanFact(spanFact({ charStart: 4, charEnd: gap }), messages).reason,
    "blank_slice",
  );
});

test("slice over 400 chars falls back; exactly 400 passes", () => {
  const long = "a".repeat(600);
  const messages = segment(long);
  assert.equal(
    materializeSpanFact(spanFact({ charStart: 0, charEnd: SPAN_MAX_SLICE_CHARS + 1 }), messages).reason,
    "slice_too_long",
  );
  assert.equal(
    materializeSpanFact(spanFact({ charStart: 0, charEnd: SPAN_MAX_SLICE_CHARS }), messages).outcome,
    "span",
  );
});

test("frame over 15 words (or empty) falls back; 15 words passes", () => {
  const messages = segment(MSG);
  const words = (count: number) => Array.from({ length: count }, (_, i) => `w${i}`).join(" ");
  assert.equal(
    materializeSpanFact(spanFact({ charStart: 0, charEnd: 4, frame: words(16) }), messages).reason,
    "frame_word_count",
  );
  assert.equal(
    materializeSpanFact(spanFact({ charStart: 0, charEnd: 4, frame: "   " }), messages).reason,
    "frame_word_count",
  );
  assert.equal(
    materializeSpanFact(spanFact({ charStart: 0, charEnd: 4, frame: words(15) }), messages).outcome,
    "span",
  );
});

test("source drift (renormalized message text) is rejected by the stamp", () => {
  const sent = "Maya  moved  to Seattle."; // exact string the model indexed
  const messages: SegmentMessage[] = [
    { index: 0, speaker: "Maya", text: "Maya moved to Seattle.", stamp: stampSpanSource(sent) },
  ];
  const start = 0;
  const result = materializeSpanFact(spanFact({ charStart: start, charEnd: start + 4 }), messages);
  assert.equal(result.outcome, "fallback");
  assert.ok(result.reason?.startsWith("source_"));
  assert.equal(result.content, "generated fallback content");
});

test("offsets index UTF-16 code units — astral-plane characters count as two", () => {
  // "🎨 tea" — the emoji is 2 code units; offsets must match .slice() exactly.
  const text = "🎨 tea in Seattle";
  const messages = segment(text);
  const emojiStart = text.indexOf("🎨");
  const result = materializeSpanFact(
    spanFact({ charStart: emojiStart, charEnd: emojiStart + 2 }),
    messages,
  );
  assert.equal(result.outcome, "span");
  assert.equal(result.quote, "🎨");
  // A single-code-unit slice of the surrogate pair is invalid Unicode but a
  // valid, non-blank slice — the contract indexes code units, not code points.
  const half = materializeSpanFact(
    spanFact({ charStart: emojiStart, charEnd: emojiStart + 1 }),
    messages,
  );
  assert.equal(half.outcome, "span");
  assert.equal(half.quote, text.slice(emojiStart, emojiStart + 1));
});

test("invalid message index and missing span fall back; missing fallback content is loud", () => {
  const messages = segment(MSG);
  assert.equal(
    materializeSpanFact(spanFact({ charStart: 0, charEnd: 4, sourceMessageIndex: 7 }), messages).reason,
    "message_index_out_of_range",
  );
  const noSpan: SpanModeFact = {
    category: "fact",
    confidence: 0.9,
    tags: ["t"],
    content: "plain generated fact",
    span: null,
  };
  const fellBack = materializeSpanFact(noSpan, messages);
  assert.equal(fellBack.outcome, "fallback");
  assert.equal(fellBack.reason, "no_span");
  assert.equal(fellBack.content, "plain generated fact");
  const noContent: SpanModeFact = {
    category: "fact",
    confidence: 0.9,
    tags: ["t"],
    content: null,
    span: { sourceMessageIndex: 0, charStart: 0, charEnd: 4, frame: "" },
  };
  assert.equal(materializeSpanFact(noContent, messages).reason, "missing_fallback_content");
});

test("per-fact fail-open: one bad span among three facts persists all three", () => {
  const messages = segment(MSG);
  const seattle = MSG.indexOf("Seattle");
  const good = materializeSpanFact(spanFact({ charStart: seattle, charEnd: seattle + 7 }), messages);
  const bad = materializeSpanFact(spanFact({ charStart: 0, charEnd: MSG.length + 5 }), messages);
  const frameOnly = materializeSpanFact(
    spanFact({ charStart: 0, charEnd: 4, frame: "Maya relocated", content: "fallback text" }),
    messages,
  );
  assert.deepEqual(
    [good.outcome, bad.outcome, frameOnly.outcome],
    ["span", "fallback", "span"],
  );
  assert.ok(bad.content.length > 0);
  assert.ok(good.content.length > 0);
  assert.ok(frameOnly.content.length > 0);
});
