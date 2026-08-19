/**
 * Empty-batch guard for timeline analysis windows (issue #2050 leftover).
 *
 * null, undefined, and [] are empty. A non-array throws.
 * A batch list containing only empty inner arrays is empty.
 */

export function isEmptyAnalysisBatches(batches: unknown): boolean {
  if (batches == null) return true;
  if (!Array.isArray(batches)) {
    throw new TypeError("batches must be an array");
  }
  if (batches.length === 0) return true;
  return batches.every((batch) => Array.isArray(batch) && batch.length === 0);
}
