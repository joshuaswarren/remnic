import assert from "node:assert/strict";
import test from "node:test";

import { estimateTokenCount } from "./token-estimate.js";

test("estimates English text at about four code points per token", () => {
  assert.equal(estimateTokenCount("abcdefghijklmnop"), 4);
});

test("estimates Japanese text at about one token per code point", () => {
  assert.equal(estimateTokenCount("日本語の文章です"), 8);
});

test("combines script-aware counts for mixed text", () => {
  assert.equal(estimateTokenCount("abcd世界"), 3);
});

test("normalizes composed characters before counting code points", () => {
  assert.equal(estimateTokenCount("e\u0301e\u0301e\u0301e\u0301"), 1);
});

test("counts Thai combining marks in wide-script text", () => {
  assert.equal(estimateTokenCount("ที่"), 3);
});

test("counts astral code points once", () => {
  assert.equal(estimateTokenCount("😀😀😀😀"), 1);
});
