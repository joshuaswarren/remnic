#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function manifestPackageDirs(packagesDir = join(repoRoot, "packages")) {
  const names = [];
  for (const entry of readdirSync(packagesDir)) {
    if (existsSync(join(packagesDir, entry, "package.json"))) names.push(entry);
  }
  return names.sort();
}

function hasCheckTypesScript(packagesDir, name) {
  const manifest = JSON.parse(readFileSync(join(packagesDir, name, "package.json"), "utf8"));
  return Boolean(manifest.scripts?.["check-types"]);
}

export function checkTypePackageDirs(packagesDir = join(repoRoot, "packages")) {
  return manifestPackageDirs(packagesDir).filter((name) => hasCheckTypesScript(packagesDir, name));
}

export function noCheckTypePackageDirs(packagesDir = join(repoRoot, "packages")) {
  return manifestPackageDirs(packagesDir).filter((name) => !hasCheckTypesScript(packagesDir, name));
}
export function resolveWorkspaceRoot(packagesDir) {
  const root = dirname(resolve(packagesDir));
  return existsSync(join(root, "pnpm-workspace.yaml")) ? root : null;
}

export function runCheckTypePackages(packagesDir = join(repoRoot, "packages")) {
  const workspaceRoot = resolveWorkspaceRoot(packagesDir);
  if (!workspaceRoot) {
    console.error(
      `[check-type-packages] not a pnpm workspace: no pnpm-workspace.yaml next to ${packagesDir}`
    );
    return 1;
  }
  const covered = checkTypePackageDirs(packagesDir);
  if (covered.length === 0) {
    console.log("[check-type-packages] No packages declare scripts.check-types; nothing to run");
    return 0;
  }
  const args = ["--recursive", "--if-present"];
  for (const name of covered) args.push("--filter", `./packages/${name}`);
  args.push("run", "check-types");
  const result = spawnSync(process.execPath, [join(repoRoot, "scripts", "pnpm.mjs"), ...args], {
    stdio: "inherit",
    cwd: workspaceRoot,
  });
  if (result.error) {
    console.error(result.error.message);
    return 1;
  }
  return result.status ?? 1;
}

const USAGE =
  "usage: check-type-packages.mjs [--list | --list-manifests | --run] [--packages-dir <dir>]";

function parseCliArgs(argv) {
  const mode = argv[0] ?? "--list";
  if (mode !== "--list" && mode !== "--list-manifests" && mode !== "--run") return null;
  let packagesDir;
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] !== "--packages-dir") return null;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("-") || value.trim() === "") return null;
    if (packagesDir !== undefined) return null;
    packagesDir = value;
    i += 1;
  }
  return { mode, packagesDir: packagesDir ?? join(repoRoot, "packages") };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (!parsed) {
    console.error(USAGE);
    process.exit(2);
  }
  if (parsed.mode === "--run") {
    process.exit(runCheckTypePackages(parsed.packagesDir));
  }
  const names =
    parsed.mode === "--list-manifests"
      ? manifestPackageDirs(parsed.packagesDir)
      : checkTypePackageDirs(parsed.packagesDir);
  for (const name of names) console.log(name);
}
