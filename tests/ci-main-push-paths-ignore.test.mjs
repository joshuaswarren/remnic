import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isIgnoredPath } from "../scripts/effective-diff.mjs";
import {
  CI_MAIN_PUSH_PATHS_IGNORE,
  RELEASE_MAIN_PUSH_PATHS_IGNORE,
  isShippedMarkdown,
} from "../scripts/ci-main-push-paths-ignore.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function pathsIgnoreFromWorkflow(relPath) {
  const yaml = readFileSync(resolve(rootDir, relPath), "utf8");
  const block = yaml.match(/\n    paths-ignore:\n((?:      - "[^"]+"\n)+)/);
  assert.ok(block, `${relPath} must define push.paths-ignore`);
  return block[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(3, -1));
}

assert.deepEqual(pathsIgnoreFromWorkflow(".github/workflows/ci.yml"), CI_MAIN_PUSH_PATHS_IGNORE);
assert.deepEqual(
  pathsIgnoreFromWorkflow(".github/workflows/release-and-publish.yml"),
  RELEASE_MAIN_PUSH_PATHS_IGNORE,
);
for (const pattern of [...CI_MAIN_PUSH_PATHS_IGNORE, ...RELEASE_MAIN_PUSH_PATHS_IGNORE]) {
  assert.notEqual(pattern, "**.md");
}

const listed = spawnSync("git", ["ls-files", "-z"], { cwd: rootDir });
assert.equal(listed.status, 0);
const files = listed.stdout.toString("utf8").split("\0").filter(Boolean);
const shipped = files.filter(isShippedMarkdown);
const blocked = shipped.filter((path) => isIgnoredPath(path, CI_MAIN_PUSH_PATHS_IGNORE));
assert.deepEqual(blocked, [], blocked.slice(0, 30).join("\n"));

console.log(`ci-main-push-paths-ignore passed (${shipped.length} shipped .md)`);
