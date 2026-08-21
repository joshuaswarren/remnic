import assert from "node:assert/strict";
import test from "node:test";

import {
  runDeepRecall,
  runDeepRecallStep,
  type DeepRecallState,
} from "./recall-deep.js";

function seed(extra: Partial<DeepRecallState> = {}): DeepRecallState {
  return {
    query: "who met at the cafe",
    workingSet: ["m-seed"],
    frontier: ["m-b", "m-c"],
    budget: 2,
    ...extra,
  };
}

test("budget 0 stops without calling the policy", () => {
  const result = runDeepRecall(seed({ budget: 0 }), () => {
    throw new Error("policy must not run when budget is 0");
  });
  assert.equal(result.trace.length, 1);
  assert.equal(result.trace[0]?.action, "stop");
  assert.equal(result.state.budget, 0);
  assert.deepEqual(result.state.workingSet, ["m-seed"]);
  assert.deepEqual(result.state.frontier, ["m-b", "m-c"]);
});

test("expand consumes budget and pulls the next frontier item", () => {
  const result = runDeepRecallStep(seed({ budget: 2 }), "expand");
  assert.equal(result.step.action, "expand");
  assert.equal(result.state.budget, 1);
  assert.deepEqual(result.state.workingSet, ["m-seed", "m-b"]);
  assert.deepEqual(result.state.frontier, ["m-c"]);
});

test("stop ends while budget remains", () => {
  let calls = 0;
  const result = runDeepRecall(seed({ budget: 4 }), () => {
    calls += 1;
    return "stop";
  });
  assert.equal(calls, 1);
  assert.equal(result.trace.length, 1);
  assert.equal(result.trace[0]?.action, "stop");
  assert.equal(result.state.budget, 4);
  assert.deepEqual(result.state.workingSet, ["m-seed"]);
});

test("unknown action throws", () => {
  assert.throws(() => runDeepRecallStep(seed(), "rewrite"), /unknown deep recall action/);
  assert.throws(
    () => runDeepRecall(seed(), () => "rewrite"),
    /unknown deep recall action/,
  );
});

test("same state and policy produce the same trace", () => {
  const policy = (state: DeepRecallState) => (state.budget > 1 ? "expand" : "refine");
  const start = seed({ budget: 3, frontier: ["m-z", "m-a"] });
  const first = runDeepRecall(start, policy);
  const second = runDeepRecall(start, policy);
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.trace.map((step) => step.action),
    ["expand", "expand", "refine", "stop"],
  );
  assert.equal(start.budget, 3);
  assert.deepEqual(start.frontier, ["m-z", "m-a"]);
});
