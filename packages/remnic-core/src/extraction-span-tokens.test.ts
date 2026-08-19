import assert from "node:assert/strict";
import { test } from "node:test";
import {
  estimateGeneratedTokens,
  estimateOffsetTokens,
  spanModeSavesTokens,
} from "./extraction-span-tokens.js";

test("estimateGeneratedTokens: 0 chars -> 0 tokens", () => {
  assert.equal(estimateGeneratedTokens(0), 0);
});

test("estimateGeneratedTokens: 1..4 chars -> 1 token", () => {
  for (const chars of [1, 2, 3, 4]) {
    assert.equal(estimateGeneratedTokens(chars), 1);
  }
});

test("estimateGeneratedTokens: 5 chars -> 2 tokens", () => {
  assert.equal(estimateGeneratedTokens(5), 2);
});

test("estimateGeneratedTokens: invalid charCount throws", () => {
  assert.throws(() => estimateGeneratedTokens(-1), /charCount/);
  assert.throws(() => estimateGeneratedTokens(Number.NaN), /charCount/);
  assert.throws(() => estimateGeneratedTokens(3.7), /charCount/);
  assert.throws(() => estimateGeneratedTokens(-1), RangeError);
  assert.throws(() => estimateGeneratedTokens(Number.NaN), RangeError);
});

test("estimateOffsetTokens: (0, 12) cost is a positive integer", () => {
  const cost = estimateOffsetTokens(0, 12);
  assert.equal(Number.isInteger(cost), true);
  assert.ok(cost > 0);
});

test("estimateOffsetTokens: offset 0 costs one character (one token)", () => {
  assert.equal(estimateOffsetTokens(0, 0), 2);
});

test("estimateOffsetTokens: reversed span throws", () => {
  assert.throws(() => estimateOffsetTokens(13, 12), RangeError);
  assert.throws(() => estimateOffsetTokens(13, 12), /reversed/);
});

test("estimateOffsetTokens: non-finite or non-integer offsets throw", () => {
  assert.throws(() => estimateOffsetTokens(Number.NaN, 12), RangeError);
  assert.throws(() => estimateOffsetTokens(0, Number.POSITIVE_INFINITY), RangeError);
  assert.throws(() => estimateOffsetTokens(0.5, 12), RangeError);
});

test("spanModeSavesTokens: long generated value beats small offsets", () => {
  assert.equal(
    spanModeSavesTokens({ generatedCharCount: 1000, start: 0, end: 12 }),
    true,
  );
});

test("spanModeSavesTokens: equal costs return false", () => {
  // (0, 12) costs 2 tokens; 5..8 generated chars also cost 2 tokens.
  assert.equal(
    spanModeSavesTokens({ generatedCharCount: 8, start: 0, end: 12 }),
    false,
  );
  assert.equal(
    spanModeSavesTokens({ generatedCharCount: 5, start: 0, end: 0 }),
    false,
  );
});
