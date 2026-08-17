#!/usr/bin/env node
/**
 * Fail when a package.json `test` / `test:*` script names a .ts file
 * that does not exist. Deleting a test and leaving it in the script
 * made CI look like a missing-module failure instead of a script bug.
 *
 * REMNIC_TEST_FILES_ROOT is a test seam (absolute fake repo root).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = process.env.REMNIC_TEST_FILES_ROOT
  ? path.resolve(process.env.REMNIC_TEST_FILES_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function packageJsonPaths(root) {
  const out = [path.join(root, "package.json")];
  const packagesDir = path.join(root, "packages");
  if (!existsSync(packagesDir)) return out;
  for (const name of readdirSync(packagesDir)) {
    const candidate = path.join(packagesDir, name, "package.json");
    if (existsSync(candidate)) out.push(candidate);
  }
  return out;
}

function namedTsFiles(script) {
  return script.split(/\s+/).filter((token) => token.endsWith(".ts") && !token.includes("*"));
}

export function findMissingTestFiles(root = ROOT) {
  const missing = [];
  for (const pkgPath of packageJsonPaths(root)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
      continue;
    }
    const scripts = parsed && typeof parsed.scripts === "object" ? parsed.scripts : {};
    const pkgDir = path.dirname(pkgPath);
    for (const [name, script] of Object.entries(scripts)) {
      if (name !== "test" && !name.startsWith("test:")) continue;
      if (typeof script !== "string") continue;
      for (const token of namedTsFiles(script)) {
        const fromPkg = path.resolve(pkgDir, token);
        const fromRoot = path.resolve(root, token);
        if (!existsSync(fromPkg) && !existsSync(fromRoot)) {
          missing.push(`${path.relative(root, pkgPath)} script ${name}: missing ${token}`);
        }
      }
    }
  }
  return missing;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("check-package-test-files.mjs")) {
  const missing = findMissingTestFiles();
  if (missing.length > 0) {
    console.error("[test-files] package.json test scripts name missing files:");
    for (const line of missing) console.error(`[test-files]   - ${line}`);
    process.exit(1);
  }
  console.log("[test-files] OK");
}
