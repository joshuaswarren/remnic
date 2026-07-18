#!/usr/bin/env node
/**
 * Sealed memory-write envelope belt (issue #1989 PR4, decision A).
 *
 * Production memory writes go through `composeMemoryEnvelope()` +
 * `writeSealedMemory()` so cross-cutting fields ride ONE composer and a new
 * field is a one-module change (write-envelope.ts) instead of a scattered
 * call-site hunt. `StorageManager.writeMemory` remains the single
 * persistence engine that `writeSealedMemory` delegates through — only
 * storage.ts itself (and tests, which may exercise the legacy contract
 * directly) may call it.
 *
 * This script is the ENFORCED belt (the repo's lint gate is tsc + biome +
 * check scripts; eslint.config.js carries the same rule for editors that
 * wire a TS-aware ESLint). It fails when a production source outside the
 * allowlist invokes `.writeMemory(`.
 */
import { readdirSync, readFileSync, lstatSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Files allowed to invoke the legacy engine directly. */
const ALLOWED = new Set([
  // The engine itself + the envelope module (mapper docs reference it).
  "packages/remnic-core/src/storage.ts",
  "packages/remnic-core/src/write-envelope.ts",
]);

// Every production package participates (review finding: plugin-openclaw,
// remnic-cli, and belief-ledger carried unmigrated writers the narrow scan
// missed). Package src roots are discovered, not hand-listed.
import { readdirSync as readdirSyncForRoots } from "node:fs";
const SCAN_ROOTS = [
  "src",
  ...readdirSyncForRoots(path.join(ROOT, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => `packages/${entry.name}/src`),
];
const SKIPPED_DIR_NAMES = new Set(["node_modules", ".git", "dist"]);

function isProductionSource(name) {
  return (
    (name.endsWith(".ts") || name.endsWith(".tsx") || name.endsWith(".mts") || name.endsWith(".cts")) &&
    !/\.test\.(ts|tsx|mts|cts)$/.test(name) &&
    !name.endsWith(".d.ts")
  );
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIR_NAMES.has(entry.name)) yield* walk(full);
    } else if (entry.isFile() && isProductionSource(entry.name)) {
      yield full;
    }
  }
}

const violations = [];
for (const rootRel of SCAN_ROOTS) {
  const root = path.join(ROOT, rootRel);
  try {
    if (lstatSync(root).isSymbolicLink()) continue;
  } catch {
    continue;
  }
  for (const file of walk(root)) {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    if (ALLOWED.has(rel)) continue;
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      // Method INVOCATION of writeMemory (not writeMemoryFrontmatter etc.,
      // not declarations, not comments/strings mentioning it).
      const match = lines[i].match(/\.\s*writeMemory\s*\(/);
      if (!match) continue;
      const trimmed = lines[i].trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      violations.push(`${rel}:${i + 1}: ${trimmed.slice(0, 120)}`);
    }
  }
}

if (violations.length > 0) {
  console.error(
    "[envelope-belt] production memory writes must go through composeMemoryEnvelope() + writeSealedMemory() (issue #1989).",
  );
  console.error(
    "[envelope-belt] Compose an envelope (strict for operator/system input, { salvage: true } for machine-generated",
  );
  console.error(
    "[envelope-belt] or replayed-from-store input, warn-logging envelope.salvageNotes) and pass per-write extras explicitly.",
  );
  console.error("[envelope-belt] Violations:");
  for (const violation of violations) {
    console.error(`[envelope-belt]   ${violation}`);
  }
  process.exit(1);
}
console.log("[envelope-belt] OK — no direct writeMemory invocations outside the storage engine");
