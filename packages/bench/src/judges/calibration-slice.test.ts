import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import path from "node:path";

import type { BenchJudge, BenchPhaseControl } from "../adapters/types.ts";
import {
  CALIBRATION_SLICE_SIZE,
  JUDGE_CALIBRATION_KAPPA_THRESHOLD,
  MIN_CALIBRATION_SOURCE_TASKS,
  loadJudgeCalibrationState,
  hashOrderedQuestionIds,
  runJudgeCalibration,
  selectCalibrationSlice,
  writeJudgeCalibrationState,
  type CalibrationAnswer,
} from "./calibration-slice.ts";

function checkpointProvenance(dir: string, answers: readonly CalibrationAnswer[]) {
  return {
    dir,
    sourceResultId: "source-run-1",
    sourceResultSha256: "a".repeat(64),
    orderedQuestionIdsHash: hashOrderedQuestionIds(answers.map((answer) => answer.questionId)),
    localJudgePromptIdentity: "sha256:" + "1".repeat(64),
    frontierJudgePromptIdentity: "sha256:" + "2".repeat(64),
    localJudgeConfigHash: "c".repeat(64),
    frontierJudgeConfigHash: "d".repeat(64),
  };
}

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

test("hashOrderedQuestionIds is deterministic and order-sensitive", () => {
  assert.equal(hashOrderedQuestionIds(["a", "b"]), hashOrderedQuestionIds(["a", "b"]));
  assert.notEqual(hashOrderedQuestionIds(["a", "b"]), hashOrderedQuestionIds(["b", "a"]));
});

test("runJudgeCalibration checkpoints each judge side and resumes only missing calls", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bench-calib-resume-"));
  try {
    const answers = makeAnswers(3);
    let localCalls = 0;
    let frontierCalls = 0;
    const local: BenchJudge = { async score() { localCalls += 1; return 1; } };
    const interruptedFrontier: BenchJudge = { async score() { frontierCalls += 1; throw new Error("interrupted"); } };
    await assert.rejects(() => runJudgeCalibration({
      benchmarkId: "locomo", localJudge: local, frontierJudge: interruptedFrontier,
      answers, sliceSize: 3, checkpoint: checkpointProvenance(dir, answers),
    }), /interrupted/);
    assert.equal(localCalls, 1);
    assert.equal(frontierCalls, 1);

    const resumed = await runJudgeCalibration({
      benchmarkId: "locomo", localJudge: local,
      frontierJudge: { async score() { frontierCalls += 1; return 1; } },
      answers, sliceSize: 3, checkpoint: checkpointProvenance(dir, answers), bootstrapSamples: 20,
    });
    assert.equal(resumed.execution.localJudgeCalls, 2);
    assert.equal(resumed.execution.frontierJudgeCalls, 3);
    assert.equal(resumed.execution.resumedJudgeOutputs, 1);
    assert.equal(localCalls, 3, "the completed local side is not repaid");
    assert.equal(frontierCalls, 4);
    assert.equal((await stat(path.join(dir, "locomo.checkpoint.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("runJudgeCalibration fails closed on corrupt or mismatched checkpoint before calls", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bench-calib-closed-"));
  try {
    const answers = makeAnswers(2);
    await runJudgeCalibration({
      benchmarkId: "locomo", localJudge: makeScalarStubJudge({ q0: 1, q1: 1 }),
      frontierJudge: makeScalarStubJudge({ q0: 1, q1: 1 }), answers, sliceSize: 2,
      checkpoint: checkpointProvenance(dir, answers), bootstrapSamples: 20,
    });
    let calls = 0;
    const counting: BenchJudge = { async score() { calls += 1; return 1; } };
    await assert.rejects(() => runJudgeCalibration({
      benchmarkId: "locomo", localJudge: counting, frontierJudge: counting, answers, sliceSize: 2,
      checkpoint: { ...checkpointProvenance(dir, answers), frontierJudgeConfigHash: "e".repeat(64) },
    }), /contract mismatch/);
    assert.equal(calls, 0);
    await writeFile(path.join(dir, "locomo.checkpoint.json"), "not-json", "utf8");
    await assert.rejects(() => runJudgeCalibration({
      benchmarkId: "locomo", localJudge: counting, frontierJudge: counting, answers, sliceSize: 2,
      checkpoint: checkpointProvenance(dir, answers),
    }), /corrupt checkpoint/);
    assert.equal(calls, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("runJudgeCalibration holds an exclusive checkpoint lock across judge-call reservation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bench-calib-lock-"));
  try {
    const answers = makeAnswers(2);
    let enteredFirstCall!: () => void;
    let releaseFirstCall!: () => void;
    const entered = new Promise<void>((resolve) => { enteredFirstCall = resolve; });
    const release = new Promise<void>((resolve) => { releaseFirstCall = resolve; });
    let firstCalls = 0;
    const blockingJudge: BenchJudge = {
      async score() {
        firstCalls += 1;
        if (firstCalls === 1) {
          enteredFirstCall();
          await release;
        }
        return 1;
      },
    };
    const first = runJudgeCalibration({
      benchmarkId: "locomo",
      localJudge: blockingJudge,
      frontierJudge: blockingJudge,
      answers,
      sliceSize: 2,
      checkpoint: checkpointProvenance(dir, answers),
      bootstrapSamples: 20,
    });
    await entered;
    let secondCalls = 0;
    const secondJudge: BenchJudge = { async score() { secondCalls += 1; return 1; } };
    await assert.rejects(() => runJudgeCalibration({
      benchmarkId: "locomo",
      localJudge: secondJudge,
      frontierJudge: secondJudge,
      answers,
      sliceSize: 2,
      checkpoint: checkpointProvenance(dir, answers),
    }), /checkpoint is locked/);
    assert.equal(secondCalls, 0, "a concurrent process must never reserve a paid call");
    releaseFirstCall();
    await first;
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("runJudgeCalibration invalidates resume when prompt or binning identity changes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bench-calib-identities-"));
  try {
    const answers = makeAnswers(2);
    const base = checkpointProvenance(dir, answers);
    await runJudgeCalibration({
      benchmarkId: "locomo",
      localJudge: makeScalarStubJudge({ q0: 1, q1: 1 }),
      frontierJudge: makeScalarStubJudge({ q0: 1, q1: 1 }),
      answers,
      sliceSize: 2,
      checkpoint: base,
      bootstrapSamples: 20,
    });
    let calls = 0;
    const judge: BenchJudge = { async score() { calls += 1; return 1; } };
    await assert.rejects(() => runJudgeCalibration({
      benchmarkId: "locomo",
      localJudge: judge,
      frontierJudge: judge,
      answers,
      sliceSize: 2,
      checkpoint: { ...base, localJudgePromptIdentity: "sha256:" + "9".repeat(64) },
    }), /contract mismatch/);
    await assert.rejects(() => runJudgeCalibration({
      benchmarkId: "locomo",
      localJudge: judge,
      frontierJudge: judge,
      answers,
      sliceSize: 2,
      checkpoint: base,
      binningIdentity: "three-way-binning-v2",
    }), /contract mismatch/);
    assert.equal(calls, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("selectCalibrationSlice: default size is 200 (#1877)", () => {
  const ids = Array.from({ length: 250 }, (_, index) => `question-${index}`);
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
  assert.deepEqual(result.confidenceInterval, { lower: 1, upper: 1, level: 0.95 });
  assert.equal(result.bootstrapSamples, 2_000);
  assert.match(result.answerSetHash, /^[0-9a-f]{64}$/);
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

test("runJudgeCalibration hashes the exact answer payload, not only question ids", async () => {
  const answers = makeAnswers(10);
  const scores = Object.fromEntries(answers.map((answer) => [answer.predicted, 1]));
  const first = await runJudgeCalibration({
    benchmarkId: "locomo",
    localJudge: makeScalarStubJudge(scores),
    frontierJudge: makeScalarStubJudge(scores),
    answers,
    sliceSize: 10,
    bootstrapSamples: 50,
  });
  const changed = answers.map((answer, index) => index === 0
    ? { ...answer, expected: `${answer.expected}-changed` }
    : answer);
  const second = await runJudgeCalibration({
    benchmarkId: "locomo",
    localJudge: makeScalarStubJudge(scores),
    frontierJudge: makeScalarStubJudge(scores),
    answers: changed,
    sliceSize: 10,
    bootstrapSamples: 50,
  });
  assert.deepEqual(first.sliceQuestionIds, second.sliceQuestionIds);
  assert.notEqual(first.answerSetHash, second.answerSetHash);
});

test("runJudgeCalibration rejects changed pinned answers before either judge is called", async () => {
  const answers = makeAnswers(10);
  const scores = Object.fromEntries(answers.map((answer) => [answer.predicted, 1]));
  const baseline = await runJudgeCalibration({
    benchmarkId: "locomo",
    localJudge: makeScalarStubJudge(scores),
    frontierJudge: makeScalarStubJudge(scores),
    answers,
    sliceSize: 10,
    bootstrapSamples: 50,
  });
  let calls = 0;
  const countingJudge: BenchJudge = {
    async score(): Promise<number> {
      calls += 1;
      return 1;
    },
  };
  const changed = answers.map((answer, index) => index === 0
    ? { ...answer, predicted: `${answer.predicted}-changed` }
    : answer);
  await assert.rejects(
    () => runJudgeCalibration({
      benchmarkId: "locomo",
      localJudge: countingJudge,
      frontierJudge: countingJudge,
      answers: changed,
      pinnedQuestionIds: baseline.sliceQuestionIds,
      expectedAnswerSetHash: baseline.answerSetHash,
      bootstrapSamples: 50,
    }),
    /pinned answer set changed/,
  );
  assert.equal(calls, 0, "answer drift must fail before spending local or frontier judge calls");
});

test("runJudgeCalibration rejects changed ordered question ids before either judge is called", async () => {
  const answers = makeAnswers(10);
  let calls = 0;
  const countingJudge: BenchJudge = { async score() { calls += 1; return 1; } };
  await assert.rejects(() => runJudgeCalibration({
    benchmarkId: "locomo",
    localJudge: countingJudge,
    frontierJudge: countingJudge,
    answers: [...answers].reverse(),
    expectedOrderedQuestionIdsHash: hashOrderedQuestionIds(answers.map((answer) => answer.questionId)),
  }), /ordered question-id list changed/);
  assert.equal(calls, 0);
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

test("runJudgeCalibration: duplicate questionIds are deduped — first answer wins (cursor review)", async () => {
  // A stored result with duplicate taskIds must not double-count a question.
  // Build 4 distinct answers, then append duplicates of two of them; the
  // slice covers all 4 ids, so without dedup sampleSize would be 6.
  const base = makeAnswers(4);
  const answers = [
    ...base,
    { ...base[0]! },
    { ...base[2]! },
  ];
  const scores: Record<string, number> = {};
  for (const answer of base) {
    scores[answer.predicted] = 1;
  }
  const result = await runJudgeCalibration({
    benchmarkId: "locomo",
    localJudge: makeScalarStubJudge(scores),
    frontierJudge: makeScalarStubJudge(scores),
    answers,
    sliceSize: 10,
  });
  assert.equal(result.sampleSize, 4, "duplicates must not inflate sampleSize");
  assert.equal(result.sliceQuestionIds.length, 4);
  assert.equal(result.verdicts.length, 4);
  assert.equal(result.kappa, 1);
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
test("writeJudgeCalibrationState + loadJudgeCalibrationState round-trip judge identities (codex P2 review)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bench-calib-identities-"));
  try {
    const result = await runJudgeCalibration({
      benchmarkId: "locomo",
      localJudge: makeScalarStubJudge(Object.fromEntries(makeAnswers(6).map((a) => [a.predicted, 1]))),
      frontierJudge: makeScalarStubJudge(Object.fromEntries(makeAnswers(6).map((a) => [a.predicted, 1]))),
      answers: makeAnswers(6),
      sliceSize: 6,
    });
    const identities = {
      localJudgeProvider: "local-llm",
      localJudgeModel: "llama3:70b",
      frontierJudgeProvider: "openai",
      frontierJudgeModel: "gpt-4o",
    };
    await writeJudgeCalibrationState(result, dir, identities);

    const loaded = await loadJudgeCalibrationState("locomo", dir);
    assert.notEqual(loaded, undefined);
    // The artifact subset still round-trips.
    assert.equal(loaded?.kappa, result.kappa);
    assert.equal(loaded?.warning, result.warning);
    // The judge identities that produced the kappa travel with the state.
    assert.equal(loaded?.localJudgeProvider, "local-llm");
    assert.equal(loaded?.localJudgeModel, "llama3:70b");
    assert.equal(loaded?.frontierJudgeProvider, "openai");
    assert.equal(loaded?.frontierJudgeModel, "gpt-4o");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeJudgeCalibrationState pins source, task order, slice, answer hash, and bootstrap interval (#1877)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bench-calib-pinned-"));
  try {
    const answers = makeAnswers(12);
    const scores = Object.fromEntries(answers.map((answer) => [answer.predicted, 1]));
    const result = await runJudgeCalibration({
      benchmarkId: "locomo",
      localJudge: makeScalarStubJudge(scores),
      frontierJudge: makeScalarStubJudge(scores),
      answers,
      sliceSize: 12,
      bootstrapSamples: 100,
    });
    await writeJudgeCalibrationState(result, dir, undefined, {
      sourceResultId: "run-pinned-123",
      orderedQuestionIdsHash: hashOrderedQuestionIds(answers.map((answer) => answer.questionId)),
      localJudgeConfigHash: "a".repeat(64),
      frontierJudgeConfigHash: "b".repeat(64),
    });
    const loaded = await loadJudgeCalibrationState("locomo", dir);
    assert.equal(loaded?.sourceResultId, "run-pinned-123");
    assert.equal(loaded?.answerSetHash, result.answerSetHash);
    assert.equal(
      loaded?.orderedQuestionIdsHash,
      hashOrderedQuestionIds(answers.map((answer) => answer.questionId)),
    );
    assert.deepEqual(loaded?.sliceQuestionIds, result.sliceQuestionIds);
    assert.deepEqual(loaded?.confidenceInterval, result.confidenceInterval);
    assert.equal(loaded?.bootstrapSamples, 100);
    assert.equal(loaded?.localJudgeConfigHash, "a".repeat(64));
    assert.equal(loaded?.frontierJudgeConfigHash, "b".repeat(64));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeJudgeCalibrationState without identities still loads (backwards compatible, unbound)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bench-calib-noid-"));
  try {
    const result = await runJudgeCalibration({
      benchmarkId: "locomo",
      localJudge: makeScalarStubJudge({}),
      frontierJudge: makeScalarStubJudge({}),
      answers: makeAnswers(2),
      sliceSize: 2,
    });
    // No identities argument — mirrors pre-binding state files.
    await writeJudgeCalibrationState(result, dir);

    const loaded = await loadJudgeCalibrationState("locomo", dir);
    assert.notEqual(loaded, undefined);
    assert.equal(loaded?.kappa, result.kappa);
    // Absent identities: the attach path treats this as unbound (attach anyway).
    assert.equal(loaded?.localJudgeModel, undefined);
    assert.equal(loaded?.frontierJudgeModel, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadJudgeCalibrationState drops partial/corrupt identities but keeps the calibration subset", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bench-calib-partial-id-"));
  try {
    // Some identity fields present but not all four (unreliable binding).
    await writeFile(
      path.join(dir, "locomo.json"),
      JSON.stringify({
        kappa: 0.82,
        sampleSize: 50,
        threshold: 0.7,
        warning: false,
        localJudgeProvider: "local-llm",
        // localJudgeModel missing → identities dropped, calibration kept.
      }),
    );
    const loaded = await loadJudgeCalibrationState("locomo", dir);
    assert.notEqual(loaded, undefined);
    assert.equal(loaded?.kappa, 0.82);
    assert.equal(loaded?.localJudgeProvider, undefined);
    assert.equal(loaded?.localJudgeModel, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test("sanitizeCalibrationSegment: distinct benchmark ids produce distinct filenames (cursor review)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bench-calib-sanitize-"));
  try {
    // "foo.bar" and "foobar" must NOT collide — the old filter-drop mapped
    // both to "foobar.json", letting one benchmark overwrite another's kappa.
    // With the fix, punctuation becomes a separator: "foo-bar" vs "foobar".
    const resultA = await runJudgeCalibration({
      benchmarkId: "foo.bar",
      localJudge: makeScalarStubJudge({}),
      frontierJudge: makeScalarStubJudge({}),
      answers: makeAnswers(2),
      sliceSize: 2,
    });
    const resultB = await runJudgeCalibration({
      benchmarkId: "foobar",
      localJudge: makeScalarStubJudge({}),
      frontierJudge: makeScalarStubJudge({}),
      answers: makeAnswers(2),
      sliceSize: 2,
    });
    const pathA = await writeJudgeCalibrationState(resultA, dir);
    const pathB = await writeJudgeCalibrationState(resultB, dir);
    assert.notEqual(path.basename(pathA), path.basename(pathB));
    assert.equal(path.basename(pathA), "foo-bar.json");
    assert.equal(path.basename(pathB), "foobar.json");
    // Both load independently — no cross-contamination.
    const loadedA = await loadJudgeCalibrationState("foo.bar", dir);
    const loadedB = await loadJudgeCalibrationState("foobar", dir);
    assert.notEqual(loadedA, undefined);
    assert.notEqual(loadedB, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("MIN_CALIBRATION_SOURCE_TASKS is exported and positive", () => {
  assert.ok(MIN_CALIBRATION_SOURCE_TASKS >= 2);
});

// Suppress the unused-stub warning for the metrics variant (kept for symmetry
// with the BenchJudge surface; the scalar path is what calibration uses).
void makeStubJudge;
