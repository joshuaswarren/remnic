import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import path from "node:path";

import {
  CALIBRATION_SLICE_SIZE,
  JUDGE_CALIBRATION_KAPPA_THRESHOLD,
  loadJudgeCalibrationState,
  runJudgeCalibration,
  selectCalibrationSlice,
  writeJudgeCalibrationState,
  type CalibrationAnswer,
} from "./calibration-slice.ts";

/** Stub judge that returns a fixed score per questionId (deterministic). */
function makeStubJudge(scoreById: Record<string, number>): BenchJudge {
  return {
    async score(
      _question: string,
      _predicted: string,
      _expected: string,
      _control?: BenchPhaseControl,
    ): Promise<number> {
      // score() doesn't carry the question id, so the stub keys on `expected`
      // which our fixtures set to the question id for lookup.
      throw new Error("makeStubJudge: use scoreWithMetrics or key via expected");
    },
    async scoreWithMetrics(
      _question: string,
      _predicted: string,
      expected: string,
      _control?: BenchPhaseControl,
    ): Promise<{ score: number; tokens: { input: number; output: number }; latencyMs: number; model?: string }> {
      const score = scoreById[expected] ?? 0;
      return { score, tokens: { input: 1, output: 1 }, latencyMs: 1 };
    },
  };
}

// `runJudgeCalibration` calls `.score()` (the scalar surface). Build a stub
// whose `.score()` resolves a per-question verdict by matching the predicted
// text, which carries the question identity in these fixtures.
function makeScalarStubJudge(predictedToScore: Record<string, number>): BenchJudge {
  return {
    async score(
      _question: string,
      predicted: string,
      _expected: string,
      _control?: BenchPhaseControl,
    ): Promise<number> {
      return predictedToScore[predicted] ?? 0;
    },
  };
}

function makeAnswers(count: number): CalibrationAnswer[] {
  const answers: CalibrationAnswer[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `q${index}`;
    answers.push({
      questionId: id,
      question: `question ${id}`,
      // Predicted text doubles as the lookup key for the scalar stub.
      predicted: id,
      expected: `gold-${id}`,
    });
  }
  return answers;
}

test("selectCalibrationSlice: deterministic — same input yields same slice across calls", () => {
  const ids = Array.from({ length: 80 }, (_, index) => `question-${index}`);
  const slice1 = selectCalibrationSlice(ids);
  const slice2 = selectCalibrationSlice(ids);
  assert.deepEqual(slice1, slice2);
});

test("selectCalibrationSlice: default size is 50", () => {
  const ids = Array.from({ length: 80 }, (_, index) => `question-${index}`);
  const slice = selectCalibrationSlice(ids);
  assert.equal(slice.length, CALIBRATION_SLICE_SIZE);
});

test("selectCalibrationSlice: returns all ids when fewer than size", () => {
  const ids = ["a", "b", "c"];
  const slice = selectCalibrationSlice(ids);
  assert.deepEqual([...slice].sort(), ["a", "b", "c"]);
});

test("selectCalibrationSlice: order is by sha256(id), not insertion order", () => {
  const ids = ["a", "b", "c", "d", "e"];
  const slice = selectCalibrationSlice(ids);
  // Deterministic but NOT insertion order — prove the hash sort moved things.
  assert.notDeepEqual(slice, ids);
  // And it is a permutation of the input.
  assert.deepEqual([...slice].sort(), [...ids].sort());
});

test("selectCalibrationSlice: dedupes duplicate ids", () => {
  const slice = selectCalibrationSlice(["a", "a", "b", "b"], 10);
  assert.deepEqual([...slice].sort(), ["a", "b"]);
});

test("selectCalibrationSlice: rejects empty / non-string ids", () => {
  assert.throws(
    () => selectCalibrationSlice([("a" as unknown) as string, ""]),
    /non-empty strings/,
  );
  assert.throws(
    () => selectCalibrationSlice([], 0),
    /positive integer/,
  );
});

test("runJudgeCalibration: perfect agreement → kappa = 1, no warning", async () => {
  const answers = makeAnswers(60);
  // Both judges score 1.0 on every slice answer → all "correct" → kappa = 1.
  const predictedToScore: Record<string, number> = {};
  for (const answer of answers) {
    predictedToScore[answer.predicted] = 1;
  }
  const result = await runJudgeCalibration({
    benchmarkId: "locomo",
    localJudge: makeScalarStubJudge(predictedToScore),
    frontierJudge: makeScalarStubJudge(predictedToScore),
    answers,
    sliceSize: 50,
  });
  assert.equal(result.kappa, 1);
  assert.equal(result.warning, false);
  assert.equal(result.sampleSize, 50);
  assert.equal(result.sliceQuestionIds.length, 50);
  assert.equal(result.threshold, JUDGE_CALIBRATION_KAPPA_THRESHOLD);
});

test("runJudgeCalibration: systematic disagreement → warning when kappa < threshold", async () => {
  const answers = makeAnswers(20);
  const localScores: Record<string, number> = {};
  const frontierScores: Record<string, number> = {};
  // Local says correct on all; frontier says correct on first half, incorrect on second.
  for (let index = 0; index < answers.length; index += 1) {
    const key = answers[index].predicted;
    localScores[key] = 1;
    frontierScores[key] = index < answers.length / 2 ? 1 : 0;
  }
  const result = await runJudgeCalibration({
    benchmarkId: "locomo",
    localJudge: makeScalarStubJudge(localScores),
    frontierJudge: makeScalarStubJudge(frontierScores),
    answers,
    sliceSize: 20,
  });
  // 10/20 agree → p_o = 0.5; marginals: local 20 correct, frontier 10 correct/10 incorrect.
  // p_e = (1 * 0.5) + (0 * 0.5) = 0.5 → kappa = (0.5 - 0.5)/(0.5) = 0.
  assert.ok(Math.abs(result.kappa) < 1e-12);
  assert.equal(result.warning, true); // 0 < 0.7
  assert.equal(result.benchmarkId, "locomo");
  assert.equal(result.verdicts.length, 20);
});

test("runJudgeCalibration: custom binScore and threshold honored", async () => {
  const answers = makeAnswers(4);
  const scores: Record<string, number> = {};
  for (const answer of answers) {
    scores[answer.predicted] = 0.9;
  }
  // Use a binScore that labels everything "strong" — perfect agreement on a
  // single category → kappa = 1 (degenerate), but threshold 0.95 makes the
  // single 1.0 still pass (1.0 >= 0.95 → no warning).
  const result = await runJudgeCalibration({
    benchmarkId: "longmemeval",
    localJudge: makeScalarStubJudge(scores),
    frontierJudge: makeScalarStubJudge(scores),
    answers,
    sliceSize: 4,
    binScore: () => "strong",
    threshold: 0.95,
  });
  assert.equal(result.kappa, 1);
  assert.equal(result.warning, false);
  assert.equal(result.threshold, 0.95);
  assert.deepEqual([...result.categories], ["strong"]);
});

test("runJudgeCalibration: rejects empty answers (slice empty → kappa undefined)", async () => {
  await assert.rejects(
    () =>
      runJudgeCalibration({
        benchmarkId: "locomo",
        localJudge: makeScalarStubJudge({}),
        frontierJudge: makeScalarStubJudge({}),
        answers: [],
      }),
    /zero paired judgements/,
  );
});

test("runJudgeCalibration: respects sliceSize smaller than available answers", async () => {
  const answers = makeAnswers(60);
  const scores: Record<string, number> = {};
  for (const answer of answers) {
    scores[answer.predicted] = 1;
  }
  const result = await runJudgeCalibration({
    benchmarkId: "locomo",
    localJudge: makeScalarStubJudge(scores),
    frontierJudge: makeScalarStubJudge(scores),
    answers,
    sliceSize: 10,
  });
  assert.equal(result.sampleSize, 10);
  assert.equal(result.sliceQuestionIds.length, 10);
});

test("runJudgeCalibration: non-finite judge scores do not crash calibration", async () => {
  const answers = makeAnswers(4);
  const result = await runJudgeCalibration({
    benchmarkId: "locomo",
    localJudge: makeScalarStubJudge(Object.fromEntries(answers.map((a) => [a.predicted, Number.NaN]))),
    frontierJudge: makeScalarStubJudge(Object.fromEntries(answers.map((a) => [a.predicted, 1]))),
    answers,
    sliceSize: 4,
  });
  // NaN → "incorrect" everywhere (local); 1 → "correct" everywhere (frontier).
  // Disjoint category sets ⇒ p_e = 0 ⇒ kappa = p_o = 0. The point: a broken
  // judge producing NaN does not throw; it surfaces as total disagreement.
  assert.equal(result.kappa, 0);
  assert.equal(result.warning, true);
});

test("writeJudgeCalibrationState + loadJudgeCalibrationState round-trip the artifact subset", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bench-calib-"));
  try {
    const result = await runJudgeCalibration({
      benchmarkId: "locomo",
      localJudge: makeScalarStubJudge(Object.fromEntries(makeAnswers(10).map((a) => [a.predicted, 1]))),
      frontierJudge: makeScalarStubJudge(Object.fromEntries(makeAnswers(10).map((a) => [a.predicted, 1]))),
      answers: makeAnswers(10),
      sliceSize: 10,
    });
    const written = await writeJudgeCalibrationState(result, dir);
    assert.equal(path.basename(written), "locomo.json");

    const loaded = await loadJudgeCalibrationState("locomo", dir);
    assert.notEqual(loaded, undefined);
    assert.equal(loaded?.kappa, result.kappa);
    assert.equal(loaded?.sampleSize, result.sampleSize);
    assert.equal(loaded?.threshold, result.threshold);
    assert.equal(loaded?.warning, result.warning);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadJudgeCalibrationState returns undefined when no state exists", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bench-calib-empty-"));
  try {
    const loaded = await loadJudgeCalibrationState("locomo", dir);
    assert.equal(loaded, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadJudgeCalibrationState treats corrupt state as a miss (rule 34: never crash, never fabricate)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bench-calib-corrupt-"));
  try {
    await writeFile(path.join(dir, "locomo.json"), "not valid json {{{");
    const loaded = await loadJudgeCalibrationState("locomo", dir);
    assert.equal(loaded, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadJudgeCalibrationState rejects structurally-invalid state (missing fields)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bench-calib-invalid-"));
  try {
    await writeFile(path.join(dir, "locomo.json"), JSON.stringify({ kappa: 0.9 }));
    const loaded = await loadJudgeCalibrationState("locomo", dir);
    assert.equal(loaded, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeJudgeCalibrationState sanitizes the benchmark id in the filename (no path escape)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bench-calib-segment-"));
  try {
    const result = await runJudgeCalibration({
      benchmarkId: "locomo",
      localJudge: makeScalarStubJudge({}),
      frontierJudge: makeScalarStubJudge({}),
      answers: makeAnswers(2),
      sliceSize: 2,
    });
    const written = await writeJudgeCalibrationState(result, dir);
    // Filename is the sanitized benchmark id; no directory separators leaked.
    assert.equal(path.basename(written), "locomo.json");
    assert.equal(path.dirname(written), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Suppress the unused-stub warning for the metrics variant (kept for symmetry
// with the BenchJudge surface; the scalar path is what calibration uses).
void makeStubJudge;
