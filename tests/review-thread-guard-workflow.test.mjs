import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("review-thread guard excludes CodeQL bot review-thread authors", () => {
  const workflow = readFileSync(".github/workflows/review-thread-guard.yml", "utf8");

  // Extract the actual NON_DEDUP_LOGINS set literal so a stray mention of a bot
  // name in a comment or unrelated code cannot satisfy the assertion.
  const setMatch = workflow.match(/const NON_DEDUP_LOGINS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(setMatch, "NON_DEDUP_LOGINS set literal must exist");
  const entries = [...setMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  for (const login of [
    "github-advanced-security",
    "github-advanced-security[bot]",
    "github-code-scanning[bot]",
  ]) {
    assert.ok(entries.includes(login), `NON_DEDUP_LOGINS must contain ${login}`);
  }

  // The gating branch must exclude non-dedup authors via the concrete expression.
  assert.match(workflow, /return !NON_DEDUP_LOGINS\.has\(loginOf\(t\) \?\? ""\);/);
});

test("review-thread guard inline mirror excludes resolved+outdated threads from canonicals", () => {
  const workflow = readFileSync(".github/workflows/review-thread-guard.yml", "utf8");

  // The stale-canonical predicate must mirror isStaleResolvedCanonical in
  // scripts/review-dedup.mjs so a resolved+outdated thread cannot anchor a
  // later active finding (codex P2 false-merge fix).
  assert.match(
    workflow,
    /const isStaleCanonical = \(t\) => t\.isResolved === true && t\.isOutdated === true;/,
  );

  // Both canonical-push sites (detached/non-dedup branch and the new-canonical
  // else branch) must be guarded by the predicate — mirror drift on either
  // reopens the hiding bug.
  assert.match(
    workflow,
    /if \(!NON_DEDUP_LOGINS\.has\(loginOf\(t\) \?\? ""\) && !isStaleCanonical\(t\)\) \{/,
  );
  assert.match(workflow, /if \(!isStaleCanonical\(t\)\) canonicals\.push\(\{ id: t\.id, anchor, body \}\);/);
});

test("check-unsticker query selects isOutdated so its dedup matches the guard", () => {
  // check-unsticker imports dedupeThreads, which now excludes resolved+outdated
  // threads from canonicals; if its GraphQL query omits isOutdated the field is
  // always undefined and its dedup diverges from review-thread-guard.yml on
  // stale resolved threads (cursor bugbot L82-L94).
  const unsticker = readFileSync(".github/workflows/check-unsticker.yml", "utf8");
  const queryBlock = unsticker.match(/reviewThreads\(first: 100, after: \$after\) \{[\s\S]*?comments\(first: 100\)/);
  assert.ok(queryBlock, "check-unsticker reviewThreads query block must exist");
  assert.match(queryBlock[0], /\bisOutdated\b/, "check-unsticker thread nodes must request isOutdated");
});

test("review-thread guard posts audit replies via 64-bit-safe fullDatabaseId", () => {
  // databaseId is deprecated for PullRequestReviewComment and null for 64-bit
  // ids; the enforce-mode audit reply must use fullDatabaseId or it silently
  // drops and the duplicate can never inherit its canonical's resolution
  // (codex P2). Guard against a regression to the deprecated field.
  const workflow = readFileSync(".github/workflows/review-thread-guard.yml", "utf8");
  assert.match(workflow, /const commentId = r\.t\.comments\?\.nodes\?\.\[0\]\?\.fullDatabaseId;/);
  assert.doesNotMatch(
    workflow,
    /\bdatabaseId\b/,
    "guard must not use the deprecated databaseId field",
  );
});

test("review-thread guard inline hasGateReply requires the Actions-bot author", () => {
  // The dedup marker is public; the inline hasGateReply must require a
  // github-actions author or a spoofed marker folds a thread out of the guard
  // (codex P2). Mirrors GATE_REPLY_AUTHOR_LOGINS in scripts/review-dedup.mjs.
  const workflow = readFileSync(".github/workflows/review-thread-guard.yml", "utf8");
  assert.match(
    workflow,
    /const GATE_REPLY_AUTHOR_LOGINS = new Set\(\["github-actions", "github-actions\[bot\]"\]\);/,
  );
  assert.match(workflow, /GATE_REPLY_AUTHOR_LOGINS\.has\(c\?\.author\?\.login \?\? ""\)/);
});

test("review-thread guard inline stripMarkup preserves bounded fenced code without HTML-stripping it", () => {
  // Dropping fenced snippets collapses distinct findings that differ only in
  // their code to identical prose -> false merge (codex P2). The inline mirror
  // must keep bounded inner code AND flatten angle brackets so JSX/generics
  // survive the later HTML pass, matching preserveFencedCode in review-dedup.mjs.
  const workflow = readFileSync(".github/workflows/review-thread-guard.yml", "utf8");
  const fence = workflow.match(/\.replace\(\/```\(\[\\s\\S\]\*\?\)```\/g,[^\n]*\)/);
  assert.ok(fence, "guard must preserve fenced code via a replacer function");
  assert.match(fence[0], /inner\.replace\(\/\^\[\^\\n\]\*\\n\/, ""\)/, "must drop the language line");
  assert.match(fence[0], /\.replace\(\/\[<>\]\/g, " "\)/, "must flatten angle brackets so JSX survives");
  assert.match(fence[0], /\.slice\(0, 200\)/, "must bound the preserved code");
  assert.doesNotMatch(workflow, /\.replace\(\/```\[\\s\\S\]\*\?```\/g, " "\)/, "must not drop fenced code to blank");
});

test("review-thread guard inline STOP set keeps negation tokens (no/not/cannot)", () => {
  // Dropping negations makes a prohibition and its opposite recommendation look
  // identical and false-merge (codex P2). Mirrors STOPWORDS in review-dedup.mjs.
  const workflow = readFileSync(".github/workflows/review-thread-guard.yml", "utf8");
  const stop = workflow.match(/const STOP = new Set\(\s*"([^"]*)"/);
  assert.ok(stop, "STOP set literal must exist");
  const words = new Set(stop[1].split(" "));
  for (const neg of ["no", "not", "cannot"]) {
    assert.ok(!words.has(neg), `STOP must not contain the negation "${neg}"`);
  }
});

test("review-thread guard inline boilerplate strip is footer-anchored, not any mention", () => {
  // A real finding line that merely mentions a footer phrase must survive; only
  // lines that START (after markup/emoji/HTML) with a footer phrase are stripped
  // (codex P2). Mirrors FEEDBACK_BOILERPLATE_PATTERN in review-dedup.mjs.
  const workflow = readFileSync(".github/workflows/review-thread-guard.yml", "utf8");
  assert.match(
    workflow,
    /\.replace\(\/\^\(\?:<\[\^>\]\*>\|\[\^A-Za-z\\n<\]\)\*\(\?:was this/,
    "boilerplate strip must be footer-anchored and use the ReDoS-safe disjoint class ([^A-Za-z\\n<])",
  );
  assert.doesNotMatch(
    workflow,
    /\.replace\(\/\^\.\*\\b\(\?:was this/,
    "must not strip any line merely containing a footer phrase",
  );
});

test("review-thread guard inline applies the directional-opposite dedup guard", () => {
  // Identical token set in reversed order must not fold; the guard cross-checks
  // an ordered bigram similarity (codex P2). Mirrors review-dedup.mjs.
  const workflow = readFileSync(".github/workflows/review-thread-guard.yml", "utf8");
  assert.match(workflow, /directionalSetMin:\s*0\.9/, "DEDUP must define directionalSetMin");
  assert.match(workflow, /directionalOrderMax:\s*0\.1/, "DEDUP must define directionalOrderMax");
  assert.match(workflow, /const orderSim = similarity\(body, c\.body, 2\);/, "must compute the ordered bigram similarity");
  assert.match(
    workflow,
    /if \(reversedOrder \|\| directionalOperandsSwapped\(body, c\.body\)\) continue;/,
    "must skip folding reversed-order or swapped-operand directional candidates",
  );
});

test("review-thread guard inline mirrors the directional operand-swap detector", () => {
  // "X instead of Y" vs "Y instead of X" (even with shared context) must not
  // fold; mirrors directionalOperandsSwapped in review-dedup.mjs.
  const workflow = readFileSync(".github/workflows/review-thread-guard.yml", "utf8");
  assert.match(workflow, /const DIRECTIONAL_MARKERS = new Set\(\["instead", "rather"\]\);/);
  assert.match(workflow, /const directionalOperandsSwapped =/);
  assert.match(
    workflow,
    /return oa\.before !== oa\.after && oa\.before === ob\.after && oa\.after === ob\.before;/,
    "operand-swap detection must compare reversed operands",
  );
});

test("review-thread guard inline expands contracted negations", () => {
  // can't/won't/n't must expand so the negation survives tokenizing (codex P2).
  const workflow = readFileSync(".github/workflows/review-thread-guard.yml", "utf8");
  assert.match(workflow, /\.replace\(\/\\bcan\['’\]t\\b\/g, "can not"\)/);
  assert.match(workflow, /\.replace\(\/\(\\w\+\?\)n\['’\]t\\b\/g, "\$1 not"\)/);
});
