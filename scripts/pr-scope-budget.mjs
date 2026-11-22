#!/usr/bin/env node

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
  "packages/plugin-devin/",
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

const DESCRIPTIVE_ARTICLES = new Set(["the", "a", "an"]);

/** Past-participle spellings of the closing keywords ("closed", not "closes"). */
const PAST_PARTICIPLE_KEYWORDS = new Set(["fixed", "closed", "resolved"]);

const CURRENT_REPO = "joshuaswarren/remnic";

/**
 * Issues CLAIMED by PR-body closing keywords, deduped (issues #2067, #2919).
 * The grammar is GitHub's closing-keyword form: keyword + optional
 * OWNER/REPOSITORY qualifier + #<n>. Same-repo comma/"and" lists may
 * continue as local `#<n>` only — `Fixes #1, #2 and #3`. A qualified
 * reference needs its own keyword (`resolves octo-org/octo-repo#100`);
 * `Fixes #1 and octo-org/octo-repo#2` does not claim the second.
 * Local `#100` and `owner/repo#100` are distinct claims — except that a
 * qualifier naming the current repository canonicalizes to the bare
 * number, so both spellings of one issue count once (issue #2948). Bare
 * #<n> citations — ordinary prose, quoted source comments, anything
 * without a keyword — never count, and neither do citations from
 * contents, commit messages, or review text: the parser consumes PR text
 * only (the workflow passes the body, #2919). Non-rendered content is
 * dropped first — HTML comments (template/generated <!-- ... --> blocks) and
 * fenced + inline code spans — so a hidden `<!-- related #2 -->` or a hash
 * in a code sample (a CSS hex color like #123456, a shell prompt) is never
 * mistaken for an issue ref, and the match requires GitHub
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
  // Qualifier is captured on the keyword-headed ref only. Continuations
  // are local `#<n>` so `Fixes #1, #2, and #3` still works, while a
  // keywordless `owner/repo#n` after `and`/comma is not a claim.
  const repoOrLocalHash = String.raw`(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#|#)`;
  const closingKeywordPattern = new RegExp(
    String.raw`(\w+\s+)?\b(fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+${repoOrLocalHash}(\d+)` +
      String.raw`((?:(?:\s*(?:,|and)\s*)+#\d+)*)` +
      String.raw`(?!\w)`,
    "gi",
  );
  for (const match of prose.matchAll(closingKeywordPattern)) {
    const lead = (match[1] ?? "").trim().toLowerCase();
    const keyword = match[2].toLowerCase();
    if (DESCRIPTIVE_ARTICLES.has(lead) && PAST_PARTICIPLE_KEYWORDS.has(keyword)) continue;
    issues.add(claimedIssue(match[3], match[4]));
    for (const extra of match[5].matchAll(/#(\d+)/g)) {
      issues.add(Number(extra[1]));
    }
  }
  return issues;
}

function claimedIssue(repo, number) {
  if (!repo || repo.toLowerCase() === CURRENT_REPO) return Number(number);
  return `${repo}#${number}`;
}

function formatClaimedIssueList(issues) {
  return [...issues]
    .sort((a, b) => {
      const num = (value) =>
        typeof value === "number" ? value : Number(String(value).slice(String(value).lastIndexOf("#") + 1));
      return num(a) - num(b) || String(typeof a).localeCompare(String(typeof b)) || String(a).localeCompare(String(b));
    })
    .map((claim) => (typeof claim === "number" ? `#${claim}` : String(claim)))
    .join(", ");
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
    const previous = typeof file?.previous_filename === "string" ? file.previous_filename : null;
    const currentCounts = countsAgainstBudget(filename);
    if (!currentCounts && !(previous !== null && countsAgainstBudget(previous))) {
      continue;
    }
    const additions = Number.isInteger(file.additions) ? file.additions : 0;
    const deletions = Number.isInteger(file.deletions) ? file.deletions : 0;
    coreLines += additions + deletions;
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
  const issuesList = formatClaimedIssueList(issues);
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
  const thresholds = loadThresholds(args.thresholds ?? path.join(SCRIPT_DIR, "pr-scope-budget.json"));
  const ignorePatterns = parseIgnoreManifest(
    readFileSync(args.ignore ?? path.join(ROOT, ".github", "ai-review-ignore"), "utf8")
  );
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
