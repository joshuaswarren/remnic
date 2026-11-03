#!/usr/bin/env node
/**
 * Fail when the committed corpus-scan worker entry drifts from its TypeScript
 * source (the same contract the openclaw plugin sync check enforces).
 */

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFile } from "node:fs/promises";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(repoRoot, "packages/remnic-core/src/corpus-scan-worker.entry.ts");
const outfile = path.join(repoRoot, "packages/remnic-core/src/corpus-scan-worker.entry.mjs");

const banner = `// GENERATED FILE — do not edit.
// Source: packages/remnic-core/src/corpus-scan-worker.entry.ts
// Regenerate: npm run sync:corpus-scan-worker
`;

const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  write: false,
  banner: { js: banner },
  logLevel: "warning",
});

const expected = result.outputFiles[0].text;
const actual = await readFile(outfile, "utf-8").catch(() => "");
if (actual !== expected) {
  console.error("corpus-scan worker entry is out of date — run: npm run sync:corpus-scan-worker");
  process.exit(1);
}
console.log("corpus-scan worker entry is in sync");
