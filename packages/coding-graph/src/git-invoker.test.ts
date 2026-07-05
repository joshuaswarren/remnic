/**
 * git-invoker tests (issue #1554 threads 13/14).
 *
 * Covers:
 *  - defaultCodingGitInvoker is a FACTORY FUNCTION (thread 13: the runtime
 *    previously treated it as an object instance and degraded to
 *    runtime_unavailable).
 *  - listTrackedFiles returns the repo's tracked files as repo-relative
 *    forward-slash paths (thread 14: the runtime sources candidatePaths for
 *    executeReindex's full-reindex branch from this method).
 *  - listTrackedFiles degrades to a tagged git failure outside a worktree.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { launchProcessSync } from "@remnic/core/runtime/child-process";

import {
  defaultCodingGitInvoker,
  type CodingGitInvoker,
} from "./git-invoker.js";

async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "git-invoker-test-"));
  const run = (args: readonly string[]) =>
    launchProcessSync("git", [...args], { cwd: dir, encoding: "utf-8", shell: false });
  run(["init", "-q"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  return dir;
}

test("defaultCodingGitInvoker is a factory function (thread 13)", () => {
  // The runtime calls defaultCodingGitInvoker() — it must be a function
  // returning the invoker, not the invoker instance itself.
  assert.equal(typeof defaultCodingGitInvoker, "function");
  const invoker = defaultCodingGitInvoker();
  assert.ok(invoker && typeof invoker === "object");
  assert.equal(typeof invoker.listTrackedFiles, "function");
  assert.equal(typeof invoker.revParseHead, "function");
});

test("listTrackedFiles: returns tracked files as repo-relative forward-slash paths (thread 14)", async () => {
  const dir = await makeTempRepo();
  try {
    // Nested file with a forward-slash path (cross-platform: use path.join to
    // create, but git stores it with forward slashes).
    await mkdir(path.join(dir, "src", "deep"), { recursive: true });
    await writeFile(path.join(dir, "src", "deep", "a.ts"), "export const a = 1;\n");
    await writeFile(path.join(dir, "root.md"), "# root\n");
    // Untracked file — must NOT appear in listTrackedFiles output.
    await writeFile(path.join(dir, "ignored.txt"), "nope\n");
    const add = launchProcessSync("git", ["add", "src/deep/a.ts", "root.md"], {
      cwd: dir,
      encoding: "utf-8",
      shell: false,
    });
    assert.equal(add.status, 0, "git add must succeed");

    const invoker: CodingGitInvoker = defaultCodingGitInvoker();
    const result = invoker.listTrackedFiles(dir);
    assert.equal(result.ok, true);
    if (result.ok) {
      // Forward-slash repo-relative paths, sorted by git's output order.
      assert.ok(result.paths.includes("src/deep/a.ts"));
      assert.ok(result.paths.includes("root.md"));
      // Untracked file excluded — this is the load-bearing assertion for the
      // candidatePaths source: only tracked files belong in an authoritative
      // full-reindex candidate set.
      assert.ok(
        !result.paths.includes("ignored.txt"),
        "listTrackedFiles must not include untracked files",
      );
      // Every path uses forward slashes (no OS-native backslashes), matching
      // the executor's repo-relative canonical-path contract.
      for (const p of result.paths) {
        assert.ok(!p.includes("\\"), `path must be forward-slash: ${p}`);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listTrackedFiles: empty repo (no tracked files) → ok:true with empty path list", async () => {
  const dir = await makeTempRepo();
  try {
    const invoker = defaultCodingGitInvoker();
    const result = invoker.listTrackedFiles(dir);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.paths.length, 0);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listTrackedFiles: non-repo directory → tagged git failure (degrades, never throws)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "git-invoker-notrepo-"));
  try {
    const invoker = defaultCodingGitInvoker();
    const result = invoker.listTrackedFiles(dir);
    // Either git_unavailable (git not on PATH) or git_error (not a worktree).
    // The contract is: never throws, always a tagged result.
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.code === "git_unavailable" || result.code === "git_error");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
