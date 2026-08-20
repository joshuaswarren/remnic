import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  evaluateSpanPhaseGate,
  SPAN_GATE_MAX_FALLBACK_RATE_PCT,
  SPAN_GATE_MAX_JUDGE_DROP_POINTS,
  SPAN_GATE_MIN_WALLCLOCK_REDUCTION_PCT,
} from "./extraction-span-gate.js";

function assertRangeError(fn: () => unknown, field: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof RangeError, `expected RangeError, got ${String(err)}`);
    assert.match((err as RangeError).message, new RegExp(field));
    return true;
  });
}

describe("evaluateSpanPhaseGate", () => {
  it("passes the Phase A bench numbers from the issue", () => {
    const verdict = evaluateSpanPhaseGate({
      wallClockReductionPct: 45,
      judgeScoreDropPoints: 0.3,
      fallbackRatePct: 4,
    });
    assert.deepEqual(verdict, {
      pass: true,
      conditions: { wallClockReduction: true, judgeQuality: true, fallbackRate: true },
      failed: [],
    });
  });

  it("treats the wall-clock boundary 20.0 as a pass (>= 20)", () => {
    const verdict = evaluateSpanPhaseGate({
      wallClockReductionPct: SPAN_GATE_MIN_WALLCLOCK_REDUCTION_PCT,
      judgeScoreDropPoints: 0,
      fallbackRatePct: 0,
    });
    assert.equal(verdict.conditions.wallClockReduction, true);
  });

  it("treats a judge drop of exactly 2.0 as a failure (< 2)", () => {
    const verdict = evaluateSpanPhaseGate({
      wallClockReductionPct: 45,
      judgeScoreDropPoints: SPAN_GATE_MAX_JUDGE_DROP_POINTS,
      fallbackRatePct: 4,
    });
    assert.equal(verdict.pass, false);
    assert.deepEqual(verdict.failed, ["judgeQuality"]);
  });

  it("treats a fallback rate of exactly 15.0 as a failure (< 15)", () => {
    const verdict = evaluateSpanPhaseGate({
      wallClockReductionPct: 45,
      judgeScoreDropPoints: 0.3,
      fallbackRatePct: SPAN_GATE_MAX_FALLBACK_RATE_PCT,
    });
    assert.equal(verdict.pass, false);
    assert.deepEqual(verdict.failed, ["fallbackRate"]);
  });

  it("fails on wall-clock reduction alone", () => {
    const verdict = evaluateSpanPhaseGate({
      wallClockReductionPct: 19.9,
      judgeScoreDropPoints: 0.3,
      fallbackRatePct: 4,
    });
    assert.equal(verdict.pass, false);
    assert.deepEqual(verdict.failed, ["wallClockReduction"]);
  });

  it("fails on judge quality alone", () => {
    const verdict = evaluateSpanPhaseGate({
      wallClockReductionPct: 45,
      judgeScoreDropPoints: 2.5,
      fallbackRatePct: 4,
    });
    assert.equal(verdict.pass, false);
    assert.deepEqual(verdict.failed, ["judgeQuality"]);
  });

  it("fails on fallback rate alone", () => {
    const verdict = evaluateSpanPhaseGate({
      wallClockReductionPct: 45,
      judgeScoreDropPoints: 0.3,
      fallbackRatePct: 15.1,
    });
    assert.equal(verdict.pass, false);
    assert.deepEqual(verdict.failed, ["fallbackRate"]);
  });

  it("lists all three failures in declaration order", () => {
    const verdict = evaluateSpanPhaseGate({
      wallClockReductionPct: 10,
      judgeScoreDropPoints: 3,
      fallbackRatePct: 20,
    });
    assert.equal(verdict.pass, false);
    assert.deepEqual(verdict.conditions, {
      wallClockReduction: false,
      judgeQuality: false,
      fallbackRate: false,
    });
    assert.deepEqual(verdict.failed, ["wallClockReduction", "judgeQuality", "fallbackRate"]);
  });

  it("fails a negative wall-clock reduction without throwing", () => {
    const verdict = evaluateSpanPhaseGate({
      wallClockReductionPct: -5,
      judgeScoreDropPoints: 0.3,
      fallbackRatePct: 4,
    });
    assert.equal(verdict.pass, false);
    assert.deepEqual(verdict.failed, ["wallClockReduction"]);
  });

  it("passes a negative judge drop (quality improved)", () => {
    const verdict = evaluateSpanPhaseGate({
      wallClockReductionPct: 45,
      judgeScoreDropPoints: -0.5,
      fallbackRatePct: 4,
    });
    assert.equal(verdict.conditions.judgeQuality, true);
    assert.equal(verdict.pass, true);
  });

  it("throws RangeError naming the field on non-finite wall-clock reduction", () => {
    assertRangeError(
      () =>
        evaluateSpanPhaseGate({
          wallClockReductionPct: Number.NaN,
          judgeScoreDropPoints: 0.3,
          fallbackRatePct: 4,
        }),
      "wallClockReductionPct",
    );
  });

  it("throws RangeError naming the field on non-finite judge drop", () => {
    assertRangeError(
      () =>
        evaluateSpanPhaseGate({
          wallClockReductionPct: 45,
          judgeScoreDropPoints: Number.POSITIVE_INFINITY,
          fallbackRatePct: 4,
        }),
      "judgeScoreDropPoints",
    );
  });

  it("throws RangeError naming the field on non-finite fallback rate", () => {
    assertRangeError(
      () =>
        evaluateSpanPhaseGate({
          wallClockReductionPct: 45,
          judgeScoreDropPoints: 0.3,
          fallbackRatePct: Number.NEGATIVE_INFINITY,
        }),
      "fallbackRatePct",
    );
  });

  it("throws RangeError on a fallback rate of 101", () => {
    assertRangeError(
      () =>
        evaluateSpanPhaseGate({
          wallClockReductionPct: 45,
          judgeScoreDropPoints: 0.3,
          fallbackRatePct: 101,
        }),
      "fallbackRatePct",
    );
  });

  it("throws RangeError on a fallback rate of -1", () => {
    assertRangeError(
      () =>
        evaluateSpanPhaseGate({
          wallClockReductionPct: 45,
          judgeScoreDropPoints: 0.3,
          fallbackRatePct: -1,
        }),
      "fallbackRatePct",
    );
  });

  it("accepts the fallback-rate endpoints 0 and 100 as measurements", () => {
    assert.doesNotThrow(() =>
      evaluateSpanPhaseGate({
        wallClockReductionPct: 45,
        judgeScoreDropPoints: 0.3,
        fallbackRatePct: 0,
      }),
    );
    const verdict = evaluateSpanPhaseGate({
      wallClockReductionPct: 45,
      judgeScoreDropPoints: 0.3,
      fallbackRatePct: 100,
    });
    assert.deepEqual(verdict.failed, ["fallbackRate"]);
  });
});
