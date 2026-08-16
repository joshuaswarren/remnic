import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const readRepoFile = (relativePath) => readFileSync(path.join(REPO_ROOT, relativePath), "utf8");

test("review-thread guard checks out the base revision without persisting credentials", () => {
  const workflow = readRepoFile(".github/workflows/review-thread-guard.yml");
  assert.match(workflow, /uses: actions\/checkout@v4/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.sha \}\}/);
});

test("AI review gate checks out the base revision without persisting credentials", () => {
  const workflow = readRepoFile(".github/workflows/ai-review-gate.yml");
  assert.match(workflow, /uses: actions\/checkout@v4/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.sha \}\}/);
});

test("review-thread guard imports the tested dedup evaluator", () => {
  const workflow = readRepoFile(".github/workflows/review-thread-guard.yml");
  assert.match(workflow, /scripts\/review-dedup\.mjs/);
  for (const exportName of [
    "DUPLICATE_LABEL",
    "computeGuardObligations",
    "dedupeThreads",
    "formatDuplicateReply",
    "hasGateReply",
  ]) {
    assert.match(workflow, new RegExp(`\\b${exportName}\\b`), `workflow must use ${exportName}`);
  }
  assert.doesNotMatch(workflow, /const NON_DEDUP_LOGINS/);
  assert.doesNotMatch(workflow, /const isStaleCanonical/);
});

test("review-thread guard keeps dedup in shadow mode by default", () => {
  const workflow = readRepoFile(".github/workflows/review-thread-guard.yml");
  assert.match(workflow, /REVIEW_DEDUP_MODE: shadow/);
  assert.match(workflow, /const applyInheritance = mode === "enforce";/);
});

test("review-thread guard queries every field required by the shared evaluator", () => {
  const workflow = readRepoFile(".github/workflows/review-thread-guard.yml");
  for (const field of [
    "isResolved",
    "isOutdated",
    "diffSide",
    "startDiffSide",
    "line",
    "startLine",
    "originalLine",
    "originalStartLine",
    "fullDatabaseId",
  ]) {
    assert.match(workflow, new RegExp(`\\b${field}\\b`), `query must request ${field}`);
  }
  assert.doesNotMatch(workflow, /\bdatabaseId\b/, "guard must not use deprecated databaseId");
});

test("check-unsticker uses the shared dedup evaluator and complete thread fields", () => {
  const workflow = readRepoFile(".github/workflows/check-unsticker.yml");
  assert.match(workflow, /scripts\/review-dedup\.mjs/);
  assert.match(workflow, /\bisOutdated\b/);
  assert.match(workflow, /\bstartDiffSide\b/);
  assert.match(workflow, /hasGateReply\(t\) \|\| resolvedById\.get\(rec\.canonicalId\) === true/);
});

test("check-unsticker only reruns the guard when its latest run failed", () => {
  const workflow = readRepoFile(".github/workflows/check-unsticker.yml");
  assert.match(workflow, /latestFailedGuardRuns\(guardRuns\)/);
  assert.match(workflow, /effective unresolved threads are zero/);
});

test("scheduled check-unsticker runs at most one scheduler instance", () => {
  const workflow = readRepoFile(".github/workflows/check-unsticker.yml");
  assert.match(workflow, /cron: ['"]\*\/5 \* \* \* \*['"]/);
  assert.match(workflow, /group: check-unsticker/);
  assert.match(workflow, /cancel-in-progress: false/);
});

test("review-thread guard posts duplicate audit replies only in enforce mode", () => {
  const workflow = readRepoFile(".github/workflows/review-thread-guard.yml");
  assert.match(workflow, /if \(applyInheritance && dupRecords\.length > 0\)/);
  assert.match(workflow, /fullDatabaseId/);
  assert.match(workflow, /issues\.addLabels/);
});
