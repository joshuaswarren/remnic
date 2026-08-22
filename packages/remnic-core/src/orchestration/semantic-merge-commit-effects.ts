/**
 * Commit-adjacent effects for judge-mediated merge-on-write (issue #2330
 * round N+11). Extracted from semantic-merge-persist.ts so that file stays
 * at its file-size ratchet cap (1200 LOC).
 *
 * Round N+11 (C): version snapshots for a merge are STAGED without pruning
 * and the prune is FINALIZED only after the compare-and-swap commits, so a
 * failed merge attempt cannot discard the oldest rollback point.
 * Round N+11 (B): the merged target is persisted into the thread's durable
 * episode set through the same appendEpisodeIds path the create path uses.
 */

import { readFile } from "node:fs/promises";

import { log } from "../logger.js";
import { createVersion, pruneVersions, type VersioningConfig } from "../page-versioning.js";
import type { ThreadingManager } from "../threading.js";
import type { MemoryFile } from "../types.js";

/**
 * Stage the pre-merge rollback snapshot WITHOUT pruning. The CAS that
 * follows can still fail on a concurrent writer; an eager prune at a full
 * history would have already discarded the oldest rollback point for a
 * merge that never happened. Returns the staged version id; throws on a
 * failed snapshot (the caller bypasses to the create path).
 */
export async function stageMergedTargetSnapshot(
  target: MemoryFile,
  versioning: VersioningConfig,
  memoryDir: string,
): Promise<string> {
  const currentFile = await readFile(target.path, "utf8");
  const version = await createVersion(
    target.path,
    currentFile,
    "semantic-merge",
    versioning,
    log,
    "judge-mediated merge-on-write (issue #2330)",
    memoryDir,
    { deferPrune: true },
  );
  return String(version.versionId);
}

/**
 * Finalize the deferred prune once the CAS has committed — the committed
 * merge is the newest snapshot, so it is never the one pruned. Best-effort:
 * a prune failure is logged and never fails the committed merge.
 */
export async function finalizeMergedVersionPrune(
  targetPath: string,
  versioning: VersioningConfig,
  memoryDir: string,
  targetId: string,
): Promise<void> {
  await pruneVersions(targetPath, versioning, log, memoryDir).catch((err) =>
    log.warn(
      `semantic-merge: version prune finalization failed for ${targetId} (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    ),
  );
}

/**
 * Round N+11 (B): persist the merged target into the thread's DURABLE
 * episode set. `runMergedTargetPostEffects` orders the batch-local episode
 * list, but that copy dies with the batch — the next extraction reloads the
 * thread from disk, and a target that entered the thread only through a
 * merge vanished. Appends through the same storage path the create path's
 * `appendPersistedThreadEpisodes` uses (`ThreadingManager.appendEpisodeIds`,
 * unique-append), so ordering semantics match the create path exactly, while
 * the public `persistedIds` return stays new-fragments-only (round N+7 D).
 * Fail-open: the committed merge stands; a thread write failure is logged.
 */
export async function persistMergedTargetThreadEpisode(
  threading: Pick<ThreadingManager, "appendEpisodeIds">,
  threadId: string | null | undefined,
  targetId: string,
): Promise<void> {
  if (!threadId) return;
  try {
    await threading.appendEpisodeIds(threadId, [targetId]);
  } catch (err) {
    log.warn(
      `semantic-merge: thread episode persist failed for ${targetId} (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
