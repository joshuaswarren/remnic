#!/usr/bin/env node
/**
 * Pre-push gate: a branch name that doesn't match the expected shape is one of
 * the strongest signals that an isolated worktree wrote to the wrong path.
 * The fleet pattern is:
 *   b<n>/<issue>           — batch <n>, working on issue <issue>
 *   b<n>/<issue>-<suffix>  — same PR with a post-review cleanup pass
 *   b<n>/process-<slug>    — process/CI improvements not tied to a single issue
 *   fix/<issue>-<slug>     — one-off fix branch (allowed but rare)
 *   main                   — never pushed directly
 * Anything else gets a hard reject; we have hit multiple "agent committed to
 * an existing unrelated branch" incidents.
 */
import { execFileSync } from "node:child_process";

const PATTERNS = [
  /^b\d+\/\d+(-[\w.-]+)?$/,
  /^b\d+\/process-[\w.-]+$/,
  /^b\d+\/split-[\w.-]+$/,
  /^fix\/\d+-[\w.-]+$/,
  /^hardening\/[\w.-]+$/,
  /^refactor\/[\w.-]+$/,
  /^release\/[\w.-]+$/,
  /^docs\/[\w.-]+$/,
  /^test\/[\w.-]+$/,
];

const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"]).toString().trim();
if (PATTERNS.some((p) => p.test(branch))) {
  console.log(`[branch-shape] OK — ${branch}`);
  process.exit(0);
}
console.error(
  `[branch-shape] FAIL — "${branch}" does not match an expected pattern. ` +
    `Use b<n>/<issue>, b<n>/process-<slug>, or fix/<issue>-<slug>.`,
);
process.exit(1);
