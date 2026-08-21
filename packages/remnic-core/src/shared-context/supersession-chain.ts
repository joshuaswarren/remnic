/**
 * Supersession chain resolution for shared-context curation (issue #1957).
 *
 * A shared item may supersede another item, which may itself be superseded.
 * Curation needs the live head of that chain. This module resolves the head
 * deterministically and survives malformed input: cycles, forks, and depth
 * blowups return errors instead of throwing or looping.
 */

export interface SupersessionItem {
  id: string;
  /** Id of the item this one replaces, when any. */
  supersedes?: string;
}

export type SupersessionChainResult =
  | { ok: true; headId: string; chain: string[] }
  | {
      ok: false;
      error: "unknown_id" | "cycle_detected" | "depth_exceeded";
      chain: string[];
    };

export const MAX_SUPERSESSION_DEPTH = 32;

/**
 * Resolve the live head of the supersession chain that starts at `startId`.
 *
 * Direction: forward. The successor of id X is the item whose `supersedes`
 * points at X. The head is the item that nothing supersedes.
 *
 * Fork policy: when two items supersede the same id, the lexicographically
 * smallest successor id wins. This keeps the result dependent only on the
 * item set, never on array order.
 *
 * Pure: reads the input, mutates nothing, performs no I/O.
 */
export function resolveSupersessionHead(input: {
  items: readonly SupersessionItem[];
  startId: string;
  maxDepth?: number;
}): SupersessionChainResult {
  const { items, maxDepth } = input;
  if (maxDepth !== undefined && (!Number.isInteger(maxDepth) || maxDepth < 1)) {
    throw new RangeError(`maxDepth must be a positive integer, got ${maxDepth}`);
  }
  const depth = maxDepth ?? MAX_SUPERSESSION_DEPTH;

  const start = input.startId.trim();
  if (start === "") {
    return { ok: false, error: "unknown_id", chain: [] };
  }

  // Build the id set and the successor map. Blank ids cannot participate,
  // and a blank `supersedes` value cannot point at anything.
  const ids = new Set<string>();
  const successorOf = new Map<string, string>();
  for (const item of items) {
    if (typeof item?.id !== "string") continue;
    const id = item.id.trim();
    if (id === "") continue;
    ids.add(id);
    const target =
      typeof item.supersedes === "string" ? item.supersedes.trim() : "";
    if (target === "") continue;
    // Fork resolution: keep the smallest successor id for determinism.
    const best = successorOf.get(target);
    if (best === undefined || id < best) {
      successorOf.set(target, id);
    }
  }

  if (!ids.has(start)) {
    return { ok: false, error: "unknown_id", chain: [] };
  }

  const chain = [start];
  const visited = new Set<string>([start]);
  let current = start;
  for (;;) {
    const next = successorOf.get(current);
    if (next === undefined) {
      return { ok: true, headId: current, chain };
    }
    if (visited.has(next)) {
      return { ok: false, error: "cycle_detected", chain };
    }
    if (chain.length + 1 > depth) {
      return { ok: false, error: "depth_exceeded", chain };
    }
    chain.push(next);
    visited.add(next);
    current = next;
  }
}
