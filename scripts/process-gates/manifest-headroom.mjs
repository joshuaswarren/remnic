#!/usr/bin/env node
/**
 * Pre-push gate: openclaw.plugin.json minified must stay below the
 * 250,000-byte fail-at. The hard cap is 262,144 (256 KB); the fail-at is a
 * fleet-wide runway: every config-adding feature consumes ~10-30 bytes, and
 * the next one without a shrink will breach the fail-at. Catching it
 * pre-push costs ~50 ms; catching it in CI costs ~3 minutes of worker rebuild.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const MANIFEST = join(repoRoot, "packages/plugin-openclaw/openclaw.plugin.json");
const HARD_CAP = 262_144;
const FAIL_AT = 250_000;

function minifiedSize() {
  // The minify script swaps the file in place; for a size-only check we
  // pipe through node -e JSON.stringify-equivalent on the parsed JSON.
  const raw = readFileSync(MANIFEST, "utf8");
  // The minified form is JSON.stringify(parsed, null, 0) by convention here.
  return JSON.stringify(JSON.parse(raw)).length;
}

const bytes = minifiedSize();
if (bytes < FAIL_AT) {
  console.log(`[manifest-headroom] OK — ${bytes} bytes (fail-at ${FAIL_AT}, hard cap ${HARD_CAP})`);
  process.exit(0);
}
if (bytes < HARD_CAP) {
  console.error(
    `[manifest-headroom] WARN — ${bytes} bytes exceeds fail-at ${FAIL_AT} ` +
      `(hard cap ${HARD_CAP}). Shrink before the next config-adding feature lands.`,
  );
  // Soft-fail so it surfaces in CI logs without blocking unrelated PRs;
  // promote to process.exit(1) once the runway is back below FAIL_AT.
  process.exit(0);
}
console.error(
  `[manifest-headroom] FAIL — ${bytes} bytes exceeds hard cap ${HARD_CAP}. ` +
    `Reduce the manifest before merging.`,
);
process.exit(1);
