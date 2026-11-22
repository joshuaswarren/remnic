#!/usr/bin/env node
// Comment ratchet: comment-line counts can only shrink (COS-743).
// Check mode compares a fresh census against scripts/comment-ratchet-baseline.json
// and fails on ANY difference (a file gained or lost comment lines).
// Run `node scripts/check-comment-ratchet.mjs --update` to regenerate the
// baseline; it refuses to raise any existing per-file count or the total.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const cwd = process.cwd();
const require = createRequire(path.join(cwd, "package.json"));
const ts = require("typescript");

const BASELINE = "scripts/comment-ratchet-baseline.json";
const EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_PATH = [
  /(^|\/)node_modules\//, /(^|\/)dist\//, /(^|\/)build\//, /(^|\/)coverage\//,
  /(^|\/)(fixtures?|__fixtures__|testdata)\//i, /\.d\.ts$/,
  /corpus-scan-worker\.entry\.mjs$/,
];
const GENERATED_RE = /GENERATED FILE|do not edit|@generated/i;
const ROOTS = ["packages", "scripts", "src"];
const DIRECTIVE_RE = new RegExp("^\\s*(\\/\\/\\/?\\s*<(reference|amd)|\\/\\/\\/?\\s*@(ts-|eslint|biome|prettier|deno|jshint|istanbul|c8|v8|node|sourcemap|babel|webpack|rollup|swc|ncc)|\\/\\/\\s*(eslint|biome-ignore|tslint|jshint|istanbul|c8|v8|prettier-ignore|deno-lint|deno-coverage|nolint|@ts-))");

function collectFiles(root, out) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      if (SKIP_PATH.some((re) => re.test(p + "/"))) continue;
      collectFiles(p, out);
    } else if (e.isFile()) {
      if (SKIP_PATH.some((re) => re.test(p))) continue;
      if (EXTS.has(path.extname(e.name))) out.push(p);
    }
  }
}

function commentRanges(sf, text) {
  const seen = new Set();
  const ranges = [];
  const add = (r) => {
    if (!r) return;
    for (const c of r) {
      if (!seen.has(c.pos)) {
        seen.add(c.pos);
        ranges.push(c);
      }
    }
  };
  const visit = (node) => {
    add(ts.getLeadingCommentRanges(text, node.pos));
    add(ts.getTrailingCommentRanges(text, node.end));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return ranges.sort((a, b) => a.pos - b.pos);
}

function countComments(f, text) {
  const kind = /\.(m|c)js$/.test(f) || /\.jsx?$/.test(f) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, false, kind);
  let count = 0;
  for (const r of commentRanges(sf, text)) {
    const seg = text.slice(r.pos, r.end);
    const isShebang = r.pos === 0 && seg.startsWith("#!");
    const isLegal = r.kind === ts.SyntaxKind.MultiLineCommentTrivia
      && r.pos < text.split("\n", 40).join("\n").length
      && /(SPDX|Copyright|Licensed under|License)/.test(seg);
    if (isShebang || isLegal || DIRECTIVE_RE.test(seg.replace(/\n/g, " "))) continue;
    count += (seg.match(/\n/g) || []).length + 1;
  }
  return count;
}

function census() {
  const files = [];
  for (const root of ROOTS) collectFiles(root, files);
  const out = {};
  let total = 0;
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    if (GENERATED_RE.test(text.split("\n", 5).join("\n"))) continue;
    const n = countComments(f, text);
    if (n > 0) {
      out[f.split(path.sep).join("/") ] = n;
      total += n;
    }
  }
  return { files: out, total };
}

const update = process.argv.includes("--update");
const fresh = census();
const baselinePath = path.join(cwd, BASELINE);
const hadBaseline = fs.existsSync(baselinePath);
const old = hadBaseline
  ? JSON.parse(fs.readFileSync(baselinePath, "utf8"))
  : { total: 0, files: {} };

if (update) {
  let violation = null;
  if (hadBaseline) {
    for (const [f, n] of Object.entries(old.files)) {
      const now = fresh.files[f] ?? 0;
      if (now > n) violation = `${f}: ${n} -> ${now}`;
    }
    if (fresh.total > old.total) violation = violation ?? `total: ${old.total} -> ${fresh.total}`;
  }
  if (violation) {
    console.error(`--update refused, ratchet may only shrink: ${violation}`);
    process.exit(1);
  }
  fs.writeFileSync(
    baselinePath,
    `${JSON.stringify({ total: fresh.total, files: fresh.files }, null, 2)}\n`,
  );
  console.log(`baseline updated: ${old.total} -> ${fresh.total} comment lines across ${Object.keys(fresh.files).length} files`);
  process.exit(0);
}

const problems = [];
for (const [f, n] of Object.entries(old.files)) {
  const now = fresh.files[f] ?? 0;
  if (now !== n) problems.push(`${f}: baseline ${n}, now ${now}${now < n ? " (run --update)" : ""}`);
}
for (const [f, n] of Object.entries(fresh.files)) {
  if (!(f in old.files)) problems.push(`${f}: new file carries ${n} comment line(s); baseline forbids comments in files without a baseline entry`);
}
if (problems.length > 0) {
  console.error(`comment ratchet failed (${problems.length} file(s)):\n  ${problems.slice(0, 40).join("\n  ")}`);
  console.error("Lower counts only: delete comments, then run `node scripts/check-comment-ratchet.mjs --update` and commit the baseline change with the same PR.");
  process.exit(1);
}
console.log(`comment ratchet ok: ${fresh.total} comment lines, unchanged from baseline`);
