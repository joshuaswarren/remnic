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
  hasCitationForTemplate,
  lastCitationMarkerForTemplate,
  stripCitationForTemplate,
} from "../source-attribution.js";
import {
  resolveConversationContextCapabilities,
  resolvePipelineProcessingCapabilities,
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
   * Finding C: async probe run after a merge verdict but before any
   * mutation. True when the would-be target already has promoted
   * shared/profile copies the merge cannot reconcile — the fact is created
   * through the normal write (whose promotion step owns those copies)
   * instead of merged.
   */
  targetHasPromotedCopies?: (targetId: string) => Promise<boolean>;
  /** Caller-side bypass: contradiction detected or pending_review routing. */
  skip?: boolean;
  /** Injection seam for tests. */
  now?: () => Date;
  judgeCall?: (options: MergeJudgeCallOptions) => Promise<MergeJudgeRawVerdict | null>;
}

const PROVENANCE_STRENGTH_RANK: Record<string, number> = {
  none: 0,
  unverified: 1,
  verified: 2,
};

/**
 * Create-path parity gate (final round, PR #2771). Nine review rounds all
 * found the same defect class: the merge path did less, or something wider,
 * than the create path. Instead of patching call sites, this ONE gate
 * enumerates every trust/scope/verdict field the create path's write stamps
 * (`writeSealedMemory` + extras in `extraction-persist.ts`) and decides,
 * per field, whether the merge preserves it. A merge proceeds only when
 * EVERY field is carried by the merge patch, preserved monotonically, or
 * provably equal. Anything else — including anything unknown or unreadable —
 * bypasses to a create, because a create is always safe and a merge is not.
 *
 * Field classification, from the create-path write:
 *  - carried by the merge patch: content (judge-composed merged body),
 *    sources (appended by buildMergeFrontmatterUpdate), contentHash
 *    (restamped off the canonical merged form), status (a merge-eligible
 *    fact is never pending_review — the caller skips — and the target is
 *    re-verified active), provenance (only when downgraded to the
 *    least-trusted side, see below).
 *  - equality-required (bypass on mismatch): category (also enforced at
 *    candidate resolution), entityRef, effective validity bounds — both
 *    sides unbounded, or an incoming validAt identical to the target's
 *    valid_at; a target carrying invalid_at never merges (round N+2 A) —
 *    subject (effective), memoryKind when the incoming fact carries a
 *    computed kind (round N+2 B), sourceConnector (against the COLD-AWARE
 *    target snapshot, finding D), faithfulness verdict (effective, finding C).
 *  - monotone-preservable (bypass when the incoming side exceeds what the
 *    target retains): tags (target must be a superset), importance score
 *    (incoming may not exceed), confidence score (incoming may not exceed;
 *    a lower incoming DOWNGRADES the record to min(incoming, target) with
 *    the tier that score maps to — final round A), provenance strength
 *    (incoming may not be stronger — and a weaker incoming downgrades the
 *    target so the merged body never carries trust its new claims did not
 *    earn, finding B).
 *  - bypass-on-presence (no carrier exists at all): structuredAttributes,
 *    bi-temporal bounds.
 *  - escalation-refused: origin (an untrusted incoming origin may never
 *    merge into a trusted target; equal or fence-safe mismatches may).
 *  - scope-widening-refused: toolScoped (an unscoped target may never gain
 *    tool-scoped claims; a scoped target keeps its stricter flag).
 */
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
  // Round N+2 (A) — effective validity bounds. The merged body inherits the
  // TARGET's valid_at/invalid_at (the patch has no carrier for either), and
  // inferMemoryStatus ignores temporal validity, so a lifecycle-active
  // target with a past invalid_at takes the fresh claims out of normal
  // recall the moment they merge in (isValidityExpiredNow reads the bound).
  // Refuse instead: a target carrying invalid_at never merges (a non-
  // bi-temporal incoming fact cannot carry one — bi-temporal facts already
  // bypass above), and a target carrying valid_at merges only with an
  // incoming fact carrying the same bound via the equality check above.
  // Both-unbounded pairs keep merging.
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

  // Finding B — provenance must not be upgraded by merging. A stronger
  // incoming strength has no carrier (create stamps it on its own fact);
  // a weaker one must RETAG the combined body to the least-trusted value,
  // because `trust-score.ts` maps the memory-level tag straight to a
  // provenance contribution and unverified new claims must not inherit
  // `verified`'s maximum.
  const incomingProvenanceRank = provenanceRank(md?.provenanceStrength);
  const targetProvenanceRank = provenanceRank(target.frontmatter.provenance);
  if (incomingProvenanceRank > targetProvenanceRank) {
    return { ok: false, field: "provenance" };
  }
  const provenanceFloor =
    incomingProvenanceRank < targetProvenanceRank
      ? ((md?.provenanceStrength ?? "none") as "verified" | "unverified" | "none")
      : undefined;

  // Final round (A) — confidence must not be upgraded by merging either.
  // Lifecycle scoring, preference consolidation, and the merged-target
  // promotion all read the record's confidence, so a low-confidence
  // extraction merging into a higher-confidence target must DOWNGRADE the
  // record to min(incoming, target) — the value the create path would have
  // stored for the incoming fact alone. A value at or above the target's
  // needs no rewrite (the min IS the target's); an unreadable one bypasses
  // the merge rather than guessing a floor. A legacy target with no
  // confidence reads as the write path's 0.8 default (parseMemoryFrontmatter).
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

  // Finding D — connector scope from the COLD-AWARE target snapshot. The
  // lookup's hit enrichment reads `sourceConnector` hot-only
  // (persistence-index.ts), so a cold-tier (or read-failed) target looks
  // unscoped and an unscoped incoming fact slips past the lookup-side
  // comparison. The re-read target carries the authoritative frontmatter;
  // fail closed on any mismatch (both sides unscoped, or identical).
  if (
    normalizeConnectorScope(target.frontmatter.sourceConnector) !==
    normalizeConnectorScope(input.sourceConnector)
  ) {
    return { ok: false, field: "sourceConnector" };
  }

  if (md?.toolScoped === true && target.frontmatter.toolScoped !== true) {
    return { ok: false, field: "toolScoped" };
  }
  // Subject: the write path stamps `subject`, and the merge patch has no
  // carrier for it, so a fact whose EFFECTIVE subject differs from the
  // target's must be created. An absent subject resolves to the
  // least-privileged `user` — the same default the subject guard applies —
  // so classification being disabled never lets an unclassified fact merge
  // into an `agent`-labeled target.
  if ((md?.subject ?? "user") !== (target.frontmatter.subject ?? "user")) {
    return { ok: false, field: "subject" };
  }
  // Round N+2 (B) — memoryKind parity. See the field doc on
  // ApplySemanticMergeOptions.incomingMetadata.memoryKind.
  if (md?.memoryKind !== undefined && md.memoryKind !== target.frontmatter.memoryKind) {
    return { ok: false, field: "memoryKind" };
  }
  // Origin: the merged body renders under the TARGET's origin at recall, so
  // an UNTRUSTED incoming origin (per the deployment's untrustedOrigins)
  // merging into a TRUSTED target would hand injected text unfenced,
  // user-authority rendering — the escalation the recall fence exists to
  // prevent. That merge is refused; the fact is created through the write
  // that stamps its own origin. Mismatches that never reduce fencing still
  // merge, so legacy unstamped targets (`origin` absent → `unknown`, the
  // fence's least-privilege default) keep receiving user-origin facts.
  if (
    isUntrustedOrigin(parseOriginClass(md?.origin), untrustedOrigins) &&
    !isUntrustedOrigin(parseOriginClass(target.frontmatter.origin), untrustedOrigins)
  ) {
    return { ok: false, field: "origin" };
  }
  // Finding C — faithfulness verdicts must be preserved. The create path
  // stamps `faithfulnessFm` whenever the gate ran (shadow mode included: a
  // contradicted fact gets the verdict without pending_review status). The
  // merge patch cannot compose an honest verdict for a combined body, so the
  // effective verdicts must be EQUAL — both present and identical, or both
  // absent. One-sided verdicts (gate ran on one side only) bypass too: the
  // trust stage maps `entailed` to the maximum contribution, so claims the
  // gate never checked must not inherit an entailment rendered over the
  // other side's claims alone. The create path runs instead and persists
  // the verdict it computed (or none).
  const incomingFaithfulness = effectiveFaithfulness(md?.faithfulness?.verdict);
  const targetFaithfulness = effectiveFaithfulness(target.frontmatter.faithfulness?.verdict);
  if (incomingFaithfulness !== targetFaithfulness) {
    return { ok: false, field: "faithfulness" };
  }
  // Round N+9 (A): an EQUAL verdict cannot survive either — the target's
  // `entailed` was rendered over its pre-merge body, never the judge's
  // merged text, so bypass (entailment only; others under-claim / no signal).
  if (targetFaithfulness === "entailed") {
    return { ok: false, field: "faithfulness" };
  }
  return {
    ok: true,
    ...(provenanceFloor !== undefined ? { provenanceFloor } : {}),
    ...(confidenceFloor !== undefined ? { confidenceFloor } : {}),
  };
}

/**
 * Round N+7 (C): the committed merged body carries the incoming extraction's
 * citation marker (lifted from the caller's cited body for this write)
 * appended after the judge's merged text, so incoming claims stay attributed
 * even when the merged text embeds the target's older citation — quoted
 * excerpts travel without frontmatter, so `sources` alone is not enough.
 * Idempotent; a no-op when attribution is off or no marker exists.
 */
function committedMergedBody(
  deps: ExtractionPersistDeps,
  mergedContent: string,
  incomingCitedContent: string | undefined,
): string {
  if (
    resolvePipelineProcessingCapabilities(deps.config).inlineSourceAttribution !== true ||
    incomingCitedContent === undefined
  ) {
    return mergedContent;
  }
  const marker = lastCitationMarkerForTemplate(
    incomingCitedContent,
    deps.config.inlineSourceAttributionFormat,
  );
  if (!marker || mergedContent.endsWith(marker)) return mergedContent;
  return `${mergedContent} ${marker}`;
}

function versioningConfigFrom(deps: ExtractionPersistDeps): VersioningConfig {
  return {
    enabled: resolveRecallAuxiliaryCapabilities(deps.config).versioning,
    maxVersionsPerPage: deps.config.versioningMaxPerPage,
    sidecarDir: deps.config.versioningSidecarDir,
  };
}

/**
 * Finding B — union the incoming fact's suggested navigation links into the
 * target's committed links, deduping on (targetId, linkType): the same key
 * `StorageManager.addLinksToMemory` uses. A suggestion naming the surviving
 * target itself is DISCARDED — memory linking and the merge judge both
 * search on the incoming content, so the suggested neighbor is often the
 * merge target itself, and attaching it would make the record its own
 * neighbor (recall-navigate would return the current memory and burn
 * traversal budget). Returns undefined when there is nothing to attach so
 * the patch carries no `links` key at all (an empty array would ERASE
 * committed links).
 */
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
      // Telemetry only — category, length, reason. Never fact content: log
      // sinks generally have broader access and retention than the memory
      // store, and extracted facts can hold personal material.
      log.info(
        `semantic-merge[shadow]: would create category=${options.category} length=${options.content.length} reason="${decision.reason}"`,
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
  // Round N+7 (C): every mutation below commits THIS body — the judge's
  // merged text plus the incoming citation marker — and the outcome reports
  // it, so caller comparisons describe what storage actually holds.
  const committedContent = committedMergedBody(deps, decision.mergedContent, options.incomingCitedContent);

  // Create-path parity gate (final round) — ONE place enumerates every
  // trust/scope/verdict field the normal write stamps and bypasses the
  // merge unless each is carried, preserved, or provably equal. See
  // {@link createPathMergeParity} for the field classification.
  const parity = createPathMergeParity({
    target,
    incoming: options.incomingMetadata,
    sourceConnector: options.sourceConnector,
    untrustedOrigins: deps.config.untrustedOrigins,
  });
  if (!parity.ok) {
    return { action: "created", reason: "metadata_unpreservable" };
  }

  // Finding C — the create path's promotion step owns shared/profile copies
  // linked by `sourceMemoryId`; a merge mutates only this storage, so those
  // copies would keep serving the pre-merge body. When any promoted copy
  // exists, bypass the merge so the normal write (with its own promotion
  // reconciliation) runs instead. Probed before any mutation, so a bypass
  // leaves the target — and its page-version history — untouched.
  if (
    options.targetHasPromotedCopies &&
    (await options.targetHasPromotedCopies(decision.targetId))
  ) {
    return { action: "created", reason: "promoted_copy_present" };
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
    versionId = await stageMergedTargetSnapshot(target, versioning, options.storage.dir);
  } catch (err) {
    log.warn(
      `semantic-merge: snapshot failed for ${decision.targetId}; creating new fact instead: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { action: "created", reason: "snapshot_failed" };
  }

  // Round N+16 (C): `committedFactHash` — passed ONLY on the degraded path —
  // registers the hash of what storage actually HOLDS. The default reader
  // (`restoreFactHashAfterApproval` → `corpusRegisteredHashes`) prefers the
  // PERSISTED frontmatter `contentHash`, which the degraded record still
  // carries from BEFORE the merge, so routing the degraded repair through it
  // re-registered the stale pre-merge identity and left the merged body
  // unindexed for exact dedup.
  const repairIndexes = async (committedFactHash?: string): Promise<void> => {
    // Hash index: remove the old form, add the new form, in the same
    // corpus-registered identity the write path uses. Both helpers are
    // fact-category no-ops, mirroring `contentHashSource` on the write path.
    // The index rebuilds from the corpus on restart, so a failure here is
    // logged, not fatal.
    try {
      await options.storage.removeFactContentHashesForMemories([target]);
      if (committedFactHash !== undefined) {
        // Round N+20 (B): body-coupled — a writer that replaced the target
        // after this writer's content commit keeps its own record (and its
        // own hash); registering ours would be a phantom exact-dedup hit.
        await options.storage.registerFactContentHash(decision.targetId, committedFactHash, committedContent);
        // Round N+19 (B): also persist the repaired identity in the
        // frontmatter — the index registration is process-local state over
        // a persisted stale `contentHash`, and a restart's corpus rebuild
        // prefers the persisted value, which would discard this repair.
        // CAS-guarded and non-fatal: a concurrent writer that already
        // replaced the record keeps its own (correct) identity.
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
    // Reindex the merged target or its new content stays undiscoverable until
    // unrelated maintenance runs (checklist #31).
    try {
      await deps.indexPersistedMemory(options.storage, decision.targetId);
    } catch (err) {
      log.warn(
        `semantic-merge: reindex failed for ${decision.targetId} (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  // Step 3 — update in place, preserving the id, via compare-and-swap on the
  // snapshot just read: a writer landing between the read and the write must
  // win rather than be overwritten from a stale body. The active-target check
  // above makes a tombstone block structurally impossible here.
  const nowIso = (options.now ? options.now() : new Date()).toISOString();
  let contentCommitted = false;
  // Captured so the success return can describe the COMMITTED frontmatter
  // (the patch's appended sources) without widening the try's scope.
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
      // Round N+13 (B): the CAS lost the race, so no merge committed — roll
      // the staged snapshot back out or this failed attempt leaves a
      // duplicate history entry a later successful prune would trade real
      // rollback states for.
      await discardMergedTargetSnapshot(
        target.path,
        versioning,
        options.storage.dir,
        decision.targetId,
        versionId,
      );
      return { action: "created", reason: "target_changed" };
    }
    contentCommitted = true;
    // The provenance patch must land on OUR merged body. An id-keyed patch
    // re-reads and stamps whatever the latest row holds, so a writer landing
    // after the content commit would receive this merge's provenance while
    // its own body stood — and the caller would still be told "merged".
    // Verify the snapshot, then patch it through the conditional API so the
    // window between the verify and the patch is closed by storage itself.
    const merged = await readTargetSnapshot(options.storage, target);
    if (!merged || merged.content !== committedContent) {
      throw new Error("target replaced before the provenance patch");
    }
    const mergedRawBody = rawPreCitationMergedBody(deps, committedContent);
    // Finding A (round N+3) — intent parity. With intent routing on, the
    // create path stamps intentGoal/intentActionType/intentEntityTypes from
    // the body it persists, and recall-search-pipeline scores intent
    // compatibility from exactly those fields; a merge that left the
    // target's stale values would misroute the newly merged claims. The
    // patch recomputes them with the SAME call the write path runs
    // (`${category} ${tags} ${content}`) over the committed record — its own
    // category and tags plus the canonical RAW pre-citation merged body — so
    // the committed values equal what an ordinary write of the same body
    // would persist. An empty entityTypes list clears a stale field, exactly
    // as serialization omits it on a fresh write.
    const mergedIntent = resolveConversationContextCapabilities(deps.config).intentRouting
      ? inferIntentFromText(
          `${merged.frontmatter.category} ${(merged.frontmatter.tags ?? []).join(" ")} ${mergedRawBody}`,
        )
      : undefined;
    // Item B — `updateMemoryIfUnchanged` keeps the target's old
    // `frontmatter.contentHash`, so the patch must restamp the identity the
    // write path would register: the hash of the SAME canonical form normal
    // persistence hashes — the sanitized RAW pre-citation body (round N+2 C).
    // Facts only, mirroring `contentHashSource` on the write path.
    const mergedFactHash =
      options.category === "fact"
        ? ContentHashIndex.computeHash(sanitizeMemoryContent(mergedRawBody).text)
        : undefined;
    // Finding B — the incoming fact's suggested navigation links attach to
    // the target here, in the same conditional patch (the fact is never
    // created on this path, so the create path's `links` carrier cannot run).
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
        // Finding B — a weaker incoming provenance retags the combined body
        // to the least-trusted value instead of letting unverified new
        // claims ride the target's stronger memory-level tag.
        ...(parity.ok && parity.provenanceFloor !== undefined
          ? { provenance: parity.provenanceFloor }
          : {}),
        // Final round (A) — min(incoming, target) confidence: the merged
        // record keeps the lower score, and the tier that score maps to,
        // so lifecycle scoring and the committed-record promotion payload
        // can never treat the combined body as higher-confidence than the
        // create path would have stored for the incoming fact alone.
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
    // A committed content update means the merged text may be IN the target.
    // Reporting `created` while it is would write the fact a second time and
    // leave those claims without the incoming provenance, so `created` is
    // reachable only once storage has been re-read and confirms the target no
    // longer holds this merge's unprovenanced body.
    //
    // #2807 (finding 2): the flag alone cannot distinguish a CAS that threw
    // BEFORE changing the target (lock acquisition, transient I/O) from one
    // that threw AFTER the write committed — and both left the staged
    // snapshot `pending` forever, which pruneExcessVersions deliberately
    // excludes, so repeated contention grew history past
    // maxVersionsPerPage with snapshots of bodies storage never (or no
    // longer) holds. Reread the target instead of trusting the flag.
    // #2813 (P1): ownership comes from the CAS's own commit identity —
    // storage stamps the thrown error with the revision its write landed
    // (markCasCommittedRevision) — NEVER from body equality: a concurrent
    // writer's identical deterministic merge is byte-for-byte this writer's
    // merged body, so content comparison would misattribute their commit,
    // and the revert below would CAS-replace their valid merge with the
    // pre-merge body while their patched provenance stood.
    //   - receipt present → OUR write landed (throw after commit) → revert,
    //     else degraded success — and the rollback verifies the standing
    //     record still carries the receipt's revision (#2813 P1, round 2);
    //     clean up OUR staged duplicate, leave theirs untouched, report the
    //     degraded merged outcome (never `created`: storage already holds
    //     these claims);
    //   - no receipt, pre-merge body → the write never landed → the snapshot
    //     is a duplicate and goes, `created` is honest;
    //   - no receipt, replaced by another writer or unreadable →
    //     unverifiable → keep-side, the snapshot stays.
    const committedRevision = casCommittedRevisionOf(err);
    let landed = contentCommitted || committedRevision !== undefined;
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
    // #2813 (P1, round 2): the receipt was used only as a boolean — never
    // compared with the standing record — so writer B's identical commit
    // after our lock released was reverted as ours. Equal revision → ours,
    // safe to roll back; advanced → B's — the same handling as the no-receipt
    // other-writer branch above; never revert theirs.
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
      // Item C — the merged body IS committed; repair the indexes before
      // reporting the degraded success. N+16 (C): the record's persisted
      // frontmatter hash is the stale PRE-merge identity, so register the
      // COMMITTED body's hash instead.
      // Round N+20 (C): degraded SUCCESS commits the recovery snapshot —
      // the body is committed and kept, so the staged version clears its
      // `pending` flag under the same page lock as a finalizing prune.
      // Without it pruneExcessVersions excluded every degraded recovery
      // point forever, so repeated degraded merges grew the manifest and
      // snapshot directory past maxVersionsPerPage and no later successful
      // merge could prune them back.
      await finalizeMergedVersionPrune(target.path, versioning, options.storage.dir, decision.targetId, versionId);
      await repairIndexes(committedMergedFactHash(deps, options.category, committedContent));
      return {
        action: "merged",
        targetId: decision.targetId,
        mergedContent: committedContent,
        provenancePatched: false,
      };
    }
    // Round N+13 (B): with the content committed and the revert above
    // confirmed, storage holds the pre-merge body, so the staged snapshot of
    // that same body is a duplicate and goes. (The degraded-success branch
    // above keeps it as the recovery point. An unverifiable throw — target
    // replaced or unreadable — is keep-side, the snapshot stays.)
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
  // Round N+12 (A): the prune finalizes only after BOTH compare-and-swaps
  // commit — full rationale on finalizeMergedVersionPrune. A degraded
  await finalizeMergedVersionPrune(target.path, versioning, options.storage.dir, decision.targetId, versionId);

  // Steps 4+5 — hash-index resync and reindex (see repairIndexes above).
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

/**
 * Finding B: for a qualifying write the create path stores the incoming
 * extraction's text as a verbatim artifact anchored to the memory it just
 * wrote. A merge that skipped that step would permanently drop the anchor
 * the same extraction would have stored, so a successful merge persists the
 * artifact against the MERGED target — same gates as the write path
 * (verbatim artifacts enabled, category qualifies, confidence at or above
 * the threshold). A merge target is always active and a pending_review fact
 * never reaches the merge, so the write path's post-write guards cannot
 * apply here. Round N+17 (B): this write is the merge path's LAST durable
 * effect (create-path ordering), and a rejection is isolated inside to a
 * logged warning — the committed target stays discoverable; failures never
 * abort the merge batch.
 */
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
    // Round N+17 (B): the caller runs this LAST, after every durable merge
    // effect — log and skip; the committed target stays discoverable.
    log.warn(
      `semantic-merge: verbatim artifact write failed for ${targetId} (non-fatal; the committed target remains discoverable): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Round N+5 (A+B) + N+6 (A/B/C): the create path's write is followed by
 * post-write stages that OBSERVE the persisted record — graph-edge
 * construction and the behavior-signal ledger. The merge path's `continue`
 * skipped both, so a judge-accepted merge committed new claims that
 * graph-mode recall and runtime-policy learning could never see. This helper
 * runs them for the SURVIVING target, derived from the re-read committed
 * record exactly like `buildMergedTargetPromotionPayload`: category,
 * entityRef, graph content, AND the relative graph path come from the
 * committed record, never the incoming extraction and never a hot-only
 * path-map fallback — the graph context is built from a hot-only corpus
 * scan, so a cold-tier target is absent from it and only `committed.path`
 * carries the true location (N+6 A). The graph content is the canonical RAW
 * pre-citation form — the same body the create path hands `buildGraphEdge`.
 * The target's prior generated edges are removed first in EVERY enabled
 * graph type — entity from-side, time/causal inbound — so a re-merge
 * REPLACES them instead of re-appending duplicates into append-only JSONLs
 * that spreadingActivation would then double-count (N+6 B, N+7 G); if the
 * replacement build fails, the rows the failed build already appended are
 * removed and the removed edges restored, so failure leaves EXACTLY the old
 * set (N+7 E, N+10 C). The target joins the
 * batch's thread episode list at its END — deduped first when already
 * present — so the merge is the thread's latest event and later facts in
 * the same extraction chain their time/causal adjacency through it (N+6 C,
 * N+7 F). Graph failures are fail-open (the committed merge stands,
 * matching the create path's try/catch); the caller owns the ledger flush,
 * so the behavior events are RETURNED for its storage.
 */
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
  // N+6 C + round N+7 (F): the normal write path pushes every freshly
  // persisted memory onto the thread episode list (extraction-persist.ts
  // post-write block); the merge must record the target as the thread's
  // LATEST event. A target already in the list (created in this thread
  // earlier, or pushed by a previous merge in this batch) must MOVE to the
  // end: leaving it at its old position makes the NEXT fact's
  // recent-in-thread resolution chain through an older episode instead of
  // the merge that just happened.
  if (input.threadEpisodeIdsForGraph) {
    const episodes = input.threadEpisodeIdsForGraph;
    const existing = episodes.lastIndexOf(merge.targetId);
    if (existing !== -1) episodes.splice(existing, 1);
    episodes.push(merge.targetId);
  }
  if (!input.graphCaps.multiGraphMemory) return signals;
  // #2807 (finding 4): whether the remove-and-rebuild below finalized. A
  // false or thrown exit means a ROLLBACK ran (or nothing mutated), and the
  // owning index's edge cache must be invalidated after the catch.
  let rewriteInstalled = false;
  try {
    const committed = await storage.getMemoryByIdIncludingArchived(merge.targetId);
    if (!committed || committed.content !== merge.mergedContent) return signals;
    if (inferMemoryStatus(committed.frontmatter, committed.path) !== "active") return signals;
    const entityRef = committed.frontmatter.entityRef;
    const rawBody = rawPreCitationMergedBody(deps, merge.mergedContent);
    // N+6 A: derive the relative path from the cold-aware committed record.
    // The graph context's path map was built from a HOT-only corpus scan, so
    // a cold-tier target is missing from it and the category-dir fallback
    // would fabricate a hot node path that graph recall cannot resolve.
    const memoryRelPath = path.relative(storage.dir, committed.path);
    input.graphContext.memoryPathById.set(merge.targetId, memoryRelPath);
    // The target predates this extraction, so a corpus-loaded context already
    // holds an entry for it — refresh that entry's body in place instead of
    // appending a duplicate the sibling scan would double-count.
    const all = input.graphContext.allMemsForGraph;
    if (Array.isArray(all)) {
      const entry = all.find((m) => path.relative(storage.dir, m.path) === memoryRelPath);
      if (entry) entry.content = rawBody;
    }
    // N+6 B + round N+7 (E/G) + round N+10 (C) + round N+12 (C): onMemoryWritten is
    // append-only, so a re-merge must first drop the target's prior
    // generated edges in EVERY enabled graph type — entity from-side,
    // time/causal inbound — or each later merge re-appends them and
    // spreadingActivation double-counts the duplicates while the JSONLs
    // The removed edges are captured; when the replacement build FAILS or is
    // superseded, the rows THAT build appended — returned by identity from
    // onMemoryWritten (round N+14), or carried on its rejection when it
    // throws mid-append (round N+16 A) — are removed first, never a
    // node-wide sweep, so rows a newer writer rebuilt after this removal
    // survive. The
    // prior edges are then RESTORED per graph type, skipped only where a
    // newer writer's rebuilt rows are live in the file — so failure leaves
    // EXACTLY the old set, and supersession leaves exactly the newer
    // writer's set: never none, never old plus partial-new.
    const rewriteTypes: GraphType[] = [];
    if (input.graphCaps.entityGraph) rewriteTypes.push("entity");
    if (input.graphCaps.timeGraph) rewriteTypes.push("time");
    if (input.graphCaps.causalGraph) rewriteTypes.push("causal");
    // Round N+12 (C): the remove-and-rebuild is revision-guarded end to end
    // (see rewriteMergedTargetGraphEdges) — a writer committing a newer body
    // mid-rebuild aborts this install instead of clobbering its edges.
    rewriteInstalled = await rewriteMergedTargetGraphEdges(storage, {
      targetId: merge.targetId,
      memoryRelPath,
      mergedContent: merge.mergedContent,
      revisionChecked: committed.frontmatter.updated,
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
    // #2807 (finding 4): the rewrite rolled back — superseded revision, a
    // failed build, or a pre-rewrite read error — after the build's
    // onMemoryWritten had already pushed this writer's appended rows into
    // the owning GraphIndex's warm edge cache. The rollback repaired only
    // the JSONL files; without invalidating the cache, spreadingActivation
    // kept serving the rolled-back edges for the full five-minute TTL.
    // Invalidation is idempotent and cheap when nothing was cached.
    deps.invalidateGraphEdgeCache?.(storage);
  }
  return signals;
}
