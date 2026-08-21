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
  assertPiExtensionEntriesResolveFromPackedPackage(tarballPath);
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

function assertPiExtensionEntriesResolveFromPackedPackage(tarballPath) {
  const packageJson = JSON.parse(
    execFileSync("tar", ["-xOf", tarballPath, "package/package.json"], { encoding: "utf8" })
  );
  const extensions = packageJson?.pi?.extensions;
  if (!Array.isArray(extensions)) return;

  const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-plugin-pi-resolve-"));
  try {
    const installRoot = path.join(tempProject, "node_modules", ...packageJson.name.split("/"));
    fs.mkdirSync(installRoot, { recursive: true });
    execFileSync("tar", ["-xzf", tarballPath, "-C", installRoot, "--strip-components=1"]);

    for (const extensionPath of extensions) {
      const specifier = piManifestPathToPackageSpecifier(packageJson.name, extensionPath);
      assertPackageSpecifierResolves(tempProject, specifier);
    }
  } finally {
    fs.rmSync(tempProject, { recursive: true, force: true });
  }
}

function piManifestPathToPackageSpecifier(packageName, manifestPath) {
  if (typeof manifestPath !== "string" || manifestPath.length === 0) {
    throw new Error(`Packed @remnic/plugin-pi pi.extensions entry must be a non-empty string: ${manifestPath}`);
  }
  if (manifestPath === ".") return packageName;
  if (manifestPath.startsWith("!") || hasGlobPattern(manifestPath)) {
    throw new Error(`Packed @remnic/plugin-pi pi.extensions entry must be an exact package path: ${manifestPath}`);
  }
  if (path.isAbsolute(manifestPath) || manifestPath.startsWith("..")) {
    throw new Error(`Packed @remnic/plugin-pi pi.extensions entry must stay inside the package: ${manifestPath}`);
  }

  const packagePath = manifestPath.startsWith("./") ? manifestPath.slice(2) : manifestPath;
  if (!packagePath || packagePath.startsWith("../") || packagePath.includes("/../")) {
    throw new Error(`Packed @remnic/plugin-pi pi.extensions entry must stay inside the package: ${manifestPath}`);
  }
  return `${packageName}/${packagePath}`;
}

function hasGlobPattern(value) {
  return /[*?[\]{}]/.test(value);
}

function assertPackageSpecifierResolves(cwd, specifier) {
  try {
    execFileSync(
      process.execPath,
      ["--input-type=module", "-e", "console.log(import.meta.resolve(process.env.SPECIFIER))"],
      {
        cwd,
        env: { ...process.env, SPECIFIER: specifier },
        encoding: "utf8",
      }
    );
  } catch (err) {
    throw new Error(`Packed @remnic/plugin-pi pi.extensions entry is not exported by package.json: ${specifier}`, {
      cause: err,
    });
  }
}

function resolveRelativeImport(fromFile, specifier) {
  const resolved = path.relative(distRoot, path.resolve(packageRoot, path.dirname(fromFile), specifier));
  if (resolved.startsWith("..") || path.isAbsolute(resolved)) {
    throw new Error(`Packed @remnic/plugin-pi import escapes dist: ${fromFile} -> ${specifier}`);
  }
  return path.posix.join("dist", resolved.split(path.sep).join(path.posix.sep));
}
