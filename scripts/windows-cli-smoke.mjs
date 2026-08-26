#!/usr/bin/env node
/**
 * CLI smoke check for the windows-smoke CI job (issue #3034).
 *
 * Acceptance criterion: `remnic --help` and `remnic doctor` both exit 0 when
 * run from an empty directory. Node creates and enters that directory instead
 * of the shell because RUNNER_TEMP is a backslash path on Windows, which
 * git-bash `mktemp`/`cd` mishandle — the check would then run in the repo root
 * and prove nothing.
 *
 * A non-zero exit from either command fails this script. No suppression.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliBin = path.join(repoRoot, "packages", "remnic-cli", "bin", "remnic.cjs");
const smokeDir = mkdtempSync(path.join(process.env.RUNNER_TEMP || tmpdir(), "remnic-smoke-"));

console.log(`[cli-smoke] empty working directory: ${smokeDir}`);
for (const args of [["--help"], ["doctor"]]) {
  console.log(`[cli-smoke] running: remnic ${args.join(" ")}`);
  execFileSync(process.execPath, [cliBin, ...args], { cwd: smokeDir, stdio: "inherit" });
}
console.log("[cli-smoke] OK — remnic --help and remnic doctor both exited 0");
