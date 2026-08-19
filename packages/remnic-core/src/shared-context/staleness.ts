/**
 * Shared-item staleness (issue #1957).
 *
 * Pure helpers. Expired items drop; superseded items that still circulate
 * get a marker. Callers never `rm`.
 */
import { isExpired, type SharedEnvelope } from "./governance.js";

export interface SharedStalenessItem {
  id: string;
  expiresAt?: string;
  supersedes?: string;
  circulating?: boolean;
}

/** Drop expired items. Half-open: `nowMs >= expiresAt` is expired. */
export function filterLiveEnvelopes<T extends Pick<SharedEnvelope, "expiresAt">>(
  items: readonly T[],
  nowMs: number,
): T[] {
  return items.filter((item) => !isExpired(item, nowMs));
}

/**
 * Mark items whose id appears in another item's `supersedes`.
 * Returns a new array. Does not mutate input and does not delete files.
 */
export function markSupersededCirculation<T extends SharedStalenessItem>(
  items: readonly T[],
): T[] {
  const supersededIds = new Set<string>();
  for (const item of items) {
    if (item.supersedes) supersededIds.add(item.supersedes);
  }
  return items.map((item) =>
    supersededIds.has(item.id) ? { ...item, circulating: true } : item,
  );
}
