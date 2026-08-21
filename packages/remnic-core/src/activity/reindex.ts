/**
 * Forced, non-fake search-index refresh for direct activity digest writes
 * (issue #1899; AGENTS.md rule 31). The digest is written straight to the QMD
 * collection root, bypassing the extraction->persist->index pipeline, so it must
 * explicitly trigger a refresh — and that refresh must actually run.
 *
 * Ordinary `SearchBackend.update()` is fail-open: it silently returns when the
 * backend is unavailable, in failure backoff, or inside its min-interval gate.
 * A freshly written digest hit by that gate would stay unsearchable until an
 * unrelated reindex, and the per-day digest-unchanged guard means the next tick
 * won't retry. So prefer the forced/strict contracts: `updateCollectionStrict`
 * bypasses the min-interval gate (force) AND throws on a genuine failure instead
 * of reporting a fake success, then `updateStrict`, then plain `update`.
 */

import type { SearchExecutionOptions } from "../search/port.js";

/** The subset of the search backend the activity reindex needs. */
export interface ActivityIndexRefresher {
  update(execution?: SearchExecutionOptions): Promise<void>;
  updateStrict?(execution?: SearchExecutionOptions): Promise<void>;
  updateCollectionStrict?(collection: string, execution?: SearchExecutionOptions): Promise<void>;
}

export async function refreshActivityIndex(
  qmd: ActivityIndexRefresher,
  collection: string,
  signal?: AbortSignal,
): Promise<void> {
  const execution = signal === undefined ? undefined : { signal };
  if (typeof qmd.updateCollectionStrict === "function" && collection.trim().length > 0) {
    await qmd.updateCollectionStrict(collection, execution);
    return;
  }
  if (typeof qmd.updateStrict === "function") {
    await qmd.updateStrict(execution);
    return;
  }
  await qmd.update(execution);
}
