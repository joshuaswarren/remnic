#!/usr/bin/env node
// Scoped anti-slop gate: lint changed JavaScript/TypeScript sources and fail
// only when an anti-slop diagnostic lands on an added/changed line, compared
// against a git base ref. Unchanged debt never blocks; syntax errors and tool
// failures fail closed.
//
// `--disable-nested-config` keeps source-directory oxlint configs from
// overriding the root gate policy; `--no-error-on-unmatched-pattern` lets a
// change whose sources are all covered by ignorePatterns lint to zero matches
// instead of erroring.
//
// ponytail: line-scoped only — a future alias/dataflow rule may report a span
// on an unchanged line while the violation sits on an added one, and such
// unchanged-line reports escape this gate. Whole-file scan or a ratcheted
// baseline are the later upgrades if that starts happening.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WORKTREE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OXLINT_EXECUTABLE = join(WORKTREE_ROOT, "node_modules", "oxlint", "bin", "oxlint");
const OXLINT_CONFIG = join(WORKTREE_ROOT, ".oxlintrc.json");
const OXLINT_TIMEOUT_MS = 300000;
const SOURCE_EXTENSIONS = new Set([
  ".js", ".jsx", ".mjs", ".cjs",
  ".ts", ".tsx", ".mts", ".cts",
]);
const ANTI_SLOP_CODE_PREFIX = "anti-slop(";

function fail(message) {
  process.stderr.write(`anti-slop gate: ${message}\n`);
  process.exit(2);
}

function execGit(repoPath, args) {
  return spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function gitOutput(repoRoot, args, failure) {
  const result = execGit(repoRoot, args);
  if (result.status !== 0) fail(failure(result.stderr?.trim() || result.error?.message || "git failed"));
  return result.stdout;
}

function splitNulPaths(output) {
  return output.split("\0").filter((entry) => entry.length > 0);
}

export function parseHunkAddedLines(diffText) {
  const added = new Set();
  for (const match of diffText.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    for (let line = start; line < start + count; line += 1) added.add(line);
  }
  return added;
}

export function parseOxlintJson(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`malformed oxlint JSON output: ${error.message}`);
  }
  if (!parsed || parsed.constructor !== Object || !Array.isArray(parsed.diagnostics)) {
    throw new Error("oxlint JSON output is missing a diagnostics array");
  }
  if (parsed.diagnostics.some((entry) => !entry || entry.constructor !== Object)) {
    throw new Error("oxlint diagnostics must be objects");
  }
  return parsed.diagnostics;
}

export function isAntiSlopDiagnostic(diagnostic) {
  return isNonEmptyText(diagnostic.code) && diagnostic.code.startsWith(ANTI_SLOP_CODE_PREFIX);
}

// Decoders for the untrusted tool output; runtime `typeof` narrowing is
// banned by the gate's own rules, so check constructors at this boundary.
function isNonEmptyText(value) {
  return value !== null && value !== undefined && value.constructor === String && value.length > 0;
}

// Byte offsets (oxlint spans) to 1-based inclusive line ranges.
export function byteLineStarts(contents) {
  const starts = [0];
  for (let index = 0; index < contents.length; index += 1) {
    if (contents[index] === 0x0a) starts.push(index + 1);
  }
  return starts;
}

function lineOfOffset(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (lineStarts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

export function spanLines(span, lineStarts, byteLength = Infinity) {
  if (!span || !Number.isSafeInteger(span.offset) || !Number.isSafeInteger(span.length)
    || span.offset < 0 || span.length < 0 || span.offset + span.length > byteLength) {
    throw new Error("oxlint diagnostic has an invalid source span");
  }
  const start = lineOfOffset(lineStarts, span.offset);
  const end = lineOfOffset(lineStarts, span.offset + Math.max(span.length - 1, 0));
  return [start, end];
}

function linesIntersect(startLine, endLine, addedLines) {
  for (let line = startLine; line <= endLine; line += 1) {
    if (addedLines.has(line)) return true;
  }
  return false;
}

function resolveBaseRef(repoRoot, explicitBase) {
  if (explicitBase !== undefined && explicitBase.length > 0) {
    const resolved = execGit(repoRoot, ["rev-parse", "--verify", "--quiet", `${explicitBase}^{commit}`]);
    if (resolved.status !== 0 || resolved.stdout.trim().length === 0) {
      fail(`base ref "${explicitBase}" does not resolve to a commit`);
    }
    return explicitBase;
  }
  const mergeBase = execGit(repoRoot, ["merge-base", "origin/main", "HEAD"]);
  if (mergeBase.status !== 0) {
    fail("cannot resolve a base ref: pass --base or set REMNIC_ANTI_SLOP_BASE_REF (no origin/main merge-base found)");
  }
  const base = mergeBase.stdout.trim();
  const head = gitOutput(repoRoot, ["rev-parse", "HEAD"], (stderr) => `git rev-parse HEAD failed: ${stderr}`).trim();
  if (base !== head) return base;
  const parent = execGit(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD^"]);
  if (parent.status !== 0 || parent.stdout.trim().length === 0) {
    fail("HEAD already equals the origin/main merge-base and has no parent commit to compare against");
  }
  return "HEAD^";
}

function hasSourceExtension(file) {
  const dot = file.lastIndexOf(".");
  return dot !== -1 && SOURCE_EXTENSIONS.has(file.slice(dot));
}

function collectChangedSources(repoRoot, baseRef) {
  const tracked = splitNulPaths(
    gitOutput(repoRoot, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--name-only", "--no-renames", "-z", baseRef],
      (stderr) => `git diff against ${baseRef} failed: ${stderr}`),
  ).filter((file) => existsSync(join(repoRoot, file)) && hasSourceExtension(file));
  const untracked = splitNulPaths(
    gitOutput(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"],
      (stderr) => `git ls-files failed: ${stderr}`),
  ).filter(hasSourceExtension);
  return { trackedSources: tracked, untrackedSources: untracked };
}

function addedLinesForTrackedFile(repoRoot, baseRef, file) {
  const diff = gitOutput(
    repoRoot,
    ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=0", "--no-renames", baseRef, "--", file],
    (stderr) => `git diff for ${file} failed: ${stderr}`,
  );
  return parseHunkAddedLines(diff);
}

function lintChangedFiles(repoRoot, files) {
  const result = spawnSync(
    process.execPath,
    [
      OXLINT_EXECUTABLE,
      "--threads=2",
      "--disable-nested-config",
      "--no-error-on-unmatched-pattern",
      "--config", OXLINT_CONFIG,
      "--format", "json",
      "--", ...files,
    ],
    { cwd: repoRoot, encoding: "utf8", timeout: OXLINT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) fail(`oxlint failed to run: ${result.error.message}`);
  if (result.status !== 0 && result.status !== 1) {
    fail(`oxlint exited with status ${result.status ?? "null"} (${result.signal ?? "no signal"}): ${result.stderr.trim()}`);
  }
  try {
    const diagnostics = parseOxlintJson(result.stdout);
    if (result.status === 1 && diagnostics.length === 0) {
      throw new Error("oxlint failed without diagnostics");
    }
    return diagnostics;
  } catch (error) {
    return fail(`could not use oxlint output: ${error.message}`);
  }
}

function parseArgs(argv) {
  const parsed = { base: undefined, root: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--base" || argument === "--root") {
      const key = argument.slice(2);
      parsed[key] = argv[index + 1];
      if (!parsed[key] || parsed[key].startsWith("--")) fail(`${argument} requires a value`);
      index += 1;
    } else if (argument.startsWith("--base=") || argument.startsWith("--root=")) {
      const key = argument.slice(2, argument.indexOf("="));
      parsed[key] = argument.slice(argument.indexOf("=") + 1);
      if (!parsed[key]) fail(`--${key} requires a value`);
    } else {
      fail(`unknown argument "${argument}"`);
    }
  }
  return parsed;
}

function main() {
  const { base: baseArg, root: rootArg } = parseArgs(process.argv.slice(2));
  const requestedRoot = rootArg ?? process.cwd();
  const rootResult = execGit(requestedRoot, ["rev-parse", "--show-toplevel"]);
  if (rootResult.status !== 0) {
    fail(`"${requestedRoot}" is not inside a git repository: ${rootResult.stderr?.trim() || rootResult.error?.message}`);
  }
  const repoRoot = rootResult.stdout.trim();

  const baseRef = resolveBaseRef(repoRoot, baseArg ?? process.env.REMNIC_ANTI_SLOP_BASE_REF);

  const { trackedSources, untrackedSources } = collectChangedSources(repoRoot, baseRef);
  const changedFiles = [...new Set([...trackedSources, ...untrackedSources])];
  if (changedFiles.length === 0) {
    process.stdout.write(`anti-slop gate: no changed JavaScript/TypeScript sources against ${baseRef}; clean.\n`);
    process.exit(0);
  }

  // Untracked and rename/new-extension paths have no base revision: every
  // line counts as added (null marks whole-file scanning).
  const addedLinesByFile = new Map();
  for (const file of untrackedSources) addedLinesByFile.set(file, null);
  for (const file of trackedSources) {
    if (!addedLinesByFile.has(file)) addedLinesByFile.set(file, addedLinesForTrackedFile(repoRoot, baseRef, file));
  }

  const scannedFiles = new Set(changedFiles);
  const sources = new Map();
  const violations = [];
  const internalErrors = [];
  for (const diagnostic of lintChangedFiles(repoRoot, changedFiles)) {
    const file = isNonEmptyText(diagnostic.filename) ? diagnostic.filename.replace(/^\.\//, "") : null;
    if (file === null || !scannedFiles.has(file)) {
      internalErrors.push(`diagnostic for unscanned path ${JSON.stringify(diagnostic.filename)}: ${diagnostic.message}`);
      continue;
    }
    if (!isNonEmptyText(diagnostic.code)) {
      internalErrors.push(`${file}: syntax error: ${diagnostic.message}`);
      continue;
    }
    if (!isAntiSlopDiagnostic(diagnostic)) {
      if (diagnostic.severity === "error") internalErrors.push(`${file}: unexpected error: ${diagnostic.message}`);
      continue;
    }
    let ranges;
    try {
      if (!Array.isArray(diagnostic.labels) || diagnostic.labels.length === 0) {
        throw new Error("oxlint diagnostic has no source labels");
      }
      if (!sources.has(file)) {
        const contents = readFileSync(join(repoRoot, file));
        sources.set(file, { byteLength: contents.length, lineStarts: byteLineStarts(contents) });
      }
      const source = sources.get(file);
      ranges = diagnostic.labels.map((label) => spanLines(label.span, source.lineStarts, source.byteLength));
    } catch (error) {
      internalErrors.push(`${file}: ${diagnostic.code}: ${error.message}`);
      continue;
    }
    const addedLines = addedLinesByFile.get(file);
    const overlap = ranges.find(([start, end]) => addedLines === null || linesIntersect(start, end, addedLines));
    if (overlap) {
      const [startLine, endLine] = overlap;
      const at = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
      violations.push(`${file}:${at}: ${diagnostic.code} ${diagnostic.message}`);
    }
  }

  if (internalErrors.length > 0) {
    fail(`fail closed:\n${internalErrors.map((line) => `  ${line}`).join("\n")}`);
  }
  if (violations.length > 0) {
    process.stderr.write(
      `anti-slop gate: ${violations.length} anti-slop finding(s) on added/changed lines against ${baseRef}:\n`
      + `${violations.map((line) => `  ${line}`).join("\n")}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`anti-slop gate: no anti-slop findings on added/changed lines against ${baseRef}; clean.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
