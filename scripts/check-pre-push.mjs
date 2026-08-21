#!/usr/bin/env node
/**
 * Fast pre-push gate: the subset of CI's `checks` job that needs no build,
 * no type-check, and no test run (issue #2774).
 *
 * Why this exists. `preflight:quick` is the mandatory gate before requesting
 * review, but it takes many minutes because it lints, type-checks, and runs a
 * long test list. In a parallel implementation batch, agents that were told to
 * run only their focused test therefore ran no repo-wide gate at all — and
 * each one missed a DIFFERENT cheap check that CI then caught, one red run per
 * branch: structural ratchets, lifecycle-matrix coverage, regex safety, and a
 * config-contract parsed-keys snapshot drift.
 *
 * Every check below is already enforced by CI. This adds no new policy; it
 * just makes the cheap half runnable in one command, in seconds, so a red CI
 * run is not the first time anyone sees it. `preflight:quick` remains the
 * pre-review gate.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * `--conditions=remnic-source` matches how CI and the other scripts resolve
 * workspace sources; without it the config-contract extractor reads build
 * output that may not exist in a fresh worktree.
 */
function nodeOptions() {
  const existing = process.env.NODE_OPTIONS ?? "";
  return existing.includes("--conditions=remnic-source")
    ? existing
    : `${existing ? `${existing} ` : ""}--conditions=remnic-source`;
}

const CHECKS = [
  {
    name: "structural ratchets",
    argv: ["node", "scripts/check-ratchets.mjs"],
    hint: "A touched file is over its grandfathered ceiling. Extract the addition into a sibling module. If the branch is behind main, merge main first — CI measures the merge commit.",
  },
  {
    name: "regex safety",
    argv: ["node", "scripts/check-regex-safety.mjs"],
    env: { REMNIC_REGEX_SAFETY_BASE_REF: process.env.REMNIC_REGEX_SAFETY_BASE_REF ?? "origin/main" },
    hint: "A changed line adds a ReDoS-shaped regex. Use bounded quantifiers such as \\s{0,8}, or scan with indexOf.",
  },
  {
    name: "envelope belt",
    argv: ["node", "scripts/check-envelope-belt.mjs"],
    hint: "A memory write bypasses composeMemoryEnvelope / storage.writeSealedMemory.",
  },
  {
    name: "config contract",
    argv: ["npx", "tsx", "scripts/validate-config-contract.ts"],
    hint: "A parsed config key is undocumented, or the parsed-keys snapshot drifted. Document the FULL key path in docs/config-reference.md, then regenerate: npx tsx scripts/config-contract/extract-parsed-keys.ts --write",
  },
  {
    name: "lifecycle-matrix coverage",
    argv: ["node", "scripts/lifecycle-matrix/check-coverage.mjs"],
    hint: "A touched lifecycle path has no registered LifecycleSubject. Add or extend one — a required gate that passes without exercising the code it covers is worse than no gate.",
    optional: true,
  },
];

function runCheck(check) {
  const [command, ...args] = check.argv;
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, ...(check.env ?? {}), NODE_OPTIONS: nodeOptions() },
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.error && check.optional && result.error.code === "ENOENT") {
    console.log(`[pre-push] SKIP ${check.name} (not present in this checkout)`);
    return true;
  }
  if (result.error) {
    console.error(`[pre-push] FAIL ${check.name}: ${result.error.message}`);
    return false;
  }
  const ok = result.status === 0;
  console.log(`[pre-push] ${ok ? "OK  " : "FAIL"} ${check.name} (${seconds}s)`);
  return ok;
}

const failures = [];
for (const check of CHECKS) {
  if (check.optional && !existsSync(join(repoRoot, check.argv[1]))) {
    console.log(`[pre-push] SKIP ${check.name} (script absent)`);
    continue;
  }
  if (!runCheck(check)) {
    failures.push(check);
  }
}

console.log("");
if (failures.length === 0) {
  console.log("[pre-push] all cheap CI gates pass. `preflight:quick` is still the pre-review gate.");
  process.exit(0);
}

console.error(`[pre-push] ${failures.length} gate(s) failed:`);
for (const failure of failures) {
  console.error(`  - ${failure.name}: ${failure.hint}`);
}
process.exit(1);
