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

/** Scan the subjects directory for `runLifecycleMatrix("<name>", ...)` registrations. */
export function registeredSubjectNames(subjectsDir) {
  if (!existsSync(subjectsDir)) return [];
  const names = new Set();
  const pattern = /runLifecycleMatrix\(\s*["']([^"']+)["']/g;
  for (const entry of readdirSync(subjectsDir)) {
    if (!entry.endsWith(".test.ts")) continue;
    const text = readFileSync(join(subjectsDir, entry), "utf8");
    for (const match of text.matchAll(pattern)) names.add(match[1]);
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

function readChangedFilesFromGit() {
  const baseRef = process.env.LIFECYCLE_BASE_REF || process.env.GITHUB_BASE_REF;
  try {
    if (baseRef) {
      execFileSync("git", ["fetch", "--quiet", "--depth=1", "origin", baseRef], { cwd: repoRoot, stdio: "ignore" });
      const range = execFileSync("git", ["merge-base", "FETCH_HEAD", "HEAD"], { cwd: repoRoot })
        .toString()
        .trim();
      return execFileSync("git", ["diff", "--name-only", `${range}...HEAD`], { cwd: repoRoot })
        .toString()
        .split("\n")
        .filter(Boolean);
    }
    return execFileSync("git", ["diff", "--name-only", "HEAD~1...HEAD"], { cwd: repoRoot })
      .toString()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readChangedFiles() {
  const filesArg = process.argv.find((a) => a.startsWith("--files="));
  if (filesArg) return filesArg.slice("--files=".length).split(",").map((s) => s.trim()).filter(Boolean);
  const pathEnv = process.env.REMNIC_LIFECYCLE_CHANGED_FILES_PATH;
  if (pathEnv && existsSync(pathEnv)) {
    return readFileSync(pathEnv, "utf8").split(/\0|\n/).map((s) => s.trim()).filter(Boolean);
  }
  return readChangedFilesFromGit();
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

  const changed = readChangedFiles();
  const ignorePath = join(repoRoot, ".github", "ai-review-ignore");
  const ignorePatterns = existsSync(ignorePath)
    ? parseIgnoreManifest(readFileSync(ignorePath, "utf8"))
    : [];
  const { effective } = splitEffectiveDiff(changed, ignorePatterns);

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
