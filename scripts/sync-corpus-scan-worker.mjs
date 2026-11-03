#!/usr/bin/env node
/**
 * Generate the plain-JavaScript corpus-scan worker entry.
 *
 * A worker thread does not inherit the TypeScript loader the source tree runs
 * under, so the worker entry must be JavaScript on every runtime the package
 * supports (the CI Node runtime included). This bundles
 * `packages/remnic-core/src/corpus-scan-worker.entry.ts` — and the scan
 * implementation it imports — into a single ES module.
 *
 * The generated file is committed so the source tree can run the worker
 * without a build; scripts/check-corpus-scan-worker-sync.mjs fails CI when it
 * drifts from the TypeScript source.
 */

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

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

const output = result.outputFiles[0].text;
const { writeFile } = await import("node:fs/promises");
await writeFile(outfile, output, "utf-8");
console.log(`corpus-scan worker entry written: ${path.relative(repoRoot, outfile)}`);
