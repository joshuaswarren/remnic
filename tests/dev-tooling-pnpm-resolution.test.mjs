import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  return readFileSync(path.join(repoRoot, rel), "utf8");
}

// Issue #2781: fleet hosts have no global `pnpm`. Every repo spawn of pnpm
// must route through scripts/pnpm.mjs (the wrapper that resolves the pinned
// pnpm without a global install) instead of a bare `pnpm` command.
const BARE_PNPM_SPAWN = /spawnSync\(\s*["']pnpm["']/;

test("check-test-types.mjs spawns pnpm through scripts/pnpm.mjs wrapper", () => {
  const source = read("scripts/check-test-types.mjs");
  assert.doesNotMatch(
    source,
    BARE_PNPM_SPAWN,
    "scripts/check-test-types.mjs must not spawn bare `pnpm` (ENOENT on hosts without a global install)",
  );
  assert.match(source, /pnpm\.mjs/, "expected the tsc spawn to route through scripts/pnpm.mjs");
});

test("connector-weclone cli.test.ts builds through scripts/pnpm.mjs wrapper", () => {
  const source = read(path.join("packages", "connector-weclone", "src", "cli.test.ts"));
  assert.doesNotMatch(source, BARE_PNPM_SPAWN);
  assert.match(source, /pnpm\.mjs/);
});

test("remnic-server-package-surface.test.ts builds through scripts/pnpm.mjs wrapper", () => {
  const source = read(path.join("tests", "remnic-server-package-surface.test.ts"));
  assert.doesNotMatch(source, BARE_PNPM_SPAWN);
  assert.match(source, /pnpm\.mjs/);
});

test("pr-preflight.sh resolves pnpm through scripts/pnpm.mjs", () => {
  const source = read(path.join("scripts", "pr-preflight.sh"));
  assert.match(
    source,
    /pnpm\(\)\s*\{[^}]*pnpm\.mjs/,
    "expected a pnpm() shell function routing through scripts/pnpm.mjs",
  );
  // The function is found by command lookup, so `run pnpm ...` and bare
  // `pnpm ...` call sites both route through it. Only an explicit bypass
  // (`command pnpm`, backslash-escaped) would escape the wrapper.
  assert.doesNotMatch(source, /command +pnpm|\{ \\pnpm /);
});
