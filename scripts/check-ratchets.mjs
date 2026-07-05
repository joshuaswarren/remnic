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
 *                                outside config.ts (heuristic regex; counts
 *                                comments/strings too, but the baseline is
 *                                measured with the same rule, so the ratchet
 *                                direction stays meaningful).
 *   4. adHocNamespaceResolutions — call sites of the ad-hoc namespace-resolution
 *                                helpers (`resolveWritableNamespace` /
 *                                `namespaceFromStorageDir` /
 *                                `configuredNamespaces`) outside the ScopePlan
 *                                resolver module (scopes/scope-plan.ts). Every
 *                                read/write path should consume a resolved
 *                                ScopePlan instead (issue #1521); this ratchet
 *                                pins the residual count so it can only shrink.
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

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

const CORE_SRC = path.join(ROOT, "packages", "remnic-core", "src");
const DEFAULT_OVERSIZE_THRESHOLD_LOC = 3000;

/** Repo-relative watchlist paths, always stored with forward slashes. */
const WATCHLIST = [
  "packages/remnic-core/src/orchestrator.ts",
  "packages/remnic-core/src/cli.ts",
  "packages/remnic-core/src/access-service.ts",
  "packages/remnic-core/src/storage.ts",
  "packages/remnic-core/src/config.ts",
];

const FLAG_READ_RE = /\bconfig\.[A-Za-z0-9_]+Enabled\b/g;
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
const SKIPPED_DIR_NAMES = new Set(["node_modules", "dist", ".git"]);

function usage() {
  return [
    "Usage: node scripts/check-ratchets.mjs [--update]",
    "",
    "  (no flags)  compare current metrics against scripts/ratchet-baseline.json;",
    "              exit 1 if any structural metric grew",
    "  --update    rewrite the baseline with current metrics (commit the result)",
    "  --help      show this message",
  ].join("\n");
}

function toPosix(relPath) {
  return relPath.split(path.sep).join("/");
}

function countLines(filePath) {
  return readFileSync(filePath, "utf8").split("\n").length;
}

function isCountedSourceFile(name) {
  return (
    name.endsWith(".ts") &&
    !name.endsWith(".test.ts") &&
    !name.endsWith(".d.ts")
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
  for (const file of sourceFiles) {
    const relPosix = toPosix(path.relative(ROOT, file));
    const content = readFileSync(file, "utf8");
    const lines = content.split("\n").length;
    if (lines > oversizeThresholdLoc) {
      oversizedFiles.push({ file: relPosix, lines });
    }
    if (relPosix !== "packages/remnic-core/src/config.ts") {
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
  }

  return {
    watchlistLoc,
    missingWatchlistFiles,
    oversizedFiles,
    oversizedFileCount: oversizedFiles.length,
    scatteredConfigFlagReads,
    adHocNamespaceResolutions,
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
  for (const key of ["oversizedFileCount", "scatteredConfigFlagReads", "adHocNamespaceResolutions"]) {
    if (!Number.isInteger(metrics[key]) || metrics[key] < 0) {
      fail(`baseline metrics.${key} must be a non-negative integer`);
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
      scatteredConfigFlagReads: metrics.scatteredConfigFlagReads,
      adHocNamespaceResolutions: metrics.adHocNamespaceResolutions,
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
    writeBaseline(metrics, DEFAULT_OVERSIZE_THRESHOLD_LOC);
    console.log(`[ratchet] baseline written to ${BASELINE_PATH}`);
    for (const [file, lines] of Object.entries(metrics.watchlistLoc)) {
      console.log(`[ratchet]   watchlist ${file}: ${lines}`);
    }
    console.log(`[ratchet]   oversizedFileCount (> ${DEFAULT_OVERSIZE_THRESHOLD_LOC} LOC): ${metrics.oversizedFileCount}`);
    console.log(`[ratchet]   scatteredConfigFlagReads: ${metrics.scatteredConfigFlagReads}`);
    console.log(`[ratchet]   adHocNamespaceResolutions: ${metrics.adHocNamespaceResolutions}`);
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
