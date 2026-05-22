import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

function runScript(script: string, args: string[]) {
  return spawnSync(process.execPath, [tsxCli, script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      REMNIC_OPENCLAW_SURFACE_DISABLE_AUTO_RESOLVE: "1",
    },
    timeout: 30_000,
  });
}

test("codex-materialize rejects missing --memory-dir value before consuming --json", () => {
  const result = runScript("scripts/codex-materialize.ts", [
    "--memory-dir",
    "--json",
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--memory-dir requires a value/);
});

test("eval-ci-gate rejects missing --base value before consuming --candidate", () => {
  const result = runScript("scripts/eval-ci-gate.ts", [
    "--base",
    "--candidate",
    "./candidate",
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--base requires a value/);
});

test("eval-baseline-ci-gate rejects missing --snapshot-id value before consuming --base", () => {
  const result = runScript("scripts/eval-baseline-ci-gate.ts", [
    "--snapshot-id",
    "--base",
    "./base",
    "--candidate",
    "./candidate",
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--snapshot-id requires a value/);
});
