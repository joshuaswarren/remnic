#!/usr/bin/env node
/**
 * Fail when a packages/* tsconfig package is missing check-types,
 * or missing precheck-types while it depends on @remnic/core.
 * Hit this run: connector-x failed tests (root) 10 minutes in.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function missingTypecheckScripts(packagesDir = join(repoRoot, "packages")) {
  const names = readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(packagesDir, name, "tsconfig.json")))
    .sort();

  const missingCheckTypes = [];
  const missingPrecheck = [];
  for (const name of names) {
    const pkg = JSON.parse(readFileSync(join(packagesDir, name, "package.json"), "utf8"));
    if (!pkg.scripts?.["check-types"]) missingCheckTypes.push(name);
    const usesCore = Boolean(
      pkg.dependencies?.["@remnic/core"] ||
        pkg.devDependencies?.["@remnic/core"] ||
        pkg.peerDependencies?.["@remnic/core"],
    );
    if (usesCore && pkg.name !== "@remnic/plugin-openclaw" && !pkg.scripts?.["precheck-types"]) {
      missingPrecheck.push(name);
    }
  }
  return { missingCheckTypes, missingPrecheck };
}


if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { missingCheckTypes, missingPrecheck } = missingTypecheckScripts();
  if (missingCheckTypes.length > 0 || missingPrecheck.length > 0) {
    if (missingCheckTypes.length > 0) {
      console.error(`packages missing scripts.check-types: ${missingCheckTypes.join(", ")}`);
    }
    if (missingPrecheck.length > 0) {
      console.error(
        `packages that depend on @remnic/core need scripts.precheck-types (copy packages/connector-limitless): ${missingPrecheck.join(", ")}`,
      );
    }
    process.exit(1);
  }
}
