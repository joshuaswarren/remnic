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
    packageJson = JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") continue;
    throw error;
  }

  const isRoot = relativePath === "package.json";
  if (!isRoot && packageJson.private === true) continue;
  if (packageJson.version === version) continue;

  packageJson.version = version;
  changed.push(`${relativePath} (${packageJson.name ?? "unnamed"})`);

  if (!dryRun) {
    await writeFile(absolutePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  }
}

if (changed.length === 0) {
  console.log(`All publishable packages already target ${version}.`);
} else {
  const action = dryRun ? "Would update" : "Updated";
  console.log(`${action} ${changed.length} package version(s) to ${version}:`);
  for (const entry of changed) {
    console.log(`- ${entry}`);
  }
}
