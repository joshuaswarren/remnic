#!/usr/bin/env node
/**
 * Structural ratchets (issue #1529, epic #1520).
 *
 * Fails when structural debt grows past the committed baseline
 * (scripts/ratchet-baseline.json):
 *
 *   1. watchlistLoc            — line counts of the current god files; each
 *                                file's count may only stay equal or shrink.
 *   2. oversizedFileCount      — number of non-test .ts files above the
 *                                oversize threshold under packages/remnic-core/src.
 *   3. scatteredConfigFlagReads — occurrences of `config.<flag>Enabled` reads
 *                                outside config.ts and capabilities.ts (the two
 *                                chokepoints: config defines flags; capabilities
 *                                resolves them to CapabilitySet projections).
 *                                Writes (`config.XEnabled = value`) are excluded;
 *                                the heuristic regex also counts comments/strings
 *                                but the baseline is measured with the same rule.
 *   4. adHocNamespaceResolutions — call sites of the ad-hoc namespace-resolution
 *                                helpers (`resolveWritableNamespace` /
 *                                `namespaceFromStorageDir` /
 *                                `configuredNamespaces`) outside the ScopePlan
 *                                resolver module (scopes/scope-plan.ts). Every
 *                                read/write path should consume a resolved
 *                                ScopePlan instead (issue #1521); this ratchet
 *                                pins the residual count so it can only shrink.
 *   5. unmigratedHandlerCount   — entries in the access-surface catalog
 *                                (access-surface-catalog.ts) with
 *                                `operation: null`: handlers not yet routed
 *                                through the access boundary (issue #1525).
 *                                Every handler must dispatch through the
 *                                operation registry; this ratchet pins the
 *                                residual count so it can only shrink.
 *   6. fileSizeGrandfather      — per-file line-count ceilings for every source
 *                                file above the 1200-line cap across ALL
 *                                packages/<pkg>/src roots and root src/
 *                                (issue #1995, umbrella #1988). New files are
 *                                hard-capped at 1200 lines; grandfathered files
 *                                may only shrink, and --update can only lower
 *                                a ceiling, never raise one.
 *
 * Improvements pass and print a reminder to tighten the baseline with:
 *   node scripts/check-ratchets.mjs --update
 *
 * Node stdlib only, no shell-outs — must stay cross-platform (see #1518).
 *
 * REMNIC_RATCHET_ROOT / REMNIC_RATCHET_BASELINE are test seams used by
 * tests/check-ratchets.test.mjs (absolute paths); they are not user-facing
 * configuration.
 */

import { existsSync, lstatSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.REMNIC_RATCHET_ROOT
  ? path.resolve(process.env.REMNIC_RATCHET_ROOT)
  : path.resolve(SCRIPT_DIR, "..");
const BASELINE_PATH = process.env.REMNIC_RATCHET_BASELINE
  ? path.resolve(process.env.REMNIC_RATCHET_BASELINE)
  : path.join(ROOT, "scripts", "ratchet-baseline.json");
/**
 * Optional changed-file scoping for the file-size ratchet (issue #1995,
 * merge-skew fix): when this env var points at a newline-separated list of
 * repo-relative paths (the PR's changed files), per-file ceiling FAILURES
 * only fire for files in the list. Without it (local runs, pushes to main)
 * every file is evaluated. Rationale: a PR that never touched config.ts
 * must not fail because ANOTHER merged PR grew config.ts on main after
 * this PR's baseline was committed — each PR is judged on its own changes,
 * and main's drift is caught on the PRs that cause it.
 */
const CHANGED_FILES_PATH = process.env.REMNIC_RATCHET_CHANGED_FILES_PATH
  ? path.resolve(process.env.REMNIC_RATCHET_CHANGED_FILES_PATH)
  : null;

function readChangedFileScope() {
  if (!CHANGED_FILES_PATH) return null;
  if (!existsSync(CHANGED_FILES_PATH)) {
    fail(
      `REMNIC_RATCHET_CHANGED_FILES_PATH points at a missing file: ${CHANGED_FILES_PATH} — ` +
        "fix the CI wiring; an empty file means 'no source changes', absence is an error (never silently widen or narrow scope)",
    );
  }
  const scope = new Set();
  // CI writes the scope with `git diff -z -c core.quotePath=off`, so entries
  // are NUL-separated and filenames arrive verbatim (round-3 finding). When
  // ANY NUL is present it is the ONLY separator — filenames may contain
  // literal newlines and must not be split on them (round-5 finding). A
  // NUL-free file (hand-written/local) splits on newlines, with a single
  // trailing \r stripped per entry (CRLF tolerance). Entries are otherwise
  // preserved byte-for-byte: no trim() (space-edged filenames are legal —
  // round-4 finding) and no backslash rewriting (git emits forward-slash
  // separators on every platform; a literal backslash is CONTENT on Linux —
  // round-5 finding).
  const raw = readFileSync(CHANGED_FILES_PATH, "utf8");
  const entries = raw.includes("\0")
    ? raw.split("\0")
    : raw.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  for (const entry of entries) {
    if (entry.length > 0) scope.add(entry);
  }
  return scope;
}

const CORE_SRC = path.join(ROOT, "packages", "remnic-core", "src");
const DEFAULT_OVERSIZE_THRESHOLD_LOC = 3000;

/**
 * File-size ratchet (issue #1995, umbrella #1988).
 *
 * Every non-test .ts source file under packages/<pkg>/src and root src/ is
 * capped at NEW_FILE_SIZE_CAP_LOC lines. Files already above the cap when the
 * baseline was generated are grandfathered with their then-current size as a
 * personal ceiling (metrics.fileSizeGrandfather): they may shrink, never
 * grow. `--update` can only LOWER a ceiling — laundering growth through a
 * baseline refresh is rejected; a deliberate exception requires hand-editing
 * the baseline JSON, which is loud in review.
 */
const NEW_FILE_SIZE_CAP_LOC = 1200;

/** Roots scanned by the file-size ratchet (repo-relative). */
function sizeCapScanRoots() {
  // Symlinked roots are VIOLATIONS, not silently skipped (round-9 finding):
  // skipping a symlinked `packages/<pkg>`, `packages/<pkg>/src`, `packages`,
  // or root `src` would let every file behind it evade the cap while the
  // check stays green. Each symlinked candidate is reported and fails the
  // metrics collection alongside in-root symlinked sources. statSync follows
  // links, so lstat first (round-3 finding).
  // lstat FIRST, tolerating ENOENT (round-12 finding): existsSync FOLLOWS
  // symlinks, so a DANGLING symlinked root returned false and was silently
  // skipped — evading the stated all-symlinked-roots rejection.
  const lstatOrNull = (candidate) => {
    try {
      return lstatSync(candidate);
    } catch {
      return null;
    }
  };
  const isSymlink = (candidate) => lstatOrNull(candidate)?.isSymbolicLink() === true;
  const isRealDirectory = (candidate) => {
    const stats = lstatOrNull(candidate);
    return stats !== null && !stats.isSymbolicLink() && statSync(candidate).isDirectory();
  };
  const roots = [];
  const symlinkedRoots = [];
  const packagesDir = path.join(ROOT, "packages");
  if (isSymlink(packagesDir)) {
    symlinkedRoots.push(toPosix(path.relative(ROOT, packagesDir)));
  } else if (isRealDirectory(packagesDir)) {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      const pkgPath = path.join(packagesDir, entry.name);
      if (entry.isSymbolicLink()) {
        // A symlinked package entry hides everything under it — violation,
        // whether or not it resolves to a directory with a src/.
        symlinkedRoots.push(toPosix(path.relative(ROOT, pkgPath)));
        continue;
      }
      if (!entry.isDirectory()) continue;
      const src = path.join(pkgPath, "src");
      if (isSymlink(src)) {
        symlinkedRoots.push(toPosix(path.relative(ROOT, src)));
        continue;
      }
      if (isRealDirectory(src)) {
        roots.push(src);
      }
    }
  }
  const rootSrc = path.join(ROOT, "src");
  if (isSymlink(rootSrc)) {
    symlinkedRoots.push(toPosix(path.relative(ROOT, rootSrc)));
  } else if (isRealDirectory(rootSrc)) {
    roots.push(rootSrc);
  }
  return { roots: roots.sort(), symlinkedRoots: symlinkedRoots.sort() };
}

/** Repo-relative watchlist paths, always stored with forward slashes. */
const WATCHLIST = [
  "packages/remnic-core/src/orchestrator.ts",
  "packages/remnic-core/src/cli.ts",
  "packages/remnic-core/src/access-service.ts",
  "packages/remnic-core/src/storage.ts",
  "packages/remnic-core/src/config.ts",
];

const FLAG_READ_RE = /\bconfig\.[A-Za-z0-9_]+Enabled\b(?!\s*=[^=])/g;
/**
 * Ad-hoc namespace-resolution call sites (issue #1521): occurrences of the
 * three legacy resolution helpers outside the ScopePlan resolver module. The
 * goal is zero — every path should resolve through `resolveScopePlan` instead.
 * The `\s*\(` anchor targets call/definition sites, excluding local
 * variables named `configuredNamespaces` (e.g. `const configuredNamespaces = …`).
 */
const ADHOC_RESOLUTION_RE =
  /\b(resolveWritableNamespace|namespaceFromStorageDir|configuredNamespaces)\s*\(/g;
const SCOPE_PLAN_REL = "packages/remnic-core/src/scopes/scope-plan.ts";

/**
 * Unmigrated access-surface handlers (issue #1525): entries in the surface
 * catalog with `operation: null` have not yet been routed through the access
 * boundary. The goal is zero — every handler must dispatch through the
 * operation registry. This ratchet pins the residual count so it can only
 * shrink as domain-group migrations land.
 */
const UNMIGRATED_HANDLER_RE = /operation:\s*null\b/;
const SURFACE_CATALOG_REL = "packages/remnic-core/src/access-surface-catalog.ts";
const SKIPPED_DIR_NAMES = new Set(["node_modules", "dist", ".git"]);
// The strict (file-size) walker skips ONLY .git: git itself refuses to track
// paths containing a .git component, so nothing there can be a committed
// source. Everything else under a src root is measurable — "dist" is real
// compiled code under include:["src"] (round-11 finding), and even a
// committed src/node_modules file is compiled when reached through an
// explicit relative import, which tsconfig's default exclude does not
// prevent (round-13 finding).
const STRICT_SKIPPED_DIR_NAMES = new Set([".git"]);
/**
 * Direct imports of the main `storage.ts` module (issue #1533 Phase B): counts
 * non-test source files that import from `./storage.js` or `../storage.js` (the
 * 7.7k-LOC god file) rather than the extracted `storage/*` interface modules.
 * The ratchet may only DECREASE as Phase B migrates the 51+ importers to the
 * `MemoryStorage` interface. Matches relative imports ending in exactly
 * `storage.js` — not sub-paths like `namespaces/storage.js` or `secure-fs.js`.
 */
const DIRECT_STORAGE_IMPORT_RE = /from\s+"(?:\.\.?\/)+storage\.js"/;

function usage() {
  return [
    "Usage: node scripts/check-ratchets.mjs [--update]",
    "",
    "  (no flags)  compare current metrics against scripts/ratchet-baseline.json;",
    "              exit 1 if any structural metric grew",
    "  --update    rewrite the baseline with current metrics (commit the result);",
    "              grandfathered file-size ceilings can only be LOWERED by --update",
    "  --help      show this message",
  ].join("\n");
}

function toPosix(relPath) {
  return relPath.split(path.sep).join("/");
}

function countLines(filePath) {
  // Do not count the empty segment after a trailing newline as a phantom
  // line: a 1,200-line file ending with "\n" must count as 1,200, not
  // 1,201 (round-8 finding). A final line WITHOUT a newline still counts.
  const text = readFileSync(filePath, "utf8");
  if (text.length === 0) return 0;
  const segments = text.split("\n");
  if (segments[segments.length - 1] === "") segments.pop();
  return segments.length;
}

function isCountedSourceFile(name) {
  // .ts/.tsx/.mts/.cts all compile under the packages' tsconfig "src"
  // globs (round-7 + round-8 findings: bench-ui compiles JSX; TypeScript
  // compiles .mts/.cts under the same include glob) — a giant .tsx, .mts,
  // or .cts would otherwise evade the cap. Declarations (.d.*) and tests
  // stay excluded. Legacy #1529 metrics scan only remnic-core/src, which
  // has neither — their counts are unaffected.
  const excluded = [
    ".test.ts", ".test.tsx", ".test.mts", ".test.cts",
    ".d.ts", ".d.mts", ".d.cts",
  ];
  return (
    [".ts", ".tsx", ".mts", ".cts"].some((ext) => name.endsWith(ext)) &&
    !excluded.some((ext) => name.endsWith(ext))
  );
}

/** Recursively list non-test .ts files under dir. Symlinks are skipped. */
function walkSourceFiles(dir) {
  const out = [];
  if (!existsSync(dir)) {
    return out;
  }
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIR_NAMES.has(entry.name)) {
        out.push(...walkSourceFiles(full));
      }
    } else if (entry.isFile() && isCountedSourceFile(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Strict variant for the file-size ratchet (issue #1995 round 6): identical
 * traversal, but a SYMLINK whose name looks like a counted source file (or a
 * symlinked subdirectory) is recorded as a violation instead of silently
 * skipped — otherwise `giant.ts -> elsewhere` would evade the line cap while
 * still compiling as part of the package.
 */
function walkSourceFilesStrict(dir) {
  const files = [];
  const symlinkedSources = [];
  if (!existsSync(dir)) {
    return { files, symlinkedSources };
  }
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      // ANY symlink inside a scan root is a counting-evasion vector
      // (`giant.ts -> elsewhere`, or a symlinked subtree) — record it.
      symlinkedSources.push(toPosix(path.relative(ROOT, full)));
      continue;
    }
    if (entry.isDirectory()) {
      // Inside a src scan root, only node_modules and .git can never be
      // source children (tsconfig's default exclude covers node_modules).
      // A `src/dist/large.ts` IS compiled production code under
      // `include: ["src"]` and must be measured — skipping every dir named
      // "dist" here let such a module bypass the cap (round-11 finding).
      if (!STRICT_SKIPPED_DIR_NAMES.has(entry.name)) {
        const nested = walkSourceFilesStrict(full);
        files.push(...nested.files);
        symlinkedSources.push(...nested.symlinkedSources);
      }
    } else if (entry.isFile() && isCountedSourceFile(entry.name)) {
      files.push(full);
    }
  }
  return { files, symlinkedSources };
}

function collectMetrics(oversizeThresholdLoc) {
  // `null` marks a watchlist file that is missing on disk. That is never an
  // improvement: a rename would otherwise evade the per-file ratchet while
  // the debt lives on under a new name. Missing files fail the check (and
  // block --update) until the WATCHLIST is deliberately edited.
  const watchlistLoc = {};
  const missingWatchlistFiles = [];
  for (const relPath of WATCHLIST) {
    const abs = path.join(ROOT, ...relPath.split("/"));
    if (existsSync(abs) && statSync(abs).isFile()) {
      watchlistLoc[relPath] = countLines(abs);
    } else {
      watchlistLoc[relPath] = null;
      missingWatchlistFiles.push(relPath);
    }
  }

  const sourceFiles = walkSourceFiles(CORE_SRC).sort();
  const oversizedFiles = [];
  let scatteredConfigFlagReads = 0;
  let adHocNamespaceResolutions = 0;
  let directStorageImports = 0;
  for (const file of sourceFiles) {
    const relPosix = toPosix(path.relative(ROOT, file));
    const content = readFileSync(file, "utf8");
    const lines = content.split("\n").length;
    if (lines > oversizeThresholdLoc) {
      oversizedFiles.push({ file: relPosix, lines });
    }
    if (
      relPosix !== "packages/remnic-core/src/config.ts" &&
      relPosix !== "packages/remnic-core/src/capabilities.ts"
    ) {
      const matches = content.match(FLAG_READ_RE);
      if (matches) {
        scatteredConfigFlagReads += matches.length;
      }
    }
    if (relPosix !== SCOPE_PLAN_REL) {
      const adHocMatches = content.match(ADHOC_RESOLUTION_RE);
      if (adHocMatches) {
        adHocNamespaceResolutions += adHocMatches.length;
      }
    }
    // Issue #1533: count files importing directly from the main storage.ts
    // (exclude storage.ts itself, and exclude the test-only storage-contract/
    // harness dir — it imports storage.js by design to exercise the public
    // surface, not as a production caller). May only decrease as Phase B
    // migrates real importers to the MemoryStorage interface.
    if (
      relPosix !== "packages/remnic-core/src/storage.ts" &&
      !relPosix.includes("/storage-contract/") &&
      // The storage/ subdirectory hosts StorageManager's own decomposition
      // modules (entity-store, ...): they ARE the storage subsystem, not
      // external importers, and importing the barrel instead creates a
      // module-initialization cycle (index -> access-* -> ... -> storage).
      !relPosix.startsWith("packages/remnic-core/src/storage/") &&
      DIRECT_STORAGE_IMPORT_RE.test(content)
    ) {
      directStorageImports++;
    }
  }

  // Unmigrated access-surface handlers (issue #1525): count catalog entries
  // still routed through surface-local validation instead of the boundary.
  // Only data-entry lines (start with `{`) are counted — doc comments also
  // mention `operation: null` and must not inflate the count.
  const catalogPath = path.join(ROOT, ...SURFACE_CATALOG_REL.split("/"));
  let unmigratedHandlerCount = 0;
  if (existsSync(catalogPath) && statSync(catalogPath).isFile()) {
    const catalogSrc = readFileSync(catalogPath, "utf8");
    for (const line of catalogSrc.split("\n")) {
      const t = line.trim();
      if (t.startsWith("{") && UNMIGRATED_HANDLER_RE.test(t)) {
        unmigratedHandlerCount += 1;
      }
    }
  }

  // File-size ratchet (issue #1995): every source file over the cap, across
  // ALL package src roots + root src/, keyed by repo-relative posix path.
  const oversizeByFile = {};
  const scanRoots = sizeCapScanRoots();
  // Symlinked roots fail the check exactly like symlinked sources inside a
  // real root (round-9 finding): both are counting-evasion vectors.
  const symlinkedSourceEntries = [...scanRoots.symlinkedRoots];
  for (const rootDir of scanRoots.roots) {
    const { files: rootFiles, symlinkedSources } = walkSourceFilesStrict(rootDir);
    symlinkedSourceEntries.push(...symlinkedSources);
    for (const file of rootFiles) {
      const lines = countLines(file);
      if (lines > NEW_FILE_SIZE_CAP_LOC) {
        oversizeByFile[toPosix(path.relative(ROOT, file))] = lines;
      }
    }
  }
  symlinkedSourceEntries.sort();

  return {
    watchlistLoc,
    missingWatchlistFiles,
    oversizedFiles,
    oversizedFileCount: oversizedFiles.length,
    oversizeByFile,
    symlinkedSourceEntries,
    scatteredConfigFlagReads,
    adHocNamespaceResolutions,
    unmigratedHandlerCount,
    directStorageImports,
  };
}

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) {
    fail(
      `baseline not found at ${BASELINE_PATH}. Generate one with ` +
        "`node scripts/check-ratchets.mjs --update` and commit it.",
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  } catch (error) {
    fail(`baseline is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail("baseline must be a JSON object");
  }
  if (parsed.version !== 1) {
    fail(`unsupported baseline version ${JSON.stringify(parsed.version)}; expected 1`);
  }
  const metrics = parsed.metrics;
  if (typeof metrics !== "object" || metrics === null) {
    fail("baseline is missing the metrics object");
  }
  if (typeof metrics.watchlistLoc !== "object" || metrics.watchlistLoc === null) {
    fail("baseline metrics.watchlistLoc must be an object");
  }
  for (const [file, lines] of Object.entries(metrics.watchlistLoc)) {
    if (!Number.isInteger(lines) || lines < 0) {
      fail(`baseline metrics.watchlistLoc entry ${file} must be a non-negative integer`);
    }
  }
  for (const key of ["oversizedFileCount", "scatteredConfigFlagReads", "adHocNamespaceResolutions", "unmigratedHandlerCount", "directStorageImports"]) {
    if (!Number.isInteger(metrics[key]) || metrics[key] < 0) {
      fail(`baseline metrics.${key} must be a non-negative integer`);
    }
  }
  // fileSizeGrandfather (issue #1995) may be ABSENT on a legacy baseline —
  // the comparison in main() then fails with a regenerate hint. Absence must
  // not fail here or `--update` could never migrate a legacy baseline.
  if (metrics.fileSizeGrandfather !== undefined) {
    if (
      typeof metrics.fileSizeGrandfather !== "object" ||
      metrics.fileSizeGrandfather === null ||
      Array.isArray(metrics.fileSizeGrandfather)
    ) {
      fail("baseline metrics.fileSizeGrandfather must be an object when present (issue #1995)");
    }
    for (const [file, ceiling] of Object.entries(metrics.fileSizeGrandfather)) {
      if (!Number.isInteger(ceiling) || ceiling <= NEW_FILE_SIZE_CAP_LOC) {
        fail(
          `baseline metrics.fileSizeGrandfather entry ${file} must be an integer above ` +
            `${NEW_FILE_SIZE_CAP_LOC} — entries at or under the cap must simply be removed`,
        );
      }
    }
  }
  const threshold = parsed.oversizeThresholdLoc;
  if (!Number.isInteger(threshold) || threshold <= 0) {
    fail("baseline oversizeThresholdLoc must be a positive integer");
  }
  return parsed;
}

function writeBaseline(metrics, oversizeThresholdLoc) {
  const baseline = {
    version: 1,
    note:
      "Structural ratchets (issue #1529, epic #1520). Counts may only decrease. " +
      "Regenerate with: node scripts/check-ratchets.mjs --update",
    oversizeThresholdLoc,
    metrics: {
      watchlistLoc: metrics.watchlistLoc,
      oversizedFileCount: metrics.oversizedFileCount,
      fileSizeGrandfather: Object.fromEntries(
        Object.entries(metrics.oversizeByFile).sort(([a], [b]) => a.localeCompare(b)),
      ),
      scatteredConfigFlagReads: metrics.scatteredConfigFlagReads,
      adHocNamespaceResolutions: metrics.adHocNamespaceResolutions,
      unmigratedHandlerCount: metrics.unmigratedHandlerCount,
      directStorageImports: metrics.directStorageImports,
    },
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
}

function fail(message) {
  console.error(`[ratchet] ERROR: ${message}`);
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== "--update" && arg !== "--help");
  if (unknown.length > 0) {
    console.error(`[ratchet] ERROR: unknown argument(s): ${unknown.join(", ")}`);
    console.error(usage());
    process.exit(2);
  }
  if (args.includes("--help")) {
    console.log(usage());
    return;
  }

  if (args.includes("--update")) {
    const metrics = collectMetrics(DEFAULT_OVERSIZE_THRESHOLD_LOC);
    if (metrics.missingWatchlistFiles.length > 0) {
      fail(
        `cannot write baseline: watchlist file(s) missing on disk: ${metrics.missingWatchlistFiles.join(", ")}. ` +
          "If a god file was deliberately split or renamed, remove it from WATCHLIST in this script first, then rerun --update.",
      );
    }
    // Issue #1995: --update may only LOWER a grandfathered ceiling, and may
    // never grandfather a file that became oversized AFTER the previous
    // baseline (review finding on PR #2000: refresh would silently adopt new
    // >cap files). Growth and new-file adoption both require shrinking the
    // file; a deliberate exception requires hand-editing the baseline JSON
    // (loud in review). First generation (no baseline on disk) bootstraps
    // the grandfather set as-is — that one-time adoption ships in the PR
    // that introduces the baseline and is itself reviewed.
    if (existsSync(BASELINE_PATH)) {
      const previous = readBaseline();
      const previousCeilings = previous.metrics.fileSizeGrandfather;
      // A legacy baseline (predating the metric) also bootstraps as-is: the
      // migration --update runs in the PR that introduces the metric.
      if (previousCeilings !== undefined) {
        // Blame scoping mirrors the check path: with a changed-file scope
        // (REMNIC_RATCHET_CHANGED_FILES_PATH = this branch's own diff),
        // the guard only blocks growth in files THIS change touched.
        // Growth that arrived via merges to main was judged on the PRs
        // that caused it and may be refreshed into the baseline.
        const changedScope = readChangedFileScope();
        const inScope = (file) => changedScope === null || changedScope.has(file);
        const laundered = [];
        const newlyOversized = [];
        for (const [file, lines] of Object.entries(metrics.oversizeByFile)) {
          const ceiling = previousCeilings[file];
          if (ceiling === undefined) {
            if (inScope(file)) newlyOversized.push(`${file} (${lines})`);
          } else if (lines > ceiling) {
            if (inScope(file)) laundered.push(`${file} (${ceiling} -> ${lines})`);
          }
        }
        if (laundered.length > 0 || newlyOversized.length > 0) {
          const parts = [];
          if (laundered.length > 0) {
            parts.push(`grandfathered file(s) grew past their ceiling: ${laundered.join(", ")}`);
          }
          if (newlyOversized.length > 0) {
            parts.push(
              `file(s) became oversized since the previous baseline and cannot be grandfathered: ${newlyOversized.join(", ")}`,
            );
          }
          fail(
            `cannot write baseline: ${parts.join("; ")}. ` +
              `Shrink the file(s) to ${NEW_FILE_SIZE_CAP_LOC} lines or extract sibling modules first — --update never raises or adds a ceiling.`,
          );
        }
        // Out-of-scope raises are permitted (that growth was judged on the
        // PRs that landed it on main) but NEVER silent: each one is printed
        // so the baseline diff review sees exactly what moved and why
        // (review finding on PR #2000 round 2).
        for (const [file, lines] of Object.entries(metrics.oversizeByFile).sort(([a], [b]) => a.localeCompare(b))) {
          const ceiling = previousCeilings[file];
          if (ceiling !== undefined && lines > ceiling && !inScope(file)) {
            console.log(
              `[ratchet]   ceiling raised (out-of-scope growth inherited from main): ${file} ${ceiling} -> ${lines}`,
            );
          } else if (ceiling === undefined && !inScope(file)) {
            console.log(
              `[ratchet]   grandfathered (out-of-scope, new on main): ${file} (${lines})`,
            );
          }
        }
      }
    }
    writeBaseline(metrics, DEFAULT_OVERSIZE_THRESHOLD_LOC);
    console.log(`[ratchet] baseline written to ${BASELINE_PATH}`);
    for (const [file, lines] of Object.entries(metrics.watchlistLoc)) {
      console.log(`[ratchet]   watchlist ${file}: ${lines}`);
    }
    console.log(`[ratchet]   oversizedFileCount (> ${DEFAULT_OVERSIZE_THRESHOLD_LOC} LOC): ${metrics.oversizedFileCount}`);
    console.log(`[ratchet]   scatteredConfigFlagReads: ${metrics.scatteredConfigFlagReads}`);
    console.log(`[ratchet]   adHocNamespaceResolutions: ${metrics.adHocNamespaceResolutions}`);
    console.log(`[ratchet]   unmigratedHandlerCount: ${metrics.unmigratedHandlerCount}`);
    console.log(`[ratchet]   directStorageImports: ${metrics.directStorageImports}`);
    console.log(
      `[ratchet]   fileSizeGrandfather (> ${NEW_FILE_SIZE_CAP_LOC} LOC): ${Object.keys(metrics.oversizeByFile).length} files`,
    );
    return;
  }

  const baseline = readBaseline();
  const threshold = baseline.oversizeThresholdLoc;
  const current = collectMetrics(threshold);
  const failures = [];
  const improvements = [];

  // The baseline and the script's WATCHLIST must describe the same set of
  // files; a silent mismatch would leave a watchlist file unchecked (or make
  // a delisted file look like an improvement).
  for (const file of WATCHLIST) {
    if (!(file in baseline.metrics.watchlistLoc)) {
      failures.push(`watchlist file ${file} is missing from the baseline — regenerate with --update`);
    }
  }
  for (const [file, baseLines] of Object.entries(baseline.metrics.watchlistLoc)) {
    if (!WATCHLIST.includes(file)) {
      failures.push(
        `baseline watchlist entry ${file} is no longer in the script watchlist — regenerate with --update`,
      );
      continue;
    }
    const currentLines = current.watchlistLoc[file];
    if (currentLines === null || currentLines === undefined) {
      failures.push(
        `${file} no longer exists but is still ratcheted — if this is a deliberate split/rename, ` +
          "remove it from WATCHLIST and regenerate the baseline with --update in the same PR",
      );
    } else if (currentLines > baseLines) {
      failures.push(`${file} grew from ${baseLines} to ${currentLines} lines`);
    } else if (currentLines < baseLines) {
      improvements.push(`${file}: ${baseLines} -> ${currentLines} lines`);
    }
  }

  if (current.oversizedFileCount > baseline.metrics.oversizedFileCount) {
    const list = current.oversizedFiles
      .sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file))
      .map((entry) => `${entry.file} (${entry.lines})`)
      .join(", ");
    failures.push(
      `files over ${threshold} LOC grew from ${baseline.metrics.oversizedFileCount} ` +
        `to ${current.oversizedFileCount}: ${list}`,
    );
  } else if (current.oversizedFileCount < baseline.metrics.oversizedFileCount) {
    improvements.push(
      `oversized files: ${baseline.metrics.oversizedFileCount} -> ${current.oversizedFileCount}`,
    );
  }

  // File-size ratchet (issue #1995): per-file ceilings across all src roots.
  const baselineCeilings = baseline.metrics.fileSizeGrandfather;
  if (baselineCeilings === undefined) {
    failures.push(
      "baseline predates the file-size ratchet (missing metrics.fileSizeGrandfather) — " +
        "regenerate with `node scripts/check-ratchets.mjs --update` and commit it",
    );
  } else {
    // Merge-skew scoping: in PR CI, ceiling FAILURES only fire for files the
    // PR itself changed (see readChangedFileScope). Improvements are always
    // reported — they carry no blame.
    const changedScope = readChangedFileScope();
    const inScope = (file) => changedScope === null || changedScope.has(file);
    // Symlinks inside scan roots are counting-evasion vectors (round-6
    // finding: `giant.ts -> elsewhere` would compile but never be counted).
    // Same blame scoping as ceilings: only symlinks THIS change introduced
    // fail its CI run.
    for (const link of current.symlinkedSourceEntries ?? []) {
      if (inScope(link)) {
        failures.push(
          `${link} is a symlink inside a file-size scan root (issue #1995) — source files and directories ` +
            "must be regular; symlinked sources evade the line cap and are not permitted.",
        );
      }
    }
    const sortedOversize = Object.entries(current.oversizeByFile).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    for (const [file, lines] of sortedOversize) {
      const ceiling = baselineCeilings[file];
      if (ceiling === undefined) {
        if (inScope(file)) {
          failures.push(
            `${file} is ${lines} lines — new source files are capped at ${NEW_FILE_SIZE_CAP_LOC} LOC (issue #1995). ` +
              "Either extract the addition into a sibling module, or shrink the file to the cap. " +
              "Grandfathering new files is not available.",
          );
        }
      } else if (lines > ceiling) {
        if (inScope(file)) {
          failures.push(
            `${file} grew from its grandfathered ceiling ${ceiling} to ${lines} lines (issue #1995). ` +
              "Extract the addition into a sibling module, or shrink the file elsewhere by at least the addition.",
          );
        }
      } else if (lines < ceiling) {
        improvements.push(`file-size ceiling ${file}: ${ceiling} -> ${lines} lines`);
      }
    }
    for (const file of Object.keys(baselineCeilings).sort()) {
      if (!(file in current.oversizeByFile)) {
        improvements.push(
          `file-size ceiling ${file}: now at/under the ${NEW_FILE_SIZE_CAP_LOC}-line cap (or removed) — prune with --update`,
        );
      }
    }
  }

  if (current.scatteredConfigFlagReads > baseline.metrics.scatteredConfigFlagReads) {
    failures.push(
      `scattered config.*Enabled reads grew from ${baseline.metrics.scatteredConfigFlagReads} ` +
        `to ${current.scatteredConfigFlagReads} (resolve gates through the shared plan instead; see #1523)`,
    );
  } else if (current.scatteredConfigFlagReads < baseline.metrics.scatteredConfigFlagReads) {
    improvements.push(
      `scattered config.*Enabled reads: ${baseline.metrics.scatteredConfigFlagReads} -> ${current.scatteredConfigFlagReads}`,
    );
  }

  if (current.adHocNamespaceResolutions > baseline.metrics.adHocNamespaceResolutions) {
    failures.push(
      `ad-hoc namespace-resolution call sites grew from ${baseline.metrics.adHocNamespaceResolutions} ` +
        `to ${current.adHocNamespaceResolutions} (resolve through the ScopePlan resolver instead; see #1521)`,
    );
  } else if (current.adHocNamespaceResolutions < baseline.metrics.adHocNamespaceResolutions) {
    improvements.push(
      `ad-hoc namespace-resolution call sites: ${baseline.metrics.adHocNamespaceResolutions} -> ${current.adHocNamespaceResolutions}`,
    );
  }

  if (current.unmigratedHandlerCount > baseline.metrics.unmigratedHandlerCount) {
    failures.push(
      `unmigrated access-surface handlers grew from ${baseline.metrics.unmigratedHandlerCount} ` +
        `to ${current.unmigratedHandlerCount} (route new handlers through the access boundary; see #1525)`,
    );
  } else if (current.unmigratedHandlerCount < baseline.metrics.unmigratedHandlerCount) {
    improvements.push(
      `unmigrated access-surface handlers: ${baseline.metrics.unmigratedHandlerCount} -> ${current.unmigratedHandlerCount}`,
    );
  }
  if (current.directStorageImports > baseline.metrics.directStorageImports) {
    failures.push(
      `direct storage.ts imports grew from ${baseline.metrics.directStorageImports} ` +
        `to ${current.directStorageImports} (migrate importers to the MemoryStorage interface; see #1533)`,
    );
  } else if (current.directStorageImports < baseline.metrics.directStorageImports) {
    improvements.push(
      `direct storage.ts imports: ${baseline.metrics.directStorageImports} -> ${current.directStorageImports}`,
    );
  }

  if (failures.length > 0) {
    console.error("[ratchet] structural ratchet exceeded — this change grows debt tracked in #1520:");
    for (const failure of failures) {
      console.error(`[ratchet]   - ${failure}`);
    }
    console.error(
      "[ratchet] reduce the metric, or — only with a reviewed justification — run " +
        "`node scripts/check-ratchets.mjs --update` and commit the new baseline.",
    );
    process.exit(1);
  }

  if (improvements.length > 0) {
    console.log("[ratchet] improvements detected — consider tightening the baseline (--update):");
    for (const improvement of improvements) {
      console.log(`[ratchet]   - ${improvement}`);
    }
  }
  console.log("[ratchet] OK");
}

main();
