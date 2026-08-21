import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

/**
 * Resolve the tsx CLI JS entry inside the workspace's installed tsx package.
 * Reading the `bin` field keeps this stable across tsx layout changes and
 * avoids the `.cmd` shim, which requires a shell to execute on Windows.
 */
export function resolveTsxCliPath(repoRoot) {
  const requireFromRoot = createRequire(join(repoRoot, "package.json"));
  const pkgPath = requireFromRoot.resolve("tsx/package.json");
  const bin = JSON.parse(readFileSync(pkgPath, "utf8")).bin;
  const binPath = typeof bin === "string" ? bin : bin?.tsx;
  if (!binPath) {
    throw new Error(`tsx package at ${dirname(pkgPath)} declares no bin entry`);
  }
  return resolve(dirname(pkgPath), binPath);
}

/**
 * Build the spawn plan for the root test runner.
 *
 * Both platforms spawn node directly against the tsx JS entry with
 * `shell: false`. On win32 a shell would wrap the `.cmd` shim, break
 * `testProcess.kill` signal forwarding, and concatenate args unquoted.
 *
 * POSIX used to spawn the bare `tsx` bin and rely on PATH. That failed with
 * an opaque `spawn tsx ENOENT` in any worktree whose root `node_modules/.bin`
 * was absent or incomplete — the error named neither the missing package nor
 * the fix. Resolving the entry explicitly turns that into either a working
 * run or the actionable message below.
 *
 * `tsxCliPath` stays an accepted override so callers (and the unit tests) can
 * pin a path; when omitted it is resolved from `repoRoot`.
 */
export function buildTestSpawnPlan({ platform, execPath, tsxCliPath, repoRoot, runnerArgs, files }) {
  const args = ["--test", ...runnerArgs, ...files];
  let cliPath = tsxCliPath;
  if (!cliPath) {
    if (!repoRoot) {
      throw new Error("buildTestSpawnPlan requires tsxCliPath or repoRoot to locate the tsx CLI");
    }
    try {
      cliPath = resolveTsxCliPath(repoRoot);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `cannot locate the tsx CLI from ${repoRoot}: ${reason}\n` +
          "Install workspace dependencies first (node scripts/pnpm.mjs install), " +
          "or create the worktree with scripts/dev-worktree.sh, which installs them.",
      );
    }
  }
  return {
    command: execPath,
    args: [cliPath, ...args],
    shell: false,
  };
}
