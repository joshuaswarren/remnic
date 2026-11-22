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

function isRegexLike(pattern: string): boolean {
  return pattern.startsWith("/") && pattern.endsWith("/") && pattern.length >= 2;
}

function isSafeRegex(source: string): boolean {
  if (source.length === 0 || source.length > 512) return false;
  if (/(?:^|[^\\])\(\.\*\)|(?:^|[^\\])\.\*|(?:^|[^\\])\.\+|^\.([^*+]?)$/.test(source)) {
    return false;
  }
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== "(") continue;
    let depth = 1;
    let j = i + 1;
    while (j < source.length && depth > 0) {
      if (source[j] === "\\") { j += 2; continue; }
      if (source[j] === "(") depth++;
      else if (source[j] === ")") depth--;
      j++;
    }
    if (depth !== 0) continue; // unbalanced — will fail RegExp compile anyway
    const afterGroup = source[j];
    if (afterGroup !== "+" && afterGroup !== "*" && afterGroup !== "{") continue;
    const groupBody = source.slice(i + 1, j - 1);
    if (/[+*?]$/.test(groupBody) || /\{\d+,?\d*\}[+*?]?$/.test(groupBody)) {
      return false;
    }
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
      if (body.length === 0) return { pattern: trimmed, matcher: () => false };
      return { pattern: trimmed, matcher: (content) => content.includes(body) };
    }
    const re = new RegExp(body);
    if (re.test("")) {
      return { pattern: trimmed, matcher: (content) => content.includes(body) };
    }
    return { pattern: trimmed, matcher: (content) => re.test(content) };
  } catch {
    return { pattern: trimmed, matcher: (content) => content.includes(body) };
  }
}

export async function loadRedactionRules(stateDir: string): Promise<CompiledRedactionRule[]> {
  const dir = path.join(stateDir, REDACTION_RULES_SUBDIR);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const jsonFiles = names.filter((n) => n.endsWith(".json")).sort();
  if (jsonFiles.length > MAX_RULE_FILES) {
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
