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

test("posix plan spawns node with the resolved tsx entry, not a bare PATH lookup", () => {
  const plan = buildTestSpawnPlan({
    platform: "linux",
    execPath: "/usr/bin/node",
    repoRoot,
    runnerArgs: [],
    files: ["tests/a.test.mjs"],
  });

  // Spawning the bare `tsx` bin relied on PATH and failed with an opaque
  // `spawn tsx ENOENT` in a worktree without a populated root .bin.
  assert.equal(plan.command, "/usr/bin/node");
  assert.notEqual(plan.command, "tsx");
  assert.equal(plan.args[0], resolveTsxCliPath(repoRoot));
  assert.deepEqual(plan.args.slice(1), ["--test", "tests/a.test.mjs"]);
  assert.equal(plan.shell, false);
});

test("darwin plan matches the posix plan", () => {
  const plan = buildTestSpawnPlan({
    platform: "darwin",
    execPath: "/usr/local/bin/node",
    repoRoot,
    runnerArgs: [],
    files: ["tests/a.test.mjs"],
  });

  assert.equal(plan.command, "/usr/local/bin/node");
  assert.equal(plan.args[0], resolveTsxCliPath(repoRoot));
  assert.equal(plan.shell, false);
});

test("an explicit tsxCliPath still overrides resolution on posix", () => {
  const plan = buildTestSpawnPlan({
    platform: "linux",
    execPath: "/usr/bin/node",
    tsxCliPath: "/pinned/tsx/dist/cli.mjs",
    runnerArgs: [],
    files: ["tests/a.test.mjs"],
  });

  assert.deepEqual(plan.args, ["/pinned/tsx/dist/cli.mjs", "--test", "tests/a.test.mjs"]);
});

test("an unresolvable tsx names the missing package and the install step", () => {
  assert.throws(
    () =>
      buildTestSpawnPlan({
        platform: "linux",
        execPath: "/usr/bin/node",
        repoRoot: "/nonexistent-remnic-root",
        runnerArgs: [],
        files: ["tests/a.test.mjs"],
      }),
    (error) => {
      assert.match(error.message, /cannot locate the tsx CLI/);
      assert.match(error.message, /scripts\/pnpm\.mjs install|dev-worktree\.sh/);
      return true;
    },
  );
});

test("omitting both tsxCliPath and repoRoot is a caller error", () => {
  assert.throws(
    () =>
      buildTestSpawnPlan({
        platform: "linux",
        execPath: "/usr/bin/node",
        runnerArgs: [],
        files: ["tests/a.test.mjs"],
      }),
    /requires tsxCliPath or repoRoot/,
  );
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
