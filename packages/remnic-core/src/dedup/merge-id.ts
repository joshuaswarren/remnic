/**
 * Merge-target id picker (issue #2330 leftover).
 *
 * Empty candidates return null. Otherwise the lowest id by localeCompare.
 * Does not mutate the input list.
 */

export function pickMergeTargetId(candidates: readonly string[]): string | null {
  let lowest: string | undefined;
  for (const id of candidates) {
    if (lowest === undefined || id.localeCompare(lowest) < 0) lowest = id;
  }
  return lowest ?? null;
}
