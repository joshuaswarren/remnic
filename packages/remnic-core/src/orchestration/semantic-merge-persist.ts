/**
 * Persist-side executor for judge-mediated merge-on-write (issue #2330, step 3).
 *
 * Lives beside `extraction-persist.ts` so that file stays within its
 * file-size ratchet ceiling. Called once per surviving fact, right before
 * the normal (non-chunked) sealed-envelope write. On every failure mode —
 * disabled gate, empty band, judge refusal, invalid verdict, snapshot or
 * update failure — the outcome is "created" and the caller falls through
 * to the unchanged write path.
 *
 * Exact mutation order (checklist #14/#42): version snapshot FIRST, then
 * the in-place content update, then the frontmatter patch, then hash-index
 * remove/add, then reindex. The new fact's content is never indexed as
 * its own entry — it was never persisted (checklist #32).
 */

import { readFile } from "node:fs/promises";

import {
  FallbackLlmClient,
  fallbackLlmRuntimeContextFromConfig,
} from "../fallback-llm.js";
import { log } from "../logger.js";
import { createVersion, type VersioningConfig } from "../page-versioning.js";
import {
  buildMergeFrontmatterUpdate,
  type MergeProvenanceSource,
} from "../dedup/merge-provenance.js";
import {
  callMergeJudge,
  type MergeJudgeCallOptions,
} from "../dedup/merge-judge.js";
import {
  decideSemanticMerge,
  type MergeCreateReason,
  type MergeJudgeRawVerdict,
} from "../dedup/merge.js";
import { REFUSED_MERGE_CATEGORIES } from "../dedup/merge-on-write.js";
import { inferMemoryStatus } from "../memory-lifecycle-ledger-utils.js";
import { resolveRecallAuxiliaryCapabilities } from "../capabilities.js";
import type { StorageManager } from "../index.js";
import type { MemoryFile, ProvenanceSource } from "../types.js";
import type { ExtractionPersistDeps } from "./extraction-persist-deps.js";

export type SemanticMergeCreateReason =
  | MergeCreateReason
  | "target_inactive"
  | "target_changed"
  | "snapshot_unavailable"
  | "snapshot_failed"
  | "update_failed"
  | "shadow_would_merge";

export type SemanticMergePersistOutcome =
  | {
      action: "merged";
      targetId: string;
      /**
       * False only in the degraded case where the content update committed,
       * the frontmatter patch failed, AND the automatic rollback could not
       * run. The merged text IS in the target, so the caller must not write
       * the fact again; the pre-merge snapshot is named in the error log.
       */
      provenancePatched: boolean;
    }
  | { action: "created"; reason: SemanticMergeCreateReason };

/** Categories that never merge (episodic / immutable by nature). */
const REFUSED = REFUSED_MERGE_CATEGORIES as readonly string[];

export interface ApplySemanticMergeOptions {
  storage: StorageManager;
  /** RAW (pre-citation) fact content — the same form the dedup band scores. */
  content: string;
  category: string;
  /** The incoming fact's claim-level provenance spans, appended to the target. */
  sources?: ProvenanceSource[];
  /**
   * Provenance connector of the incoming fact. Forwarded to the decision so a
   * cross-connector neighbor is never a merge target (same scope contract the
   * novelty and semantic-dedup gates apply).
   */
  sourceConnector?: string;
  /** Caller-side bypass: contradiction detected or pending_review routing. */
  skip?: boolean;
  /** Injection seam for tests. */
  now?: () => Date;
  judgeCall?: (options: MergeJudgeCallOptions) => Promise<MergeJudgeRawVerdict | null>;
}

function versioningConfigFrom(deps: ExtractionPersistDeps): VersioningConfig {
  return {
    enabled: resolveRecallAuxiliaryCapabilities(deps.config).versioning,
    maxVersionsPerPage: deps.config.versioningMaxPerPage,
    sidecarDir: deps.config.versioningSidecarDir,
  };
}

/**
 * Re-read the target through the SAME reader the storage compare-and-swaps
 * use, so a snapshot handed to one of them carries an identical fingerprint
 * basis. Null means the file no longer holds this memory, which no caller may
 * read as "unchanged".
 */
async function readTargetSnapshot(
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
async function revertMergedContent(
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

export async function applySemanticMergeAtPersist(
  deps: ExtractionPersistDeps,
  options: ApplySemanticMergeOptions,
): Promise<SemanticMergePersistOutcome> {
  const config = deps.config.semanticMerge;
  if (config?.enabled !== true || options.skip === true) {
    return { action: "created", reason: "disabled" };
  }
  if (REFUSED.includes(options.category)) {
    return { action: "created", reason: "disabled" };
  }

  const decision = await decideSemanticMerge({
    content: options.content,
    category: options.category,
    config,
    sourceConnector: options.sourceConnector,
    dedupThreshold: deps.config.semanticDedupThreshold,
    lookup: (content, limit) => deps.semanticDedupLookup(content, limit, options.storage),
    resolveCandidate: async (memoryId) => {
      const memory = await options.storage.getMemoryByIdIncludingArchived(memoryId);
      if (!memory) return null;
      return {
        content: memory.content,
        category: memory.frontmatter.category,
        status: inferMemoryStatus(memory.frontmatter, memory.path),
      };
    },
    judge: async (input) => {
      const call = options.judgeCall ?? callMergeJudge;
      // A null (no backend answered / schema-failed) maps to a thrown error
      // so decideSemanticMerge classifies it as judge_error → create.
      const verdict = await call({
        ...input,
        candidates: [...input.candidates],
        config: deps.config,
        localLlm: deps.getLocalLlm(),
        fallbackLlm: new FallbackLlmClient(
          deps.config.gatewayConfig,
          fallbackLlmRuntimeContextFromConfig(deps.config),
        ),
      });
      if (!verdict) throw new Error("merge judge unavailable or unparseable");
      return verdict;
    },
  });

  if (decision.action === "create") {
    if (config.shadowMode) {
      log.info(
        `semantic-merge[shadow]: would create "${options.content.slice(0, 60)}…" reason="${decision.reason}"`,
      );
    }
    return { action: "created", reason: decision.reason };
  }

  if (config.shadowMode) {
    // Rollout lever: decision-only. Never mutate in shadow mode.
    log.info(
      `semantic-merge[shadow]: would merge into ${decision.targetId} reason="judge_merge"`,
    );
    return { action: "created", reason: "shadow_would_merge" };
  }

  // Step 1 — re-read the target; gone or no-longer-active → create.
  const target = await options.storage.getMemoryByIdIncludingArchived(decision.targetId);
  if (!target || inferMemoryStatus(target.frontmatter, target.path) !== "active") {
    return { action: "created", reason: "target_inactive" };
  }
  // `mergedContent` was composed from the body the judge was shown. In a
  // multi-writer deployment another extraction can update the target between
  // that resolve and now; writing the merge would silently drop the
  // concurrent writer's details. A changed body creates instead.
  if (target.content !== decision.targetContent) {
    return { action: "created", reason: "target_changed" };
  }

  // Step 2 — rollback data BEFORE any mutation (checklist #14). A failed
  // snapshot must leave the target untouched. Versioning disabled means no
  // rollback story exists at all, so merge refuses to run.
  const versioning = versioningConfigFrom(deps);
  if (!versioning.enabled) {
    return { action: "created", reason: "snapshot_unavailable" };
  }
  let versionId: string;
  try {
    const currentFile = await readFile(target.path, "utf8");
    const version = await createVersion(
      target.path,
      currentFile,
      "semantic-merge",
      versioning,
      log,
      "judge-mediated merge-on-write (issue #2330)",
      options.storage.dir,
    );
    versionId = String(version.versionId);
  } catch (err) {
    log.warn(
      `semantic-merge: snapshot failed for ${decision.targetId}; creating new fact instead: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { action: "created", reason: "snapshot_failed" };
  }

  // Step 3 — update in place, preserving the id, via compare-and-swap on the
  // snapshot just read: a writer landing between the read and the write must
  // win rather than be overwritten from a stale body. The active-target check
  // above makes a tombstone block structurally impossible here.
  const nowIso = (options.now ? options.now() : new Date()).toISOString();
  let contentCommitted = false;
  try {
    const frontmatter = buildMergeFrontmatterUpdate({
      targetSources: (target.frontmatter.sources ?? []) as MergeProvenanceSource[],
      incomingSources: (options.sources ?? []) as MergeProvenanceSource[],
      targetReinforcementCount: target.frontmatter.reinforcement_count,
      nowIso,
    });
    const updated = await options.storage.updateMemoryIfUnchanged(target, decision.mergedContent, {
      actor: "semantic-merge",
    });
    if (!updated) return { action: "created", reason: "target_changed" };
    contentCommitted = true;
    // The provenance patch must land on OUR merged body. An id-keyed patch
    // re-reads and stamps whatever the latest row holds, so a writer landing
    // after the content commit would receive this merge's provenance while
    // its own body stood — and the caller would still be told "merged".
    // Verify the snapshot, then patch it through the conditional API so the
    // window between the verify and the patch is closed by storage itself.
    const merged = await readTargetSnapshot(options.storage, target);
    if (!merged || merged.content !== decision.mergedContent) {
      throw new Error("target replaced before the provenance patch");
    }
    const patched = await options.storage.writeMemoryFrontmatterIfUnchanged(
      merged,
      {
        updated: frontmatter.updated,
        derived_via: frontmatter.derived_via,
        reinforcement_count: frontmatter.reinforcement_count,
        sources: frontmatter.sources,
      },
      { actor: "semantic-merge" },
    );
    if (!patched) throw new Error("frontmatter patch rejected (target changed)");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // A committed content update means the merged text may be IN the target.
    // Reporting `created` while it is would write the fact a second time and
    // leave those claims without the incoming provenance, so `created` is
    // reachable only once storage has been re-read and confirms the target no
    // longer holds this merge's unprovenanced body.
    if (
      contentCommitted &&
      !(await revertMergedContent(options.storage, target, decision.mergedContent))
    ) {
      log.error(
        `semantic-merge: ${decision.targetId} holds merged content without provenance metadata and the rollback failed (${detail}); snapshot ${versionId} holds the pre-merge state — recover with revertToVersion. Not creating a duplicate fact.`,
      );
      return { action: "merged", targetId: decision.targetId, provenancePatched: false };
    }
    log.warn(
      `semantic-merge: update failed for ${decision.targetId}${contentCommitted ? " (content rolled back)" : ""} (snapshot ${versionId} holds the pre-merge state): ${detail}`,
    );
    return { action: "created", reason: "update_failed" };
  }

  // Step 4 — hash index: remove the old form, add the new form, in the
  // same corpus-registered identity the write path uses. Both helpers are
  // fact-category no-ops, mirroring `contentHashSource` on the write path.
  // The index rebuilds from the corpus on restart, so a failure here is
  // logged, not fatal.
  try {
    await options.storage.removeFactContentHashesForMemories([target]);
    await options.storage.restoreFactHashAfterApproval(decision.targetId);
  } catch (err) {
    log.warn(
      `semantic-merge: hash-index sync failed for ${decision.targetId} (non-fatal; index rebuilds from corpus): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Step 5 — reindex the merged target or its new content stays
  // undiscoverable until unrelated maintenance runs (checklist #31).
  try {
    await deps.indexPersistedMemory(options.storage, decision.targetId);
  } catch (err) {
    log.warn(
      `semantic-merge: reindex failed for ${decision.targetId} (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  log.info(
    `semantic-merge: merged fact into ${decision.targetId} (version ${versionId})`,
  );
  return { action: "merged", targetId: decision.targetId, provenancePatched: true };
}
