import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptPath = join(repoRoot, "scripts", "test-file.mjs");

function run(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

test("runs one root test file and forwards tsx arguments", () => {
  const result = run([
    "tests/root-test-runner-lib.test.mjs",
    "--",
    "--test-name-pattern",
    "selectTestPatterns with no groups",
  ]);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("reports a missing test file and exits non-zero", () => {
  const result = run(["tests/does-not-exist.test.mjs"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Test file not found: tests\/does-not-exist\.test\.mjs/);
});
