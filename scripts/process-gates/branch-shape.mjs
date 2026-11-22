#!/usr/bin/env node
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
