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
