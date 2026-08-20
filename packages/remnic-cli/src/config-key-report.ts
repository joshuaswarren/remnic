/**
 * Value-free diagnostics for a config file that failed to load.
 *
 * `parseConfig` error text embeds raw config values, so `err.message` cannot
 * reach console output (CodeQL js/clear-text-logging). Two weaker fixes were
 * tried first and both were wrong:
 *
 * 1. Redacting the parsed object. Taint analysis cannot see through a generic
 *    `redact<T>()`, and a key deny-list is only as complete as its last edit.
 * 2. Describing the parsed object's shape. Better in principle, but walking it
 *    still READS every value — including `openaiApiKey` — so the sensitive
 *    access CodeQL flags is still performed, whatever we then do with it.
 *
 * This reads the config's raw TEXT and reports key names only. No property of
 * the parsed config is ever accessed, so no value can be logged by
 * construction — there is no pattern to maintain and a newly named secret
 * field is safe without anyone updating this file.
 */

/** A `"key":` token. Captures the key name, not what follows it. */
const KEY_TOKEN = /"((?:[^"\\]|\\.)*)"\s*:/g;

/** A `"key": "${...}"` pair — the failure `resolveEnvVars` actually raises. */
const UNRESOLVED_PAIR = /"((?:[^"\\]|\\.)*)"\s*:\s*"\$\{[^}"]*\}"/g;

export interface ConfigKeyReport {
  /** Sorted, de-duplicated key names present in the file. */
  keys: string[];
  /** Keys whose value is an unresolved `${...}` placeholder. */
  unresolved: string[];
}

export function reportConfigKeys(rawText: string, maxKeys = 200): ConfigKeyReport {
  if (typeof rawText !== "string" || rawText.trim() === "") {
    return { keys: [], unresolved: [] };
  }
  const keys = new Set<string>();
  for (const match of rawText.matchAll(KEY_TOKEN)) {
    if (keys.size >= maxKeys) break;
    keys.add(match[1] ?? "");
  }
  const unresolved = new Set<string>();
  for (const match of rawText.matchAll(UNRESOLVED_PAIR)) {
    unresolved.add(match[1] ?? "");
  }
  const sort = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return { keys: [...keys].sort(sort), unresolved: [...unresolved].sort(sort) };
}

/** Operator-facing lines. Key names only; never a value. */
export function formatConfigKeyReport(report: ConfigKeyReport): string {
  if (report.keys.length === 0) return "  (no config keys found)";
  const lines = report.keys.map(
    (key) => `  ${key}${report.unresolved.includes(key) ? " (unresolved ${...} placeholder)" : ""}`,
  );
  return lines.join("\n");
}
