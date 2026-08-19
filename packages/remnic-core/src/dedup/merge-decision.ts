/**
 * Pure create/update/skip decision for merge-on-write (issue #2330 slice).
 *
 * No I/O, no LLM. Invalid thresholds throw RangeError; bad candidates are
 * ignored, never thrown on. `below_threshold` is reserved for a later slice.
 */

export type MergeDecision =
  | { action: "create" }
  | { action: "update"; targetId: string }
  | { action: "skip"; reason: "duplicate" | "below_threshold" };

export interface MergeCandidate {
  id: string;
  similarity: number; // 0..1
  updatedAt: string; // ISO
}

export interface MergeDecisionOptions {
  updateThreshold: number; // >= this similarity -> update
  duplicateThreshold: number; // >= this similarity -> skip as duplicate
}

function assertThreshold(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`invalid ${name}: ${value}`);
  }
}

/** Total order: similarity desc, then updatedAt desc, then id asc. NaN times sort last. */
function compareCandidates(a: MergeCandidate, b: MergeCandidate): number {
  if (a.similarity !== b.similarity) return b.similarity - a.similarity;
  // Date.parse never throws; unparseable timestamps yield NaN and sort last.
  const aTime = Date.parse(a.updatedAt);
  const bTime = Date.parse(b.updatedAt);
  if (aTime !== bTime) {
    if (Number.isNaN(aTime)) return 1;
    if (Number.isNaN(bTime)) return -1;
    return bTime - aTime;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function decideMergeOnWrite(
  candidates: readonly MergeCandidate[],
  options: MergeDecisionOptions,
): MergeDecision {
  assertThreshold(options.updateThreshold, "updateThreshold");
  assertThreshold(options.duplicateThreshold, "duplicateThreshold");
  if (options.duplicateThreshold < options.updateThreshold) {
    throw new RangeError(
      `duplicateThreshold ${options.duplicateThreshold} < updateThreshold ${options.updateThreshold}`,
    );
  }

  const valid = candidates.filter(
    (c) =>
      typeof c.id === "string" &&
      c.id.trim() !== "" &&
      typeof c.similarity === "number" &&
      Number.isFinite(c.similarity) &&
      c.similarity >= 0 &&
      c.similarity <= 1,
  );
  if (valid.length === 0) return { action: "create" };

  const best = valid.reduce((acc, c) => (compareCandidates(c, acc) < 0 ? c : acc));

  if (best.similarity >= options.duplicateThreshold) {
    return { action: "skip", reason: "duplicate" };
  }
  if (best.similarity >= options.updateThreshold) {
    return { action: "update", targetId: best.id };
  }
  return { action: "create" };
}
