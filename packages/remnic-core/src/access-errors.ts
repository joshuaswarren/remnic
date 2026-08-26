/**
 * Tool-surface error enrichment: nearest-tool suggestions and arg-shape hints.
 *
 * Each function is a pure message builder — it returns a better error string
 * without changing semantics, status codes, or rejection behavior.
 *
 * @module access-errors
 */

import type { ZodError } from "zod";

// ─── Existing error classes (restored from pre-#3042) ─────────────────────

/** Authenticated caller lacks the required authorization (HTTP 403). */
export class EngramAccessForbiddenError extends Error {}

/** Invalid caller input (HTTP 400). */
export class EngramAccessInputError extends Error {}

/**
 * A write rejected by the namespace write-ACL (issue #1888). Subclasses
 * EngramAccessInputError so every existing catch/HTTP-400 mapping still
 * applies, but carries the attempted namespace + principal so the observe/
 * write surfaces can dead-letter the payload before re-throwing (fail-closed
 * placement is unchanged; only the destroyed-payload behavior is fixed).
 */
export class NamespaceNotWritableError extends EngramAccessInputError {
  constructor(
    readonly attemptedNamespace: string,
    readonly principal: string | undefined,
    message?: string,
  ) {
    super(message ?? `namespace is not writable: ${attemptedNamespace}`);
    this.name = "NamespaceNotWritableError";
  }
}

// ─── Levenshtein distance ─────────────────────────────────────────────────

/**
 * Standard Levenshtein edit distance. O(n*m) over bounded inputs.
 * Exported so the test can verify it without importing private helpers.
 */
export function levenshtein(a: string, b: string): number {
  const an = a.length;
  const bn = b.length;
  // Fast paths for empty strings.
  if (an === 0) return bn;
  if (bn === 0) return an;

  // Use two rows to keep memory O(min(n,m)).
  let prev: number[] = [];
  let curr: number[] = [];

  // Align loops to the shorter string.
  const [shorter, longer, sn, ln] =
    an < bn ? [a, b, an, bn] : [b, a, bn, an];

  for (let i = 0; i <= sn; i++) prev[i] = i;

  for (let j = 1; j <= ln; j++) {
    curr[0] = j;
    for (let i = 1; i <= sn; i++) {
      const cost = shorter[i - 1] === longer[j - 1] ? 0 : 1;
      curr[i] = Math.min(
        prev[i] + 1,       // deletion
        curr[i - 1] + 1,   // insertion
        prev[i - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[sn];
}

// ─── Similar-name helpers ─────────────────────────────────────────────────

const SUGGESTION_DISTANCE_CAP = 3;

export interface SuggestionCandidate {
  name: string;
  distance: number;
}

/**
 * Find the nearest registered tool names by Levenshtein distance.
 * Results are sorted by distance ascending then name ascending (deterministic).
 * Only names with distance <= {@link SUGGESTION_DISTANCE_CAP} are returned;
 * when no name is that close the caller falls back to listing the full set.
 */
export function nearestSuggestions(
  requested: string,
  registeredNames: readonly string[],
): SuggestionCandidate[] {
  const candidates: SuggestionCandidate[] = [];
  for (const name of registeredNames) {
    const distance = levenshtein(requested.toLowerCase(), name.toLowerCase());
    if (distance <= SUGGESTION_DISTANCE_CAP) {
      candidates.push({ name, distance });
    }
  }
  // Total comparator: distance asc, then name asc.
  candidates.sort((a, b) => {
    if (a.distance !== b.distance) return a.distance < b.distance ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return candidates;
}

/**
 * Build a human-readable "did you mean?" suggestion string.
 * When no close match is found, returns a fallback listing.
 */
function buildSuggestion(
  requested: string,
  registeredNames: readonly string[],
): string {
  const suggestions = nearestSuggestions(requested, registeredNames);
  if (suggestions.length === 0) {
    return `Registered tools: ${registeredNames.join(", ")}`;
  }
  return `Did you mean ${suggestions.map((s) => s.name).join(", ")}?`;
}

/**
 * Reverse-engineer ONE synthetic example value from a Zod schema type.
 * Returns a deterministic placeholder that round-trips through parse().
 */
function exampleFromSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return undefined;
  const obj = schema as Record<string, unknown>;
  if (obj._def?.typeName === "ZodString") return "<string>";
  if (obj._def?.typeName === "ZodNumber") return 42;
  if (obj._def?.typeName === "ZodBoolean") return true;
  if (obj._def?.typeName === "ZodNullable") return null;
  if (obj._def?.typeName === "ZodOptional") return undefined;
  if (obj._def?.typeName === "ZodArray") return [];
  if (obj._def?.typeName === "ZodObject") {
    const shape = obj._def.shape?.();
    if (!shape || typeof shape !== "object") return {};
    const result: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(shape)) {
      const val = exampleFromSchema(shape[key]);
      if (val !== undefined) result[key] = val;
    }
    return result;
  }
  if (obj._def?.typeName === "ZodEnum") {
    const values = obj._def.values;
    if (Array.isArray(values) && values.length > 0) return values[0];
    return "<value>";
  }
  return undefined;
}

/**
 * Build an enriched "unknown tool" error message.
 *
 * @param requested - the tool name the caller used
 * @param registeredNames - ALL registered tool names (including aliases)
 */
export function unknownToolError(
  requested: string,
  registeredNames: readonly string[],
): string {
  const suggestion = buildSuggestion(requested, registeredNames);
  return `Unknown tool: ${requested}. ${suggestion}`;
}

/**
 * Build an enriched "invalid arguments" error message.
 *
 * @param tool - the tool name that received the invalid args
 * @param zodError - the ZodError from parse()
 * @param schema - the original Zod schema, used to generate example calls
 */
export function invalidArgsError(
  tool: string,
  zodError: ZodError,
  schema?: unknown,
): string {
  const issues = zodError.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message} (expected ${issue.expected ?? typeof issue})`;
  });
  let message = `Invalid arguments for "${tool}": ${issues.join("; ")}`;
  if (schema) {
    const example = exampleFromSchema(schema);
    if (example && typeof example === "object" && Object.keys(example).length > 0) {
      message += `. Example: ${JSON.stringify({ ...example, [tool]: "..." }, null, 0)}`;
    }
  }
  return message;
}
