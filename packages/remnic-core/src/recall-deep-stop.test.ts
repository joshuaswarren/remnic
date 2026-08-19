import assert from "node:assert/strict";
import test from "node:test";

import { shouldStopDeepRecall } from "./recall-deep-stop.js";

test("budgetLeft 0 stops", () => {
  assert.equal(shouldStopDeepRecall({ budgetLeft: 0, policy: "expand-once" }), true);
});

test("stop policy stops", () => {
  assert.equal(shouldStopDeepRecall({ budgetLeft: 3, policy: "stop" }), true);
});

test("expand-once stops only after one expansion", () => {
  assert.equal(
    shouldStopDeepRecall({ budgetLeft: 3, policy: "expand-once", alreadyExpanded: false }),
    false,
  );
  assert.equal(
    shouldStopDeepRecall({ budgetLeft: 3, policy: "expand-once", alreadyExpanded: true }),
    true,
  );
});

test("unknown policy throws", () => {
  assert.throws(
    () => shouldStopDeepRecall({ budgetLeft: 3, policy: "refine-twice" }),
    /unknown deep recall stop policy/,
  );
  assert.throws(
    () => shouldStopDeepRecall({ budgetLeft: 3, policy: "refine-twice" }),
    /stop, expand-once/,
  );
});
