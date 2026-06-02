import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.join(packageRoot, "dist");
const entrypoints = ["dist/index.js", "dist/publisher.js"];

const packOutput = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: packageRoot,
  encoding: "utf8",
});
const [pack] = JSON.parse(packOutput);
const packedFiles = new Set(pack.files.map((file) => file.path));

for (const entrypoint of entrypoints) {
  assertPacked(entrypoint);
  assertPackedRelativeImports(entrypoint);
  await import(pathToFileURL(path.join(packageRoot, entrypoint)).href);
}

console.log("plugin-pi packed imports OK");

function assertPacked(filePath) {
  if (!packedFiles.has(filePath)) {
    throw new Error(`Packed @remnic/plugin-pi artifact is missing ${filePath}`);
  }
}

function assertPackedRelativeImports(entrypoint) {
  const filePath = path.join(packageRoot, entrypoint);
  const source = fs.readFileSync(filePath, "utf8");
  const importPattern =
    /\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']\s*\)/g;

  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2];
    const importedPath = resolveRelativeImport(entrypoint, specifier);
    assertPacked(importedPath);
  }
}

function resolveRelativeImport(fromFile, specifier) {
  const resolved = path.relative(distRoot, path.resolve(packageRoot, path.dirname(fromFile), specifier));
  if (resolved.startsWith("..") || path.isAbsolute(resolved)) {
    throw new Error(`Packed @remnic/plugin-pi import escapes dist: ${fromFile} -> ${specifier}`);
  }
  return path.posix.join("dist", resolved.split(path.sep).join(path.posix.sep));
}
