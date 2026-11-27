#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = process.env.REMNIC_REGEX_SAFETY_ROOT
  ? path.resolve(process.env.REMNIC_REGEX_SAFETY_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SCANNED_EXTENSIONS = new Set([".ts", ".mts"]);

export const REDOS_SHAPES = Object.freeze([
  {
    id: "lazy-any",
    codeql: "js/polynomial-redos",
    detector: /\[(?:\\s\\S|\\S\\s|\\w\\W|\\W\\w|\\d\\D|\\D\\d)\][*+]\??|\.[*+]\?/,
    fix: "bound the quantifier (e.g. {0,256}) or replace with an indexOf/loop scan",
  },
  {
    id: "negated-class-alternation",
    codeql: "js/polynomial-redos",
    detector: /\[\^[^\]]+\][*+]/,
    requiresAlternation: true,
    fix: "bound the class (e.g. [^>]{0,256}) or drop the alternative and scan with indexOf",
  },
  {
    id: "ws-capture-chain",
    codeql: "js/polynomial-redos",
    detector: null,
    fix: "collapse the \\s* chain (single \\s* or bounded \\s{0,8}) or trim before matching",
  },
  {
    id: "nested-quantifier",
    codeql: "js/redos",
    detector: null,
    fix: "remove one quantifier level or rewrite the matching as a loop",
  },
]);

function maskLiterals(src) {
  let out = "";
  let inClass = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (c === "\\") {
      const next = src[i + 1] ?? "";
      const isShorthand = /[a-zA-Z0-9]/.test(next);
      out += isShorthand ? c + next : "  ";
      i += 1;
      continue;
    }
    if (inClass) {
      out += c === "]" ? "]" : " ";
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      out += "[";
      if (src[i + 1] === "^") {
        out += "^"; // negation marker is structural, not content
        i += 1;
      }
      continue;
    }
    out += c;
  }
  return out;
}

function unboundedBrace(braceBody) {
  return /^\d+,$/.test(braceBody);
}

function hasNestedQuantifier(src) {
  for (let i = 0; i + 1 < src.length; i += 1) {
    if (src[i] !== ")" || (src[i + 1] !== "*" && src[i + 1] !== "+")) continue;
    const open = src.lastIndexOf("(", i);
    if (open === -1) continue;
    if (src.indexOf(")", open + 1) !== i) continue; // inner group — skip this level
    const body = src.slice(open + 1, i);
    const last = body[body.length - 1];
    if (last === "*" || last === "+") return true;
    if (last === "}") {
      const openBrace = body.lastIndexOf("{");
      if (openBrace !== -1 && unboundedBrace(body.slice(openBrace + 1, -1))) return true;
    }
  }
  return false;
}

function shapeMatches(shape, src) {
  if (shape.id === "ws-capture-chain") {
    const wsCount = (src.match(/\\s[*+]/g) ?? []).length;
    return wsCount >= 2 && (src.includes("(") || /\[[^\]]+\][*+]/.test(src));
  }
  if (shape.id === "nested-quantifier") return hasNestedQuantifier(src);
  if (!shape.detector.test(src)) return false;
  if (shape.requiresAlternation && !src.includes("|")) return false;
  return true;
}


const PRE_REGEX_CHARS = new Set([
  "", " ", "\t", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}",
  ";", ">", "<", "+", "-", "*", "%", "~", "^", "\n",
]);


function lineRegions(line) {
  const strings = [];
  const comments = [];
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
    if (c === "/" && line[i + 1] === "*") {
      const close = line.indexOf("*/", i + 2);
      if (close === -1) {
        commentStart = i;
        break;
      }
      comments.push([i, close + 1]);
      i = close + 1;
      continue;
    }
  }
  if (quote) strings.push([spanStart, line.length]);
  return { strings, comments, commentStart };
}
export function extractRegexLiterals(line) {
  if (/^\s*\*/.test(line)) return [];
  const { strings, comments, commentStart } = lineRegions(line);
  const inString = (pos) => strings.some(([s, e]) => pos >= s && pos <= e);
  const inComment = (pos) => comments.some(([s, e]) => pos >= s && pos <= e);
  const isFlag = (c) => c >= "a" && c <= "z";
  const out = [];
  for (let open = 0; open < line.length; open += 1) {
    if (line[open] !== "/") continue;
    if (commentStart >= 0 && open > commentStart) break;
    if (inString(open) || inComment(open)) continue;
    const prev = open === 0 ? "" : line[open - 1];
    if (!PRE_REGEX_CHARS.has(prev)) continue;
    const after = line[open + 1];
    if (after === undefined || after === "/" || after === "*") continue;
    let i = open + 1;
    let inClass = false;
    let closed = -1;
    while (i < line.length) {
      const c = line[i];
      if (c === "\\") i += 2;
      else if (inClass) {
        if (c === "]") inClass = false;
        i += 1;
      } else if (c === "[") {
        inClass = true;
        i += 1;
      } else if (c === "/") {
        closed = i;
        break;
      } else i += 1;
    }
    if (closed === -1 || closed === open + 1) continue;
    let end = closed + 1;
    while (end < line.length && isFlag(line[end])) end += 1;
    out.push({ literal: line.slice(open, end), src: line.slice(open + 1, closed), index: open });
    open = end - 1; // the for-loop increment moves past the literal
  }
  return out;
}

export function scanLine(text) {
  const findings = [];
  for (const { literal, src } of extractRegexLiterals(text)) {
    const masked = maskLiterals(src);
    for (const shape of REDOS_SHAPES) {
      if (shapeMatches(shape, masked)) {
        findings.push({ id: shape.id, codeql: shape.codeql, literal, fix: shape.fix });
      }
    }
  }
  return findings;
}


function tryGit(args, cwd = ROOT) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // A large diff overflows Node's 1 MB default and fails the gate.
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function resolveBase() {
  const ref = process.env.REMNIC_REGEX_SAFETY_BASE_REF || "origin/main";
  const head = tryGit(["rev-parse", "HEAD"]);
  if (tryGit(["rev-parse", "--verify", `${ref}^{commit}`])) {
    const mergeBase = tryGit(["merge-base", "HEAD", ref]);
    if (mergeBase && mergeBase.trim() !== (head ?? "").trim()) {
      return { base: mergeBase.trim(), ref };
    }
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
  const added = parseAddedLines(diff);
  const untracked = tryGit(["ls-files", "--others", "--exclude-standard", "--", "*.ts", "*.mts"]);
  if (untracked) {
    for (const relPath of untracked.split("\n")) {
      if (!relPath) continue;
      try {
        const lines = readFileSync(path.join(ROOT, relPath), "utf8").split("\n");
        for (let i = 0; i < lines.length; i += 1) {
          added.push({ file: relPath, line: i + 1, text: lines[i] });
        }
      } catch {
        // unreadable untracked file — the diff scan will surface tracked problems
      }
    }
  }
  return { added, base: resolved.ref };
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
