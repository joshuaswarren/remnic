#!/usr/bin/env node
/**
 * Lifecycle scenario-matrix coverage gate (issue #1993, umbrella #1988 phase 5).
 *
 * When a PR's EFFECTIVE diff (changed files minus ai-review-ignore artifact
 * paths — reusing scripts/effective-diff.mjs) touches a lifecycle-critical path
 * in scripts/lifecycle-matrix/coverage.json's `lifecycleManifest`, this gate
 * requires that path to be covered by a registered `LifecycleSubject`
 * (packages/remnic-core/src/testing/subjects). Grandfathered paths (decision C)
 * warn instead of fail; the grandfather list is a ratchet — it may shrink,
 * never grow. A manifest glob with no coverage mapping and no grandfather entry
 * fails the gate, naming the path and the manifest.
 *
 * The matrix TESTS run in the normal suite; this gate enforces the EXISTENCE of
 * coverage, the suite enforces the behavior.
 *
 * Pure functions below are the tested surface (tests/lifecycle-matrix-coverage.test.mjs);
 * the CLI at the bottom wires them to git + the repo manifest.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

import { isIgnoredPath, parseIgnoreManifest, splitEffectiveDiff } from "../effective-diff.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(scriptDir));

/**
 * A manifest glob must be usable by {@link isIgnoredPath}, which matches
 * repo-relative POSIX paths. Patterns that can never match such a path — a
 * leading `/`, negation, backslashes, or surrounding whitespace — are a
 * manifest ERROR, not silently accepted; otherwise a touched lifecycle file
 * slips through uncovered. Mirrors the documented subset in scripts/effective-diff.mjs.
 */
function validateManifestGlob(glob) {
  if (typeof glob !== "string" || glob.length === 0) {
    throw new Error(`coverage manifest: lifecycleManifest entry must be a non-empty string (got ${JSON.stringify(glob)})`);
  }
  if (glob !== glob.trim()) {
    throw new Error(`coverage manifest: glob ${JSON.stringify(glob)} has leading/trailing whitespace and cannot match a repo-relative path`);
  }
  if (glob.startsWith("!") || glob.startsWith("/")) {
    throw new Error(
      `coverage manifest: unsupported glob ${JSON.stringify(glob)} — negation and leading-slash forms never match repo-relative paths (see scripts/effective-diff.mjs)`,
    );
  }
  if (glob.includes("\\")) {
    throw new Error(`coverage manifest: glob ${JSON.stringify(glob)} must use forward slashes, not backslashes`);
  }
}

const SUBJECT_IDENT = /[A-Za-z0-9_$]/;
const SUBJECT_CALL = "runLifecycleMatrix";

/**
 * Discover `runLifecycleMatrix("<name>", ...)` registrations in JS/TS source at
 * the CODE level: a single scan skips comments AND string/template literals, so
 * neither a commented-out example nor a docs string like
 * `const doc = 'runLifecycleMatrix("fake", subject)'` is mistaken for a real
 * registration — only a genuine call, whose first string argument is the
 * subject name, is recorded. A raw regex over the file text counts both and
 * lets a coverage mapping pass while the matrix runs no such subject.
 */
export function discoverSubjectRegistrations(source) {
  const names = [];
  const n = source.length;
  let i = 0;
  let quote = null;
  while (i < n) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < n && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (
      ch === "r" &&
      source.startsWith(SUBJECT_CALL, i) &&
      (i === 0 || !SUBJECT_IDENT.test(source[i - 1])) &&
      !SUBJECT_IDENT.test(source[i + SUBJECT_CALL.length] ?? "")
    ) {
      let j = i + SUBJECT_CALL.length;
      while (j < n && /\s/.test(source[j])) j += 1;
      if (source[j] === "(") {
        j += 1;
        while (j < n && /\s/.test(source[j])) j += 1;
        const q = source[j];
        if (q === '"' || q === "'") {
          j += 1;
          let name = "";
          while (j < n && source[j] !== q) {
            if (source[j] === "\\") {
              name += source[j + 1] ?? "";
              j += 2;
              continue;
            }
            name += source[j];
            j += 1;
          }
          if (name.length > 0) names.push(name);
          i = j + 1;
          continue;
        }
      }
      i += SUBJECT_CALL.length;
      continue;
    }
    i += 1;
  }
  return names;
}

/**
 * Parse + validate a coverage manifest object. Throws on structural errors so a
 * malformed manifest fails the gate loudly instead of silently under-checking.
 */
export function loadCoverageManifest(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("coverage manifest must be a JSON object");
  }
  const lifecycleManifest = raw.lifecycleManifest;
  const coverage = raw.coverage;
  const grandfathered = raw.grandfathered;
  if (!Array.isArray(lifecycleManifest) || lifecycleManifest.length === 0) {
    throw new Error("coverage manifest: `lifecycleManifest` must be a non-empty array");
  }
  for (const glob of lifecycleManifest) {
    validateManifestGlob(glob);
  }
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) {
    throw new Error("coverage manifest: `coverage` must be an object of glob → subject");
  }
  if (!Array.isArray(grandfathered)) {
    throw new Error("coverage manifest: `grandfathered` must be an array");
  }
  const manifestSet = new Set(lifecycleManifest);
  for (const key of Object.keys(coverage)) {
    if (!manifestSet.has(key)) {
      throw new Error(`coverage manifest: coverage key ${JSON.stringify(key)} is not in lifecycleManifest`);
    }
  }
  for (const glob of grandfathered) {
    if (!manifestSet.has(glob)) {
      throw new Error(`coverage manifest: grandfathered entry ${JSON.stringify(glob)} is not in lifecycleManifest`);
    }
    if (Object.prototype.hasOwnProperty.call(coverage, glob)) {
      throw new Error(`coverage manifest: ${JSON.stringify(glob)} cannot be both covered and grandfathered`);
    }
  }
  return { lifecycleManifest, coverage, grandfathered };
}

/** "covered" | "grandfathered" | "unmapped" for a single manifest glob. */
export function classifyGlob(glob, manifest) {
  if (Object.prototype.hasOwnProperty.call(manifest.coverage, glob)) return "covered";
  if (manifest.grandfathered.includes(glob)) return "grandfathered";
  return "unmapped";
}

/**
 * Evaluate an effective changed-files list against the manifest.
 * Precedence per file: covered > grandfathered > unmapped (a file covered by
 * one glob is covered even if another glob it matches is only grandfathered).
 */
export function evaluateCoverage(effectiveFiles, manifest) {
  const covered = [];
  const warnings = [];
  const violations = [];
  for (const file of effectiveFiles) {
    const matched = manifest.lifecycleManifest.filter((glob) => isIgnoredPath(file, [glob]));
    if (matched.length === 0) continue;
    const classes = matched.map((glob) => ({ glob, klass: classifyGlob(glob, manifest) }));
    const coveredBy = classes.find((c) => c.klass === "covered");
    if (coveredBy) {
      covered.push({ file, glob: coveredBy.glob, subject: manifest.coverage[coveredBy.glob] });
      continue;
    }
    const grandfatheredBy = classes.find((c) => c.klass === "grandfathered");
    if (grandfatheredBy) {
      warnings.push({ file, glob: grandfatheredBy.glob });
      continue;
    }
    violations.push({ file, glob: classes[0].glob });
  }
  return { covered, warnings, violations };
}

/** Grandfather ratchet: entries present in head but absent from base (growth = violation). */
export function grandfatherGrowth(baseManifest, headManifest) {
  const baseSet = new Set(baseManifest.grandfathered);
  return headManifest.grandfathered.filter((glob) => !baseSet.has(glob));
}

/** Manifest ratchet: lifecycleManifest globs present in base but removed in head (removal silently disables the gate for that path). */
export function manifestShrinkage(baseManifest, headManifest) {
  const headSet = new Set(headManifest.lifecycleManifest);
  return baseManifest.lifecycleManifest.filter((glob) => !headSet.has(glob));
}

/** Scan the subjects directory for `runLifecycleMatrix("<name>", ...)` registrations. */
export function registeredSubjectNames(subjectsDir) {
  if (!existsSync(subjectsDir)) return [];
  const names = new Set();
  for (const entry of readdirSync(subjectsDir)) {
    if (!entry.endsWith(".test.ts")) continue;
    const source = readFileSync(join(subjectsDir, entry), "utf8");
    for (const name of discoverSubjectRegistrations(source)) names.add(name);
  }
  return [...names];
}

/** Every coverage subject name must be a real registered subject. */
export function unregisteredSubjects(manifest, registered) {
  const known = new Set(registered);
  const missing = new Set();
  for (const subject of Object.values(manifest.coverage)) {
    if (!known.has(subject)) missing.add(subject);
  }
  return [...missing];
}

/**
 * Parse `git diff --name-status -z -M` output into changed-file records.
 * Rename/copy records (R###/C###) carry both { filename, previous_filename };
 * every other status carries { filename }. Fields are NUL-terminated (-z) so
 * renamed and space-bearing paths survive intact.
 */
export function parseNameStatusZ(text) {
  const tokens = text.split("\0").filter((t) => t.length > 0);
  const records = [];
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i++];
    if (/^[RC]\d*$/.test(status)) {
      const previous_filename = tokens[i++];
      const filename = tokens[i++];
      if (filename) records.push({ filename, previous_filename });
    } else {
      const filename = tokens[i++];
      if (filename) records.push({ filename });
    }
  }
  return records;
}

/**
 * Flatten changed-file records into individual repo-relative paths. A rename
 * record contributes BOTH its destination and its source: moving a lifecycle
 * path to an ignored or non-lifecycle location still changes lifecycle
 * behavior and must not bypass the gate (rename-bypass hardening).
 */
export function flattenChangedPaths(entries) {
  const out = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      if (entry) out.push(entry);
      continue;
    }
    const filename = entry?.filename ?? entry?.path;
    if (filename) out.push(filename);
    if (typeof entry?.previous_filename === "string" && entry.previous_filename) {
      out.push(entry.previous_filename);
    }
  }
  return [...new Set(out)];
}

// Local-dev fallback (CI always sets REMNIC_LIFECYCLE_CHANGED_FILES_PATH).
// Git errors are NOT swallowed: a diff that cannot be computed must fail the
// gate loudly rather than return [] and pass vacuously.
function readChangedFilesFromGit() {
  const baseRef = process.env.LIFECYCLE_BASE_REF || process.env.GITHUB_BASE_REF;
  const diffArgs = ["-c", "core.quotePath=off", "diff", "--name-status", "-z", "-M"];
  let range = "HEAD~1...HEAD";
  if (baseRef) {
    execFileSync("git", ["fetch", "--quiet", "--depth=1", "origin", baseRef], { cwd: repoRoot, stdio: "ignore" });
    const mergeBase = execFileSync("git", ["merge-base", "FETCH_HEAD", "HEAD"], { cwd: repoRoot }).toString().trim();
    range = `${mergeBase}...HEAD`;
  }
  return parseNameStatusZ(execFileSync("git", [...diffArgs, range], { cwd: repoRoot }).toString());
}

function readChangedFiles() {
  const filesArg = process.argv.find((a) => a.startsWith("--files="));
  if (filesArg) return filesArg.slice("--files=".length).split(",").map((s) => s.trim()).filter(Boolean);
  const pathEnv = process.env.REMNIC_LIFECYCLE_CHANGED_FILES_PATH;
  if (pathEnv && existsSync(pathEnv)) {
    return parseNameStatusZ(readFileSync(pathEnv, "utf8"));
  }
  return readChangedFilesFromGit();
}

/**
 * Load the base (pre-PR) coverage manifest for the shrink-only grandfather
 * ratchet. Path comes from `--base-manifest=` or LIFECYCLE_BASE_MANIFEST_PATH.
 * Returns null when absent/empty (manifest newly introduced → nothing to
 * ratchet against) or unparseable (the base already passed its own gate).
 */
function readBaseManifest() {
  const baseArg = process.argv.find((a) => a.startsWith("--base-manifest="));
  const basePath = baseArg
    ? baseArg.slice("--base-manifest=".length)
    : process.env.LIFECYCLE_BASE_MANIFEST_PATH;
  if (!basePath || !existsSync(basePath)) return null;
  const raw = readFileSync(basePath, "utf8").trim();
  if (raw.length === 0) return null;
  try {
    return loadCoverageManifest(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Load the base-ref ai-review-ignore patterns. Path comes from `--base-ignore=`
 * or LIFECYCLE_BASE_IGNORE_PATH (CI writes `git show <base>:.github/ai-review-ignore`
 * there). Read from the BASE ref, never the head checkout: otherwise a PR could
 * add a lifecycle path (e.g. orchestrator.ts) to `.github/ai-review-ignore` and
 * the gate would drop it from the effective diff before evaluateCoverage,
 * bypassing the required-subject check. Absent/empty base → no patterns (fail
 * safe: ignore nothing rather than trust head-side rules).
 */
function readBaseIgnorePatterns() {
  const baseArg = process.argv.find((a) => a.startsWith("--base-ignore="));
  const basePath = baseArg
    ? baseArg.slice("--base-ignore=".length)
    : process.env.LIFECYCLE_BASE_IGNORE_PATH;
  if (!basePath || !existsSync(basePath)) return [];
  const raw = readFileSync(basePath, "utf8");
  if (raw.trim().length === 0) return [];
  return parseIgnoreManifest(raw);
}

function main() {
  const manifestArg = process.argv.find((a) => a.startsWith("--manifest="));
  const manifestPath = manifestArg
    ? manifestArg.slice("--manifest=".length)
    : join(scriptDir, "coverage.json");
  const manifest = loadCoverageManifest(JSON.parse(readFileSync(manifestPath, "utf8")));

  const registered = registeredSubjectNames(
    join(repoRoot, "packages", "remnic-core", "src", "testing", "subjects"),
  );
  const missingSubjects = unregisteredSubjects(manifest, registered);
  if (missingSubjects.length > 0) {
    console.error(
      `::error::lifecycle-matrix coverage.json maps to unregistered subject(s): ${missingSubjects.join(", ")}. ` +
        `Registered subjects: ${registered.join(", ") || "(none)"}.`,
    );
    process.exit(1);
  }

  const baseManifest = readBaseManifest();
  if (baseManifest) {
    const grown = grandfatherGrowth(baseManifest, manifest);
    if (grown.length > 0) {
      console.error(
        `::error::lifecycle-matrix grandfather list grew: ${grown.join(", ")}. ` +
          `The grandfather list is a shrink-only ratchet (scripts/lifecycle-matrix/coverage.json) — ` +
          `cover new lifecycle paths with a registered LifecycleSubject instead of grandfathering them.`,
      );
      process.exit(1);
    }
    const removed = manifestShrinkage(baseManifest, manifest);
    if (removed.length > 0) {
      console.error(
        `::error::lifecycle-matrix lifecycleManifest removed path(s): ${removed.join(", ")}. ` +
          `Lifecycle-critical paths may not be dropped from the manifest — removing a glob silently ` +
          `disables the path-triggered gate for that subsystem (scripts/lifecycle-matrix/coverage.json).`,
      );
      process.exit(1);
    }
  }

  const changed = readChangedFiles();
  const ignorePatterns = readBaseIgnorePatterns();
  const { effective } = splitEffectiveDiff(flattenChangedPaths(changed), ignorePatterns);

  const { covered, warnings, violations } = evaluateCoverage(effective, manifest);

  for (const w of warnings) {
    console.warn(
      `::warning::lifecycle path ${w.file} (glob ${w.glob}) is grandfathered — no LifecycleSubject covers it yet ` +
        `(scripts/lifecycle-matrix/coverage.json). Consider adding a subject.`,
    );
  }
  for (const c of covered) {
    console.log(`[lifecycle-matrix] ${c.file} covered by subject "${c.subject}" (glob ${c.glob}).`);
  }
  if (violations.length > 0) {
    for (const v of violations) {
      console.error(
        `::error::lifecycle path ${v.file} matches lifecycleManifest glob ${v.glob} but has NO coverage mapping ` +
          `and is not grandfathered. Add it to scripts/lifecycle-matrix/coverage.json "coverage" pointing at a ` +
          `registered LifecycleSubject, or (last resort) do not extend the manifest without coverage.`,
      );
    }
    process.exit(1);
  }

  console.log(
    `[lifecycle-matrix] OK — ${covered.length} covered, ${warnings.length} grandfathered, 0 violations ` +
      `(${effective.length} effective changed files).`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
