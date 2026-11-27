#!/usr/bin/env node

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

const NEW_FILE_SIZE_CAP_LOC = 1200;

function sizeCapScanRoots() {
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
const ADHOC_RESOLUTION_RE =
  /\b(resolveWritableNamespace|namespaceFromStorageDir|configuredNamespaces)\s*\(/g;
const SCOPE_PLAN_REL = "packages/remnic-core/src/scopes/scope-plan.ts";

const UNMIGRATED_HANDLER_RE = /operation:\s*null\b/;
const SURFACE_CATALOG_REL = "packages/remnic-core/src/access-surface-catalog.ts";
const SKIPPED_DIR_NAMES = new Set(["node_modules", "dist", ".git"]);
const STRICT_SKIPPED_DIR_NAMES = new Set([".git"]);
const DIRECT_STORAGE_IMPORT_RE = /from\s+"(?:\.\.?\/)+storage\.js"/;
const TYPE_ONLY_IMPORT_RE = /^\s*import\s+type\s/;

function hasValueStorageImport(content) {
  for (const line of content.split("\n")) {
    if (!DIRECT_STORAGE_IMPORT_RE.test(line)) continue;
    if (TYPE_ONLY_IMPORT_RE.test(line)) continue;
    return true;
  }
  return false;
}

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
  const text = readFileSync(filePath, "utf8");
  if (text.length === 0) return 0;
  const segments = text.split(/\r\n|\r|\n/);
  if (segments[segments.length - 1] === "") segments.pop();
  return segments.length;
}

function isCountedSourceFile(name) {
  const excluded = [
    ".test.ts", ".test.tsx", ".test.mts", ".test.cts",
    ".d.ts", ".d.mts", ".d.cts",
  ];
  return (
    [".ts", ".tsx", ".mts", ".cts"].some((ext) => name.endsWith(ext)) &&
    !excluded.some((ext) => name.endsWith(ext))
  );
}

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
      symlinkedSources.push(toPosix(path.relative(ROOT, full)));
      continue;
    }
    if (entry.isDirectory()) {
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
    if (
      relPosix !== "packages/remnic-core/src/storage.ts" &&
      !relPosix.includes("/storage-contract/") &&
      !relPosix.startsWith("packages/remnic-core/src/storage/") &&
      hasValueStorageImport(content)
    ) {
      directStorageImports++;
    }
  }

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

  const oversizeByFile = {};
  const scanRoots = sizeCapScanRoots();
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
    if (metrics.symlinkedSourceEntries.length > 0) {
      fail(
        `cannot write baseline: symlinked source entries present: ${metrics.symlinkedSourceEntries.join(", ")}. ` +
          "Remove the symlink(s) — symlinked sources and scan roots are counting-evasion vectors and always fail the check.",
      );
    }
    if (metrics.missingWatchlistFiles.length > 0) {
      fail(
        `cannot write baseline: watchlist file(s) missing on disk: ${metrics.missingWatchlistFiles.join(", ")}. ` +
          "If a god file was deliberately split or renamed, remove it from WATCHLIST in this script first, then rerun --update.",
      );
    }
    if (existsSync(BASELINE_PATH)) {
      const previous = readBaseline();
      const previousCeilings = previous.metrics.fileSizeGrandfather;
      if (previousCeilings !== undefined) {
        const changedScope = readChangedFileScope();
        const scopedUpdate = changedScope !== null && changedScope.size > 0;
        const inScope = (file) => !scopedUpdate || changedScope.has(file);
        const laundered = [];
        const newlyOversized = [];
        for (const [file, lines] of Object.entries(metrics.oversizeByFile)) {
          const ceiling = previousCeilings[file];
          if (ceiling === undefined) {
            newlyOversized.push(`${file} (${lines})`);
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
        for (const [file, lines] of Object.entries(metrics.oversizeByFile).sort(([a], [b]) => a.localeCompare(b))) {
          const ceiling = previousCeilings[file];
          if (ceiling !== undefined && lines > ceiling && !inScope(file)) {
            console.log(
              `[ratchet]   ceiling raised (out-of-scope growth inherited from main): ${file} ${ceiling} -> ${lines}`,
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
  const warnings = [];

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

  const baselineCeilings = baseline.metrics.fileSizeGrandfather;
  if (baselineCeilings === undefined) {
    failures.push(
      "baseline predates the file-size ratchet (missing metrics.fileSizeGrandfather) — " +
        "regenerate with `node scripts/check-ratchets.mjs --update` and commit it",
    );
  } else {
    const changedScope = readChangedFileScope();
    const inScope = (file) => changedScope === null || changedScope.has(file);
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
              "Extract the addition into a sibling module, or shrink the file elsewhere by at least the addition. " +
              "If this is a merge with main, rebase first — CI measures the merge commit, not the branch tip.",
          );
        }
      } else if (lines < ceiling) {
        improvements.push(`file-size ceiling ${file}: ${ceiling} -> ${lines} lines`);
        if (inScope(file) && ceiling - lines < 20) {
          warnings.push(
            `${file} has only ${ceiling - lines} LOC of headroom (${lines}/${ceiling}) — ` +
              "put additions in a sibling module",
          );
        }
      } else if (inScope(file) && lines === ceiling) {
        warnings.push(
          `${file} is EXACTLY at its ceiling ${ceiling} — any added line fails this gate; ` +
            "extract instead, and note that CI measures the merge commit, so merging main can push it over on its own",
        );
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
  if (warnings.length > 0 && readChangedFileScope() !== null) {
    console.log("");
    console.log("[ratchet] WARNING — you are editing files with no room to grow:");
    for (const warning of warnings) {
      console.log(`[ratchet]   ! ${warning}`);
    }
    console.log("");
  }
  console.log("[ratchet] OK");
}

main();
