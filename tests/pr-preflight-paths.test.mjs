import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkTypePackageDirs, noCheckTypePackageDirs } from "../scripts/check-type-packages.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const preflightScript = resolve(rootDir, "scripts/pr-preflight.sh");
const coveredPackages = checkTypePackageDirs();
const noCheckTypePackages = noCheckTypePackageDirs();

function scopeList(stdout, label) {
  const prefix = `[preflight] ${label} packages:`;
  const line = stdout.split("\n").find((candidate) => candidate.startsWith(prefix));
  if (!line) return null;
  return line.slice(prefix.length).trim().split(/\s+/).filter(Boolean);
}

/** Checked and skipped must be a partition — never both (pipefail + grep -Fxq). */
function assertExclusivePackageScope(stdout, context) {
  const checked = scopeList(stdout, "Checked") ?? [];
  const skipped = scopeList(stdout, "Skipped") ?? [];
  const overlap = checked.filter((name) => skipped.includes(name));
  assert.deepEqual(
    overlap,
    [],
    `${context}: packages must not appear in both Checked and Skipped (overlap: ${overlap.join(", ")})`,
  );
}

/**
 * Under `set -o pipefail`, `printf … | grep -Fxq` can exit 141 on an early match
 * once the producer still has data to write (SIGPIPE). Membership then looks false
 * and a covered package is appended to Skipped while still listed in Checked.
 * Pin the production script off that pipeline; selection tests below exercise the
 * real `--print-quick-package-scope` path.
 */
const preflightSource = readFileSync(preflightScript, "utf8");
assert.equal(
  preflightSource.includes("set -euo pipefail"),
  true,
  "preflight keeps pipefail; membership must tolerate it",
);
assert.doesNotMatch(
  preflightSource,
  /printf '%s\\n' "\$\{[^}]+\[@\]\}" \| grep -Fxq/,
  "quick_package_scope must not use printf|grep -Fxq membership under pipefail",
);

/** Synthetic early match + large haystack: proves pipefail misclassifies grep -Fxq. */
{
  const probe = spawnSync(
    "bash",
    [
      "-c",
      [
        "set -euo pipefail",
        'haystack=("connector-droid")',
        "for i in $(seq 1 4000); do haystack+=(\"pad-$i\"); done",
        'if printf "%s\\n" "${haystack[@]}" | grep -Fxq "connector-droid"; then echo MATCH; else echo MISS; fi',
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(
    probe.stdout.trim(),
    "MISS",
    "control: early grep -Fxq under pipefail must misclassify so the production ban stays load-bearing",
  );
}


const guardedPaths = [
  "src/orchestrator.ts",
  "src/storage.ts",
  "src/storage/read-store.ts",
  "src/orchestration/recall-internal.ts",
  "src/intent.ts",
  "src/memory-cache.ts",
  "src/entity-retrieval.ts",
  "src/config.ts",
  "packages/remnic-core/src/orchestrator.ts",
  "packages/remnic-core/src/storage.ts",
  "packages/remnic-core/src/storage/memory-read-store.ts",
  "packages/remnic-core/src/orchestration/recall-search-pipeline.ts",
  "packages/remnic-core/src/intent.ts",
  "packages/remnic-core/src/memory-cache.ts",
  "packages/remnic-core/src/entity-retrieval.ts",
  "packages/remnic-core/src/config.ts",
];

const excludedPaths = [
  "src/config.tsx",
  "src/storage.ts.bak",
  "packages/remnic-core/src/storage-contract/round-trip.test.ts",
  "packages/remnic-core/src/orchestrator.test.ts",
  "packages/remnic-core/src/other/config.ts",
  "docs/storage/guide.md",
];

function gateStatus(path) {
  return spawnSync("bash", [preflightScript, "--check-entity-hardening-path", path], {
    cwd: rootDir,
    encoding: "utf8",
  });
}

for (const path of guardedPaths) {
  const result = gateStatus(path);

  assert.equal(result.status, 0, `expected entity hardening for ${path}: ${result.stderr}`);
}
function packageScope(files) {
  return spawnSync("bash", [preflightScript, "--print-quick-package-scope"], {
    cwd: rootDir,
    encoding: "utf8",
    env: { ...process.env, PREFLIGHT_CHANGED_FILES: files },
  });
}

const affectedScope = packageScope("packages/remnic-cli/src/index.ts\nREADME.md");
assert.equal(affectedScope.status, 0, affectedScope.stderr);
assert.match(affectedScope.stdout, /Quick package scope: affected packages/);
assert.match(affectedScope.stdout, /Checked packages: remnic-cli/);
assert.match(affectedScope.stdout, /Skipped packages:.*remnic-core/);

const coreScope = packageScope("packages/remnic-core/src/index.ts");
assert.equal(coreScope.status, 0, coreScope.stderr);
assert.match(coreScope.stdout, /Checked packages:.*plugin-openclaw/);
assert.match(coreScope.stdout, /Checked packages:.*bench-ui/);
assertExclusivePackageScope(coreScope.stdout, "remnic-core dependents");
{
  const coreChecked = scopeList(coreScope.stdout, "Checked") ?? [];
  const coreSkipped = scopeList(coreScope.stdout, "Skipped") ?? [];
  assert.ok(
    coreChecked.includes("connector-droid"),
    "connector-droid declares check-types and is in the remnic-core dependent set",
  );
  assert.equal(
    coreSkipped.includes("connector-droid"),
    false,
    "connector-droid must not also land in Skipped (pipefail false-negative membership)",
  );
}


const pythonPluginScope = packageScope("packages/plugin-hermes/remnic_hermes/hermes_llm_bridge.py");
assert.equal(pythonPluginScope.status, 0, pythonPluginScope.stderr);
assert.match(pythonPluginScope.stdout, /Quick package scope: all packages/);
assert.match(pythonPluginScope.stdout, /Checked packages:.*remnic-core/);

const rootConfigScope = packageScope("tsconfig.json");
assert.equal(rootConfigScope.status, 0, rootConfigScope.stderr);
assert.match(rootConfigScope.stdout, /Quick package scope: all packages/);
// Generated from package manifests (#2851): every workspace package that
// declares scripts.check-types is checked, and only the documented
// no-check-type packages may skip.
assert.deepEqual(scopeList(rootConfigScope.stdout, "Checked"), coveredPackages);
assert.deepEqual(scopeList(rootConfigScope.stdout, "Skipped"), noCheckTypePackages);
assert.ok(
  coveredPackages.includes("import-weclone"),
  "import-weclone declares scripts.check-types and must always be checked"
);
assertExclusivePackageScope(rootConfigScope.stdout, "all-packages scope");
assertExclusivePackageScope(affectedScope.stdout, "remnic-cli affected scope");


// Clean CI vs hydrated local (#2851): node_modules and package build output
// must not change the quick package scope. Only simulate hydration with
// markers this run created, so a real checkout is never mutated.
const nodeModulesDir = resolve(rootDir, "node_modules");
const importWecloneDistDir = resolve(rootDir, "packages/import-weclone/dist");
const hadNodeModules = existsSync(nodeModulesDir);
const hadDist = existsSync(importWecloneDistDir);
try {
  if (!hadNodeModules) mkdirSync(nodeModulesDir, { recursive: true });
  if (!hadDist) mkdirSync(importWecloneDistDir, { recursive: true });
  const hydratedScope = packageScope("tsconfig.json");
  assert.equal(hydratedScope.status, 0, hydratedScope.stderr);
  assert.equal(hydratedScope.stdout, rootConfigScope.stdout);
  assertExclusivePackageScope(hydratedScope.stdout, "hydrated all-packages scope");
  assertExclusivePackageScope(rootConfigScope.stdout, "pre-hydration baseline");

} finally {
  if (!hadNodeModules) rmSync(nodeModulesDir, { recursive: true, force: true });
  if (!hadDist) rmSync(importWecloneDistDir, { recursive: true, force: true });
}

const workspaceConfigScope = packageScope("pnpm-workspace.yaml");
assert.equal(workspaceConfigScope.status, 0, workspaceConfigScope.stderr);
assert.match(workspaceConfigScope.stdout, /Quick package scope: all packages/);

const emptyScope = packageScope("");
assert.equal(emptyScope.status, 0, emptyScope.stderr);
assert.match(emptyScope.stdout, /Quick package scope: all packages/);

for (const path of excludedPaths) {
  const result = gateStatus(path);
  assert.equal(result.status, 1, `expected no entity hardening for ${path}: ${result.stderr}`);
}

const workflowSource = readFileSync(resolve(rootDir, ".github/workflows/ci.yml"), "utf8");
const pathFilterMatch = workflowSource.match(/^ {12}entity_hardening:\n((?:^ {14}- '[^']+'\n)+)/m);
assert.ok(pathFilterMatch, "CI detect-risky-paths job must define the entity_hardening filter");

const ciFilterLines = new Set(pathFilterMatch[1].split("\n").map((line) => line.trim()));
for (const path of [
  "src/storage/**",
  "src/orchestration/**",
  "packages/remnic-core/src/storage/**",
  "packages/remnic-core/src/orchestration/**",
]) {
  assert.ok(ciFilterLines.has(`- '${path}'`), `CI path filter must include ${path}`);
}

console.log(`Preflight path contract passed: ${guardedPaths.length} guarded, ${excludedPaths.length} excluded`);
