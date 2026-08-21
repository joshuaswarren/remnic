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
  // Laplace: (0+1) / (0+1+2) = 1/3.
  assert.ok(Math.abs(result.score - 1 / 3) < 1e-9);
  assert.equal(result.confidence, 1);
});

test("single success does not saturate the memory (2/3, not 1)", () => {
  const result = computeMemoryWorth({ mw_success: 1, mw_fail: 0, now: NOW });
  // Laplace: (1+1) / (1+0+2) = 2/3.
  assert.ok(Math.abs(result.score - 2 / 3) < 1e-9);
  assert.equal(result.confidence, 1);
});

test("large counters converge toward empirical frequency", () => {
  // 90 successes out of 100 → raw frequency 0.9.
  // Laplace: (90+1) / (90+10+2) = 91 / 102 ≈ 0.8922.
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
  // Negative counters → treated as 0 (upstream already rejects, but defend).
  const negative = computeMemoryWorth({ mw_success: -5, mw_fail: -2, now: NOW });
  assert.equal(negative.score, 0.5);
  assert.equal(negative.confidence, 0);

  // NaN / Infinity counters → treated as 0.
  const nanCounter = computeMemoryWorth({
    mw_success: Number.NaN,
    mw_fail: Number.POSITIVE_INFINITY,
    now: NOW,
  });
  assert.equal(nanCounter.score, 0.5);
  assert.equal(nanCounter.confidence, 0);

  // Non-integer counters are refused outright (not floored). A stored `1.9`
  // is a corruption signal and we'd rather score to the prior than pretend
  // it was "1 real success".
  const floatCounter = computeMemoryWorth({
    mw_success: 1.9,
    mw_fail: 0,
    now: NOW,
  });
  assert.equal(floatCounter.confidence, 0);
  assert.equal(floatCounter.score, 0.5);
});

test("decay: stale outcomes are pulled back toward the prior", () => {
  // 5 successes, 0 failures, observed exactly one half-life ago.
  // With halfLife = 1d, decay factor = 0.5 so effective counts = (2.5, 0)
  // and score = (2.5+1)/(2.5+0+2) = 3.5/4.5 ≈ 0.7778. Without decay it would
  // have been (5+1)/(5+0+2) = 6/7 ≈ 0.857.
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
  // 1000 days old with a 1-day half-life ⇒ factor ≈ 2^-1000, functionally 0.
  // Effective counts are ~0, so the ratio lands on the uniform prior.
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
  // If a test / tool seeds lastAccessed slightly in the future, we must not
  // apply negative decay (which would blow up to >1). Age clamps to zero, so
  // the raw counts are used untouched.
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
  // Same as if no timestamp were supplied at all.
  const baseline = computeMemoryWorth({
    mw_success: 2,
    mw_fail: 1,
    now: NOW,
  });
  assert.equal(result.score, baseline.score);
  assert.equal(result.confidence, 3);
});

test("partial corruption fails the whole record to the prior", () => {
  // Codex P2: `mw_success: 10` with `mw_fail: NaN` must NOT read as strong
  // positive evidence. Either counter being corrupt must collapse both to
  // the prior.
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

  // Sanity: an absent counter is not corruption, so a record with
  // `mw_success: 10, mw_fail: undefined` still reads as strong positive
  // evidence (legacy half-instrumentation is allowed).
  const sGoodFAbsent = computeMemoryWorth({
    mw_success: 10,
    mw_fail: undefined,
    now: NOW,
  });
  assert.ok(sGoodFAbsent.score > 0.8);
  assert.equal(sGoodFAbsent.confidence, 10);
});

test("overflow-prone counters fail safely to the neutral prior", () => {
  // 1e308 + 1e308 + 2 overflows to Infinity in IEEE-754, which would drive
  // the ratio to 0 instead of the neutral 0.5. The helper must detect the
  // corruption and collapse to the prior.
  const huge = computeMemoryWorth({
    mw_success: 1e308,
    mw_fail: 1e308,
    now: NOW,
  });
  assert.equal(huge.score, 0.5);
  assert.equal(huge.confidence, 0);
  assert.ok(Number.isFinite(huge.score));
  assert.ok(Number.isFinite(huge.confidence));

  // Merely-very-large but still safe-integer counts should pass through
  // without collapsing. Laplace of (1000, 1000) is exactly 0.5.
  const large = computeMemoryWorth({
    mw_success: 1000,
    mw_fail: 1000,
    now: NOW,
  });
  assert.ok(Math.abs(large.score - 0.5) < 1e-9);
  assert.equal(large.confidence, 2000);
});

test("invalid `now` Date does not poison output with NaN", () => {
  // If a caller mis-constructs `now` (e.g., `new Date("bad")`), the helper
  // must still return finite, well-clamped numbers rather than NaN — a NaN
  // score would sort arbitrarily in downstream recall ranking.
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
  // With decay disabled by the invalid now, raw counts (2 successes, 1
  // failure) yield Laplace (2+1)/(2+1+2) = 3/5 = 0.6.
  assert.ok(Math.abs(result.score - 0.6) < 1e-9);
  assert.equal(result.confidence, 3);
});

test("score is always within [0, 1]", () => {
  // Extreme cases: huge failure count, tiny decay factor, etc.
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
  // These two fields are distinct in name so observability can label them
  // separately, but by construction they are the same number. Pin that so
  // a future diverging refactor is caught by tests.
  const r = computeMemoryWorth({ mw_success: 3, mw_fail: 2, now: NOW });
  assert.equal(r.score, r.p_success);
});
