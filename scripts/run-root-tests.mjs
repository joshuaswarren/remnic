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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { ensurePackageBuild } from "./build-staleness.mjs";
import { appendNodeOption } from "./root-test-runner-env.mjs";
import {
  chunkArgsByLength,
  expandTestPatterns,
  loadNativeManifest,
  parseRunnerArgs,
  parseTapSummary,
  partitionNativeDependent,
  probeBetterSqlite3,
  selectTestPatterns,
  selectTestShard,
} from "./root-test-runner-lib.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(repoRoot, "scripts", "native-dependent-tests.json");
const tsxBin = process.platform === "win32" ? "tsx.cmd" : "tsx";

// Resolve tsx regardless of how this script was launched: `node scripts/…`
// has no package-manager PATH injection (unlike `pnpm test`), so prepend the
// workspace bin dir explicitly. Fixes `spawn tsx ENOENT` under bare node.
const workspaceBinDir = join(repoRoot, "node_modules", ".bin");
process.env.PATH = `${workspaceBinDir}${path.delimiter}${process.env.PATH ?? ""}`;

process.env.NODE_OPTIONS = appendNodeOption(
  process.env.NODE_OPTIONS,
  "--conditions=remnic-source",
);

// Sandbox TMPDIR for this run (#2083). os.tmpdir() reads TMPDIR/TMP/TEMP on
// each call and child test processes inherit process.env, so pointing all
// three at one per-run scratch dir makes every test's temp directory land
// inside it. A single cleanup then reclaims them all, so leaked per-test dirs
// cannot accumulate in the shared /tmp across runs and exhaust inodes on
// long-lived (self-hosted) runners. The scratch dir is created via the current
// tmpdir() BEFORE the override so it is not nested under itself. The prefix is
// deliberately short: one test binds an AF_UNIX socket under os.tmpdir(), and
// its path must stay within the ~107-byte sun_path limit even with this extra
// nesting level.
const testRunScratchDir = mkdtempSync(join(tmpdir(), "rt-"));
process.env.TMPDIR = testRunScratchDir;
process.env.TMP = testRunScratchDir;
process.env.TEMP = testRunScratchDir;
let testRunScratchCleaned = false;
function cleanupTestRunScratchDir() {
  if (testRunScratchCleaned) return;
  testRunScratchCleaned = true;
  try {
    rmSync(testRunScratchDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup — never mask the run's real exit status.
  }
}
// Normal termination emits `exit`; a signal (CI cancel/timeout, Ctrl-C) does
// NOT, so clean up in the signal handler too, then re-raise with the default
// disposition so the parent still observes the real signal termination.
process.on("exit", cleanupTestRunScratchDir);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    cleanupTestRunScratchDir();
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  });
}

let selectedGroups;
let selectedPatterns;
let selectedShard;
try {
  ({ groups: selectedGroups, shard: selectedShard } = parseRunnerArgs(process.argv.slice(2)));
  selectedPatterns = selectTestPatterns(selectedGroups);
} catch (error) {
  console.error(`[root-tests] ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
if (selectedGroups.length > 0) {
  console.warn(
    `[root-tests] running pattern group(s): ${selectedGroups.join(", ")} (${selectedPatterns.length} pattern(s))`,
  );
}

const { files: expandedFiles, emptyPatterns } = expandTestPatterns(repoRoot, selectedPatterns);
if (emptyPatterns.length > 0) {
  console.error(
    `[root-tests] ERROR: test pattern(s) matched no files — coverage would be silently lost: ${emptyPatterns.join(", ")}`,
  );
  process.exit(1);
}
let files = expandedFiles;
if (selectedShard !== null) {
  try {
    files = selectTestShard(files, selectedShard);
  } catch (error) {
    console.error(`[root-tests] ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  console.warn(
    `[root-tests] running file shard ${selectedShard.index}/${selectedShard.total} (${files.length}/${expandedFiles.length} file(s))`,
  );
}

// Tests under packages/remnic-cli load @remnic/bench through the CLI's
// optional-bench loader (packages/remnic-cli/src/optional-bench.ts). When
// bench/dist is absent that loader falls back to tsx/esm/api's tsImport,
// whose scoped-loader registration poisons subsequent dynamic .ts imports
// in the same process — so tests/remnic-cli-dataset-resolution.test.ts
// fails on a fresh clone that never built bench (#1609). Ensure bench dist
// exists here so the fallback never fires in the test path. This makes the
// runner self-sufficient: `pnpm test` and a direct
// `node scripts/run-root-tests.mjs` both work without a prior
// `check-types`/`build` side-effect. Idempotent — skips instantly when dist
// exists and no source is newer.
ensurePackageBuild(
  repoRoot,
  "@remnic/bench",
  join(repoRoot, "packages", "bench", "dist", "index.js"),
  [
    join(repoRoot, "packages", "bench", "src"),
    join(repoRoot, "packages", "bench", "package.json"),
    join(repoRoot, "packages", "bench", "tsup.config.ts"),
    join(repoRoot, "packages", "bench", "tsconfig.json"),
  ],
);
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
  // Under --group sharding `files` is a subset of the tree, so manifest
  // entries belonging to other groups are not stale — validate staleness
  // against the full pattern expansion before failing.
  let staleEntries = stale;
  if ((selectedGroups.length > 0 || selectedShard !== null) && stale.length > 0) {
    const fullFiles = new Set(expandTestPatterns(repoRoot).files);
    staleEntries = stale.filter((entry) => !fullFiles.has(entry));
  }
  if (staleEntries.length > 0) {
    console.error(
      `[root-tests] ERROR: scripts/native-dependent-tests.json lists files that no longer exist: ${staleEntries.join(", ")}. Update the manifest.`,
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

/** Run one tsx --test invocation, streaming output and parsing its TAP epilogue. */
function runTsx(testArgs) {
  return new Promise((resolve) => {
    const child = spawn(tsxBin, ["--test", ...testArgs], {
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
      resolve({ status: 1, summary: null });
    });

    child.on("close", (status) => {
      resolve({ status: status ?? 1, summary: parseTapSummary(tail) });
    });
  });
}

// Windows builds a single bounded command line per spawn, so hundreds of
// explicit file arguments cannot ride one invocation. Healthy runs therefore
// pass the selected pattern arguments (tsx expands them internally, and
// expandTestPatterns above already proved none are vacuous); only exclusion
// runs pass explicit relative paths, chunked under a conservative budget.
const ARGV_CHAR_BUDGET = 6000;
const runsArgs =
  selectedShard === null && filesToRun.length === files.length
    ? [selectedPatterns.map((pattern) => pattern.id)]
    : chunkArgsByLength(filesToRun, ARGV_CHAR_BUDGET);

let totalFail = 0;
let worstStatus = 0;
for (const [index, args] of runsArgs.entries()) {
  if (runsArgs.length > 1) {
    console.warn(`[root-tests] chunk ${index + 1}/${runsArgs.length} (${args.length} file(s))`);
  }
  const { status, summary } = await runTsx(args);
  if (summary === null) {
    console.error("[root-tests] ERROR: no TAP summary found in test output — treating as failure.");
    process.exit(status === 0 ? 1 : status);
  }
  totalFail += summary.fail;
  if (status !== 0) worstStatus = status;
}

if (totalFail > 0 && worstStatus === 0) {
  console.error(
    `[root-tests] ERROR: runner exited 0 but TAP reports ${totalFail} failing test(s) — failing the run.`,
  );
  process.exit(1);
}
if (filesToRun.length !== files.length) {
  console.warn(
    `[root-tests] reminder: ${files.length - filesToRun.length} native-dependent file(s) were skipped this run.`,
  );
}
process.exit(worstStatus);
