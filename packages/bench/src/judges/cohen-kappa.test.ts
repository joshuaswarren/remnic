import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_JUDGE_BINARIZATION_THRESHOLD,
  bootstrapCohensKappaConfidenceInterval,
  binarizeJudgeScore,
  computeCohensKappa,
} from "./cohen-kappa.ts";

test("computeCohensKappa: perfect agreement → kappa = 1", () => {
  const result = computeCohensKappa(
    ["correct", "incorrect", "correct", "incorrect"],
    ["correct", "incorrect", "correct", "incorrect"],
  );
  assert.equal(result.kappa, 1);
  assert.equal(result.observedAgreement, 1);
  assert.equal(result.sampleSize, 4);
  assert.deepEqual([...result.categories], ["correct", "incorrect"]);
});

test("computeCohensKappa: identical single category for both raters → kappa = 1 (degenerate convention)", () => {
  // Both raters label everything "correct". p_e collapses to 1, so the
  // denominator is 0; convention returns 1 for perfect agreement.
  const result = computeCohensKappa(
    ["correct", "correct", "correct"],
    ["correct", "correct", "correct"],
  );
  assert.equal(result.kappa, 1);
  assert.equal(result.observedAgreement, 1);
  assert.equal(result.expectedAgreement, 1);
});

test("computeCohensKappa: pure disagreement → kappa < 0 (worse than chance)", () => {
  // Each rater uses both labels equally (marginals balanced → p_e = 0.5),
  // but they disagree on every item → p_o = 0 → kappa = -1.
  const result = computeCohensKappa(
    ["correct", "incorrect", "correct", "incorrect"],
    ["incorrect", "correct", "incorrect", "correct"],
  );
  assert.equal(result.kappa, -1);
  assert.equal(result.observedAgreement, 0);
  assert.equal(result.expectedAgreement, 0.5);
});

test("computeCohensKappa: kappa below raw agreement when marginals agree (Wikipedia 0.8→0.6 example)", () => {
  // Balanced marginals (5/5 each): 4 correct-correct + 4 incorrect-incorrect
  // = 8 agreements → p_o = 0.8. p_e = 0.5*0.5 + 0.5*0.5 = 0.5.
  // kappa = (0.8 - 0.5) / (1 - 0.5) = 0.6.
  // (Canonical "you cannot eyeball kappa from raw agreement" case.)
  const raterA = ["correct", "correct", "correct", "correct", "correct", "incorrect", "incorrect", "incorrect", "incorrect", "incorrect"];
  const raterB = ["correct", "correct", "correct", "correct", "incorrect", "incorrect", "incorrect", "incorrect", "incorrect", "correct"];
  const result = computeCohensKappa(raterA, raterB);
  assert.equal(result.observedAgreement, 0.8);
  assert.equal(result.expectedAgreement, 0.5);
  assert.ok(Math.abs(result.kappa - 0.6) < 1e-12);
});

test("computeCohensKappa: rejects mismatched lengths", () => {
  assert.throws(
    () => computeCohensKappa(["a", "b"], ["a"]),
    /equal length/,
  );
});

test("computeCohensKappa: rejects empty arrays", () => {
  assert.throws(
    () => computeCohensKappa([], []),
    /zero paired judgements/,
  );
});

test("bootstrapCohensKappaConfidenceInterval is deterministic and contains the point estimate", () => {
  const local = ["correct", "correct", "correct", "correct", "incorrect", "incorrect", "incorrect", "incorrect"];
  const frontier = ["correct", "correct", "correct", "incorrect", "incorrect", "incorrect", "incorrect", "correct"];
  const point = computeCohensKappa(local, frontier).kappa;
  const first = bootstrapCohensKappaConfidenceInterval(local, frontier, { iterations: 500 });
  const second = bootstrapCohensKappaConfidenceInterval(local, frontier, { iterations: 500 });
  assert.deepEqual(first, second);
  assert.equal(first.bootstrapSamples, 500);
  assert.equal(first.confidenceInterval.level, 0.95);
  assert.ok(first.confidenceInterval.lower <= point);
  assert.ok(first.confidenceInterval.upper >= point);
});

test("bootstrapCohensKappaConfidenceInterval validates paired input and options", () => {
  assert.throws(
    () => bootstrapCohensKappaConfidenceInterval(["correct"], []),
    /equal length/,
  );
  assert.throws(
    () => bootstrapCohensKappaConfidenceInterval([], []),
    /zero paired judgements/,
  );
  assert.throws(
    () => bootstrapCohensKappaConfidenceInterval(["correct"], ["correct"], { iterations: 0 }),
    /positive integer/,
  );
  assert.throws(
    () => bootstrapCohensKappaConfidenceInterval(["correct"], ["correct"], { level: 1 }),
    /between 0 and 1/,
  );
});
test("computeCohensKappa: skewed marginals depress kappa below raw agreement (textbook 2x2)", () => {
  // Unequal marginals: A is 7 correct / 3 incorrect; B is 8 correct / 2 incorrect.
  // They agree on 9 of 10 (p_o = 0.9), but because both skew toward "correct",
  // chance agreement is high → kappa ≈ 0.74, far below 0.9.
  //   p_e = (7/10 * 8/10) + (3/10 * 2/10) = 0.56 + 0.06 = 0.62
  //   kappa = (0.9 - 0.62) / (1 - 0.62) = 0.28 / 0.38 ≈ 0.7368
  const raterA = ["correct", "correct", "correct", "correct", "correct", "correct", "correct", "incorrect", "incorrect", "incorrect"];
  const raterB = ["correct", "correct", "correct", "correct", "correct", "correct", "correct", "incorrect", "incorrect", "correct"];
  const result = computeCohensKappa(raterA, raterB);
  assert.equal(result.observedAgreement, 0.9);
  assert.ok(Math.abs(result.expectedAgreement - 0.62) < 1e-12);
  assert.ok(Math.abs(result.kappa - 0.28 / 0.38) < 1e-12);
});

test("binarizeJudgeScore: correct/incorrect split at default threshold", () => {
  assert.equal(binarizeJudgeScore(1), "correct");
  assert.equal(binarizeJudgeScore(0.6), "correct");
  assert.equal(binarizeJudgeScore(DEFAULT_JUDGE_BINARIZATION_THRESHOLD), "correct");
  assert.equal(binarizeJudgeScore(0.49), "incorrect");
  assert.equal(binarizeJudgeScore(0), "incorrect");
});

test("binarizeJudgeScore: honors a custom threshold", () => {
  assert.equal(binarizeJudgeScore(0.8, 0.8), "correct");
  assert.equal(binarizeJudgeScore(0.79, 0.8), "incorrect");
});

test("binarizeJudgeScore: buckets non-finite scores as incorrect (no crash)", () => {
  assert.equal(binarizeJudgeScore(Number.NaN), "incorrect");
  assert.equal(binarizeJudgeScore(Number.POSITIVE_INFINITY), "incorrect");
  assert.equal(binarizeJudgeScore(Number.NEGATIVE_INFINITY), "incorrect");
});
