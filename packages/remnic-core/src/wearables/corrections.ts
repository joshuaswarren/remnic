/**
 * Wearable transcript corrections — user-specific replacement rules.
 *
 * ASR engines consistently mishear the same proper nouns for the same
 * person ("remnick" for "Remnic", a colleague's name, product jargon).
 * Rules come from two places, merged at sync time:
 *
 *  1. `wearables.corrections` in plugin config (declarative, versioned
 *     with the operator's config).
 *  2. A CLI-managed rules file at `state/wearables/corrections.json`
 *     (added interactively via `remnic wearables corrections add`).
 *
 * Literal rules are regex-escaped before compilation and replacements
 * are applied via a function (never a replacement string) so `$` in
 * either side can't corrupt output.
 */

import { promises as fsPromises } from "node:fs";
import * as path from "node:path";

import type { WearableCorrectionRule } from "./types.js";

export interface CompiledCorrectionRule {
  rule: WearableCorrectionRule;
  pattern: RegExp;
}

export interface CorrectionApplication {
  text: string;
  applied: number;
}

/** Hard cap on rule pattern length (bounds hostile/pathological regexes). */
const MAX_PATTERN_LENGTH = 256;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Validate and compile a correction rule. Throws a descriptive error on
 * invalid input (empty match, regex that doesn't compile, regex that
 * matches the empty string) — callers surface this at config parse or
 * CLI time rather than skipping the rule silently.
 */
export function compileCorrectionRule(
  rule: WearableCorrectionRule,
  label: string,
): CompiledCorrectionRule {
  if (typeof rule.match !== "string" || rule.match.length === 0) {
    throw new Error(`${label}: match must be a non-empty string`);
  }
  if (rule.match.length > MAX_PATTERN_LENGTH) {
    throw new Error(
      `${label}: match exceeds ${MAX_PATTERN_LENGTH} characters — correction patterns must stay short`,
    );
  }
  if (typeof rule.replace !== "string") {
    throw new Error(`${label}: replace must be a string`);
  }
  const flags = rule.caseInsensitive === false ? "g" : "gi";
  let pattern: RegExp;
  if (rule.regex === true) {
    try {
      // Operator-supplied regexes are the documented feature here
      // (rules live in the operator's own config / state file, never in
      // request input); the length cap above bounds pathological
      // patterns. CodeQL js/regex-injection is dismissed by design for
      // this site.
      pattern = new RegExp(rule.match, flags);
    } catch (err) {
      throw new Error(
        `${label}: match is not a valid regular expression: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  } else {
    // Literal rules match on word boundaries when both edges of the
    // match are word characters, so "remnick" doesn't fire inside
    // "remnickson" unless the user opts into regex mode.
    const escaped = escapeRegExp(rule.match);
    const leading = /^[\p{L}\p{N}_]/u.test(rule.match) ? "\\b" : "";
    const trailing = /[\p{L}\p{N}_]$/u.test(rule.match) ? "\\b" : "";
    pattern = new RegExp(`${leading}${escaped}${trailing}`, flags);
  }
  if (pattern.test("")) {
    throw new Error(
      `${label}: pattern matches the empty string and would corrupt every transcript`,
    );
  }
  pattern.lastIndex = 0;
  return { rule, pattern };
}

/** Compile a rule list, labeling errors with their index. */
export function compileCorrectionRules(
  rules: WearableCorrectionRule[],
  labelPrefix: string,
): CompiledCorrectionRule[] {
  return rules.map((rule, index) =>
    compileCorrectionRule(rule, `${labelPrefix}[${index}]`),
  );
}

/** Apply every applicable rule to a piece of transcript text. */
export function applyCorrections(
  text: string,
  rules: CompiledCorrectionRule[],
  sourceId: string,
): CorrectionApplication {
  let applied = 0;
  let result = text;
  for (const { rule, pattern } of rules) {
    if (
      Array.isArray(rule.sources) &&
      rule.sources.length > 0 &&
      !rule.sources.includes(sourceId)
    ) {
      continue;
    }
    pattern.lastIndex = 0;
    result = result.replace(pattern, () => {
      applied += 1;
      // Replacement via function: `$` in rule.replace stays literal.
      return rule.replace;
    });
  }
  return { text: result, applied };
}

// ---------------------------------------------------------------------------
// CLI-managed rules file
// ---------------------------------------------------------------------------

interface CorrectionsFileShape {
  version: 1;
  rules: WearableCorrectionRule[];
}

export function correctionsFilePath(memoryDir: string): string {
  return path.join(memoryDir, "state", "wearables", "corrections.json");
}

/**
 * Load CLI-managed correction rules. A missing file means no rules; a
 * malformed file throws (operators should know their corrections are
 * not being applied rather than silently losing them).
 */
export async function loadCorrectionsFile(
  memoryDir: string,
): Promise<WearableCorrectionRule[]> {
  const filePath = correctionsFilePath(memoryDir);
  let raw: string;
  try {
    raw = await fsPromises.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `wearables corrections file is not valid JSON (state/wearables/corrections.json): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !Array.isArray((parsed as CorrectionsFileShape).rules)
  ) {
    throw new Error(
      'wearables corrections file has an unexpected shape (state/wearables/corrections.json); expected {"version":1,"rules":[...]}',
    );
  }
  const rules = (parsed as CorrectionsFileShape).rules;
  // Validate every persisted rule up front so a hand-edited bad rule
  // fails at load with its index, not mid-sync.
  compileCorrectionRules(rules, "state corrections");
  return rules;
}

/** Persist CLI-managed rules atomically (temp file + rename). */
export async function saveCorrectionsFile(
  memoryDir: string,
  rules: WearableCorrectionRule[],
): Promise<void> {
  compileCorrectionRules(rules, "state corrections");
  const filePath = correctionsFilePath(memoryDir);
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  const payload: CorrectionsFileShape = { version: 1, rules };
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await fsPromises.writeFile(
    tmpPath,
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf-8",
  );
  try {
    await fsPromises.rename(tmpPath, filePath);
  } catch (err) {
    // Clean up the temp file on rename failure; the original (if any)
    // is untouched.
    await fsPromises.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}
