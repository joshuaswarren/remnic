import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts", "dev-worktree.sh");
const worktreeDiscipline =
  "Verify `pwd` before every write; use absolute paths rooted at this worktree; NEVER write to the main checkout or sibling worktrees; agent file tools may ignore cwd.";

function git(...args) {
  return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" }).trim();
}

function runScript(args, env, script = scriptPath) {
  return spawnSync("bash", [script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function createFakeNpm() {
  const root = mkdtempSync(path.join(os.tmpdir(), "remnic-dev-worktree-npm-"));
  const bin = path.join(root, "bin");
  const log = path.join(root, "npm.log");
  mkdirSync(bin);
  const npm = path.join(bin, "npm");
  writeFileSync(
    npm,
    String.raw`#!/bin/sh
printf '%s\n' "$*" >> "$DEV_WORKTREE_TEST_LOG"
if [ "$*" = "$DEV_WORKTREE_TEST_FAIL_ON" ]; then exit 1; fi
`
  );
  chmodSync(npm, 0o755);
  return { root, bin, log };
}

function cleanupWorktree(worktreePath, branch, root = repoRoot) {
  if (existsSync(worktreePath)) {
    execFileSync("git", ["-C", root, "worktree", "remove", "--force", worktreePath]);
  }
  const branchExists = spawnSync("git", ["-C", root, "show-ref", "--verify", `refs/heads/${branch}`]).status === 0;
  if (branchExists) {
    execFileSync("git", ["-C", root, "branch", "-D", branch], { stdio: "ignore" });
  }
}

test("creates an installed worktree and runs the smoke check at an absolute path", () => {
  const fixture = createFakeNpm();
  const worktreePath = path.join(fixture.root, "absolute-worktree");
  const branch = `test/dev-worktree-${process.pid}-absolute`;

  try {
    const result = runScript([worktreePath, branch, "HEAD"], {
      DEV_WORKTREE_TEST_LOG: fixture.log,
      PATH: `${fixture.bin}${path.delimiter}${process.env.PATH ?? ""}`,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(git("-C", worktreePath, "branch", "--show-current"), branch);
    assert.equal(existsSync(path.join(worktreePath, ".claude", "napkin.md")), true);
    const napkin = readFileSync(path.join(worktreePath, ".claude", "napkin.md"), "utf8");
    assert.ok(napkin.includes(`## Worktree Discipline\n${worktreeDiscipline}`));
    assert.ok(result.stdout.includes(`Worktree discipline: ${worktreeDiscipline}`));
    assert.match(result.stdout, /Worktree ready/);
    assert.match(result.stdout, new RegExp(`Next steps[\\s\\S]*${branch}`));
    const calls = readFileSync(fixture.log, "utf8");
    assert.match(calls, /exec --yes pnpm@10\.32\.1 -- install --frozen-lockfile/);
    assert.match(calls, /exec --yes pnpm@10\.32\.1 -- --filter @remnic\/core run check-types/);
  } finally {
    cleanupWorktree(worktreePath, branch);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("seeds worktree discipline when the source napkin is absent", () => {
  const fixture = createFakeNpm();
  const isolatedRoot = mkdtempSync(path.join(os.tmpdir(), "remnic-dev-worktree-repo-"));
  const isolatedScripts = path.join(isolatedRoot, "scripts");
  const isolatedScript = path.join(isolatedScripts, "dev-worktree.sh");
  const worktreePath = path.join(fixture.root, "fresh-napkin-worktree");
  const branch = `test/dev-worktree-${process.pid}-fresh-napkin`;
  mkdirSync(isolatedScripts);
  copyFileSync(scriptPath, isolatedScript);
  chmodSync(isolatedScript, 0o755);
  execFileSync("git", ["-C", isolatedRoot, "init", "--initial-branch=main"], { stdio: "ignore" });
  writeFileSync(path.join(isolatedRoot, "README.md"), "test repository\n");
  execFileSync("git", ["-C", isolatedRoot, "add", "README.md"]);
  execFileSync(
    "git",
    ["-C", isolatedRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "initial"],
    { stdio: "ignore" }
  );

  try {
    const result = runScript(
      [worktreePath, branch, "HEAD"],
      {
        DEV_WORKTREE_TEST_LOG: fixture.log,
        PATH: `${fixture.bin}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      isolatedScript
    );

    assert.equal(result.status, 0, result.stderr);
    assert.ok(readFileSync(path.join(worktreePath, ".claude", "napkin.md"), "utf8").includes(`## Worktree Discipline\n${worktreeDiscipline}`));
    assert.ok(result.stdout.includes(`Worktree discipline: ${worktreeDiscipline}`));
  } finally {
    try {
      cleanupWorktree(worktreePath, branch, isolatedRoot);
    } finally {
      rmSync(isolatedRoot, { recursive: true, force: true });
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("removes the worktree when package installation fails", () => {
  const fixture = createFakeNpm();
  const worktreePath = path.join(fixture.root, "failed-install");
  const branch = `test/dev-worktree-${process.pid}-failed-install`;

  try {
    const result = runScript([worktreePath, branch, "HEAD"], {
      DEV_WORKTREE_TEST_LOG: fixture.log,
      DEV_WORKTREE_TEST_FAIL_ON: "exec --yes pnpm@10.32.1 -- install --frozen-lockfile",
      PATH: `${fixture.bin}${path.delimiter}${process.env.PATH ?? ""}`,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Package install failed; removed worktree/);
    assert.equal(existsSync(worktreePath), false);
    assert.notEqual(spawnSync("git", ["-C", repoRoot, "show-ref", "--verify", `refs/heads/${branch}`]).status, 0);
  } finally {
    cleanupWorktree(worktreePath, branch);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
test("cleans up when worktree creation fails after creating its branch", () => {
  const fixture = createFakeNpm();
  const worktreePath = path.join(fixture.root, "failed-checkout");
  const branch = `test/dev-worktree-${process.pid}-failed-checkout`;
  const hooksPath = path.join(fixture.root, "hooks");
  mkdirSync(hooksPath);
  const postCheckout = path.join(hooksPath, "post-checkout");
  writeFileSync(postCheckout, "#!/bin/sh\nexit 7\n");
  chmodSync(postCheckout, 0o755);

  try {
    const result = runScript([worktreePath, branch, "HEAD"], {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: hooksPath,
      PATH: `${fixture.bin}${path.delimiter}${process.env.PATH ?? ""}`,
    });

    assert.notEqual(result.status, 0);
    assert.equal(existsSync(worktreePath), false);
    assert.notEqual(spawnSync("git", ["-C", repoRoot, "show-ref", "--verify", `refs/heads/${branch}`]).status, 0);
  } finally {
    cleanupWorktree(worktreePath, branch);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
test("refuses a registered worktree whose directory is missing", () => {
  const fixture = createFakeNpm();
  const worktreePath = path.join(fixture.root, "registered-worktree");
  const existingBranch = `test/dev-worktree-${process.pid}-registered`;
  const requestedBranch = `test/dev-worktree-${process.pid}-registered-retry`;
  execFileSync("git", ["-C", repoRoot, "worktree", "add", "-b", existingBranch, worktreePath, "HEAD"]);
  rmSync(worktreePath, { recursive: true, force: true });

  try {
    const result = runScript([worktreePath, requestedBranch, "HEAD"], {
      DEV_WORKTREE_TEST_LOG: fixture.log,
      PATH: `${fixture.bin}${path.delimiter}${process.env.PATH ?? ""}`,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /registered worktree path/);
    assert.notEqual(
      spawnSync("git", ["-C", repoRoot, "show-ref", "--verify", `refs/heads/${requestedBranch}`]).status,
      0
    );
  } finally {
    execFileSync("git", ["-C", repoRoot, "worktree", "remove", "--force", worktreePath], { stdio: "ignore" });
    cleanupWorktree(worktreePath, existingBranch);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("resolves a relative worktree path from the invoking checkout", () => {
  const fixture = createFakeNpm();
  const worktreePath = path.join(fixture.root, "relative-worktree");
  const relativePath = path.relative(repoRoot, worktreePath);
  const branch = `test/dev-worktree-${process.pid}-relative`;

  try {
    const result = runScript([relativePath, branch, "HEAD"], {
      DEV_WORKTREE_TEST_LOG: fixture.log,
      PATH: `${fixture.bin}${path.delimiter}${process.env.PATH ?? ""}`,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(worktreePath));
  } finally {
    cleanupWorktree(worktreePath, branch);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("refuses to clobber an existing worktree path", () => {
  const fixture = createFakeNpm();
  const worktreePath = path.join(fixture.root, "already-there");
  const branch = `test/dev-worktree-${process.pid}-existing`;
  writeFileSync(worktreePath, "keep this file\n");

  try {
    const result = runScript([worktreePath, branch, "HEAD"], {
      DEV_WORKTREE_TEST_LOG: fixture.log,
      PATH: `${fixture.bin}${path.delimiter}${process.env.PATH ?? ""}`,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /existing path/);
    assert.equal(readFileSync(worktreePath, "utf8"), "keep this file\n");
    assert.equal(existsSync(fixture.log), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects an unknown base ref before creating a worktree", () => {
  const fixture = createFakeNpm();
  const worktreePath = path.join(fixture.root, "invalid-base");
  const branch = `test/dev-worktree-${process.pid}-invalid-base`;

  try {
    const result = runScript([worktreePath, branch, "refs/heads/does-not-exist"], {
      DEV_WORKTREE_TEST_LOG: fixture.log,
      PATH: `${fixture.bin}${path.delimiter}${process.env.PATH ?? ""}`,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /base ref.*not found/i);
    assert.equal(existsSync(worktreePath), false);
    assert.equal(existsSync(fixture.log), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
test("rejects checkout shorthand branch names", () => {
  const fixture = createFakeNpm();
  const worktreePath = path.join(fixture.root, "checkout-shorthand");
  const branch = "@{-1}";

  try {
    const result = runScript([worktreePath, branch, "HEAD"], {
      DEV_WORKTREE_TEST_LOG: fixture.log,
      PATH: `${fixture.bin}${path.delimiter}${process.env.PATH ?? ""}`,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid branch name/);
    assert.equal(existsSync(worktreePath), false);
    assert.equal(existsSync(fixture.log), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
