import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("review-thread guard excludes CodeQL bot review-thread authors", () => {
  const workflow = readFileSync(".github/workflows/review-thread-guard.yml", "utf8");

  assert.match(workflow, /const NON_DEDUP_LOGINS = new Set/);
  assert.match(workflow, /github-advanced-security/);
  assert.match(workflow, /github-advanced-security\[bot\]/);
  assert.match(workflow, /github-code-scanning\[bot\]/);
  assert.match(workflow, /NON_DEDUP_LOGINS\.has\(loginOf\(t\)/);
});
