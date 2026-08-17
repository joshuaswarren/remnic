// Stale closed-issue claim detector (parallel-run defect, 2026-08).
//
// A PR whose body claims `Fixes #N` for an issue that is ALREADY closed, with
// a base far behind main, is a revert bomb: the three-dot diff looks like the
// fix, but a two-dot diff against current main deletes every commit that
// landed after the issue closed. Rebase before review, or re-verify the issue
// is really the same defect.
//
// Pure evaluator (unit-tested); the review-thread-guard workflow job
// `closed-issue-base` feeds it GitHub API data. The module is also runnable:
// pipe the same JSON object to stdin for a local check.

import path from "node:path";
import { fileURLToPath } from "node:url";

// GitHub closing-keyword family. Requires whitespace between keyword and #N so
// cross-repo forms like `Fixes owner/repo#1` are NOT matched.
const FIX_KEYWORD_PATTERN = /\b(?:fix(?:es|ed)?|clos(?:es|ed)?|resolv(?:es|ed)?)\s+#(\d+)/gi;

/** Issue numbers referenced by a closing keyword in a PR body. */
export function parseFixNumbers(body) {
  const text = typeof body === "string" ? body : "";
  const numbers = [];
  for (const match of text.matchAll(FIX_KEYWORD_PATTERN)) {
    const n = Number.parseInt(match[1], 10);
    if (Number.isInteger(n) && n > 0 && !numbers.includes(n)) numbers.push(n);
  }
  return numbers;
}

// A base this far behind main makes a closed-issue claim stale enough to fail.
export const STALE_BASE_COMMIT_THRESHOLD = 15;

/**
 * Verdict on a PR's closed-issue claims against its base staleness.
 *
 * @param {{body: string, commitsBehindMain: number, closedFixNumbers: number[]}} input
 * @returns {{ok: boolean, reason: string, staleFixNumbers: number[], commitsBehindMain: number}}
 */
export function evaluateClosedIssueBase(input) {
  const body = typeof input?.body === "string" ? input.body : "";
  const behind = Number.isFinite(input?.commitsBehindMain) ? input.commitsBehindMain : 0;
  const closed = Array.isArray(input?.closedFixNumbers) ? input.closedFixNumbers : [];

  const fixNumbers = parseFixNumbers(body);
  const staleFixNumbers = fixNumbers.filter((n) => closed.includes(n));

  if (staleFixNumbers.length > 0 && behind >= STALE_BASE_COMMIT_THRESHOLD) {
    return {
      ok: false,
      reason: `PR claims ${staleFixNumbers.map((n) => `#${n}`).join(", ")} which ${staleFixNumbers.length === 1 ? "is" : "are"} already closed, and the base is ${behind} commits behind main (>= ${STALE_BASE_COMMIT_THRESHOLD}). The three-dot diff looks like the fix, but merging would delete commits that landed after the issue closed. Rebase onto main first.`,
      staleFixNumbers,
      commitsBehindMain: behind,
    };
  }
  return {
    ok: true,
    reason:
      staleFixNumbers.length > 0
        ? `closed-issue claims ${staleFixNumbers.map((n) => `#${n}`).join(", ")} with base only ${behind} commits behind main`
        : `no stale closed-issue claims (base ${behind} commits behind main)`,
    staleFixNumbers,
    commitsBehindMain: behind,
  };
}

// CLI: `echo '{"body": "...", "commitsBehindMain": 18, "closedFixNumbers": [2454]}' | node scripts/check-closed-issue-base.mjs`
const isDirectExecution =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  let raw = "";
  process.stdin.on("data", (chunk) => {
    raw += chunk;
  });
  process.stdin.on("end", () => {
    try {
      const verdict = evaluateClosedIssueBase(JSON.parse(raw));
      console.log(verdict.reason);
      process.exitCode = verdict.ok ? 0 : 1;
    } catch (error) {
      console.error(`check-closed-issue-base: stdin must be the evaluator's JSON input: ${error.message}`);
      process.exitCode = 2;
    }
  });
}
