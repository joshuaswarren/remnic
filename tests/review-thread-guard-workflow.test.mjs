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

test("check-unsticker folds a resolved-canonical duplicate so it can rerun the guard", () => {
  // In enforce mode a duplicate whose canonical is resolved must not count as a
  // blocker even before its audit reply exists, or the sweeper refuses the rerun
  // that posts the reply (enforce-mode deadlock, codex P2).
  const unsticker = readFileSync(".github/workflows/check-unsticker.yml", "utf8");
  assert.match(unsticker, /const resolvedById = new Map\(threads\.map\(\(t\) => \[t\.id, t\.isResolved === true\]\)\);/);
  assert.match(
    unsticker,
    /hasGateReply\(t\) \|\| resolvedById\.get\(rec\.canonicalId\) === true/,
    "duplicate must fold when audited OR its canonical is resolved",
  );
});

test("review-thread guard effectiveUnresolved folds only with resolved canonical AND audit evidence", () => {
  // A duplicate stops gating only when its canonical is resolved AND its gate
  // reply is posted; a resolved canonical without the reply keeps gating so a
  // transient reply-post failure can't silently pass enforce (codex P2).
  const workflow = readFileSync(".github/workflows/review-thread-guard.yml", "utf8");
  assert.match(
    workflow,
    /return canonicalResolved\.get\(rec\.canonicalId\) === true && !auditedDuplicateIds\.has\(rec\.id\);/,
    "effectiveUnresolved must gate a resolved-canonical duplicate until it is audited",
  );
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
  assert.match(workflow, /reversedOrder \|\|/, "match loop must skip reversed-order directional candidates");
  assert.match(
    workflow,
    /directionalOperandsSwapped\(body, c\.body\) \|\|/,
    "match loop must skip swapped-operand directional candidates",
  );
});

test("review-thread guard inline mirrors the directional operand-swap detector", () => {
  // "X instead of Y" vs "Y instead of X" (even with shared context) must not
  // fold; mirrors directionalOperandsSwapped in review-dedup.mjs.
  const workflow = readFileSync(".github/workflows/review-thread-guard.yml", "utf8");
  assert.match(workflow, /const DIRECTIONAL_MARKERS = new Set\(\["instead", "rather"\]\);/);
  assert.match(workflow, /const directionalOperandsSwapped =/);
  assert.match(workflow, /const directionalPhrases =/, "must slice operand phrases around the marker");
  assert.match(
    workflow,
    /return seqEqual\(aBefore, bAfter\) && seqEqual\(aAfter, bBefore\);/,
    "operand-swap detection must compare reversed multi-word operand phrases",
  );
});

test("review-thread guard inline expands contracted negations", () => {
  // can't/won't/n't must expand so the negation survives tokenizing (codex P2).
  const workflow = readFileSync(".github/workflows/review-thread-guard.yml", "utf8");
  assert.match(workflow, /\.replace\(\/\\bcan\['’\]t\\b\/g, "can not"\)/);
  assert.match(workflow, /\.replace\(\/\(\\w\+\?\)n\['’\]t\\b\/g, "\$1 not"\)/);
});

test("review-thread guard and unsticker anchor on diff side", () => {
  // A LEFT and a RIGHT comment on the same line are different locations and must
  // not dedupe; both the guard query/overlap and the unsticker query must carry
  // and honor diffSide (codex P2). Mirrors threadAnchor/anchorsOverlap in review-dedup.mjs.
  const guard = readFileSync(".github/workflows/review-thread-guard.yml", "utf8");
  const unsticker = readFileSync(".github/workflows/check-unsticker.yml", "utf8");
  assert.match(guard, /\bstartDiffSide\b/, "guard thread query must request startDiffSide");
  assert.match(guard, /t\.startDiffSide \?\? c\?\.startDiffSide/, "anchorOf must carry the start diff side");
  assert.match(guard, /if \(a\.side !== b\.side\) return false;/, "overlap must require the same (start:end) diff side");
  assert.match(unsticker, /\bstartDiffSide\b/, "unsticker thread query must request startDiffSide");
});

test("review-thread guard inline rejects polarity-mismatch duplicates", () => {
  // A prohibition and its affirmative on the same lines must not fold; mirrors
  // polarityMismatch in review-dedup.mjs (codex P2).
  const guard = readFileSync(".github/workflows/review-thread-guard.yml", "utf8");
  assert.match(guard, /const NEGATION_TOKENS = new Set\(\["not", "no", "cannot", "never", "none"\]\);/);
  assert.match(guard, /const polarityMismatch =/);
  assert.match(guard, /polarityMismatch\(body, c\.body\)/, "match loop must reject polarity mismatches");
});
