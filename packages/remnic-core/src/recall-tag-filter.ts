// Tag filtering helpers for memory recall (issue #689).
//
// Tags are free-form labels stored on each memory's frontmatter (see
// `storage.ts`). Recall callers can filter the result set down to memories
// that match a set of tags using `any` (default) or `all` semantics.
//
// This module is intentionally small and pure. The actual filter is applied
// at the access-service seam after `serializeRecallResults` hydrates each
// result's tags from frontmatter, so we don't have to touch QMD or thread
// tag-aware metadata through orchestrator internals for v1.
//
// Comparison is case-sensitive exact match — same form storage uses for tags.

import type { RecallFilterTrace } from "./recall-xray.js";

export type TagMatchMode = "any" | "all";

const TAG_MATCH_VALUES: ReadonlyArray<TagMatchMode> = ["any", "all"];

/**
 * Coerce a caller-supplied `tagMatch` value to the allowed enum.
 *
 * - `undefined` / `null` → `undefined` (caller didn't ask).
 * - Valid string → narrowed `TagMatchMode`.
 * - Invalid string → throws (CLAUDE.md rule 51 — never silently default).
 */
export function parseTagMatch(value: unknown): TagMatchMode | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(
      `tagMatch must be a string (one of: ${TAG_MATCH_VALUES.join(", ")})`,
    );
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed !== "any" && trimmed !== "all") {
    throw new Error(
      `invalid tagMatch value: ${value} (expected one of: ${TAG_MATCH_VALUES.join(", ")})`,
    );
  }
  return trimmed;
}

/**
 * Coerce a caller-supplied `tags` value into a clean string[].
 *
 * Accepts `string[]` and discards non-string / empty entries. Returns
 * `undefined` when no usable tags remain so downstream callers can treat
 * "no filter" and "empty filter" identically.
 */
export function normalizeTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out.length > 0 ? out : undefined;
}

export interface TagFilterInput {
  tags: string[] | undefined;
  tagMatch: TagMatchMode | undefined;
}

export interface TagFilterDecision {
  /** Whether the candidate's tags satisfy the filter. */
  admitted: boolean;
}

/**
 * Decide whether a single result's tags satisfy the filter.
 *
 * `any` (default) admits when the result has at least one of the filter
 * tags. `all` admits only when every filter tag is present on the result.
 * Returns `admitted: true` whenever no filter tags are configured.
 */
export function evaluateTagFilter(
  candidateTags: string[] | undefined,
  filter: TagFilterInput,
): TagFilterDecision {
  const filterTags = filter.tags;
  if (!filterTags || filterTags.length === 0) {
    return { admitted: true };
  }
  const tags = Array.isArray(candidateTags) ? candidateTags : [];
  const tagSet = new Set(tags);
  const mode: TagMatchMode = filter.tagMatch ?? "any";
  if (mode === "all") {
    for (const t of filterTags) {
      if (!tagSet.has(t)) return { admitted: false };
    }
    return { admitted: true };
  }
  for (const t of filterTags) {
    if (tagSet.has(t)) return { admitted: true };
  }
  return { admitted: false };
}

export interface TaggedResult {
  tags: string[];
}

/**
 * Apply the tag filter to an array of recall results.
 *
 * Returns `{results, trace}`:
 *  - `results` is the filtered array (or the original when no filter).
 *  - `trace` is a `RecallFilterTrace` capturing how many candidates were
 *    seen vs admitted, suitable for surfacing in X-ray output.
 *
 * `trace` is `null` when no filter tags were configured so callers can
 * skip emitting an empty trace entry.
 */
export function applyTagFilter<T extends TaggedResult>(
  results: T[],
  filter: TagFilterInput,
): { results: T[]; trace: RecallFilterTrace | null } {
  const filterTags = filter.tags;
  if (!filterTags || filterTags.length === 0) {
    return { results, trace: null };
  }
  const mode: TagMatchMode = filter.tagMatch ?? "any";
  const admitted: T[] = [];
  for (const r of results) {
    if (evaluateTagFilter(r.tags, filter).admitted) {
      admitted.push(r);
    }
  }
  const trace: RecallFilterTrace = {
    name: "tag-filter",
    considered: results.length,
    admitted: admitted.length,
    reason: `tags=${filterTags.join(",")} match=${mode}`,
  };
  return { results: admitted, trace };
}
