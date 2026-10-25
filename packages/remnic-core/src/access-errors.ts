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
/**
 * Upper bound on the requested tool name. Anything longer is rejected before
 * the O(n*m) Levenshtein pass (#3042 review, P2): a 128 KB request over ~30
 * tools would otherwise run hundreds of millions of comparisons and block
 * the server event loop. The repo documents 64 chars as the tool-name shape;
 * this matches the limit enforced by every published surface.
 */
export const SUGGESTION_REQUEST_MAX_LEN = 64;

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
  // Defense in depth: the entry point already caps; this guards any direct
  // caller of the helper from an unbounded Levenshtein pass (issue #3042).
  if (requested.length > SUGGESTION_REQUEST_MAX_LEN) return [];
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
 * Read a Zod type tag without asserting a shape.
 *
 * Zod keeps its discriminant at `_def.typeName`. Both hops are narrowed with
 * `in`/`typeof` rather than an inline cast, so a non-Zod object yields
 * `undefined` instead of a fabricated read.
 */
function zodTypeName(schema: unknown): string | undefined {
  // zod 4: schema internals live on `_zod.def.type` (v3 read `_def.typeName`).
  if (!(schema instanceof Object) || !("_zod" in schema)) return undefined;
  // SAFETY: the guard above established `_zod` exists; its `.def` carries the
  // discriminator string under `type`.
  const def = (schema as { _zod?: { def?: { type?: unknown } } })._zod?.def;
  // SAFETY: zod's `_zod.def.type` discriminator is always a string literal.
  const discriminator = def?.type;
  return discriminator === undefined ? undefined : String(discriminator);
}

/**
 * A zod schema node this module reflects over — any object the library
 * exposes as a schema (v4 marks them with `_zod`).
 */
/** Structural marker: every zod schema carries `_zod`. */
type ZodSchemaLike = { _zod?: unknown };

/**
 * A synthetic example value derived from a schema: a placeholder the SAME
 * schema accepts, so the error message can show a valid argument shape.
 */
type SchemaExample = string | number | boolean | null | readonly SchemaExample[] | { [key: string]: SchemaExample };

/**
 * Reverse-engineer ONE synthetic example value from a Zod schema type.
 * Returns a deterministic placeholder intended to round-trip through parse().
 */
function exampleFromSchema(schema: ZodSchemaLike): SchemaExample | undefined {
  switch (zodTypeName(schema)) {
    case "string":
      return "<string>";
    case "number":
      return 42;
    case "boolean":
      return true;
    case "nullable":
      return null;
    case "array":
      return [];
    case "optional":
      // Optional fields are omitted from the example rather than sent as null.
      return undefined;
    case "enum": {
      // v4 exposes accepted values as the public `.enum` record.
      if (!(schema instanceof Object) || !("enum" in schema)) return "<value>";
      // SAFETY: the guard established `.enum`; zod types it as a value record.
      const values = Object.values((schema as { enum: Record<string, string> }).enum);
      return values.length > 0 ? values[0] : "<value>";
    }
    case "object": {
      // v4 exposes `.shape` as a plain property on the object schema.
      if (!(schema instanceof Object) || !("shape" in schema)) return {};
      // SAFETY: object schemas expose their field schemas keyed by name.
      const fieldsByName = (schema as { shape: { [field: string]: ZodSchemaLike } }).shape;
      if (!(fieldsByName instanceof Object)) return {};
      const result: { [key: string]: SchemaExample } = {};
      for (const field of Object.getOwnPropertyNames(fieldsByName)) {
        if (!Object.hasOwn(fieldsByName, field)) continue;
        const schemaNode = fieldsByName[field];
        const value = exampleFromSchema(schemaNode);
        if (value !== undefined) result[field] = value;
      }
      return result;
    }
    default:
      return undefined;
  }
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
  // Cap the request before the suggestion pass: a 128 KB name would otherwise
  // pay O(n*m) per registered tool (issue #3042 review, P2). The cap matches
  // the documented tool-name shape; an over-long request is rejected with a
  // teaching message rather than a silent truncate.
  if (requested.length > SUGGESTION_REQUEST_MAX_LEN) {
    return `Unknown tool: name exceeds ${SUGGESTION_REQUEST_MAX_LEN} characters (got ${requested.length}).`;
  }
  const suggestion = buildSuggestion(requested, registeredNames);
  return `Unknown tool: ${requested}. ${suggestion}`;
}

/**
 * Build an enriched "invalid arguments" error message.
 *
 * The example is generated from the schema (never hand-written, so it cannot
 * drift) and is shown ONLY when it round-trips through that same schema. It
 * carries schema-derived fields only: injecting the tool name would add an
 * unrecognized property and fail a `.strict()` object (#3035 review finding).
 *
 * @param tool - the tool name that received the invalid args
 * @param zodError - the ZodError from parse()
 * @param schema - the original Zod schema, used to generate the example
 */
export function invalidArgsError(
  tool: string,
  zodError: ZodError,
  schema?: unknown,
): string {
  const issues = zodError.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    // `expected` exists only on the invalid_type / invalid_literal variants of
    // ZodIssue, so it is read through a presence check rather than assumed.
    const expected = "expected" in issue ? issue.expected : undefined;
    return expected === undefined
      ? `${path}: ${issue.message}`
      : `${path}: ${issue.message} (expected ${String(expected)})`;
  });
  let message = `Invalid arguments for "${tool}": ${issues.join("; ")}`;
  if (!schema) return message;

  const example = exampleFromSchema(schema);
  if (!example || typeof example !== "object" || Object.keys(example).length === 0) {
    return message;
  }

  // Withhold an example that cannot parse against its own schema: a
  // non-round-tripping example is misinformation, worse than none. Narrowed
  // with `in`/`typeof` rather than an inline cast so the shape is checked.
  let roundTrips = false;
  if (typeof schema === "object" && "safeParse" in schema) {
    const parser = schema.safeParse;
    if (typeof parser === "function") {
      try {
        const parsed: unknown = parser.call(schema, example);
        roundTrips =
          typeof parsed === "object"
          && parsed !== null
          && "success" in parsed
          && parsed.success === true;
      } catch {
        roundTrips = false;
      }
    }
  }

  return roundTrips ? `${message}. Example arguments: ${JSON.stringify(example)}` : message;
}
