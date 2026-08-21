/**
 * Shared-item contradiction detection (issue #1957).
 *
 * Pure helper. Same-id items are one item; overlapping claim keys with
 * unequal values are a conflict. No deletes, no persistence.
 */

export interface SharedClaimItem {
  id: string;
  claims: Record<string, string>;
}

export type ContradictionPairResult =
  | { kind: "same" }
  | { kind: "conflict"; keys: string[] }
  | { kind: "none" };

export function detectContradictionPair(
  a: SharedClaimItem,
  b: SharedClaimItem,
): ContradictionPairResult {
  if (a.id === b.id) {
    return { kind: "same" };
  }
  const keys: string[] = [];
  for (const key of Object.keys(a.claims)) {
    if (key in b.claims && a.claims[key] !== b.claims[key]) {
      keys.push(key);
    }
  }
  return keys.length > 0 ? { kind: "conflict", keys: keys.sort() } : { kind: "none" };
}
