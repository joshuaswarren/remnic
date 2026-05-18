/**
 * Resolution Verbs — executes user-chosen resolution actions on contradiction pairs (issue #520).
 *
 * All resolution paths delegate to StorageManager.supersedeMemory. Do not
 * reimplement supersession logic here (rule 22: deduplicate resolution).
 */

import type { StorageManager } from "../storage.js";
import type { MemoryCategory, MemoryFile } from "../types.js";
import type { ResolutionVerb } from "./contradiction-review.js";
import { resolvePair, readPair } from "./contradiction-review.js";
import { log } from "../logger.js";

export interface ResolutionResult {
  pairId: string;
  verb: ResolutionVerb;
  /** Memory IDs affected by the resolution. */
  affectedIds: string[];
  /** Human-readable status. */
  message: string;
}

export interface ExecuteResolutionOptions {
  /** Existing merged memory to supersede both source memories to. */
  mergedMemoryId?: string;
  /** Content for a new merged memory. Required for merge when mergedMemoryId is omitted. */
  mergedContent?: string;
  /** Category for a newly created merged memory. Defaults to the shared source category, or fact. */
  mergedCategory?: MemoryCategory;
  /** Resolve storage for the pair namespace, or the default namespace for legacy unscoped pairs. */
  storageForNamespace?: (namespace: string | undefined) => StorageManager | Promise<StorageManager>;
}

const VALID_VERBS: ResolutionVerb[] = ["keep-a", "keep-b", "merge", "both-valid", "needs-more-context"];

export function isValidResolutionVerb(value: string): value is ResolutionVerb {
  return VALID_VERBS.includes(value as ResolutionVerb);
}

/**
 * Execute a resolution verb on a contradiction pair.
 *
 * - `keep-a`: Supersede B, keep A active.
 * - `keep-b`: Supersede A, keep B active.
 * - `merge`: Create or verify a real merged memory, then supersede both inputs.
 * - `both-valid`: Mark pair as reviewed; no memories are superseded.
 * - `needs-more-context`: Defer; no action, short cooldown.
 */
export async function executeResolution(
  memoryDir: string,
  storage: StorageManager,
  pairId: string,
  verb: ResolutionVerb,
  options: ExecuteResolutionOptions = {},
): Promise<ResolutionResult> {
  const pair = readPair(memoryDir, pairId);
  if (!pair) {
    return { pairId, verb, affectedIds: [], message: `Pair ${pairId} not found` };
  }

  if (pair.namespace && !options.storageForNamespace) {
    throw new Error(
      "contradiction resolution requires storageForNamespace for namespaced pairs so callers resolve the correct namespace storage",
    );
  }

  const resolutionStorage = options.storageForNamespace
    ? await options.storageForNamespace(pair.namespace)
    : storage;

  if (pair.resolution && pair.resolution !== "needs-more-context") {
    return { pairId, verb, affectedIds: [], message: `Pair already resolved with verb "${pair.resolution}"` };
  }

  const [idA, idB] = pair.memoryIds;
  const affectedIds: string[] = [];
  let message = "";
  let supersedeFailed = false;

  switch (verb) {
    case "keep-a": {
      const keepTarget = await validateKeepTarget(resolutionStorage, pairId, idA);
      if (!keepTarget.ok) {
        supersedeFailed = true;
        message = keepTarget.message;
        break;
      }
      const sourceB = await loadSourceSnapshot(resolutionStorage, idB);
      const ok = sourceB
        ? await supersedeSafe(resolutionStorage, idB, idA, "contradiction-resolution:keep-a")
        : false;
      if (ok) { affectedIds.push(idB); message = `Kept ${idA}, superseded ${idB}`; }
      else {
        supersedeFailed = true;
        const rolledBack = sourceB
          ? await restoreMemorySnapshot(resolutionStorage, sourceB, "contradiction-resolution:keep-a-rollback")
          : false;
        message = rolledBack
          ? `Supersede failed for ${idB}; restored ${idB} and did not resolve`
          : `Supersede failed for ${idB}; rollback incomplete for ${idB} and pair is not resolved`;
      }
      break;
    }
    case "keep-b": {
      const keepTarget = await validateKeepTarget(resolutionStorage, pairId, idB);
      if (!keepTarget.ok) {
        supersedeFailed = true;
        message = keepTarget.message;
        break;
      }
      const sourceA = await loadSourceSnapshot(resolutionStorage, idA);
      const ok = sourceA
        ? await supersedeSafe(resolutionStorage, idA, idB, "contradiction-resolution:keep-b")
        : false;
      if (ok) { affectedIds.push(idA); message = `Kept ${idB}, superseded ${idA}`; }
      else {
        supersedeFailed = true;
        const rolledBack = sourceA
          ? await restoreMemorySnapshot(resolutionStorage, sourceA, "contradiction-resolution:keep-b-rollback")
          : false;
        message = rolledBack
          ? `Supersede failed for ${idA}; restored ${idA} and did not resolve`
          : `Supersede failed for ${idA}; rollback incomplete for ${idA} and pair is not resolved`;
      }
      break;
    }
    case "merge": {
      const replacement = await prepareMergeReplacement(resolutionStorage, pairId, idA, idB, options);
      if (!replacement.ok) {
        supersedeFailed = true;
        message = replacement.message;
        break;
      }

      const okA = await supersedeSafe(resolutionStorage, idA, replacement.mergedId, "contradiction-resolution:merge");
      if (!okA) {
        supersedeFailed = true;
        const rolledBackA = await restoreMemorySnapshot(resolutionStorage, replacement.sourceA);
        message = rolledBackA
          ? `Merge failed for ${idA}; restored ${idA} and did not resolve`
          : `Merge failed for ${idA}; rollback incomplete for ${idA} and pair is not resolved`;
        if (rolledBackA) {
          await cleanupCreatedReplacement(resolutionStorage, replacement);
        }
        break;
      }

      const okB = await supersedeSafe(resolutionStorage, idB, replacement.mergedId, "contradiction-resolution:merge");
      if (!okB) {
        supersedeFailed = true;
        const rolledBackA = await restoreMemorySnapshot(resolutionStorage, replacement.sourceA);
        const rolledBackB = await restoreMemorySnapshot(resolutionStorage, replacement.sourceB);
        message = rolledBackA && rolledBackB
          ? `Merge failed for ${idB}; restored ${idA} and ${idB} and did not resolve`
          : `Merge failed for ${idB}; rollback incomplete for ${[
            rolledBackA ? undefined : idA,
            rolledBackB ? undefined : idB,
          ].filter(Boolean).join(", ")} and pair is not resolved`;
        if (rolledBackA && rolledBackB) {
          await cleanupCreatedReplacement(resolutionStorage, replacement);
        }
        break;
      }

      affectedIds.push(idA, idB);
      message = `Both memories superseded by merged ${replacement.mergedId}`;
      break;
    }
    case "both-valid": {
      message = "Pair marked as both-valid; cooldown applied";
      break;
    }
    case "needs-more-context": {
      message = "Deferred; no action taken, short cooldown applied";
      break;
    }
  }

  if (!supersedeFailed) {
    resolvePair(memoryDir, pairId, verb);
  }
  log.info("[contradiction-resolution] pair=%s verb=%s affected=%d", pairId, verb, affectedIds.length);
  return { pairId, verb, affectedIds, message };
}

type MergeReplacement =
  | {
      ok: true;
      mergedId: string;
      sourceA: MemoryFile;
      sourceB: MemoryFile;
      created: boolean;
    }
  | {
      ok: false;
      message: string;
    };

async function prepareMergeReplacement(
  storage: StorageManager,
  pairId: string,
  idA: string,
  idB: string,
  options: ExecuteResolutionOptions,
): Promise<MergeReplacement> {
  const sourceA = await storage.getMemoryById(idA);
  const sourceB = await storage.getMemoryById(idB);
  if (!sourceA || !sourceB) {
    return { ok: false, message: `Merge requires both source memories to exist; not resolving ${pairId}` };
  }

  const requestedMergedId = options.mergedMemoryId?.trim();
  if (requestedMergedId) {
    if (requestedMergedId === idA || requestedMergedId === idB) {
      return { ok: false, message: "Merge replacement must be distinct from both source memories; not resolving" };
    }
    const replacement = await storage.getMemoryById(requestedMergedId);
    if (!replacement) {
      return { ok: false, message: `Merged memory ${requestedMergedId} not found; not resolving` };
    }
    const replacementStatus = replacement.frontmatter.status ?? "active";
    if (replacementStatus !== "active") {
      return {
        ok: false,
        message: `Merged memory ${requestedMergedId} is ${replacementStatus}; not resolving`,
      };
    }
    return { ok: true, mergedId: requestedMergedId, sourceA, sourceB, created: false };
  }

  const mergedContent = options.mergedContent;
  if (typeof mergedContent !== "string" || mergedContent.trim().length === 0) {
    return {
      ok: false,
      message: "Merge requires mergedMemoryId or mergedContent; no memories changed",
    };
  }

  const category = options.mergedCategory ?? mergedMemoryCategory(sourceA, sourceB);
  let mergedId: string;
  try {
    mergedId = await storage.writeMemory(category, mergedContent, {
      actor: "contradiction-resolution",
      confidence: Math.min(sourceA.frontmatter.confidence ?? 0.8, sourceB.frontmatter.confidence ?? 0.8),
      tags: ["contradiction-resolution", "merge"],
      source: "contradiction-resolution",
      lineage: [idA, idB],
      derivedFrom: [idA, idB],
      derivedVia: "merge",
    });
  } catch (err) {
    log.warn(
      "[contradiction-resolution] merged memory creation failed for %s: %s",
      pairId,
      err instanceof Error ? err.message : err,
    );
    return { ok: false, message: `Merged memory could not be created; not resolving ${pairId}` };
  }
  const replacement = await storage.getMemoryById(mergedId);
  if (!replacement) {
    await cleanupMemoryId(storage, mergedId);
    return { ok: false, message: `Merged memory ${mergedId} could not be verified; not resolving` };
  }
  return { ok: true, mergedId, sourceA, sourceB, created: true };
}

function mergedMemoryCategory(sourceA: MemoryFile, sourceB: MemoryFile): MemoryCategory {
  return sourceA.frontmatter.category === sourceB.frontmatter.category
    ? sourceA.frontmatter.category
    : "fact";
}

type KeepTargetValidation =
  | { ok: true }
  | { ok: false; message: string };

async function validateKeepTarget(
  storage: StorageManager,
  pairId: string,
  keepId: string,
): Promise<KeepTargetValidation> {
  const target = await loadSourceSnapshot(storage, keepId);
  if (!target) {
    return { ok: false, message: `Kept memory ${keepId} not found; not resolving ${pairId}` };
  }

  const status = target.frontmatter.status ?? "active";
  if (status !== "active") {
    return { ok: false, message: `Kept memory ${keepId} is ${status}; not resolving ${pairId}` };
  }

  return { ok: true };
}

async function loadSourceSnapshot(storage: StorageManager, memoryId: string): Promise<MemoryFile | null> {
  try {
    return await storage.getMemoryById(memoryId);
  } catch (err) {
    log.warn(
      "[contradiction-resolution] source snapshot failed for %s: %s",
      memoryId,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

async function restoreMemorySnapshot(
  storage: StorageManager,
  memory: MemoryFile,
  reasonCode = "contradiction-resolution:merge-rollback",
): Promise<boolean> {
  try {
    const current = await storage.getMemoryById(memory.frontmatter.id);
    if (!current) return false;
    const restoredFrontmatter: Partial<MemoryFile["frontmatter"]> = {
      ...memory.frontmatter,
      status: memory.frontmatter.status,
      supersededBy: memory.frontmatter.supersededBy,
      supersededAt: memory.frontmatter.supersededAt,
    };
    return await storage.writeMemoryFrontmatter(current, restoredFrontmatter, {
      actor: "contradiction-resolution",
      reasonCode,
    });
  } catch (err) {
    log.warn(
      "[contradiction-resolution] rollback failed for %s: %s",
      memory.frontmatter.id,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

async function cleanupCreatedReplacement(storage: StorageManager, replacement: Extract<MergeReplacement, { ok: true }>): Promise<void> {
  if (!replacement.created) return;
  await cleanupMemoryId(storage, replacement.mergedId);
}

async function cleanupMemoryId(storage: StorageManager, memoryId: string): Promise<void> {
  try {
    const memory = await storage.getMemoryById(memoryId);
    const invalidated = await storage.invalidateMemory(memoryId);
    if (invalidated && memory?.frontmatter.category === "fact") {
      await storage.removeFactContentHashesForMemories([memory]);
    }
  } catch (err) {
    log.warn(
      "[contradiction-resolution] cleanup failed for merged memory %s: %s",
      memoryId,
      err instanceof Error ? err.message : err,
    );
  }
}

async function supersedeSafe(
  storage: StorageManager,
  oldId: string,
  newId: string,
  reason: string,
): Promise<boolean> {
  try {
    const result = await storage.supersedeMemory(oldId, newId, reason);
    if (result === false) {
      log.warn("[contradiction-resolution] supersede returned false for %s → %s", oldId, newId);
      return false;
    }
    return true;
  } catch (err) {
    log.warn(
      "[contradiction-resolution] supersede failed %s → %s: %s",
      oldId,
      newId,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}
