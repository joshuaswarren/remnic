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
 * Heuristic mirroring `isRegexLike` in correction-contract.ts: a pattern is
 * regex-like when it is wrapped in `/…/` OR contains regex metacharacters.
 * Kept in this module so the matcher does not import the correction module
 * (the correction module owns persistence; this owns consultation).
 */
function isRegexLike(pattern: string): boolean {
  if (pattern.startsWith("/") && pattern.endsWith("/") && pattern.length >= 2) return true;
  return /[\\^$.|?*+()[\]{}]/.test(pattern);
}

/**
 * Compile a single pattern into a matcher. A literal pattern matches by
 * case-sensitive substring; a regex-like pattern compiles into a RegExp
 * anchored to search (global flag off — we only need a boolean). Compilation
 * failures fall back to literal substring so a bad pattern never throws here.
 */
export function compileRedactionPattern(pattern: string): CompiledRedactionRule {
  const trimmed = pattern.trim();
  if (isRegexLike(trimmed)) {
    const body = trimmed.startsWith("/") && trimmed.endsWith("/")
      ? trimmed.slice(1, -1)
      : trimmed;
    try {
      const re = new RegExp(body);
      return { pattern: trimmed, matcher: (content) => re.test(content) };
    } catch {
      // Malformed regex despite validation (e.g. rule file hand-edited) —
      // treat as a literal so the rule still does something useful.
      return { pattern: trimmed, matcher: (content) => content.includes(trimmed) };
    }
  }
  return { pattern: trimmed, matcher: (content) => content.includes(trimmed) };
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
  const rules: CompiledRedactionRule[] = [];
  for (const name of names) {
    if (rules.length >= MAX_RULE_FILES) break;
    if (!name.endsWith(".json")) continue;
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
