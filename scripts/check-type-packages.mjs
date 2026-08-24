#!/usr/bin/env node
/**
 * Manifest-derived enumeration of workspace packages that type checks cover
 * (issue #2851).
 *
 * A package is covered iff packages/<dir>/package.json exists and declares
 * scripts.check-types. Manifests without that script are the documented
 * no-check-type set (native platform shims and non-TypeScript host adapters);
 * scripts/check-package-typecheck-scripts.mjs is the rule that keeps the set
 * honest — every packages/* package WITH a tsconfig.json must declare the
 * script. Those packages are the only legitimate skips.
 *
 * Enumeration reads package manifests only, so the result is identical on a
 * clean CI checkout and a hydrated local clone regardless of node_modules,
 * build output, platform, or directory order.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Every packages/* directory that owns a package manifest, sorted by name. */
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

/** Covered packages: manifest declares scripts.check-types. Sorted. */
export function checkTypePackageDirs(packagesDir = join(repoRoot, "packages")) {
  return manifestPackageDirs(packagesDir).filter((name) => hasCheckTypesScript(packagesDir, name));
}

/** Documented no-check-type packages: manifest present, script absent. Sorted. */
export function noCheckTypePackageDirs(packagesDir = join(repoRoot, "packages")) {
  return manifestPackageDirs(packagesDir).filter((name) => !hasCheckTypesScript(packagesDir, name));
}

/**
 * Run check-types in exactly the covered packages through the pinned pnpm
 * wrapper, one explicit --filter per package. Replaces the environment-
 * dependent `--filter="./packages/*"` glob sweep, whose matched set followed
 * pnpm workspace-resolution state and skipped covered packages on clean CI
 * checkouts (#2851).
 */
export function runCheckTypePackages(packagesDir = join(repoRoot, "packages")) {
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
  let sawPackagesDir = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== "--packages-dir") continue;
    const value = argv[i + 1];
    if (sawPackagesDir || value === undefined || value.startsWith("-") || value.trim() === "") {
      return null;
    }
    packagesDir = value;
    sawPackagesDir = true;
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
