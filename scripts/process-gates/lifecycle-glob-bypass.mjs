#!/usr/bin/env node
/**
 * Pre-push gate: a coverage entry whose glob contains `**` is a directory-wide
 * bypass. The lifecycle-matrix check treats `covered` as outranking
 * `grandfathered`, so a glob key like `packages/remnic-core/src/lifecycle/**`
 * will silently claim coverage for every file matched by that glob, including
 * any grandfathered paths under it (e.g. `lifecycle/tombstones.ts`). A bypass
 * that hides behind a registered subject is worse than no gate.
 *
 * This gate fails pre-push whenever a coverage entry with `**` covers a path
 * that the HEAD manifest already lists in `grandfathered`. The fix is the
 * convention every other entry follows: exact-path entries in both
 * `lifecycleManifest` and `coverage` pointing at a subject that genuinely
 * runs the code.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isIgnoredPath } from "../effective-diff.mjs";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const manifestPath = join(repoRoot, "scripts/lifecycle-matrix/coverage.json");

function load() {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function failures(manifest) {
  const out = [];
  for (const [glob, subject] of Object.entries(manifest.coverage ?? {})) {
    if (!glob.includes("**")) continue;
    // Every currently-grandfathered path that this glob covers is silently
    // promoted from "warn-only" to "covered" by this glob. That is the bypass.
    for (const grand of manifest.grandfathered ?? []) {
      if (isIgnoredPath(grand, [glob])) {
        out.push(
          `coverage key "${glob}" -> "${subject}" silently covers grandfathered path "${grand}". ` +
            `Use an exact-path entry in both lifecycleManifest and coverage, pointed at a subject that runs it.`,
        );
      }
    }
  }
  return out;
}

const manifest = load();
const fails = failures(manifest);
if (fails.length === 0) {
  console.log("[lifecycle-glob-bypass] OK");
  process.exit(0);
}
console.error("[lifecycle-glob-bypass] " + fails.length + " silent bypass(es):");
for (const f of fails) console.error("  ::error::" + f);
process.exit(1);
