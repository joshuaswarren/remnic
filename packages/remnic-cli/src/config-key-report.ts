/**
 * Value-free diagnostics for a config file that failed to load.
 *
 * `parseConfig` error text embeds raw config values, so `err.message` cannot
 * reach console output (CodeQL js/clear-text-logging). Three weaker fixes were
 * tried first and each was wrong in an instructive way:
 *
 * 1. Redacting the parsed object. Taint analysis cannot see through a generic
 *    `redact<T>()`, and a key deny-list is only as complete as its last edit.
 * 2. Describing the parsed object's shape. Still READS every value, including
 *    `openaiApiKey`, so the sensitive access happens regardless of what the
 *    walker keeps.
 * 3. Regex-scanning the raw text for `"key":` tokens. A regex has no
 *    structural context, and this path exists precisely because the file did
 *    NOT parse: in `{"openaiApiKey":"secret":}` the VALUE is followed by a
 *    colon, so the secret matches the key pattern and gets printed.
 *
 * So this is a positional scanner. A string is reported only when the scanner
 * is genuinely in an object-key slot, scanning stops at the first lexical
 * error, and no value is ever copied out — only the fact that a value had the
 * `${...}` placeholder shape, which is the failure `resolveEnvVars` raises.
 * No property of the parsed config is accessed either, so no value can reach
 * output by construction: there is no pattern to maintain and a newly named
 * secret field is safe without editing this file.
 */

/** Key names are reported only within this charset; anything else is skipped. */
const REPORTABLE_KEY = /^[A-Za-z0-9_.-]{1,128}$/;

export interface ConfigKeyReport {
  /** Sorted, de-duplicated key names found in object-key position. */
  keys: string[];
  /** Reported keys whose value had the `${...}` placeholder shape. */
  unresolved: string[];
  /** True when scanning stopped early: lexical error or the key cap. */
  truncated: boolean;
}

/** Read a JSON string starting at `i` (which must index the opening quote). */
function readString(text: string, i: number): { value: string; next: number } | null {
  let out = "";
  let index = i + 1;
  while (index < text.length) {
    const ch = text[index]!;
    if (ch === "\\") {
      // Keep the pair opaque: the escape's meaning does not matter here, only
      // that it cannot terminate the string.
      index += 2;
      out += "\u0000";
      continue;
    }
    if (ch === '"') return { value: out, next: index + 1 };
    if (ch === "\n") return null;
    out += ch;
    index += 1;
  }
  return null;
}

/** Skip whitespace. Bounded by the input length; no backtracking. */
function skipWs(text: string, i: number): number {
  let index = i;
  while (index < text.length && (text[index] === " " || text[index] === "\t" || text[index] === "\n" || text[index] === "\r")) {
    index += 1;
  }
  return index;
}

export function reportConfigKeys(rawText: string, maxKeys = 200): ConfigKeyReport {
  const empty: ConfigKeyReport = { keys: [], unresolved: [], truncated: false };
  if (typeof rawText !== "string" || rawText.trim() === "") return empty;

  const keys = new Set<string>();
  const unresolved = new Set<string>();
  // Context stack: true = inside an object (so a string may be a key),
  // false = inside an array (a string is always a value).
  const inObject: boolean[] = [];
  let truncated = false;
  let i = skipWs(rawText, 0);
  let expectKey = false;

  scan: while (i < rawText.length) {
    const ch = rawText[i]!;
    if (ch === "{") {
      inObject.push(true);
      expectKey = true;
      i = skipWs(rawText, i + 1);
      continue;
    }
    if (ch === "[") {
      inObject.push(false);
      expectKey = false;
      i = skipWs(rawText, i + 1);
      continue;
    }
    if (ch === "}" || ch === "]") {
      inObject.pop();
      expectKey = false;
      i = skipWs(rawText, i + 1);
      continue;
    }
    if (ch === ",") {
      expectKey = inObject[inObject.length - 1] === true;
      i = skipWs(rawText, i + 1);
      continue;
    }
    if (ch === '"') {
      const read = readString(rawText, i);
      if (!read) {
        truncated = true;
        break scan;
      }
      const after = skipWs(rawText, read.next);
      const isKeySlot = expectKey && inObject[inObject.length - 1] === true && rawText[after] === ":";
      if (isKeySlot) {
        if (keys.size >= maxKeys) {
          truncated = true;
          break scan;
        }
        if (REPORTABLE_KEY.test(read.value)) keys.add(read.value);
        // Look at the value only to classify its SHAPE. Nothing is copied.
        const valueStart = skipWs(rawText, after + 1);
        if (rawText[valueStart] === '"') {
          const value = readString(rawText, valueStart);
          if (value && value.value.startsWith("${") && value.value.endsWith("}")) {
            if (REPORTABLE_KEY.test(read.value)) unresolved.add(read.value);
          }
          i = value ? value.next : valueStart;
          if (!value) {
            truncated = true;
            break scan;
          }
          expectKey = false;
          i = skipWs(rawText, i);
          continue;
        }
        expectKey = false;
        i = valueStart;
        continue;
      }
      // A string in value position: never reported, never inspected further.
      expectKey = false;
      i = after;
      continue;
    }
    // A key slot may only hold a string. Anything else means the file is
    // broken here, and continuing would let a later string be read as a key —
    // that is exactly how `{"a":1, /* "secret": */ }` leaked a value in an
    // earlier revision. Stop at the lexical error instead.
    if (expectKey) {
      truncated = true;
      break scan;
    }
    // Otherwise this is a scalar in value position: skip one character.
    i += 1;
  }

  const sort = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return { keys: [...keys].sort(sort), unresolved: [...unresolved].sort(sort), truncated };
}

/** Operator-facing lines. Key names only; never a value. */
export function formatConfigKeyReport(report: ConfigKeyReport): string {
  if (report.keys.length === 0) {
    return report.truncated ? "  (config could not be scanned)" : "  (no config keys found)";
  }
  const unresolved = new Set(report.unresolved);
  const lines = report.keys.map(
    (key) => `  ${key}${unresolved.has(key) ? " (unresolved ${...} placeholder)" : ""}`,
  );
  if (report.truncated) lines.push("  (scan stopped early: malformed config or key cap reached)");
  return lines.join("\n");
}
