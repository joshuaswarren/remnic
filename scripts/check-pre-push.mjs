#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveTsxCliPath } from "./test-spawn-plan.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const BASE_REF_CANDIDATES = ["github/main", "origin/main", "upstream/main", "main"];

function nodeOptions() {
  const existing = process.env.NODE_OPTIONS ?? "";
  return existing.includes("--conditions=remnic-source")
    ? existing
    : `${existing ? `${existing} ` : ""}--conditions=remnic-source`;
}

function git(args) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return result.status === 0 ? (result.stdout ?? "") : null;
}

function resolveMergeBase() {
  const override = process.env.REMNIC_PRE_PUSH_BASE_REF;
  const candidates = override ? [override] : BASE_REF_CANDIDATES;
  let best = null;
  for (const ref of candidates) {
    const mergeBase = git(["merge-base", ref, "HEAD"])?.trim();
    if (!mergeBase) continue;
    const depth = Number.parseInt((git(["rev-list", "--count", mergeBase]) ?? "0").trim(), 10);
    if (!Number.isFinite(depth)) continue;
    if (best === null || depth > best.depth) best = { ref, mergeBase, depth };
  }
  return best;
}

function baseScopeEnv() {
  const base = resolveMergeBase();
  if (base === null) {
    console.log(
      "[pre-push] NOTE: no base ref found, so ratchet/lifecycle checks run without base scoping.",
    );
    console.log(
      `[pre-push]   Fetch one of ${BASE_REF_CANDIDATES.join(", ")} (or set REMNIC_PRE_PUSH_BASE_REF) for the scope CI uses.`,
    );
    return {};
  }
  const { ref: BASE_REF, mergeBase } = base;
  console.log(`[pre-push] base: ${BASE_REF} (merge-base ${mergeBase.slice(0, 9)})`);
  const scratch = mkdtempSync(join(tmpdir(), "remnic-pre-push-"));
  const changed = git(["-c", "core.quotePath=off", "diff", "--name-only", `${mergeBase}...HEAD`]) ?? "";
  const changedNameStatus =
    git(["-c", "core.quotePath=off", "diff", "--name-status", "-z", "-M", `${mergeBase}...HEAD`]) ?? "";
  const ratchetPath = join(scratch, "ratchet-changed-files.txt");
  const lifecyclePath = join(scratch, "lifecycle-changed-files.txt");
  const baseCoveragePath = join(scratch, "lifecycle-base-coverage.json");
  const baseIgnorePath = join(scratch, "lifecycle-base-ignore.txt");
  writeFileSync(ratchetPath, changed);
  writeFileSync(lifecyclePath, changedNameStatus);
  writeFileSync(baseCoveragePath, git(["show", `${mergeBase}:scripts/lifecycle-matrix/coverage.json`]) ?? "");
  writeFileSync(baseIgnorePath, git(["show", `${mergeBase}:.github/ai-review-ignore`]) ?? "");
  return {
    REMNIC_RATCHET_CHANGED_FILES_PATH: ratchetPath,
    REMNIC_LIFECYCLE_CHANGED_FILES_PATH: lifecyclePath,
    LIFECYCLE_BASE_MANIFEST_PATH: baseCoveragePath,
    LIFECYCLE_BASE_IGNORE_PATH: baseIgnorePath,
  };
}

const resolvedBase = resolveMergeBase();
const baseEnv = baseScopeEnv();

const CHECKS = [
  {
    name: "structural ratchets",
    argv: ["node", "scripts/check-ratchets.mjs"],
    hint: "A touched file is over its grandfathered ceiling. Extract the addition into a sibling module. If the branch is behind main, merge main first — CI measures the merge commit.",
  },
  {
    name: "comment ratchet",
    argv: ["node", "scripts/check-comment-ratchet.mjs"],
    hint: "Comment-line counts changed. Delete comments (never add), then run: node scripts/check-comment-ratchet.mjs --update",
  },
  {
    name: "regex safety",
    argv: ["node", "scripts/check-regex-safety.mjs"],
    env: {
      REMNIC_REGEX_SAFETY_BASE_REF:
        process.env.REMNIC_REGEX_SAFETY_BASE_REF ?? resolvedBase?.ref ?? "origin/main",
    },
    hint: "A changed line adds a ReDoS-shaped regex. Use bounded quantifiers such as \\s{0,8}, or scan with indexOf.",
  },
  {
    name: "envelope belt",
    argv: ["node", "scripts/check-envelope-belt.mjs"],
    hint: "A memory write bypasses composeMemoryEnvelope / storage.writeSealedMemory.",
  },
  {
    name: "config contract",
    argv: [process.execPath, resolveTsxCliPath(repoRoot), "scripts/validate-config-contract.ts"],
    env: {
      REMNIC_CONFIG_CONTRACT_BASE_REF:
        process.env.REMNIC_CONFIG_CONTRACT_BASE_REF ?? resolvedBase?.ref ?? "origin/main",
    },
    hint: "A parsed config key is undocumented, or the parsed-keys snapshot drifted. Document the FULL key path in docs/config-reference.md, then regenerate: npx tsx scripts/config-contract/extract-parsed-keys.ts --write",
  },
  {
    name: "lifecycle-matrix coverage",
    argv: ["node", "scripts/lifecycle-matrix/check-coverage.mjs"],
    hint: "A touched lifecycle path has no registered LifecycleSubject. Add or extend one — a required gate that passes without exercising the code it covers is worse than no gate.",
    optional: true,
  },
  {
    name: "lifecycle glob-bypass",
    argv: ["node", "scripts/process-gates/lifecycle-glob-bypass.mjs"],
    hint: "A coverage entry with ** silently bypasses grandfathered paths. Use exact-path entries.",
  },
  {
    name: "types import cycle",
    argv: ["node", "scripts/process-gates/types-import-cycle.mjs"],
    hint: "types.ts transitively reaches a runtime module. Move the interface into a leaf sibling and re-export.",
  },
  {
    name: "manifest headroom",
    argv: ["node", "scripts/process-gates/manifest-headroom.mjs"],
    hint: "openclaw.plugin.json minified is over the 250,000 fail-at. Shrink before the next config addition lands.",
  },
  {
    name: "branch shape",
    argv: ["node", "scripts/process-gates/branch-shape.mjs"],
    hint: "Branch name does not match an expected pattern (b<n>/<issue>, b<n>/process-..., fix/<issue>-...).",
  },
];

function runCheck(check) {
  const [command, ...args] = check.argv;
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, ...baseEnv, ...(check.env ?? {}), NODE_OPTIONS: nodeOptions() },
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
