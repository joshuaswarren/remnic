#!/usr/bin/env node

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

import { isIgnoredPath, parseIgnoreManifest, splitEffectiveDiff } from "../effective-diff.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(scriptDir));

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
const REGEX_ALLOWED_AFTER = new Set([
  "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "^", "~", "<", ">",
]);
const STATEMENT_CONTINUATION = new Set([
  "&", "|", "?", ":", "=", ",", "(", "[", "+", "-", "*", "/", "%", "^", "~", "<", ">", "!", ".",
]);
const CONTROL_KEYWORDS = new Set(["if", "for", "while", "switch", "catch"]);
const BODY_KEYWORDS = new Set(["else", "do", "try", "finally"]);

function precedingWord(source, idx) {
  let k = idx - 1;
  for (;;) {
    while (k >= 0 && /\s/.test(source[k])) k -= 1;
    if (k < 1) break;
    if (source[k] === "/" && source[k - 1] === "*") {
      k -= 2;
      while (k >= 1 && !(source[k - 1] === "/" && source[k] === "*")) k -= 1;
      k -= 2;
      continue;
    }
    let lineStart = k;
    while (lineStart >= 0 && source[lineStart] !== "\n") lineStart -= 1;
    lineStart += 1;
    const commentAt = source.slice(lineStart, k + 1).indexOf("//");
    if (commentAt !== -1) {
      k = lineStart + commentAt - 1;
      continue;
    }
    break;
  }
  const end = k;
  while (k >= 0 && SUBJECT_IDENT.test(source[k])) k -= 1;
  return { word: source.slice(k + 1, end + 1), start: k + 1 };
}

function skipRegexLiteral(source, start) {
  const n = source.length;
  let k = start + 1;
  let inClass = false;
  while (k < n) {
    const c = source[k];
    if (c === "\\") {
      k += 2;
      continue;
    }
    if (c === "\n") break;
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      k += 1;
      break;
    }
    k += 1;
  }
  while (k < n && /[a-z]/i.test(source[k])) k += 1;
  return k;
}

export function discoverSubjectRegistrations(source) {
  const names = [];
  const n = source.length;
  let i = 0;
  let quote = null;
  let depth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let prevSig = "";
  let nlSincePrev = false;
  const controlParen = [];
  let lastCloseWasControlHeader = false;
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
    if (/\s/.test(ch)) {
      if (ch === "\n") nlSincePrev = true;
      i += 1;
      continue;
    }
    const sawNewlineBeforeToken = nlSincePrev;
    nlSincePrev = false;
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      prevSig = ch;
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
    if (ch === "/") {
      if (prevSig === "" || REGEX_ALLOWED_AFTER.has(prevSig)) {
        i = skipRegexLiteral(source, i);
        prevSig = "z"; // a regex literal is an operand → a following `/` is division
        continue;
      }
      prevSig = "/";
      i += 1;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      prevSig = ch;
      i += 1;
      continue;
    }
    if (ch === "}") {
      if (depth > 0) depth -= 1;
      prevSig = ch;
      i += 1;
      continue;
    }
    if (ch === "(") {
      const pw = precedingWord(source, i);
      const isControlHeader =
        CONTROL_KEYWORDS.has(pw.word) ||
        (pw.word === "await" && precedingWord(source, pw.start).word === "for");
      controlParen.push(isControlHeader);
      parenDepth += 1;
      prevSig = ch;
      i += 1;
      continue;
    }
    if (ch === ")") {
      const wasControl = controlParen.pop() ?? false;
      if (parenDepth > 0) parenDepth -= 1;
      if (parenDepth === 0) lastCloseWasControlHeader = wasControl;
      prevSig = ch;
      i += 1;
      continue;
    }
    if (ch === "[") {
      bracketDepth += 1;
      prevSig = ch;
      i += 1;
      continue;
    }
    if (ch === "]") {
      if (bracketDepth > 0) bracketDepth -= 1;
      prevSig = ch;
      i += 1;
      continue;
    }
    if (
      depth === 0 &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      (prevSig === "" ||
        prevSig === ";" ||
        prevSig === "}" ||
        (sawNewlineBeforeToken &&
          !STATEMENT_CONTINUATION.has(prevSig) &&
          !(prevSig === ")" && lastCloseWasControlHeader) &&
          !BODY_KEYWORDS.has(precedingWord(source, i).word))) &&
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
          j += 1; // past the closing quote of the subject name
          let callDepth = 1;
          let braceDepth = 0;
          let bracketDepth = 0;
          let contentSegments = 0;
          let curSegHasContent = false;
          let argQuote = null;
          let argPrev = "(";
          while (j < n && callDepth > 0) {
            const c = source[j];
            if (argQuote) {
              if (c === "\\") {
                j += 2;
                continue;
              }
              if (c === argQuote) argQuote = null;
              j += 1;
              continue;
            }
            if (/\s/.test(c)) {
              j += 1;
              continue;
            }
            if (c === '"' || c === "'" || c === "`") {
              argQuote = c;
              argPrev = c;
              curSegHasContent = true;
              j += 1;
              continue;
            }
            if (c === "/" && source[j + 1] === "/") {
              while (j < n && source[j] !== "\n") j += 1;
              continue;
            }
            if (c === "/" && source[j + 1] === "*") {
              j += 2;
              while (j < n && !(source[j] === "*" && source[j + 1] === "/")) j += 1;
              j += 2;
              continue;
            }
            if (c === "/") {
              if (argPrev === "" || REGEX_ALLOWED_AFTER.has(argPrev)) {
                j = skipRegexLiteral(source, j);
                argPrev = "z";
                curSegHasContent = true;
                continue;
              }
              argPrev = "/";
              curSegHasContent = true;
              j += 1;
              continue;
            }
            if (c === ")") {
              callDepth -= 1;
              if (callDepth === 0) break; // call closed — do not count as content
              curSegHasContent = true;
              argPrev = c;
              j += 1;
              continue;
            }
            if (c === "(") callDepth += 1;
            else if (c === "{") braceDepth += 1;
            else if (c === "}") {
              if (braceDepth > 0) braceDepth -= 1;
            } else if (c === "[") bracketDepth += 1;
            else if (c === "]") {
              if (bracketDepth > 0) bracketDepth -= 1;
            }
            if (c === "," && callDepth === 1 && braceDepth === 0 && bracketDepth === 0) {
              if (curSegHasContent) contentSegments += 1;
              curSegHasContent = false;
            } else {
              curSegHasContent = true;
            }
            argPrev = c;
            j += 1;
          }
          if (curSegHasContent) contentSegments += 1;
          if (name.length > 0 && contentSegments === 1) names.push(name);
          prevSig = ")";
          i = j;
          continue;
        }
      }
      prevSig = SUBJECT_CALL[SUBJECT_CALL.length - 1];
      i += SUBJECT_CALL.length;
      continue;
    }
    prevSig = ch;
    i += 1;
  }
  return names;
}

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
      manifestSet.add(key);
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

export function isLifecycleTestFile(file) {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
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
    if (isLifecycleTestFile(file)) continue;
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

export function deletedOrRenamedPaths(records, manifest) {
  const set = new Set();
  const lifecycleGlobs = manifest?.lifecycleManifest ?? [];
  for (const r of records) {
    if (!r || typeof r === "string") continue;
    if (typeof r.status === "string" && r.status.startsWith("D") && r.filename) set.add(r.filename);
    if (typeof r.previous_filename === "string" && r.previous_filename && r.filename) {
      if (lifecycleGlobs.some((glob) => isIgnoredPath(r.filename, [glob]))) set.add(r.previous_filename);
    }
  }
  return set;
}

export function deletedPaths(records) {
  const set = new Set();
  for (const r of records) {
    if (!r || typeof r === "string") continue;
    if (typeof r.status === "string" && r.status.startsWith("D") && r.filename) set.add(r.filename);
  }
  return set;
}

export function renameSourcesWithinLifecycle(records, manifest) {
  const drop = new Set();
  for (const r of records) {
    if (!r || typeof r === "string") continue;
    const dest = r.filename;
    const src = r.previous_filename;
    if (!src || !dest) continue;
    if (manifest.lifecycleManifest.some((glob) => isIgnoredPath(dest, [glob]))) drop.add(src);
  }
  return drop;
}

export function unexplainedRemovals(removed, explained) {
  return removed.filter((glob) => glob.includes("*") || !explained.has(glob));
}

/** Scan subject directories for `runLifecycleMatrix("<name>", ...)` registrations. */
export function registeredSubjectNames(subjectsDirs) {
  const directories = Array.isArray(subjectsDirs) ? subjectsDirs : [subjectsDirs];
  const names = new Set();
  for (const subjectsDir of directories) {
    if (!existsSync(subjectsDir)) continue;
    for (const entry of readdirSync(subjectsDir)) {
      if (!entry.endsWith(".test.ts")) continue;
      const source = readFileSync(join(subjectsDir, entry), "utf8");
      for (const name of discoverSubjectRegistrations(source)) names.add(name);
    }
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
      if (filename) records.push({ status, filename, previous_filename });
    } else {
      const filename = tokens[i++];
      if (filename) records.push({ status, filename });
    }
  }
  return records;
}

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

  const registered = registeredSubjectNames([
    join(repoRoot, "packages", "remnic-core", "src", "testing", "subjects"),
    join(repoRoot, "packages", "plugin-openclaw", "src", "testing", "subjects"),
  ]);
  const missingSubjects = unregisteredSubjects(manifest, registered);
  if (missingSubjects.length > 0) {
    console.error(
      `::error::lifecycle-matrix coverage.json maps to unregistered subject(s): ${missingSubjects.join(", ")}. ` +
        `Registered subjects: ${registered.join(", ") || "(none)"}.`,
    );
    process.exit(1);
  }

  const changed = readChangedFiles();
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
    const unexplained = unexplainedRemovals(removed, deletedOrRenamedPaths(changed, manifest))
      .filter((glob) => {
        if (!glob.endsWith("/**")) return true;
        const dir = join(repoRoot, glob.slice(0, -3));
        if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
        const walk = (d) => {
          for (const entry of readdirSync(d, { withFileTypes: true })) {
            const child = join(d, entry.name);
            if (entry.isDirectory() && walk(child)) return true;
            if (entry.name.endsWith(".ts")) return true;
          }
          return false;
        };
        return walk(dir);
      });
    if (unexplained.length > 0) {
      console.error(
        `::error::lifecycle-matrix lifecycleManifest removed path(s) with no matching deletion/rename: ${unexplained.join(", ")}. ` +
          `Removing a live glob silently disables the path-triggered gate for that subsystem; only remove an entry when the ` +
          `name-status diff shows its file was deleted or renamed (scripts/lifecycle-matrix/coverage.json).`,
      );
      process.exit(1);
    }
  }

  const ignorePatterns = readBaseIgnorePatterns();
  const deleted = deletedPaths(changed);
  const renamedWithin = renameSourcesWithinLifecycle(changed, manifest);
  const { effective } = splitEffectiveDiff(
    flattenChangedPaths(changed).filter((p) => !deleted.has(p) && !renamedWithin.has(p)),
    ignorePatterns,
  );

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
