/**
 * Value-free config diagnostics for a failed config load.
 *
 * A redactor is not enough here: CodeQL's taint tracker cannot see that a
 * generic `redact<T>(config)` sanitizes, so config values still reach
 * `console.error` on paper (js/clear-text-logging), and it is right to
 * complain — a redactor is only as good as its key pattern.
 *
 * This reports the SHAPE instead: which key paths exist, and which hold an
 * unresolved `${...}` placeholder, which is the failure `resolveEnvVars`
 * actually raises. No value is ever read into the output, so no key pattern
 * has to be maintained and a newly named secret field is safe by construction.
 */

/** `${FOO}` or `${FOO:-bar}` — the shape resolveEnvVars fails on. */
const UNRESOLVED_PLACEHOLDER = /^\$\{[^}]*\}$/;

export interface ConfigShapeEntry {
  /** Dotted key path. Array indices appear as `[n]`. */
  path: string;
  /** `object`, `array`, `string`, `number`, `boolean`, or `null`. */
  kind: string;
  /** True when a string value is an unresolved `${...}` placeholder. */
  unresolvedPlaceholder?: true;
}

export function describeConfigShape(value: unknown, maxEntries = 200): ConfigShapeEntry[] {
  const entries: ConfigShapeEntry[] = [];
  walk(value, "", entries, maxEntries);
  // Deterministic: path ascending, so two runs of the same failure read the
  // same and a diff of two operator reports is meaningful.
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

function walk(value: unknown, prefix: string, entries: ConfigShapeEntry[], maxEntries: number): void {
  if (entries.length >= maxEntries) return;
  if (Array.isArray(value)) {
    if (prefix !== "") entries.push({ path: prefix, kind: "array" });
    for (const [index, item] of value.entries()) {
      walk(item, `${prefix}[${index}]`, entries, maxEntries);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    if (prefix !== "") entries.push({ path: prefix, kind: "object" });
    for (const [key, nested] of Object.entries(value)) {
      walk(nested, prefix === "" ? key : `${prefix}.${key}`, entries, maxEntries);
    }
    return;
  }
  if (prefix === "") return;
  const kind = value === null ? "null" : typeof value;
  // The ONLY thing read from a string is whether it matches the placeholder
  // shape. The value itself never enters an entry.
  if (typeof value === "string" && UNRESOLVED_PLACEHOLDER.test(value)) {
    entries.push({ path: prefix, kind, unresolvedPlaceholder: true });
    return;
  }
  entries.push({ path: prefix, kind });
}

/** One line per entry, for console output. */
export function formatConfigShape(entries: readonly ConfigShapeEntry[]): string {
  if (entries.length === 0) return "  (config is empty)";
  return entries
    .map((entry) => `  ${entry.path}: ${entry.kind}${entry.unresolvedPlaceholder ? " (unresolved ${...} placeholder)" : ""}`)
    .join("\n");
}
