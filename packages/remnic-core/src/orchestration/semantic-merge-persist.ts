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

import { isUntrustedOrigin, parseOriginClass } from "../security/origin-authority.js";
import {
  FallbackLlmClient,
  fallbackLlmRuntimeContextFromConfig,
} from "../fallback-llm.js";
import { log } from "../logger.js";
import { sanitizeMemoryContent } from "../sanitize.js";
import { ContentHashIndex } from "../storage/content-hash-index.js";
import { createVersion, type VersioningConfig } from "../page-versioning.js";
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
import {
  resolvePresentationCapabilities,
  resolveRecallAuxiliaryCapabilities,
} from "../capabilities.js";
import type {
  FaithfulnessFrontmatter,
  ImportanceScore,
  MemoryCategory,
  MemoryFile,
  MemoryFrontmatter,
  MemoryLink,
  MemorySubject,
  ProvenanceSource,
} from "../types.js";
import { normalizeConnectorScope } from "../dedup/connector-scope.js";
import type { StorageManager } from "../index.js";
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

/**
 * The merged-target promotion payload (final round): EVERY field the
 * shared/profile copy is stamped from, taken wholesale off the re-read
 * committed record — no field on the promotion path reads the incoming
 * extraction. `origin` is normalized through `parseOriginClass` so an
 * unstamped legacy target promotes as `unknown`, the fence's
 * least-privilege default, and never falls back to the extraction's own
 * origin. Absent optional fields stay absent: a target without temporal
 * bounds or attributes promotes a copy without them. The record's
 * confidence is the downgraded min(incoming, target) value the merge
 * patch stamped (final round A), so the copy stamps that same value. The
 * tool-scope marker and owning connector ride along (finding A) so the
 * promotion's withhold gate evaluates the record's committed scope, not a
 * fresh content-heuristic guess over the merged body.
 */
export interface MergedTargetPromotionPayload {
  category: string;
  content: string;
  confidence: number;
  tags: string[];
  entityRef?: string;
  structuredAttributes?: Record<string, string>;
  sourceMemoryId: string;
  importance?: ImportanceScore;
  intentGoal?: string;
  intentActionType?: string;
  intentEntityTypes?: string[];
  memoryKind?: MemoryFrontmatter["memoryKind"];
  validAt?: string;
  invalidAt?: string;
  observedAt?: string;
  eventTimeSource?: "extracted" | "assumed";
  /** Normalized committed origin; never undefined, so the envelope's extraction fallback cannot fire. */
  origin: string;
  sources?: ProvenanceSource[];
  provenance?: "verified" | "unverified" | "none";
  subject?: MemorySubject;
  /** The committed target's own write provenance label. */
  source: string;
  /** Committed tool-scope marker + owning connector (finding A): the copy must
   * stay withheld from the shared namespace exactly like the record it copies.
   * Re-running the content heuristics over the merged body is not equivalent —
   * the judge-composed text can drop the tool references that earned the
   * target its marker at write time, and without the connector the heuristic
   * returns false outright. */
  toolScoped?: true;
  sourceConnector?: string;
}

/**
 * Re-read the committed merge target (cold-aware id lookup — the same
 * resolver the merge itself used) and derive the promotion payload solely
 * from that record. Returns null when the record can no longer ground the
 * promotion (deleted, its body was replaced after the merge committed, or a
 * concurrent lifecycle operation archived/superseded it between the merge
 * commit and this reread — promoting from a retired record would resurrect
 * content that operation retired, final round B); callers then skip the
 * promotion fail-open — the merge itself stands.
 */
export async function buildMergedTargetPromotionPayload(
  storage: StorageManager,
  merge: { targetId: string; mergedContent: string },
): Promise<MergedTargetPromotionPayload | null> {
  const committed = await storage.getMemoryByIdIncludingArchived(merge.targetId);
  if (!committed || committed.content !== merge.mergedContent) return null;
  // Final round (B): the including-archived lookup still returns a retired
  // record, and body equality alone cannot tell a concurrent archive or
  // supersede apart from a live target. Recompute the status from the
  // committed record itself and refuse to promote unless it is still
  // active.
  if (inferMemoryStatus(committed.frontmatter, committed.path) !== "active") {
    return null;
  }
  const fm = committed.frontmatter;
  return {
    category: fm.category,
    content: committed.content,
    confidence: fm.confidence,
    tags: fm.tags ?? [],
    sourceMemoryId: fm.id,
    origin: parseOriginClass(fm.origin),
    source: fm.source,
    ...(fm.entityRef !== undefined ? { entityRef: fm.entityRef } : {}),
    ...(fm.structuredAttributes !== undefined
      ? { structuredAttributes: { ...fm.structuredAttributes } }
      : {}),
    ...(fm.importance !== undefined ? { importance: fm.importance } : {}),
    ...(fm.intentGoal !== undefined ? { intentGoal: fm.intentGoal } : {}),
    ...(fm.intentActionType !== undefined ? { intentActionType: fm.intentActionType } : {}),
    ...(fm.intentEntityTypes !== undefined
      ? { intentEntityTypes: [...fm.intentEntityTypes] }
      : {}),
    ...(fm.memoryKind !== undefined ? { memoryKind: fm.memoryKind } : {}),
    ...(fm.valid_at !== undefined ? { validAt: fm.valid_at } : {}),
    ...(fm.invalid_at !== undefined ? { invalidAt: fm.invalid_at } : {}),
    ...(fm.observedAt !== undefined ? { observedAt: fm.observedAt } : {}),
    ...(fm.eventTimeSource !== undefined ? { eventTimeSource: fm.eventTimeSource } : {}),
    ...(fm.sources && fm.sources.length > 0
      ? { sources: fm.sources.map((source) => ({ ...source })) }
      : {}),
    ...(fm.provenance !== undefined ? { provenance: fm.provenance } : {}),
    ...(fm.subject !== undefined ? { subject: fm.subject } : {}),
    ...(fm.toolScoped === true ? { toolScoped: true as const } : {}),
    ...(fm.sourceConnector !== undefined ? { sourceConnector: fm.sourceConnector } : {}),
  };
}

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
 *    candidate resolution), entityRef, validAt, subject (effective),
 *    sourceConnector (against the COLD-AWARE target snapshot, finding D),
 *    faithfulness verdict (effective, finding C).
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
  // merge patch cannot compose an honest verdict for a combined body, so a
  // defined incoming verdict must equal the target's effective one —
  // otherwise the create path runs and persists the verdict it computed.
  // An undefined incoming verdict (gate off) leaves the target's own
  // verdict describing the target's own claims, exactly as a create would.
  const incomingFaithfulness = effectiveFaithfulness(md?.faithfulness?.verdict);
  if (
    incomingFaithfulness !== undefined &&
    incomingFaithfulness !== effectiveFaithfulness(target.frontmatter.faithfulness?.verdict)
  ) {
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

/**
 * Finding B — union the incoming fact's suggested navigation links into the
 * target's committed links, deduping on (targetId, linkType): the same key
 * `StorageManager.addLinksToMemory` uses. Returns undefined when there is
 * nothing to attach so the patch carries no `links` key at all (an empty
 * array would ERASE committed links).
 */
export function mergeMemoryLinks(
  existing: readonly MemoryLink[] | undefined,
  incoming: readonly MemoryLink[] | undefined,
): MemoryLink[] | undefined {
  if (!incoming || incoming.length === 0) return undefined;
  const merged = [...(existing ?? [])];
  for (const link of incoming) {
    if (!merged.some((l) => l.targetId === link.targetId && l.linkType === link.linkType)) {
      merged.push({ ...link });
    }
  }
  return merged;
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

  // Steps 4+5 as a closure: the degraded success below (merged body committed,
  // provenance patch failed, rollback failed) still needs the post-commit
  // index repair, or QMD serves the old text and the fact-hash index holds a
  // stale identity until restart or unrelated maintenance (item C).
  const repairIndexes = async (): Promise<void> => {
    // Hash index: remove the old form, add the new form, in the same
    // corpus-registered identity the write path uses. Both helpers are
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
    // Item B — `updateMemoryIfUnchanged` keeps the target's old
    // `frontmatter.contentHash`, so the patch must restamp the identity the
    // write path would register: the hash of the SAME canonical form normal
    // persistence hashes (sanitized raw pre-citation content), never a cited
    // variant. Facts only, mirroring `contentHashSource` on the write path.
    const mergedFactHash =
      options.category === "fact"
        ? ContentHashIndex.computeHash(sanitizeMemoryContent(decision.mergedContent).text)
        : undefined;
    // Finding B — the incoming fact's suggested navigation links attach to
    // the target here, in the same conditional patch (the fact is never
    // created on this path, so the create path's `links` carrier cannot run).
    const mergedLinks = mergeMemoryLinks(merged.frontmatter.links, options.incomingLinks);
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
      // Item C — the merged body IS committed; repair the indexes before
      // reporting the degraded success.
      await repairIndexes();
      return {
        action: "merged",
        targetId: decision.targetId,
        mergedContent: decision.mergedContent,
        provenancePatched: false,
      };
    }
    log.warn(
      `semantic-merge: update failed for ${decision.targetId}${contentCommitted ? " (content rolled back)" : ""} (snapshot ${versionId} holds the pre-merge state): ${detail}`,
    );
    return { action: "created", reason: "update_failed" };
  }

  // Steps 4+5 — hash-index resync and reindex (see repairIndexes above).
  await repairIndexes();

  log.info(
    `semantic-merge: merged fact into ${decision.targetId} (version ${versionId})`,
  );
  return {
    action: "merged",
    targetId: decision.targetId,
    mergedContent: decision.mergedContent,
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
 * apply here. Failures propagate exactly like the write path's artifact
 * step: the durable write stands, the error surfaces to the caller.
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
}
