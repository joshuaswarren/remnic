#!/usr/bin/env node

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
