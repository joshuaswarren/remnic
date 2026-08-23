/**
 * Fake-provider determinism and cost-model tests (issue #2333 Phase A).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { SPAN_BENCH_FIXTURE } from "./fixture.ts";
import { renderSegment } from "./segment.ts";
import { runFakeExtraction, MS_PER_OUTPUT_TOKEN } from "./fake-provider.ts";
import { SpanModeFactSchema, CurrentModeFactSchema } from "./schema.ts";
import { materializeSpanFact } from "./materialize.ts";
import { tokenizeForJudge } from "./judge.ts";

const CONV = SPAN_BENCH_FIXTURE[0];

test("same model + seed is byte-identical across runs, both modes", () => {
  for (const mode of ["current", "span"] as const) {
    const first = runFakeExtraction(CONV, mode, 1234);
    const second = runFakeExtraction(CONV, mode, 1234);
    assert.equal(first.responsePayload, second.responsePayload);
    assert.equal(first.outputTokens, second.outputTokens);
    assert.equal(first.wallClockMs, second.wallClockMs);
  }
});

test("every fixture quote is a verbatim substring of its message (span invariants hold)", () => {
  for (const conversation of SPAN_BENCH_FIXTURE) {
    for (const fact of conversation.facts) {
      const text = conversation.messages[fact.messageIndex]?.text;
      assert.ok(text, `${conversation.id}/${fact.id}: message exists`);
      assert.ok(
        text.includes(fact.quote),
        `${conversation.id}/${fact.id}: quote not verbatim in message`,
      );
      assert.ok(
        fact.frame.trim().split(/\s+/).length <= 15,
        `${conversation.id}/${fact.id}: frame exceeds 15 words`,
      );
    }
  }
});

test("clean-seed span runs materialize every fact from the span (zero fallback)", () => {
  // Find a seed whose corruption draws all land outside the invalid/drift
  // bands for this conversation's three facts.
  const segment = renderSegment(CONV);
  for (let seed = 0; seed < 64; seed += 1) {
    const run = runFakeExtraction(CONV, "span", seed);
    const results = run.rawFacts.map((raw) =>
      materializeSpanFact(SpanModeFactSchema.parse(raw), segment.messages),
    );
    if (results.every((result) => result.outcome === "span")) {
      return; // found the clean seed; determinism guarantees it stays clean
    }
  }
  assert.fail("no clean seed found in [0, 64) — corruption rates are too high for 3 facts");
});

test("wall-clock is decode-bound on measured output tokens for both modes", () => {
  const current = runFakeExtraction(CONV, "current", 7);
  const span = runFakeExtraction(CONV, "span", 7);
  assert.equal(current.wallClockMs, current.outputTokens * MS_PER_OUTPUT_TOKEN);
  assert.equal(span.wallClockMs, span.outputTokens * MS_PER_OUTPUT_TOKEN);
  assert.ok(span.outputTokens < current.outputTokens, "span payload must cost fewer output tokens");
});

test("both mode payloads parse their schemas; span facts carry a span, current facts carry content", () => {
  const current = runFakeExtraction(CONV, "current", 7);
  const span = runFakeExtraction(CONV, "span", 7);
  for (const raw of current.rawFacts) {
    const fact = CurrentModeFactSchema.parse(raw);
    assert.ok(fact.content.length > 0);
    assert.equal(fact.span, undefined);
  }
  for (const raw of span.rawFacts) {
    const fact = SpanModeFactSchema.parse(raw);
    assert.ok(fact.span);
    assert.ok(Number.isInteger(fact.span.charStart));
  }
});

test("judge tokenization splits on non-alphanumerics and lowercases", () => {
  assert.deepEqual(tokenizeForJudge("Maya's FAI-2, tea!"), ["maya", "s", "fai", "2", "tea"]);
});
