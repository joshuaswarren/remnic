import assert from "node:assert/strict";
import test from "node:test";

import {
  annotateStateView,
  formatSupersededPrefix,
  isChangeOrientedQuery,
  parseRecallStateViews,
  shouldWidenSuperseded,
  type StateViewChain,
  type StateViewResult,
} from "./recall-state-view.js";

function fact(id: string, extra: Partial<StateViewResult> = {}): StateViewResult {
  return { id, ...extra };
}

const PAIR: StateViewChain[] = [{ predecessorId: "old-job", successorId: "new-job", supersededAt: "2026-03-01" }];

const PAIR_RESULTS: StateViewResult[] = [
  fact("new-job", { status: "active" }),
  fact("old-job", { status: "superseded", supersededBy: "new-job", supersededAt: "2026-03-01" }),
];

test("change-intent query labels both facts in a superseded pair", () => {
  const labeled = annotateStateView(PAIR_RESULTS, "when did the job title change", PAIR, { enabled: true });
  assert.equal(labeled.length, 2);
  assert.equal(labeled[0]?.id, "new-job");
  assert.equal(labeled[0]?.stateLabel, "current");
  assert.equal(labeled[1]?.id, "old-job");
  assert.equal(labeled[1]?.stateLabel, "historical");
});

test("change-intent conjugations fire the annotator", () => {
  const phrases = [
    "when did we switch",
    "we used to",
    "before the move",
    "after the cutover",
    "they switched vendors",
    "she switches stacks",
    "switching away from it",
    "the title changed",
    "it changes next week",
    "they are changing providers",
  ];
  for (const query of phrases) {
    assert.equal(isChangeOrientedQuery(query), true, query);
    const labeled = annotateStateView(PAIR_RESULTS, query, PAIR, { enabled: true });
    assert.equal(labeled[0]?.stateLabel, "current", query);
    assert.equal(labeled[1]?.stateLabel, "historical", query);
  }
});

test("non-change query is identical (same array reference, no labels)", () => {
  const input = PAIR_RESULTS.map((row) => ({ ...row }));
  const out = annotateStateView(input, "what is the current job title", PAIR, { enabled: true });
  assert.equal(out, input);
  assert.equal(out[0]?.stateLabel, undefined);
  assert.equal(out[1]?.stateLabel, undefined);
});

test("recallStateViews false is identity (same array reference)", () => {
  const input = PAIR_RESULTS.map((row) => ({ ...row }));
  assert.equal(annotateStateView(input, "when did the job title change", PAIR), input);
  assert.equal(annotateStateView(input, "when did the job title change", PAIR, { enabled: false }), input);
  assert.equal(input[0]?.stateLabel, undefined);
});

test("superseded never appears without its successor", () => {
  const orphan = [fact("old-job", { status: "superseded", supersededBy: "new-job" })];
  const out = annotateStateView(orphan, "when did this change", PAIR, { enabled: true });
  assert.deepEqual(out, []);
  assert.equal(shouldWidenSuperseded("new-job", new Set(["old-job"])), false);
  assert.equal(shouldWidenSuperseded("new-job", new Set(["old-job", "new-job"])), true);
  assert.equal(shouldWidenSuperseded(undefined, new Set(["new-job"])), false);
});

test("annotateStateView is sort-stable", () => {
  const reversed = [PAIR_RESULTS[1]!, PAIR_RESULTS[0]!];
  const labeled = annotateStateView(reversed, "when did the title change", PAIR, { enabled: true });
  assert.deepEqual(
    labeled.map((row) => row.id),
    ["old-job", "new-job"],
  );
  assert.equal(labeled[0]?.stateLabel, "historical");
  assert.equal(labeled[1]?.stateLabel, "current");
});

test("middle hop of a three-node chain is transition", () => {
  const chains: StateViewChain[] = [
    { predecessorId: "v1", successorId: "v2" },
    { predecessorId: "v2", successorId: "v3" },
  ];
  const results = [
    fact("v1", { status: "superseded", supersededBy: "v2" }),
    fact("v2", { status: "superseded", supersededBy: "v3" }),
    fact("v3", { status: "active" }),
  ];
  const labeled = annotateStateView(results, "what changed", chains, { enabled: true });
  assert.deepEqual(
    labeled.map((row) => [row.id, row.stateLabel]),
    [
      ["v1", "historical"],
      ["v2", "transition"],
      ["v3", "current"],
    ],
  );
});

test("formatSupersededPrefix matches the injected-block contract", () => {
  assert.equal(formatSupersededPrefix("2026-03-01", "new-job"), "[superseded 2026-03-01 by new-job]");
});

test("parseRecallStateViews honors 0/false and defaults off", () => {
  assert.equal(parseRecallStateViews(undefined), false);
  assert.equal(parseRecallStateViews(false), false);
  assert.equal(parseRecallStateViews(0), false);
  assert.equal(parseRecallStateViews("false"), false);
  assert.equal(parseRecallStateViews("0"), false);
  assert.equal(parseRecallStateViews(true), true);
  assert.equal(parseRecallStateViews(1), true);
  assert.equal(parseRecallStateViews("true"), true);
});

test("annotateStateView does not mutate input rows", () => {
  const input = PAIR_RESULTS.map((row) => ({ ...row }));
  annotateStateView(input, "when did this change", PAIR, { enabled: true });
  assert.equal(input[0]?.stateLabel, undefined);
  assert.equal(input[1]?.stateLabel, undefined);
});
