
import { GraphEdgeAppendError } from "../graph-append-error.js";
import type { CasRevisionReadStatus } from "../storage/cas-revision-store.js";
import type { GraphEdge, GraphType } from "../graph.js";
import { readFile } from "node:fs/promises";
import { removeNodeEdgesForRewrite, rollbackNodeEdgeRewrite } from "../graph-jsonl.js";
import {
  attachCitation,
  citationTemplateIsDetectable,
  citationTemplatesForMerge,
  lastRecognizedCitationMarker,
  stripRecognizedCitations,
  type CitationContext,
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
    await recordStrandedCommit(targetPath, versioning, versionId, log, memoryDir);
  });
}

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
 * actually true of storage afterwards:
 *  - "reverted" — the target no longer holds this merge's unprovenanced text
 *    (ours was restored away, or another writer already replaced the body
 *  - "superseded" — the standing merged body is ANOTHER writer's commit
 *    (#2813 P1): `committedRevision` names the receipt token OUR CAS minted,
 *    the reread holds a different standing token, and a concurrent writer's
 *    deterministic merge is byte-for-byte our merged text — so only the
 *    token can attribute the standing record. Never revert theirs; the
 *    caller discards its own staged duplicate and reports the degraded merge;
 *  - "stands" — unverifiable (unreadable target), or the restore lost its
 *    race, so assume the merged text stands and refuse to create a duplicate.
 *
 * `committedRevision` is the CAS commit receipt (markCasCommittedRevision,
 * or the successful CAS's return value): the dedicated per-target revision
 * token from the durable sidecar (#2807) — unique per commit even within one
 * millisecond. Public `frontmatter.updated` never identifies a commit.
 * Callers without identity omit it and keep the body-equality
 * classification above.
 */
export type RevertMergedContentResult = "reverted" | "superseded" | "stands";

export async function revertMergedContent(
  storage: StorageManager,
  target: MemoryFile,
  mergedContent: string,
  committedRevision?: string,
): Promise<RevertMergedContentResult> {
  try {
    const current = await readTargetSnapshot(storage, target);
    if (!current) return "stands";
    if (current.content !== mergedContent) return "reverted";
    if (committedRevision !== undefined) {
      let standing: Awaited<ReturnType<StorageManager["readCasRevisionStatus"]>>;
      try {
        standing = await storage.readCasRevisionStatus(target.path);
      } catch (err) {
        standing = {
          status: "unavailable",
          reason: err instanceof Error ? err.message : String(err),
        };
      }
      if (standing.status === "present") {
        if (standing.revision !== committedRevision) {
          return "superseded";
        }
      } else if (standing.status === "unavailable") {
        log.warn(
          `revertMergedContent: CAS revision status for ${target.path} is unavailable (${standing.reason}); ownership cannot be verified — keeping the recovery snapshot instead of discarding or reverting`,
        );
        return "stands";
      } else {
        log.warn(
          `revertMergedContent: CAS revision receipt for ${target.path} is absent although this writer holds receipt ${committedRevision}; ownership cannot be verified — keeping the recovery snapshot`,
        );
        return "stands";
      }
    }
    return (await storage.updateMemoryIfUnchanged(current, target.content, {
      actor: "semantic-merge-rollback",
    }))
      ? "reverted"
      : "stands";
  } catch {
    return "stands";
  }
}

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

export async function rewriteMergedTargetGraphEdges(
  storage: {
    dir: string;
    getMemoryByIdIncludingArchived: (id: string) => Promise<MemoryFile | null>;
    readCasRevisionStatus: (filePath: string) => Promise<CasRevisionReadStatus>;
  },
  input: {
    targetId: string;
    memoryRelPath: string;
    mergedContent: string;
    revisionChecked: string | undefined;
    rewriteTypes: readonly GraphType[];
    build: () => Promise<GraphEdge[] | void>;
  },
): Promise<boolean> {
  const removedEdges = await removeNodeEdgesForRewrite(storage.dir, input.memoryRelPath, input.rewriteTypes);
  let appended: readonly GraphEdge[] | undefined;
  try {
    appended = (await input.build()) ?? undefined;
    const committedNow = await storage.getMemoryByIdIncludingArchived(input.targetId);
    let standing: CasRevisionReadStatus;
    if (committedNow === null) {
      standing = { status: "absent" };
    } else {
      standing = await storage.readCasRevisionStatus(committedNow.path).catch((err: unknown) => ({
        status: "unavailable" as const,
        reason: err instanceof Error ? err.message : String(err),
      }));
    }
    if (
      !committedNow ||
      committedNow.content !== input.mergedContent ||
      standing.status === "unavailable" ||
      (standing.status === "present" ? standing.revision : undefined) !== input.revisionChecked
    ) {
      if (standing.status === "unavailable") {
        log.warn(
          `rewriteMergedTargetGraphEdges: CAS revision status for ${input.memoryRelPath} is unavailable (${standing.reason}); aborting the install — an unverified replacement must not install (#2837)`,
        );
      }
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

export function committedMergedBody(
  deps: ExtractionPersistDeps,
  mergedContent: string,
  incomingCitedContent: string | undefined,
  incomingCitationContext: Omit<CitationContext, "ts"> | undefined,
  nowIso: string,
): string {
  if (resolvePipelineProcessingCapabilities(deps.config).inlineSourceAttribution !== true) {
    return mergedContent;
  }
  const template = deps.config.inlineSourceAttributionFormat;
  const templates = citationTemplatesForMerge(deps.config);
  if (incomingCitedContent !== undefined) {
    const marker = lastRecognizedCitationMarker(incomingCitedContent, templates);
    if (marker) {
      return mergedContent.endsWith(marker) ? mergedContent : `${mergedContent} ${marker}`;
    }
  }
  if (!citationTemplateIsDetectable(template)) return mergedContent;
  if (lastRecognizedCitationMarker(mergedContent, templates)) return mergedContent;
  return attachCitation(
    mergedContent,
    { ...incomingCitationContext, ts: nowIso },
    template,
  );
}

export function rawPreCitationMergedBody(deps: ExtractionPersistDeps, mergedContent: string): string {
  if (resolvePipelineProcessingCapabilities(deps.config).inlineSourceAttribution !== true) {
    return mergedContent;
  }
  return stripRecognizedCitations(mergedContent, citationTemplatesForMerge(deps.config));
}

export function committedMergedFactHash(
  deps: ExtractionPersistDeps,
  category: string,
  committedContent: string,
): string | undefined {
  if (category !== "fact") return undefined;
  return ContentHashIndex.computeHash(sanitizeMemoryContent(rawPreCitationMergedBody(deps, committedContent)).text);
}

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
