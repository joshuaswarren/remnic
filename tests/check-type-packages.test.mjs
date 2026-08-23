import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
{
  const runDir = mkdtempSync(join(tmpdir(), "check-type-packages-run-"));
  try {
    const packagesDir = writeWorkspace(runDir, { shuffled: false, hydrated: false });
    const stubBin = join(runDir, "stub-bin");
    mkdirSync(stubBin);
    const argsFile = join(runDir, "args.txt");
    writeFileSync(
      join(stubBin, "pnpm"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '10.32.1\\n'
  exit 0
fi
printf '%s\\n' "$@" > "${argsFile}"
exit "\${STUB_EXIT:-0}"
`,
      { mode: 0o755 }
    );

    const run = (extraEnv) =>
      spawnSync(process.execPath, [modulePath, "--run", "--packages-dir", packagesDir], {
        cwd: runDir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${stubBin}${process.env.PATH ? `:${process.env.PATH}` : ""}`,
          ...extraEnv,
        },
      });

    const ok = run({});
    assert.equal(ok.status, 0, ok.stderr);
    const args = readFileSync(argsFile, "utf8").trim().split("\n");
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

console.log("check-type-packages scope passed: deterministic manifest enumeration and run wiring");
