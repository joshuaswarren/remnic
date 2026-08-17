#!/usr/bin/env node
/**
 * ReDoS-shape pre-check for changed regex literals (issue #2439).
 *
 * CodeQL flagged the same wrapper-strip regex three times in a row on
 * PR #2438 — each fix traded one polynomial shape for another
 * ([^>]* → bounded attr → bounded content → finally an indexOf scan),
 * costing three full CI+review cycles. This gate is the local mirror of
 * those findings: it scans CHANGED/ADDED lines in .ts/.mts files for
 * regex literals matching the known-flagged shapes and fails with
 * file:line + the literal before a push burns a CodeQL round.
 *
 * Heuristic, not a solver — catching the known-flagged shapes pre-push
 * is the bar. A clean run does NOT prove CodeQL will pass.
 *
 * Usage:
 *   node scripts/check-regex-safety.mjs             # changed lines vs origin/main
 *                                                    # (falls back to HEAD~1 when no
 *                                                    # origin/main; skips when neither)
 *   node scripts/check-regex-safety.mjs <file>...   # full-file scan of the given
 *                                                    # .ts/.mts files (tests, targeted runs)
 *
 * Env: REMNIC_REGEX_SAFETY_BASE_REF overrides the base ref (default
 * origin/main). REMNIC_REGEX_SAFETY_ROOT is a test seam pointing the
 * git mode at another repo root. Node stdlib only — no new deps.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = process.env.REMNIC_REGEX_SAFETY_ROOT
  ? path.resolve(process.env.REMNIC_REGEX_SAFETY_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SCANNED_EXTENSIONS = new Set([".ts", ".mts"]);

/**
 * Known ReDoS-flagged shapes. Each entry names the CodeQL finding class
 * it mirrors, from the PR #2438 flag rounds:
 *
 *  - lazy-any                  → js/polynomial-redos (round: bounded-content fix
 *                                still used [\s\S]*? / lazy .*? over any-matching input)
 *  - negated-class-alternation → js/polynomial-redos (round 1: [^>]*-style class
 *                                with a preceding literal alternative branch)
 *  - ws-capture-chain          → js/polynomial-redos (round 2: \s* chains adjacent
 *                                to [a-z]+-style captures inside longer patterns)
 *  - nested-quantifier         → js/redos (classic (a+)+ exponential backtracking)
 *
 * Bounded quantifiers ({0,256}) and linear scans (indexOf/loop) are the
 * sanctioned fixes and deliberately do NOT match these detectors.
 */
export const REDOS_SHAPES = Object.freeze([
  {
    id: "lazy-any",
    codeql: "js/polynomial-redos",
    // [\s\S]* / [\s\S]+ (greedy or lazy) or a lazy .*/.+ — an unbounded
    // quantifier over a class that matches everything.
    detector: /\[\\s\\S\][*+]\??|\.[*+]\?/,
    fix: "bound the quantifier (e.g. {0,256}) or replace with an indexOf/loop scan",
  },
  {
    id: "negated-class-alternation",
    codeql: "js/polynomial-redos",
    // [^>]*-style unbounded negated class combined with a literal
    // alternative branch — the PR #2438 round-1 shape.
    detector: /\[\^[^\]]+\][*+]/,
    requiresAlternation: true,
    fix: "bound the class (e.g. [^>]{0,256}) or drop the alternative and scan with indexOf",
  },
  {
    id: "ws-capture-chain",
    codeql: "js/polynomial-redos",
    // Two or more \s*/\s+ adjacent to a capture group or quantified class
    // inside one pattern — the round-2 shape.
    detector: null,
    fix: "collapse the \\s* chain (single \\s* or bounded \\s{0,8}) or trim before matching",
  },
  {
    id: "nested-quantifier",
    codeql: "js/redos",
    // A quantified token inside a group that is itself quantified —
    // (a+)+, (a*)+, (\d{2,})+ exponential backtracking.
    detector: /\((?:\\.|[^()\\])+[*+}]\)[*+]/,
    fix: "remove one quantifier level or rewrite the matching as a loop",
  },
]);

function shapeMatches(shape, src) {
  if (shape.id === "ws-capture-chain") {
    const wsCount = (src.match(/\\s[*+]/g) ?? []).length;
    return wsCount >= 2 && (src.includes("(") || /\[[^\]]+\][*+]/.test(src));
  }
  if (!shape.detector.test(src)) return false;
  if (shape.requiresAlternation && !src.includes("|")) return false;
  return true;
}

// ── Regex-literal extraction ────────────────────────────────────────────────

/** Characters that may directly precede a regex literal's opening slash. */
const PRE_REGEX_CHARS = new Set([
  "", " ", "\t", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}",
  ";", ">", "<", "+", "-", "*", "%", "~", "^", "\n",
]);

const REGEX_LITERAL_RE =
  /\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n])+\/[a-z]*/g;

/**
 * Track string spans and a line-comment start on one source line so
 * candidates inside strings or after `//` are skipped. Best-effort:
 * regex literals containing quote characters can confuse the tracker,
 * which at worst suppresses a later candidate on the same line.
 */
function lineRegions(line) {
  const strings = [];
  let commentStart = -1;
  let quote = null;
  let spanStart = 0;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) {
        strings.push([spanStart, i]);
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      spanStart = i;
      continue;
    }
    if (c === "/" && line[i + 1] === "/") {
      commentStart = i;
      break;
    }
  }
  if (quote) strings.push([spanStart, line.length]);
  return { strings, commentStart };
}

/** Extract regex-literal candidates ({ literal, src, index }) from one line. */
export function extractRegexLiterals(line) {
  const { strings, commentStart } = lineRegions(line);
  const inString = (pos) => strings.some(([s, e]) => pos >= s && pos <= e);
  const out = [];
  REGEX_LITERAL_RE.lastIndex = 0;
  for (const match of line.matchAll(REGEX_LITERAL_RE)) {
    const open = match.index;
    if (commentStart >= 0 && open > commentStart) continue;
    if (inString(open)) continue;
    const prev = open === 0 ? "" : line[open - 1];
    if (!PRE_REGEX_CHARS.has(prev)) continue;
    const text = match[0];
    const src = text.slice(1, text.lastIndexOf("/"));
    if (src.length === 0) continue;
    out.push({ literal: text, src, index: open });
  }
  return out;
}

/** Scan one line's text; returns findings for the line. */
export function scanLine(text) {
  const findings = [];
  for (const { literal, src } of extractRegexLiterals(text)) {
    for (const shape of REDOS_SHAPES) {
      if (shapeMatches(shape, src)) {
        findings.push({ id: shape.id, codeql: shape.codeql, literal, fix: shape.fix });
      }
    }
  }
  return findings;
}

// ── Input modes ─────────────────────────────────────────────────────────────

function tryGit(args, cwd = ROOT) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

function resolveBase() {
  const ref = process.env.REMNIC_REGEX_SAFETY_BASE_REF || "origin/main";
  if (tryGit(["rev-parse", "--verify", `${ref}^{commit}`])) {
    const mergeBase = tryGit(["merge-base", "HEAD", ref]);
    if (mergeBase) return { base: mergeBase.trim(), ref };
  }
  if (tryGit(["rev-parse", "--verify", "HEAD~1"])) {
    return { base: "HEAD~1", ref: "HEAD~1" };
  }
  return null;
}
export function parseAddedLines(diff) {
  const added = [];
  let file = null;
  let newLine = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ b/") || raw.startsWith("+++ w/")) {
      file = raw.slice(6);
      continue;
    }
    if (raw.startsWith("+++ ")) {
      file = null;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (hunk) {
      newLine = Number.parseInt(hunk[1], 10);
      continue;
    }
    if (file === null) continue;
    if (raw.startsWith("+")) {
      added.push({ file, line: newLine, text: raw.slice(1) });
      newLine += 1;
    } else if (raw.startsWith(" ")) {
      newLine += 1;
    }
  }
  return added;
}

function collectGitModeLines() {
  const resolved = resolveBase();
  if (!resolved) return { skipped: true };
  const diff = tryGit([
    "diff",
    "--no-color",
    "--unified=0",
    "--diff-filter=ACMR",
    resolved.base,
    "--",
    "*.ts",
    "*.mts",
  ]);
  if (diff === null) return { error: `git diff against ${resolved.ref} failed` };
  return { added: parseAddedLines(diff), base: resolved.ref };
}

function collectArgvModeLines(files) {
  const added = [];
  for (const filePath of files) {
    if (!SCANNED_EXTENSIONS.has(path.extname(filePath))) continue;
    let source;
    try {
      source = readFileSync(filePath, "utf8");
    } catch (error) {
      return { error: `cannot read ${filePath}: ${error.message}` };
    }
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      added.push({ file: filePath, line: i + 1, text: lines[i] });
    }
  }
  return { added };
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const argvFiles = process.argv.slice(2);
  const collected = argvFiles.length > 0 ? collectArgvModeLines(argvFiles) : collectGitModeLines();

  if (collected.error) {
    console.error(`[regex-safety] ERROR: ${collected.error}`);
    process.exit(2);
  }
  if (collected.skipped) {
    console.log(
      "[regex-safety] no base ref (origin/main and HEAD~1 unavailable) — nothing to scan, passing.",
    );
    process.exit(0);
  }

  const findings = [];
  for (const { file, line, text } of collected.added) {
    for (const finding of scanLine(text)) {
      findings.push({ file, line, ...finding });
    }
  }

  findings.sort((a, b) => {
    const fileCmp = a.file.localeCompare(b.file);
    if (fileCmp !== 0) return fileCmp;
    if (a.line !== b.line) return a.line - b.line;
    return a.id.localeCompare(b.id);
  });

  if (findings.length > 0) {
    for (const f of findings) {
      console.error(
        `${f.file}:${f.line}: [${f.id}] ${f.literal} mirrors CodeQL ${f.codeql} — ${f.fix}`,
      );
    }
    console.error(
      `[regex-safety] ${findings.length} ReDoS-shaped regex literal(s) on changed lines. ` +
        "Fix before pushing (issue #2439).",
    );
    process.exit(1);
  }

  const fileCount = new Set(collected.added.map((e) => e.file)).size;
  const baseNote = collected.base ? ` (base ${collected.base})` : "";
  console.log(
    `Regex safety check passed: ${collected.added.length} changed line(s) across ` +
      `${fileCount} file(s), 0 findings${baseNote}.`,
  );
  process.exit(0);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main();
}
