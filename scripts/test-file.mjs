import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { isAnySourceNewerThan } from "./build-staleness.mjs";
import { appendNodeOption } from "./root-test-runner-env.mjs";
import { buildTestSpawnPlan, resolveTsxCliPath } from "./test-spawn-plan.mjs";
import { shouldBuildBench } from "./test-file-deps.mjs";
import {
  loadNativeManifest,
  partitionNativeDependent,
  probeBetterSqlite3,
} from "./root-test-runner-lib.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const rawArgs = process.argv.slice(2);
const separatorIndex = rawArgs.indexOf("--");
const fileArgs = separatorIndex === -1 ? rawArgs : rawArgs.slice(0, separatorIndex);
const runnerArgs = separatorIndex === -1 ? [] : rawArgs.slice(separatorIndex + 1);

if (fileArgs.length === 0) {
  console.error("Usage: npm run test:file -- <test-file> [...test-files] [-- <tsx-args>]");
  process.exit(1);
}

const files = fileArgs.map((fileArg) => {
  const filePath = isAbsolute(fileArg) ? fileArg : resolve(process.cwd(), fileArg);
  if (!existsSync(filePath)) {
    console.error(`Test file not found: ${fileArg}`);
    process.exit(1);
  }
  if (!statSync(filePath).isFile()) {
    console.error(`Test path is not a file: ${fileArg}`);
    process.exit(1);
  }
  return filePath;
});

function ensureBuild(pkgName, distPath, sourcePaths) {
  if (existsSync(distPath) && !isAnySourceNewerThan(sourcePaths, distPath)) return;
  const build = spawnSync(
    process.execPath,
    [join(repoRoot, "scripts", "pnpm.mjs"), "--filter", pkgName, "build"],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (build.status !== 0) process.exit(build.status ?? 1);
}

ensureBuild(
  "@remnic/core",
  join(repoRoot, "packages", "remnic-core", "dist", "index.js"),
  [
    join(repoRoot, "packages", "remnic-core", "src"),
    join(repoRoot, "packages", "remnic-core", "package.json"),
    join(repoRoot, "packages", "remnic-core", "tsup.config.ts"),
    join(repoRoot, "packages", "remnic-core", "tsconfig.json"),
  ],
);

if (shouldBuildBench(files)) {
  ensureBuild(
    "@remnic/bench",
    join(repoRoot, "packages", "bench", "dist", "index.js"),
    [
      join(repoRoot, "packages", "bench", "src"),
      join(repoRoot, "packages", "bench", "package.json"),
      join(repoRoot, "packages", "bench", "tsup.config.ts"),
      join(repoRoot, "packages", "bench", "tsconfig.json"),
    ],
  );
}

let filesToRun = files;
let nativeProbe = probeBetterSqlite3(repoRoot);
if (!nativeProbe.ok) {
  console.warn(`[test-file] better-sqlite3 binding unavailable: ${nativeProbe.reason}`);
  const heal = spawnSync(process.execPath, [join(repoRoot, "scripts", "ensure-better-sqlite3.mjs")], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (heal.status === 0) nativeProbe = probeBetterSqlite3(repoRoot);
}

if (!nativeProbe.ok) {
  if (process.env.REMNIC_REQUIRE_NATIVE_TESTS === "1") {
    console.error(
      `[test-file] ERROR: better-sqlite3 binding unavailable (${nativeProbe.reason}) and ` +
        "REMNIC_REQUIRE_NATIVE_TESTS=1 forbids skipping native-dependent tests.",
    );
    process.exit(1);
  }
  const manifest = loadNativeManifest(join(repoRoot, "scripts", "native-dependent-tests.json"));
  const relativeFiles = files.map((file) => relative(repoRoot, file).split(sep).join("/"));
  const selectedManifest = manifest.files.filter((entry) => relativeFiles.includes(entry));
  const { run, excluded } = partitionNativeDependent(relativeFiles, selectedManifest);
  filesToRun = files.filter((_, index) => run.includes(relativeFiles[index]));
  for (const file of excluded) console.warn(`[test-file] SKIP ${file}`);
  if (filesToRun.length === 0) process.exit(0);
}

const testRunScratchDir = mkdtempSync(join(tmpdir(), "rt-"));
let testRunScratchCleaned = false;
function cleanupTestRunScratchDir() {
  if (testRunScratchCleaned) return;
  testRunScratchCleaned = true;
  try {
    rmSync(testRunScratchDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup must not mask the test result.
  }
}
process.on("exit", cleanupTestRunScratchDir);
let testProcess;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (testProcess && !testProcess.killed) testProcess.kill(signal);
    process.removeAllListeners(signal);
    cleanupTestRunScratchDir();
    process.exitCode = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[signal] ?? 1;
    process.exit(process.exitCode);
  });
}

const workspaceBinDir = join(repoRoot, "node_modules", ".bin");
const spawnPlan = buildTestSpawnPlan({
  platform: process.platform,
  execPath: process.execPath,
  tsxCliPath: process.platform === "win32" ? resolveTsxCliPath(repoRoot) : undefined,
  runnerArgs,
  files: filesToRun,
});
const result = await new Promise((resolve) => {
  testProcess = spawn(spawnPlan.command, spawnPlan.args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${workspaceBinDir}${delimiter}${process.env.PATH ?? ""}`,
      NODE_OPTIONS: appendNodeOption(process.env.NODE_OPTIONS, "--conditions=remnic-source"),
      TMPDIR: testRunScratchDir,
      TMP: testRunScratchDir,
      TEMP: testRunScratchDir,
    },
    stdio: "inherit",
    shell: spawnPlan.shell,
  });
  testProcess.on("close", (status, signal) => resolve({ status, signal }));
});

if (result.error) {
  console.error(`Failed to launch ${spawnPlan.command}: ${result.error.message}`);
  process.exit(1);
}

if (result.signal) {
  process.exitCode = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[result.signal] ?? 1;
} else {
  process.exitCode = result.status ?? 1;
}
