/**
 * Empty-set guard for a recall-navigate path (issue #1956 leftover).
 *
 * null, undefined, and [] are empty. A non-array throws. Any other array is not empty.
 */

/** True when the navigate path is absent or has no nodes. */
export function isEmptyNavigatePath(nodes: unknown): boolean {
  if (nodes == null) return true;
  if (!Array.isArray(nodes)) {
    throw new TypeError("nodes must be an array");
  }
  return nodes.length === 0;
}
