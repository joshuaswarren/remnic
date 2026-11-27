#!/usr/bin/env node
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
