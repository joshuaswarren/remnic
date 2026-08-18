#!/usr/bin/env node
/**
 * PR scope budget (issue #1991 PR2, umbrella #1988; subsystem-group and
 * multi-issue detection added in issue #2067).
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
 * Beyond raw line count, a diff can be small yet still unfocused: several
 * unrelated subsystems changed for several different issues in one PR. The
 * subsystem heuristic (issue #2067) classifies each core changed file into a
 * group (scripts/pr-scope-budget.json `subsystemGroups`) and reads issue
 * references from the PR title + body, then:
 *
 *   groups >= 3 AND issues >= 2                          -> warn
 *   groups >= 2 AND issues >= 2 AND groups share no
 *     package-level path ancestor (truly unrelated)      -> fail (exempt-able)
 *
 * Thresholds and the group map live in scripts/pr-scope-budget.json — no
 * magic numbers in workflow code; the check prints them on every run.
 *
 * Inputs (provided by the workflow):
 *   --files <path>    JSON array of GitHub `listFiles` objects
 *                     ({ filename, additions, deletions, status }) —
 *                     paginated to completion by the caller.
 *   --labels <path>   JSON array of label name strings on the PR.
 *   --pr-meta <path>  Optional plain-text PR title + body (issue references
 *                     are extracted from it). Absent -> no multi-issue signal.
 *
 * Pure with respect to the filesystem beyond those inputs — unit-testable
 * without GitHub.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isIgnoredPath, parseIgnoreManifest } from "./effective-diff.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");

export const EXEMPT_LABEL = "scope-budget-exempt";

/**
 * Minimum shared leading path segments two subsystem-group prefixes must have
 * to count as RELATED. A 2-segment ancestor is the top-level package
 * (`packages/<pkg>`); groups whose only common ancestor is shallower
 * (`packages/` alone, or nothing) are treated as truly unrelated subsystems.
 */
export const MIN_SHARED_ANCESTOR_SEGMENTS = 2;

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

/** Validate + normalize the optional subsystemGroups map (prefix -> group). */
export function loadSubsystemGroups(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("pr-scope-budget.json: subsystemGroups must be an object mapping path prefixes to group names");
  }
  for (const [prefix, group] of Object.entries(raw)) {
    if (typeof group !== "string" || group.length === 0) {
      throw new Error(`pr-scope-budget.json: subsystemGroups['${prefix}'] must be a non-empty string`);
    }
    if (prefix.startsWith("/")) {
      throw new Error(`pr-scope-budget.json: subsystemGroups key '${prefix}' must be repo-relative`);
    }
  }
  return { ...raw };
}

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
  return {
    warnLines: parsed.warnLines,
    failLines: parsed.failLines,
    subsystemGroups: loadSubsystemGroups(parsed.subsystemGroups),
  };
}

/**
 * All #<n> issue references in free text, deduped (issue #2067). Non-rendered
 * content is dropped first — HTML comments (template/generated <!-- ... -->
 * blocks) and fenced + inline code spans — so a hidden `<!-- related #2 -->`
 * or a hash in a code sample (a CSS hex color like #123456, a shell prompt) is
 * never mistaken for an issue ref, and the match requires GitHub
 * issue-reference boundaries (no adjacent alphanumerics, no leading #) so
 * `abc#12`, `#12ab`, and `##12` do not count.
 */
export function extractIssueRefs(text) {
  const issues = new Set();
  if (typeof text !== "string") return issues;
  const prose = text
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ");
  for (const match of prose.matchAll(
    /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+#(\d+)((?:\s*(?:,|and)\s*#\d+)*)/gi,
  )) {
    issues.add(Number(match[1]));
    for (const extra of match[2].matchAll(/#(\d+)/g)) {
      issues.add(Number(extra[1]));
    }
  }
  return issues;
}

/**
 * Classify a path into its subsystem group by LONGEST matching prefix — so a
 * fine subsystem key (packages/remnic-core/src/recall) wins over a broad
 * package key (packages/remnic-core/). Returns { group, prefix } or null.
 */
export function classifySubsystem(filename, subsystemGroups) {
  let best = null;
  for (const prefix of Object.keys(subsystemGroups)) {
    if (filename.startsWith(prefix) && (best === null || prefix.length > best.length)) {
      best = prefix;
    }
  }
  return best === null ? null : { group: subsystemGroups[best], prefix: best };
}

/** Count of leading path segments common to every prefix (0 when none share). */
export function sharedAncestorSegments(prefixes) {
  if (prefixes.length === 0) return 0;
  const segmented = prefixes.map((prefix) => prefix.split("/").filter((seg) => seg.length > 0));
  const [first, ...rest] = segmented;
  let count = 0;
  for (let i = 0; i < first.length; i += 1) {
    if (rest.every((segs) => segs[i] === first[i])) count += 1;
    else break;
  }
  return count;
}

/**
 * Compute the budget decision for a set of changed files.
 * Returns { coreLines, verdict: "pass"|"warn"|"fail"|"exempt", detail }.
 */
export function evaluateScopeBudget({ files, labels, thresholds, ignorePatterns, subsystemGroups = {}, prText = "" }) {
  if (!Array.isArray(files)) throw new Error("evaluateScopeBudget: files must be an array");
  if (!Array.isArray(labels)) throw new Error("evaluateScopeBudget: labels must be an array");

  let coreLines = 0;
  const coreFiles = [];
  const countsAgainstBudget = (candidate) =>
    typeof candidate === "string" &&
    candidate.length > 0 &&
    !isIgnoredPath(candidate, ignorePatterns) &&
    CORE_PATH_PREFIXES.some((prefix) => candidate.startsWith(prefix));
  for (const file of files) {
    const filename = file?.filename;
    if (typeof filename !== "string" || filename.length === 0) {
      throw new Error(`evaluateScopeBudget: file entry has no filename: ${JSON.stringify(file)}`);
    }
    // Renames: count when EITHER side is a non-ignored core path — a core
    // file renamed into a non-core or ignored destination still changed core
    // (review finding on #2003 round 3; mirrors splitEffectiveDiff's rule).
    const previous = typeof file?.previous_filename === "string" ? file.previous_filename : null;
    const currentCounts = countsAgainstBudget(filename);
    if (!currentCounts && !(previous !== null && countsAgainstBudget(previous))) {
      continue;
    }
    const additions = Number.isInteger(file.additions) ? file.additions : 0;
    const deletions = Number.isInteger(file.deletions) ? file.deletions : 0;
    coreLines += additions + deletions;
    // Classify BOTH core sides of a rename: a core file moved between
    // subsystems (core->core) changed both, and one moved to a
    // non-core/ignored destination still changed its source subsystem — so
    // grouping follows every core side, never just the new name
    // (review: cursor + codex on #2067).
    const classifyPaths = [];
    if (currentCounts) classifyPaths.push(filename);
    if (previous !== null && previous !== filename && countsAgainstBudget(previous)) {
      classifyPaths.push(previous);
    }
    coreFiles.push({ filename, lines: additions + deletions, classifyPaths });
  }
  coreFiles.sort((a, b) => b.lines - a.lines || a.filename.localeCompare(b.filename));

  const top = coreFiles
    .slice(0, 5)
    .map((f) => `${f.filename} (${f.lines})`)
    .join(", ");

  // Subsystem-group / multi-issue signal (issue #2067). Classification runs
  // over the same core files the line budget counts, so docs/tests/artifact
  // churn never inflates the group count.
  const groups = new Set();
  const prefixes = new Set();
  for (const file of coreFiles) {
    for (const candidate of file.classifyPaths) {
      const classified = classifySubsystem(candidate, subsystemGroups);
      if (classified) {
        groups.add(classified.group);
        prefixes.add(classified.prefix);
      }
    }
  }
  const issues = extractIssueRefs(prText);
  const ancestorSegments = sharedAncestorSegments([...prefixes]);
  const crossScopeFail = groups.size >= 2 && issues.size >= 2 && ancestorSegments < MIN_SHARED_ANCESTOR_SEGMENTS;
  const crossScopeWarn = !crossScopeFail && groups.size >= 3 && issues.size >= 2;
  const groupsList = [...groups].sort().join(", ");
  const issuesList = [...issues]
    .sort((a, b) => a - b)
    .map((n) => `#${n}`)
    .join(", ");
  const scopeSummary = `changes span ${groups.size} subsystem groups (${groupsList}) across ${issues.size} referenced issues (${issuesList})`;

  const isExempt = labels.includes(EXEMPT_LABEL);
  const failReasons = [];
  const warnReasons = [];

  if (coreLines > thresholds.failLines) {
    failReasons.push(
      `core effective diff is ${coreLines} changed lines — over the ${thresholds.failLines}-line fail threshold. Split by subsystem (schema/surface vs storage/serialization vs retrieval/behavior — AGENTS.md 'Cleaner PR Workflow'), or a maintainer may apply the '${EXEMPT_LABEL}' label with justification. Largest: ${top}`
    );
  } else if (coreLines > thresholds.warnLines) {
    warnReasons.push(
      `core effective diff is ${coreLines} changed lines — over the ${thresholds.warnLines}-line budget (fail at ${thresholds.failLines}). Consider splitting by subsystem. Largest: ${top}`
    );
  }

  if (crossScopeFail) {
    failReasons.push(
      `${scopeSummary} whose subsystems share no package-level ancestor — split into one PR per issue, or a maintainer may apply the '${EXEMPT_LABEL}' label.`
    );
  } else if (crossScopeWarn) {
    warnReasons.push(`${scopeSummary} — consider splitting into one PR per issue.`);
  }

  if (failReasons.length > 0) {
    if (isExempt) {
      return {
        coreLines,
        verdict: "exempt",
        detail: `passing ONLY because the '${EXEMPT_LABEL}' label is present. ${failReasons.join(" ")}`,
      };
    }
    return { coreLines, verdict: "fail", detail: failReasons.join(" ") };
  }
  if (warnReasons.length > 0) {
    return { coreLines, verdict: "warn", detail: warnReasons.join(" ") };
  }
  return {
    coreLines,
    verdict: "pass",
    detail: `core effective diff is ${coreLines} changed lines (budget ${thresholds.warnLines}).`,
  };
}

const CLI_FLAGS = ["--files", "--labels", "--thresholds", "--ignore", "--pr-meta"];
const CLI_USAGE =
  "usage: pr-scope-budget.mjs --files <files.json> --labels <labels.json> [--thresholds <path>] [--ignore <path>] [--pr-meta <path>]";

function parseCliArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!CLI_FLAGS.includes(flag) || value === undefined) {
      throw new Error(CLI_USAGE);
    }
    out[flag.slice(2)] = value;
  }
  if (!out.files || !out.labels) {
    throw new Error(CLI_USAGE);
  }
  return out;
}

function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const files = JSON.parse(readFileSync(args.files, "utf8"));
  const labels = JSON.parse(readFileSync(args.labels, "utf8"));
  // CI passes --thresholds/--ignore pointing at copies fetched from the PR's
  // BASE ref, so a PR can never weaken its own budget by editing these files
  // in the same head (review finding on #2003 — both bots, independently).
  // The repo-local defaults serve local/manual runs only.
  const thresholds = loadThresholds(args.thresholds ?? path.join(SCRIPT_DIR, "pr-scope-budget.json"));
  const ignorePatterns = parseIgnoreManifest(
    readFileSync(args.ignore ?? path.join(ROOT, ".github", "ai-review-ignore"), "utf8")
  );
  // PR title + body is DATA (author-controlled), never executed — only scanned
  // for #<n> issue references. Absent -> no multi-issue signal.
  const prText = args["pr-meta"] ? readFileSync(args["pr-meta"], "utf8") : "";

  const result = evaluateScopeBudget({
    files,
    labels,
    thresholds,
    ignorePatterns,
    subsystemGroups: thresholds.subsystemGroups,
    prText,
  });
  console.log(
    `[scope-budget] thresholds: warn > ${thresholds.warnLines}, fail > ${thresholds.failLines} (core paths, artifact paths excluded)`
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

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  main();
}
