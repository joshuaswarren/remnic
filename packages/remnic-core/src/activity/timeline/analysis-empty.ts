/**
 * Empty-set guard for timeline analysis observations (issue #2050 leftover).
 *
 * null, undefined, and [] are empty. A non-array throws. Any other array is not empty.
 */

/** True when the observation set is absent or has no items. */
export function isEmptyObservationSet(items: unknown): boolean {
  if (items == null) return true;
  if (!Array.isArray(items)) {
    throw new TypeError("items must be an array");
  }
  return items.length === 0;
}
