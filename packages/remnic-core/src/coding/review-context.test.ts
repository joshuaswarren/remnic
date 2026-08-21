/**
 * Tests for the diff-aware review-context packer (issue #569 PR 4).
 *
 * All fixtures synthetic — no real diffs, no real user data.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  isReviewPrompt,
  packReviewContext,
  parseTouchedFiles,
  rankReviewCandidates,
  type ReviewCandidate,
} from "./review-context.js";

// ──────────────────────────────────────────────────────────────────────────
// isReviewPrompt
// ──────────────────────────────────────────────────────────────────────────

test("isReviewPrompt: matches the #569 keyword list (case-insensitive)", () => {
  for (const prompt of [
    "review this PR",
    "Review this diff",
    "look at this PR",
    "what changed?",
    "WHAT CHANGED in this branch",
    "can you do a code review?",
    "what's in this PR?",
    "what is in this patch?",
  ]) {
    assert.equal(isReviewPrompt(prompt), true, `expected match: ${JSON.stringify(prompt)}`);
  }
});

test("isReviewPrompt: rejects non-review prompts", () => {
  for (const prompt of [
    "how do i set up the project?",
    "what is the meaning of life",
    "refactor the foo module",
    "write a test for bar",
    "", // empty
    "   ",
  ]) {
    assert.equal(isReviewPrompt(prompt), false, `expected non-match: ${JSON.stringify(prompt)}`);
  }
});

test("isReviewPrompt: `reviewer` (longer word) does NOT match `review`", () => {
  // Whole-word boundary.
  assert.equal(isReviewPrompt("who is the reviewer on call?"), false);
});

test("isReviewPrompt: null/undefined input returns false defensively", () => {
  assert.equal(isReviewPrompt(null), false);
  assert.equal(isReviewPrompt(undefined), false);
});

// ──────────────────────────────────────────────────────────────────────────
// parseTouchedFiles
// ──────────────────────────────────────────────────────────────────────────

test("parseTouchedFiles: extracts paths from `diff --git` lines", () => {
  const diff = [
    "diff --git a/src/foo.ts b/src/foo.ts",
    "index 111..222 100644",
    "--- a/src/foo.ts",
    "+++ b/src/foo.ts",
    "@@ -1,3 +1,3 @@",
    "-old",
    "+new",
  ].join("\n");
  assert.deepEqual(parseTouchedFiles(diff), ["src/foo.ts"]);
});

test("parseTouchedFiles: extracts paths from --- / +++ headers when no `diff --git` line", () => {
  const diff = [
    "--- a/docs/readme.md",
    "+++ b/docs/readme.md",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");
  assert.deepEqual(parseTouchedFiles(diff), ["docs/readme.md"]);
});

test("parseTouchedFiles: strips `a/` / `b/` prefixes exactly once", () => {
  const diff = "diff --git a/a/foo.ts b/a/foo.ts";
  // Path "a/foo.ts" — not "foo.ts". Only the leading single-letter prefix is stripped.
  assert.deepEqual(parseTouchedFiles(diff), ["a/foo.ts"]);
});

test("parseTouchedFiles: ignores /dev/null markers (adds and deletes)", () => {
  const diff = [
    "diff --git a/new.ts b/new.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/new.ts",
  ].join("\n");
  assert.deepEqual(parseTouchedFiles(diff), ["new.ts"]);
});

test("parseTouchedFiles: multi-file diff deduplicates and sorts", () => {
  const diff = [
    "diff --git a/z.ts b/z.ts",
    "--- a/z.ts",
    "+++ b/z.ts",
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "diff --git a/m.ts b/m.ts",
    "--- a/m.ts",
    "+++ b/m.ts",
  ].join("\n");
  assert.deepEqual(parseTouchedFiles(diff), ["a.ts", "m.ts", "z.ts"]);
});

test("parseTouchedFiles: empty / non-string / whitespace input → empty list", () => {
  assert.deepEqual(parseTouchedFiles(""), []);
  assert.deepEqual(parseTouchedFiles(null), []);
  assert.deepEqual(parseTouchedFiles(undefined), []);
  assert.deepEqual(parseTouchedFiles("   \n  "), []);
});

test("parseTouchedFiles: rename handles both sides of the diff --git line", () => {
  const diff = [
    "diff --git a/old/name.ts b/new/name.ts",
    "similarity index 98%",
    "rename from old/name.ts",
    "rename to new/name.ts",
  ].join("\n");
  assert.deepEqual(parseTouchedFiles(diff), ["new/name.ts", "old/name.ts"]);
});

test("parseTouchedFiles: quoted `diff --git` paths with spaces are kept intact", () => {
  // Regression: the previous `\\S+` tokenizer shattered
  // `"a/src/my file.ts" "b/src/my file.ts"` into four half-paths. Quoted
  // diff-git paths must be parsed as single tokens.
  //
  // Real git emits quoted `---` / `+++` headers whenever the filename
  // contains whitespace, matching the `diff --git` line — so both places
  // we parse must respect quoting.
  const diff = [
    'diff --git "a/src/my file.ts" "b/src/my file.ts"',
    '--- "a/src/my file.ts"',
    '+++ "b/src/my file.ts"',
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");
  const out = parseTouchedFiles(diff);
  assert.deepEqual(out, ["src/my file.ts"]);
});

test("parseTouchedFiles: --- / +++ header alone (no diff --git prefix) handles quoted path", () => {
  // Regression: the `--- / +++` header regex used `\S+`, which stops at the
  // first internal whitespace. For quoted paths like `--- "a/foo bar.ts"`
  // the path was silently truncated after `"a/foo`. Now the header path is
  // extracted with an explicit tokenizer that respects quotes.
  const diff = [
    '--- "a/path with spaces.ts"',
    '+++ "b/path with spaces.ts"',
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");
  assert.deepEqual(parseTouchedFiles(diff), ["path with spaces.ts"]);
});

test("parseTouchedFiles: quoted paths in --- / +++ headers (stripDiffPathPrefix order)", () => {
  // Regression: `stripDiffPathPrefix` checked `a/` / `b/` BEFORE stripping
  // quotes, so `"a/path with spaces.ts"` never matched the prefix, leaving
  // a bogus `"a/path` entry. Quote-stripping must happen first so the
  // prefix check sees the unquoted `a/path with spaces.ts`.
  const diff = [
    'diff --git "a/path with spaces.ts" "b/path with spaces.ts"',
    '--- "a/path with spaces.ts"',
    '+++ "b/path with spaces.ts"',
  ].join("\n");
  const out = parseTouchedFiles(diff);
  assert.deepEqual(out, ["path with spaces.ts"]);
});

test("parseTouchedFiles: unterminated quoted path does not crash or produce fragments", () => {
  // Defensive: a malformed diff with an unclosed quote must not throw and
  // must not emit garbage touched-file entries.
  const diff = 'diff --git "a/broken src/foo.ts\n';
  const out = parseTouchedFiles(diff);
  assert.deepEqual(out, []);
});

test("parseTouchedFiles: escaped quote inside quoted path is preserved", () => {
  // Git uses backslash escapes inside C-quoted paths. The parser must
  // handle `\"` without terminating the token early, and must leave the
  // unescaped literal quote in the final path.
  const diff = 'diff --git "a/has\\"quote.ts" "b/has\\"quote.ts"\n';
  const out = parseTouchedFiles(diff);
  assert.deepEqual(out, ['has"quote.ts']);
});

test("parseTouchedFiles: C-quoted octal UTF-8 path bytes are decoded", () => {
  const diff = [
    'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
    '--- "a/caf\\303\\251.ts"',
    '+++ "b/caf\\303\\251.ts"',
  ].join("\n");

  assert.deepEqual(parseTouchedFiles(diff), ["café.ts"]);
});

test("parseTouchedFiles: invalid C-quoted UTF-8 preserves raw token without path-separator corruption", () => {
  const diff = 'diff --git "a/bad\\303.ts" "b/bad\\303.ts"';

  assert.deepEqual(parseTouchedFiles(diff), ['"a/bad\\303.ts"', '"b/bad\\303.ts"']);
});

// ──────────────────────────────────────────────────────────────────────────
// rankReviewCandidates
// ──────────────────────────────────────────────────────────────────────────

function c(id: string, score: number, entityRefs?: string[]): ReviewCandidate {
  return { id, score, entityRefs };
}

test("rankReviewCandidates: no touched files → no boost; stable by (score desc, id asc)", () => {
  const out = rankReviewCandidates(
    [c("b", 0.3), c("a", 0.8), c("c", 0.3)],
    [],
  );
  assert.deepEqual(
    out.map((r) => r.id),
    ["a", "b", "c"],
  );
  for (const r of out) assert.equal(r.boost, 0);
});

test("rankReviewCandidates: matched memory floats above same-score unmatched peer", () => {
  // Two candidates with identical score; only one mentions a touched file.
  // The match boost must break the tie and push the matched one first.
  const candidates = [
    c("same-unrelated", 0.3, ["lib/other.ts"]),
    c("same-matched", 0.3, ["src/foo.ts"]),
  ];
  const out = rankReviewCandidates(candidates, ["src/foo.ts"]);
  assert.equal(out[0]!.id, "same-matched");
  assert.equal(out[0]!.boost, 0.5);
  assert.equal(out[1]!.id, "same-unrelated");
  assert.equal(out[1]!.boost, 0);
});

test("rankReviewCandidates: boost narrows gap with stronger unmatched peer (0.1+boost vs 0.7)", () => {
  // A boosted weak candidate does NOT beat a strong unmatched peer — the
  // boost is a bias, not a filter. But it should at least close the gap.
  const candidates = [
    c("strong-unrelated", 0.7, ["lib/other.ts"]),
    c("weak-matched", 0.1, ["src/foo.ts"]),
  ];
  const out = rankReviewCandidates(candidates, ["src/foo.ts"]);
  assert.equal(out[0]!.id, "strong-unrelated", "0.7 still wins against 0.1 + 0.5 = 0.6");
  // But the matched candidate now sits at 0.6 instead of 0.1.
  const matched = out.find((r) => r.id === "weak-matched");
  assert.ok(matched);
  assert.equal(matched!.score + matched!.boost, 0.6);
});

test("rankReviewCandidates: boost is capped at 1.0 even with many matches", () => {
  const cand = c("many-hits", 0, ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
  const out = rankReviewCandidates([cand], ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
  assert.ok(out[0]);
  assert.equal(out[0]!.boost, 1.0, "boost must cap at MAX_BOOST");
});

test("rankReviewCandidates: missing entityRefs → boost 0 (no crash)", () => {
  const out = rankReviewCandidates([{ id: "x", score: 0.5 }], ["src/foo.ts"]);
  assert.equal(out[0]!.boost, 0);
});

test("rankReviewCandidates: substring matching — ref 'foo.ts' matches touched 'src/foo.ts'", () => {
  const out = rankReviewCandidates(
    [c("basename-ref", 0.1, ["foo.ts"])],
    ["src/foo.ts"],
  );
  assert.equal(out[0]!.boost, 0.5, "basename-style ref should match a repo-relative touched path");
});

test("rankReviewCandidates: deterministic tie-break by id (rule 19 — comparator returns 0 for equal)", () => {
  const out = rankReviewCandidates(
    [c("zeta", 0.5), c("alpha", 0.5), c("mu", 0.5)],
    [],
  );
  assert.deepEqual(
    out.map((r) => r.id),
    ["alpha", "mu", "zeta"],
  );
});

// ──────────────────────────────────────────────────────────────────────────
// packReviewContext end-to-end
// ──────────────────────────────────────────────────────────────────────────

test("packReviewContext: full path — diff → touched files + ranked recall", () => {
  const diff = [
    "diff --git a/src/auth.ts b/src/auth.ts",
    "--- a/src/auth.ts",
    "+++ b/src/auth.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");
  const result = packReviewContext({
    diff,
    candidates: [
      c("auth-history", 0.2, ["src/auth.ts"]),
      c("random-other", 0.6, ["db.sql"]),
    ],
  });

  assert.deepEqual(result.touchedFiles, ["src/auth.ts"]);
  assert.equal(result.rankedRecall[0]!.id, "auth-history");
  assert.equal(result.rankedRecall[0]!.boost, 0.5);
  assert.equal(result.rankedRecall[1]!.id, "random-other");
});

test("packReviewContext: C-quoted non-ASCII touched paths boost matching candidates", () => {
  const result = packReviewContext({
    diff: 'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
    candidates: [
      c("matched-cafe", 0.2, ["café.ts"]),
      c("unmatched", 0.6, ["db.sql"]),
    ],
  });

  assert.deepEqual(result.touchedFiles, ["café.ts"]);
  assert.equal(result.rankedRecall[0]!.id, "matched-cafe");
  assert.equal(result.rankedRecall[0]!.boost, 0.5);
});

test("packReviewContext: empty diff → no touched files, no boosts, ranked by score", () => {
  const result = packReviewContext({
    diff: "",
    candidates: [c("a", 0.1), c("b", 0.9), c("c", 0.5)],
  });
  assert.deepEqual(result.touchedFiles, []);
  assert.deepEqual(result.rankedRecall.map((r) => r.id), ["b", "c", "a"]);
});
