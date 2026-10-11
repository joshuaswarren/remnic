/**
 * Compare two ranked QMD result sets.
 *
 * Each JSON file is `{ results: [{ docid, score, rank? }], timings?: { totalMs } }`.
 * The report prints overlap and correlation only. It does not print queries,
 * paths, or document bodies.
 *
 *   node scripts/recall-qmd-compare.mjs <before-dir> <after-dir>
 *   node scripts/recall-qmd-compare.mjs --rerank-off <dir>
 *
 * --rerank-off pairs `<stem>-daemon.json` with `<stem>-norerank.json` in one
 * directory. That is the harness self-check against a captured rerank-on
 * baseline, not a live timing run.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MISSING_RANK = 11;

export function compareRankedLists(before, after) {
  const left = (before ?? []).slice(0, 10);
  const right = (after ?? []).slice(0, 10);
  const rightIds = new Set(right.map((row) => row.docid));
  const overlap = left.filter((row) => rightIds.has(row.docid)).length;
  const union = [];
  const seen = new Set();
  for (const row of [...left, ...right]) {
    if (seen.has(row.docid)) continue;
    seen.add(row.docid);
    union.push(row.docid);
  }
  const rankLeft = new Map(left.map((row, index) => [row.docid, index + 1]));
  const rankRight = new Map(right.map((row, index) => [row.docid, index + 1]));
  const xs = union.map((id) => rankLeft.get(id) ?? MISSING_RANK);
  const ys = union.map((id) => rankRight.get(id) ?? MISSING_RANK);
  return {
    top1Match: left[0]?.docid !== undefined && left[0].docid === right[0]?.docid,
    top10Overlap: overlap,
    spearman: spearman(xs, ys),
    unionSize: union.length,
  };
}

export function spearman(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  // Too few points have no correlation: equal inputs agree, anything else is
  // undefined. One constant side against a varying one is undefined too, never
  // a perfect score; two constant sides tie everything and agree.
  const same = xs.slice(0, n).every((value, i) => value === ys[i]);
  if (n < 2) return same ? 1 : null;
  let meanX = 0;
  let meanY = 0;
  for (let i = 0; i < n; i++) {
    meanX += xs[i];
    meanY += ys[i];
  }
  meanX /= n;
  meanY /= n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - meanX;
    const b = ys[i] - meanY;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return dx === 0 && dy === 0 ? 1 : null;
  return num / Math.sqrt(dx * dy);
}

function loadResultFile(filePath) {
  const parsed = JSON.parse(readFileSync(filePath, "utf8"));
  if (!Array.isArray(parsed?.results)) throw new Error(`${filePath}: results must be an array`);
  const results = parsed.results;
  const totalMs = typeof parsed.timings?.totalMs === "number" ? parsed.timings.totalMs : null;
  return { results, totalMs };
}

function listJson(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

function tryLoad(filePath) {
  try {
    return loadResultFile(filePath);
  } catch {
    return null;
  }
}

function pairRow(name, before, after) {
  if (!before || !after) {
    return { name, missing: true, beforeMs: before?.totalMs ?? null, afterMs: after?.totalMs ?? null };
  }
  return {
    // Exactly one side empty is a failed query, not a comparison.
    oneSidedEmpty: (before.results.length === 0) !== (after.results.length === 0),
    name,
    ...compareRankedLists(before.results, after.results),
    beforeMs: before.totalMs,
    afterMs: after.totalMs,
  };
}

// A counterpart that is absent or unreadable becomes an explicit `missing` row,
// so an incomplete run cannot look healthy.
export function compareDirectories(beforeDir, afterDir) {
  const names = [...new Set([...listJson(beforeDir), ...listJson(afterDir)])].sort();
  return names.map((name) => pairRow(name, tryLoad(join(beforeDir, name)), tryLoad(join(afterDir, name))));
}

export function compareRerankOff(dir) {
  // Stems come from either suffix, so a capture with only one side still shows up.
  const daemonSuffix = "-daemon.json";
  const offSuffix = "-norerank.json";
  const stems = new Set();
  for (const name of listJson(dir)) {
    if (name.endsWith(daemonSuffix)) stems.add(name.slice(0, -daemonSuffix.length));
    else if (name.endsWith(offSuffix)) stems.add(name.slice(0, -offSuffix.length));
  }
  return [...stems].sort().map((stem) =>
    pairRow(`${stem}${daemonSuffix}`, tryLoad(join(dir, `${stem}${daemonSuffix}`)), tryLoad(join(dir, `${stem}${offSuffix}`))),
  );
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function formatComparison(rows) {
  const lines = ["name top1 overlap spearman before_ms after_ms"];
  for (const row of rows) {
    const ms = (value) => (value === null ? "-" : String(value));
    if (row.missing) {
      lines.push([row.name, "MISSING", "-", "-", ms(row.beforeMs), "-"].join(" "));
      continue;
    }
    lines.push(
      [
        row.name + (row.oneSidedEmpty ? " EMPTY-SIDE" : ""),
        row.top1Match ? "yes" : "no",
        String(row.top10Overlap),
        row.spearman === null ? "-" : row.spearman.toFixed(4),
        ms(row.beforeMs),
        ms(row.afterMs),
      ].join(" ")
    );
  }
  const compared = rows.filter((row) => !row.missing);
  const overlaps = compared.map((row) => row.top10Overlap);
  const correlations = compared.map((row) => row.spearman).filter((value) => value !== null);
  const top1 = compared.filter((row) => row.top1Match).length;
  lines.push(
    `summary queries=${rows.length} compared=${compared.length} missing=${rows.length - compared.length} empty_side=${compared.filter((row) => row.oneSidedEmpty).length} top1=${top1}/${compared.length} mean_overlap=${mean(overlaps)?.toFixed(2) ?? "-"} mean_spearman=${mean(correlations)?.toFixed(4) ?? "-"}`
  );
  return lines.join("\n");
}

function report(rows) {
  process.stdout.write(`${formatComparison(rows)}\n`);
  if (rows.some((row) => row.missing || row.oneSidedEmpty)) process.exitCode = 1;
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--rerank-off" && args[1]) {
    report(compareRerankOff(args[1]));
    return;
  }
  if (args.length >= 2) {
    report(compareDirectories(args[0], args[1]));
    return;
  }
  process.stderr.write(
    "Usage: node scripts/recall-qmd-compare.mjs <before-dir> <after-dir>\n" +
      "       node scripts/recall-qmd-compare.mjs --rerank-off <dir>\n"
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
