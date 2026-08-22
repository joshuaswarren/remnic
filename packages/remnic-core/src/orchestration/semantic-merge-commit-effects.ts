/**
 * Commit-adjacent effects for judge-mediated merge-on-write (issue #2330
 * round N+11). Extracted from semantic-merge-persist.ts so that file stays
 * at its file-size ratchet cap (1200 LOC).
 *
 * Round N+11 (C) + N+12 (A): version snapshots for a merge are STAGED
 * without pruning and the prune is FINALIZED only after the FULL
 * content-and-metadata transaction commits (both compare-and-swaps), so a
 * failed merge attempt cannot discard the oldest rollback point.
 * Round N+11 (B) + N+12 (D): the merged target is persisted into the
 * thread's durable episode set MOVE-TO-END — a re-merged target already
 * earlier in the thread moves to the tail, not a unique-append no-op.
 */
import { removeNodeEdgesForRewrite, rollbackNodeEdgeRewrite } from "../graph-jsonl.js";
import type { GraphType } from "../graph.js";


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
 * Finalize the deferred prune once the FULL content-and-metadata transaction
 * has committed (round N+12 A: both compare-and-swaps, not just the content
 * one) — the committed merge is the newest snapshot, so it is never the one
 * pruned. Best-effort: a prune failure is logged and never fails the
 * committed merge.
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
 * Round N+11 (B) + N+12 (D): persist the merged target into the thread's
 * DURABLE episode set, MOVE-TO-END. `runMergedTargetPostEffects` orders the
 * batch-local episode list, but that copy dies with the batch — the next
 * extraction reloads the thread from disk, and a target that entered the
 * thread only through a merge vanished. A target already EARLIER in the
 * durable list must move to the end, not stay put: `appendEpisodeIds` is a
 * unique-append no-op for present ids, so after the reload the target sat at
 * its old position and could fall outside
 * `resolveRecentThreadMemoryPaths(...).slice(-3)`. Remove-then-append matches
 * the batch-local ordering fix exactly, while the public `persistedIds`
 * return stays new-fragments-only (round N+7 D). Fail-open: the committed
 * merge stands; a thread write failure is logged.
 */
export async function persistMergedTargetThreadEpisode(
  threading: Pick<ThreadingManager, "loadThread" | "saveThread">,
  threadId: string | null | undefined,
  targetId: string,
): Promise<void> {
  if (!threadId) return;
  try {
    const thread = await threading.loadThread(threadId);
    if (!thread) return;
    const existing = thread.episodeIds.lastIndexOf(targetId);
    if (existing !== -1) thread.episodeIds.splice(existing, 1);
    thread.episodeIds.push(targetId);
    thread.updatedAt = new Date().toISOString();
    await threading.saveThread(thread);
  } catch (err) {
    log.warn(
      `semantic-merge: thread episode persist failed for ${targetId} (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Round N+12 (C): replace a merged target's generated graph edges with the
 * rebuild's rows, revision-guarded end to end. The caller's committed-body
 * check can pass, writer B can then commit a NEWER merge and finish
 * rebuilding edges for it, and writer A would resume to remove B's edges and
 * install edges derived from A's older body. The revision observed at the
 * check is carried THROUGH the remove-and-rebuild; before the install
 * counts as final the target is re-read, and an advanced revision (or a
 * vanished target) aborts the install — the rows A's build appended are
 * removed and the edges observed at A's removal are restored, which include
 * B's. The advancing writer owns the rebuild. Returns whether the install
 * finalized (the caller advances its adjacency chain only then). A build
 * failure rolls back the same way (round N+10 C) and rethrows — fail-open
 * stays the caller's decision.
 */
export async function rewriteMergedTargetGraphEdges(
  storage: {
    dir: string;
    getMemoryByIdIncludingArchived: (id: string) => Promise<MemoryFile | null>;
  },
  input: {
    targetId: string;
    memoryRelPath: string;
    mergedContent: string;
    /** The frontmatter `updated` value the committed-body check validated. */
    revisionChecked: string | undefined;
    rewriteTypes: readonly GraphType[];
    build: () => Promise<void>;
  },
): Promise<boolean> {
  const removedEdges = await removeNodeEdgesForRewrite(storage.dir, input.memoryRelPath, input.rewriteTypes);
  try {
    await input.build();
    const committedNow = await storage.getMemoryByIdIncludingArchived(input.targetId);
    if (
      !committedNow ||
      committedNow.content !== input.mergedContent ||
      committedNow.frontmatter.updated !== input.revisionChecked
    ) {
      await rollbackNodeEdgeRewrite(storage.dir, input.memoryRelPath, input.rewriteTypes, removedEdges, input.targetId);
      return false;
    }
    return true;
  } catch (buildErr) {
    await rollbackNodeEdgeRewrite(storage.dir, input.memoryRelPath, input.rewriteTypes, removedEdges, input.targetId);
    throw buildErr;
  }
}
