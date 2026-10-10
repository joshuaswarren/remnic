import assert from "node:assert/strict";
import test from "node:test";
import { compareRankedLists, spearman } from "../../../scripts/recall-qmd-compare.mjs";

const row = (docid: string) => ({ docid, score: 1 });

test("identical rankings match on top-1, overlap, and correlation", () => {
  const ranked = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map(row);
  const compared = compareRankedLists(ranked, ranked);
  assert.equal(compared.top1Match, true);
  assert.equal(compared.top10Overlap, 10);
  assert.ok(Math.abs(compared.spearman - 1) < 1e-9);
});

test("a swap keeps top-1 and reports the rank correlation", () => {
  const before = ["a", "b", "c"].map(row);
  const after = ["a", "c", "b"].map(row);
  const compared = compareRankedLists(before, after);
  assert.equal(compared.top1Match, true);
  assert.equal(compared.top10Overlap, 3);
  assert.ok(Math.abs(compared.spearman - 0.5) < 1e-9);
});

test("disjoint top-10 lists do not match and correlation is negative", () => {
  const before = ["a", "b", "c"].map(row);
  const after = ["d", "e", "f"].map(row);
  const compared = compareRankedLists(before, after);
  assert.equal(compared.top1Match, false);
  assert.equal(compared.top10Overlap, 0);
  assert.ok(compared.spearman < 0);
});

test("spearman is 1 for tied constant ranks and -1 for a reversal", () => {
  assert.equal(spearman([1, 1, 1], [4, 4, 4]), 1);
  assert.ok(Math.abs(spearman([1, 2, 3], [3, 2, 1]) + 1) < 1e-9);
});
