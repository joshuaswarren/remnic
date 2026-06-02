import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.join(packageRoot, "dist");
const entrypoints = ["dist/index.js", "dist/publisher.js"];
const packRoot = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-plugin-pi-pack-"));

let packedFiles;

try {
  const tarballPath = packPackage();
  packedFiles = new Set(listPackedFiles(tarballPath));
  assertPublishableDependencyRanges(tarballPath);
} finally {
  fs.rmSync(packRoot, { recursive: true, force: true });
}

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

function packPackage() {
  const packOutput = execFileSync("pnpm", ["pack", "--json", "--out", path.join(packRoot, "%s-%v.tgz")], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  const pack = parsePackOutput(packOutput);
  const tarballPath = pack?.tarball ?? pack?.filename ?? pack?.tarballPath;
  if (!tarballPath || typeof tarballPath !== "string") {
    throw new Error("Unable to locate packed @remnic/plugin-pi tarball path");
  }
  return path.isAbsolute(tarballPath) ? tarballPath : path.resolve(packRoot, tarballPath);
}

function parsePackOutput(output) {
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

function listPackedFiles(tarballPath) {
  const tarOutput = execFileSync("tar", ["-tf", tarballPath], { encoding: "utf8" });
  return tarOutput
    .split(/\r?\n/)
    .filter(Boolean)
    .map((entry) => entry.replace(/^package\//, ""));
}

function assertPublishableDependencyRanges(tarballPath) {
  const packageJson = JSON.parse(
    execFileSync("tar", ["-xOf", tarballPath, "package/package.json"], { encoding: "utf8" })
  );
  for (const section of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    const dependencies = packageJson[section];
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
    for (const [name, range] of Object.entries(dependencies)) {
      if (typeof range === "string" && range.startsWith("workspace:")) {
        throw new Error(`Packed @remnic/plugin-pi ${section}.${name} uses non-publishable range ${range}`);
      }
    }
  }
}

function resolveRelativeImport(fromFile, specifier) {
  const resolved = path.relative(distRoot, path.resolve(packageRoot, path.dirname(fromFile), specifier));
  if (resolved.startsWith("..") || path.isAbsolute(resolved)) {
    throw new Error(`Packed @remnic/plugin-pi import escapes dist: ${fromFile} -> ${specifier}`);
  }
  return path.posix.join("dist", resolved.split(path.sep).join(path.posix.sep));
}
