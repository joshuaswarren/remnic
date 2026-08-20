/**
 * Merge frontmatter provenance (issue #2330 step 3).
 *
 * A semantic merge must append the incoming fact's provenance to the merge
 * target's `sources` array, never replace it, so history survives the merge.
 * This module computes the resulting frontmatter fields as a pure function:
 * no I/O, no clock reads, no input mutation.
 */

export const MERGE_DERIVED_VIA = "semantic-merge";

export interface MergeProvenanceSource {
  sessionKey: string;
  turnId: string;
  quote: string;
}

export interface MergeFrontmatterUpdate {
  updated: string;
  derived_via: string;
  merge_count: number;
  sources: MergeProvenanceSource[];
}

function assertSource(source: MergeProvenanceSource, index: number): void {
  for (const field of ["sessionKey", "turnId", "quote"] as const) {
    const value = source[field];
    if (typeof value !== "string" || value.trim() === "") {
      throw new RangeError(`sources[${index}].${field} must be a non-blank string`);
    }
  }
}

function sourceKey(source: MergeProvenanceSource): string {
  // JSON tuple form: unambiguous for string triples, unlike a joined string.
  return JSON.stringify([source.sessionKey, source.turnId, source.quote]);
}

export function buildMergeFrontmatterUpdate(input: {
  /** Existing sources already on the merge target. */
  targetSources?: readonly MergeProvenanceSource[];
  /** Sources from the incoming fact being merged in. */
  incomingSources: readonly MergeProvenanceSource[];
  /** Existing merge_count on the target, if any. */
  targetMergeCount?: number;
  nowIso: string;
}): MergeFrontmatterUpdate {
  const nowIso = input.nowIso;
  if (
    typeof nowIso !== "string" ||
    nowIso.trim() === "" ||
    Number.isNaN(Date.parse(nowIso))
  ) {
    throw new RangeError(`nowIso must be a non-blank parseable timestamp, got ${JSON.stringify(nowIso)}`);
  }

  const targetMergeCount = input.targetMergeCount;
  if (
    targetMergeCount !== undefined &&
    (typeof targetMergeCount !== "number" ||
      !Number.isInteger(targetMergeCount) ||
      targetMergeCount < 0)
  ) {
    throw new RangeError(`merge_count must be a non-negative integer when supplied, got ${String(targetMergeCount)}`);
  }

  const seen = new Set<string>();
  const sources: MergeProvenanceSource[] = [];
  const append = (source: MergeProvenanceSource, index: number): void => {
    assertSource(source, index);
    const key = sourceKey(source);
    if (seen.has(key)) return;
    seen.add(key);
    sources.push({ sessionKey: source.sessionKey, turnId: source.turnId, quote: source.quote });
  };

  const target = input.targetSources ?? [];
  target.forEach(append);
  input.incomingSources.forEach((source, i) => append(source, target.length + i));

  return {
    updated: nowIso,
    derived_via: MERGE_DERIVED_VIA,
    merge_count: (targetMergeCount ?? 0) + 1,
    sources,
  };
}
