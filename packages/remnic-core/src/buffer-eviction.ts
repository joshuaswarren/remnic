import type { BufferEntryState } from "./types.js";

const EMPTY_ENTRY: BufferEntryState = { turns: [], lastExtractionAt: null, extractionCount: 0 };

export interface BufferEvictionHooks {
  /** Last activity time (ms) of an entry; older entries are evicted first. */
  activityAt(entry: BufferEntryState): number;
  /** Accepted captures exit via refusal/backpressure, never eviction (#3251). */
  holdsAcceptedCapture(entry: BufferEntryState | undefined): boolean;
}

/**
 * Pick the keys to evict so `entries` returns to `maxCount`: the oldest empty
 * sessions first; retained failed extractions (#1908) keep their turns, so if
 * empty entries alone cannot reach the cap the oldest NON-empty sessions go
 * too rather than growing unboundedly. "default", the retained keys and
 * entries holding an accepted capture are never chosen.
 */
export function selectEvictedBufferKeys(
  entries: Readonly<Record<string, BufferEntryState>>,
  retainKeys: readonly string[],
  maxCount: number,
  hooks: BufferEvictionHooks,
): string[] {
  const keys = Object.keys(entries);
  if (keys.length <= maxCount) return [];

  const insertionOrder = new Map(keys.map((key, index) => [key, index]));
  const byOldestActivity = (left: string, right: string): number => {
    const leftAt = hooks.activityAt(entries[left] ?? EMPTY_ENTRY);
    const rightAt = hooks.activityAt(entries[right] ?? EMPTY_ENTRY);
    if (leftAt !== rightAt) return leftAt - rightAt;
    return (insertionOrder.get(left) ?? 0) - (insertionOrder.get(right) ?? 0);
  };
  const candidates = keys.filter(
    (key) => key !== "default" && !retainKeys.includes(key) && !hooks.holdsAcceptedCapture(entries[key]),
  );
  const emptyRemovable = candidates
    .filter((key) => (entries[key]?.turns.length ?? 0) === 0)
    .sort(byOldestActivity);

  const removableCount = Math.max(0, keys.length - maxCount);
  const evicted = emptyRemovable.slice(0, removableCount);
  if (evicted.length < removableCount) {
    const nonEmptyRemovable = candidates
      .filter((key) => (entries[key]?.turns.length ?? 0) > 0)
      .sort(byOldestActivity);
    return evicted.concat(nonEmptyRemovable.slice(0, removableCount - evicted.length));
  }
  return evicted;
}
