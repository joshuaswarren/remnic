import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { buildTestSpawnPlan, resolveTsxCliPath } from "../scripts/test-spawn-plan.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("win32 plan spawns node with the tsx JS entry and no shell", () => {
  const plan = buildTestSpawnPlan({
    platform: "win32",
    execPath: "C:\\Program Files\\nodejs\\node.exe",
    tsxCliPath: "C:\\repo\\node_modules\\tsx\\dist\\cli.mjs",
    runnerArgs: ["--test-name-pattern", "foo bar"],
    files: ["tests/a.test.mjs", "tests/b.test.mjs"],
  });

  assert.equal(plan.command, "C:\\Program Files\\nodejs\\node.exe");
  assert.deepEqual(plan.args, [
    "C:\\repo\\node_modules\\tsx\\dist\\cli.mjs",
    "--test",
    "--test-name-pattern",
    "foo bar",
    "tests/a.test.mjs",
    "tests/b.test.mjs",
  ]);
  assert.equal(plan.shell, false);
});

test("posix plan spawns the tsx bin without a shell", () => {
  const plan = buildTestSpawnPlan({
    platform: "linux",
    execPath: "/usr/bin/node",
    tsxCliPath: undefined,
    runnerArgs: [],
    files: ["tests/a.test.mjs"],
  });

  assert.equal(plan.command, "tsx");
  assert.deepEqual(plan.args, ["--test", "tests/a.test.mjs"]);
  assert.equal(plan.shell, false);
});

test("darwin plan matches the posix plan", () => {
  const plan = buildTestSpawnPlan({
    platform: "darwin",
    execPath: "/usr/local/bin/node",
    tsxCliPath: undefined,
    runnerArgs: [],
    files: ["tests/a.test.mjs"],
  });

  assert.equal(plan.command, "tsx");
  assert.equal(plan.shell, false);
});

test("resolveTsxCliPath resolves the installed tsx bin entry", () => {
  const tsxCliPath = resolveTsxCliPath(repoRoot);

  const expectedSegment = ["node_modules", "tsx"].join(sep);
  assert.ok(
    tsxCliPath.includes(expectedSegment),
    `expected ${tsxCliPath} to contain ${expectedSegment}`,
  );
  assert.ok(existsSync(tsxCliPath), `expected ${tsxCliPath} to exist`);
});
