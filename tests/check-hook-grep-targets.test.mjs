import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  HOOK_CONTRACT_TESTS,
  HOOK_CORE_REL,
  findHookGrepTargetMisses,
} from "../scripts/check-hook-grep-targets.mjs";

function writeTree(files) {
  const root = mkdtempSync(path.join(tmpdir(), "hook-grep-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

test("passes when no shared hook core exists", () => {
  const root = writeTree({
    [HOOK_CONTRACT_TESTS[0]]: "readFileSync(codexHookRunner)",
  });
  assert.deepEqual(findHookGrepTargetMisses(root), []);
});

test("fails when contract tests omit remnic-hook-core.cjs", () => {
  const root = writeTree({
    [HOOK_CORE_REL]: "module.exports = {}",
    [HOOK_CONTRACT_TESTS[0]]: "readFileSync(codexHookRunner)",
    [HOOK_CONTRACT_TESTS[1]]: "readFileSync(runner)",
  });
  assert.deepEqual(findHookGrepTargetMisses(root), HOOK_CONTRACT_TESTS);
});

test("passes when both contract tests name the core file", () => {
  const root = writeTree({
    [HOOK_CORE_REL]: "module.exports = {}",
    [HOOK_CONTRACT_TESTS[0]]: 'readFileSync(codexHookCore) // remnic-hook-core.cjs',
    [HOOK_CONTRACT_TESTS[1]]: 'path.join(PACKAGES, "plugin-codex", "hooks", "bin", "remnic-hook-core.cjs")',
  });
  assert.deepEqual(findHookGrepTargetMisses(root), []);
});
