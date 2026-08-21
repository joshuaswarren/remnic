import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  exactMatch,
  f1Score,
  rougeL,
  recallAtK,
  containsAnswer,
  aggregateScores,
} from "../evals/scorer.js";

describe("eval scorer", () => {
  describe("exactMatch", () => {
    it("matches identical strings", () => {
      assert.equal(exactMatch("Paris", "Paris"), 1.0);
    });

    it("is case insensitive", () => {
      assert.equal(exactMatch("paris", "PARIS"), 1.0);
    });

    it("trims whitespace", () => {
      assert.equal(exactMatch("  Paris  ", "Paris"), 1.0);
    });

    it("rejects different strings", () => {
      assert.equal(exactMatch("London", "Paris"), 0.0);
    });
  });

  describe("f1Score", () => {
    it("returns 1.0 for identical strings", () => {
      assert.equal(f1Score("the cat sat", "the cat sat"), 1.0);
    });

    it("returns 0.0 for no overlap", () => {
      assert.equal(f1Score("hello world", "foo bar"), 0.0);
    });

    it("returns partial score for partial overlap", () => {
      const score = f1Score("the cat sat on the mat", "the cat");
      assert.ok(score > 0.0 && score < 1.0);
    });

    it("handles empty strings", () => {
      assert.equal(f1Score("", ""), 1.0);
      assert.equal(f1Score("hello", ""), 0.0);
      assert.equal(f1Score("", "hello"), 0.0);
    });
  });

  describe("rougeL", () => {
    it("returns 1.0 for identical strings", () => {
      assert.equal(rougeL("the cat sat", "the cat sat"), 1.0);
    });

    it("returns 0.0 for no common subsequence", () => {
      assert.equal(rougeL("abc def", "xyz uvw"), 0.0);
    });

    it("scores subsequence overlap", () => {
      const score = rougeL("the cat sat on the mat", "the cat on mat");
      assert.ok(score > 0.5);
    });
  });

  describe("recallAtK", () => {
    it("returns 1.0 when all relevant items found", () => {
      assert.equal(recallAtK(["a", "b", "c"], ["a", "b"], 3), 1.0);
    });

    it("returns 0.0 when no relevant items found", () => {
      assert.equal(recallAtK(["x", "y"], ["a", "b"], 2), 0.0);
    });

    it("respects K cutoff", () => {
      assert.equal(recallAtK(["x", "a"], ["a"], 1), 0.0);
      assert.equal(recallAtK(["x", "a"], ["a"], 2), 1.0);
    });

    it("returns 1.0 for empty relevant set", () => {
      assert.equal(recallAtK(["a"], [], 1), 1.0);
    });

  });

  describe("containsAnswer", () => {
    it("finds substring match", () => {
      assert.equal(
        containsAnswer("The capital of France is Paris.", "Paris"),
        1.0,
      );
    });

    it("is case insensitive", () => {
      assert.equal(containsAnswer("I love PARIS", "paris"), 1.0);
    });

    it("returns 0 when not contained", () => {
      assert.equal(containsAnswer("The capital is London", "Paris"), 0.0);
    });
  });

  describe("aggregateScores", () => {
    it("computes mean, min, max", () => {
      const agg = aggregateScores([
        { f1: 0.5, exact: 0.0 },
        { f1: 1.0, exact: 1.0 },
      ]);
      assert.equal(agg.f1_mean, 0.75);
      assert.equal(agg.f1_min, 0.5);
      assert.equal(agg.f1_max, 1.0);
      assert.equal(agg.exact_mean, 0.5);
    });

    it("returns empty for empty input", () => {
      const agg = aggregateScores([]);
      assert.deepEqual(agg, {});
    });
  });
});
