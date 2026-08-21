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
import type { ProvenanceSource } from "../types.js";
import type { ExtractionPersistDeps } from "./extraction-persist-deps.js";

export type SemanticMergeCreateReason =
  | MergeCreateReason
  | "target_inactive"
  | "snapshot_unavailable"
  | "snapshot_failed"
  | "update_failed"
  | "shadow_would_merge";

export type SemanticMergePersistOutcome =
  | { action: "merged"; targetId: string }
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

  // Step 3 — update in place, preserving the id. The active-target check
  // above makes a tombstone block structurally impossible here.
  const nowIso = (options.now ? options.now() : new Date()).toISOString();
  try {
    const frontmatter = buildMergeFrontmatterUpdate({
      targetSources: (target.frontmatter.sources ?? []) as MergeProvenanceSource[],
      incomingSources: (options.sources ?? []) as MergeProvenanceSource[],
      targetReinforcementCount: target.frontmatter.reinforcement_count,
      nowIso,
    });
    const updated = await options.storage.updateMemory(decision.targetId, decision.mergedContent, {
      actor: "semantic-merge",
    });
    if (!updated) return { action: "created", reason: "update_failed" };
    const patched = await options.storage.updateMemoryFrontmatter(decision.targetId, {
      updated: frontmatter.updated,
      derived_via: frontmatter.derived_via,
      reinforcement_count: frontmatter.reinforcement_count,
      sources: frontmatter.sources,
    });
    if (!patched) {
      log.warn(
        `semantic-merge: frontmatter patch failed for ${decision.targetId} after content update (snapshot ${versionId} holds the pre-merge state); creating new fact. Recover with revertToVersion.`,
      );
      return { action: "created", reason: "update_failed" };
    }
  } catch (err) {
    log.warn(
      `semantic-merge: update failed for ${decision.targetId} (snapshot ${versionId} holds the pre-merge state): ${err instanceof Error ? err.message : String(err)}`,
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
  return { action: "merged", targetId: decision.targetId };
}
