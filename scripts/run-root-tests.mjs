/**
 * Root test runner (issue #1538, epic #1520).
 *
 * Guarantees:
 *   1. Every test pattern must match at least one file — a glob silently
 *      matching nothing is an error, not a vacuous pass.
 *   2. The better-sqlite3 native binding is probed (by constructing a real
 *      database) before the run. If it is broken, the runner attempts the
 *      repo's own self-heal (scripts/ensure-better-sqlite3.mjs) once.
 *   3. If the binding still cannot load, the native-dependent test files
 *      listed in scripts/native-dependent-tests.json are excluded with a
 *      loud per-file [SKIP] — instead of ~160 guaranteed failures drowning
 *      out real regressions. With REMNIC_REQUIRE_NATIVE_TESTS=1 (CI sets
 *      this) exclusion is forbidden and a broken binding fails the run.
 *   4. Any test failure fails the run: the child's exit status is
 *      propagated AND the TAP summary is parsed as belt-and-suspenders —
 *      a missing summary or fail > 0 exits non-zero regardless.
 */

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { appendNodeOption } from "./root-test-runner-env.mjs";
import {
  expandTestPatterns,
  loadNativeManifest,
  parseTapSummary,
  partitionNativeDependent,
  probeBetterSqlite3,
} from "./root-test-runner-lib.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(repoRoot, "scripts", "native-dependent-tests.json");
const tsxBin = process.platform === "win32" ? "tsx.cmd" : "tsx";

process.env.NODE_OPTIONS = appendNodeOption(
  process.env.NODE_OPTIONS,
  "--conditions=remnic-source",
);

const { files, emptyPatterns } = expandTestPatterns(repoRoot);
if (emptyPatterns.length > 0) {
  console.error(
    `[root-tests] ERROR: test pattern(s) matched no files — coverage would be silently lost: ${emptyPatterns.join(", ")}`,
  );
  process.exit(1);
}

let filesToRun = files;
let probe = probeBetterSqlite3(repoRoot);
if (!probe.ok) {
  console.warn(`[root-tests] better-sqlite3 binding unavailable: ${probe.reason}`);
  console.warn("[root-tests] attempting self-heal via scripts/ensure-better-sqlite3.mjs ...");
  const heal = spawnSync(
    process.execPath,
    [join(repoRoot, "scripts", "ensure-better-sqlite3.mjs")],
    { cwd: repoRoot, stdio: "inherit", env: process.env },
  );
  if (heal.status === 0) {
    probe = probeBetterSqlite3(repoRoot);
  }
}

if (!probe.ok) {
  if (process.env.REMNIC_REQUIRE_NATIVE_TESTS === "1") {
    console.error(
      `[root-tests] ERROR: better-sqlite3 binding unavailable (${probe.reason}) and ` +
        "REMNIC_REQUIRE_NATIVE_TESTS=1 forbids skipping native-dependent suites.",
    );
    process.exit(1);
  }
  const manifest = loadNativeManifest(manifestPath);
  const { run, excluded, stale } = partitionNativeDependent(files, manifest.files);
  if (stale.length > 0) {
    console.error(
      `[root-tests] ERROR: scripts/native-dependent-tests.json lists files that no longer exist: ${stale.join(", ")}. Update the manifest.`,
    );
    process.exit(1);
  }
  filesToRun = run;
  console.warn(
    `[root-tests] SKIPPING ${excluded.length} native-dependent test file(s) (better-sqlite3 unavailable: ${probe.reason}):`,
  );
  for (const file of excluded) {
    console.warn(`[root-tests]   [SKIP] ${file}`);
  }
  console.warn(
    "[root-tests] restore full coverage with: pnpm rebuild better-sqlite3 (or node scripts/ensure-better-sqlite3.mjs)",
  );
}

const child = spawn(tsxBin, ["--test", ...filesToRun.map((file) => path.join(repoRoot, ...file.split("/")))], {
  cwd: repoRoot,
  env: process.env,
  stdio: ["inherit", "pipe", "inherit"],
});

// Stream stdout live while keeping a bounded tail for the TAP summary parse.
const TAIL_LIMIT = 64 * 1024;
let tail = "";
child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  tail = (tail + chunk.toString("utf-8")).slice(-TAIL_LIMIT);
});

child.on("error", (error) => {
  console.error(`[root-tests] ERROR: failed to launch ${tsxBin}: ${error.message}`);
  process.exit(1);
});

child.on("close", (status) => {
  const summary = parseTapSummary(tail);
  if (summary === null) {
    console.error("[root-tests] ERROR: no TAP summary found in test output — treating as failure.");
    process.exit(status === 0 ? 1 : (status ?? 1));
  }
  if (summary.fail > 0 && status === 0) {
    console.error(
      `[root-tests] ERROR: runner exited 0 but TAP reports ${summary.fail} failing test(s) — failing the run.`,
    );
    process.exit(1);
  }
  if (filesToRun.length !== files.length) {
    console.warn(
      `[root-tests] reminder: ${files.length - filesToRun.length} native-dependent file(s) were skipped this run.`,
    );
  }
  process.exit(status ?? 1);
});
