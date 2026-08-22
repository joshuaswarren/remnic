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

import { GraphEdgeAppendError } from "../graph-append-error.js";
import type { GraphEdge, GraphType } from "../graph.js";
import { readFile } from "node:fs/promises";
import { removeNodeEdgesForRewrite, rollbackNodeEdgeRewrite } from "../graph-jsonl.js";
import {
  hasCitationForTemplate,
  stripCitationForTemplate,
} from "../source-attribution.js";
import { resolvePipelineProcessingCapabilities } from "../capabilities.js";
import { inferMemoryStatus } from "../memory-lifecycle-ledger-utils.js";
import { sanitizeMemoryContent } from "../sanitize.js";
import { ContentHashIndex } from "../storage/content-hash-index.js";
import type { ExtractionPersistDeps } from "./extraction-persist-deps.js";

import { log } from "../logger.js";
import { createVersion, pruneVersions, recordStrandedCommit, removeVersion, type VersioningConfig } from "../page-versioning.js";
import type { ThreadingManager } from "../threading.js";
import type { MemoryFile, MemoryFrontmatter } from "../types.js";
import type { StorageManager } from "../index.js";

/**
 * Stage the pre-merge rollback snapshot WITHOUT pruning, marked `pending`.
 * The CAS that follows can still fail on a concurrent writer; an eager
 * prune at a full history would have already discarded the oldest rollback
 * point for a merge that never happened, and a concurrent writer's
 * finalizing prune cannot count this entry until its own write commits
 * (round N+15 B). Returns the staged version id; throws on a
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
 * one) — the staged `versionId` becomes a committed rollback point (its
 * `pending` flag clears under the same page lock as the prune, round N+15 B),
 * and the prune then counts only committed snapshots, so a concurrent
 * still-pending writer's staged entry is never traded away. Best-effort: a
 * prune failure records the staged id as a stranded commit (round N+22) so
 * the NEXT successful finalization for the page reconciles its `pending`
 * flag and the prune bound applies again — without it, every transient
 * failure (manifest lock timeout, I/O error) stranded one unprunable
 * snapshot beyond maxVersionsPerPage. Never fails the committed merge.
 */
export async function finalizeMergedVersionPrune(
  targetPath: string,
  versioning: VersioningConfig,
  memoryDir: string,
  targetId: string,
  versionId: string,
): Promise<void> {
  await pruneVersions(targetPath, versioning, log, memoryDir, {
    committedVersionId: versionId,
  }).catch(async (err) => {
    log.warn(
      `semantic-merge: version prune finalization failed for ${targetId} (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
    // The merge HAS committed — the staged snapshot is a real rollback
    // point whose `pending` flag never cleared. Record it so the next
    // successful finalization reconciles the flag and pruning bounds
    // history again.
    await recordStrandedCommit(targetPath, versioning, versionId, log, memoryDir);
  });
}

/**
 * Round N+13 (B): undo the staged pre-merge snapshot after an aborted
 * attempt — a lost content CAS, or a metadata failure whose content revert
 * succeeded. Staging mutates version history, so without this rollback every
 * failed attempt left a snapshot of an unchanged body in the manifest;
 * repeated failures grew history past `maxVersionsPerPage` and a later
 * successful merge's prune then discarded real rollback states to make room
 * for those duplicates. History returns to its pre-attempt state. Best-effort
 * and idempotent: a removal failure is logged and never masks the abort's
 * own result. A degraded success (unrollbackable metadata failure) keeps the
 * staged snapshot — it is the recovery point for the committed merge.
 */
export async function discardMergedTargetSnapshot(
  targetPath: string,
  versioning: VersioningConfig,
  memoryDir: string,
  targetId: string,
  versionId: string,
): Promise<void> {
  await removeVersion(targetPath, versionId, versioning, log, memoryDir).catch((err) =>
    log.warn(
      `semantic-merge: staged snapshot ${versionId} removal failed for ${targetId} (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    ),
  );
}

/**
 * Re-read the target through the SAME reader the storage compare-and-swaps
 * use, so a snapshot handed to one of them carries an identical fingerprint
 * basis. Null means the file no longer holds this memory, which no caller may
 * read as "unchanged".
 */
export async function readTargetSnapshot(
  storage: StorageManager,
  target: MemoryFile,
): Promise<MemoryFile | null> {
  const current = await storage.readMemoryByPath(target.path);
  if (!current || current.frontmatter.id !== target.frontmatter.id) return null;
  return current;
}

/**
 * Undo a merged body whose provenance patch never landed, and report what is
 * actually true of storage afterwards: `true` means the target no longer holds
 * unprovenanced merged text, so the caller may honestly create the fact.
 *
 * Three states, because only one of them is ours to undo:
 *  - the body is still our merged text → restore the pre-merge body under a
 *    compare-and-swap on the re-read snapshot;
 *  - another writer already replaced it → nothing of ours remains, so the
 *    restore is skipped rather than clobbering that writer's body;
 *  - the target is unreadable → unverifiable, so assume the merged text stands
 *    and refuse to create a duplicate.
 */
export async function revertMergedContent(
  storage: StorageManager,
  target: MemoryFile,
  mergedContent: string,
): Promise<boolean> {
  try {
    const current = await readTargetSnapshot(storage, target);
    if (!current) return false;
    if (current.content !== mergedContent) return true;
    return await storage.updateMemoryIfUnchanged(current, target.content, {
      actor: "semantic-merge-rollback",
    });
  } catch {
    return false;
  }
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
 * Round N+12 (C) + N+14: replace a merged target's generated graph edges
 * with the rebuild's rows, revision-guarded end to end. The caller's
 * committed-body check can pass, writer B can then commit a NEWER merge and
 * finish rebuilding edges for it, and writer A would resume to remove B's
 * edges and install edges derived from A's older body. The revision observed
 * at the check is carried THROUGH the remove-and-rebuild; before the install
 * counts as final the target is re-read, and an advanced revision (or a
 * vanished target) aborts the install. The advancing writer owns the rebuild.
 * Returns whether the install finalized (the caller advances its adjacency
 * chain only then). A build failure rolls back the same way (round N+10 C)
 * and rethrows — fail-open stays the caller's decision.
 *
 * Round N+14 makes the ROLLBACK surgical: `build` returns the exact rows it
 * appended (by identity), and the rollback removes only those — never a
 * node-wide sweep — so rows a newer writer appended after this writer's
 * removal survive. The snapshot restore is residue-gated per graph type: a
 * type whose file still holds node rows the aborting writer cannot account
 * for belongs to the newer writer and is NOT restored over. See
 * {@link rollbackNodeEdgeRewrite}.
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
    build: () => Promise<GraphEdge[] | void>;
  },
): Promise<boolean> {
  const removedEdges = await removeNodeEdgesForRewrite(storage.dir, input.memoryRelPath, input.rewriteTypes);
  // Round N+14 + N+16 (A): the rows THIS writer's build appended, by exact
  // identity. A build that THROWS carries its partial row set on the error
  // (GraphEdgeAppendError — tracked incrementally as each row is written),
  // so the rollback stays surgical on the throwing path too; only a build
  // that neither returns rows nor wraps its failure falls back to the
  // node-wide sweep, identical outcome absent interleaving.
  let appended: readonly GraphEdge[] | undefined;
  try {
    appended = (await input.build()) ?? undefined;
    const committedNow = await storage.getMemoryByIdIncludingArchived(input.targetId);
    if (
      !committedNow ||
      committedNow.content !== input.mergedContent ||
      committedNow.frontmatter.updated !== input.revisionChecked
    ) {
      await rollbackNodeEdgeRewrite(storage.dir, input.memoryRelPath, input.rewriteTypes, removedEdges, input.targetId, appended);
      return false;
    }
    return true;
  } catch (buildErr) {
    await rollbackNodeEdgeRewrite(
      storage.dir,
      input.memoryRelPath,
      input.rewriteTypes,
      removedEdges,
      input.targetId,
      appended ?? (buildErr instanceof GraphEdgeAppendError ? buildErr.appendedEdges : undefined),
    );
    throw buildErr;
  }
}

/**
 * Round N+2 (C) — the canonical RAW pre-citation merged body for hashing.
 * The judge composes mergedContent from the stored target body, which
 * carries an appended citation marker when inline source attribution is
 * enabled; the ordinary write path hashes `contentHashSource` — the raw
 * fact text BEFORE any citation is attached. Hashing the cited body would
 * give the merged record a different identity than the equivalent raw
 * write (checklist #13), so the configured citation form is stripped
 * first, exactly like the write path's `rawChunkedContent`
 * canonicalization. Lives in this sibling (extracted from
 * semantic-merge-persist.ts) so that file stays within its file-size
 * ratchet cap.
 */
export function rawPreCitationMergedBody(deps: ExtractionPersistDeps, mergedContent: string): string {
  if (resolvePipelineProcessingCapabilities(deps.config).inlineSourceAttribution !== true) {
    return mergedContent;
  }
  const template = deps.config.inlineSourceAttributionFormat;
  return hasCitationForTemplate(mergedContent, template)
    ? stripCitationForTemplate(mergedContent, template)
    : mergedContent;
}

/**
 * Round N+16 (C): the fact-hash identity of the COMMITTED merged body —
 * the same raw sanitized rule the provenance patch stamps. The degraded
 * repair registers THIS value (what storage actually holds), never the
 * record's persisted `frontmatter.contentHash`, which on that path is the
 * stale PRE-merge identity. Undefined for non-fact categories (hash ops
 * are fact-category no-ops there).
 */
export function committedMergedFactHash(
  deps: ExtractionPersistDeps,
  category: string,
  committedContent: string,
): string | undefined {
  if (category !== "fact") return undefined;
  return ContentHashIndex.computeHash(sanitizeMemoryContent(rawPreCitationMergedBody(deps, committedContent)).text);
}

/**
 * Round N+19 (B): durably persist the degraded merge's repaired hash. The
 * round-N+16 C repair registered the committed body's hash in the
 * process-local fact-hash index, but the record's PERSISTED frontmatter
 * `contentHash` still carried the stale pre-merge identity — and a restart's
 * first-use index rebuild derives hashes from the durable corpus, where
 * `corpusRegisteredHashes` returns the stale persisted value whenever it
 * disagrees with the current body. The repair was therefore discarded on
 * restart. This restamps the persisted identity to the committed body's hash
 * through the same conditional frontmatter API the provenance patch uses: a
 * writer that replaced the record meanwhile fails the compare and keeps its
 * own (correct) identity. Best-effort — failures are logged, never fatal to
 * the degraded merge.
 */
export async function persistRepairedContentHash(
  storage: {
    getMemoryByIdIncludingArchived: (id: string) => Promise<MemoryFile | null>;
    writeMemoryFrontmatterIfUnchanged: (
      expected: MemoryFile,
      patch: Partial<MemoryFrontmatter>,
      lifecycle?: { actor?: string },
    ) => Promise<boolean>;
  },
  targetId: string,
  committedContent: string,
  contentHash: string,
): Promise<void> {
  try {
    const current = await storage.getMemoryByIdIncludingArchived(targetId);
    if (!current || current.content !== committedContent) return;
    if (inferMemoryStatus(current.frontmatter, current.path) !== "active") return;
    if (current.frontmatter.contentHash === contentHash) return;
    await storage.writeMemoryFrontmatterIfUnchanged(
      current,
      { contentHash },
      { actor: "semantic-merge" },
    );
  } catch (err) {
    log.warn(
      `semantic-merge: durable content-hash repair failed for ${targetId} (non-fatal; the in-memory index holds the merged body until restart): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
