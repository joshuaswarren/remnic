#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const publicManifestAliases = new Map([
  ["openclaw.plugin.json", ["packages/plugin-openclaw"]],
]);
const validBumpTypes = new Set(["major", "minor", "patch"]);

function readOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (value === undefined || value === "" || value === "--" || value.startsWith("--")) {
    throw new Error(`Missing value for ${optionName}`);
  }
  return value;
}

function parseArgs(argv) {
  const args = {
    base: "",
    head: "HEAD",
    bump: "patch",
    dryRun: false,
    json: false,
    repoRoot: process.cwd(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base") {
      args.base = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--head") {
      args.head = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--bump") {
      args.bump = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--repo-root") {
      args.repoRoot = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--") {
      continue;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.help && !validBumpTypes.has(args.bump)) {
    throw new Error(
      `Invalid --bump value "${args.bump}". Valid values: major, minor, patch.`,
    );
  }

  return args;
}

function usage() {
  return [
    "Usage: node scripts/bump-changed-packages.mjs --base <ref> [--head <ref>] [--bump patch|minor|major] [--dry-run] [--json]",
    "",
    "Diffs release source files between refs and bumps only public workspace packages whose own files changed.",
    "If a package version was already changed in the release source, the script leaves that version alone.",
  ].join("\n");
}

function runGit(repoRoot, args, options = {}) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: options.quiet ? ["ignore", "pipe", "ignore"] : ["ignore", "pipe", "pipe"],
  }).trim();
}

function tryGit(repoRoot, args) {
  try {
    return runGit(repoRoot, args, { quiet: true });
  } catch {
    return null;
  }
}

function normalizeRelativePath(filePath) {
  return filePath.split(path.sep).join("/");
}

function sortByPath(left, right) {
  return left.relativePath.localeCompare(right.relativePath);
}

async function readJson(jsonPath) {
  return JSON.parse(await readFile(jsonPath, "utf8"));
}

async function writeJson(jsonPath, value, dryRun) {
  const next = `${JSON.stringify(value, null, 2)}\n`;
  const current = await readFile(jsonPath, "utf8").catch(() => "");
  if (current === next) {
    return false;
  }
  if (!dryRun) {
    await writeFile(jsonPath, next);
  }
  return true;
}

function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) {
    throw new Error(`Cannot compare non-semver package version: ${version}`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareVersions(left, right) {
  const leftParts = parseSemver(left);
  const rightParts = parseSemver(right);

  for (const key of ["major", "minor", "patch"]) {
    if (leftParts[key] > rightParts[key]) {
      return 1;
    }
    if (leftParts[key] < rightParts[key]) {
      return -1;
    }
  }

  return 0;
}

function bumpVersion(version, bump) {
  const { major, minor, patch } = parseSemver(version);

  if (bump === "major") {
    return `${major + 1}.0.0`;
  }
  if (bump === "minor") {
    return `${major}.${minor + 1}.0`;
  }
  if (bump === "patch") {
    return `${major}.${minor}.${patch + 1}`;
  }
  throw new Error(`Unsupported package bump type: ${bump}`);
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function discoverPublicPackages(repoRoot) {
  const packagesRoot = path.join(repoRoot, "packages");
  const entries = await readdir(packagesRoot, { withFileTypes: true });
  const packages = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const packageDir = path.join(packagesRoot, entry.name);
    const packageJsonPath = path.join(packageDir, "package.json");
    if (!(await pathExists(packageJsonPath))) {
      continue;
    }

    const manifest = await readJson(packageJsonPath);
    if (manifest.private === true) {
      continue;
    }

    packages.push({
      dir: packageDir,
      relativeDir: normalizeRelativePath(path.relative(repoRoot, packageDir)),
      packageJsonPath,
      relativePath: normalizeRelativePath(path.relative(repoRoot, packageJsonPath)),
      manifest,
      name: manifest.name,
      version: manifest.version,
    });
  }

  return packages.sort(sortByPath);
}

function changedPackageDirs(changedFiles, packages) {
  const byDir = new Map(packages.map((pkg) => [pkg.relativeDir, pkg]));
  const changed = new Map();

  for (const file of changedFiles) {
    for (const [alias, packageDirs] of publicManifestAliases) {
      if (file === alias) {
        for (const packageDir of packageDirs) {
          const pkg = byDir.get(packageDir);
          if (pkg) {
            changed.set(pkg.relativeDir, pkg);
          }
        }
      }
    }

    for (const pkg of packages) {
      if (file === pkg.relativeDir || file.startsWith(`${pkg.relativeDir}/`)) {
        changed.set(pkg.relativeDir, pkg);
      }
    }
  }

  return [...changed.values()].sort(sortByPath);
}

function packageVersionAtRef(repoRoot, ref, relativePath) {
  const raw = tryGit(repoRoot, ["show", `${ref}:${relativePath}`]);
  if (raw === null) {
    return null;
  }

  return JSON.parse(raw).version ?? null;
}

function releaseSourceShaAtRef(repoRoot, ref) {
  const raw = tryGit(repoRoot, ["cat-file", "-p", ref]);
  const match = raw?.match(/^source-main-sha:\s*([0-9a-f]{7,40})$/im);
  if (!match) {
    return null;
  }

  const sha = match[1];
  return tryGit(repoRoot, ["rev-parse", "--verify", `${sha}^{commit}`]) ?? null;
}

function changedFilesBaseRef(repoRoot, base, head) {
  return (
    releaseSourceShaAtRef(repoRoot, base) ??
    tryGit(repoRoot, ["merge-base", base, head]) ??
    base
  );
}

async function syncJsonManifestVersion(repoRoot, relativeManifestPath, version, dryRun) {
  const manifestPath = path.join(repoRoot, relativeManifestPath);
  if (!(await pathExists(manifestPath))) {
    return false;
  }

  const manifest = await readJson(manifestPath);
  manifest.version = version;
  return writeJson(manifestPath, manifest, dryRun);
}

async function syncCompanionVersions(repoRoot, pkg, version, dryRun) {
  const changedFiles = [];

  if (pkg.relativeDir === "packages/plugin-openclaw") {
    const packageManifest = "packages/plugin-openclaw/openclaw.plugin.json";
    const rootManifest = "openclaw.plugin.json";
    if (await syncJsonManifestVersion(repoRoot, packageManifest, version, dryRun)) {
      changedFiles.push(packageManifest);
    }
    if (await syncJsonManifestVersion(repoRoot, rootManifest, version, dryRun)) {
      changedFiles.push(rootManifest);
    }
  }

  if (pkg.relativeDir === "packages/shim-openclaw-engram") {
    const shimManifest = "packages/shim-openclaw-engram/openclaw.plugin.json";
    if (await syncJsonManifestVersion(repoRoot, shimManifest, version, dryRun)) {
      changedFiles.push(shimManifest);
    }
  }

  if (pkg.relativeDir === "packages/plugin-claude-code") {
    const claudeManifest = "packages/plugin-claude-code/.claude-plugin/plugin.json";
    if (await syncJsonManifestVersion(repoRoot, claudeManifest, version, dryRun)) {
      changedFiles.push(claudeManifest);
    }
  }

  return changedFiles;
}

async function bumpChangedPackages(options) {
  const repoRoot = path.resolve(options.repoRoot);
  const base = options.base;
  const head = options.head || "HEAD";

  if (!base) {
    throw new Error("--base is required");
  }
  if (!tryGit(repoRoot, ["rev-parse", "--verify", base])) {
    throw new Error(`Base ref not found: ${base}`);
  }
  if (!tryGit(repoRoot, ["rev-parse", "--verify", head])) {
    throw new Error(`Head ref not found: ${head}`);
  }

  const changedBase = changedFilesBaseRef(repoRoot, base, head);
  const changedFiles = runGit(repoRoot, ["diff", "--name-only", `${changedBase}..${head}`])
    .split("\n")
    .map((file) => file.trim())
    .filter(Boolean);

  const packages = await discoverPublicPackages(repoRoot);
  const changedPackages = changedPackageDirs(changedFiles, packages);
  const updates = [];

  for (const pkg of changedPackages) {
    const baseVersion = packageVersionAtRef(repoRoot, base, pkg.relativePath);
    let nextVersion = pkg.version;
    let reason = "new-package";

    if (baseVersion !== null) {
      const versionComparison = compareVersions(pkg.version, baseVersion);
      if (versionComparison === 0) {
        nextVersion = bumpVersion(pkg.version, options.bump);
        reason = "auto-bump";
      } else if (versionComparison > 0) {
        reason = "manual-version";
      } else {
        nextVersion = bumpVersion(baseVersion, options.bump);
        reason = "catch-up-bump";
      }
    }

    const changedFilesForPackage = [];
    if (nextVersion !== pkg.version) {
      const nextManifest = { ...pkg.manifest, version: nextVersion };
      if (await writeJson(pkg.packageJsonPath, nextManifest, options.dryRun)) {
        changedFilesForPackage.push(pkg.relativePath);
      }
    }

    changedFilesForPackage.push(
      ...(await syncCompanionVersions(repoRoot, pkg, nextVersion, options.dryRun)),
    );

    updates.push({
      name: pkg.name,
      path: pkg.relativeDir,
      from: pkg.version,
      to: nextVersion,
      baseVersion,
      reason,
      changedFiles: changedFilesForPackage,
    });
  }

  return { base, changedBase, head, bump: options.bump, changedFiles, updates };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const result = await bumpChangedPackages(args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.updates.length === 0) {
    console.log(
      `No public workspace package versions need changes for ${result.base}..${result.head}.`,
    );
    return;
  }

  for (const update of result.updates) {
    const suffix = update.changedFiles.length
      ? `; wrote ${update.changedFiles.join(", ")}`
      : "";
    console.log(
      `${update.name}: ${update.from} -> ${update.to} (${update.reason})${suffix}`,
    );
  }
}

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entrypoint === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export {
  bumpChangedPackages,
  bumpVersion,
  changedPackageDirs,
  discoverPublicPackages,
  parseArgs,
};
