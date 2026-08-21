import assert from "node:assert/strict";
import { test } from "node:test";
import { SPAN_OUTCOMES, tallySpanFallbacks } from "./extraction-span-fallback.js";
import {
  SPAN_GATE_MAX_FALLBACK_RATE_PCT,
  evaluateSpanPhaseGate,
} from "./extraction-span-gate.js";

test("tallySpanFallbacks: mixed outcomes compute the expected percentage", () => {
  const tally = tallySpanFallbacks(["span", "fallback", "span", "span", "fallback"]);
  assert.equal(tally.attempts, 5);
  assert.equal(tally.fallbacks, 2);
  assert.equal(tally.fallbackRatePct, 40);
});

test("tallySpanFallbacks: all-span is exactly 0", () => {
  const tally = tallySpanFallbacks(["span", "span", "span"]);
  assert.equal(tally.fallbacks, 0);
  assert.equal(tally.fallbackRatePct, 0);
});

test("tallySpanFallbacks: all-fallback is exactly 100", () => {
  const tally = tallySpanFallbacks(["fallback", "fallback"]);
  assert.equal(tally.fallbacks, 2);
  assert.equal(tally.fallbackRatePct, 100);
});

test("tallySpanFallbacks: zero attempts means no measurement, never NaN", () => {
  const tally = tallySpanFallbacks([]);
  assert.equal(tally.attempts, 0);
  assert.equal(tally.fallbacks, 0);
  assert.equal(tally.fallbackRatePct, null);
  assert.equal(Number.isNaN(tally.fallbackRatePct as unknown as number), false);
});

test("tallySpanFallbacks: unknown outcome throws and lists the allow-list", () => {
  assert.throws(() => tallySpanFallbacks(["span", "fall back"]), /unknown span outcome/);
  // No normalization: case variants are unknown outcomes, never successes.
  assert.throws(() => tallySpanFallbacks(["Span"]), /unknown span outcome/);
  assert.throws(() => tallySpanFallbacks(["FALLBACK"]), /unknown span outcome/);
  assert.throws(
    () => tallySpanFallbacks(["span", "fallback", "recovered"]),
    /unknown span outcome "recovered"; expected one of \[span, fallback\]/,
  );
  assert.deepEqual(SPAN_OUTCOMES, ["span", "fallback"]);
});

test("tallySpanFallbacks: non-array input throws", () => {
  assert.throws(() => tallySpanFallbacks("span" as never), /array/);
  assert.throws(() => tallySpanFallbacks(null as never), /array/);
  assert.throws(() => tallySpanFallbacks(undefined as never), /array/);
});

test("tallySpanFallbacks: 1-of-3 rounds deterministically across calls", () => {
  const first = tallySpanFallbacks(["fallback", "span", "span"]);
  const second = tallySpanFallbacks(["fallback", "span", "span"]);
  assert.equal(first.fallbackRatePct, 33.3333);
  assert.deepEqual(first, second);
});

test("tallySpanFallbacks: a rate at or above the gate bar is what the gate rejects", () => {
  const outcomes = [
    "span",
    "fallback",
    "span",
    "span",
    "fallback",
    "span",
    "span",
    "span",
    "span",
    "span",
  ];
  const tally = tallySpanFallbacks(outcomes);
  assert.equal(tally.fallbackRatePct, 20); // 2 of 10
  assert.ok(tally.fallbackRatePct >= SPAN_GATE_MAX_FALLBACK_RATE_PCT);
  const verdict = evaluateSpanPhaseGate({
    wallClockReductionPct: 30,
    judgeScoreDropPoints: 0,
    fallbackRatePct: tally.fallbackRatePct,
  });
  assert.equal(verdict.conditions.fallbackRate, false);
  assert.equal(verdict.pass, false);
  assert.ok(verdict.failed.includes("fallbackRate"));
});

test("tallySpanFallbacks: does not mutate the input", () => {
  const outcomes = ["span", "fallback", "span"];
  tallySpanFallbacks(outcomes);
  assert.deepEqual(outcomes, ["span", "fallback", "span"]);
});

// Review: a 0 rate satisfies the gate's `fallbackRatePct < 15`, so returning 0
// for an empty sample let an unmeasured run approve Phase B. null cannot be
// passed to the gate at all, which is the enforcement the comment lacked.
test("tallySpanFallbacks: an empty sample is null, which the gate cannot accept as a rate", () => {
  const tally = tallySpanFallbacks([]);
  assert.equal(tally.fallbackRatePct, null);
  assert.equal(tally.attempts, 0);
  assert.equal(Number.isNaN(tally.fallbackRatePct as unknown as number), false);
  // A measured all-span run is a real 0 and stays distinguishable from null.
  assert.equal(tallySpanFallbacks(["span"]).fallbackRatePct, 0);
});
