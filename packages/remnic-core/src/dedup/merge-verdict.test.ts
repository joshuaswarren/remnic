import assert from "node:assert/strict";
import test from "node:test";

import { MERGE_JUDGE_VERDICTS, parseMergeJudgeVerdict } from "./merge-verdict.js";

test("every allow-list name parses (loops the constant)", () => {
  for (const name of MERGE_JUDGE_VERDICTS) {
    const result = parseMergeJudgeVerdict(name);
    assert.equal(result.ok, true);
    assert.ok(result.ok);
    assert.equal(result.verdict, name);
    assert.equal(result.decision, name === "merge" ? "merge" : "create");
  }
});

test("accepts mixed case and surrounding whitespace", () => {
  for (const raw of ["MERGE", " merge ", "Create", "\tcreate\n", "UnCertain", "  uncertain  "]) {
    const result = parseMergeJudgeVerdict(raw);
    assert.ok(result.ok, `expected "${raw}" to parse`);
    assert.equal(result.verdict, raw.trim().toLowerCase());
  }
});

test("only merge yields decision merge", () => {
  const merged = parseMergeJudgeVerdict("merge");
  assert.ok(merged.ok);
  assert.equal(merged.decision, "merge");
});

test("uncertain yields decision create", () => {
  const result = parseMergeJudgeVerdict("uncertain");
  assert.ok(result.ok);
  assert.equal(result.verdict, "uncertain");
  assert.equal(result.decision, "create");
});

test("empty and non-string inputs give empty_verdict with decision create", () => {
  const empties: unknown[] = ["", "   ", null, undefined, 42, { verdict: "merge" }, ["merge"]];
  for (const raw of empties) {
    const result = parseMergeJudgeVerdict(raw);
    assert.ok(!result.ok, `expected ${JSON.stringify(raw)} to fail`);
    assert.equal(result.error, "empty_verdict");
    assert.equal(result.decision, "create");
  }
});

test("unrecognized strings give unknown_verdict with decision create", () => {
  for (const raw of ["I think merge", "maybe", "merge them", "merg", "MERGE!"]) {
    const result = parseMergeJudgeVerdict(raw);
    assert.ok(!result.ok, `expected "${raw}" to fail`);
    assert.equal(result.error, "unknown_verdict");
    assert.equal(result.decision, "create");
  }
});

test("no input throws", () => {
  const hostile: unknown[] = [
    "",
    "   ",
    null,
    undefined,
    0,
    NaN,
    {},
    [],
    () => "merge",
    Symbol("merge"),
    "I think merge",
    "merge",
  ];
  for (const raw of hostile) {
    assert.doesNotThrow(() => parseMergeJudgeVerdict(raw));
  }
});
