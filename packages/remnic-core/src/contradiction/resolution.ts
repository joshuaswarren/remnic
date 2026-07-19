/**
 * Resolution Verbs — executes user-chosen resolution actions on contradiction pairs (issue #520).
 *
 * All resolution paths delegate to StorageManager.supersedeMemory. Do not
 * reimplement supersession logic here (rule 22: deduplicate resolution).
 */

import { log } from "../logger.js";
import { composeMemoryEnvelope } from "../write-envelope.js";
import type { StorageManager } from "../storage.js";
import type { MemoryCategory, MemoryFile } from "../types.js";
import type { ResolutionVerb } from "./contradiction-review.js";
import { readPair, resolvePair } from "./contradiction-review.js";

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
  /**
   * Best-effort hook invoked after a contradiction resolution leaves a durable
   * mutation in the namespace's memory files (issue #1499 sweep, NH1dX / NH3X3).
   * Every mutating verb — `merge` (creates a new memory and supersedes both
   * sources), `keep-a`, and `keep-b` (supersede the losing source + rewrite
   * frontmatter) — writes directly to the pair's (possibly DYNAMIC) namespace
   * storage, bypassing the extraction write path that records catalog writes. So
   * without this the namespace's `lastWriteAt` stays stale and QMD maintenance /
   * `writtenSince` can skip a namespace whose only post-write mutation is
   * resolving a contradiction. It fires after the resolution commits, or after a
   * failed resolution/rollback path when durable memory changes are still left on
   * disk. If a failure rolls back cleanly, this is never called, so the catalog
   * never records a write that did not survive (rule #25). Non-mutating verbs
   * (`both-valid`, `needs-more-context`) never trigger it. Callers wire this to
   * `Orchestrator.recordCatalogWrite(namespace, storageDir)`. Must be
   * failure-tolerant: it is fire-and-forget and must never affect resolution.
   */
  onMergedMemoryWritten?: (namespace: string | undefined, storageDir: string) => void;
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
  if (typeof verb !== "string" || !isValidResolutionVerb(verb)) {
    throw new Error(`Invalid contradiction resolution verb: ${String(verb)}`);
  }

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
  let rollbackAfterResolveFailure: (() => Promise<boolean>) | null = null;
  // Deferred catalog-write touch for any resolution that leaves durable namespace
  // memory mutations (issue #1499 sweep, NH1dX / NH3X3). Rule #25: never record a
  // catalog touch for a write that is fully rolled back. Successful mutating
  // resolutions invoke it after `resolvePair` persists. Failed paths invoke it
  // only when rollback inspection shows the namespace still differs from the
  // pre-mutation snapshot.
  let recordCatalogWriteTouch: (() => void) | null = null;
  // Returns the deferred touch fn for a mutating verb (or null when the caller
  // wired no catalog hook), so each branch assigns `recordCatalogWriteTouch`
  // directly in the function body — keeping TS control-flow narrowing intact at
  // the post-commit invocation below.
  const buildCatalogTouch = (): (() => void) | null => {
    if (!options.onMergedMemoryWritten) return null;
    const onMergedMemoryWritten = options.onMergedMemoryWritten;
    const namespace = pair.namespace;
    const storageDir = resolutionStorage.dir;
    return () => onMergedMemoryWritten(namespace, storageDir);
  };
  const catalogWriteTouch = buildCatalogTouch();
  const recordCatalogWriteTouchSafely = (context: string, touch = catalogWriteTouch): void => {
    if (!touch) return;
    try {
      touch();
    } catch (err) {
      log.warn(
        "[contradiction-resolution] catalog write touch failed for pair=%s context=%s: %s",
        pairId,
        context,
        err instanceof Error ? err.message : err,
      );
    }
  };
  const touchCatalogIfRollbackLeftChange = async (
    context: string,
    snapshots: MemoryFile[],
    replacement?: Extract<MergeReplacement, { ok: true }>,
  ): Promise<void> => {
    if (!catalogWriteTouch) return;
    if (await rollbackLeftDurableMutation(resolutionStorage, snapshots, replacement)) {
      recordCatalogWriteTouchSafely(context);
    }
  };

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
      if (ok) {
        affectedIds.push(idB);
        rollbackAfterResolveFailure = async () =>
          restoreMemorySnapshot(resolutionStorage, sourceB!, "contradiction-resolution:keep-a-rollback");
        // keep-a superseded idB in this namespace — record a catalog touch once
        // the resolution durably commits (NH3X3).
        recordCatalogWriteTouch = catalogWriteTouch;
        message = `Kept ${idA}, superseded ${idB}`;
      }
      else {
        supersedeFailed = true;
        const rolledBack = sourceB
          ? await restoreMemorySnapshot(resolutionStorage, sourceB, "contradiction-resolution:keep-a-rollback")
          : false;
        if (sourceB && !rolledBack) {
          await touchCatalogIfRollbackLeftChange("keep-a-rollback-incomplete", [sourceB]);
        }
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
      if (ok) {
        affectedIds.push(idA);
        rollbackAfterResolveFailure = async () =>
          restoreMemorySnapshot(resolutionStorage, sourceA!, "contradiction-resolution:keep-b-rollback");
        // keep-b superseded idA in this namespace — record a catalog touch once
        // the resolution durably commits (NH3X3).
        recordCatalogWriteTouch = catalogWriteTouch;
        message = `Kept ${idB}, superseded ${idA}`;
      }
      else {
        supersedeFailed = true;
        const rolledBack = sourceA
          ? await restoreMemorySnapshot(resolutionStorage, sourceA, "contradiction-resolution:keep-b-rollback")
          : false;
        if (sourceA && !rolledBack) {
          await touchCatalogIfRollbackLeftChange("keep-b-rollback-incomplete", [sourceA]);
        }
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
        else {
          await touchCatalogIfRollbackLeftChange("merge-first-rollback-incomplete", [replacement.sourceA], replacement);
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
        else {
          await touchCatalogIfRollbackLeftChange(
            "merge-second-rollback-incomplete",
            [replacement.sourceA, replacement.sourceB],
            replacement,
          );
        }
        break;
      }

      affectedIds.push(idA, idB);
      rollbackAfterResolveFailure = async () => {
        const rolledBackA = await restoreMemorySnapshot(resolutionStorage, replacement.sourceA);
        const rolledBackB = await restoreMemorySnapshot(resolutionStorage, replacement.sourceB);
        if (rolledBackA && rolledBackB) {
          await cleanupCreatedReplacement(resolutionStorage, replacement);
        }
        return rolledBackA && rolledBackB;
      };
      // Catalog write touch (issue #1499 sweep): the merge supersedes BOTH sources
      // (and, when created, writes a fresh merged memory) in the pair's (possibly
      // dynamic) namespace storage — but the resolution is not durable yet
      // (resolvePair persists below, and a failure rolls the merge back). Defer
      // the touch so it fires ONLY after the resolution commits past the rollback
      // point (NH1dX, rule #25). Arm it for EVERY successful merge — even reusing
      // an existing merged-id still supersedes both sources, a namespace mutation
      // that must refresh `lastWriteAt` (NH3X3). Otherwise a dynamic namespace
      // whose only durable mutation is a contradiction merge stays invisible to
      // QMD maintenance / `writtenSince`. Best-effort on the caller side.
      recordCatalogWriteTouch = catalogWriteTouch;
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
    let resolved = false;
    try {
      resolved = resolvePair(memoryDir, pairId, verb) !== null;
    } catch (err) {
      log.warn(
        "[contradiction-resolution] failed to persist pair=%s verb=%s: %s",
        pairId,
        verb,
        err instanceof Error ? err.message : err,
      );
    }
    if (!resolved) {
      if (rollbackAfterResolveFailure) {
        const rolledBack = await rollbackAfterResolveFailure();
        affectedIds.length = 0;
        message = rolledBack
          ? `Resolution persistence failed; rolled back memory changes and did not resolve ${pairId}`
          : "Resolution persistence failed; rollback incomplete and pair is not resolved";
        if (!rolledBack && recordCatalogWriteTouch) {
          recordCatalogWriteTouchSafely("resolve-persistence-rollback-incomplete", recordCatalogWriteTouch);
        }
      } else {
        message = "Resolution persistence failed; pair is not resolved";
      }
    } else if (recordCatalogWriteTouch) {
      // The resolution durably committed (memory mutated AND the resolution
      // persisted past the rollback point). Only now is it safe to record the
      // catalog write for the namespace mutation (NH1dX / NH3X3, rule #25).
      // Best-effort: the caller's callback swallows errors; guard here so a
      // throwing callback never derails a successful resolution.
      recordCatalogWriteTouchSafely("resolved", recordCatalogWriteTouch);
    }
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
    // Sealed-envelope write (issue #1989 PR4): merged content is
    // LLM-produced — salvage; drops are warn-logged.
    const mergeEnvelope = composeMemoryEnvelope(
      {
        content: mergedContent,
        category,
        confidence: Math.min(sourceA.frontmatter.confidence ?? 0.8, sourceB.frontmatter.confidence ?? 0.8),
        tags: ["contradiction-resolution", "merge"],
      },
      { source: "contradiction-resolution" },
      { salvage: true },
    );
    if (mergeEnvelope.salvageNotes.length > 0) {
      log.warn(`contradiction-resolution write salvaged invalid fields: ${mergeEnvelope.salvageNotes.join("; ")}`);
    }
    const mergeResult = await storage.writeSealedMemory(mergeEnvelope, {
      actor: "contradiction-resolution",
      lineage: [idA, idB],
      derivedVia: "merge",
    });
    mergedId = mergeResult.id;
    if (mergeResult.tombstoneBlocked) {
      // #1645: merged content matched a tombstone (pending_review). Don't
      // supersede both sources to a non-active replacement — that retires
      // the only active copies. Clean up the pending merge and abort the pair.
      await cleanupMemoryId(storage, mergedId);
      return { ok: false, message: `Merged memory for ${pairId} was tombstone-blocked (pending_review); not resolving — sources kept active` };
    }
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

async function rollbackLeftDurableMutation(
  storage: StorageManager,
  snapshots: MemoryFile[],
  replacement?: Extract<MergeReplacement, { ok: true }>,
): Promise<boolean> {
  for (const snapshot of snapshots) {
    try {
      const current = await storage.getMemoryById(snapshot.frontmatter.id);
      if (!current) return true;
      if (supersessionStateChanged(current, snapshot)) return true;
    } catch (err) {
      log.warn(
        "[contradiction-resolution] rollback inspection failed for %s: %s",
        snapshot.frontmatter.id,
        err instanceof Error ? err.message : err,
      );
      return true;
    }
  }

  if (replacement?.created) {
    try {
      return (await storage.getMemoryById(replacement.mergedId)) !== null;
    } catch (err) {
      log.warn(
        "[contradiction-resolution] rollback replacement inspection failed for %s: %s",
        replacement.mergedId,
        err instanceof Error ? err.message : err,
      );
      return true;
    }
  }

  return false;
}

function supersessionStateChanged(current: MemoryFile, snapshot: MemoryFile): boolean {
  return (
    current.frontmatter.status !== snapshot.frontmatter.status ||
    current.frontmatter.supersededBy !== snapshot.frontmatter.supersededBy ||
    current.frontmatter.supersededAt !== snapshot.frontmatter.supersededAt
  );
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
