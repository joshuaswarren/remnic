import test from "node:test";
import assert from "node:assert/strict";
import { inferIntentFromText, planRecallMode } from "../src/intent.ts";

test("runtime input guards: planRecallMode handles nullish/non-string values", () => {
  const weirdInputs: unknown[] = [undefined, null, 42, true, { x: 1 }, ["ok"]];
  for (const value of weirdInputs) {
    assert.doesNotThrow(() => planRecallMode(value as string));
    assert.equal(planRecallMode(value as string), "no_recall");
  }
});

test("runtime input guards: inferIntentFromText handles nullish/non-string values", () => {
  const weirdInputs: unknown[] = [undefined, null, 42, true, { x: 1 }, ["ok"]];
  for (const value of weirdInputs) {
    assert.doesNotThrow(() => inferIntentFromText(value as string));
    const out = inferIntentFromText(value as string);
    assert.equal(out.goal, "unknown");
    assert.equal(out.actionType, "unknown");
    assert.deepEqual(out.entityTypes, []);
  }
});
