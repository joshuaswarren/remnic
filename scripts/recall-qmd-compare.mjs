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
  if (n < 2) return 1;
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
  if (dx === 0 || dy === 0) return 1;
  return num / Math.sqrt(dx * dy);
}

function loadResultFile(filePath) {
  const parsed = JSON.parse(readFileSync(filePath, "utf8"));
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  const totalMs = typeof parsed.timings?.totalMs === "number" ? parsed.timings.totalMs : null;
  return { results, totalMs };
}

function listJson(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

export function compareDirectories(beforeDir, afterDir) {
  const rows = [];
  for (const name of listJson(beforeDir)) {
    const afterPath = join(afterDir, name);
    let after;
    try {
      after = loadResultFile(afterPath);
    } catch {
      continue;
    }
    const before = loadResultFile(join(beforeDir, name));
    rows.push({
      name,
      ...compareRankedLists(before.results, after.results),
      beforeMs: before.totalMs,
      afterMs: after.totalMs,
    });
  }
  return rows;
}

export function compareRerankOff(dir) {
  const rows = [];
  for (const name of listJson(dir)) {
    const daemonSuffix = "-daemon.json";
    if (!name.endsWith(daemonSuffix)) continue;
    const offName = `${name.slice(0, -daemonSuffix.length)}-norerank.json`;
    const before = loadResultFile(join(dir, name));
    const after = loadResultFile(join(dir, offName));
    rows.push({
      name,
      ...compareRankedLists(before.results, after.results),
      beforeMs: before.totalMs,
      afterMs: after.totalMs,
    });
  }
  return rows;
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function formatComparison(rows) {
  const lines = ["name top1 overlap spearman before_ms after_ms"];
  for (const row of rows) {
    lines.push(
      [
        row.name,
        row.top1Match ? "yes" : "no",
        String(row.top10Overlap),
        row.spearman.toFixed(4),
        row.beforeMs === null ? "-" : String(row.beforeMs),
        row.afterMs === null ? "-" : String(row.afterMs),
      ].join(" ")
    );
  }
  const overlaps = rows.map((row) => row.top10Overlap);
  const correlations = rows.map((row) => row.spearman);
  const top1 = rows.filter((row) => row.top1Match).length;
  lines.push(
    `summary queries=${rows.length} top1=${top1}/${rows.length} mean_overlap=${mean(overlaps)?.toFixed(2) ?? "-"} mean_spearman=${mean(correlations)?.toFixed(4) ?? "-"}`
  );
  return lines.join("\n");
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--rerank-off" && args[1]) {
    process.stdout.write(`${formatComparison(compareRerankOff(args[1]))}\n`);
    return;
  }
  if (args.length >= 2) {
    process.stdout.write(`${formatComparison(compareDirectories(args[0], args[1]))}\n`);
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
