import assert from "node:assert/strict";
import test from "node:test";

import {
  STALE_BASE_COMMIT_THRESHOLD,
  evaluateClosedIssueBase,
  parseFixNumbers,
} from "../scripts/check-closed-issue-base.mjs";

test("parseFixNumbers matches the GitHub closing-keyword family, case-insensitively", () => {
  assert.deepEqual(parseFixNumbers("Fixes #2454"), [2454]);
  assert.deepEqual(parseFixNumbers("fix #12"), [12]);
  assert.deepEqual(parseFixNumbers("This closes #34 and nothing else"), [34]);
  assert.deepEqual(parseFixNumbers("CLOSES #7. RESOLVED #8."), [7, 8]);
  assert.deepEqual(parseFixNumbers("Fixed #9, fixes #9 again (dedup)"), [9]);
});

test("parseFixNumbers ignores cross-repo refs, plain mentions, and keyword-less bodies", () => {
  assert.deepEqual(parseFixNumbers("Fixes owner/repo#1"), []);
  assert.deepEqual(parseFixNumbers("See #42 for context"), []);
  assert.deepEqual(parseFixNumbers(""), []);
  assert.deepEqual(parseFixNumbers("no keywords here #99"), []);
});

test("a closed claim with a far-behind base is a revert bomb", () => {
  const verdict = evaluateClosedIssueBase({
    body: "Fixes #2454",
    commitsBehindMain: STALE_BASE_COMMIT_THRESHOLD,
    closedFixNumbers: [2454],
  });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.staleFixNumbers, [2454]);
  assert.match(verdict.reason, /#2454/);
  assert.match(verdict.reason, /Rebase/);
});

test("boundary: 14 commits behind passes, 15 fails", () => {
  const input = { body: "Fixes #2454", closedFixNumbers: [2454] };
  assert.equal(evaluateClosedIssueBase({ ...input, commitsBehindMain: 14 }).ok, true);
  assert.equal(evaluateClosedIssueBase({ ...input, commitsBehindMain: 15 }).ok, false);
});

test("a still-open claimed issue never trips the gate", () => {
  const verdict = evaluateClosedIssueBase({
    body: "Fixes #100 and closes #101",
    commitsBehindMain: 99,
    closedFixNumbers: [],
  });
  assert.equal(verdict.ok, true);
});

test("one closed and one open claim with a stale base still fails", () => {
  const verdict = evaluateClosedIssueBase({
    body: "Fixes #100 and closes #101",
    commitsBehindMain: 30,
    closedFixNumbers: [101],
  });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.staleFixNumbers, [101]);
});

test("a closed claim on a fresh base passes (rebased PR is reviewable)", () => {
  const verdict = evaluateClosedIssueBase({
    body: "Fixes #2454",
    commitsBehindMain: 2,
    closedFixNumbers: [2454],
  });
  assert.equal(verdict.ok, true);
});

test("a keyword-less body passes regardless of staleness", () => {
  const verdict = evaluateClosedIssueBase({ body: "chore: cleanup", commitsBehindMain: 50, closedFixNumbers: [50] });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.staleFixNumbers, []);
});

test("invalid commitsBehindMain is treated as 0, never as stale", () => {
  const verdict = evaluateClosedIssueBase({
    body: "Fixes #2454",
    commitsBehindMain: "lots",
    closedFixNumbers: [2454],
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.commitsBehindMain, 0);
});
