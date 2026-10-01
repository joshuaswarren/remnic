import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "./config.js";
import type { MemoryFile, QmdSearchResult } from "./types.js";
import {
  OUTCOME_STATE_OBSERVED,
  OUTCOME_STATE_UNOBSERVED,
  applyOutcomePriorScores,
  blendOutcomeScore,
  outcomePriorBoostActive,
  parseOutcomeBoostWeight,
  rerankWithOutcomePrior,
  resolveOutcomeObservation,
  scaleTextScore,
  type OutcomeObservationState,
} from "./rerank-outcome.js";

// @ts-expect-error "bogus" is not an OutcomeObservationState
const badOutcomeState: OutcomeObservationState = "bogus";
void badOutcomeState;

function memory(counters: { mw_success?: number; mw_fail?: number }): MemoryFile {
  return {
    path: "facts/a.md",
    content: "synthetic fact",
    frontmatter: counters as MemoryFile["frontmatter"],
  };
}

function result(path: string, score: number, namespace?: string): QmdSearchResult {
  return { docid: path, path, snippet: "", score, namespace } as QmdSearchResult;
}

test("scaleTextScore clamps into [0, 1] without a batch min-max", () => {
  assert.equal(scaleTextScore(0.4), 0.4);
  assert.equal(scaleTextScore(2.5), 1);
  assert.equal(scaleTextScore(-3), 0);
  assert.equal(scaleTextScore(Number.NaN), 0);
  assert.equal(scaleTextScore(Number.POSITIVE_INFINITY), 0);
});

test("UNOBSERVED is not the Memory Worth Beta prior", () => {
  const unobserved = resolveOutcomeObservation(undefined);
  assert.equal(unobserved.state, OUTCOME_STATE_UNOBSERVED);
  assert.equal(blendOutcomeScore(1, unobserved, 0.5), 1);
  assert.notEqual(blendOutcomeScore(1, unobserved, 0.5), 0.75);

  const zeros = resolveOutcomeObservation({ success: 0, fail: 0 });
  assert.equal(zeros.state, OUTCOME_STATE_UNOBSERVED);

  const missing = resolveOutcomeObservation({});
  assert.equal(missing.state, OUTCOME_STATE_UNOBSERVED);

  const invalid = resolveOutcomeObservation({ success: Number.NaN, fail: 1 });
  assert.equal(invalid.state, OUTCOME_STATE_UNOBSERVED);
  const negative = resolveOutcomeObservation({ success: -1, fail: 2 });
  assert.equal(negative.state, OUTCOME_STATE_UNOBSERVED);

  const observed = resolveOutcomeObservation({ success: 0, fail: 1 });
  assert.equal(observed.state, OUTCOME_STATE_OBSERVED);
  assert.equal(observed.outcomeScore, 0);
  assert.equal(blendOutcomeScore(1, observed, 0.5), 0.5);
  assert.notEqual(blendOutcomeScore(1, observed, 0.5), 2 / 3);

  const oneSided = resolveOutcomeObservation({ success: 2 });
  assert.equal(oneSided.state, OUTCOME_STATE_OBSERVED);
  assert.equal(oneSided.outcomeScore, 1);
});

test("pre-main unit gates cover ties, equal scores, and w=0 identity", () => {
  const unobserved = resolveOutcomeObservation(undefined);
  const observedZero = resolveOutcomeObservation({ success: 0, fail: 4 });
  assert.equal(unobserved.state, OUTCOME_STATE_UNOBSERVED);
  assert.equal(observedZero.state, OUTCOME_STATE_OBSERVED);
  assert.equal(blendOutcomeScore(1.7, unobserved, 0), 1.7);
  assert.equal(blendOutcomeScore(1.7, observedZero, 0), 1.7);
  assert.equal(blendOutcomeScore(1.7, observedZero, 0.5), scaleTextScore(1.7) * 0.5);

  const tied = rerankWithOutcomePrior(
    [
      { item: "left", textScore: 0.4, success: 3, fail: 1 },
      { item: "right", textScore: 0.4, success: 0, fail: 9 },
    ],
    0,
  );
  assert.deepEqual(
    tied.map((row) => [row.item, row.score, row.state]),
    [
      ["left", 0.4, OUTCOME_STATE_OBSERVED],
      ["right", 0.4, OUTCOME_STATE_OBSERVED],
    ],
  );

  const equalBlend = rerankWithOutcomePrior(
    [
      { item: "first", textScore: 0.2, success: 1, fail: 1 },
      { item: "second", textScore: 0.2, success: 1, fail: 1 },
    ],
    0.5,
  );
  assert.deepEqual(
    equalBlend.map((row) => row.item),
    ["first", "second"],
  );
  assert.equal(equalBlend[0]?.score, equalBlend[1]?.score);
});

test("weight 0 keeps raw scores and original order", () => {
  const ranked = rerankWithOutcomePrior(
    [
      { item: "a", textScore: 1.4, success: 0, fail: 5 },
      { item: "b", textScore: 0.2 },
      { item: "c", textScore: -1, success: 9, fail: 0 },
    ],
    0,
  );
  assert.deepEqual(
    ranked.map((row) => [row.item, row.score]),
    [
      ["a", 1.4],
      ["b", 0.2],
      ["c", -1],
    ],
  );
});

test("equal blended scores keep the original index order", () => {
  const ranked = rerankWithOutcomePrior(
    [
      { item: "first", textScore: 1 },
      { item: "second", textScore: 0, success: 1, fail: 0 },
    ],
    1,
  );
  assert.deepEqual(
    ranked.map((row) => row.item),
    ["first", "second"],
  );
  assert.equal(ranked[0]?.score, ranked[1]?.score);
});

test("observed outcomes reorder above a weaker text score", () => {
  const ranked = rerankWithOutcomePrior(
    [
      { item: "text", textScore: 0.9 },
      { item: "worked", textScore: 0.2, success: 4, fail: 0 },
    ],
    1,
  );
  assert.deepEqual(
    ranked.map((row) => row.item),
    ["worked", "text"],
  );
});

test("parseOutcomeBoostWeight rejects invalid values and keeps zero", () => {
  assert.equal(parseOutcomeBoostWeight(undefined), 0);
  assert.equal(parseOutcomeBoostWeight(""), 0);
  assert.equal(parseOutcomeBoostWeight("0"), 0);
  assert.equal(parseOutcomeBoostWeight("0.3"), 0.3);
  assert.throws(() => parseOutcomeBoostWeight(false), /outcomeBoostWeight/);
  assert.throws(() => parseOutcomeBoostWeight("false"), /outcomeBoostWeight/);
  assert.throws(() => parseOutcomeBoostWeight("1.5"), /outcomeBoostWeight/);
  assert.throws(() => parseOutcomeBoostWeight(Number.NaN), /outcomeBoostWeight/);
  assert.throws(() => rerankWithOutcomePrior([{ item: "a", textScore: 1 }], 1.2), /outcomeBoostWeight/);
});

test("parseConfig leaves the outcome boost off", () => {
  const defaults = parseConfig({});
  assert.equal(defaults.outcomeBoostEnabled, false);
  assert.equal(defaults.outcomeBoostWeight, 0);
  assert.equal(outcomePriorBoostActive(defaults), false);
  assert.equal(parseConfig({ outcomeBoostEnabled: "false" }).outcomeBoostEnabled, false);
  assert.equal(parseConfig({ outcomeBoostEnabled: "0" }).outcomeBoostEnabled, false);
  assert.equal(parseConfig({ outcomeBoostWeight: "0" }).outcomeBoostWeight, 0);
  assert.equal(outcomePriorBoostActive(parseConfig({ outcomeBoostEnabled: true, outcomeBoostWeight: 0 })), false);
  assert.equal(outcomePriorBoostActive(parseConfig({ outcomeBoostEnabled: false, outcomeBoostWeight: 0.3 })), false);
  assert.equal(outcomePriorBoostActive(parseConfig({ outcomeBoostEnabled: true, outcomeBoostWeight: 0.3 })), true);
  assert.throws(() => parseConfig({ outcomeBoostWeight: "no" }), /outcomeBoostWeight/);
});

test("applyOutcomePriorScores is an identity at weight 0 and uses the namespace key", () => {
  const untouched = [result("facts/a.md", 1.4, "ns-a"), result("facts/a.md", 0.2)];
  const before = untouched.map((row) => ({ path: row.path, score: row.score, namespace: row.namespace }));
  applyOutcomePriorScores(untouched, new Map(), { outcomeBoostWeight: 0 });
  assert.deepEqual(
    untouched.map((row) => ({ path: row.path, score: row.score, namespace: row.namespace })),
    before,
  );
  const negative = [result("facts/a.md", 1.4)];
  applyOutcomePriorScores(negative, new Map(), { outcomeBoostWeight: -1 });
  assert.equal(negative[0]?.score, 1.4);
  assert.throws(
    () => applyOutcomePriorScores([result("facts/a.md", 1)], new Map(), { outcomeBoostWeight: 1.2 }),
    /outcomeBoostWeight/,
  );

  const namespaced = resolveOutcomeObservation({ success: 0, fail: 1 });
  assert.equal(namespaced.state, OUTCOME_STATE_OBSERVED);
  assert.equal(namespaced.outcomeScore, 0);
  const bare = resolveOutcomeObservation({ success: 8, fail: 0 });
  assert.equal(bare.state, OUTCOME_STATE_OBSERVED);
  assert.equal(bare.outcomeScore, 1);

  const results = [result("facts/a.md", 1, "ns-a"), result("facts/a.md", 0.2)];
  const memoryByPath = new Map<string, MemoryFile>([
    ["ns-a\0facts/a.md", memory({ mw_success: 0, mw_fail: 1 })],
    ["facts/a.md", memory({ mw_success: 8, mw_fail: 0 })],
  ]);
  applyOutcomePriorScores(results, memoryByPath, { outcomeBoostWeight: 1 });
  // 0/1 is an observed rate of 0, not UNOBSERVED. The namespaced key must not
  // read the bare-path 8/0 counters. At weight 1 the bare path (rate 1) sorts
  // ahead of ns-a (rate 0).
  assert.equal(results[0]?.namespace, undefined);
  assert.equal(results[0]?.score, 1);
  assert.equal(results[1]?.namespace, "ns-a");
  assert.equal(results[1]?.score, 0);
});
