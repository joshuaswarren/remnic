/**
 * Recovery primary-mutation replay for durable dependency propagation.
 *
 * Extracted from the delivery module so the recovery concern — resolving a
 * memory across hot/cold/archived stores and replaying the primary mutation
 * (supersede / invalidate / temporal) that a durable job represents — lives in
 * one cohesive place. These functions are stateless with respect to the
 * delivery class: they operate on an injected storage handle plus pure helpers,
 * so the delivery delegates here without wrapper indirection. The module
 * imports only package-local, host-agnostic sources (no index backend).
 */
import { createHash } from "node:crypto";

import { sanitizeMemoryContent } from "../sanitize.js";
import type { MemoryFile } from "../types.js";
import {
  applyTemporalSupersessionPrimaryMutation,
  type TemporalSupersessionStorage,
} from "../temporal-supersession.js";
import {
  type DependencyPropagationStorage,
  type PropagationEvent,
} from "./dependency-propagation.js";
import { canonicalize, matchesPreparedSource } from "./dependency-propagation-queue-state.js";

/**
 * Storage capabilities the recovery replay needs beyond the base
 * {@link DependencyPropagationStorage}: cold/archived memory reads, committed
 * invalidation bookkeeping, and the supersede/invalidate primitives.
 */
export type DependencyPropagationRecoveryStorage = DependencyPropagationStorage & {
  readAllColdMemories?: () => Promise<MemoryFile[]>;
  readArchivedMemories?: () => Promise<MemoryFile[]>;
  hasCommittedInvalidation?: (memory: Pick<MemoryFile, "content" | "frontmatter">) => Promise<boolean>;
  clearCommittedInvalidation?: (
    memory: Pick<MemoryFile, "content" | "frontmatter">,
  ) => Promise<void>;
  invalidateMemory?: (
    id: string,
    snapshot?: Pick<MemoryFile, "content" | "frontmatter"> & Partial<Pick<MemoryFile, "path">>,
    options?: { recordCommitProof?: boolean },
  ) => Promise<boolean>;
  updateMemoryIfUnchanged?: (
    expected: MemoryFile,
    content: string,
    options?: {
      supersedes?: string;
      lineage?: string[];
      actor?: string;
      sourceConnector?: string;
    },
  ) => Promise<boolean>;
};

/**
 * Content fingerprint captured at preparation time. Access-count /
 * last-accessed bookkeeping is excluded so a replay can prove the survivor has
 * not drifted.
 */
export function memoryFingerprint(memory: Pick<MemoryFile, "content" | "frontmatter">): string {
  const { accessCount: _accessCount, lastAccessed: _lastAccessed, ...frontmatter } = memory.frontmatter;
  return createHash("sha256")
    .update(JSON.stringify(canonicalize({ content: memory.content, frontmatter })))
    .digest("hex");
}

/**
 * Resolve a memory by id across hot, cold, and archived stores. Returns `null`
 * when no source record survives anywhere — recovery then cannot replay.
 */
export async function findRecoverySource(
  storage: DependencyPropagationRecoveryStorage,
  sourceId: string,
): Promise<MemoryFile | null> {
  const hot = await storage.getMemoryById(sourceId);
  if (hot?.frontmatter.id === sourceId) return hot;
  if (storage.readAllColdMemories) {
    const cold = await storage.readAllColdMemories();
    const coldMatch = cold.find((memory) => memory.frontmatter.id === sourceId);
    if (coldMatch) return coldMatch;
  }
  if (storage.readArchivedMemories) {
    const archived = await storage.readArchivedMemories();
    const archivedMatch = archived.find((memory) => memory.frontmatter.id === sourceId);
    if (archivedMatch) return archivedMatch;
  }
  return null;
}

/**
 * Refresh a propagation event's replacement content from the current store for
 * replay. Returns the event unchanged when it has no replacement; returns
 * `null` when a replacement was expected but is no longer resolvable.
 */
export async function readCurrentReplacementEvent(
  storage: DependencyPropagationStorage,
  event: PropagationEvent,
): Promise<PropagationEvent | null> {
  if (event.replacementId === null) return event;
  const replacement = await findRecoverySource(
    storage as DependencyPropagationRecoveryStorage,
    event.replacementId,
  );
  if (!replacement) return null;
  return {
    ...event,
    replacementContent: replacement.content,
  };
}

/**
 * Replay the primary mutation a durable job represents against the current
 * store, by cause: temporal supersession, contradiction supersede,
 * consolidation invalidate, or consolidation merge. Idempotent — returns
 * `true` when the mutation is already applied or is applied now, `false` when
 * the source/replacement no longer matches the prepared snapshot (so the caller
 * keeps the job retryable instead of marking it complete).
 */
export async function replayPrimaryMutation(
  sourceStorage: DependencyPropagationStorage,
  event: PropagationEvent,
  preparedReplacementFingerprint?: string,
): Promise<boolean> {
  const storage = sourceStorage as DependencyPropagationRecoveryStorage;
  const source = await findRecoverySource(storage, event.oldMemory.frontmatter.id);
  const primaryApplied =
    source?.frontmatter.status === "superseded" &&
    source.frontmatter.supersededBy === event.replacementId;

  if (event.cause === "temporal_supersession") {
    if (!event.replacementId || !event.temporalMutation || !source) return false;
    const temporalPrimaryApplied =
      primaryApplied &&
      source.frontmatter.supersededAt === event.temporalMutation.supersededAt &&
      (event.temporalMutation.invalidAt === undefined ||
        source.frontmatter.invalid_at === event.temporalMutation.invalidAt);
    if (!temporalPrimaryApplied) {
      const replacement = await findRecoverySource(storage, event.replacementId);
      if (
        event.replacementContent === null ||
        !replacement ||
        replacement.frontmatter.id !== event.replacementId ||
        replacement.content !== event.replacementContent
      )
        return false;
      if (!matchesPreparedSource(source, event.oldMemory)) return false;
    }
    return await applyTemporalSupersessionPrimaryMutation({
      storage: sourceStorage as unknown as TemporalSupersessionStorage,
      oldMemory: source,
      replacementId: event.replacementId,
      mutation: event.temporalMutation,
    });
  }

  if (event.cause === "contradiction") {
    if (!event.replacementId || !source) return false;
    if (primaryApplied) return true;
    const replacement = await findRecoverySource(storage, event.replacementId);
    if (
      event.replacementContent === null ||
      !replacement ||
      replacement.frontmatter.id !== event.replacementId ||
      replacement.content !== event.replacementContent
    )
      return false;
    if (!matchesPreparedSource(source, event.oldMemory)) return false;
    return await storage.supersedeMemory(
      event.oldMemory.frontmatter.id,
      event.replacementId,
      `dependency_propagation:${event.cause}`,
      undefined,
      { requireActive: true, acceptExactReplay: true, expectedSnapshot: source },
    );
  }

  if (event.cause === "consolidation_invalidate") {
    if (!source) {
      return storage.hasCommittedInvalidation
        ? await storage.hasCommittedInvalidation(event.oldMemory)
        : false;
    }
    if (!storage.invalidateMemory || !matchesPreparedSource(source, event.oldMemory)) return false;
    return await storage.invalidateMemory(source.frontmatter.id, source, {
      recordCommitProof: true,
    });
  }

  if (
    !event.replacementId ||
    event.replacementContent === null ||
    !storage.updateMemoryIfUnchanged
  ) {
    return false;
  }
  const replacement = await findRecoverySource(storage, event.replacementId);
  const persistedReplacementContent = sanitizeMemoryContent(event.replacementContent).text;
  if (
    replacement &&
    replacement.frontmatter.supersedes === event.oldMemory.frontmatter.id &&
    replacement.content !== persistedReplacementContent
  ) {
    return false;
  }
  const mergeAlreadyApplied =
    replacement !== null &&
    replacement.frontmatter.supersedes === event.oldMemory.frontmatter.id &&
    replacement.content === persistedReplacementContent;
  if (!source) {
    if (!storage.hasCommittedInvalidation) return false;
    return await storage.hasCommittedInvalidation(event.oldMemory);
  }
  if (
    preparedReplacementFingerprint &&
    source &&
    !mergeAlreadyApplied &&
    (!replacement || memoryFingerprint(replacement) !== preparedReplacementFingerprint)
  ) {
    return false;
  }
  if (!replacement || !matchesPreparedSource(source, event.oldMemory)) return false;
  if (!mergeAlreadyApplied) {
    const updated = await storage.updateMemoryIfUnchanged(
      replacement,
      event.replacementContent,
      {
        supersedes: event.oldMemory.frontmatter.id,
        lineage: [event.replacementId, event.oldMemory.frontmatter.id],
      },
    );
    if (!updated) return false;
  }
  if (!storage.invalidateMemory) return false;
  return await storage.invalidateMemory(source.frontmatter.id, source, {
    recordCommitProof: true,
  });
}
