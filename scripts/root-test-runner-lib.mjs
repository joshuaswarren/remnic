/**
 * Pure helpers for the root test runner (issue #1538, epic #1520).
 *
 * Kept free of process/spawn side effects so tests/root-test-runner-lib.test.mjs
 * can exercise every branch. Node stdlib only, cross-platform (no shell-outs,
 * forward-slash-normalized results).
 */

import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The root suite's coverage, as structured entries rather than opaque glob
 * strings. Each entry must match at least one file at run time — a pattern
 * that matches nothing is an error (a rename or layout change silently
 * removing coverage), not a pass.
 */
export const TEST_PATTERNS = [
  { id: "tests/**/*.test.ts", base: "tests", recursive: true, suffix: ".test.ts" },
  { id: "tests/**/*.test.mjs", base: "tests", recursive: true, suffix: ".test.mjs" },
  { id: "packages/*/src/**/*.test.ts", base: "packages", packageSrc: true, recursive: true, suffix: ".test.ts" },
  { id: "packages/*/src/**/*.test.tsx", base: "packages", packageSrc: true, recursive: true, suffix: ".test.tsx" },
  { id: "dashboard/lib/*.test.ts", base: "dashboard/lib", recursive: false, suffix: ".test.ts" },
  { id: "integrations/amb/*.test.mjs", base: "integrations/amb", recursive: false, suffix: ".test.mjs" },
  // Hook runners ship as standalone CommonJS (no build step, spawned by the
  // host), so their tests live beside them rather than under `<pkg>/src`.
  // Without this entry they were never executed by any CI job.
  { id: "packages/**/*.test.cjs", base: "packages", recursive: true, suffix: ".test.cjs" },
];

/**
 * Named pattern groups for CI test sharding (issue: CI wall-clock). Every
 * TEST_PATTERNS id must belong to exactly one group — the companion test
 * enforces the partition so a new pattern cannot silently escape sharded CI.
 */
export const TEST_PATTERN_GROUPS = Object.freeze({
  root: ["tests/**/*.test.ts", "tests/**/*.test.mjs"],
  packages: [
    "packages/*/src/**/*.test.ts",
    "packages/*/src/**/*.test.tsx",
    "packages/**/*.test.cjs",
  ],
  misc: ["dashboard/lib/*.test.ts", "integrations/amb/*.test.mjs"],
});

/**
 * Resolve --group selections into TEST_PATTERNS entries.
 * No groups selected → the full pattern list (unsharded behavior).
 * Unknown group names are an error, never a silent no-op.
 */
export function selectTestPatterns(groupNames, patterns = TEST_PATTERNS) {
  if (!Array.isArray(groupNames)) {
    throw new Error("selectTestPatterns: groupNames must be an array");
  }
  if (groupNames.length === 0) return patterns;
  const validGroups = Object.keys(TEST_PATTERN_GROUPS).join(", ");
  const ids = new Set();
  for (const name of groupNames) {
    const groupIds = TEST_PATTERN_GROUPS[name];
    if (!groupIds) {
      throw new Error(`Unknown test group "${name}". Valid groups: ${validGroups}`);
    }
    for (const id of groupIds) ids.add(id);
  }
  const selected = patterns.filter((pattern) => ids.has(pattern.id));
  if (selected.length === 0) {
    throw new Error(`Test group selection [${groupNames.join(", ")}] matched no patterns.`);
  }
  return selected;
}
export function selectTestShard(files, shard) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("selectTestShard requires at least one file");
  }
  const { index, total } = shard ?? {};
  if (
    !Number.isSafeInteger(index) ||
    !Number.isSafeInteger(total) ||
    index < 1 ||
    total < 1 ||
    index > total
  ) {
    throw new Error(`selectTestShard received invalid shard ${String(index)}/${String(total)}`);
  }
  if (total > files.length) {
    throw new Error(`selectTestShard ${index}/${total} would create an empty shard for ${files.length} file(s)`);
  }
  return [...files].sort().filter((_, fileIndex) => fileIndex % total === index - 1);
}


/**
 * Parse root-test-runner CLI arguments. `--group <name>` is repeatable;
 * `--shard <index>/<total>` is optional and may appear once.
 */
export function parseRunnerArgs(argv) {
  const groups = [];
  let shard = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--group") {
      const value = argv[index + 1];
      if (typeof value !== "string" || value.startsWith("--")) {
        throw new Error("--group requires a group name argument");
      }
      if (!groups.includes(value)) groups.push(value);
      index += 1;
      continue;
    }
    if (arg === "--shard") {
      if (shard !== null) {
        throw new Error("--shard may be provided only once");
      }
      const value = argv[index + 1];
      if (typeof value !== "string" || value.startsWith("--")) {
        throw new Error("--shard requires an index/total argument");
      }
      const match = /^(\d+)\/(\d+)$/.exec(value);
      if (!match) {
        throw new Error("--shard must use index/total with integer values");
      }
      const shardIndex = Number(match[1]);
      const shardTotal = Number(match[2]);
      if (
        !Number.isSafeInteger(shardIndex) ||
        !Number.isSafeInteger(shardTotal) ||
        shardIndex < 1 ||
        shardTotal < 1 ||
        shardIndex > shardTotal
      ) {
        throw new Error("--shard must satisfy 1 <= index <= total");
      }
      shard = { index: shardIndex, total: shardTotal };
      index += 1;
      continue;
    }
    throw new Error(
      `Unknown argument "${arg}". Usage: run-root-tests.mjs [--group <name>]... [--shard <index>/<total>]`,
    );
  }
  return { groups, shard };
}

const SKIPPED_DIR_NAMES = new Set(["node_modules", "dist", ".git"]);

function toPosix(relPath) {
  return relPath.split(path.sep).join("/");
}

function listFiles(dir, recursive) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive && !SKIPPED_DIR_NAMES.has(entry.name)) {
        out.push(...listFiles(full, true));
      }
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function packageSrcDirs(repoRoot) {
  const packagesDir = path.join(repoRoot, "packages");
  let entries;
  try {
    entries = readdirSync(packagesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(packagesDir, entry.name, "src"));
}

/**
 * Expand every TEST_PATTERNS entry into repo-relative posix paths.
 * Returns { files, emptyPatterns } — callers must treat a non-empty
 * emptyPatterns list as an error (vacuous coverage).
 */
export function expandTestPatterns(repoRoot, patterns = TEST_PATTERNS) {
  const files = new Set();
  const emptyPatterns = [];
  for (const pattern of patterns) {
    const roots = pattern.packageSrc
      ? packageSrcDirs(repoRoot)
      : [path.join(repoRoot, ...pattern.base.split("/"))];
    let matched = 0;
    for (const root of roots) {
      for (const file of listFiles(root, pattern.recursive)) {
        if (file.endsWith(pattern.suffix)) {
          files.add(toPosix(path.relative(repoRoot, file)));
          matched += 1;
        }
      }
    }
    if (matched === 0) {
      emptyPatterns.push(pattern.id);
    }
  }
  return { files: [...files].sort(), emptyPatterns };
}

/** Load and validate the native-dependent test manifest. Throws on malformed input. */
export function loadNativeManifest(manifestPath) {
  const parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${manifestPath}: manifest must be a JSON object`);
  }
  if (parsed.version !== 1) {
    throw new Error(`${manifestPath}: unsupported manifest version ${JSON.stringify(parsed.version)}`);
  }
  if (!Array.isArray(parsed.files) || parsed.files.some((file) => typeof file !== "string")) {
    throw new Error(`${manifestPath}: manifest files must be an array of strings`);
  }
  return { files: [...parsed.files].sort() };
}

/**
 * Split expanded test files into runnable vs native-excluded sets.
 * Manifest entries that match no expanded file are reported as stale so the
 * manifest cannot silently drift from the tree.
 */
export function partitionNativeDependent(files, manifestFiles) {
  const manifest = new Set(manifestFiles);
  const run = [];
  const excluded = [];
  for (const file of files) {
    (manifest.has(file) ? excluded : run).push(file);
  }
  const fileSet = new Set(files);
  const stale = manifestFiles.filter((entry) => !fileSet.has(entry));
  return { run, excluded, stale };
}

/**
 * Greedily chunk argument lists so each spawn's combined argv stays under a
 * conservative character budget — Windows builds one command line with a low
 * length limit, so hundreds of explicit file paths cannot go into a single
 * spawn (cursor review on #1542). A single oversized argument still gets its
 * own chunk rather than being dropped.
 */
export function chunkArgsByLength(args, budgetChars) {
  if (!Number.isInteger(budgetChars) || budgetChars <= 0) {
    throw new Error(`chunkArgsByLength: budgetChars must be a positive integer, got ${budgetChars}`);
  }
  const chunks = [];
  let current = [];
  let currentLength = 0;
  for (const arg of args) {
    const cost = arg.length + 1;
    if (current.length > 0 && currentLength + cost > budgetChars) {
      chunks.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(arg);
    currentLength += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Parse the trailing TAP summary from a node:test run.
 * Returns null when no summary is present (crash before the epilogue).
 */
export function parseTapSummary(output) {
  const summary = {};
  for (const key of ["tests", "pass", "fail", "cancelled", "skipped", "todo"]) {
    const match = output.match(new RegExp(`^# ${key} (\\d+)$`, "m"));
    if (!match) return null;
    summary[key] = Number(match[1]);
  }
  return summary;
}

/**
 * Strong better-sqlite3 probe: importing the JS wrapper succeeds without the
 * native binary, so only constructing a real database proves the binding
 * works. Resolves from packages/remnic-core (the depending package) — never
 * from the repo root, where resolution can walk up into a parent checkout.
 * REMNIC_FORCE_NATIVE_UNAVAILABLE=1 is a test seam that simulates a broken
 * binding without touching node_modules.
 */
export function probeBetterSqlite3(repoRoot, env = process.env) {
  if (env.REMNIC_FORCE_NATIVE_UNAVAILABLE === "1") {
    return { ok: false, reason: "forced unavailable via REMNIC_FORCE_NATIVE_UNAVAILABLE" };
  }
  try {
    const anchor = pathToFileURL(path.join(repoRoot, "packages", "remnic-core", "package.json"));
    const req = createRequire(anchor);
    const loaded = req("better-sqlite3");
    const Database = typeof loaded === "function" ? loaded : loaded?.default;
    if (typeof Database !== "function") {
      return { ok: false, reason: "module did not export a constructor" };
    }
    const db = new Database(":memory:");
    db.pragma("journal_mode = MEMORY");
    db.close();
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: message.split("\n")[0] };
  }
}
