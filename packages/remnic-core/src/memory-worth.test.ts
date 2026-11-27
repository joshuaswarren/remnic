import test from "node:test";
import assert from "node:assert/strict";

import { computeMemoryWorth } from "./memory-worth.js";

/**
 * Issue #560 PR 2 — unit tests for `computeMemoryWorth`.
 *
 * These tests pin the mathematical properties of the scorer:
 *   - Uninstrumented memories score to the neutral prior (0.5).
 *   - A single failure drags the score below 0.5 but not to 0.
 *   - A single success raises the score above 0.5 but not to 1.
 *   - Large counters converge toward empirical frequency.
 *   - Corrupt inputs (negatives, NaN, floats) collapse to the prior.
 *   - Recency decay pulls stale outcomes back toward the prior.
 */

const NOW = new Date("2026-01-01T00:00:00.000Z");

test("neutral prior: no counters, no timestamps", () => {
  const result = computeMemoryWorth({ now: NOW });
  assert.equal(result.score, 0.5);
  assert.equal(result.p_success, 0.5);
  assert.equal(result.confidence, 0);
});

test("neutral prior: explicit zero counters match absent counters", () => {
  const absent = computeMemoryWorth({ now: NOW });
  const zero = computeMemoryWorth({ mw_success: 0, mw_fail: 0, now: NOW });
  assert.equal(zero.score, absent.score);
  assert.equal(zero.confidence, 0);
});

test("single failure does not exile the memory (1/3, not 0)", () => {
  const result = computeMemoryWorth({ mw_success: 0, mw_fail: 1, now: NOW });
  assert.ok(Math.abs(result.score - 1 / 3) < 1e-9);
  assert.equal(result.confidence, 1);
});

test("single success does not saturate the memory (2/3, not 1)", () => {
  const result = computeMemoryWorth({ mw_success: 1, mw_fail: 0, now: NOW });
  assert.ok(Math.abs(result.score - 2 / 3) < 1e-9);
  assert.equal(result.confidence, 1);
});

test("large counters converge toward empirical frequency", () => {
  const result = computeMemoryWorth({
    mw_success: 90,
    mw_fail: 10,
    now: NOW,
  });
  assert.ok(Math.abs(result.score - 91 / 102) < 1e-9);
  assert.ok(result.score > 0.88, `expected score near 0.89, got ${result.score}`);
  assert.ok(result.score < 0.90);
  assert.equal(result.confidence, 100);
});

test("symmetry: equal successes and failures score exactly 0.5", () => {
  const result = computeMemoryWorth({
    mw_success: 5,
    mw_fail: 5,
    now: NOW,
  });
  assert.equal(result.score, 0.5);
  assert.equal(result.confidence, 10);
});

test("score is monotonic in successes (more wins ⇒ higher score)", () => {
  const low = computeMemoryWorth({ mw_success: 1, mw_fail: 5, now: NOW });
  const mid = computeMemoryWorth({ mw_success: 3, mw_fail: 3, now: NOW });
  const high = computeMemoryWorth({ mw_success: 5, mw_fail: 1, now: NOW });
  assert.ok(low.score < mid.score);
  assert.ok(mid.score < high.score);
});

test("corrupt inputs (negative, NaN, float) fail safely to prior", () => {
  const negative = computeMemoryWorth({ mw_success: -5, mw_fail: -2, now: NOW });
  assert.equal(negative.score, 0.5);
  assert.equal(negative.confidence, 0);

  const nanCounter = computeMemoryWorth({
    mw_success: Number.NaN,
    mw_fail: Number.POSITIVE_INFINITY,
    now: NOW,
  });
  assert.equal(nanCounter.score, 0.5);
  assert.equal(nanCounter.confidence, 0);

  const floatCounter = computeMemoryWorth({
    mw_success: 1.9,
    mw_fail: 0,
    now: NOW,
  });
  assert.equal(floatCounter.confidence, 0);
  assert.equal(floatCounter.score, 0.5);
});

test("decay: stale outcomes are pulled back toward the prior", () => {
  const dayMs = 24 * 60 * 60 * 1000;
  const lastAccessed = new Date(NOW.getTime() - dayMs).toISOString();
  const decayed = computeMemoryWorth({
    mw_success: 5,
    mw_fail: 0,
    lastAccessed,
    now: NOW,
    halfLifeMs: dayMs,
  });
  const fresh = computeMemoryWorth({
    mw_success: 5,
    mw_fail: 0,
    now: NOW,
  });
  assert.ok(
    decayed.score < fresh.score,
    `decayed score ${decayed.score} should be lower than fresh ${fresh.score}`,
  );
  assert.ok(Math.abs(decayed.score - 3.5 / 4.5) < 1e-9);
  assert.ok(Math.abs(decayed.confidence - 2.5) < 1e-9);
});

test("decay: extremely old outcomes collapse toward 0.5", () => {
  const dayMs = 24 * 60 * 60 * 1000;
  const lastAccessed = new Date(NOW.getTime() - 1000 * dayMs).toISOString();
  const result = computeMemoryWorth({
    mw_success: 100,
    mw_fail: 0,
    lastAccessed,
    now: NOW,
    halfLifeMs: dayMs,
  });
  assert.ok(Math.abs(result.score - 0.5) < 1e-6);
  assert.ok(result.confidence < 1e-6);
});

test("decay: zero or negative half-life disables decay", () => {
  const dayMs = 24 * 60 * 60 * 1000;
  const lastAccessed = new Date(NOW.getTime() - 100 * dayMs).toISOString();
  const zero = computeMemoryWorth({
    mw_success: 5,
    mw_fail: 0,
    lastAccessed,
    now: NOW,
    halfLifeMs: 0,
  });
  const negative = computeMemoryWorth({
    mw_success: 5,
    mw_fail: 0,
    lastAccessed,
    now: NOW,
    halfLifeMs: -1,
  });
  const undefinedHalfLife = computeMemoryWorth({
    mw_success: 5,
    mw_fail: 0,
    lastAccessed,
    now: NOW,
  });
  assert.equal(zero.score, undefinedHalfLife.score);
  assert.equal(negative.score, undefinedHalfLife.score);
  assert.equal(zero.confidence, 5);
});

test("decay: future lastAccessed timestamps clamp to age=0", () => {
  const dayMs = 24 * 60 * 60 * 1000;
  const lastAccessed = new Date(NOW.getTime() + dayMs).toISOString();
  const fresh = computeMemoryWorth({
    mw_success: 3,
    mw_fail: 1,
    lastAccessed,
    now: NOW,
    halfLifeMs: dayMs,
  });
  const sameWithoutTimestamp = computeMemoryWorth({
    mw_success: 3,
    mw_fail: 1,
    now: NOW,
  });
  assert.equal(fresh.score, sameWithoutTimestamp.score);
  assert.equal(fresh.confidence, 4);
});

test("decay: unparseable lastAccessed is ignored, not fatal", () => {
  const result = computeMemoryWorth({
    mw_success: 2,
    mw_fail: 1,
    lastAccessed: "not-a-date",
    now: NOW,
    halfLifeMs: 1000,
  });
  const baseline = computeMemoryWorth({
    mw_success: 2,
    mw_fail: 1,
    now: NOW,
  });
  assert.equal(result.score, baseline.score);
  assert.equal(result.confidence, 3);
});

test("partial corruption fails the whole record to the prior", () => {
  const sGoodFBad = computeMemoryWorth({
    mw_success: 10,
    mw_fail: Number.NaN,
    now: NOW,
  });
  assert.equal(sGoodFBad.score, 0.5);
  assert.equal(sGoodFBad.confidence, 0);

  const sBadFGood = computeMemoryWorth({
    mw_success: -1,
    mw_fail: 10,
    now: NOW,
  });
  assert.equal(sBadFGood.score, 0.5);
  assert.equal(sBadFGood.confidence, 0);

  const sGoodFAbsent = computeMemoryWorth({
    mw_success: 10,
    mw_fail: undefined,
    now: NOW,
  });
  assert.ok(sGoodFAbsent.score > 0.8);
  assert.equal(sGoodFAbsent.confidence, 10);
});

test("overflow-prone counters fail safely to the neutral prior", () => {
  const huge = computeMemoryWorth({
    mw_success: 1e308,
    mw_fail: 1e308,
    now: NOW,
  });
  assert.equal(huge.score, 0.5);
  assert.equal(huge.confidence, 0);
  assert.ok(Number.isFinite(huge.score));
  assert.ok(Number.isFinite(huge.confidence));

  const large = computeMemoryWorth({
    mw_success: 1000,
    mw_fail: 1000,
    now: NOW,
  });
  assert.ok(Math.abs(large.score - 0.5) < 1e-9);
  assert.equal(large.confidence, 2000);
});

test("invalid `now` Date does not poison output with NaN", () => {
  const invalidNow = new Date("not-a-date");
  const result = computeMemoryWorth({
    mw_success: 2,
    mw_fail: 1,
    lastAccessed: "2025-01-01T00:00:00.000Z",
    now: invalidNow,
    halfLifeMs: 1000,
  });
  assert.ok(Number.isFinite(result.score));
  assert.ok(Number.isFinite(result.p_success));
  assert.ok(Number.isFinite(result.confidence));
  assert.ok(result.score >= 0 && result.score <= 1);
  assert.ok(Math.abs(result.score - 0.6) < 1e-9);
  assert.equal(result.confidence, 3);
});

test("score is always within [0, 1]", () => {
  const cases = [
    { mw_success: 0, mw_fail: 1_000_000 },
    { mw_success: 1_000_000, mw_fail: 0 },
    { mw_success: 1_000_000, mw_fail: 1_000_000 },
  ];
  for (const c of cases) {
    const r = computeMemoryWorth({ ...c, now: NOW });
    assert.ok(r.score >= 0 && r.score <= 1, `score out of range for ${JSON.stringify(c)}: ${r.score}`);
    assert.ok(r.p_success >= 0 && r.p_success <= 1);
  }
});

test("p_success mirrors score", () => {
  const r = computeMemoryWorth({ mw_success: 3, mw_fail: 2, now: NOW });
  assert.equal(r.score, r.p_success);
});
