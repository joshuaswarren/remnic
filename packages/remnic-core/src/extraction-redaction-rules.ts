/**
 * extraction-redaction-rules.ts — consults persisted correction redaction
 * rules during the extraction→persist path so a `never_store` / redaction_rule
 * correction actually blocks future extraction of matching content (issue
 * #1669, #1580 follow-up).
 *
 * The Correction Contract persists `redaction_rule` patterns to
 * `<storage>/state/corrections/redaction-rules/<slug>.json` (one file per
 * rule, idempotent on pattern). This module reads those patterns at the start
 * of each extraction persist pass and exposes a pure matcher the orchestrator
 * consults BEFORE a fact reaches the storage write chokepoint — mirroring how
 * tombstones are consulted at the write chokepoint (#1579), but one stage
 * earlier so the content never even lands as `pending_review`.
 *
 * Scope (issue #1669): the extraction layer consults the rules. Persistence
 * stays owned by the correction module. This helper is the read surface.
 *
 * Safety: patterns are validated at correction-apply time
 * (`validateRedactionPattern` — bounded literal/safe-regex, no catastrophic
 * shapes). We compile defensively here too: a pattern that fails to compile
 * as a regex is treated as a literal substring, and any matcher error is
 * swallowed (fail-open to "no match") so a malformed rule can never block the
 * entire extraction pipeline.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Directory (relative to a namespace storage dir) where redaction rules live.
 * Kept in sync with `registerRedactionRuleFn` in correction-access-wiring.ts.
 */
export const REDACTION_RULES_SUBDIR = path.join("state", "corrections", "redaction-rules");

/** Maximum number of rule files read per pass (defense in depth). */
const MAX_RULE_FILES = 256;

/**
 * A compiled redaction rule. `pattern` is the original (validated) pattern;
 * `matcher` returns true when content should be withheld.
 */
export interface CompiledRedactionRule {
  pattern: string;
  matcher: (content: string) => boolean;
}

/** Shape persisted by `registerRedactionRuleFn`. */
interface RedactionRuleFile {
  pattern: string;
  namespace?: string;
  createdAt?: string;
}

/**
 * Only `/…/`-wrapped patterns compile as RegExp; everything else is a literal
 * substring (review thread P1). An unwrapped pattern like `abc+def` must match
 * the literal string `abc+def`, NOT the regex `abccccdef`.
 */
function isRegexLike(pattern: string): boolean {
  return pattern.startsWith("/") && pattern.endsWith("/") && pattern.length >= 2;
}

/**
 * Reject patterns prone to catastrophic backtracking (ReDoS, review thread #3).
 * Mirrors the safe-regex heuristic: a quantifier inside a group that is itself
 * quantified creates exponential blowup on near-miss inputs. Also rejects
 * patterns with overlapping alternation under repetition
 * (e.g. (a|a)*). Returns true when the pattern is safe to compile.
 *
 * This is a second line of defense — validateRedactionPattern runs first at
 * apply time, but a hand-edited rule file or an edge case can still slip past.
 */
function isSafeRegex(source: string): boolean {
  // Bound the pattern length so a pathological rule cannot stall the check.
  if (source.length > 512) return false;
  // Reject overly-broad patterns (.*) that would match every fact and
  // withhold all extraction (cursor Bugbot thread — mirrors
  // isUnsafeRedactionRegex in correction-contract.ts).
  if (/(?:^|[^\\])\(\.\*\)|(?:^|[^\\])\.\*|(?:^|[^\\])\.\+|^\.([^*+]?)$/.test(source)) {
    return false;
  }
  // group body itself ends with a quantifier. This catches (a+)+, (a*)*, etc.
  // Also catches overlapping alternation like (a|a)+.
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== "(") continue;
    // Find the matching close paren
    let depth = 1;
    let j = i + 1;
    while (j < source.length && depth > 0) {
      if (source[j] === "\\") { j += 2; continue; }
      if (source[j] === "(") depth++;
      else if (source[j] === ")") depth--;
      j++;
    }
    if (depth !== 0) continue; // unbalanced — will fail RegExp compile anyway
    // Check if the char after the closing paren is a quantifier
    const afterGroup = source[j];
    if (afterGroup !== "+" && afterGroup !== "*" && afterGroup !== "{") continue;
    const groupBody = source.slice(i + 1, j - 1);
    // The group body ends with a quantifier on a non-escape char
    if (/[+*?]$/.test(groupBody) || /\{\d+,?\d*\}[+*?]?$/.test(groupBody)) {
      // Nested quantifier → potential ReDoS
      return false;
    }
    // Overlapping alternation: (a|a)+ where branches share a common prefix
    if (groupBody.includes("|")) {
      const branches = groupBody.split("|");
      if (branches.length >= 2) {
        const firstChars = new Set(branches.map((b) => b[0]).filter(Boolean));
        if (firstChars.size < branches.filter((b) => b.length > 0).length) {
          return false;
        }
      }
    }
    i = j;
  }
  return true;
}

/**
 * Compile a single pattern into a matcher. A literal pattern matches by
 * case-sensitive substring; a `/…/`-wrapped pattern compiles into a RegExp
 * anchored to search (global flag off — we only need a boolean). Compilation
 * failures fall back to literal substring so a bad pattern never throws here.
 */
export function compileRedactionPattern(pattern: string): CompiledRedactionRule {
  const trimmed = pattern.trim();
  if (!isRegexLike(trimmed)) {
    return { pattern: trimmed, matcher: (content) => content.includes(trimmed) };
  }
  const body = trimmed.slice(1, -1);
  try {
    if (!isSafeRegex(body)) {
      // Catastrophic-backtracking shape (e.g. (a+)+) — never compile.
      // Fall back to literal substring on the BODY (without delimiters) so the
      // rule still does something useful without risking a ReDoS.
      return { pattern: trimmed, matcher: (content) => content.includes(body) };
    }
    const re = new RegExp(body);
    return { pattern: trimmed, matcher: (content) => re.test(content) };
  } catch {
    // Malformed regex despite validation (e.g. rule file hand-edited) —
    // treat as a literal on the BODY so the rule still does something useful.
    return { pattern: trimmed, matcher: (content) => content.includes(body) };
  }
}

/**
 * Load + compile every redaction rule persisted under a namespace's storage
 * dir. Returns an empty array when the directory is absent or unreadable
 * (fail-open — a missing or corrupt rules dir must never block extraction).
 */
export async function loadRedactionRules(stateDir: string): Promise<CompiledRedactionRule[]> {
  const dir = path.join(stateDir, REDACTION_RULES_SUBDIR);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    // ENOENT (cold install, no rules yet) or permission error — no rules.
    return [];
  }
  // Sort deterministically (alphabetical by filename) so the set of rules
  // that survives the MAX_RULE_FILES cap is NOT filesystem-dependent (review
  // thread P2). Without this, readdir order varies by OS/FS and the silently
  // truncated rules are arbitrary — a never-store pattern could be dropped.
  const jsonFiles = names.filter((n) => n.endsWith(".json")).sort();
  if (jsonFiles.length > MAX_RULE_FILES) {
    // Visible failure mode: log a warning so the operator knows rules were
    // truncated, rather than silently dropping enforcement.
    console.warn(
      `extraction-redaction: ${jsonFiles.length} redaction rules in ${dir} exceed the ${MAX_RULE_FILES} cap; ` +
      `${jsonFiles.length - MAX_RULE_FILES} rules will NOT be enforced. Remove unused rules or raise the cap.`,
    );
  }
  const rules: CompiledRedactionRule[] = [];
  for (const name of jsonFiles.slice(0, MAX_RULE_FILES)) {
    try {
      const raw = await readFile(path.join(dir, name), "utf-8");
      const parsed = JSON.parse(raw) as RedactionRuleFile;
      if (typeof parsed?.pattern !== "string" || parsed.pattern.trim().length === 0) continue;
      rules.push(compileRedactionPattern(parsed.pattern));
    } catch {
      // Skip a corrupt rule file rather than failing the pass (rule 34 —
      // visible skip, never a silent pipeline block).
    }
  }
  return rules;
}

/**
 * Test content against a set of compiled rules. Returns true if ANY rule
 * matches (the content should be withheld). An empty rule set never matches.
 */
export function contentMatchesRedactionRules(
  content: string,
  rules: readonly CompiledRedactionRule[],
): boolean {
  for (const rule of rules) {
    try {
      if (rule.matcher(content)) return true;
    } catch {
      // A matcher should not throw (compilation already fell back), but if a
      // RegExp blows up on pathological input we skip that rule rather than
      // failing the whole gate.
    }
  }
  return false;
}
