import assert from "node:assert/strict";
import { test } from "node:test";

import { shouldRecallEventOrderEvidence } from "../packages/remnic-core/src/event-order-recall.ts";
import {
  expandUnsegmentableRecallNGrams,
  isUnsegmentableRecallChar,
  normalizeRecallTokens,
} from "../packages/remnic-core/src/recall-tokenization.ts";
test("Thai characters are unsegmentable and expand to n-grams", () => {
  assert.equal(isUnsegmentableRecallChar("ก"), true);
  const tokens = expandUnsegmentableRecallNGrams("กรุง");
  assert.equal(tokens.includes("ก"), true);
  assert.equal(tokens.includes("กรุง"), true);
  assert.ok(normalizeRecallTokens("กรุงเทพ").length > 1);
});

test("Khmer Lao and Myanmar scripts are unsegmentable", () => {
  assert.equal(isUnsegmentableRecallChar("ក"), true);
  assert.equal(isUnsegmentableRecallChar("ກ"), true);
  assert.equal(isUnsegmentableRecallChar("က"), true);
});

test("shouldRecallEventOrderEvidence matches Japanese temporal cues", () => {
  assert.equal(shouldRecallEventOrderEvidence("最初に何があった"), true);
  assert.equal(shouldRecallEventOrderEvidence("What was my espresso code?"), false);
});
