/**
 * Span-mode materialization tests (issue #2333 Phase B).
 *
 * Covers the Phase B test contract: bounds off-by-one at both ends
 * ([charStart, charEnd) end-exclusive), hash-mismatch (offset drift)
 * rejection, per-fact fail-open, shadow-mode zero-diff vs "off", oversized
 * span rejection, frame word-count limits, untrusted-span stripping in "off",
 * and strict config enum handling.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { stampSpanSource } from "./extraction-span-source-hash.js";
import {
  applyExtractionSpanMaterialization,
  bindLocalExtractionPrompt,
  buildSpanMaterializeTurns,
  factCarriesSpan,
  materializeFactSpan,
  spanAgreesWithContent,
  stripUntrustedFactSpans,
  SPAN_MAX_SLICE_CHARS,
  type SpanMaterializeTurn,
} from "./extraction-span-materialize.js";
import { renderExtractionConversation } from "./source-agent-qualifier.js";
import { parseConfig } from "./config.js";
import type { BufferTurn, ExtractedFact } from "./types.js";
import type { ExtractedFactSpanRef } from "./extraction-span-config.js";

const TURN_TEXT = "Maya moved to Seattle last spring for a new senior role.";

function turns(...texts: string[]): SpanMaterializeTurn[] {
  return buildSpanMaterializeTurns(texts);
}

function fact(overrides: {
  charStart: number;
  charEnd: number;
  frame?: string;
  content?: string;
  sourceMessageIndex?: number;
  sourceHash?: string;
  sourceLength?: number;
}): ExtractedFact {
  const span: ExtractedFactSpanRef = {
    sourceMessageIndex: overrides.sourceMessageIndex ?? 0,
    charStart: overrides.charStart,
    charEnd: overrides.charEnd,
    frame: overrides.frame ?? "Maya's relocation",
    ...(overrides.sourceHash !== undefined && overrides.sourceLength !== undefined
      ? { sourceHash: overrides.sourceHash, sourceLength: overrides.sourceLength }
      : {}),
  };
  return {
    category: "fact",
    content: overrides.content ?? "Maya moved to Seattle last spring for a new senior role.",
    confidence: 0.9,
    tags: ["relocation"],
    span,
  };
}

test("on-mode materializes frame + verbatim slice and sets the grounding quote", () => {
  const start = TURN_TEXT.indexOf("Seattle");
  const result = materializeFactSpan(
    fact({ charStart: start, charEnd: start + "Seattle".length }),
    turns(TURN_TEXT),
    "on",
  );
  assert.equal(result.outcome, "span");
  assert.equal(result.fact.content, "Maya's relocation: Seattle");
  assert.equal(result.fact.quote, "Seattle");
  assert.equal(result.fact.span, undefined, "offsets die at materialization");
});

test("[charStart, charEnd) is end-exclusive — off-by-one at both ends", () => {
  const start = TURN_TEXT.indexOf("Seattle");
  const messages = turns(TURN_TEXT);
  const inner = materializeFactSpan(fact({ charStart: start + 1, charEnd: start + 6 }), messages, "on");
  assert.equal(inner.fact.quote, "eattl");
  const lastChar = materializeFactSpan(
    fact({ charStart: TURN_TEXT.length - 1, charEnd: TURN_TEXT.length }),
    messages,
    "on",
  );
  assert.equal(lastChar.outcome, "span");
  assert.equal(lastChar.fact.quote, ".");
  assert.equal(
    materializeFactSpan(fact({ charStart: 0, charEnd: TURN_TEXT.length + 1 }), messages, "on").outcome,
    "fallback",
  );
  assert.equal(
    materializeFactSpan(fact({ charStart: -1, charEnd: 4 }), messages, "on").outcome,
    "fallback",
  );
  assert.equal(
    materializeFactSpan(fact({ charStart: 5, charEnd: 5 }), messages, "on").outcome,
    "fallback",
  );
  assert.equal(
    materializeFactSpan(fact({ charStart: 9, charEnd: 4 }), messages, "on").outcome,
    "fallback",
  );
});

test("offset drift (turn text changed after stamping) is rejected", () => {
  // The stamp was computed over the exact double-spaced string the model saw;
  // the turn text here has been renormalized — verify must fail.
  const drifted: SpanMaterializeTurn[] = [
    { text: "Maya moved to Seattle.", stamp: stampSpanSource("Maya  moved  to Seattle.") },
  ];
  assert.notEqual(drifted[0].stamp.hash, stampSpanSource(drifted[0].text).hash);
  const result = materializeFactSpan(fact({ charStart: 0, charEnd: 4 }), drifted, "on");
  assert.equal(result.outcome, "fallback");
  assert.equal(result.fact.content, "Maya moved to Seattle last spring for a new senior role.");
  assert.equal(result.fact.span, undefined);
});

test("oversized slice (>400 chars) is rejected; exactly 400 passes", () => {
  const long = "a".repeat(600);
  const messages = turns(long);
  assert.equal(
    materializeFactSpan(fact({ charStart: 0, charEnd: SPAN_MAX_SLICE_CHARS + 1 }), messages, "on").outcome,
    "fallback",
  );
  assert.equal(
    materializeFactSpan(fact({ charStart: 0, charEnd: SPAN_MAX_SLICE_CHARS }), messages, "on").outcome,
    "span",
  );
});

test("whitespace-only slice and frame word-count limits are rejected", () => {
  const messages = turns("word1   word2 word3");
  const words = (count: number) => Array.from({ length: count }, (_, i) => `w${i}`).join(" ");
  assert.equal(
    materializeFactSpan(fact({ charStart: 5, charEnd: 7 }), messages, "on").outcome,
    "fallback",
  );
  assert.equal(
    materializeFactSpan(fact({ charStart: 0, charEnd: 5, frame: words(15) }), messages, "on").outcome,
    "span",
  );
  assert.equal(
    materializeFactSpan(fact({ charStart: 0, charEnd: 5, frame: "   " }), messages, "on").outcome,
    "fallback",
  );
});

test("per-fact fail-open: one invalid span among three persists all three", () => {
  const messages = turns(TURN_TEXT);
  const seattle = TURN_TEXT.indexOf("Seattle");
  const facts = [
    fact({ charStart: seattle, charEnd: seattle + 7, content: "fallback A" }),
    fact({ charStart: 0, charEnd: TURN_TEXT.length + 5, content: "fallback B" }),
    fact({ charStart: 0, charEnd: 4, content: "fallback C" }),
  ];
  const outcomes = facts.map((f) => materializeFactSpan(f, messages, "on"));
  assert.deepEqual(
    outcomes.map((o) => o.outcome),
    ["span", "fallback", "span"],
  );
  for (const outcome of outcomes) {
    assert.ok(outcome.fact.content.length > 0);
    assert.equal(outcome.fact.span, undefined);
  }
});

test("shadow mode is zero-diff: byte-identical facts vs the same input", () => {
  const messages = turns(TURN_TEXT);
  const seattle = TURN_TEXT.indexOf("Seattle");
  const spanFact = fact({ charStart: seattle, charEnd: seattle + 7, content: "generated restatement" });
  const shadow = materializeFactSpan(spanFact, messages, "shadow");
  assert.equal(shadow.outcome, "span");
  assert.equal(shadow.fact.content, "generated restatement", "shadow persists generated content");
  assert.ok(!("quote" in shadow.fact), "shadow does not touch the grounding quote");
  assert.equal(shadow.fact.span, undefined);
  // Zero-diff vs "off": the persisted fact is byte-identical to simply
  // stripping the span — same content, same fields, nothing added.
  const stripped = stripUntrustedFactSpans([spanFact])[0];
  assert.deepEqual(shadow.fact, stripped);
  // And the comparison materialization is still produced for telemetry.
  assert.equal(shadow.materialized, "Maya's relocation: Seattle");
});

test("shadow agreement predicate: exact or containment", () => {
  assert.equal(spanAgreesWithContent("a: b c", "b c"), true);
  assert.equal(spanAgreesWithContent("b c", "a: b c"), true);
  assert.equal(spanAgreesWithContent("a: b c", "a: b c"), true);
  assert.equal(spanAgreesWithContent("a: b c", "z z z"), false);
});

test("stray span in off-mode is stripped untrusted; factCarriesSpan detects spans", () => {
  const messages = turns(TURN_TEXT);
  const stray = fact({ charStart: 0, charEnd: 900, content: "kept" });
  assert.ok(factCarriesSpan(stray));
  const strippedFacts = stripUntrustedFactSpans([stray]);
  assert.equal(strippedFacts[0].span, undefined);
  assert.equal(strippedFacts[0].content, "kept");
  assert.ok(!factCarriesSpan(strippedFacts[0]));
  // materializeFactSpan in off mode never validates — callers strip instead;
  // a fallback here still must not lose content.
  const result = materializeFactSpan(stray, messages, "off");
  assert.equal(result.fact.content, "kept");
});

test("config: extraction.spanMode default off, valid values accepted, unknown rejected", () => {
  assert.equal(parseConfig({}).extraction.spanMode, "off");
  assert.equal(parseConfig({ extraction: { spanMode: "shadow" } }).extraction.spanMode, "shadow");
  assert.equal(parseConfig({ extraction: { spanMode: "on" } }).extraction.spanMode, "on");
  assert.equal(parseConfig({ extraction: {} }).extraction.spanMode, "off");
  assert.throws(
    () => parseConfig({ extraction: { spanMode: "sometimes" } }),
    /extraction\.spanMode must be one of "off", "shadow", "on"/,
  );
  assert.throws(
    () => parseConfig({ extraction: { spanMode: 1 } }),
    /extraction\.spanMode must be one of "off", "shadow", "on"/,
  );
});

test("config: extraction block must be an object, not an array or scalar", () => {
  assert.throws(() => parseConfig({ extraction: [] }), /extraction must be an object/);
  assert.throws(() => parseConfig({ extraction: "on" }), /extraction must be an object/);
  assert.throws(() => parseConfig({ extraction: null }), /extraction must be an object/);
});

test("config: unknown extraction keys including spanMode typos are rejected", () => {
  assert.throws(
    () => parseConfig({ extraction: { spanMdoe: "on" } }),
    /extraction has unknown property: spanMdoe/,
  );
  assert.throws(
    () => parseConfig({ extraction: { spanMode: "on", extra: true } }),
    /extraction has unknown property: extra/,
  );
  assert.equal(parseConfig({ extraction: { spanMode: "on" } }).extraction.spanMode, "on");
});

test("applyExtractionSpanMaterialization uses captured prompt stamps, not a restamp", () => {
  const generated = "Maya moved to Seattle last spring for a new senior role.";
  const result = {
    facts: [fact({ charStart: 0, charEnd: 4, content: generated })],
    entities: [],
    questions: [],
    profileUpdates: [],
  };
  const captured = buildSpanMaterializeTurns([TURN_TEXT]);
  const ok = applyExtractionSpanMaterialization(result, captured, "on");
  assert.equal(ok.facts[0]?.content, "Maya's relocation: Maya");

  const drifted = [{ text: TURN_TEXT, stamp: stampSpanSource("different prompt text") }];
  const fallback = applyExtractionSpanMaterialization(result, drifted, "on");
  assert.equal(fallback.facts[0]?.content, generated);
});

test("span sourceHash/sourceLength must match the captured prompt stamp", () => {
  const captured = buildSpanMaterializeTurns([TURN_TEXT]);
  const stamp = captured[0]?.stamp;
  assert.ok(stamp);
  const matching = materializeFactSpan(
    fact({ charStart: 0, charEnd: 4, sourceHash: stamp.hash, sourceLength: stamp.length }),
    captured,
    "on",
  );
  assert.equal(matching.outcome, "span");
  const mismatched = materializeFactSpan(
    fact({ charStart: 0, charEnd: 4, sourceHash: "0".repeat(64), sourceLength: stamp.length }),
    captured,
    "on",
  );
  assert.equal(mismatched.outcome, "fallback");
});

test("local prompt bind stamps the truncated visible prefix, not the unseen suffix", () => {
  const visible = "Maya moved to Seattle last spring";
  const unseen = " for a new senior role. UNSEEN_SUFFIX";
  const content = `${visible}${unseen}`;
  const turns: BufferTurn[] = [{ role: "user", content, timestamp: "2026-05-21T00:00:00.000Z" }];
  const { conversation, renderedConversation } = renderExtractionConversation(turns, undefined);
  const cut = conversation.indexOf(unseen);
  assert.ok(cut > 0);
  const bound = bindLocalExtractionPrompt(conversation, turns, cut, renderedConversation);
  assert.match(bound.promptConversation, /\[truncated\]$/);
  assert.equal(bound.spanTurns[0]?.text, visible);
  assert.equal(bound.spanTurns[0]?.stamp.length, visible.length);
  assert.notEqual(bound.spanTurns[0]?.stamp.hash, stampSpanSource(content).hash);

  const leakStart = content.indexOf("UNSEEN_SUFFIX");
  const againstFull = materializeFactSpan(
    fact({ charStart: leakStart, charEnd: content.length, content: "kept-frame" }),
    buildSpanMaterializeTurns([content]),
    "on",
  );
  assert.equal(againstFull.outcome, "span");
  assert.match(againstFull.fact.content ?? "", /UNSEEN_SUFFIX/);

  const againstBound = materializeFactSpan(
    fact({ charStart: leakStart, charEnd: content.length, content: "kept-frame" }),
    bound.spanTurns,
    "on",
  );
  assert.equal(againstBound.outcome, "fallback");
  assert.equal(againstBound.fact.content, "kept-frame");

  const visibleOk = materializeFactSpan(
    fact({
      charStart: 0,
      charEnd: visible.length,
      content: "kept-frame",
      sourceHash: bound.spanTurns[0]?.stamp.hash,
      sourceLength: bound.spanTurns[0]?.stamp.length,
    }),
    bound.spanTurns,
    "on",
  );
  assert.equal(visibleOk.outcome, "span");
  assert.equal(visibleOk.fact.quote, visible);
  const fullStamp = stampSpanSource(content);
  const wrongHash = materializeFactSpan(
    fact({
      charStart: 0,
      charEnd: visible.length,
      content: "kept-frame",
      sourceHash: fullStamp.hash,
      sourceLength: fullStamp.length,
    }),
    bound.spanTurns,
    "on",
  );
  assert.equal(wrongHash.outcome, "fallback");
});

test("on-mode facts that omit span are dropped instead of persisting the frame", () => {
  const generated = {
    facts: [
      {
        category: "fact" as const,
        content: "Maya's relocation",
        confidence: 0.9,
        tags: ["relocation"],
      },
    ],
    entities: [],
    questions: [],
    profileUpdates: [],
  };
  const on = applyExtractionSpanMaterialization(generated, turns(TURN_TEXT), "on");
  assert.equal(on.facts.length, 0);
  const shadow = applyExtractionSpanMaterialization(generated, turns(TURN_TEXT), "shadow");
  assert.equal(shadow.facts[0]?.content, "Maya's relocation");
  const off = applyExtractionSpanMaterialization(generated, turns(TURN_TEXT), "off");
  assert.equal(off.facts[0]?.content, "Maya's relocation");
});

test("on-mode mixed batch keeps validated spans and drops omitted spans", () => {
  const seattle = TURN_TEXT.indexOf("Seattle");
  const result = {
    facts: [
      fact({ charStart: seattle, charEnd: seattle + 7 }),
      {
        category: "fact" as const,
        content: "Maya's relocation",
        confidence: 0.9,
        tags: [],
      },
    ],
    entities: [],
    questions: [],
    profileUpdates: [],
  };
  const on = applyExtractionSpanMaterialization(result, turns(TURN_TEXT), "on");
  assert.equal(on.facts.length, 1);
  assert.equal(on.facts[0]?.content, "Maya's relocation: Seattle");
});
