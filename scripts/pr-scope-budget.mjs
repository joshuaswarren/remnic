#!/usr/bin/env node
/**
 * PR scope budget (issue #1991 PR2, umbrella #1988).
 *
 * Mean PR diff size doubled (1,246 -> 2,653 lines) the week after review
 * friction fell, and the 40-59-thread churn tails live in the largest
 * diffs. The narrow-scope rule was prose; this makes it a number.
 *
 * Measures the EFFECTIVE diff (changed lines minus .github/ai-review-ignore
 * artifact paths — shared manifest with the AI review gate) against CORE
 * package paths only, then:
 *
 *   <= warnLines            -> pass
 *   >  warnLines            -> warn (exit 0, ::warning annotation)
 *   >  failLines            -> fail (exit 1) unless the PR carries the
 *                              `scope-budget-exempt` label (auditable,
 *                              maintainer-applied; re-evaluated every run —
 *                              removing the label re-fails).
 *
 * Thresholds live in scripts/pr-scope-budget.json — no magic numbers in
 * workflow code; the check prints them on every run.
 *
 * Inputs (provided by the workflow):
 *   --files <path>   JSON array of GitHub `listFiles` objects
 *                    ({ filename, additions, deletions, status }) —
 *                    paginated to completion by the caller.
 *   --labels <path>  JSON array of label name strings on the PR.
 *
 * Pure with respect to the filesystem beyond those inputs — unit-testable
 * without GitHub.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseIgnoreManifest, isIgnoredPath } from "./effective-diff.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");

export const EXEMPT_LABEL = "scope-budget-exempt";

/** Core paths whose changed lines count against the budget. */
export const CORE_PATH_PREFIXES = [
  "packages/remnic-core/",
  "packages/remnic-cli/",
  "packages/remnic-server/",
  "packages/plugin-openclaw/",
  "packages/plugin-claude-code/",
  "packages/plugin-codex/",
  "packages/plugin-hermes/",
  "packages/plugin-pi/",
  "packages/shim-openclaw-engram/",
  "src/",
];

export function loadThresholds(thresholdsPath) {
  const parsed = JSON.parse(readFileSync(thresholdsPath, "utf8"));
  for (const key of ["warnLines", "failLines"]) {
    if (!Number.isInteger(parsed[key]) || parsed[key] <= 0) {
      throw new Error(`pr-scope-budget.json: ${key} must be a positive integer`);
    }
  }
  if (parsed.failLines <= parsed.warnLines) {
    throw new Error("pr-scope-budget.json: failLines must exceed warnLines");
  }
  return { warnLines: parsed.warnLines, failLines: parsed.failLines };
}

/**
 * Compute the budget decision for a set of changed files.
 * Returns { coreLines, verdict: "pass"|"warn"|"fail"|"exempt", detail }.
 */
export function evaluateScopeBudget({ files, labels, thresholds, ignorePatterns }) {
  if (!Array.isArray(files)) throw new Error("evaluateScopeBudget: files must be an array");
  if (!Array.isArray(labels)) throw new Error("evaluateScopeBudget: labels must be an array");

  let coreLines = 0;
  const coreFiles = [];
  for (const file of files) {
    const filename = file?.filename;
    if (typeof filename !== "string" || filename.length === 0) {
      throw new Error(`evaluateScopeBudget: file entry has no filename: ${JSON.stringify(file)}`);
    }
    if (isIgnoredPath(filename, ignorePatterns)) continue;
    if (!CORE_PATH_PREFIXES.some((prefix) => filename.startsWith(prefix))) continue;
    const additions = Number.isInteger(file.additions) ? file.additions : 0;
    const deletions = Number.isInteger(file.deletions) ? file.deletions : 0;
    coreLines += additions + deletions;
    coreFiles.push({ filename, lines: additions + deletions });
  }
  coreFiles.sort((a, b) => b.lines - a.lines || a.filename.localeCompare(b.filename));

  const top = coreFiles
    .slice(0, 5)
    .map((f) => `${f.filename} (${f.lines})`)
    .join(", ");

  if (coreLines > thresholds.failLines) {
    if (labels.includes(EXEMPT_LABEL)) {
      return {
        coreLines,
        verdict: "exempt",
        detail: `core effective diff is ${coreLines} changed lines (> fail threshold ${thresholds.failLines}) — passing ONLY because the '${EXEMPT_LABEL}' label is present. Largest: ${top}`,
      };
    }
    return {
      coreLines,
      verdict: "fail",
      detail: `core effective diff is ${coreLines} changed lines — over the ${thresholds.failLines}-line fail threshold. Split by subsystem (schema/surface vs storage/serialization vs retrieval/behavior — AGENTS.md 'Cleaner PR Workflow'), or a maintainer may apply the '${EXEMPT_LABEL}' label with justification. Largest: ${top}`,
    };
  }
  if (coreLines > thresholds.warnLines) {
    return {
      coreLines,
      verdict: "warn",
      detail: `core effective diff is ${coreLines} changed lines — over the ${thresholds.warnLines}-line budget (fail at ${thresholds.failLines}). Consider splitting by subsystem. Largest: ${top}`,
    };
  }
  return {
    coreLines,
    verdict: "pass",
    detail: `core effective diff is ${coreLines} changed lines (budget ${thresholds.warnLines}).`,
  };
}

function parseCliArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag !== "--files" && flag !== "--labels") || value === undefined) {
      throw new Error("usage: pr-scope-budget.mjs --files <files.json> --labels <labels.json>");
    }
    out[flag.slice(2)] = value;
  }
  if (!out.files || !out.labels) {
    throw new Error("usage: pr-scope-budget.mjs --files <files.json> --labels <labels.json>");
  }
  return out;
}

function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const files = JSON.parse(readFileSync(args.files, "utf8"));
  const labels = JSON.parse(readFileSync(args.labels, "utf8"));
  const thresholds = loadThresholds(path.join(SCRIPT_DIR, "pr-scope-budget.json"));
  const ignorePatterns = parseIgnoreManifest(
    readFileSync(path.join(ROOT, ".github", "ai-review-ignore"), "utf8"),
  );

  const result = evaluateScopeBudget({ files, labels, thresholds, ignorePatterns });
  console.log(
    `[scope-budget] thresholds: warn > ${thresholds.warnLines}, fail > ${thresholds.failLines} (core paths, artifact paths excluded)`,
  );
  console.log(`[scope-budget] ${result.verdict.toUpperCase()}: ${result.detail}`);
  if (result.verdict === "warn" || result.verdict === "exempt") {
    console.log(`::warning title=PR scope budget::${result.detail}`);
  }
  if (result.verdict === "fail") {
    console.log(`::error title=PR scope budget::${result.detail}`);
    process.exit(1);
  }
}

const isDirectExecution =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  main();
}
