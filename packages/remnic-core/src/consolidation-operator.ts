
/**
 * Operator algebra for non-destructive consolidation.
 *
 * - `split`  — one source memory is rewritten as multiple smaller memories.
 * - `merge`  — multiple source memories are collapsed into one canonical
 *   memory.
 * - `update` — a newer value supersedes an older value within the same
 *   logical fact.
 * - `pattern-reinforcement` (issue #687 PR 2/4) — emitted by the
 *   pattern-reinforcement maintenance job when it clusters duplicate
 *   non-procedural memories and promotes the most recent member to
 *   canonical.  Unlike the other operators, the job does not produce
 *   page-versioning snapshots — it just stamps reinforcement metadata
 *   on the canonical and points superseded duplicates at it.  See
 *   `maintenance/pattern-reinforcement.ts`.
 */
export type ConsolidationOperator =
  | "split"
  | "merge"
  | "update"
  | "pattern-reinforcement";

/**
 * Allowed values for the `derived_via` frontmatter field.  Used by storage
 * validation to reject unknown operator values on write.
 */
export const CONSOLIDATION_OPERATORS: readonly ConsolidationOperator[] = [
  "split",
  "merge",
  "update",
  "pattern-reinforcement",
] as const;

/**
 * Regular expression for validating a single `derived_from` entry.
 *
 * Format: `<non-empty memory path>:<integer version >= 0>`.  Matches the
 * `path:versionNumber` convention used by `page-versioning.ts` snapshots
 * (e.g. `"facts/preferences.md:3"`).  The path portion is greedy-last so
 * paths that themselves contain a colon remain parseable — only the final
 * `:<digits>` is consumed as the version.
 */
const DERIVED_FROM_ENTRY_RE = /^(.+):(\d+)$/;

/**
 * Regular expression for validating a memory-id `derived_from` entry
 * (issue #687 PR 2/4).  Pattern reinforcement records source memory IDs
 * directly rather than page-versioning snapshots, so we also need to
 * accept that shape.
 *
 * Memory IDs are alphanumeric with hyphens, underscores, or COLONS —
 * the namespace-prefixed form (e.g. `global:fact-abc-123`,
 * `entity:person-alice`) is a legitimate ID format already used
 * throughout the graph-retrieval code path (`stripDerivedFromVersion`).
 * The disambiguation against `<path>:<version>` is *not* "no colons
 * allowed" — it's "the segment after the last colon must NOT be a
 * non-negative integer" (PR #730 review feedback, Codex P1).
 *
 * Slashes and dots remain forbidden so paths cannot accidentally pass
 * as memory IDs.
 *
 * Exported so the consolidation-provenance integrity scanner (PR
 * #730 review feedback) can recognize bare memory IDs instead of
 * flagging them as malformed snapshot references.
 */
export const DERIVED_FROM_MEMORY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_:-]*$/;

function looksLikeSnapshotEntry(entry: string): boolean {
  const match = entry.match(DERIVED_FROM_ENTRY_RE);
  if (!match) return false;
  const pathPart = match[1];
  return pathPart.includes("/") || pathPart.includes(".");
}

/**
 * Validate a `derived_from` entry string.  Returns `true` for either
 * - the snapshot format `<non-empty path>:<integer >= 0>` (issue #561), or
 * - a memory-id of the form `[A-Za-z0-9][A-Za-z0-9_:-]*` (issue #687
 *   PR 2/4 — used by pattern-reinforcement provenance).  Memory IDs
 *   may include `:` for namespace-prefixed forms like
 *   `global:fact-abc-123` (PR #730 review feedback, Codex P1).
 *
 * Disambiguation rule: only treat the entry as `<path>:<version>` when
 * the trailing segment after the last `:` is a non-negative integer
 * AND the left side looks like a path (contains `/` or `.`).
 * Otherwise treat the entire string as a memory ID.  This is the same
 * heuristic the graph retrieval path uses when splitting derived_from
 * references back into a memory id.
 *
 * Kept pure so storage and future CLI/doctor paths can share the same
 * validator.
 */
export function isValidDerivedFromEntry(entry: unknown): entry is string {
  if (typeof entry !== "string") return false;
  if (entry.length === 0) return false;
  if (looksLikeSnapshotEntry(entry)) {
    const match = entry.match(DERIVED_FROM_ENTRY_RE);
    if (!match) return false;
    const pathPart = match[1];
    if (pathPart.length === 0 || pathPart.trim().length === 0) return false;
    const versionNum = Number(match[2]);
    return Number.isInteger(versionNum) && versionNum >= 0;
  }
  return DERIVED_FROM_MEMORY_ID_RE.test(entry);
}

export function isConsolidationOperator(value: unknown): value is ConsolidationOperator {
  return (
    typeof value === "string" &&
    (CONSOLIDATION_OPERATORS as readonly string[]).includes(value)
  );
}

export type SemanticConsolidationLlmOperator = "split" | "merge" | "update";

const SEMANTIC_CONSOLIDATION_LLM_OPERATORS: readonly SemanticConsolidationLlmOperator[] = [
  "split",
  "merge",
  "update",
] as const;

/**
 * Type guard restricted to the operator subset the
 * semantic-consolidation LLM is allowed to emit.  Use this in any
 * code path that validates LLM output — `isConsolidationOperator` is
 * for validating values that came from disk / internal callers.
 */
export function isSemanticConsolidationLlmOperator(
  value: unknown,
): value is SemanticConsolidationLlmOperator {
  return (
    typeof value === "string" &&
    (SEMANTIC_CONSOLIDATION_LLM_OPERATORS as readonly string[]).includes(value)
  );
}
