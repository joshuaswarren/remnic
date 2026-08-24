import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkTypePackageDirs, manifestPackageDirs, noCheckTypePackageDirs } from "../scripts/check-type-packages.mjs";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const modulePath = join(rootDir, "scripts", "check-type-packages.mjs");

const packageSpecs = [
  { name: "zzz-late-alpha", checkTypes: true },
  { name: "aaa-early-omega", checkTypes: true },
  { name: "import-like-optional", checkTypes: true },
  { name: "native-platform-shim", checkTypes: false },
  { name: "host-adapter-plain", checkTypes: false },
];

/** Build a synthetic packages/ tree; creation order, node_modules, and dist
 * output vary between the "clean CI" and "hydrated local" shapes (#2851). */
function writeWorkspace(dir, { shuffled, hydrated }) {
  const packagesDir = join(dir, "packages");
  mkdirSync(packagesDir, { recursive: true });
  const specs = shuffled ? [...packageSpecs].reverse() : packageSpecs;
  for (const spec of specs) {
    const pkgDir = join(packagesDir, spec.name);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: `@remnic/${spec.name}`,
        scripts: spec.checkTypes ? { "check-types": "tsc --noEmit" } : { build: "tsup" },
      })
    );
    if (hydrated) {
      mkdirSync(join(pkgDir, "dist"), { recursive: true });
      writeFileSync(join(pkgDir, "dist", "index.js"), "");
    }
  }
  // Non-pnpm directory (no manifest) and a stray file must be ignored.
  mkdirSync(join(packagesDir, "swift-native-helper"), { recursive: true });
  writeFileSync(join(packagesDir, "notes.md"), "");
  // Workspace contract: run mode must resolve this dir as the pnpm workspace
  // root owning packagesDir (#2873).
  writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  if (hydrated) mkdirSync(join(dir, "node_modules"), { recursive: true });
  return packagesDir;
}

const scratchRoot = mkdtempSync(join(tmpdir(), "check-type-packages-"));
try {
  const cleanDir = mkdtempSync(join(scratchRoot, "clean-"));
  const hydratedDir = mkdtempSync(join(scratchRoot, "hydrated-"));
  const cleanPackages = writeWorkspace(cleanDir, { shuffled: false, hydrated: false });
  const hydratedPackages = writeWorkspace(hydratedDir, { shuffled: true, hydrated: true });

  const expectedCovered = ["aaa-early-omega", "import-like-optional", "zzz-late-alpha"];
  const expectedNoCheckType = ["host-adapter-plain", "native-platform-shim"];

  // Enumeration is identical across clean CI and hydrated local shapes:
  // node_modules, dist output, and directory order cannot change it.
  assert.deepEqual(checkTypePackageDirs(cleanPackages), expectedCovered);
  assert.deepEqual(checkTypePackageDirs(hydratedPackages), expectedCovered);
  assert.deepEqual(noCheckTypePackageDirs(cleanPackages), expectedNoCheckType);
  assert.deepEqual(noCheckTypePackageDirs(hydratedPackages), expectedNoCheckType);
  const expectedManifests = [...expectedCovered, ...expectedNoCheckType].sort();
  assert.deepEqual(manifestPackageDirs(cleanPackages), expectedManifests);
  assert.deepEqual(manifestPackageDirs(hydratedPackages), expectedManifests);

  // Repo tree: import-weclone is covered, the no-check-type host adapters are not.
  const repoCovered = checkTypePackageDirs();
  assert.ok(repoCovered.includes("import-weclone"));
  assert.ok(!repoCovered.includes("plugin-codex"));
  assert.ok(!repoCovered.includes("plugin-claude-code"));
} finally {
  rmSync(scratchRoot, { recursive: true, force: true });
}

// --run wiring: one explicit --filter per covered package through the pinned
// pnpm wrapper — never a glob filter — with exit-code propagation. The stub
// pnpm satisfies the wrapper's pinned-version probe and records its args.
function createStubPnpm(stubBin, argsFile) {
  mkdirSync(stubBin, { recursive: true });
  const isWindows = process.platform === "win32";
  const binaryName = isWindows ? "pnpm.cmd" : "pnpm";
  const stubPath = join(stubBin, binaryName);

  if (isWindows) {
    writeFileSync(
      stubPath,
      `@echo off
if "%~1"=="--version" (
  echo 10.32.1
  exit /b 0
)
break > "${argsFile}"
for %%A in (%*) do (
  (echo %%A)>>"${argsFile}"
)
break > stub-cwd-marker
if defined STUB_EXIT (
  exit /b %STUB_EXIT%
) else (
  exit /b 0
)
`
    );
  } else {
    writeFileSync(
      stubPath,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '10.32.1\\n'
  exit 0
fi
printf '%s\\n' "$@" > "${argsFile}"
: > ./stub-cwd-marker
exit "\${STUB_EXIT:-0}"
`,
      { mode: 0o755 }
    );
    chmodSync(stubPath, 0o755);
  }
  return stubPath;
}

{
  const runDir = mkdtempSync(join(tmpdir(), "check-type-packages-run-"));
  try {
    const packagesDir = writeWorkspace(runDir, { shuffled: false, hydrated: false });
    const stubBin = join(runDir, "stub-bin");
    const argsFile = join(runDir, "args.txt");
    const stubPath = createStubPnpm(stubBin, argsFile);

    assert.ok(existsSync(stubPath), "platform-appropriate pnpm stub binary must exist");
    assert.equal(
      stubPath.endsWith(process.platform === "win32" ? "pnpm.cmd" : "pnpm"),
      true,
      "stub binary name must match platform conventions"
    );
    const run = (extraEnv) =>
      spawnSync(process.execPath, [modulePath, "--run", "--packages-dir", packagesDir], {
        cwd: runDir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${stubBin}${delimiter}${process.env.PATH ?? ""}`,
          ...extraEnv,
        },
      });

    const ok = run({});
    assert.equal(ok.status, 0, ok.stderr);
    const args = readFileSync(argsFile, "utf8").trim().split(/\r?\n/);
    assert.deepEqual(args, [
      "--recursive",
      "--if-present",
      "--filter",
      "./packages/aaa-early-omega",
      "--filter",
      "./packages/import-like-optional",
      "--filter",
      "./packages/zzz-late-alpha",
      "run",
      "check-types",
    ]);
    assert.ok(!args.some((arg) => arg.includes("*")), "glob filters are forbidden (#2851)");

    const failing = run({ STUB_EXIT: "7" });
    assert.equal(failing.status, 7, "pnpm failure must fail the sweep");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}

// #2873: --run must execute pnpm in the enumerated workspace root, not the
// caller's cwd. The caller here sits inside a DIFFERENT synthetic pnpm
// workspace with a decoy package named like a covered one — if the filters
// resolved against the caller's workspace, pnpm would run there instead.
{
  const foreignRoot = mkdtempSync(join(tmpdir(), "check-type-packages-foreign-"));
  const runDir = mkdtempSync(join(tmpdir(), "check-type-packages-cwd-"));
  try {
    writeFileSync(join(foreignRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    const decoyDir = join(foreignRoot, "packages", "aaa-early-omega");
    mkdirSync(decoyDir, { recursive: true });
    writeFileSync(
      join(decoyDir, "package.json"),
      JSON.stringify({ name: "@caller/decoy", scripts: { "check-types": "tsc --noEmit" } })
    );

    const packagesDir = writeWorkspace(runDir, { shuffled: false, hydrated: false });
    const stubBin = join(runDir, "stub-bin");
    const argsFile = join(runDir, "args.txt");
    createStubPnpm(stubBin, argsFile);

    const result = spawnSync(process.execPath, [modulePath, "--run", "--packages-dir", packagesDir], {
      cwd: foreignRoot,
      encoding: "utf8",
      env: { ...process.env, PATH: `${stubBin}${delimiter}${process.env.PATH ?? ""}` },
    });
    assert.equal(result.status, 0, result.stderr);
    // pnpm ran in the enumerated workspace root: the stub's relative cwd
    // marker landed there, and in neither the caller's root nor its packages.
    assert.ok(
      existsSync(join(runDir, "stub-cwd-marker")),
      "pnpm cwd must be the enumerated workspace root (#2873)"
    );
    assert.ok(!existsSync(join(foreignRoot, "stub-cwd-marker")), "caller workspace must not be filtered");
    assert.ok(
      !existsSync(join(foreignRoot, "packages", "stub-cwd-marker")),
      "caller workspace packages must not be filtered"
    );
    const args = readFileSync(argsFile, "utf8").trim().split(/\r?\n/);
    assert.deepEqual(args, [
      "--recursive",
      "--if-present",
      "--filter",
      "./packages/aaa-early-omega",
      "--filter",
      "./packages/import-like-optional",
      "--filter",
      "./packages/zzz-late-alpha",
      "run",
      "check-types",
    ]);
  } finally {
    rmSync(foreignRoot, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
}

// #2873: --packages-dir whose parent carries no pnpm-workspace.yaml is not a
// pnpm workspace — reject before pnpm is invoked at all.
{
  const noWorkspaceRoot = mkdtempSync(join(tmpdir(), "check-type-packages-nonws-"));
  try {
    const packagesDir = join(noWorkspaceRoot, "packages");
    const pkgDir = join(packagesDir, "stray-package");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "@remnic/stray-package", scripts: { "check-types": "tsc --noEmit" } })
    );
    const stubBin = join(noWorkspaceRoot, "stub-bin");
    const argsFile = join(noWorkspaceRoot, "args.txt");
    createStubPnpm(stubBin, argsFile);

    const result = spawnSync(process.execPath, [modulePath, "--run", "--packages-dir", packagesDir], {
      cwd: noWorkspaceRoot,
      encoding: "utf8",
      env: { ...process.env, PATH: `${stubBin}${delimiter}${process.env.PATH ?? ""}` },
    });
    assert.notEqual(result.status, 0, "non-workspace packages-dir must fail");
    assert.match(result.stderr, /not a pnpm workspace/);
    assert.ok(!existsSync(argsFile), "pnpm must not be invoked for a non-workspace packages-dir");
    assert.ok(!existsSync(join(noWorkspaceRoot, "stub-cwd-marker")));
  } finally {
    rmSync(noWorkspaceRoot, { recursive: true, force: true });
  }
}
// CLI --packages-dir: reject incomplete values before enumeration (#2856).
{
  const spawnCli = (args) => spawnSync(process.execPath, [modulePath, ...args], { encoding: "utf8" });
  const assertUsageReject = (args) => {
    const result = spawnCli(args);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /usage: check-type-packages\.mjs/);
    assert.equal(result.stdout, "");
  };

  assertUsageReject(["--list", "--packages-dir"]);
  assertUsageReject(["--run", "--packages-dir"]);
  assertUsageReject(["--list", "--packages-dir", "--run"]);
  assertUsageReject(["--list", "--packages-dir", ""]);
  assertUsageReject(["--list", "--packages-dir", "   "]);
  assertUsageReject([
    "--list",
    "--packages-dir",
    join(tmpdir(), "check-type-packages-a"),
    "--packages-dir",
    join(tmpdir(), "check-type-packages-b"),
  ]);

  const listDir = mkdtempSync(join(tmpdir(), "check-type-packages-list-"));
  try {
    const packagesDir = writeWorkspace(listDir, { shuffled: false, hydrated: false });
    const listed = spawnCli(["--list", "--packages-dir", packagesDir]);
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(listed.stdout.trim().split(/\r?\n/), [
      "aaa-early-omega",
      "import-like-optional",
      "zzz-late-alpha",
    ]);
  } finally {
    rmSync(listDir, { recursive: true, force: true });
  }
}

console.log("check-type-packages scope passed: deterministic manifest enumeration and run wiring");
