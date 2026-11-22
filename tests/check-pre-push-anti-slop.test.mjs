// check:pre-push must run the scoped anti-slop gate against the merge-base
// (#3616). PR 3645 added chained type assertions on new lines; check:pre-push
// passed locally because it never ran scripts/check-anti-slop.mjs, and CI's
// lint job then failed. This builds a throwaway branch in a temporary git
// worktree and runs the real pre-push step on it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function prePushOnBranch(source) {
  const dir = mkdtempSync(join(tmpdir(), "remnic-pre-push-anti-slop-"));
  const tree = join(dir, "tree");
  git(repoRoot, ["worktree", "add", "--detach", tree, "HEAD"]);
  try {
    symlinkSync(join(repoRoot, "node_modules"), join(tree, "node_modules"), "dir");
    const hasIdentity = spawnSync("git", ["-C", tree, "config", "user.email"], { encoding: "utf8" }).stdout.trim() !== "";
    const identity = hasIdentity ? [] : ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid"];
    // The gate scripts as they are in this checkout (uncommitted edits included).
    for (const script of ["scripts/check-pre-push.mjs", "scripts/check-anti-slop.mjs"]) {
      copyFileSync(join(repoRoot, script), join(tree, script));
    }
    git(tree, ["add", "scripts"]);
    git(tree, [...identity, "commit", "-q", "--allow-empty", "-m", "base"]);
    const base = git(tree, ["rev-parse", "HEAD"]);
    mkdirSync(join(tree, "packages", "remnic-core", "src"), { recursive: true });
    writeFileSync(join(tree, "packages", "remnic-core", "src", "pre-push-anti-slop-fixture.ts"), source);
    git(tree, ["add", "packages/remnic-core/src/pre-push-anti-slop-fixture.ts"]);
    git(tree, [...identity, "commit", "-q", "-m", "fixture"]);
    return spawnSync(process.execPath, ["scripts/check-pre-push.mjs"], {
      cwd: tree,
      encoding: "utf8",
      env: { ...process.env, REMNIC_PRE_PUSH_ONLY: "scoped anti-slop", REMNIC_PRE_PUSH_BASE_REF: base, REMNIC_ANTI_SLOP_BASE_REF: "" },
    });
  } finally {
    git(repoRoot, ["worktree", "remove", "--force", tree]);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("check:pre-push fails a branch that adds a chained type assertion (#3616)", () => {
  const result = prePushOnBranch("export function f(value: number): string {\n  return (value as unknown) as string;\n}\n");
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /scoped anti-slop/);
  assert.match(output, /no-chained-type-assertions/);
});

test("check:pre-push passes the same branch shape without the assertion (#3616)", () => {
  const result = prePushOnBranch("export function f(value: number): string {\n  return String(value);\n}\n");
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
