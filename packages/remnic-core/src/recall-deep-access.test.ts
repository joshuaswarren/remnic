import assert from "node:assert/strict";
import test from "node:test";

import { runDeepRecallAccess } from "./recall-deep-access.js";

const QUERY = "who met at the cafe";

test("budget 0 stops immediately with a tagged refusal", () => {
  const result = runDeepRecallAccess({ query: QUERY, budget: 0, policyName: "expand-once" });
  assert.equal(result.ok, false);
  assert.deepEqual(result.refusal, { tag: "budget_exhausted" });
  assert.equal(result.trace.length, 1);
  assert.equal(result.trace[0]?.action, "stop");
  assert.equal(result.state.budget, 0);
  assert.equal(result.state.query, QUERY);
  assert.deepEqual(result.state.workingSet, []);
  assert.deepEqual(result.state.frontier, []);
  assert.equal(result.traceJson, JSON.stringify(result.trace));
});

test("unknown policyName is rejected", () => {
  assert.throws(
    () => runDeepRecallAccess({ query: QUERY, budget: 2, policyName: "refine-twice" }),
    /unknown deep recall access policy/,
  );
  assert.throws(
    () => runDeepRecallAccess({ query: QUERY, budget: 2, policyName: "refine-twice" }),
    /stop, expand-once/,
  );
});

test("stop policy ends without expanding", () => {
  const result = runDeepRecallAccess({ query: QUERY, budget: 3, policyName: "stop" });
  assert.equal(result.ok, true);
  assert.equal(result.refusal, undefined);
  assert.equal(result.trace.length, 1);
  assert.equal(result.trace[0]?.action, "stop");
  assert.equal(result.state.budget, 3);
  assert.deepEqual(result.state.workingSet, []);
});

test("expand-once expands once then stops", () => {
  const result = runDeepRecallAccess({ query: QUERY, budget: 3, policyName: "expand-once" });
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.trace.map((step) => step.action),
    ["expand", "stop"],
  );
  assert.equal(result.state.budget, 2);
});

test("same input produces the same trace JSON", () => {
  const input = { query: QUERY, budget: 4, policyName: "expand-once" as const };
  const first = runDeepRecallAccess(input);
  const second = runDeepRecallAccess(input);
  assert.equal(first.traceJson, second.traceJson);
  assert.equal(first.traceJson, JSON.stringify(first.trace));
});
