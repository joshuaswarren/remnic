/**
 * Generic reinforcement-core primitives extracted from `procedure-miner.ts`
 * (issue #687 PR 1/4). Procedure-specific scoring (success rate, step
 * normalization) intentionally stays in the miner — this module only
 * exposes category-agnostic clustering and cluster summarization helpers
 * so future PRs can run reinforcement across non-procedural categories.
 *
 * Pure refactor — no behavior change.
 */

/**
 * Group `items` into clusters keyed by `keyFn(item)`.
 *
 * - Preserves the original input order within each cluster's array.
 * - The returned `Map` insertion order matches first-seen key order, so
 *   downstream iteration is deterministic for a given input.
 * - Throws `TypeError` if `keyFn` returns a non-string (e.g. `undefined`,
 *   `null`, or a number). Callers must produce a stable string key.
 */
export function clusterByKey<T>(items: readonly T[], keyFn: (item: T) => string): Map<string, T[]> {
  const clusters = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    if (typeof key !== "string") {
      throw new TypeError(
        `clusterByKey: keyFn must return a string, got ${key === null ? "null" : typeof key}`,
      );
    }
    const existing = clusters.get(key);
    if (existing) {
      existing.push(item);
    } else {
      clusters.set(key, [item]);
    }
  }
  return clusters;
}

export interface ClusterSummary {
  /** Number of items in the cluster. */
  count: number;
  /** Earliest timestamp seen in the cluster (string min via `localeCompare`). */
  firstSeen: string;
  /** Latest timestamp seen in the cluster (string max via `localeCompare`). */
  lastSeen: string;
}

/**
 * Summarize a cluster by counting items and tracking earliest/latest
 * timestamps. Timestamp comparison uses `String#localeCompare`, which is
 * correct for ISO-8601 strings (lexicographic order matches chronological
 * order).
 *
 * - Throws `RangeError` on empty clusters — `firstSeen`/`lastSeen` are not
 *   meaningful without at least one item.
 * - When all timestamps are equal, `firstSeen === lastSeen`.
 */
export function summarizeCluster<T>(
  cluster: readonly T[],
  extractTimestamp: (item: T) => string,
): ClusterSummary {
  if (cluster.length === 0) {
    throw new RangeError("summarizeCluster: cluster must contain at least one item");
  }
  let firstSeen = extractTimestamp(cluster[0]);
  let lastSeen = firstSeen;
  for (let i = 1; i < cluster.length; i += 1) {
    const ts = extractTimestamp(cluster[i]);
    if (ts.localeCompare(firstSeen) < 0) firstSeen = ts;
    if (ts.localeCompare(lastSeen) > 0) lastSeen = ts;
  }
  return { count: cluster.length, firstSeen, lastSeen };
}
