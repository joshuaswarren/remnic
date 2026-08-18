#!/usr/bin/env node
/**
 * Squash-merge via REST. Use when GraphQL merge is rate-limited (this run).
 * usage: node scripts/squash-merge-pr.mjs <n>
 */
import { spawnSync } from "node:child_process";

const pr = process.argv[2];
if (!/^\d+$/.test(pr ?? "")) {
  console.error("usage: node scripts/squash-merge-pr.mjs <pr-number>");
  process.exit(2);
}

const result = spawnSync(
  "gh",
  [
    "api",
    "-X",
    "PUT",
    `repos/{owner}/{repo}/pulls/${pr}/merge`,
    "-f",
    "merge_method=squash",
  ],
  { stdio: "inherit" },
);
process.exit(result.status === null ? 1 : result.status);
