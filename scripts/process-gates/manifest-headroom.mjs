#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const MANIFEST = join(repoRoot, "packages/plugin-openclaw/openclaw.plugin.json");
const HARD_CAP = 262_144;
const FAIL_AT = 250_000;

function minifiedSize() {
  const raw = readFileSync(MANIFEST, "utf8");
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
  // Blocking again (issue 3618): the minified size is back below FAIL_AT,
  // so exceeding the fail-at must block pre-push instead of only logging.
  process.exit(1);
}
console.error(
  `[manifest-headroom] FAIL — ${bytes} bytes exceeds hard cap ${HARD_CAP}. ` +
    `Reduce the manifest before merging.`,
);
process.exit(1);
