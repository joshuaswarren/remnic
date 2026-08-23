import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const preflightScript = resolve(rootDir, "scripts/pr-preflight.sh");

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

const rootConfigScope = packageScope("tsconfig.json");
assert.equal(rootConfigScope.status, 0, rootConfigScope.stderr);
assert.match(rootConfigScope.stdout, /Quick package scope: all packages/);
assert.match(rootConfigScope.stdout, /Checked packages:.*remnic-cli/);
// #2851: CI may classify optional import packages differently, but root
// config changes must always include the core runtime in quick checks.
assert.match(rootConfigScope.stdout, /Checked packages:.*remnic-core/);
assert.doesNotMatch(rootConfigScope.stdout, /Skipped packages:.*remnic-core/);

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
