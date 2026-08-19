/**
 * Empty-set guard for a deep-recall working set (issue #2332 leftover).
 *
 * null, undefined, and [] are empty. A non-array throws. Any other array is not empty.
 */

/** True when the working set is absent or has no items. */
export function isEmptyWorkingSet(items: unknown): boolean {
  if (items == null) return true;
  if (!Array.isArray(items)) {
    throw new TypeError("items must be an array");
  }
  return items.length === 0;
}
