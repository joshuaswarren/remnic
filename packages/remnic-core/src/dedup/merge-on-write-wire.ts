/**
 * Persist seam for merge-on-write (issue #2330 leftover slice).
 *
 * Default off. Failures and disabled gates create. Persist callers inject
 * writeMerged / writeNew. This module does not touch extraction-persist.
 */

import {
  applyMergeOnWrite,
  type MergeJudge,
  type MergeOnWritePair,
} from "./merge-on-write.js";

export async function applyMergeOnWriteAtPersist<T>(opts: {
  enabled?: boolean;
  pair: MergeOnWritePair;
  judge: MergeJudge;
  mergeMin?: number;
  skipThreshold?: number;
  writeMerged: (id: string) => T | Promise<T>;
  writeNew: () => T | Promise<T>;
}): Promise<T> {
  const decision = await applyMergeOnWrite({
    enabled: opts.enabled,
    pair: opts.pair,
    judge: opts.judge,
    mergeMin: opts.mergeMin,
    skipThreshold: opts.skipThreshold,
  });
  if (decision === "merge" && opts.pair.existingId) {
    return opts.writeMerged(opts.pair.existingId);
  }
  return opts.writeNew();
}
