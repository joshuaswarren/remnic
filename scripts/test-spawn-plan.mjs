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
 * win32: spawn node directly against the tsx JS entry with `shell: false` —
 * a shell would wrap the `.cmd` shim, break `testProcess.kill` signal
 * forwarding, and concatenate args unquoted.
 * POSIX: keep spawning the `tsx` bin (resolved from the workspace `.bin`
 * via PATH), also without a shell.
 */
export function buildTestSpawnPlan({ platform, execPath, tsxCliPath, runnerArgs, files }) {
  const args = ["--test", ...runnerArgs, ...files];
  if (platform === "win32") {
    return {
      command: execPath,
      args: [tsxCliPath, ...args],
      shell: false,
    };
  }
  return {
    command: "tsx",
    args,
    shell: false,
  };
}
