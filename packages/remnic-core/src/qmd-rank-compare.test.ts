import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareRankedLists, compareDirectories, compareRerankOff, formatComparison, spearman } from "../../../scripts/recall-qmd-compare.mjs";

const row = (docid: string) => ({ docid, score: 1 });

test("identical rankings match on top-1, overlap, and correlation", () => {
  const ranked = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map(row);
  const compared = compareRankedLists(ranked, ranked);
  assert.equal(compared.top1Match, true);
  assert.equal(compared.top10Overlap, 10);
  assert.ok(Math.abs((compared.spearman ?? NaN) - 1) < 1e-9);
});

test("a swap keeps top-1 and reports the rank correlation", () => {
  const before = ["a", "b", "c"].map(row);
  const after = ["a", "c", "b"].map(row);
  const compared = compareRankedLists(before, after);
  assert.equal(compared.top1Match, true);
  assert.equal(compared.top10Overlap, 3);
  assert.ok(Math.abs((compared.spearman ?? NaN) - 0.5) < 1e-9);
});

test("disjoint top-10 lists do not match and correlation is negative", () => {
  const before = ["a", "b", "c"].map(row);
  const after = ["d", "e", "f"].map(row);
  const compared = compareRankedLists(before, after);
  assert.equal(compared.top1Match, false);
  assert.equal(compared.top10Overlap, 0);
  assert.ok((compared.spearman ?? 0) < 0);
});

test("spearman is 1 for tied constant ranks and -1 for a reversal", () => {
  assert.equal(spearman([1, 1, 1], [4, 4, 4]), 1);
  assert.ok(Math.abs((spearman([1, 2, 3], [3, 2, 1]) ?? NaN) + 1) < 1e-9);
});

test("an empty ranking against a non-empty one is not perfect correlation", () => {
  const compared = compareRankedLists([], ["a", "b", "c"].map(row));
  assert.equal(compared.top10Overlap, 0);
  assert.equal(compared.spearman, null);
  assert.equal(spearman([11, 11], [1, 2]), null);
  assert.equal(spearman([1], [1]), 1);
  assert.equal(spearman([1], [11]), null);
});

function resultFile(dir: string, name: string, docids: string[]): void {
  writeFileSync(join(dir, name), JSON.stringify({ results: docids.map(row) }));
}

test("a missing or unreadable counterpart is reported, not dropped", () => {
  const before = mkdtempSync(join(tmpdir(), "qmd-cmp-b-"));
  const after = mkdtempSync(join(tmpdir(), "qmd-cmp-a-"));
  resultFile(before, "q1.json", ["a", "b"]);
  resultFile(before, "q2.json", ["a", "b"]);
  resultFile(before, "q3.json", ["a", "b"]);
  resultFile(after, "q1.json", ["a", "b"]);
  writeFileSync(join(after, "q3.json"), "{not json");
  const rows = compareDirectories(before, after);
  assert.deepEqual(rows.filter((r) => r.missing).map((r) => r.name), ["q2.json", "q3.json"]);
  assert.match(formatComparison(rows), /summary queries=3 compared=1 missing=2 empty_side=0/);
});

test("rerank-off reports a daemon file with no norerank twin instead of throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "qmd-cmp-r-"));
  resultFile(dir, "q1-daemon.json", ["a", "b"]);
  resultFile(dir, "q1-norerank.json", ["a", "b"]);
  resultFile(dir, "q2-daemon.json", ["a", "b"]);
  const rows = compareRerankOff(dir);
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((r) => r.missing).length, 1);
});

test("files present on only one side, an invalid results field, and a one-sided empty ranking are all reported", () => {
  const before = mkdtempSync(join(tmpdir(), "qmd-cmp-b2-"));
  const after = mkdtempSync(join(tmpdir(), "qmd-cmp-a2-"));
  resultFile(before, "q1.json", ["a", "b"]);
  writeFileSync(join(after, "q1.json"), "{}");
  resultFile(after, "q2.json", ["a"]);
  resultFile(before, "q3.json", ["a", "b"]);
  resultFile(after, "q3.json", []);
  const rows = compareDirectories(before, after);
  assert.deepEqual(rows.map((r) => r.name), ["q1.json", "q2.json", "q3.json"]);
  assert.deepEqual(rows.map((r) => Boolean(r.missing)), [true, true, false]);
  assert.equal(rows[2]?.oneSidedEmpty, true);
  assert.match(formatComparison(rows), /missing=2 empty_side=1/);
  // an empty before dir with captures only in after must not look clean
  const emptyBefore = mkdtempSync(join(tmpdir(), "qmd-cmp-b3-"));
  assert.equal(compareDirectories(emptyBefore, after).every((r) => r.missing), true);
});
