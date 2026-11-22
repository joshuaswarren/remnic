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

import path from "node:path";

import { buildBehaviorSignalsForMemory } from "../behavior-signals.js";

import { isUntrustedOrigin, parseOriginClass } from "../security/origin-authority.js";
import {
  FallbackLlmClient,
  fallbackLlmRuntimeContextFromConfig,
} from "../fallback-llm.js";
import { log } from "../logger.js";
import { sanitizeMemoryContent } from "../sanitize.js";
import { ContentHashIndex } from "../storage/content-hash-index.js";
import type { VersioningConfig } from "../page-versioning.js";
import {
  committedMergedBody,
  committedMergedFactHash,
  discardMergedTargetSnapshot,
  finalizeMergedVersionPrune,
  persistRepairedContentHash,
  rawPreCitationMergedBody,
  readTargetSnapshot,
  revertMergedContent,
  rewriteMergedTargetGraphEdges,
  stageMergedTargetSnapshot,
} from "./semantic-merge-commit-effects.js";
import {
  buildMergeFrontmatterUpdate,
  type MergeFrontmatterUpdate,
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
import { confidenceTier } from "../types.js";
import { REFUSED_MERGE_CATEGORIES } from "../dedup/merge-on-write.js";
import { inferMemoryStatus } from "../memory-lifecycle-ledger-utils.js";
import { inferIntentFromText } from "../intent.js";
import {
  type CitationContext,
} from "../source-attribution.js";
import {
  resolveConversationContextCapabilities,
  resolvePresentationCapabilities,
  resolveRecallAuxiliaryCapabilities,
  type GraphConstructionCapabilitySet,
} from "../capabilities.js";
import type { GraphType } from "../graph.js";
import type {
  BehaviorSignalEvent,
  FaithfulnessFrontmatter,
  MemoryCategory,
  MemoryFile,
  MemoryFrontmatter,
  MemoryLink,
  MemorySubject,
  ProvenanceSource,
} from "../types.js";
import { normalizeConnectorScope } from "../dedup/connector-scope.js";
import type { StorageManager } from "../index.js";
import { casCommittedRevisionOf } from "../storage/deletion-revision-store.js";
import type { ExtractionPersistDeps } from "./extraction-persist-deps.js";

export type SemanticMergeCreateReason =
  | MergeCreateReason
  | "target_inactive"
  | "target_changed"
  | "metadata_unpreservable"
  | "promoted_copy_present"
  | "snapshot_unavailable"
  | "snapshot_failed"
  | "update_failed"
  | "shadow_would_merge";


export type SemanticMergePersistOutcome =
  | {
      action: "merged";
      targetId: string;
      /**
       * The committed merged body (finding A): the caller's merged-target
       * promotion must copy THIS body — not the incoming fact — so the
       * shared/profile copy serves the same claims its `sourceMemoryId`
       * points at. Present on the degraded branch too, where the merged
       * text is committed even though the provenance patch failed.
       */
      mergedContent: string;
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
  /**
   * Extraction metadata the normal write path persists but a merge cannot
   * carry onto the target (item A). A merge forwards only content, category,
   * sources, and connector; when any entry here is NEW information relative
   * to the target, merging is bypassed so nothing is silently discarded.
   */
  incomingMetadata?: {
    tags?: readonly string[];
    entityRef?: string;
    structuredAttributes?: Record<string, string>;
    /** Effective `validAt` the write path would persist (bi-temporal or source). */
    validAt?: string;
    /** True when bi-temporal bounds (validFrom/validUntil/observedAt/eventTimeSource) apply. */
    biTemporal?: boolean;
    /** Importance score the write path would stamp. */
    importanceScore?: number;
    /**
     * Confidence the write path would stamp (final round A). The merged
     * record keeps the LOWER side — min(incoming, target), with the tier
     * that score maps to — matching what the create path would have stored
     * for the incoming fact alone; an incoming value at or above the
     * target's needs no rewrite. An unreadable value (non-finite or outside
     * [0, 1]) bypasses the merge rather than guessing a floor.
     */
    confidence?: number;
    /**
     * Provenance strength the write path would stamp.
     */
    provenanceStrength?: "verified" | "unverified" | "none";
    /**
     * True when the write path would stamp `toolScoped: true` (finding A):
     * connector-scoped claims must never widen into an unscoped target, so
     * such a fact is created through the write that stamps the flag. A
     * target that already carries `toolScoped: true` keeps its stricter
     * scope — the merge patch never touches that field.
     */
    toolScoped?: boolean;
    /**
     * Subject the write path would stamp when subject classification is
     * enabled (finding A): the merge patch has no carrier for `subject`, so
     * a fact whose effective subject differs from the target's must be
     * created rather than merged into a target that keeps a different label.
     */
    subject?: MemorySubject;
    /**
     * Authority origin the write path would stamp (finding A). The merge
     * patch has no carrier for `origin`, so the merged body would render
     * under the TARGET's authority at recall; a cross-origin merge is
     * refused outright (see {@link createPathMergeParity}).
     */
    origin?: string;
    /**
     * Faithfulness verdict the write path would stamp (finding C). In
     * shadow mode a contradicted/unsupported fact receives this frontmatter
     * without pending_review status, so the verdict — not just the enforce
     * status — gates parity: the merge patch cannot compose an honest
     * verdict for a combined body, so an incoming verdict that differs from
     * the target's effective one bypasses the merge.
     */
    faithfulness?: FaithfulnessFrontmatter;
    /**
     * Episode/note classification the write path would stamp when
     * `episodeNoteMode` is on (round N+2, finding B). The merge patch has
     * no `memoryKind` carrier, so the merged record keeps the target's
     * kind — the classification that drives episode-cache membership and
     * the episode-only verification/promotion paths. A computed incoming
     * kind that differs from the target's committed kind (including a
     * kinded fact into an unkinded legacy target) bypasses the merge.
     * Undefined means classification is off and no episode path consults
     * the field, so those merges keep passing.
     */
    memoryKind?: MemoryFrontmatter["memoryKind"];
  };
  /**
   * Navigation links the caller suggested for the incoming fact (finding B).
   * The create path stamps these on the fact it writes; a merge that dropped
   * them would permanently lose the relationships, so a successful merge
   * attaches them to the TARGET record in the same conditional frontmatter
   * patch that stamps provenance — deduped on (targetId, linkType), the key
   * `StorageManager.addLinksToMemory` uses.
   */
  incomingLinks?: readonly MemoryLink[];
  /**
   * Round N+7 (C): the caller's single cited body for this write — the raw
   * fact content with this write's citation marker attached (the same
   * string the verbatim artifact stores). The committed merged body reuses
   * that exact marker so the incoming claims stay attributed alongside the
   * target's older citation, and memory and artifact share one timestamp.
   * Absent (or citation-free) commits the judge's merged body unchanged.
   */
  incomingCitedContent?: string;
  /**
   * #2916: the citation context of THIS write (agent/session) — the same
   * base a fresh attributed write stamps. When no incoming citation marker
   * is liftable, the committed merged body still receives the configured
   * inline-attribution transform exactly as a fresh attributed write would,
   * stamped with this context and the merge's commit timestamp.
   */
  incomingCitationContext?: Omit<CitationContext, "ts">;
  /**
   * Finding C: async probe run after a merge verdict but before any
   * mutation. True when the would-be target already has promoted
   * shared/profile copies the merge cannot reconcile — the fact is created
   * through the normal write (whose promotion step owns those copies)
   * instead of merged.
   */
  targetHasPromotedCopies?: (targetId: string) => Promise<boolean>;
  /** Caller-side bypass: contradiction detected or pending_review routing. */
  skip?: boolean;
  now?: () => Date;
  judgeCall?: (options: MergeJudgeCallOptions) => Promise<MergeJudgeRawVerdict | null>;
}

const PROVENANCE_STRENGTH_RANK: Record<string, number> = {
  none: 0,
  unverified: 1,
  verified: 2,
};

export type CreatePathMergeParity =
  | {
      ok: true;
      provenanceFloor?: "verified" | "unverified" | "none";
      /** Lower incoming confidence the patch must stamp (final round A). */
      confidenceFloor?: number;
    }
  | { ok: false; field: string };

/** Effective provenance rank; absent reads as "none" (legacy contract, types.ts). */
function provenanceRank(value: string | undefined): number {
  return PROVENANCE_STRENGTH_RANK[value ?? "none"] ?? 0;
}

/**
 * Effective faithfulness verdict using the trust stage's own normalization
 * (`skipped_no_span` reads as "unchecked"); undefined = gate never ran.
 */
function effectiveFaithfulness(
  verdict: FaithfulnessFrontmatter["verdict"] | undefined,
): FaithfulnessFrontmatter["verdict"] | undefined {
  if (verdict === undefined) return undefined;
  return verdict === "skipped_no_span" ? "unchecked" : verdict;
}

export function createPathMergeParity(input: {
  /** Cold-aware committed snapshot of the merge target (never a lookup hit). */
  target: MemoryFile;
  incoming: ApplySemanticMergeOptions["incomingMetadata"];
  /** The incoming fact's connector scope (finding D). */
  sourceConnector?: string;
  untrustedOrigins: readonly string[];
}): CreatePathMergeParity {
  const { target, untrustedOrigins } = input;
  const md = input.incoming;
  if (md?.structuredAttributes && Object.keys(md.structuredAttributes).length > 0) {
    return { ok: false, field: "structuredAttributes" };
  }
  if (md?.biTemporal === true) return { ok: false, field: "biTemporal" };
  if (md?.entityRef !== undefined && md.entityRef !== target.frontmatter.entityRef) {
    return { ok: false, field: "entityRef" };
  }
  if (md?.validAt !== undefined && md.validAt !== target.frontmatter.valid_at) {
    return { ok: false, field: "validAt" };
  }
  if (target.frontmatter.invalid_at !== undefined) {
    return { ok: false, field: "validity_bounds" };
  }
  if (target.frontmatter.valid_at !== undefined && md?.validAt === undefined) {
    return { ok: false, field: "validity_bounds" };
  }
  const targetTags = new Set(target.frontmatter.tags ?? []);
  if ((md?.tags ?? []).some((tag) => !targetTags.has(tag))) {
    return { ok: false, field: "tags" };
  }
  if (
    md?.importanceScore !== undefined &&
    md.importanceScore > (target.frontmatter.importance?.score ?? 0)
  ) {
    return { ok: false, field: "importance" };
  }

  const incomingProvenanceRank = provenanceRank(md?.provenanceStrength);
  const targetProvenanceRank = provenanceRank(target.frontmatter.provenance);
  if (incomingProvenanceRank > targetProvenanceRank) {
    return { ok: false, field: "provenance" };
  }
  const provenanceFloor =
    incomingProvenanceRank < targetProvenanceRank
      ? ((md?.provenanceStrength ?? "none") as "verified" | "unverified" | "none")
      : undefined;

  if (md?.confidence !== undefined) {
    if (
      typeof md.confidence !== "number" ||
      !Number.isFinite(md.confidence) ||
      md.confidence < 0 ||
      md.confidence > 1
    ) {
      return { ok: false, field: "confidence" };
    }
  }
  const confidenceFloor =
    md?.confidence !== undefined && md.confidence < (target.frontmatter.confidence ?? 0.8)
      ? md.confidence
      : undefined;

  if (
    normalizeConnectorScope(target.frontmatter.sourceConnector) !==
    normalizeConnectorScope(input.sourceConnector)
  ) {
    return { ok: false, field: "sourceConnector" };
  }

  if (md?.toolScoped === true && target.frontmatter.toolScoped !== true) {
    return { ok: false, field: "toolScoped" };
  }
  if ((md?.subject ?? "user") !== (target.frontmatter.subject ?? "user")) {
    return { ok: false, field: "subject" };
  }
  if (md?.memoryKind !== undefined && md.memoryKind !== target.frontmatter.memoryKind) {
    return { ok: false, field: "memoryKind" };
  }
  if (
    isUntrustedOrigin(parseOriginClass(md?.origin), untrustedOrigins) &&
    !isUntrustedOrigin(parseOriginClass(target.frontmatter.origin), untrustedOrigins)
  ) {
    return { ok: false, field: "origin" };
  }
  const incomingFaithfulness = effectiveFaithfulness(md?.faithfulness?.verdict);
  const targetFaithfulness = effectiveFaithfulness(target.frontmatter.faithfulness?.verdict);
  if (incomingFaithfulness !== targetFaithfulness) {
    return { ok: false, field: "faithfulness" };
  }
  if (targetFaithfulness === "entailed") {
    return { ok: false, field: "faithfulness" };
  }
  return {
    ok: true,
    ...(provenanceFloor !== undefined ? { provenanceFloor } : {}),
    ...(confidenceFloor !== undefined ? { confidenceFloor } : {}),
  };
}

function versioningConfigFrom(deps: ExtractionPersistDeps): VersioningConfig {
  return {
    enabled: resolveRecallAuxiliaryCapabilities(deps.config).versioning,
    maxVersionsPerPage: deps.config.versioningMaxPerPage,
    sidecarDir: deps.config.versioningSidecarDir,
  };
}

export function mergeMemoryLinks(
  existing: readonly MemoryLink[] | undefined,
  incoming: readonly MemoryLink[] | undefined,
  survivingTargetId: string,
): MemoryLink[] | undefined {
  if (!incoming || incoming.length === 0) return undefined;
  const merged = [...(existing ?? [])];
  for (const link of incoming) {
    if (link.targetId === survivingTargetId) continue;
    if (!merged.some((l) => l.targetId === link.targetId && l.linkType === link.linkType)) {
      merged.push({ ...link });
    }
  }
  return merged.length > 0 ? merged : undefined;
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
        `semantic-merge[shadow]: would create category=${options.category} length=${options.content.length} reason="${decision.reason}"`,
      );
    }
    return { action: "created", reason: decision.reason };
  }

  if (config.shadowMode) {
    log.info(
      `semantic-merge[shadow]: would merge into ${decision.targetId} reason="judge_merge"`,
    );
    return { action: "created", reason: "shadow_would_merge" };
  }

  const target = await options.storage.getMemoryByIdIncludingArchived(decision.targetId);
  if (!target || inferMemoryStatus(target.frontmatter, target.path) !== "active") {
    return { action: "created", reason: "target_inactive" };
  }
  if (target.content !== decision.targetContent) {
    return { action: "created", reason: "target_changed" };
  }
  const nowIso = (options.now ? options.now() : new Date()).toISOString();
  const committedContent = committedMergedBody(
    deps,
    decision.mergedContent,
    options.incomingCitedContent,
    options.incomingCitationContext,
    nowIso,
  );

  const parity = createPathMergeParity({
    target,
    incoming: options.incomingMetadata,
    sourceConnector: options.sourceConnector,
    untrustedOrigins: deps.config.untrustedOrigins,
  });
  if (!parity.ok) {
    return { action: "created", reason: "metadata_unpreservable" };
  }

  if (
    options.targetHasPromotedCopies &&
    (await options.targetHasPromotedCopies(decision.targetId))
  ) {
    return { action: "created", reason: "promoted_copy_present" };
  }
  const versioning = versioningConfigFrom(deps);
  if (!versioning.enabled) {
    return { action: "created", reason: "snapshot_unavailable" };
  }
  let versionId: string;
  try {
    versionId = await stageMergedTargetSnapshot(target, versioning, options.storage.dir);
  } catch (err) {
    log.warn(
      `semantic-merge: snapshot failed for ${decision.targetId}; creating new fact instead: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { action: "created", reason: "snapshot_failed" };
  }

  const repairIndexes = async (committedFactHash?: string): Promise<void> => {
    try {
      await options.storage.removeFactContentHashesForMemories([target]);
      if (committedFactHash !== undefined) {
        await options.storage.registerFactContentHash(decision.targetId, committedFactHash, committedContent);
        await persistRepairedContentHash(
          options.storage,
          decision.targetId,
          committedContent,
          committedFactHash,
        );
      } else {
        await options.storage.restoreFactHashAfterApproval(decision.targetId);
      }
    } catch (err) {
      log.warn(
        `semantic-merge: hash-index sync failed for ${decision.targetId} (non-fatal; index rebuilds from corpus): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      await deps.indexPersistedMemory(options.storage, decision.targetId);
    } catch (err) {
      log.warn(
        `semantic-merge: reindex failed for ${decision.targetId} (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  let casRevision: string | undefined; // #2813 (P1): OUR content CAS's receipt — feeds the patch stamp below and the catch's rollback comparison
  let mergePatch: MergeFrontmatterUpdate | undefined;
  try {
    mergePatch = buildMergeFrontmatterUpdate({
      targetSources: (target.frontmatter.sources ?? []) as MergeProvenanceSource[],
      incomingSources: (options.sources ?? []) as MergeProvenanceSource[],
      targetReinforcementCount: target.frontmatter.reinforcement_count,
      nowIso,
    });
    const updated = await options.storage.updateMemoryIfUnchanged(target, committedContent, {
      actor: "semantic-merge",
    });
    if (!updated) {
      await discardMergedTargetSnapshot(
        target.path,
        versioning,
        options.storage.dir,
        decision.targetId,
        versionId,
      );
      return { action: "created", reason: "target_changed" };
    }
    casRevision = updated; // fix A: a successful CAS returns the revision it landed; a later rollback compares against it
    const merged = await readTargetSnapshot(options.storage, target);
    if (!merged || merged.content !== committedContent) {
      throw new Error("target replaced before the provenance patch");
    }
    const mergedRawBody = rawPreCitationMergedBody(deps, committedContent);
    const mergedIntent = resolveConversationContextCapabilities(deps.config).intentRouting
      ? inferIntentFromText(
          `${merged.frontmatter.category} ${(merged.frontmatter.tags ?? []).join(" ")} ${mergedRawBody}`,
        )
      : undefined;
    const mergedFactHash =
      options.category === "fact"
        ? ContentHashIndex.computeHash(sanitizeMemoryContent(mergedRawBody).text)
        : undefined;
    const mergedLinks = mergeMemoryLinks(
      merged.frontmatter.links,
      options.incomingLinks,
      decision.targetId,
    );
    const patched = await options.storage.writeMemoryFrontmatterIfUnchanged(
      merged,
      {
        updated: mergePatch.updated,
        derived_via: mergePatch.derived_via,
        reinforcement_count: mergePatch.reinforcement_count,
        sources: mergePatch.sources,
        ...(mergedFactHash !== undefined ? { contentHash: mergedFactHash } : {}),
        ...(parity.ok && parity.provenanceFloor !== undefined
          ? { provenance: parity.provenanceFloor }
          : {}),
        ...(parity.ok && parity.confidenceFloor !== undefined
          ? {
              confidence: parity.confidenceFloor,
              confidenceTier: confidenceTier(parity.confidenceFloor),
            }
          : {}),
        ...(mergedLinks !== undefined ? { links: mergedLinks } : {}),
        ...(mergedIntent !== undefined
          ? {
              intentGoal: mergedIntent.goal,
              intentActionType: mergedIntent.actionType,
              intentEntityTypes: mergedIntent.entityTypes,
            }
          : {}),
      },
      { actor: "semantic-merge" },
    );
    if (!patched) throw new Error("frontmatter patch rejected (target changed)");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const committedRevision = casCommittedRevisionOf(err) ?? casRevision; // fix A: patch-path failures carry no error receipt — fall back to the success receipt
    const landed = committedRevision !== undefined;
    if (!landed) {
      let observed: MemoryFile | null = null;
      try {
        observed = await readTargetSnapshot(options.storage, target);
      } catch {
        /* unreadable → keep-side below */
      }
      if (observed?.content === committedContent) {
        await discardMergedTargetSnapshot(
          target.path,
          versioning,
          options.storage.dir,
          decision.targetId,
          versionId,
        );
        await repairIndexes(committedMergedFactHash(deps, options.category, committedContent));
        log.warn(
          `semantic-merge: update failed for ${decision.targetId} (the compare-and-swap threw before this writer's mutation; the standing merged body is another writer's identical commit — snapshot ${versionId} discarded, the concurrent commit left untouched): ${detail}`,
        );
        return {
          action: "merged",
          targetId: decision.targetId,
          mergedContent: committedContent,
          provenancePatched: false,
        };
      } else if (observed?.content === target.content) {
        await discardMergedTargetSnapshot(
          target.path,
          versioning,
          options.storage.dir,
          decision.targetId,
          versionId,
        );
        log.warn(
          `semantic-merge: update failed for ${decision.targetId} (the compare-and-swap threw before changing the target; snapshot ${versionId} discarded — the reread holds the pre-merge body): ${detail}`,
        );
        return { action: "created", reason: "update_failed" };
      }
    }
    const revert = landed
      ? await revertMergedContent(options.storage, target, committedContent, committedRevision)
      : undefined;
    if (revert === "superseded") {
      await discardMergedTargetSnapshot(
        target.path,
        versioning,
        options.storage.dir,
        decision.targetId,
        versionId,
      );
      await repairIndexes(committedMergedFactHash(deps, options.category, committedContent));
      log.warn(
        `semantic-merge: update failed for ${decision.targetId} (the standing merged body advanced past this writer's commit receipt — another writer's identical commit stands; snapshot ${versionId} discarded, the concurrent commit left untouched): ${detail}`,
      );
      return {
        action: "merged",
        targetId: decision.targetId,
        mergedContent: committedContent,
        provenancePatched: false,
      };
    }
    if (landed && revert !== "reverted") {
      log.error(
        `semantic-merge: ${decision.targetId} holds merged content without provenance metadata and the rollback failed (${detail}); snapshot ${versionId} holds the pre-merge state — recover with revertToVersion. Not creating a duplicate fact.`,
      );
      await finalizeMergedVersionPrune(target.path, versioning, options.storage.dir, decision.targetId, versionId);
      await repairIndexes(committedMergedFactHash(deps, options.category, committedContent));
      return {
        action: "merged",
        targetId: decision.targetId,
        mergedContent: committedContent,
        provenancePatched: false,
      };
    }
    if (landed) {
      await discardMergedTargetSnapshot(
        target.path,
        versioning,
        options.storage.dir,
        decision.targetId,
        versionId,
      );
    }
    log.warn(
      `semantic-merge: update failed for ${decision.targetId}${landed ? ` (content rolled back; snapshot ${versionId} rolled back out of history)` : ` (snapshot ${versionId} staged)`}: ${detail}`,
    );
    return { action: "created", reason: "update_failed" };
  }
  await finalizeMergedVersionPrune(target.path, versioning, options.storage.dir, decision.targetId, versionId);

  await repairIndexes();

  log.info(
    `semantic-merge: merged fact into ${decision.targetId} (version ${versionId})`,
  );
  return {
    action: "merged",
    targetId: decision.targetId,
    mergedContent: committedContent,
    provenancePatched: true,
  };
}

export async function writeMergedVerbatimArtifact(
  deps: ExtractionPersistDeps,
  storage: StorageManager,
  targetId: string,
  input: {
    category: string;
    /** Incoming fact body, cited exactly once for this write by the caller. */
    citedContent: string;
    confidence: number;
    tags: readonly string[];
    intent?: { goal?: string; actionType?: string; entityTypes?: string[] };
    sourceConnector?: string;
    origin?: string;
    toolScoped?: boolean;
  },
): Promise<void> {
  if (!resolvePresentationCapabilities(deps.config).verbatimArtifacts) return;
  if (!deps.config.verbatimArtifactCategories.includes(input.category as MemoryCategory)) {
    return;
  }
  if (!(input.confidence >= deps.config.verbatimArtifactsMinConfidence)) return;
  try {
    await storage.writeArtifact(input.citedContent, {
      confidence: input.confidence,
      tags: [...input.tags, "artifact"],
      artifactType: deps.artifactTypeForCategory(input.category),
      sourceMemoryId: targetId,
      intentGoal: input.intent?.goal,
      intentActionType: input.intent?.actionType,
      intentEntityTypes: input.intent?.entityTypes,
      ...(input.sourceConnector ? { sourceConnector: input.sourceConnector } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.toolScoped ? { toolScoped: true as const } : {}),
    });
  } catch (err) {
    log.warn(
      `semantic-merge: verbatim artifact write failed for ${targetId} (non-fatal; the committed target remains discoverable): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function runMergedTargetPostEffects(
  deps: ExtractionPersistDeps,
  storage: StorageManager,
  merge: { targetId: string; mergedContent: string },
  input: {
    /** Written category (parity-guaranteed equal to the committed record's). */
    category: MemoryCategory;
    incomingContent: string;
    incomingConfidence: number;
    namespace: string;
    graphCaps: GraphConstructionCapabilitySet;
    graphContext: {
      allMemsForGraph: MemoryFile[] | null;
      memoryPathById: Map<string, string>;
      previousPersistedRelPath?: string;
    };
    threadIdForEdge: string | undefined;
    threadEpisodeIdsForGraph: string[] | undefined;
  },
): Promise<BehaviorSignalEvent[]> {
  const signals = buildBehaviorSignalsForMemory({
    memoryId: merge.targetId,
    category: input.category,
    content: input.incomingContent,
    namespace: input.namespace,
    confidence: input.incomingConfidence,
    source: "extraction",
  });
  if (input.threadEpisodeIdsForGraph) {
    const episodes = input.threadEpisodeIdsForGraph;
    const existing = episodes.lastIndexOf(merge.targetId);
    if (existing !== -1) episodes.splice(existing, 1);
    episodes.push(merge.targetId);
  }
  if (!input.graphCaps.multiGraphMemory) return signals;
  let rewriteInstalled = false;
  try {
    const committed = await storage.getMemoryByIdIncludingArchived(merge.targetId);
    if (!committed || committed.content !== merge.mergedContent) return signals;
    if (inferMemoryStatus(committed.frontmatter, committed.path) !== "active") return signals;
    const entityRef = committed.frontmatter.entityRef;
    const rawBody = rawPreCitationMergedBody(deps, merge.mergedContent);
    const memoryRelPath = path.relative(storage.dir, committed.path);
    input.graphContext.memoryPathById.set(merge.targetId, memoryRelPath);
    const all = input.graphContext.allMemsForGraph;
    if (Array.isArray(all)) {
      const entry = all.find((m) => path.relative(storage.dir, m.path) === memoryRelPath);
      if (entry) entry.content = rawBody;
    }
    const rewriteTypes: GraphType[] = [];
    if (input.graphCaps.entityGraph) rewriteTypes.push("entity");
    if (input.graphCaps.timeGraph) rewriteTypes.push("time");
    if (input.graphCaps.causalGraph) rewriteTypes.push("causal");
    const receiptStatus = await storage.readCasRevisionStatus(committed.path);
    if (receiptStatus.status === "unavailable") {
      log.warn(
        `runMergedTargetPostEffects: CAS revision status for ${committed.path} is unavailable (${receiptStatus.reason}); skipping the graph rewrite — the next merge retries it (#2837)`,
      );
      return signals;
    }
    rewriteInstalled = await rewriteMergedTargetGraphEdges(storage, {
      targetId: merge.targetId,
      memoryRelPath,
      mergedContent: merge.mergedContent,
      revisionChecked: receiptStatus.status === "present" ? receiptStatus.revision : undefined,
      rewriteTypes,
      build: () =>
        deps.buildGraphEdge(
          storage,
          memoryRelPath,
          entityRef,
          merge.targetId,
          rawBody,
          all,
          input.graphContext.memoryPathById,
          input.threadIdForEdge,
          input.threadEpisodeIdsForGraph,
          input.graphContext.previousPersistedRelPath,
          input.graphCaps,
        ),
    });
    if (rewriteInstalled) input.graphContext.previousPersistedRelPath = memoryRelPath;
  } catch {
    /* fail-open: the committed merge stands; the create path's graph block fails open too */
  }
  if (!rewriteInstalled) {
    deps.invalidateGraphEdgeCache?.(storage);
  }
  return signals;
}
