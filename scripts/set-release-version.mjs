#!/usr/bin/env node
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const version = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
const semverIdentifier = String.raw`(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)`;
const versionPattern = new RegExp(
  String.raw`^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-${semverIdentifier}(?:\.${semverIdentifier})*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`,
);

if (!version || !versionPattern.test(version)) {
  console.error("Usage: node scripts/set-release-version.mjs <semver> [--dry-run]");
  process.exit(1);
}

const repoRoot = process.cwd();
const packagePaths = ["package.json"];
const packagesDir = path.join(repoRoot, "packages");

async function readJson(jsonPath) {
  return JSON.parse(await readFile(jsonPath, "utf8"));
}

async function writeJson(jsonPath, value) {
  await writeFile(jsonPath, `${JSON.stringify(value, null, 2)}\n`);
}

function companionManifestPaths(relativePackageJsonPath) {
  const packageDir = path.dirname(relativePackageJsonPath);
  const paths = [];
  if (packageDir !== ".") {
    paths.push(path.join(packageDir, "openclaw.plugin.json"));
  }
  if (packageDir === path.join("packages", "plugin-openclaw")) {
    paths.push("openclaw.plugin.json");
  }
  return paths;
}

async function syncCompanionManifestVersion(relativePath) {
  const changed = [];
  for (const relativeManifestPath of companionManifestPaths(relativePath)) {
    const absoluteManifestPath = path.join(repoRoot, relativeManifestPath);
    let manifest;
    try {
      manifest = await readJson(absoluteManifestPath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (manifest.version === version) continue;
    manifest.version = version;
    changed.push(`${relativeManifestPath} (${manifest.id ?? "openclaw manifest"})`);
    if (!dryRun) {
      await writeJson(absoluteManifestPath, manifest);
    }
  }
  return changed;
}

function syncRemnicPeerDependencyRanges(packageJson) {
  if (
    !packageJson.peerDependencies ||
    typeof packageJson.peerDependencies !== "object" ||
    Array.isArray(packageJson.peerDependencies)
  ) {
    return [];
  }

  const changed = [];
  const nextRange = `^${version}`;
  for (const [name, spec] of Object.entries(packageJson.peerDependencies)) {
    if (!name.startsWith("@remnic/") || spec === nextRange) continue;
    packageJson.peerDependencies[name] = nextRange;
    changed.push(name);
  }
  return changed;
}

for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  packagePaths.push(path.join("packages", entry.name, "package.json"));
}

packagePaths.sort();

const changed = [];
for (const relativePath of packagePaths) {
  const absolutePath = path.join(repoRoot, relativePath);
  let packageJson;
  try {
    packageJson = await readJson(absolutePath);
  } catch (error) {
    if (error?.code === "ENOENT") continue;
    throw error;
  }

  const isRoot = relativePath === "package.json";
  if (!isRoot && packageJson.private === true) continue;
  const peerRangeChanges = syncRemnicPeerDependencyRanges(packageJson);
  if (packageJson.version === version && peerRangeChanges.length === 0) {
    changed.push(...await syncCompanionManifestVersion(relativePath));
    continue;
  }

  const versionChanged = packageJson.version !== version;
  if (versionChanged) {
    packageJson.version = version;
  }
  const suffix = [
    versionChanged ? "version" : null,
    peerRangeChanges.length > 0
      ? `peer ${peerRangeChanges.join(",")}`
      : null,
  ].filter(Boolean).join("; ");
  changed.push(`${relativePath} (${packageJson.name ?? "unnamed"}${suffix ? `; ${suffix}` : ""})`);

  if (!dryRun) {
    await writeJson(absolutePath, packageJson);
  }
  changed.push(...await syncCompanionManifestVersion(relativePath));
}

if (changed.length === 0) {
  console.log(`All publishable packages already target ${version}.`);
} else {
  const action = dryRun ? "Would update" : "Updated";
  console.log(`${action} ${changed.length} package/manifest release field(s) to ${version}:`);
  for (const entry of changed) {
    console.log(`- ${entry}`);
  }
}
