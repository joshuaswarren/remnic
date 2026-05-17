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

  if (pair.resolution && pair.resolution !== "needs-more-context") {
    return { pairId, verb, affectedIds: [], message: `Pair already resolved with verb "${pair.resolution}"` };
  }

  const [idA, idB] = pair.memoryIds;
  const affectedIds: string[] = [];
  let message = "";
  let supersedeFailed = false;

  switch (verb) {
    case "keep-a": {
      const ok = await supersedeSafe(storage, idB, idA, "contradiction-resolution:keep-a");
      if (ok) { affectedIds.push(idB); message = `Kept ${idA}, superseded ${idB}`; }
      else { supersedeFailed = true; message = `Supersede failed for ${idB}; not resolving`; }
      break;
    }
    case "keep-b": {
      const ok = await supersedeSafe(storage, idA, idB, "contradiction-resolution:keep-b");
      if (ok) { affectedIds.push(idA); message = `Kept ${idB}, superseded ${idA}`; }
      else { supersedeFailed = true; message = `Supersede failed for ${idA}; not resolving`; }
      break;
    }
    case "merge": {
      const replacement = await prepareMergeReplacement(storage, pairId, idA, idB, options);
      if (!replacement.ok) {
        supersedeFailed = true;
        message = replacement.message;
        break;
      }

      const okA = await supersedeSafe(storage, idA, replacement.mergedId, "contradiction-resolution:merge");
      if (!okA) {
        supersedeFailed = true;
        const rolledBackA = await restoreMemorySnapshot(storage, replacement.sourceA);
        message = rolledBackA
          ? `Merge failed for ${idA}; restored ${idA} and did not resolve`
          : `Merge failed for ${idA}; rollback incomplete for ${idA} and pair is not resolved`;
        if (rolledBackA) {
          await cleanupCreatedReplacement(storage, replacement);
        }
        break;
      }

      const okB = await supersedeSafe(storage, idB, replacement.mergedId, "contradiction-resolution:merge");
      if (!okB) {
        supersedeFailed = true;
        const rolledBackA = await restoreMemorySnapshot(storage, replacement.sourceA);
        const rolledBackB = await restoreMemorySnapshot(storage, replacement.sourceB);
        message = rolledBackA && rolledBackB
          ? `Merge failed for ${idB}; restored ${idA} and ${idB} and did not resolve`
          : `Merge failed for ${idB}; rollback incomplete for ${[
            rolledBackA ? undefined : idA,
            rolledBackB ? undefined : idB,
          ].filter(Boolean).join(", ")} and pair is not resolved`;
        if (rolledBackA && rolledBackB) {
          await cleanupCreatedReplacement(storage, replacement);
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

async function restoreMemorySnapshot(storage: StorageManager, memory: MemoryFile): Promise<boolean> {
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
      reasonCode: "contradiction-resolution:merge-rollback",
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
