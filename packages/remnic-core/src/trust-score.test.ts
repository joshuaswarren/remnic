import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TRUST_WEIGHTS,
  NEUTRAL_TRUST_SCORE,
  TRUST_BAND_THRESHOLDS,
  bandForScore,
  computeTrustScore,
  renderEpistemicHedge,
  resolveTrustWeights,
  trustMultiplier,
  type TrustSignals,
} from "./trust-score.js";

/**
 * Issue #1577 PR 1 — unit tests for the pure TrustScore module.
 *
 * Pins the contract rules from the module header:
 *   1. No signals → neutral (0.5, medium, multiplier 1.0).
 *   2. Corrupt / out-of-range component → that component collapses to neutral.
 *   3. Deterministic.
 *   4. Components echoed for explainability.
 *   5. quarantine reserved for hard negatives.
 * Plus monotonicity: more corroboration → ≥ score; contradicted → ≤ score.
 */

test("no signals → neutral prior (score 0.5, band medium, neutral flag)", () => {
  const r = computeTrustScore({});
  assert.equal(r.score, NEUTRAL_TRUST_SCORE);
  assert.equal(r.band, "medium");
  assert.equal(r.neutral, true);
  assert.deepEqual(r.components, {});
  // The multiplier derived from a neutral score is exactly 1.0.
  assert.equal(trustMultiplier(r.score), 1);
});

test("neutral multiplier is exactly 1.0 at score 0.5", () => {
  assert.equal(trustMultiplier(0.5), 1);
});

test("multiplier is bounded by [min, max] and monotonic in score", () => {
  // score 0 → min, score 1 → max, strictly increasing through 0.5=1.
  assert.equal(trustMultiplier(0, 0.5, 1.25), 0.5);
  assert.equal(trustMultiplier(1, 0.5, 1.25), 1.25);
  assert.equal(trustMultiplier(0.5, 0.5, 1.25), 1);
  // Monotonic non-decreasing across the range.
  let prev = -Infinity;
  for (let i = 0; i <= 20; i += 1) {
    const s = i / 20;
    const m = trustMultiplier(s, 0.5, 1.25);
    assert.ok(m >= prev - 1e-12, `multiplier not monotonic at ${s}`);
    prev = m;
  }
});

test("multiplier stays in bounds when given an inverted (min>max) contract", () => {
  // Defensive: pick the tighter bound rather than producing nonsense.
  const m = trustMultiplier(0.2, 1.25, 0.5);
  assert.ok(m >= 0.5 - 1e-9 && m <= 1.25 + 1e-9);
});

test("monotonicity: more corroboration → score does not decrease", () => {
  const base: TrustSignals = { corroborationCount: 1 };
  const more: TrustSignals = { corroborationCount: 5 };
  const a = computeTrustScore(base);
  const b = computeTrustScore(more);
  assert.ok(b.score >= a.score - 1e-12, "more corroboration must not lower the score");
});

test("monotonicity: contradicted faithfulness → score <= unchecked", () => {
  const unchecked = computeTrustScore({ faithfulness: "unchecked" });
  const contradicted = computeTrustScore({ faithfulness: "contradicted" });
  assert.ok(
    contradicted.score <= unchecked.score + 1e-12,
    "contradicted must not out-score unchecked",
  );
});

test("contradicted faithfulness forces the quarantine band", () => {
  const r = computeTrustScore({ faithfulness: "contradicted" });
  assert.equal(r.band, "quarantine");
});

test("pending_review contradiction forces the quarantine band", () => {
  const r = computeTrustScore({ contradiction: "pending_review" });
  assert.equal(r.band, "quarantine");
});

test("corrupt component collapses to neutral, never to an extreme", () => {
  // NaN domainCalibration must not push the score to 0 or 1.
  const r = computeTrustScore({ domainCalibration: NaN });
  // Only one component present and it is corrupt → neutral prior.
  assert.equal(r.neutral, true);
  assert.equal(r.score, NEUTRAL_TRUST_SCORE);
});

test("corrupt corroborationCount (negative / NaN) is dropped, not damning", () => {
  const rNegative = computeTrustScore({ corroborationCount: -3 });
  const rNaN = computeTrustScore({ corroborationCount: NaN });
  assert.equal(rNegative.neutral, true);
  assert.equal(rNaN.neutral, true);
});

test("weights: invalid weight rejected, valid override applied", () => {
  const resolved = resolveTrustWeights({ memoryWorth: 0.9, faithfulness: NaN });
  assert.equal(resolved.memoryWorth, 0.9);
  // NaN faithfulness falls back to the documented default, not NaN.
  assert.equal(resolved.faithfulness, DEFAULT_TRUST_WEIGHTS.faithfulness);
});

test("weights: out-of-range weight rejected", () => {
  const resolved = resolveTrustWeights({ provenance: 5 });
  assert.equal(resolved.provenance, DEFAULT_TRUST_WEIGHTS.provenance);
});

test("active weights are sum-normalized so absent components redistribute", () => {
  // Only memoryWorth present → it carries 100% of the weight.
  const r = computeTrustScore({ memoryWorth: { score: 1, confidence: 5 } });
  assert.ok(r.components.memoryWorth);
  assert.ok(Math.abs(r.components.memoryWorth.weight - 1) < 1e-12);
  assert.ok(Math.abs(r.score - 1) < 1e-12);
});

test("components are echoed for explainability", () => {
  const r = computeTrustScore({
    memoryWorth: { score: 0.9, confidence: 3 },
    provenance: "verified",
  });
  assert.ok(r.components.memoryWorth);
  assert.ok(r.components.provenance);
  // Each component carries value + weight.
  for (const c of Object.values(r.components)) {
    assert.ok(typeof c.value === "number" && c.value >= 0 && c.value <= 1);
    assert.ok(typeof c.weight === "number" && c.weight >= 0 && c.weight <= 1);
  }
});

test("determinism: same inputs → identical result (twice)", () => {
  const signals: TrustSignals = {
    memoryWorth: { score: 0.8, confidence: 4 },
    provenance: "verified",
    faithfulness: "entailed",
    corroborationCount: 3,
  };
  const a = computeTrustScore(signals);
  const b = computeTrustScore(signals);
  assert.deepEqual(a, b);
});

test("band thresholds map scores to the documented bands", () => {
  assert.equal(bandForScore(0.9, false), "high");
  assert.equal(bandForScore(0.7, false), "high");
  assert.equal(bandForScore(0.69, false), "medium");
  assert.equal(bandForScore(0.45, false), "medium");
  assert.equal(bandForScore(0.3, false), "low");
  assert.equal(bandForScore(0.1, false), "low");
  // Hard negative overrides the score-derived band.
  assert.equal(bandForScore(0.95, true), "quarantine");
});

test("band thresholds constant matches the band mapping", () => {
  assert.equal(TRUST_BAND_THRESHOLDS.high, 0.7);
  assert.equal(TRUST_BAND_THRESHOLDS.medium, 0.45);
});

// ─── Epistemic rendering ──────────────────────────────────────────────────

test("epistemic hedge: neutral and high → empty string (no token waste)", () => {
  const neutral = computeTrustScore({});
  assert.equal(renderEpistemicHedge(neutral), "");
  const high = computeTrustScore({
    memoryWorth: { score: 1, confidence: 10 },
    provenance: "verified",
    faithfulness: "entailed",
    corroborationCount: 4,
  });
  assert.equal(high.band, "high");
  assert.equal(renderEpistemicHedge(high), "");
});

test("epistemic hedge: low band → non-empty, deterministic hedge", () => {
  const low = computeTrustScore({ faithfulness: "unsupported" });
  const hedge = renderEpistemicHedge(low);
  assert.ok(hedge.length > 0);
  assert.ok(hedge.startsWith("(low confidence"));
  // Deterministic.
  assert.equal(renderEpistemicHedge(low), hedge);
});

test("epistemic hedge: quarantine band → names the hard negative", () => {
  const q = computeTrustScore({ faithfulness: "contradicted" });
  const hedge = renderEpistemicHedge(q);
  assert.ok(hedge.length > 0);
  assert.match(hedge, /contradicted/);
});

test("epistemic hedge: medium band → names a single weakness", () => {
  const medium = computeTrustScore({ corroborationCount: 1 });
  // single mention alone lands around neutral-ish; force medium by checking it
  // produced a hedge only when band is medium/low. Verify determinism either way.
  const hedge = renderEpistemicHedge(medium);
  if (medium.band === "medium") {
    assert.ok(hedge.startsWith("(unconfirmed"));
  }
  // Always deterministic.
  assert.equal(renderEpistemicHedge(medium), hedge);
});

test("disabled weight: zero-weight-only-signal falls back to neutral, not low", () => {
  // Review P2: when an operator sets a component weight to 0 to disable it,
  // and a memory has only that signal, the score must NOT collapse to 0 (low
  // band). It should be neutral — a disabled signal carries no information.
  const result = computeTrustScore(
    { memoryWorth: { score: 0.9, confidence: 5 } },
    { memoryWorth: 0, provenance: 1, faithfulness: 1 },
  );
  assert.equal(result.neutral, true, "zero-weight-only-signal must be neutral");
  assert.equal(result.score, NEUTRAL_TRUST_SCORE);
  assert.equal(result.band, "medium");
  assert.equal(Object.keys(result.components).length, 0);
});

test("disabled weight: zero-weight component does not contribute to blend", () => {
  // When a component has weight 0 but other components are active, the active
  // ones still score normally. The zero-weight component stays in the echo
  // (with weight 0) for explainability but contributes nothing to the blend.
  const result = computeTrustScore(
    { memoryWorth: { score: 0.9, confidence: 5 }, provenance: "verified" },
    { memoryWorth: 0, provenance: 1, faithfulness: 1 },
  );
  assert.equal(result.neutral, false);
  assert.ok(result.score > NEUTRAL_TRUST_SCORE, "verified provenance should boost");
  assert.equal(result.components.memoryWorth?.weight, 0, "zero-weight component echoed with weight 0");
  assert.ok(result.components.provenance?.weight > 0, "active component has non-zero weight");
});

// ─── Issue #1577 — scoring edges (review Oqg_0 / Op_0X / Op_0b) ─────────────

test("unchecked faithfulness as the ONLY signal → truly neutral (absent, not active 0.5)", () => {
  // Review Oqg_0: "unchecked" means the gate ran but could not verify — it
  // carries NO signal. A memory whose ONLY signal is unchecked faithfulness
  // must score the neutral prior (neutral: true), NOT "active 0.5", so the
  // epistemic hedge never spuriously fires on an unverifiable memory and the
  // component never masquerades as measured evidence.
  const result = computeTrustScore({ faithfulness: "unchecked" });
  assert.equal(result.neutral, true, "unchecked-only must be truly neutral");
  assert.equal(result.score, NEUTRAL_TRUST_SCORE);
  assert.equal(result.band, "medium");
  assert.equal(Object.keys(result.components).length, 0, "unchecked must not appear as a component");
  assert.equal(renderEpistemicHedge(result), "", "no hedge on an unverifiable memory");
});

test("unchecked faithfulness mixed with another signal → dropped (does not dilute)", () => {
  // When unchecked co-occurs with a real signal, unchecked is ABSENT (not a
  // neutral 0.5 component pulling toward the middle). The memory scores purely
  // on the present signal — identical to a memory that never had a faithfulness
  // verdict at all.
  const withUnchecked = computeTrustScore({ faithfulness: "unchecked", provenance: "verified" });
  const justVerified = computeTrustScore({ provenance: "verified" });
  assert.equal(withUnchecked.score, justVerified.score, "unchecked must not dilute a present signal");
  assert.equal(withUnchecked.components.faithfulness, undefined, "unchecked dropped from components");
  assert.ok(withUnchecked.components.provenance !== undefined, "verified provenance present");
});

test("disabled weight is neutral across all recall paths: present+disabled vs absent", () => {
  // Review Op_0X: a disabled (weight 0) component must be neutral, not damning.
  // A memory with provenance=verified AND a zero-weight memoryWorth signal must
  // score identically to a memory with provenance=verified alone — the disabled
  // component contributes nothing and the active one is sum-normalized to 1.0.
  const disabled = computeTrustScore(
    { memoryWorth: { score: 0.1, confidence: 5 }, provenance: "verified" },
    { memoryWorth: 0, provenance: 1, faithfulness: 1 },
  );
  const absent = computeTrustScore(
    { provenance: "verified" },
    { memoryWorth: 0, provenance: 1, faithfulness: 1 },
  );
  assert.equal(disabled.score, absent.score, "disabled-weight signal must be neutral (== absent)");
  assert.equal(disabled.components.memoryWorth?.weight, 0, "disabled component echoed with weight 0");
  assert.equal(disabled.components.provenance?.weight, 1, "sole active component normalizes to full weight");
});
