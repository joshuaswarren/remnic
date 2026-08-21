import assert from "node:assert/strict";
import test from "node:test";

import {
  runDeepRecall,
  type DeepRecallState,
} from "./recall-deep.js";
import { renderDeepRecallTrace } from "./recall-deep-render.js";

function seed(extra: Partial<DeepRecallState> = {}): DeepRecallState {
  return {
    query: "who met at the cafe",
    workingSet: [],
    frontier: ["m-b", "m-c"],
    budget: 2,
    ...extra,
  };
}

test("empty working set prints (empty)", () => {
  const result = runDeepRecall(seed({ budget: 0 }), () => {
    throw new Error("policy must not run when budget is 0");
  });
  assert.equal(
    renderDeepRecallTrace(result),
    [
      "# Deep recall",
      "",
      "- query: who met at the cafe",
      "- budget: 0",
      "- stop: budget exhausted",
      "",
      "## Steps",
      "",
      "1. stop budget=0 workingSet=(empty) frontier=m-b, m-c",
      "",
    ].join("\n"),
  );
});

test("expand then stop snapshot", () => {
  const result = runDeepRecall(seed({ workingSet: ["m-seed"], budget: 2 }), (state) =>
    state.workingSet.includes("m-b") ? "stop" : "expand",
  );
  assert.equal(
    renderDeepRecallTrace(result),
    [
      "# Deep recall",
      "",
      "- query: who met at the cafe",
      "- budget: 1",
      "- stop: stop",
      "",
      "## Steps",
      "",
      "1. expand budget=1 workingSet=m-seed, m-b frontier=m-c",
      "2. stop budget=1 workingSet=m-seed, m-b frontier=m-c",
      "",
    ].join("\n"),
  );
});

test("same result renders the same bytes", () => {
  const policy = () => "stop";
  const first = renderDeepRecallTrace(runDeepRecall(seed({ budget: 3 }), policy));
  const second = renderDeepRecallTrace(runDeepRecall(seed({ budget: 3 }), policy));
  assert.equal(first, second);
});
