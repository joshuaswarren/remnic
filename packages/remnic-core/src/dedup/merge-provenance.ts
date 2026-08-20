/**
 * Merge frontmatter builder (issue #2330).
 *
 * On a create-or-update merge the target keeps its own provenance and gains
 * the incoming fact's, so a merge can never erase where a claim came from.
 *
 * Fields here match the canonical schema in `types.ts` deliberately: the
 * serializer rejects a `derived_via` outside its allow-list and drops keys
 * `MemoryFrontmatter` does not define, so an invented operator name or
 * counter would vanish on write. Pure — no I/O, no clock.
 */

/** The serializer's allow-listed operator for a create-or-update merge. */
export const MERGE_DERIVED_VIA = "merge" as const;

/**
 * Structural mirror of `ProvenanceSource` (types.ts). `sessionKey`,
 * `observedAt`, and `quote` are required; `turnId` and the character
 * offsets are optional and MUST survive a merge untouched.
 */
export interface MergeProvenanceSource {
  sessionKey: string;
  observedAt: string;
  quote: string;
  turnId?: string;
  charStart?: number;
  charEnd?: number;
}

export interface MergeFrontmatterUpdate {
  updated: string;
  derived_via: typeof MERGE_DERIVED_VIA;
  /** Follows the `reinforcement_count` convention; the serializer requires > 0. */
  reinforcement_count: number;
  sources: MergeProvenanceSource[];
}

const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Require a full ISO 8601 instant whose calendar components round-trip.
 * `Date.parse` alone accepts `123` and rolls `2026-02-30` over into March,
 * and this value is echoed verbatim into frontmatter.
 */
function assertIsoInstant(value: unknown, field: string): string {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) {
    throw new RangeError(`${field} must be a full ISO 8601 instant, got ${JSON.stringify(value)}`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new RangeError(`${field} must be a full ISO 8601 instant, got ${JSON.stringify(value)}`);
  }
  // Reject a rolled-over calendar date (2026-02-30 -> 2026-03-02).
  if (!new Date(ms).toISOString().startsWith(value.slice(0, 10))) {
    throw new RangeError(`${field} is not a real calendar date: ${JSON.stringify(value)}`);
  }
  return value;
}

function assertOffset(value: unknown, field: string): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative integer when present, got ${String(value)}`);
  }
}

function normalizeSource(source: MergeProvenanceSource, index: number): MergeProvenanceSource {
  const label = `sources[${index}]`;
  for (const field of ["sessionKey", "quote"] as const) {
    const value = source[field];
    if (typeof value !== "string" || value.trim() === "") {
      throw new RangeError(`${label}.${field} must be a non-blank string`);
    }
  }
  assertIsoInstant(source.observedAt, `${label}.observedAt`);
  if (source.turnId !== undefined && (typeof source.turnId !== "string" || source.turnId.trim() === "")) {
    throw new RangeError(`${label}.turnId must be a non-blank string when present`);
  }
  assertOffset(source.charStart, `${label}.charStart`);
  assertOffset(source.charEnd, `${label}.charEnd`);
  if (source.charStart !== undefined && source.charEnd !== undefined && source.charEnd < source.charStart) {
    throw new RangeError(`${label}.charEnd must be >= charStart`);
  }
  // Copy every canonical field, including the optional ones: dropping
  // observedAt or the offsets here would make the serializer discard the
  // clone, turning "append provenance" into "erase provenance".
  const copy: MergeProvenanceSource = {
    sessionKey: source.sessionKey,
    observedAt: source.observedAt,
    quote: source.quote,
  };
  if (source.turnId !== undefined) copy.turnId = source.turnId;
  if (source.charStart !== undefined) copy.charStart = source.charStart;
  if (source.charEnd !== undefined) copy.charEnd = source.charEnd;
  return copy;
}

function sourceKey(source: MergeProvenanceSource): string {
  return JSON.stringify([
    source.sessionKey,
    source.turnId ?? null,
    source.observedAt,
    source.quote,
    source.charStart ?? null,
    source.charEnd ?? null,
  ]);
}

export function buildMergeFrontmatterUpdate(input: {
  /** Existing sources already on the merge target. */
  targetSources?: readonly MergeProvenanceSource[];
  /** Sources from the incoming fact being merged in. */
  incomingSources: readonly MergeProvenanceSource[];
  /** Existing reinforcement_count on the target, if any. */
  targetReinforcementCount?: number;
  nowIso: string;
}): MergeFrontmatterUpdate {
  const updated = assertIsoInstant(input.nowIso, "nowIso");

  const previous = input.targetReinforcementCount;
  if (
    previous !== undefined &&
    (typeof previous !== "number" || !Number.isInteger(previous) || previous < 0)
  ) {
    throw new RangeError(
      `reinforcement_count must be a non-negative integer when supplied, got ${String(previous)}`,
    );
  }

  const seen = new Set<string>();
  const sources: MergeProvenanceSource[] = [];
  const append = (source: MergeProvenanceSource, index: number): void => {
    const copy = normalizeSource(source, index);
    const key = sourceKey(copy);
    if (seen.has(key)) return;
    seen.add(key);
    sources.push(copy);
  };

  const target = input.targetSources ?? [];
  target.forEach(append);
  input.incomingSources.forEach((source, i) => append(source, target.length + i));

  return {
    updated,
    derived_via: MERGE_DERIVED_VIA,
    reinforcement_count: (previous ?? 0) + 1,
    sources,
  };
}
