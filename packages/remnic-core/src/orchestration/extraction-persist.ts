import { classifyExtractionOrigin, type ExtractionSourceContext } from "./extraction-origin-context.js";
import { evaluateInjectionScreen, screenEntityForIndex, screenPersistStrings } from "./extraction-injection-gate.js";
/**
 * Extraction persistence coordinator (issue #1526, seam 16).
 *
 * It owns the extraction-to-memory write pipeline, including redaction,
 * judging, scope routing, deduplication, lifecycle updates, and indexing.
 */

import { isMemoryCategory } from "../write-envelope.js";
import {
  composeSalvagedExtractionEnvelope,
  probeSalvageSurvivingFields,
  withReservedMarkerTag,
} from "./extraction-envelope.js";
import { ContentHashIndex, normalizeAttributePairs, type StorageManager } from "../index.js";
import { log } from "../logger.js";
import { chunkContent, type ChunkingConfig } from "../chunking.js";
import { semanticChunkContent, type SemanticChunkResult } from "../semantic-chunking.js";
import { isAboveImportanceThreshold, scoreImportance } from "../importance.js";
import { sanitizeMemoryContent } from "../sanitize.js";
import {
  resolveCapabilities,
  resolveConsolidationCapabilities,
  resolveGraphConstructionCapabilities,
  resolveMemoryLifecycleCapabilities,
  resolvePipelineProcessingCapabilities,
  resolvePresentationCapabilities,
  resolveNamespaceCapabilities,
  resolveRecallEnhancementCapabilities,
  resolveRecallAuxiliaryCapabilities,
  resolveConversationContextCapabilities, resolveSecurityCapabilities, type GraphConstructionCapabilitySet,
  type MemoryLifecycleCapabilitySet,
} from "../capabilities.js";
import { coerceBool } from "../connectors/coerce.js";
import {
  applyTemporalSupersession,
  normalizeSupersessionKey,
} from "../temporal-supersession.js";
import { pickFactEventTimeAnchor, resolveFactEventTime } from "../event-time.js";
import {
  judgeFactDurability,
  getVerdictKind,
  validateProcedureExtraction,
  type JudgeVerdict,
  type JudgeCandidate,
} from "../extraction-judge.js";
import {
  EXTRACTION_JUDGE_VERDICT_CATEGORY,
  recordJudgeVerdict,
} from "../extraction-judge-telemetry.js";
import { recordJudgeTrainingPair } from "../extraction-judge-training.js";
import {
  applyFaithfulnessVerdict,
  runFaithfulnessGateBatch,
  type FaithfulnessGateCounters,
} from "../extraction-faithfulness.js";
import {
  contentMatchesRedactionRules,
  loadRedactionRules,
  type CompiledRedactionRule,
} from "../extraction-redaction-rules.js";
import {
  attachCitation,
  type CitationContext,
  hasCitationForTemplate,
  stripCitationForTemplate,
} from "../source-attribution.js";
import { classifyMemoryKind } from "../himem.js";
import { shouldPromoteGlobalFactToShared, withholdToolScopedFromSharedNamespace } from "../tool-scoped-memory.js";
import {
  buildBehaviorSignalsForMemory,
  dedupeBehaviorSignalsByMemoryAndHash,
} from "../behavior-signals.js";
import { buildProcedurePersistBody } from "../procedural/procedure-types.js";
import { stripAttributesSuffix } from "../structured-attributes.js";
import { resolveWriteSubject } from "../memory-subject.js";
import { LocalLlmClient } from "../local-llm.js";
import type { ExtractionEngine } from "../extraction.js";
import {
  FallbackLlmClient,
  fallbackLlmRuntimeContextFromConfig,
} from "../fallback-llm.js";
import { EmbeddingFallback } from "../embedding-fallback.js";
import { decideSemanticDedup, type SemanticDedupDecision, type SemanticDedupHit } from "../dedup/semantic.js";
import { applyNoveltyGate, embeddingsFromCosineHits } from "../dedup/novelty-gate.js";
import { selectRouteRule, type RouteRule, type RoutingEngineOptions } from "../routing/engine.js";
import { ThreadingManager } from "../threading.js";
import { NamespaceStorageRouter } from "../namespaces/storage.js";
import type { ResolvedScopeProfilePlan } from "../namespaces/scope-profiles.js";
import type { SearchBackend } from "../search/port.js";
import { inferIntentFromText } from "../intent.js";
import type {
  BehaviorSignalEvent,
  ExtractionResult,
  MemoryFile,
  MemoryFrontmatter,
  MemoryLink,
  MemorySubject,
  PluginConfig,
  ProvenanceSource,
  MemoryCategory,
} from "../types.js";
import {
  createBatchPromotedCopyProbe,
  flushDeferredFactHashOnFailure,
  makeSubjectGuardAllows,
  profileAutoPromotionAllows,
  readActiveMemoriesBothTiers,
  promotionWithholdsToolScope,
  promoteAndReconcileMergedTarget,
  shouldPromoteToShared,
} from "./extraction-persist-promotion.js";
import type { ExtractionPersistDeps } from "./extraction-persist-deps.js";
import type { DependencyPropagationDeliveryPort } from "./dependency-propagation-delivery.js";
import { isDependencyPropagationEnabled } from "./dependency-propagation.js";
import {
  buildMemoryPathById,
  appendMemoryToGraphContext,
  resolvePersistedMemoryRelativePath,
} from "../orchestrator.js";
import type { HarmonicConstructionInput } from "../harmonic-construction.js";
import { enqueueMergedTargetForHarmonicConstruction, persistConstructedHarmonicRecords } from "./harmonic-construction-persist.js";
import { applySemanticMergeAtPersist, runMergedTargetPostEffects, writeMergedVerbatimArtifact } from "./semantic-merge-persist.js";
import { buildMergedTargetPromotionPayload } from "./semantic-merge-promotion-payload.js";
import { persistMergedTargetThreadEpisode } from "./semantic-merge-commit-effects.js";
import { ExtractionAnchorSnapshot } from "./extraction-anchor-snapshot.js";

export class ExtractionPersistCoordinator {
  constructor(
    private readonly deps: ExtractionPersistDeps,
  ) {}
  private get config(): PluginConfig {
    return this.deps.config;
  }
  private get dependencyPropagationDelivery(): DependencyPropagationDeliveryPort | undefined {
    if (!isDependencyPropagationEnabled(this.config)) return undefined;
    return this.deps.getDependencyPropagationDelivery();
  }

  async persistExtraction(
    result: ExtractionResult,
    storage: StorageManager,
    threadIdForExtraction?: string | null,
    sourceContext?: ExtractionSourceContext,
    baseNamespace?: string,
    scopeProfileWritePlan?: ResolvedScopeProfilePlan | null,
    /** Verbatim source turn text the facts were extracted from (faithfulness gate #1576). */
    sourceText?: string,
    graphCaps: GraphConstructionCapabilitySet = resolveGraphConstructionCapabilities(this.deps.config),
    lifecycleCaps: MemoryLifecycleCapabilitySet = resolveMemoryLifecycleCapabilities(this.deps.config),
  ): Promise<{ persistedIds: string[]; memoryPathById: Map<string, string> }> {
    // Inline source attribution (issue #369). When enabled, every extracted
    // fact is rewritten to carry a compact provenance tag inside its body so
    // the citation survives hostile memory text, copy/paste, and LLM quoting.
    // The helper is a no-op when the feature flag is off, so legacy pipelines
    // see zero behavioral change.
    const citationEnabled = resolvePipelineProcessingCapabilities(this.deps.config).inlineSourceAttribution === true;
    const citationTemplate = this.deps.config.inlineSourceAttributionFormat;
    // #1909: the main-path fact writes defer their per-fact fact-hash-index flush
    // to the orchestrator's end-of-persist reconciling batch save ONLY when fact
    // deduplication is enabled (with it off, contentHashIndexForStorage() returns
    // null and the batch save is a no-op, so the write must save immediately).
    // Round 11: there is NO fact-hashes.ready marker anymore — the fact-hash
    // index is ALWAYS rebuilt from the corpus on restart (see
    // ensureFactHashIndexAuthoritative), so a deferred write, crash, or
    // multi-process interleave is safe by construction with no marker to guard.
    const factDedupEnabled = resolveRecallAuxiliaryCapabilities(this.deps.config).factDeduplication;
    const harmonicConstructionEnabled = resolveCapabilities(this.deps.config).harmonicRetrieval;
    const harmonicAnchorsEnabled =
      resolveConsolidationCapabilities(this.deps.config).abstractionAnchors;
    const harmonicBaseNamespace =
      baseNamespace ?? this.deps.storageDirNamespace(storage.dir);
    const harmonicFactsByStorage = new Map<
      string,
      {
        storage: StorageManager;
        facts: HarmonicConstructionInput["persistedFacts"];
      }
    >();
    const harmonicSourceInsertedAtBase = Date.now();
    let harmonicSourceOrder = 0;
    const promotedCopyProbe = createBatchPromotedCopyProbe(this.deps.config, this.deps.getStorageRouter, scopeProfileWritePlan); // #2330 finding F: one promoted-copy scan per namespace per batch

  // Canonicalize stored content for dedup comparison: strip citations
  // (using the same template), sanitize, then normalize whitespace.
  const normalizeStoredHashSource = (raw: string): string =>
    ContentHashIndex.normalizeContent(
      sanitizeMemoryContent(
        citationEnabled && hasCitationForTemplate(raw, citationTemplate)
          ? stripCitationForTemplate(raw, citationTemplate)
          : raw,
      ).text,
    );
    // The stable fields (agent, session) are computed once; `ts` is intentionally
    // omitted here and added fresh per invocation so each fact in a large batch
    // gets its own insertion timestamp rather than sharing a single batch-start time.
    const citationContextBase: Omit<CitationContext, "ts"> = citationEnabled
      ? {
          agent: sourceContext?.principal,
          session: sourceContext?.sessionKey,
        }
      : {};
    const applyInlineCitation = (content: string): string => {
      if (!citationEnabled) return content;
      if (typeof content !== "string" || content.length === 0) return content;
      // Build a fresh CitationContext per call so `ts` reflects the actual
      // insertion time of each individual fact rather than the batch-start time.
      const citationContext: CitationContext = {
        ...citationContextBase,
        ts: new Date().toISOString(),
      };
      // `attachCitation` already calls `hasCitationForTemplate` internally and
      // is a no-op when the content already carries a citation (default or
      // custom template).  The outer check was redundant and has been removed
      // to avoid a maintenance hazard where the two guard paths could diverge.
      return attachCitation(content, citationContext, citationTemplate);
    };
    const persistedIds: string[] = [];
    const memoryPathById = new Map<string, string>();
    const anchorSnapshots = new ExtractionAnchorSnapshot({
      enabled: coerceBool(this.deps.config.contradictionLocalization?.anchorEnabled) ?? true,
      candidateLimit: this.deps.config.contradictionLocalization?.anchorCandidates,
      onRefreshError: (error) => log.warn(`anchor snapshot update failed; using empty snapshot: ${error}`),
    });
    const supersessionOrderingAt = (validAt?: string): string =>
      validAt && validAt.length > 0 ? validAt : new Date().toISOString();
    // #1635: pending_review persisted ids, excluded from the thread episode set below.
    const pendingReviewPersistedIds: string[] = [];
    const persistedIdsByStorage = new Map<string, { storage: StorageManager; ids: string[] }>();
    const trackPersistedId = (
      targetStorage: StorageManager,
      id: string,
      options: {
        includeReturnedIds?: boolean;
        /** #1635: keep this id out of the persisted thread episode set. */
        pendingReview?: boolean;
        category?: MemoryCategory;
        harmonicFact?: Omit<
          HarmonicConstructionInput["persistedFacts"][number],
          "memoryId"
        >;
      } = {},
    ): void => {
      if (options.includeReturnedIds !== false) {
        persistedIds.push(id);
      }
      if (options.pendingReview) {
        pendingReviewPersistedIds.push(id);
      }
      const key = targetStorage.dir;
      const existing = persistedIdsByStorage.get(key);
      if (existing) {
        existing.ids.push(id);
      } else {
        persistedIdsByStorage.set(key, { storage: targetStorage, ids: [id] });
      }
      if (
        harmonicConstructionEnabled &&
        options.harmonicFact &&
        !options.pendingReview
      ) {
        const harmonicEntry = harmonicFactsByStorage.get(key) ?? {
          storage: targetStorage,
          facts: [],
        };
        harmonicEntry.facts.push({
          ...options.harmonicFact,
          memoryId: id,
          insertedAt: new Date(harmonicSourceInsertedAtBase + harmonicSourceOrder).toISOString(),
        });
        harmonicSourceOrder++;
        harmonicFactsByStorage.set(key, harmonicEntry);
      }
      if (options.category && !memoryPathById.has(id)) {
        const relPath = resolvePersistedMemoryRelativePath({ memoryId: id, pathById: memoryPathById, category: options.category });
        memoryPathById.set(id, relPath);
      }
    };
    let dedupedCount = 0, semanticMergedCount = 0;
    // Counter for facts skipped by the importance write-gate (issue #372).
    let importanceGatedCount = 0;
    // UUI2: short-circuit semantic dedup after first backend-unavailable signal
    // within this batch. Once any fact in the batch gets reason="backend_unavailable"
    // (meaning the embedding backend is degraded), subsequent facts skip the
    // lookup entirely and proceed directly to write. This prevents N-fact batches
    // from paying N × timeout when the backend is down. The flag resets per-batch
    // (declared here, inside persistExtraction) so a transient hiccup in one
    // batch does not permanently disable dedup in future batches.
    let batchBackendUnavailable = false;
    // #1669: per-namespace redaction-rule cache for this persist pass. A
    // `never_store` / redaction_rule correction persists patterns under each
    // namespace's state/corrections/redaction-rules/ dir; we consult them
    // before a fact reaches the storage write chokepoint so matching content
    // is withheld entirely rather than landing as pending_review. Cached per
    // dir so a multi-fact batch over one namespace reads the dir once.
    let redactionGatedCount = 0;
    const redactionRulesByDir = new Map<string, CompiledRedactionRule[]>();
    const redactionRulesFor = async (...dirs: string[]): Promise<CompiledRedactionRule[]> => {
      const out: CompiledRedactionRule[] = [];
      for (const d of dirs) {
        let r = redactionRulesByDir.get(d);
        if (!r) { r = await loadRedactionRules(d); redactionRulesByDir.set(d, r); }
        out.push(...r);
      }
      return out;
    };
    const behaviorSignalsByStorage = new Map<
      string,
      { storage: StorageManager; events: BehaviorSignalEvent[] }
    >();
    const trackBehaviorSignals = (
      targetStorage: StorageManager,
      events: BehaviorSignalEvent[],
    ): void => {
      if (events.length === 0) return;
      const key = targetStorage.dir;
      const existing = behaviorSignalsByStorage.get(key);
      if (existing) {
        existing.events.push(...events);
        return;
      }
      behaviorSignalsByStorage.set(key, {
        storage: targetStorage,
        events: [...events],
      });
    };
    const sharedProfileLayer = scopeProfileWritePlan?.layers.find(
      (layer) =>
        layer.id === "serverShared" &&
        layer.namespace === this.deps.config.sharedNamespace,
    );
    const sharedPromotionTarget = scopeProfileWritePlan?.promotionTargets.find(
      (target) =>
        target.target === "serverShared" &&
        target.namespace === this.deps.config.sharedNamespace,
    );
    const profileAllowsSharedWrites =
      !scopeProfileWritePlan ||
      Boolean(
        scopeProfileWritePlan.profile.readOrder.includes("serverShared") &&
          scopeProfileWritePlan.readNamespaces.includes(this.deps.config.sharedNamespace) &&
          sharedProfileLayer?.readable &&
          sharedProfileLayer.writable &&
          sharedPromotionTarget?.authorized,
      );
    // #1713: hoist namespaces-enabled once for the scope-routing mirrors
    // (pre-judge + write-loop) so no new scattered config.*Enabled read is
    // introduced (ratchet scatteredConfigFlagReads; see #1523).
    const namespacesEnabled = resolveNamespaceCapabilities(this.deps.config).namespaces;
    const sourceConnector = sourceContext?.sourceConnector; const origin = classifyExtractionOrigin(sourceContext);
    // Subject guard (issue #2372): the ONE gate shared by every extraction-side
    // promotion path so behavior matches the spaces surface (§27).
    const subjectGuardAllows = makeSubjectGuardAllows(this.deps.config);
    const promoteMemoryToProfileTargets = async (options: {
      sourceStorage: StorageManager;
      category: string;
      content: string;
      confidence: number;
      tags: string[];
      entityRef?: string;
      structuredAttributes?: Record<string, string>;
      sourceMemoryId: string;
      importance?: ReturnType<typeof scoreImportance>;
      intentGoal?: string;
      intentActionType?: string;
      intentEntityTypes?: string[];
      memoryKind?: MemoryFrontmatter["memoryKind"];
      validAt?: string;
      // #1578 — bi-temporal bounds + provenance forwarded to profile-target copies.
      invalidAt?: string;
      observedAt?: string;
      eventTimeSource?: "extracted" | "assumed";
      source: string;
      /** Origin override: the COMMITTED target's retained origin (merged-target promotion). */
      origin?: string;
      sources?: ProvenanceSource[];
      provenance?: "verified" | "unverified" | "none";
      toolScoped?: true;
      subject?: MemorySubject;
      harmonicFact?: Omit<
        HarmonicConstructionInput["persistedFacts"][number],
        "memoryId"
      >;
    }): Promise<string[]> => {
      if (
        !scopeProfileWritePlan ||
        !profileAutoPromotionAllows(scopeProfileWritePlan, options.category, options.confidence)
      )
        return [];
      const autoTargets = new Set(scopeProfileWritePlan.profile.autoPromote.targets);
      const targets = scopeProfileWritePlan.promotionTargets.filter(
        (target) =>
          target.target !== "serverShared" &&
          autoTargets.has(target.target) &&
          target.authorized &&
          target.namespace,
      );
      if (targets.length === 0) return [];
      const rawContent =
        citationEnabled && hasCitationForTemplate(options.content, citationTemplate)
          ? stripCitationForTemplate(options.content, citationTemplate)
          : options.content;
      const citedContent = applyInlineCitation(rawContent);
      const sanitizedBase = sanitizeMemoryContent(rawContent);
      const writtenCopyIds: string[] = [];
      for (const target of targets) {
        if (!target.namespace) continue;
        try {
          const targetStorage = await this.deps.getStorageRouter().storageFor(target.namespace);
          if (targetStorage.dir === options.sourceStorage.dir) continue;
          if (!subjectGuardAllows(options.subject, target.target, `profile promotion to ${target.target}`)) continue;
          // Compose BEFORE the dedup gate (#2014 round 2): salvage mode may
          // drop or clamp attributes, and the dedup hash, contentHashSource,
          // and supersession keys below must all describe the SURVIVING
          // fields that writeSealedMemory actually persists.
          const targetPromotionEnvelope = composeSalvagedExtractionEnvelope(
            {
              content: citedContent,
              category: options.category as MemoryCategory,
              origin: options.origin ?? origin, confidence: options.confidence,
              tags: withReservedMarkerTag(options.tags, `${target.target}-promotion`),
              entityRef: options.entityRef,
              structuredAttributes: options.structuredAttributes,
              validAt: options.validAt,
              ...(sourceContext?.sourceConnector ? { sourceConnector: sourceContext.sourceConnector } : {}),
              ...(options.subject !== undefined ? { subject: options.subject } : {}),
            },
            { source: `${options.source}-${target.target}-promotion` },
          );
          const targetSurvivingAttrs = targetPromotionEnvelope.rawStructuredAttributes;
          const dedupContent =
            options.category === "fact" &&
            targetSurvivingAttrs &&
            Object.keys(targetSurvivingAttrs).length > 0
              ? `${sanitizedBase.text}\n[Attributes: ${normalizeAttributePairs({ ...targetSurvivingAttrs })}]`
              : sanitizedBase.text;
          if (
            options.category === "fact" &&
            (await targetStorage.hasFactContentHash(dedupContent))
          ) {
            // Connector-aware dedup (QOjlD): verify a same-connector
            // active fact exists before skipping the promotion write.
            // Different connectors with same content should NOT be deduped.
            let skipPromotion = true;
            try {
              const allMems = await readActiveMemoriesBothTiers(targetStorage);
              const nc = sourceContext?.sourceConnector?.trim() || undefined;
              skipPromotion = allMems.some((m) => {
                if (m.frontmatter.category !== options.category) return false;
                if ((m.frontmatter.status ?? "active") !== "active") return false;
                if (normalizeStoredHashSource(m.content ?? "") !==
                  ContentHashIndex.normalizeContent(dedupContent)) return false;
                return (m.frontmatter.sourceConnector?.trim() || undefined) === nc;
              });
            } catch (err) {
              log.warn(
                `connector-aware promotion dedup scan failed; writing fail-open: ${err instanceof Error ? err.message : String(err)}`,
              );
              skipPromotion = false;
            }
            if (skipPromotion) {
            // #1671 — backfill bi-temporal bounds the existing promoted copy
            // lacks (re-extraction with a now-resolved invalidAt). Best-effort,
            // fail-open; the helper gates on invalidAt to avoid I/O when no
            // end bound is present.
            if (options.invalidAt || options.validAt) {
              await this.deps.backfillTemporalBoundsOnDedupHit(
                targetStorage,
                dedupContent,
                {
                  invalidAt: options.invalidAt,
                  // #1707 thread 2 — carry the corrected start bound.
                  validFrom: options.validAt,
                  ...(options.observedAt ? { observedAt: options.observedAt } : {}),
                  ...(options.eventTimeSource ? { eventTimeSource: options.eventTimeSource } : {}),
                },
                // #2014 round 3: the envelope's SURVIVING entityRef — the raw
                // option can differ (untrimmed/dropped) from what sealed
                // writes persisted, mistargeting the backfill row.
                targetPromotionEnvelope.entityRef,
                sourceContext?.sourceConnector,
              );
            }
            continue;
            }
          }
          // Sealed-envelope write (issue #1989 PR2): cross-cutting fields ride
          // the composed envelope (built above, before the dedup gate).
          const targetPromotion = await targetStorage.writeSealedMemory(targetPromotionEnvelope, {
            importance: options.importance,
            lineage: [options.sourceMemoryId],
            sourceMemoryId: options.sourceMemoryId,
            intentGoal: options.intentGoal,
            intentActionType: options.intentActionType,
            intentEntityTypes: options.intentEntityTypes,
            memoryKind: options.memoryKind,
            // #1578 — forward bi-temporal bounds + ingestion provenance.
            ...(options.invalidAt ? { invalidAt: options.invalidAt } : {}),
            ...(options.observedAt ? { observedAt: options.observedAt } : {}),
            ...(options.eventTimeSource ? { eventTimeSource: options.eventTimeSource } : {}),
            contentHashSource: options.category === "fact" ? dedupContent : rawContent,
            ...(options.sources && options.sources.length > 0 ? { sources: options.sources } : {}),
            ...(options.provenance ? { provenance: options.provenance } : {}),
            ...(options.toolScoped ? { toolScoped: true as const } : {}),
          });
          const promotedId = targetPromotion.id;
          // #1645: if the TARGET namespace's own tombstone blocked this promotion,
          // the row lands pending_review — do NOT supersede active target memories.
          if (
            !targetPromotion.tombstoneBlocked &&
            lifecycleCaps.temporalSupersession &&
            options.category === "fact" &&
            targetPromotionEnvelope.entityRef &&
            targetSurvivingAttrs &&
            Object.keys(targetSurvivingAttrs).length > 0
          ) {
            try {
              await applyTemporalSupersession({
                storage: targetStorage,
                newMemoryId: promotedId,
                entityRef: targetPromotionEnvelope.entityRef,
                structuredAttributes: { ...targetSurvivingAttrs },
                createdAt: supersessionOrderingAt(options.validAt),
                enabled: !(options.eventTimeSource === "extracted" && !options.validAt),
                dependencyPropagationDelivery: this.dependencyPropagationDelivery,
                namespaceScope: this.deps.storageDirNamespace(targetStorage.dir),
              });
            } catch (profileSupersessionErr) {
              log.warn(
                `persistExtraction: ${target.target} promotion temporal supersession failed open for promoted ${promotedId}: ${profileSupersessionErr}`,
              );
            }
          }
          // #1645 TV6: tombstone-blocked = pending_review; skip catalog/index/behavior.
          if (!targetPromotion.tombstoneBlocked) {
            writtenCopyIds.push(promotedId);
            trackPersistedId(targetStorage, promotedId, {
              includeReturnedIds: false,
              category: options.category as MemoryCategory,
              harmonicFact: options.harmonicFact,
            });
            await this.deps.indexPersistedMemory(targetStorage, promotedId);
            trackBehaviorSignals(
              targetStorage,
              buildBehaviorSignalsForMemory({
                memoryId: promotedId,
                category: options.category as any,
                content: options.content,
                namespace: target.namespace,
                confidence: options.confidence,
                source: "extraction",
              }),
            );
          }
        } catch (err) {
          log.warn(
            `persistExtraction: ${target.target} promotion failed open for ${options.sourceMemoryId}: ${err}`,
          );
        }
      }
      return writtenCopyIds;
    };
    const promoteMemoryToShared = async (options: {
      sourceStorage: StorageManager;
      category: string;
      content: string;
      confidence: number;
      tags: string[];
      entityRef?: string;
      structuredAttributes?: Record<string, string>;
      sourceMemoryId: string;
      importance?: ReturnType<typeof scoreImportance>;
      intentGoal?: string;
      intentActionType?: string;
      intentEntityTypes?: string[];
      memoryKind?: MemoryFrontmatter["memoryKind"];
      validAt?: string;
      // #1578 — bi-temporal bounds + ingestion provenance forwarded to the
      // shared-namespace copy (cursor bugbot).
      invalidAt?: string;
      observedAt?: string;
      eventTimeSource?: "extracted" | "assumed";
      source: string;
      origin?: string;
      sourceConnector?: string;
      /** Committed-record tool-scope marker — see {@link promotionWithholdsToolScope}. */
      toolScoped?: true;
      procedureSteps?: ReadonlyArray<{ toolCall?: { kind?: string } }>;
      /** Claim-level provenance spans (issue #1575 PR 2). */
      sources?: ProvenanceSource[];
      provenance?: "verified" | "unverified" | "none";
      subject?: MemorySubject;
      harmonicFact?: Omit<
        HarmonicConstructionInput["persistedFacts"][number],
        "memoryId"
      >;
    }): Promise<string | undefined> => {
      const toolScoped = promotionWithholdsToolScope(options);
      // P1-A (#2330 N+8): every exit returns the LAST copy id written, profile copies included.
      let promotedCopyId = (
        await promoteMemoryToProfileTargets({
          ...options,
          ...(toolScoped ? { toolScoped: true as const } : {}),
        })
      ).at(-1);
      if (lifecycleCaps.extractionScopeClassification && toolScoped) return promotedCopyId;
      if (
        !shouldPromoteToShared(
          this.deps.config,
          scopeProfileWritePlan,
          profileAllowsSharedWrites,
          (dir) => this.deps.storageDirNamespace(dir),
          options.sourceStorage,
          options.category,
          options.confidence,
        )
      )
        return promotedCopyId;
      if (!subjectGuardAllows(options.subject, "serverShared", "shared promotion"))
        return promotedCopyId;
      try {
        const sharedStorage = await this.deps.getStorageRouter().storageFor(
          this.deps.config.sharedNamespace,
        );
        // Dedup gate: strip any pre-existing citation, sanitize, and build
        // the attribute-enriched body with normalizeAttributePairs — the
        // same canonicalization writeMemory applies — so the hash lookup
        // uses the exact body writeMemory stores (#369/#401, #402 round-6).
        const rawContent =
          citationEnabled &&
          hasCitationForTemplate(options.content, citationTemplate)
            ? stripCitationForTemplate(options.content, citationTemplate)
            : options.content;
        const citedContent = applyInlineCitation(rawContent);
        const sanitizedBase = sanitizeMemoryContent(rawContent);
        // Compose BEFORE the dedup gate (#2014 round 2): the dedup hash, contentHashSource, and
        // supersession keys must describe the SURVIVING fields writeSealedMemory persists.
        const sharedPromotionEnvelope = composeSalvagedExtractionEnvelope(
          {
            content: citedContent,
            category: options.category as MemoryCategory,
            origin: options.origin ?? origin, confidence: options.confidence,
            tags: withReservedMarkerTag(options.tags, "shared-promotion"),
            entityRef: options.entityRef,
            structuredAttributes: options.structuredAttributes,
            validAt: options.validAt,
            ...(sourceContext?.sourceConnector ? { sourceConnector: sourceContext.sourceConnector } : {}),
            ...(options.subject !== undefined ? { subject: options.subject } : {}),
          },
          { source: `${options.source}-shared-promotion` },
        );
        const sharedSurvivingAttrs = sharedPromotionEnvelope.rawStructuredAttributes;
        const dedupContent =
          options.category === "fact" &&
          sharedSurvivingAttrs &&
          Object.keys(sharedSurvivingAttrs).length > 0
            ? `${sanitizedBase.text}\n[Attributes: ${normalizeAttributePairs({ ...sharedSurvivingAttrs })}]`
            : sanitizedBase.text;
        if (
          options.category === "fact" &&
          (await sharedStorage.hasFactContentHash(dedupContent))
        ) {
          // Connector identity gate: backfill bounds only onto a same-connector fact (no cross-patch).
          // Fail-open: on scan error backfill proceeds (prior best-effort behaviour).
          let sharedSameConnector = true;
          if (options.invalidAt || options.validAt) {
            try {
              const sharedMems = await readActiveMemoriesBothTiers(sharedStorage);
              const snc = sourceContext?.sourceConnector?.trim() || undefined;
              sharedSameConnector = sharedMems.some((m) => {
                if (m.frontmatter.category !== "fact") return false;
                if ((m.frontmatter.status ?? "active") !== "active") return false;
                if (normalizeStoredHashSource(m.content ?? "") !==
                  ContentHashIndex.normalizeContent(dedupContent)) return false;
                return (m.frontmatter.sourceConnector?.trim() || undefined) === snc;
              });
            } catch (scanErr) {
              // Review f1b89fe9: on scan error, conservatively skip backfill
              // instead of fail-opening. A fail-open here still calls the
              // helper, which selects the first hash/entity match — and if
              // that match is a different connector's fact, the mutation
              // corrupts its temporal bounds. Skipping is the safe choice.
              sharedSameConnector = false;
              log.warn(
                `connector-aware shared backfill scan failed; skipping backfill to avoid cross-connector mutation: ${scanErr instanceof Error ? scanErr.message : String(scanErr)}`,
              );
            }
          }
          // #1671 — backfill bi-temporal bounds onto the existing shared copy
          // before the supersession short-circuit. Covers all return paths below
          // (supersession-hit, catch-skip, and the no-supersession short-circuit)
          // in one shot. Best-effort / fail-open; the helper gates on invalidAt.
          // Connector gate: skip backfill when no same-connector active fact
          // exists so a different connector's copy is not mutated.
          if (sharedSameConnector && (options.invalidAt || options.validAt)) {
            await this.deps.backfillTemporalBoundsOnDedupHit(
              sharedStorage,
              dedupContent,
              {
                invalidAt: options.invalidAt,
                // #1707 thread 2 — carry the corrected start bound.
                validFrom: options.validAt,
                ...(options.observedAt ? { observedAt: options.observedAt } : {}),
                ...(options.eventTimeSource ? { eventTimeSource: options.eventTimeSource } : {}),
              },
              // #2014 round 3: envelope-surviving entityRef (see profile-target).
              sharedPromotionEnvelope.entityRef,
              sourceContext?.sourceConnector,
            );
          }
          // Uj6H fix: shared-namespace temporal supersession must also run when
          // the hash-dedup short-circuit fires.  Without this, an existing shared
          // fact whose structuredAttributes are stale (or an older conflicting
          // shared fact that is still active) never gets retired — supersession
          // only ran in the post-writeMemory block which is unreachable here.
          //
          // Strategy: scan the shared namespace for the existing fact whose
          // normalized content matches the incoming content, then run
          // applyTemporalSupersession against it using the same logic that
          // would have run post-writeMemory.  This is a best-effort / fail-open
          // step — if the lookup fails we skip silently (same as the normal path).
          if (
            lifecycleCaps.temporalSupersession &&
            sharedPromotionEnvelope.entityRef &&
            sharedSurvivingAttrs &&
            Object.keys(sharedSurvivingAttrs).length > 0
          ) {
            // PR #402 round-7 (Fix #2 / Codex P1 PRRT_kwDORJXyws56VALC):
            // Track whether matchingFact lookup completed before the try block
            // so the catch block can distinguish an early-lookup failure (where
            // we don't know if a duplicate exists) from a post-lookup supersession
            // failure (where we confirmed a duplicate and must skip the write).
            let hashDedupMatchingFact: MemoryFile | undefined;
            let hashDedupLookupComplete = false;
            try {
              // Fix #2 (P2 PRRT_kwDORJXyws56VHZf): dedupContent is now built
              // from sanitizedBase.text (see fix #4 above), so normalizedIncoming
              // uses the same sanitized+normalized content that writeMemory hashes
              // and that hasFactContentHash just matched.  Previously this used the
              // raw options.content, which diverged from the stored hash when
              // sanitization redacted the content, causing the candidate lookup to
              // return undefined and leaving stale facts active.
              const normalizedIncoming = ContentHashIndex.normalizeContent(dedupContent);
              const allShared = await readActiveMemoriesBothTiers(sharedStorage);
              // PR #402 round-12 (Finding Uybg): restrict hash-dedup matching to
              // the SAME entity.  Content-hash equality alone can collide across
              // entities when two entities share identical fact text.  Using an
              // unrelated entity's existing fact as `newMemoryId` would anchor
              // supersession to that entity's record and corrupt its
              // `supersededBy` links.  Only consider facts whose normalized
              // `entityRef` matches the incoming entity.
              const incomingEntityNorm = normalizeSupersessionKey(sharedPromotionEnvelope.entityRef);
              hashDedupMatchingFact = allShared.find((m) => {
                if (m.frontmatter.category !== "fact") return false;
                if ((m.frontmatter.status ?? "active") !== "active") return false;
                // Same-entity guard: skip if entity doesn't match.
                if (!m.frontmatter.entityRef) return false;
                if (normalizeSupersessionKey(m.frontmatter.entityRef) !== incomingEntityNorm) {
                  log.debug(
                    `persistExtraction: hash-dedup skipping cross-entity match (incoming="${incomingEntityNorm}" candidate="${normalizeSupersessionKey(m.frontmatter.entityRef)}")`,
                  );
                  return false;
                }
                // PR #402 round-7 (Fix #2): compare stored fact's full body
                // (including any appended "[Attributes: ...]" suffix) against the
                // enriched normalizedIncoming so the candidate selected is the one
                // whose hash actually matched in hasFactContentHash.
                if (normalizeStoredHashSource(m.content ?? "") !== normalizedIncoming) return false;
                // Connector-aware dedup: same content from different connectors
                // is NOT a duplicate (review thread QOjlD).
                const existingConnector = m.frontmatter.sourceConnector?.trim() || undefined;
                const newConnector = sourceContext?.sourceConnector?.trim() || undefined;
                if (existingConnector !== newConnector) return false;
                return true;
              });
              hashDedupLookupComplete = true;
              if (hashDedupMatchingFact) {
                // Finding UvU1 (PR #402 round-11): anchor supersession to the
                // incoming event's time, not the existing fact's persisted
                // `created`.  For source-dated replay/import, this is the
                // source valid_at; otherwise it is the current wall-clock. The
                // matching fact may be an old shared copy whose `created`
                // predates the incoming promotion event — using it as
                // `createdAt` would make the new memory appear older than the
                // existing one, preventing supersession from firing.
                // PR #402 round-12 (Finding Uyui): the matching fact is an
                // existing OLD memory — its persisted `frontmatter.created` is
                // stale relative to the incoming promotion event.  Pass
                // `useCallerTimestamp: true` so the function uses
                // `createdAt` as the ordering anchor instead of the old fact's
                // timestamp, ensuring supersession fires correctly even when
                // the matching fact predates conflicting candidates.
                const hashDedupSupersession = await applyTemporalSupersession({
                  storage: sharedStorage,
                  newMemoryId: hashDedupMatchingFact.frontmatter.id,
                  entityRef: sharedPromotionEnvelope.entityRef,
                  structuredAttributes: { ...sharedSurvivingAttrs },
                  createdAt: supersessionOrderingAt(options.validAt),
                  useCallerTimestamp: true,
                  enabled: !(options.eventTimeSource === "extracted" && !options.validAt),
                  dependencyPropagationDelivery: this.dependencyPropagationDelivery,
                  namespaceScope: this.deps.storageDirNamespace(sharedStorage.dir),
                });
                // Catalog touch (issue #1499 — codex P2 NElSf): this dedup branch
                // returns WITHOUT the post-write catalog touch (now at the storage chokepoint #1522),
                // but `applyTemporalSupersession` mutated the shared namespace
                // (it rewrote frontmatter to retire stale shared facts). When any
                // ids were actually superseded, the shared namespace changed, so we
                // must record the write — otherwise the shared record's
                // `lastWriteAt` stays stale and `writtenSince` maintenance / QMD
                // fanout skips the namespace after a supersession-only update.
                // Best-effort and failure-tolerant (the storage chokepoint swallows
                // errors); only touch when work happened to avoid spurious writes.
                if (hashDedupSupersession.supersededIds.length > 0) {
                }
                // Active matching fact exists — normal short-circuit is safe.
                return promotedCopyId;
              }
              // No active same-entity shared fact found with this content hash.
              // This can happen when the previously-written shared fact has since
              // been superseded (e.g. Austin → NYC → Austin reversion): the hash
              // index still records the hash but the fact is no longer active.
              // Fall through to the write path below so a new active shared
              // memory is created, then supersession fires post-write as usual.
              log.debug(
                `persistExtraction: hash-dedup found no active same-entity shared fact for ${options.sourceMemoryId}; falling through to write`,
              );
            } catch (hashDedupSupersessionErr) {
              log.warn(
                `persistExtraction: shared-namespace supersession on hash-dedup path failed open for ${options.sourceMemoryId}: ${hashDedupSupersessionErr}`,
              );
              // PR #402 round-7 (Fix #1 / cursor Medium PRRT_kwDORJXyws56U_ig):
              // Only skip the write if we CONFIRMED a matching active shared fact
              // before the error occurred (hashDedupLookupComplete is true AND
              // hashDedupMatchingFact is set).  If the error was thrown before
              // matchingFact was resolved — e.g. readAllMemories() threw — we
              // cannot assume a duplicate exists, and unconditionally returning
              // would permanently lose the shared promotion.  Fall through to the
              // write path so the fact is not silently dropped.
              if (hashDedupLookupComplete && hashDedupMatchingFact) {
                // A matching active shared fact was confirmed — skip the write to
                // avoid duplicating content that is already present.  The existing
                // fact remains active and the supersession failure is logged above.
                return promotedCopyId;
              }
              // Lookup did not complete or no candidate was found — we cannot
              // confirm a duplicate.  Fall through to the write + post-write
              // supersession path so the shared promotion is not lost.
              log.debug(
                `persistExtraction: hash-dedup catch: lookup incomplete or no candidate found for ${options.sourceMemoryId}; falling through to write`,
              );
            }
          } else {
            // Connector-aware dedup (QPAn-): when temporal supersession is off
            // or the fact has no entity/structuredAttributes, the original
            // short-circuit would drop a different-connector fact. Verify a
            // same-connector active fact exists before skipping the shared
            // promotion write; otherwise fall through so the new connector's
            // fact gets its own promoted copy.
            let skipSharedPromotion = true;
            try {
              const allSharedMems = await readActiveMemoriesBothTiers(sharedStorage);
              const snc = sourceContext?.sourceConnector?.trim() || undefined;
              const sharedNormalized = ContentHashIndex.normalizeContent(dedupContent);
              skipSharedPromotion = allSharedMems.some((m) => {
                if (m.frontmatter.category !== "fact") return false;
                if ((m.frontmatter.status ?? "active") !== "active") return false;
                if (normalizeStoredHashSource(m.content ?? "") !== sharedNormalized) return false;
                return (m.frontmatter.sourceConnector?.trim() || undefined) === snc;
              });
            } catch (err) {
              log.warn(
                `connector-aware shared promotion dedup scan failed; writing fail-open: ${err instanceof Error ? err.message : String(err)}`,
              );
              skipSharedPromotion = false;
            }
            if (skipSharedPromotion) {
              return promotedCopyId;
            }
            // No same-connector active shared fact — fall through to write.
          }
        }
        const sharedPromotion = await sharedStorage.writeSealedMemory(sharedPromotionEnvelope, {
          importance: options.importance,
          lineage: [options.sourceMemoryId],
          sourceMemoryId: options.sourceMemoryId,
          intentGoal: options.intentGoal,
          intentActionType: options.intentActionType,
          intentEntityTypes: options.intentEntityTypes,
          memoryKind: options.memoryKind,
          // #1578 — forward bi-temporal bounds + ingestion provenance.
          ...(options.invalidAt ? { invalidAt: options.invalidAt } : {}),
          ...(options.observedAt ? { observedAt: options.observedAt } : {}),
          ...(options.eventTimeSource ? { eventTimeSource: options.eventTimeSource } : {}),
          contentHashSource: options.category === "fact" ? dedupContent : rawContent,
          // Claim-level provenance spans (issue #1575 PR 2).
          ...(options.sources && options.sources.length > 0 ? { sources: options.sources } : {}),
          ...(options.provenance ? { provenance: options.provenance } : {}),
          ...(toolScoped ? { toolScoped: true as const } : {}),
        });
        const promotedId = sharedPromotion.id;
        // #1645: if the shared namespace's own tombstone blocked this promotion,
        // leave the row pending_review but do NOT supersede active shared memories.
        // PR #402 Finding 3 fix: run temporal supersession against the shared
        // namespace after the promoted write lands so stale shared-namespace
        // copies of the same entity attribute are retired.  Without this,
        // source-namespace supersession leaves the shared copy active and
        // shared recall continues returning the stale state.  Reuses the same
        // applyTemporalSupersession helper — no logic duplication.
        if (
          !sharedPromotion.tombstoneBlocked &&
          lifecycleCaps.temporalSupersession &&
          sharedPromotionEnvelope.entityRef &&
          sharedSurvivingAttrs &&
          Object.keys(sharedSurvivingAttrs).length > 0
        ) {
          try {
            await applyTemporalSupersession({
              storage: sharedStorage,
              newMemoryId: promotedId,
              entityRef: sharedPromotionEnvelope.entityRef,
              structuredAttributes: { ...sharedSurvivingAttrs },
              createdAt: supersessionOrderingAt(options.validAt),
              enabled: !(options.eventTimeSource === "extracted" && !options.validAt),
              dependencyPropagationDelivery: this.dependencyPropagationDelivery,
              namespaceScope: this.deps.storageDirNamespace(sharedStorage.dir),
            });
          } catch (sharedSupersessionErr) {
            log.warn(
              `persistExtraction: shared-namespace temporal supersession failed open for promoted ${promotedId}: ${sharedSupersessionErr}`,
            );
          }
        }
        // Catalog touch (issue #1499, Issue B + ordering sweep): a shared-
        // namespace promotion is the ONLY write the shared namespace receives on
        // this path, so without this the shared record's lastWriteAt stays stale
        // and `writtenSince` filters / maintenance fanout skip it. Record AFTER
        // the promoted write and the shared temporal-supersession attempt so the
        // catalog timestamp never precedes a later durable frontmatter mutation in
        // the same promotion pass. The hot-path source-namespace touch uses a
        // different storage dir, so this does not double-count the source.
        // Best-effort and failure-tolerant — it must never crash the promotion.
        // #1645 TV6: same guard as the profile-target promotion above.
        if (!sharedPromotion.tombstoneBlocked) {
          trackPersistedId(sharedStorage, promotedId, {
            includeReturnedIds: false,
            category: options.category as MemoryCategory,
            harmonicFact: options.harmonicFact,
          });
          await this.deps.indexPersistedMemory(sharedStorage, promotedId);
          trackBehaviorSignals(
            sharedStorage,
            buildBehaviorSignalsForMemory({
              memoryId: promotedId,
              category: options.category as any,
              content: options.content,
              namespace: this.deps.config.sharedNamespace,
              confidence: options.confidence,
              source: "extraction",
            }),
          );
        }
        promotedCopyId = promotedId; // feeds the merged-target reconciliation (round N+7 B)
        return promotedId;
      } catch (err) {
        log.warn(
          `persistExtraction: shared promotion failed open for ${options.sourceMemoryId}: ${err}`,
        );
        return promotedCopyId; // P1-A: profile copies written pre-failure still reconcile
      }
    };
    // #1707 thread 1 — backfill temporal bounds onto promotion copies when the
    // SOURCE-namespace dedup short-circuit fires. That branch patches the
    // source copy then `continue`s before the promotion dedup paths run, so
    // promoted shared/profile copies written before the source fact carried
    // resolved bounds stay stale (cross-namespace recall surfaces an expired
    // fact). This mirrors the promotion-target resolution used by the two
    // promote closures above and calls the same fail-open helper against each
    // target storage. Backfill-only: never writes a new promoted copy.
    const backfillTemporalBoundsOnPromotionCopies = async (args: {
      sourceStorage: StorageManager;
      content: string;
      category: string;
      confidence: number;
      entityRef?: string;
      structuredAttributes?: Record<string, string>;
      sourceConnector?: string;
      bounds: {
        invalidAt?: string;
        validFrom?: string;
        observedAt?: string;
        eventTimeSource?: "extracted" | "assumed";
      };
    }): Promise<void> => {
      // Mirror the helper's I/O gate: only resolve promotion targets when
      // there is an end bound OR an EXTRACTED start bound. An "assumed"
      // validFrom is just the ingestion anchor (no recall effect), so
      // skipping it avoids resolving target storages on every bi-temporal
      // duplicate (review cursor PRRT_OvHk).
      const hasExtractedStart =
        args.bounds.validFrom !== undefined &&
        args.bounds.eventTimeSource === "extracted";
      if (!args.bounds.invalidAt && !hasExtractedStart) return;
      // Build the same dedupContent the promotion functions hash on so the
      // content-hash lookup in the helper matches what was stored.
      const rawContent =
        citationEnabled && hasCitationForTemplate(args.content, citationTemplate)
          ? stripCitationForTemplate(args.content, citationTemplate)
          : args.content;
      const sanitizedBase = sanitizeMemoryContent(rawContent);
      // #2014 round 3: promoted copies were written from SALVAGE envelopes,
      // so hash on the same surviving fields those writes persisted — a
      // raw-attrs hash silently misses after salvage drops/dedupes keys.
      // Fail open to raw fields when the probe rejects.
      const probed =
        args.category === "fact" && isMemoryCategory(args.category)
          ? probeSalvageSurvivingFields({
              content: rawContent,
              category: args.category,
              structuredAttributes: args.structuredAttributes,
              entityRef: args.entityRef,
            })
          : null;
      const backfillEntityRef = probed ? probed.entityRef : args.entityRef;
      const survivingBackfillAttrs = probed
        ? probed.structuredAttributes
        : args.structuredAttributes;
      const dedupContent =
        args.category === "fact" &&
        survivingBackfillAttrs &&
        Object.keys(survivingBackfillAttrs).length > 0
          ? `${sanitizedBase.text}\n[Attributes: ${normalizeAttributePairs(survivingBackfillAttrs)}]`
          : sanitizedBase.text;
      // Profile targets. NOTE: we do NOT gate on profileAutoPromotionAllows —
      // a promoted profile copy may exist from an EARLIER extraction with
      // higher confidence or older auto-promote settings, so the current
      // duplicate's confidence must not skip backfilling an already-existing
      // promoted copy (review codex PRRT_Ov7LKF). The helper no-ops when no
      // matching copy is found, so resolving all configured auto-promote
      // targets is safe.
      if (scopeProfileWritePlan) {
        const autoTargets = new Set(
          scopeProfileWritePlan.profile.autoPromote.targets,
        );
        const profileTargets = scopeProfileWritePlan.promotionTargets.filter(
          (target) =>
            target.target !== "serverShared" &&
            autoTargets.has(target.target) &&
            target.authorized &&
            target.namespace,
        );
        for (const target of profileTargets) {
          if (!target.namespace) continue;
          try {
            const targetStorage = await this.deps.getStorageRouter().storageFor(
              target.namespace,
            );
            if (targetStorage.dir === args.sourceStorage.dir) continue;
            await this.deps.backfillTemporalBoundsOnDedupHit(
              targetStorage,
              dedupContent,
              args.bounds,
              backfillEntityRef,
              args.sourceConnector,
            );
          } catch (err) {
            log.warn(
              `bitemporal-backfill: profile-target backfill failed open for ${target.target}: ${err}`,
            );
          }
        }
      }
      // Shared target. A shared copy may exist from an earlier extraction
      // regardless of the current confidence, so do not gate on
      // shouldPromoteToShared (review codex PRRT_Ov7LKF) — BUT still respect
      // shared-write AUTHORIZATION: a scoped profile that does not authorize
      // serverShared writes must not have its shared namespace backfilled
      // (review codex PRRT_Ov7dHR). profileAllowsSharedWrites is true for the
      // legacy no-scope case and encodes the readable/writable/authorized
      // checks under a scope profile.
      if (profileAllowsSharedWrites) {
        try {
          const sharedStorage = await this.deps.getStorageRouter().storageFor(
            this.deps.config.sharedNamespace,
          );
          if (sharedStorage.dir !== args.sourceStorage.dir) {
            await this.deps.backfillTemporalBoundsOnDedupHit(
              sharedStorage,
              dedupContent,
              args.bounds,
              backfillEntityRef,
              args.sourceConnector,
            );
          }
        } catch (err) {
          log.warn(
            `bitemporal-backfill: shared-target backfill failed open: ${err}`,
          );
        }
      }
    };

    // Defensive: validate result and facts array
    if (!result || !Array.isArray(result.facts)) {
      log.warn(
        "persistExtraction: result or result.facts is invalid, skipping",
        { resultType: typeof result, factsType: typeof result?.facts },
      );
      return { persistedIds, memoryPathById };
    }

    // Chunking config from plugin settings
    const chunkingConfig: ChunkingConfig = {
      targetTokens: this.deps.config.chunkingTargetTokens,
      minTokens: this.deps.config.chunkingMinTokens,
      overlapSentences: this.deps.config.chunkingOverlapSentences,
    };

    const rawEntities = Array.isArray((result as any).entities)
      ? (result as any).entities
      : [];
    const rawQuestions = Array.isArray((result as any).questions)
      ? (result as any).questions
      : [];
    const rawProfileUpdates = Array.isArray((result as any).profileUpdates)
      ? (result as any).profileUpdates
      : [];

    const facts = result.facts.slice(0, this.deps.config.extractionMaxFactsPerRun);
    const entities = rawEntities.slice(
      0,
      this.deps.config.extractionMaxEntitiesPerRun,
    );
    const questions = rawQuestions.slice(
      0,
      this.deps.config.extractionMaxQuestionsPerRun,
    );
    const profileUpdates = rawProfileUpdates.slice(
      0,
      this.deps.config.extractionMaxProfileUpdatesPerRun,
    );

    if (
      facts.length < result.facts.length ||
      entities.length < result.entities.length ||
      questions.length < result.questions.length ||
      profileUpdates.length < result.profileUpdates.length
    ) {
      log.warn(
        "persistExtraction: capped extraction payload to guardrails " +
          `(facts ${facts.length}/${result.facts.length}, entities ${entities.length}/${result.entities.length}, ` +
          `questions ${questions.length}/${result.questions.length}, profile ${profileUpdates.length}/${result.profileUpdates.length})`,
      );
    }

    // v8.2: pre-load all memories once for entity-sibling graph edges (avoids per-fact disk scan)
    type GraphStorageContext = {
      allMemsForGraph: Awaited<
        ReturnType<typeof storage.readAllMemories>
      > | null;
      memoryPathById: Map<string, string>;
      previousPersistedRelPath?: string;
    };
    const graphContextByStorageDir = new Map<string, GraphStorageContext>();
    const ensureGraphContext = async (
      targetStorage: StorageManager,
    ): Promise<GraphStorageContext> => {
      const existing = graphContextByStorageDir.get(targetStorage.dir);
      if (existing) return existing;
      const created: GraphStorageContext = {
        allMemsForGraph: null,
        memoryPathById: new Map<string, string>(),
      };
      if (graphCaps.multiGraphMemory) {
        try {
          created.allMemsForGraph = await targetStorage.readAllMemories();
          for (const [id, relPath] of buildMemoryPathById(
            created.allMemsForGraph,
            targetStorage.dir,
          )) {
            created.memoryPathById.set(id, relPath);
          }
        } catch {
          /* fail-open */
        }
      }
      graphContextByStorageDir.set(targetStorage.dir, created);
      return created;
    };
    let threadEpisodeIdsForGraph: string[] | undefined;
    if (graphCaps.multiGraphMemory && threadIdForExtraction) {
      try {
        const thread = await this.deps.getThreading().loadThread(threadIdForExtraction);
        threadEpisodeIdsForGraph = thread?.episodeIds
          ? [...thread.episodeIds]
          : [];
      } catch {
        /* fail-open */
      }
    }
    const routeRules = await this.deps.loadRoutingRules();
    const routeOptions = this.deps.routeEngineOptions();

    // Pre-routing pass: compute the routed category for every fact BEFORE
    // building judge candidates.  Route rules may override f.category (e.g.
    // via taxonomy remapping), and the judge must evaluate against the
    // *final* category that will actually be persisted — not the raw
    // extraction-time category.  The per-fact write loop below reuses
    // these pre-computed results so routing is evaluated exactly once per
    // fact (no duplicated logic).
    const preRoutedCategories: Array<string | undefined> = new Array(facts.length);
    // #1713 Item 1: collect routed target namespaces so the pre-judge redaction
    // filter can consult rules from cross-namespace targets, not just the source.
    // #1713 P2 (cursor): track per-fact routed namespace for per-fact pre-judge rules
    const preRoutedNamespaceByFact: Array<string | undefined> = new Array(facts.length);
    if (routeRules.length > 0) {
      for (let fi = 0; fi < facts.length; fi++) {
        const f = facts[fi];
        if (
          !f ||
          typeof f.content !== "string" ||
          !f.content.trim() ||
          typeof f.category !== "string" ||
          !f.category.trim()
        ) {
          continue;
        }
        try {
          const tags = Array.isArray(f.tags) ? f.tags : [];
          const routeText = `${f.category} ${tags.join(" ")} ${f.content}`;
          const selected = selectRouteRule(routeText, routeRules, routeOptions);
          if (selected?.target.category) {
            preRoutedCategories[fi] = selected.target.category;
          }
          if (selected?.target.namespace) {
            preRoutedNamespaceByFact[fi] = selected.target.namespace;
          }
        } catch {
          // Fail-open: routing errors fall through to the extracted category.
        }
      }
    }

    // Extraction judge gate (issue #376). When enabled, batch-evaluate all
    // candidate facts for durability before the per-fact write loop.
    // The verdicts map is keyed by candidate index — we maintain a
    // candidateIndexToFactIndex mapping so the write loop can look up
    // verdicts by original fact index.
    //
    // Candidates are built using the *routed* category (preRoutedCategories)
    // so the judge evaluates durability against the same category that will
    // be persisted, not the raw extraction-time category.
    let judgeVerdictsByFactIndex: Map<number, import("../extraction-judge.js").JudgeVerdict> | null = null;
    let judgeGatedCount = 0;
    // Reset the side-channel defer count at the start of every
    // persistExtraction call so stale state from a prior call cannot leak
    // into the caller's buffer-retention decision.
    this.deps.setLastPersistExtractionDeferredCount(0);
    if (lifecycleCaps.extractionJudge) {
      // #1669 P1 + #1713 Item 1: pre-filter redacted facts from judge candidates
      // so never-store content is not persisted as judge training data.
      // Consult source + shared + routed target namespace rules so a
      // never-store pattern registered under a cross-namespace target is
      // caught at the batch pre-filter point, not just at the persist gate.
      let preJudgeRedactionRules: CompiledRedactionRule[] = [];
      try {
        // #1713: base rules are source-only. Per-fact routed target rules
        // (including shared when a fact is routed there) are checked in the
        // fact loop, matching the write-time gate's per-fact scoping exactly.
        preJudgeRedactionRules = await redactionRulesFor(storage.dir);
      } catch { /* fail open */ }
      try {
        const judgeCandidates: JudgeCandidate[] = [];
        const candidateToFactIndex: number[] = [];
        for (let fi = 0; fi < facts.length; fi++) {
          const f = facts[fi];
          if (
            !f ||
            typeof f.content !== "string" ||
            !f.content.trim() ||
            typeof f.category !== "string" ||
            !f.category.trim()
          ) {
            continue;
          }
          // Use the routed category when available so the judge sees the
          // final persisted category, not the raw extraction-time value.
          // Cast to MemoryCategory — routing targets are always valid
          // category slugs defined in the taxonomy; the fallback is the
          // original ExtractedFact.category which is already typed.
          const judgeCategory = (preRoutedCategories[fi] ?? f.category) as import("../types.js").MemoryCategory;
          if (judgeCategory === "procedure") {
            continue;
          }
          const tags = Array.isArray(f.tags) ? f.tags : [];
          const imp = scoreImportance(
            f.content,
            judgeCategory,
            tags,
          );
          // Pre-filter: skip facts below importance threshold to avoid
          // wasting LLM calls on facts that will be filtered anyway in
          // the per-fact write loop (issue #376 review finding).
          if (
            !isAboveImportanceThreshold(
              imp.level,
              this.deps.config.extractionMinImportanceLevel,
            )
          ) {
            continue;
          }
          // #1713 P2 (cursor): per-fact rules — load this fact's routed target
          // namespace rules FIRST, then check. This catches target-only rules
          // even when the base (source+shared) rules are empty (threads acc58c42
          // + PBJEe/PBKAj).
          let factRedactionRules = preJudgeRedactionRules;
          let factNs = preRoutedNamespaceByFact[fi];
          // #1713: predict the same target namespace the write loop will route
          // this global fact to (shared, via shouldPromoteGlobalFactToShared) so
          // the pre-judge redaction filter consults that namespace's rules.
          if (
            !factNs &&
            lifecycleCaps.extractionScopeClassification &&
            namespacesEnabled &&
            f.scope === "global" &&
            profileAllowsSharedWrites &&
            this.deps.storageDirNamespace(storage.dir) !== this.deps.config.sharedNamespace &&
            shouldPromoteGlobalFactToShared({ scope: f.scope, content: f.content,
              sourceConnector, procedureSteps: f.procedureSteps }) &&
            subjectGuardAllows(f.subject, "serverShared", "pre-judge shared routing")
          ) {
            factNs = this.deps.config.sharedNamespace;
          }
          if (factNs) {
            try {
              const factDir = (await this.deps.getStorageRouter().storageFor(factNs)).dir;
              if (factDir !== storage.dir) {
                const targetRules = await redactionRulesFor(factDir);
                if (targetRules.length) factRedactionRules = [...preJudgeRedactionRules, ...targetRules];
              }
            } catch { /* fail open */ }
          }
          if (factRedactionRules.length > 0) {
            const rc = f.content + (f.structuredAttributes ? " " + JSON.stringify(f.structuredAttributes) : "")
              + (f.procedureSteps ? " " + f.procedureSteps.map((s) => `${s.intent} ${s.expectedOutcome ?? ""} ${s.toolCall ? `${s.toolCall.kind} ${s.toolCall.signature}` : ""}`.trim()).join(" ") : "");
            if (contentMatchesRedactionRules(rc, factRedactionRules)) continue;
          }
          judgeCandidates.push({
            text: f.content,
            category: judgeCategory,
            confidence: typeof f.confidence === "number" ? f.confidence : 0.7,
            tags,
            importanceLevel: imp.level,
          });
          candidateToFactIndex.push(fi);
        }
        // Telemetry + training-pair emit (issue #562 PR 3 + PR 4). The
        // orchestrator wires two fire-and-forget writers behind a single
        // callback so `judgeFactDurability` does not need to know about
        // either ledger. Both handlers are skipped when their flags are
        // off; the combined callback itself is undefined when both are
        // disabled so there is zero overhead in the default configuration.
        const judgeTelemetryOpts = {
          enabled: lifecycleCaps.extractionJudgeTelemetry,
          memoryDir: this.deps.config.memoryDir,
        };
        const judgeTrainingOpts = {
          enabled: this.deps.config.collectJudgeTrainingPairs === true,
          ...(this.deps.config.judgeTrainingDir
            ? { directory: this.deps.config.judgeTrainingDir }
            : {}),
        };
        const judgeTelemetryHandler =
          judgeTelemetryOpts.enabled || judgeTrainingOpts.enabled
            ? (obs: import("../extraction-judge.js").JudgeVerdictObservation) => {
                const ts = new Date().toISOString();
                const verdictKind = getVerdictKind(obs.verdict);
                if (judgeTelemetryOpts.enabled) {
                  const event: import("../extraction-judge-telemetry.js").JudgeVerdictEvent = {
                    version: 1,
                    category: EXTRACTION_JUDGE_VERDICT_CATEGORY,
                    ts,
                    verdictKind,
                    reason: obs.verdict.reason,
                    deferrals: obs.priorDeferrals,
                    elapsedMs: obs.elapsedMs,
                    candidateCategory: obs.candidate.category,
                    confidence: obs.candidate.confidence,
                    contentHash: obs.contentHash,
                    fromCache: obs.source === "cache",
                    ...(obs.source === "llm-cap-rejected"
                      ? { deferCapTriggered: true }
                      : {}),
                  };
                  void recordJudgeVerdict(event, judgeTelemetryOpts);
                }
                if (judgeTrainingOpts.enabled) {
                  const pair: import("../extraction-judge-training.js").JudgeTrainingPair = {
                    version: 1,
                    ts,
                    candidateText: obs.candidate.text,
                    candidateCategory: obs.candidate.category,
                    ...(typeof obs.candidate.confidence === "number"
                      ? { candidateConfidence: obs.candidate.confidence }
                      : {}),
                    verdictKind,
                    reason: obs.verdict.reason,
                    priorDeferrals: obs.priorDeferrals,
                  };
                  void recordJudgeTrainingPair(pair, judgeTrainingOpts);
                }
              }
            : undefined;
        const judgeResult = await judgeFactDurability(
          judgeCandidates,
          this.deps.config,
          this.deps.getLocalLlm(),
          new FallbackLlmClient(
            this.deps.config.gatewayConfig,
            fallbackLlmRuntimeContextFromConfig(this.deps.config),
          ),
          this.deps.getJudgeVerdictCache(),
          this.deps.getJudgeDeferCounts(),
          judgeTelemetryHandler,
        );
        // Remap candidate-indexed verdicts to original fact indexes
        judgeVerdictsByFactIndex = new Map();
        for (const [candidateIdx, verdict] of judgeResult.verdicts) {
          const factIdx = candidateToFactIndex[candidateIdx];
          if (factIdx !== undefined) {
            judgeVerdictsByFactIndex.set(factIdx, verdict);
          }
        }
        log.info(
          `extraction-judge: ${judgeResult.verdicts.size}/${judgeCandidates.length} facts evaluated, ` +
            `${judgeResult.cached} cached, ${judgeResult.judged} judged, ` +
            `${judgeResult.deferred} deferred` +
            (judgeResult.deferredCappedToReject > 0
              ? ` (${judgeResult.deferredCappedToReject} cap-rejected)`
              : "") +
            `, ${judgeResult.elapsed}ms`,
        );
        // Expose defer count to the caller (issue #562 PR 2) so it can decide
        // whether to retain buffer turns for the next extraction pass.
        this.deps.setLastPersistExtractionDeferredCount(judgeResult.deferred);
      } catch (err) {
        // Fail-open: if the entire judge pipeline errors, proceed without filtering
        log.warn(
          `extraction-judge: pipeline error, proceeding without filtering (fail-open): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Faithfulness gate (issue #1576). Entailment-verification of extracted
    // facts against their verified source spans from #1575. Placement: after
    // parse + provenance validation, BEFORE persist/index (rule 44). The
    // substantive batch logic lives in the pure module; this is thin
    // delegation (ground rule 4). off → null map (byte-identical pre-feature
    // pipeline, rule 39); shadow → record only; enforce → pending_review.
    const faithfulnessMode = this.deps.config.extractionFaithfulnessGate;
    const faithfulnessResultsByFactIndex =
      faithfulnessMode === "shadow" || faithfulnessMode === "enforce"
        ? await runFaithfulnessGateBatch(
            facts,
            faithfulnessMode,
            this.deps.config,
            this.deps.getLocalLlm(),
            new FallbackLlmClient(
              this.deps.config.gatewayConfig,
              fallbackLlmRuntimeContextFromConfig(this.deps.config),
            ),
            this.deps.getFaithfulnessCounters(),
            sourceText,
          )
        : null;

    let factLoopIndex = -1;
    for (const fact of facts) {
      factLoopIndex++;
      if (
        !fact ||
        typeof (fact as any).content !== "string" ||
        !(fact as any).content.trim()
      ) {
        continue;
      }
      if (
        typeof (fact as any).category !== "string" ||
        !(fact as any).category.trim()
      ) {
        continue;
      }
      // Trim first (round 5): legacy writeMemory accepted " fact ".
      (fact as any).category = (fact as any).category.trim();
      // #2014/#2017 review round: an unrecognized non-empty category from
      // the extractor is a per-CANDIDATE defect. The composer keeps category
      // fatal even in salvage mode (identity field), so filter here — one
      // malformed model field must not abort the whole extraction batch.
      if (!isMemoryCategory((fact as any).category)) {
        log.warn(
          `persistExtraction: skipping fact with unrecognized category ${JSON.stringify((fact as any).category)}`,
        );
        continue;
      }
      (fact as any).tags = Array.isArray((fact as any).tags)
        ? (fact as any).tags.filter((t: any) => typeof t === "string")
        : [];
      (fact as any).confidence =
        typeof (fact as any).confidence === "number"
          ? (fact as any).confidence
          : 0.7;
      // #1670 — anchor each fact's event-time to its SOURCE TURN timestamp,
      // not the batch-wide latest. When a buffered conversation spans a date
      // boundary, a relative expression ("yesterday") on an early-turn fact
      // must resolve against that early turn's date. Prefer the fact's
      // explicit sourceTurnTimestamp, then the earliest provenance span's
      // observedAt, then fall back to the batch anchor (legacy extractors).
      const factAnchor = pickFactEventTimeAnchor(fact, sourceContext?.validAt);
      const biTemporal = this.deps.config.temporalBiTemporal && factAnchor ? resolveFactEventTime(fact.eventTime, factAnchor) : undefined;
      // Content-hash dedup check (v6.0)
      //
      // Canonicalize pre-tagged facts before hashing (Codex P2 — issue #369).
      // When a fact already carries an inline citation (e.g. relayed or
      // reprocessed), hashing `fact.content` as-is would produce a different
      // hash than the one stored from the original write (which used the raw,
      // un-cited body as contentHashSource). Strip any citation first so the
      // dedup key matches what the hash index recorded.
      //
      // stripCitationForTemplate handles both the default and custom template
      // formats. For all-placeholder templates it cannot detect citations and
      // returns the text unchanged — dedup may miss in that edge case, which
      // is acceptable (no false-positive suppression).
      //
      // Routing runs before content-hash dedup and scoring so category overrides
      // affect both the dedup fingerprint and importance (issue #519 procedure routing).
      let writeCategory = fact.category;
      let targetStorage = storage;
      const sourceStorageDir = storage.dir; // #1669 thread #2: pre-routing source ns for redaction gate
      // Track the KNOWN target namespace NAME alongside targetStorage (round 6,
      // codex P2 — NCQI0). Re-deriving it from `targetStorage.dir` mangles a raw
      // namespace literally named like a canonical token (e.g. `ns-616c706861`
      // served from its legacy raw dir decodes to `alpha`). We seed it from the
      // EXPLICIT base namespace the caller used to obtain `storage` (NHIdx, codex
      // P2) — `selfNamespace`/`writeNamespaceOverride` — so the catalog write touch
      // records the real namespace, not a guess decoded from the directory. We only
      // fall back to decoding the dir when no base namespace was passed (legacy
      // callers). The EXPLICIT routed name (below) still overrides this verbatim.
      let targetNamespaceName =
        baseNamespace && baseNamespace.length > 0
          ? baseNamespace
          : this.deps.storageDirNamespace(targetStorage.dir);
      let routedRuleId: string | undefined;
      let routedNamespaceExplicit = false;
      if (routeRules.length > 0) {
        try {
          const routeText = `${fact.category} ${fact.tags.join(" ")} ${fact.content}`;
          const selected = selectRouteRule(routeText, routeRules, routeOptions);
          if (selected) {
            routedRuleId = selected.rule.id;
            if (selected.target.category) {
              writeCategory = selected.target.category;
            }
            if (selected.target.namespace) {
              routedNamespaceExplicit = true;
              targetStorage = await this.deps.getStorageRouter().storageFor(
                selected.target.namespace,
              );
              targetNamespaceName = selected.target.namespace;
            }
          }
        } catch (err) {
          log.warn(
            `routing evaluation failed; fail-open to extracted category/namespace: ${err}`,
          );
        }
      }
      // Write-time subject stamp (issue #2372): extractor token over the
      // category default; absent when classification is disabled (byte-identical).
      const factSubject = this.deps.config.subjectClassification?.enabled === true
        ? resolveWriteSubject(writeCategory, fact.subject)
        : undefined;
      // Scope-based namespace routing: a `global` fact (no explicit routing
      // rule) promotes to the shared namespace unless a guard withholds it.
      if (
        lifecycleCaps.extractionScopeClassification &&
        namespacesEnabled &&
        fact.scope === "global" &&
        !routedNamespaceExplicit
      ) {
        const currentNs = this.deps.storageDirNamespace(targetStorage.dir);
        if (currentNs !== this.deps.config.sharedNamespace && profileAllowsSharedWrites) {
          if (shouldPromoteGlobalFactToShared({ scope: fact.scope, content: fact.content,
            sourceConnector, procedureSteps: fact.procedureSteps }) && subjectGuardAllows(fact.subject, "serverShared", "scope-routing")) {
            try {
              targetStorage = await this.deps.getStorageRouter().storageFor(
                this.deps.config.sharedNamespace,
              );
              targetNamespaceName = this.deps.config.sharedNamespace;
              log.debug(
                `scope-routing: fact "${fact.content.slice(0, 60)}…" routed to shared namespace (scope=global)`,
              );
            } catch (scopeRouteErr) {
              log.warn(
                `scope-routing: failed to resolve shared namespace storage; writing to session namespace (fail-open): ${scopeRouteErr}`,
              );
            }
          }
        } else if (currentNs !== this.deps.config.sharedNamespace) {
          log.debug(
            `scope-routing: skipped shared namespace for global fact because active scope profile ${scopeProfileWritePlan?.profileId ?? "none"} does not authorize serverShared writes`,
          );
        }
      }
      const harmonicFact: Omit<
        HarmonicConstructionInput["persistedFacts"][number],
        "memoryId"
      > = {
        category: writeCategory,
        content: fact.content,
        tags: fact.tags,
        cueAnchors: fact.cueAnchors,
        entityRef: fact.entityRef,
        validAt: biTemporal?.validFrom ?? sourceContext?.validAt,
      };
      const { status: injectionScreenStatus, tags: injectionScreenTags } = evaluateInjectionScreen({ content: fact.content, category: writeCategory, structuredAttributes: fact.structuredAttributes, procedureSteps: fact.procedureSteps }, resolveSecurityCapabilities(this.deps.config).injectionScreen, resolveSecurityCapabilities(this.deps.config).injectionScreenProfile);
      // #1669 redaction-rule gate: consult BOTH source and target namespace
      // rules before any write. A never-store pattern registered under the
      // source namespace must survive scope-routing to a different target
      // (review thread #2). Fails open on read error.
      try {
        const redactionRules = await redactionRulesFor(sourceStorageDir, targetStorage.dir);
        const redactionCandidate = fact.content
          + (fact.structuredAttributes ? " " + JSON.stringify(fact.structuredAttributes) : "")
          + (fact.procedureSteps ? " " + fact.procedureSteps.map((s) => `${s.intent} ${s.expectedOutcome ?? ""} ${s.toolCall ? `${s.toolCall.kind} ${s.toolCall.signature}` : ""}`.trim()).join(" ") : "");
        if (redactionRules.length > 0 && contentMatchesRedactionRules(redactionCandidate, redactionRules)) {
          redactionGatedCount++;
          log.debug(`extraction: redaction-rule withheld fact #${redactionGatedCount} in ${targetStorage.dir}`);
          continue;
        }
      } catch (redactionErr) {
        log.warn(`extraction: redaction-rule gate failed open: ${redactionErr}`);
      }

      // Procedures: fingerprint the full serialized body (title + steps), not
      // the title alone, so distinct step lists are not collapsed (issue #519).
      const canonicalContentForHash =
        citationEnabled &&
        hasCitationForTemplate(fact.content, citationTemplate)
          ? stripCitationForTemplate(fact.content, citationTemplate)
          : fact.content;
      const contentHashDedupKey =
        writeCategory === "procedure"
          ? buildProcedurePersistBody(fact.content, fact.procedureSteps)
          : canonicalContentForHash;
      // Importance is scored before the dedup short-circuit so #1671 backfill
      // can gate on it (cursor PRRT_OvKnS): a low-value duplicate that the
      // importance write-gate (#372) or the judge pre-filter would drop must
      // not expire an active fact.
      const importance = scoreImportance(
        fact.content,
        writeCategory,
        fact.tags,
      );
      let exactDuplicate = false;
      let needsCorpusConfirm = false;
      try {
        exactDuplicate = await this.deps.hasContentHashDedup(targetStorage, contentHashDedupKey);
        if (factDedupEnabled && !exactDuplicate) {
          // Fact dedup disabled → skip the authority check AND (via the guarded
          // corpus block below) corpus confirmation, so a disabled deployment
          // never suppresses a write via dedup (PR #2016 thread SD-nH). Enabled:
          // a MISS is trustworthy only against an AUTHORITATIVE index — re-check.
          if (await targetStorage.isFactContentHashAuthoritative()) {
            exactDuplicate = await this.deps.hasContentHashDedup(targetStorage, contentHashDedupKey);
          } else {
            needsCorpusConfirm = true;
          }
        }
      } catch (err) {
        // Dedup lookup failed (e.g. the authoritative rebuild could not run). Do
        // NOT fail-open into a possible duplicate — confirm against the corpus.
        needsCorpusConfirm = true;
        log.warn(
          `content-hash dedup lookup unavailable for storage ${targetStorage.dir}; confirming against corpus: ${err}`,
        );
      }
      // Connector-aware dedup (QOjlB): if the hash says duplicate — or the index
      // could not authoritatively confirm a miss — verify a same-content,
      // same-connector active fact exists across the hot+cold tiers. Different
      // connectors with the same content are NOT duplicates. Fail open (write) on
      // scan failure so an unverifiable state cannot silently drop content.
      if (factDedupEnabled && (exactDuplicate || needsCorpusConfirm)) {
        try {
          // #2016 cold-tier finding: the authoritative content-hash rebuild
          // unions the HOT and COLD tiers, so a hash hit can name an active copy
          // that was demoted to cold/. A hot-only confirmation scan misses it,
          // flips exactDuplicate back to false, and writes a second active hot
          // copy of the same content. Scan both tiers so a cold-only active copy
          // still confirms the duplicate and suppresses the redundant hot write.
          const [hotMems, coldMems] = await Promise.all([
            targetStorage.readAllMemories(),
            targetStorage.readAllColdMemories(),
          ]);
          const nc = sourceContext?.sourceConnector?.trim() || undefined;
          const matchesActiveDuplicate = (m: MemoryFile): boolean => {
            if (m.frontmatter.category !== writeCategory) return false;
            if ((m.frontmatter.status ?? "active") !== "active") return false;
            // Thread 5 (QPDE5): for procedures the hash is keyed on the full
            // body (title + steps via buildProcedurePersistBody), so compare
            // against contentHashDedupKey — not canonicalContentForHash which
            // is the title only. Thread 3 (QO42V): facts with
            // structuredAttributes get an appended [Attributes: ...] suffix in
            // the stored body that the hash key lacks; strip it before
            // comparing so same-connector enriched facts dedup correctly.
            if (normalizeStoredHashSource(stripAttributesSuffix(m.content ?? "")) !==
              ContentHashIndex.normalizeContent(contentHashDedupKey)) return false;
            return (m.frontmatter.sourceConnector?.trim() || undefined) === nc;
          };
          exactDuplicate =
            hotMems.some(matchesActiveDuplicate) || coldMems.some(matchesActiveDuplicate);
        } catch (err) {
          log.warn(
            `connector-aware dedup scan failed for storage ${targetStorage.dir}; writing fail-open: ${err instanceof Error ? err.message : String(err)}`,
          );
          exactDuplicate = false;
        }
      }
      if (exactDuplicate && injectionScreenStatus !== "pending_review") {
        // #1671 — before short-circuiting, backfill bi-temporal bounds
        // onto the existing source-namespace copy if it lacks bounds the
        // incoming fact now carries (re-extraction with a resolved invalidAt).
        // Skip when the fact would be rejected/deferred/pending by downstream
        // gates — a non-durable candidate must not expire an active fact
        // (chatgpt-codex P1: faithfulness, requireSpans, extraction judge).
        // #1671 + #1707: backfill bi-temporal bounds onto the existing
        // source-namespace copy if it lacks bounds the incoming fact now
        // carries (re-extraction with a resolved bound). #1707 thread 3:
        // gate on writeCategory === "fact" — the helper only matches facts,
        // so a non-fact duplicate must not reach the fact-only scan.
        // #1707 thread 2: also fire when only a corrected start bound
        // (validFrom) is present, not just an end bound (validUntil). The
        // downstream-gate skip still applies — a non-durable candidate must
        // not expire an active fact (chatgpt-codex P1).
        if (
          biTemporal &&
          writeCategory === "fact" &&
          (biTemporal.validUntil || biTemporal.validFrom)
        ) {
          const fr = faithfulnessResultsByFactIndex?.get(factLoopIndex);
          const faithfulnessWouldPending =
            faithfulnessMode === "enforce" &&
            fr?.ok === true &&
            (fr.verdict === "unsupported" || fr.verdict === "contradicted");
          const requireSpansWouldPending =
            this.deps.config.provenance?.requireSpans === true &&
            fact.requireSpansPending === true;
          const judgeVerdict = judgeVerdictsByFactIndex?.get(factLoopIndex);
          const judgeWouldGate =
            !this.deps.config.extractionJudgeShadow &&
            judgeVerdict !== undefined &&
            !judgeVerdict.durable;
          // Importance gate (cursor PRRT_OvKnS): below-threshold duplicates
          // would never persist (#372) and carry no judge verdict (the
          // pre-filter skips them), so they must not expire an active fact.
          if (
            isAboveImportanceThreshold(importance.level, this.deps.config.extractionMinImportanceLevel) &&
            !faithfulnessWouldPending &&
            !requireSpansWouldPending &&
            !judgeWouldGate
          ) {
            await this.deps.backfillTemporalBoundsOnDedupHit(
              targetStorage,
              contentHashDedupKey,
              {
                invalidAt: biTemporal.validUntil,
                // #1707 thread 2 — carry the corrected start bound too.
                validFrom: biTemporal.validFrom,
                observedAt: biTemporal.observedAt,
                eventTimeSource: biTemporal.eventTimeSource,
              },
              fact.entityRef,
              sourceContext?.sourceConnector,
            );
            // #1707 thread 1 — the source branch short-circuits (`continue`
            // below) before the promotion dedup paths run, so promoted
            // shared/profile copies written before the source fact carried
            // resolved bounds stay stale and cross-namespace recall surfaces
            // an expired fact. Backfill the promotion targets too (fail-open,
            // backfill-only — never writes a new promoted copy).
            await backfillTemporalBoundsOnPromotionCopies({
              sourceStorage: targetStorage,
              content: fact.content,
              category: writeCategory,
              confidence: fact.confidence,
              entityRef: fact.entityRef,
              structuredAttributes: fact.structuredAttributes,
              sourceConnector: sourceContext?.sourceConnector,
              bounds: {
                invalidAt: biTemporal.validUntil,
                validFrom: biTemporal.validFrom,
                observedAt: biTemporal.observedAt,
                eventTimeSource: biTemporal.eventTimeSource,
              },
            });
          }
        }
        log.debug(
          `dedup: skipping duplicate fact "${fact.content.slice(0, 60)}…" in storage ${targetStorage.dir}`,
        );
        dedupedCount++;
        continue;
      }
      if (writeCategory === "procedure" && this.deps.config.procedural?.enabled !== true && injectionScreenStatus !== "pending_review") {
        log.debug("persistExtraction: skip procedure memory (procedural.enabled is false)");
        continue;
      }

      // Importance write-gate (issue #372). Drop facts whose locally-scored
      // level falls below the configured minimum BEFORE the semantic dedup
      // lookup so that low-importance facts never incur an embedding search.
      // scoreImportance() already applies category boosts (e.g. corrections
      // +0.15) before deriving the level, so a correction at raw ~0.35
      // still lands at "normal" and passes the default gate. Without this
      // gate, trivial turn-level chatter ("hi", "k", heartbeat pings) gets
      // persisted as a fact memory and dilutes the store.
      if (
        injectionScreenStatus !== "pending_review" &&
        !isAboveImportanceThreshold(
          importance.level,
          this.deps.config.extractionMinImportanceLevel,
        )
      ) {
        importanceGatedCount++;
        const snippet = fact.content.slice(0, 60).replace(/\s+/g, " ").trim();
        log.debug(`extraction: skip trivial "${snippet}"`);
        // Log-based counter (no dedicated metric bus in remnic-core yet).
        // Operators can grep for `metric:importance_gated` in gateway.log
        // to tune extractionMinImportanceLevel.
        log.debug(
          `metric:importance_gated level=${importance.level} threshold=${this.deps.config.extractionMinImportanceLevel} category=${writeCategory} count=${importanceGatedCount}`,
        );
        continue;
      }

      // Extraction judge gate (issue #376 + #562 PR 2). After the local
      // importance gate passes, consult the judge verdict (computed before
      // the loop). In active mode, non-durable facts are dropped. In shadow
      // mode, verdicts are logged but all facts proceed to write.
      //
      // Defer verdicts (issue #562): do not persist now, but also do not
      // cache the outcome so the candidate is re-evaluated on a later
      // extraction pass. The judge module tracks how many times the same
      // content has been deferred and converts to reject at the configured
      // cap, so the orchestrator only needs to skip the write here.
      if (judgeVerdictsByFactIndex && injectionScreenStatus !== "pending_review") {
        const verdict = judgeVerdictsByFactIndex.get(factLoopIndex);
        if (verdict && !verdict.durable) {
          const verdictKind = getVerdictKind(verdict);
          if (this.deps.config.extractionJudgeShadow) {
            log.info(
              `extraction-judge[shadow]: would ${verdictKind} "${fact.content.slice(0, 60)}…" reason="${verdict.reason}"`,
            );
          } else if (verdictKind === "defer") {
            judgeGatedCount++;
            log.debug(
              `extraction-judge: deferred "${fact.content.slice(0, 60)}…" reason="${verdict.reason}"`,
            );
            continue;
          } else {
            judgeGatedCount++;
            log.debug(
              `extraction-judge: rejected "${fact.content.slice(0, 60)}…" reason="${verdict.reason}"`,
            );
            continue;
          }
        }
      }

      // Procedure extraction gate (issue #519): ≥2 steps + trigger phrasing.
      // Runs even when extractionJudgeEnabled is false (durability judge is unrelated).
      // Never tied to extractionJudgeShadow — that flag is only for the LLM durability judge.
      if (writeCategory === "procedure" && injectionScreenStatus !== "pending_review") {
        const procGate = validateProcedureExtraction({
          content: fact.content,
          procedureSteps: fact.procedureSteps,
        });
        if (!procGate.durable) {
          log.debug(
            `extraction-procedure-gate: rejected "${fact.content.slice(0, 60)}…" reason="${procGate.reason}"`,
          );
          continue;
        }
      }

      // Faithfulness gate verdict application (issue #1576). Look up the
      // pre-computed verdict for this fact and translate it to frontmatter +
      // an optional enforce-mode pending_review status. Logic lives in the
      // pure module; this is thin read-through (ground rule 4).
      const { faithfulness: faithfulnessFm, enforceStatus: faithfulnessGateStatus } =
        applyFaithfulnessVerdict(
          faithfulnessResultsByFactIndex,
          factLoopIndex,
          faithfulnessMode,
          fact.content,
          this.deps.getFaithfulnessCounters(),
        );

      // requireSpans enforcement (issue #1575 PR 2): when an operator opts
      // into provenance.requireSpans, a fact whose quote could not be located
      // in any source turn (carried as the transient requireSpansPending
      // signal from the extraction validator) routes to pending_review — the
      // same review queue an unsupported faithfulness verdict uses. This is
      // the persist-path wiring ProvenanceConfig.requireSpans documents.
      // Faithfulness takes precedence when it already routed the fact; both
      // gates agree on pending_review so the merge is a simple coalesce
      // (chatgpt-codex-connector thread 4xB).
      const requireSpansPendingStatus =
        this.deps.config.provenance?.requireSpans === true &&
        fact.requireSpansPending === true
          ? ("pending_review" as const)
          : undefined;
      const faithfulnessEnforceStatus = faithfulnessGateStatus ?? requireSpansPendingStatus ?? injectionScreenStatus;

      const novelty = await applyNoveltyGate({
        enabled: this.deps.config["noveltyGateEnabled"] === true,
        addThreshold: this.deps.config.noveltyAddThreshold,
        noopThreshold: this.deps.config.noveltyNoopThreshold,
        lookup: async () =>
          embeddingsFromCosineHits(
            await this.deps.semanticDedupLookup(
              fact.content,
              this.deps.config.semanticDedupCandidates,
              targetStorage,
            ),
            // Same connector scoping as decideSemanticDedup below: a
            // cross-connector neighbor must not noop this candidate.
            { candidateConnector: sourceContext?.sourceConnector },
          ),
      });
      let pendingSemanticSkip: (SemanticDedupDecision & { action: "skip" }) | null = null;
      if (novelty.decision !== "add" && resolvePipelineProcessingCapabilities(this.deps.config).semanticDedup && injectionScreenStatus !== "pending_review") {
        let semanticDecision: SemanticDedupDecision;
        // UUI2: skip embedding lookup for the rest of this batch once we know
        // the backend is unavailable. The flag is reset per-batch (set to false
        // at the top of persistExtraction), so a transient hiccup in one call
        // does not permanently disable dedup in subsequent calls.
        if (batchBackendUnavailable) {
          semanticDecision = { action: "keep", reason: "backend_unavailable" };
        } else {
          try {
            // Pass the resolved target storage so the lookup scopes the
            // embedding index to the target namespace (PR #399 P1 fix).
            // Without this, a high-similarity hit in a different namespace
            // would cause the fact to be dropped here — cross-namespace
            // write suppression / data loss.
            const lookupStorage = targetStorage;
            // PR #1852 review finding on 7e0eb1a0: forward the candidate's
            // sourceConnector so the connector-aware skip gate can refuse to
            // drop a connector B paraphrase against connector A's memory.
            semanticDecision = await decideSemanticDedup(
              fact.content,
              (content, limit) =>
                this.deps.semanticDedupLookup(content, limit, lookupStorage),
              {
                enabled: true,
                threshold: this.deps.config.semanticDedupThreshold,
                candidates: this.deps.config.semanticDedupCandidates,
                sourceConnector: sourceContext?.sourceConnector,
              },
            );
          } catch (err) {
            log.warn(
              `semantic dedup decision failed; failing open and writing fact: ${err}`,
            );
            semanticDecision = {
              action: "keep",
              reason: "backend_unavailable",
            };
          }
          // UUI2: cache the backend-unavailable signal for the rest of this batch.
          if (semanticDecision.reason === "backend_unavailable") {
            batchBackendUnavailable = true;
          }
        }
        if (semanticDecision.action === "skip") {
          pendingSemanticSkip = semanticDecision;
        }
      }

      const inferredIntent = resolveConversationContextCapabilities(this.deps.config).intentRouting
        ? inferIntentFromText(
            `${writeCategory} ${fact.tags.join(" ")} ${fact.content}`,
          )
        : null;
      const extractionWriteSource =
        (fact as any).source === "proactive"
          ? "extraction-proactive"
          : "extraction";
      const extractionSourceConnector = sourceContext?.sourceConnector;
      const factToolScoped = withholdToolScopedFromSharedNamespace({
        content: fact.content,
        sourceConnector: extractionSourceConnector,
        procedureSteps: fact.procedureSteps,
      });

      // Check for contradictions before writing (Phase 2B).
      // NOTE: This block was moved above the chunking branch so that the
      // pendingSemanticSkip guard (below) can also protect the chunking path.
      // Previously, contradiction detection only ran on the non-chunked path,
      // meaning chunked facts could be persisted even when semanticDecision was
      // "skip" (the deferred guard was bypassed by the chunking `continue`).
      let supersedes: string | undefined;
      let links: MemoryLink[] = [];
      // True when contradiction detection ran and confirmed a contradiction,
      // regardless of whether auto-resolve is enabled. Used by the
      // semantic-skip guard so that contradictory updates are never silently
      // dropped — even when `contradictionAutoResolve=false` (in which case
      // `supersedes` is intentionally left unset to avoid retiring the old
      // memory without user confirmation).
      let contradictionDetected = false;
      // #1645: hoist the contradiction result so the deferred auto-resolve
      // (post-write, gated on tombstone status) can read its fields.
      let contradiction: {
        supersededId: string;
        confidence: number;
        reason: string;
        supersededPath: string;
        supersededCreated: string;
        supersededTags: string[];
      } | null | undefined;

      // Faithfulness gate (#1576, chatgpt P2): skip contradiction detection
      // for a pending_review fact — an unfaithful extraction in the review queue
      // must not trigger auto-resolve and retire an existing active memory.
      if (
        resolveRecallEnhancementCapabilities(this.deps.config).contradictionDetection &&
        faithfulnessEnforceStatus !== "pending_review"
      ) {
        const targetNamespace = this.deps.storageDirNamespace(targetStorage.dir);
        const candidateEntityRef: unknown = fact.entityRef;
        const factEntityRef = typeof candidateEntityRef === "string" ? candidateEntityRef : undefined;
        contradiction = await this.deps.checkForContradiction(
          fact.content,
          writeCategory,
          targetNamespace,
          {
            entityRef: factEntityRef,
            structuredAttributes: fact.structuredAttributes,
            storageSnapshot: await anchorSnapshots.get(targetStorage, factEntityRef),
          },
        );
        if (contradiction) {
          contradictionDetected = true;
          // When auto-resolve is enabled the existing memory has already been
          // marked superseded; set `supersedes` so the new write carries the
          // relationship. When auto-resolve is disabled we still record the
          // contradiction link (so the memory is annotated for manual review)
          // but do NOT set `supersedes` on the new write — the old memory
          // remains active until a human resolves it.
          if (this.deps.config.contradictionAutoResolve) {
            supersedes = contradiction.supersededId;
          }
          links.push({
            targetId: contradiction.supersededId,
            linkType: "contradicts",
            strength: contradiction.confidence,
            reason: contradiction.reason,
          });
          // #1645: deindex + supersede are deferred to after writeMemory so the
          // caller can gate them on the new write's tombstone status. A
          // tombstone-blocked write (pending_review) must not deindex or retire
          // the existing active memory — see the post-write guard below.
        }
      }

      // Apply the deferred semantic-skip now that contradiction detection has
      // run. If a contradiction was found (contradictionDetected is true), the
      // candidate is a contradictory update and must be written — do not skip
      // it. Only drop it when there is no detected contradiction (true
      // near-duplicate). This check intentionally runs BEFORE the chunking
      // branch so that a fact flagged as a semantic near-duplicate cannot be
      // persisted (with its hash registered) simply because it was long enough
      // to trigger chunking.
      //
      // NOTE: We use `contradictionDetected` rather than `!!supersedes` here
      // so that facts are preserved even when `contradictionAutoResolve=false`.
      // When auto-resolve is disabled `supersedes` is intentionally unset, but
      // the write must still proceed so the user can manually reconcile the
      // two memories later.
      //
      // UUI1: correction category writes are NEVER suppressed by the semantic
      // skip fallback, regardless of whether supersedes is set. When contradiction
      // detection is disabled or QMD is unavailable, supersedes is never set —
      // without this exemption a high-similarity correction would be silently
      // dropped, leaving a stale fact active. writeCategory (not fact.category)
      // is used because routing rules may have overridden the raw category.
      const isCorrection = writeCategory === "correction";
      // Faithfulness gate (#1576, cursor High): a pending_review fact must
      // bypass the semantic-dedup skip so it reaches the review queue — the
      // gate's contract is "persists with status: pending_review, never
      // silently dropped" (issue #1576).
      if (
        (pendingSemanticSkip || novelty.decision === "noop") &&
        !contradictionDetected &&
        !isCorrection &&
        faithfulnessEnforceStatus !== "pending_review"
      ) {
        log.debug(
          `dedup: skipping ${pendingSemanticSkip ? "semantic near-duplicate" : "novelty-noop"} fact "${fact.content
            .slice(0, 60)
            .replace(/\s+/g, " ")}…" score=${(pendingSemanticSkip?.topScore ?? novelty.score).toFixed(
            3,
          )} neighbor=${pendingSemanticSkip?.topId ?? novelty.neighborId}`,
        );
        dedupedCount++;
        // Do NOT add fact.content to contentHashIndex here. No memory was
        // persisted for this fact, so registering a synthetic hash would
        // permanently suppress exact-copy writes once the neighbor memory is
        // archived or deleted (the hash would linger with no backing record).
        continue;
      }

      // Check if chunking is enabled and content should be chunked.
      // When semanticChunkingEnabled is true, prefer the embedding-based
      // semantic chunker which produces more coherent topic-aligned segments.
      // Falls back to the recursive sentence-boundary chunker on failure.
      if (resolvePipelineProcessingCapabilities(this.deps.config).chunking && writeCategory !== "procedure") {
        let chunkResult: { chunked: boolean; chunks: { content: string; index: number; tokenCount: number }[] };

        if (resolvePipelineProcessingCapabilities(this.deps.config).semanticChunking) {
          try {
            const embedFn = this.deps.getEmbeddingFallback().embedTexts.bind(this.deps.getEmbeddingFallback());
            const semanticResult: SemanticChunkResult = await semanticChunkContent(
              fact.content,
              embedFn,
              this.deps.config.semanticChunkingConfig,
            );
            chunkResult = semanticResult;
          } catch (err) {
            // Honor the fallbackToRecursive contract: when the user explicitly
            // disables fallback, re-throw so extraction fails fast instead of
            // silently using the recursive chunker. semanticChunkContent already
            // throws when fallback is disabled, but this outer catch swallowed
            // that signal. (PR #439 post-merge Finding 1.)
            if (this.deps.config.semanticChunkingConfig?.fallbackToRecursive === false) {
              throw err;
            }
            log.debug(
              `semantic chunking failed, falling back to recursive chunker: ${err}`,
            );
            chunkResult = chunkContent(fact.content, chunkingConfig);
          }
        } else {
          chunkResult = chunkContent(fact.content, chunkingConfig);
        }

        if (chunkResult.chunked && chunkResult.chunks.length > 1) {
          // Classify memory kind (v8.0 Phase 2B: HiMem episode/note dual store)
          const memoryKind = resolvePresentationCapabilities(this.deps.config).episodeNoteMode
            ? classifyMemoryKind(fact.content, fact.tags ?? [], writeCategory)
            : undefined;

          // Write the parent memory first (with full content for reference).
          //
          // Compute the cited content once so that writeMemory and writeArtifact
          // (when verbatim artifacts are enabled) share the same citation timestamp.
          // See the normal write path comment for the full dedup rationale.
          //
          // Propagate supersedes/links from contradiction detection (round 6
          // fix): contradiction detection now runs BEFORE this branch so the
          // parent must carry the supersession relationship — without it the
          // old memory is deindexed but the new chunked parent has no link
          // back, leaving a dangling deindex with no replacement reference.
          // Child chunks intentionally do NOT carry supersedes; only the
          // parent represents the logical memory unit.
          // Canonicalize contentHashSource before writing (Thread 3 — Codex P2,
          // issue #369). If fact.content already carries an inline citation
          // (e.g. re-processed or relayed fact), strip it so contentHashSource
          // records the raw un-cited body — matching what the dedup check hashes
          // via stripCitationForTemplate before calling hasFactContentHash.
          const rawChunkedContent =
            citationEnabled &&
            hasCitationForTemplate(fact.content, citationTemplate)
              ? stripCitationForTemplate(fact.content, citationTemplate)
              : fact.content;
          const citedChunkedContent = applyInlineCitation(rawChunkedContent);
          const parentWriteEnvelope = composeSalvagedExtractionEnvelope(
            {
              content: citedChunkedContent,
              category: writeCategory,
              origin, confidence: fact.confidence,
              tags: withReservedMarkerTag([...fact.tags, ...injectionScreenTags], "chunked"),
              entityRef: fact.entityRef,
              structuredAttributes: fact.structuredAttributes,
              validAt: biTemporal ? biTemporal.validFrom : sourceContext?.validAt,
              ...(extractionSourceConnector ? { sourceConnector: extractionSourceConnector } : {}),
            },
            { source: extractionWriteSource },
);
          const parentWrite = await targetStorage.writeSealedMemory(parentWriteEnvelope, {
            importance,
            supersedes,
            links: links.length > 0 ? links : undefined,
            intentGoal: inferredIntent?.goal,
            intentActionType: inferredIntent?.actionType,
            intentEntityTypes: inferredIntent?.entityTypes,
            memoryKind,
            ...(biTemporal ? { observedAt: biTemporal.observedAt, eventTimeSource: biTemporal.eventTimeSource, ...(biTemporal.validUntil ? { invalidAt: biTemporal.validUntil } : {}) } : {}),
            contentHashSource: rawChunkedContent,
            // Faithfulness gate (issue #1576).
            ...(faithfulnessFm ? { faithfulness: faithfulnessFm } : {}),
            ...(faithfulnessEnforceStatus ? { status: faithfulnessEnforceStatus } : {}),
            // Claim-level provenance spans (issue #1575 PR 2).
            ...(fact.sources && fact.sources.length > 0 ? { sources: fact.sources } : {}),
            ...(fact.provenance ? { provenance: fact.provenance } : {}),
            // PR #2016: never defer here — fallible chunk/artifact writes follow this
            // durable parent .md; flush the hash now so a throw can't strand it (dup).
            deferHashIndexSave: false,
            ...(factToolScoped ? { toolScoped: true as const } : {}),
          });
          const parentId = parentWrite.id;
          // #1645: surface the tombstone block and gate active post-write paths
          const tombstoneBlocked = parentWrite.tombstoneBlocked;
          const postWriteGuard =
            faithfulnessEnforceStatus === "pending_review" || tombstoneBlocked;
          // #1645: defer contradiction auto-resolve until tombstone status is
          // known (see applyDeferredContradictionResolve).
          const contradictionOutcome = await this.deps.applyDeferredContradictionResolve(
            contradiction,
            targetStorage,
            parentId,
            postWriteGuard,
          );
          if (contradictionOutcome === "resolved" || contradictionOutcome === "lost_race") {
            await anchorSnapshots.remove(targetStorage, contradiction!.supersededId);
          }
          try {
            // #2014 round 3: chunks inherit the PARENT ENVELOPE's surviving
            // tags (minus the parent-only "chunked" marker) and entityRef —
            // passing raw fact.tags let chunk frontmatter disagree with the
            // sealed parent and retain tags past the per-memory limits.
            const chunkTags = parentWriteEnvelope.tags.filter((tag) => tag !== "chunked");
            // Write individual chunks with parent reference
            for (const chunk of chunkResult.chunks) {
              // Score each chunk's importance separately
              const chunkImportance = scoreImportance(
                chunk.content,
                writeCategory,
                chunkTags,
              );
              const chunkWriteSource =
                (fact as any).source === "proactive"
                  ? "chunking-proactive"
                  : "chunking";

              await targetStorage.writeChunk(
                parentId,
                chunk.index,
                chunkResult.chunks.length,
                writeCategory,
                // Each chunk carries its own inline citation so provenance
                // survives when a single chunk is quoted in isolation.
                applyInlineCitation(chunk.content),
                {
                  // #2014 round 4: sealed parent's confidence — raw
                  // fact.confidence would let parent and chunk disagree.
                  confidence: parentWriteEnvelope.confidence,
                  tags: [...chunkTags],
                  entityRef: parentWriteEnvelope.entityRef,
                  source: chunkWriteSource,
                  importance: chunkImportance,
                  intentGoal: inferredIntent?.goal,
                  intentActionType: inferredIntent?.actionType,
                  intentEntityTypes: inferredIntent?.entityTypes,
                  memoryKind,
                  validAt: biTemporal ? biTemporal.validFrom : sourceContext?.validAt,
                  // #1578: propagate end bound + provenance to chunks (cursor bugbot).
                  ...(biTemporal
                    ? {
                        observedAt: biTemporal.observedAt,
                        eventTimeSource: biTemporal.eventTimeSource,
                        ...(biTemporal.validUntil
                          ? { invalidAt: biTemporal.validUntil }
                          : {}),
                      }
                    : {}),
                  // Faithfulness gate (issue #1576): propagate the parent
                  // fact's verdict + enforce status so a pending_review fact
                  // is not indexed as active through its chunks (chatgpt P2).
                  ...(faithfulnessFm ? { faithfulness: faithfulnessFm } : {}),
                  // #1645 (OchiE): inherit pending_review + blockedBy so no chunk lands active.
                  ...(postWriteGuard
                    ? { status: "pending_review" as const }
                    : (faithfulnessEnforceStatus ? { status: faithfulnessEnforceStatus } : {})),
                  ...(tombstoneBlocked && parentWrite.blockedBy
                    ? { blockedBy: parentWrite.blockedBy }
                    : {}),
                  // Claim-level provenance (issue #1575 PR 2): mirror the
                  // parent's spans onto each chunk so a chunk surfaced
                  // independently (memory_get/x-ray on a chunk ID) preserves
                  // the verified span (chatgpt-codex-connector thread Ocvmo).
                  ...(fact.sources && fact.sources.length > 0 ? { sources: fact.sources } : {}),
                  ...(fact.provenance ? { provenance: fact.provenance } : {}),
                  ...(extractionSourceConnector ? { sourceConnector: extractionSourceConnector } : {}), ...(origin ? { origin } : {}),
                  ...(factToolScoped ? { toolScoped: true as const } : {}),
                },
              );
            }
          } finally {
            // #1522: the catalog write touch lives in the storage chokepoint.
          }

          if (routedRuleId) {
            log.debug(
              `routing applied for chunked memory ${parentId}: rule=${routedRuleId} category=${writeCategory} storage=${targetStorage.dir}`,
            );
          }
          log.debug(
            `chunked memory ${parentId} into ${chunkResult.chunks.length} chunks`,
          );
          trackPersistedId(targetStorage, parentId, {
            pendingReview: postWriteGuard,
            category: writeCategory,
            harmonicFact,
          });
          await anchorSnapshots.replace(targetStorage, parentId, writeCategory, memoryPathById);
          // #1576 (cursor Medium): keep pending_review ids out of threadEpisodeIdsForGraph — else later active facts build thread-predecessor edges to an unfaithful memory.
          if (
            !postWriteGuard &&
            threadEpisodeIdsForGraph &&
            !threadEpisodeIdsForGraph.includes(parentId)
          ) {
            threadEpisodeIdsForGraph.push(parentId);
          }
          // #1645: same gate as the non-chunked path — a blocked chunked parent
          // must not enter the embedding-fallback index (resurrection).
          if (!postWriteGuard) {
            await this.deps.indexPersistedMemory(targetStorage, parentId);
          }
          // PR #402 Thread 1 fix: run source-namespace temporal supersession for
          // chunked writes, matching the non-chunked path.  Without this the
          // source namespace retains stale facts that should have been superseded.
          // Faithfulness gate (#1576, cursor High): skip supersession for a
          // pending_review fact — an unfaithful extraction in the review queue
          // must NOT retire older active memories.
          if (!postWriteGuard) {
            try {
              // #2014 round 2: same envelope-surviving key rule as the
              // non-chunked path.
              const temporalSupersession = await applyTemporalSupersession({
                storage: targetStorage,
                newMemoryId: parentId,
                entityRef: parentWriteEnvelope.entityRef,
                structuredAttributes: parentWriteEnvelope.rawStructuredAttributes
                  ? { ...parentWriteEnvelope.rawStructuredAttributes }
                  : undefined,
                // #1578 r3: an extracted end-only bound (validFrom absent) is
                // historical, not a new authoritative state — never let it
                // supersede a later active fact (codex P1 on :15534).
                createdAt: supersessionOrderingAt(biTemporal?.validFrom ?? sourceContext?.validAt),
                enabled: lifecycleCaps.temporalSupersession &&
                  !(biTemporal && !biTemporal.validFrom),
                dependencyPropagationDelivery: this.dependencyPropagationDelivery,
                namespaceScope: this.deps.storageDirNamespace(targetStorage.dir),
              });
              for (const supersededId of temporalSupersession.supersededIds) {
                await anchorSnapshots.remove(targetStorage, supersededId);
              }
            } catch (err) {
              log.warn(`temporal-supersession (chunked): unexpected error: ${err}`);
            }
          }
          // Faithfulness gate (#1576, chatgpt P2): do not promote a
          // pending_review fact to shared/profile — it must enter the review
          // queue without active copies that bypass the gate.
          if (!postWriteGuard) await promoteMemoryToShared({
            sourceStorage: targetStorage,
            category: writeCategory,
            content: fact.content,
            subject: factSubject,
            confidence: fact.confidence,
            tags: fact.tags,
            entityRef: fact.entityRef,
            structuredAttributes: fact.structuredAttributes,
            sourceMemoryId: parentId,
            importance,
            intentGoal: inferredIntent?.goal,
            intentActionType: inferredIntent?.actionType,
            intentEntityTypes: inferredIntent?.entityTypes,
            memoryKind,
            validAt: biTemporal ? biTemporal.validFrom : sourceContext?.validAt,
            ...(biTemporal
              ? {
                  observedAt: biTemporal.observedAt,
                  eventTimeSource: biTemporal.eventTimeSource,
                  ...(biTemporal.validUntil ? { invalidAt: biTemporal.validUntil } : {}),
                }
              : {}),
            source: extractionWriteSource,
            ...(extractionSourceConnector ? { sourceConnector: extractionSourceConnector } : {}),
            ...(fact.procedureSteps && fact.procedureSteps.length ? { procedureSteps: fact.procedureSteps } : {}),
            ...(fact.sources && fact.sources.length > 0 ? { sources: fact.sources } : {}),
            ...(fact.provenance ? { provenance: fact.provenance } : {}),
            harmonicFact,
          });
          // Register chunked content in the target storage hash index too.
          // Thread 3 fix: canonicalize by stripping any pre-existing citation
          // so the stored hash matches what the dedup check computes.
          try {
            const canonicalChunkedContent =
              citationEnabled &&
              hasCitationForTemplate(fact.content, citationTemplate)
                ? stripCitationForTemplate(fact.content, citationTemplate)
                : fact.content;
            // #1645: do NOT register a tombstone-blocked fact's content in the
            // dedup index — writeMemory already skipped it (rule 44). Re-adding
            // would let the next extraction dedup-skip the tombstone chokepoint
            // and silently ban the retired content (no pending_review row).
            if (!tombstoneBlocked) {
              await this.deps.addContentHashDedup(targetStorage, canonicalChunkedContent);
            }
          } catch (err) {
            log.warn(
              `content-hash dedup registration failed for chunked memory ${parentId}: ${err}`,
            );
          }

          for (const chunk of chunkResult.chunks) {
            const chunkId = `${parentId}-chunk-${chunk.index}`;
            // Do NOT push chunkId into persistedIds — chunk IDs must not leak
            // into boxBuilder.onExtraction() or threading.processTurn(), which
            // only expect canonical parent memory IDs.  Call indexPersistedMemory
            // directly for embedding-fallback sync of each chunk document.
            // #1645: chunks inherit pending_review under postWriteGuard — don't
            // index them into the embedding fallback (resurrection).
            if (!postWriteGuard) {
              await this.deps.indexPersistedMemory(targetStorage, chunkId);
            }
          }
          try {
            if (
              resolvePresentationCapabilities(this.deps.config).verbatimArtifacts &&
              this.deps.config.verbatimArtifactCategories.includes(writeCategory) &&
              fact.confidence >= this.deps.config.verbatimArtifactsMinConfidence &&
              !postWriteGuard
            ) {
              // Reuse citedChunkedContent so the artifact carries the same citation
              // timestamp as the parent memory write above (Fix #3 — duplicate-citation).
              await targetStorage.writeArtifact(citedChunkedContent, {
                confidence: fact.confidence,
                tags: [...fact.tags, "artifact", "chunked-parent"],
                artifactType: this.deps.artifactTypeForCategory(writeCategory),
                sourceMemoryId: parentId,
                intentGoal: inferredIntent?.goal,
                intentActionType: inferredIntent?.actionType,
                intentEntityTypes: inferredIntent?.entityTypes,
                ...(extractionSourceConnector ? { sourceConnector: extractionSourceConnector } : {}),
                ...(origin ? { origin } : {}),
                ...(factToolScoped ? { toolScoped: true as const } : {}),
              });
            }
            // v8.2: graph edge building for chunked memories. #1576: skip pending_review.
            if (graphCaps.multiGraphMemory && !postWriteGuard) {
              try {
                const graphContext = await ensureGraphContext(targetStorage);
                // #2014 round 4: graph identity must match the PERSISTED
                // memory — the envelope's surviving entityRef.
                const entityRef = parentWriteEnvelope.entityRef;
                const parentRelPath = resolvePersistedMemoryRelativePath({
                  memoryId: parentId,
                  pathById: graphContext.memoryPathById,
                  category: writeCategory,
                });
                graphContext.memoryPathById.set(parentId, parentRelPath);
                appendMemoryToGraphContext({
                  allMemsForGraph: graphContext.allMemsForGraph,
                  storageDir: targetStorage.dir,
                  memoryRelPath: parentRelPath,
                  memoryId: parentId,
                  category: writeCategory,
                  content: fact.content ?? "",
                  entityRef,
                });
                await this.deps.buildGraphEdge(
                  targetStorage,
                  parentRelPath,
                  entityRef,
                  parentId,
                  fact.content ?? "",
                  graphContext.allMemsForGraph,
                  graphContext.memoryPathById,
                  threadIdForExtraction ?? undefined,
                  threadEpisodeIdsForGraph,
                  graphContext.previousPersistedRelPath,
                  graphCaps,
                );
                graphContext.previousPersistedRelPath = parentRelPath;
              } catch {
                /* fail-open */
              }
            }
          } finally {
            // #1522: the catalog write touch lives in the storage chokepoint.
          }
          trackBehaviorSignals(
            targetStorage,
            buildBehaviorSignalsForMemory({
              memoryId: parentId,
              category: writeCategory,
              content: fact.content,
              namespace: this.deps.storageDirNamespace(targetStorage.dir),
              confidence: fact.confidence,
              source: "extraction",
            }),
          );
          continue; // Skip the normal write below
        }
      }

      // Suggest links for this memory (Phase 3A)
      if (resolveRecallEnhancementCapabilities(this.deps.config).memoryLinking && this.deps.getQmd().isAvailable()) {
        const targetNamespace = this.deps.storageDirNamespace(targetStorage.dir);
        const suggestedLinks = await this.deps.suggestLinksForMemory(
          fact.content,
          writeCategory,
          targetNamespace,
        );
        if (suggestedLinks.length > 0) {
          links.push(...suggestedLinks);
        }
      }

      // Classify memory kind (v8.0 Phase 2B: HiMem episode/note dual store)
      const memoryKind =
        writeCategory === "procedure"
          ? undefined
          : resolvePresentationCapabilities(this.deps.config).episodeNoteMode
            ? classifyMemoryKind(fact.content, fact.tags ?? [], writeCategory)
            : undefined;

      // Normal write (no chunking). Cite once so memory and artifact copies share one timestamp; hash the RAW pre-citation text. Merge-on-write (#2330): a judge-approved in-band match updates in place; uncarryable metadata, promoted copies, backend outage, and a novelty-add decision bypass to this write.
      const rawPersistBody = writeCategory === "procedure" ? buildProcedurePersistBody(fact.content, fact.procedureSteps) : fact.content;
      const citedFactContent = applyInlineCitation(rawPersistBody);
      const semanticMerge = await applySemanticMergeAtPersist(this.deps, {
        storage: targetStorage, content: fact.content, category: writeCategory, sources: fact.sources, sourceConnector: extractionSourceConnector,
        incomingMetadata: { tags: [...fact.tags, ...injectionScreenTags], entityRef: fact.entityRef, structuredAttributes: fact.structuredAttributes, validAt: biTemporal ? biTemporal.validFrom : sourceContext?.validAt, biTemporal: biTemporal !== undefined, importanceScore: importance.score, confidence: fact.confidence, provenanceStrength: fact.provenance, toolScoped: factToolScoped, subject: factSubject, origin, faithfulness: faithfulnessFm, memoryKind }, skip: contradictionDetected || faithfulnessEnforceStatus === "pending_review" || batchBackendUnavailable || novelty.decision === "add",
        incomingLinks: links.length > 0 ? links : undefined, incomingCitedContent: citedFactContent, incomingCitationContext: citationContextBase,
        targetHasPromotedCopies: (targetId) => promotedCopyProbe.check(targetStorage, targetId),
      });
      if (semanticMerge.action === "created" && semanticMerge.reason === "backend_unavailable") batchBackendUnavailable = true; // arms the batch short circuit for the remaining facts
      if (semanticMerge.action === "merged") {
        semanticMergedCount++;
        await anchorSnapshots.replace(targetStorage, semanticMerge.targetId, writeCategory, memoryPathById);
        // D + final round (A/B) + N+7 (A/B) + N+18 (B): with no promoted copies the create path's promotion must still run — fail-open, the merge stands — and its payload derives SOLELY from the re-read committed record (no field reads the incoming extraction; the null cases — replaced mid-flight, retired, degraded merge, or the isolated fail-open reread failure — are documented on buildMergedTargetPromotionPayload). After the current copy lands, any concurrently promoted PRE-merge copy is superseded. Promotion eligibility gates on the committed record's tier — the downgraded min(incoming, target) confidence where a lower incoming fact merged in.
        const mergedPromotion = await buildMergedTargetPromotionPayload(targetStorage, semanticMerge);
        // Round N+10 (A) + #2807 (finding 1): promotion AND reconciliation — including the no-promotion path, where a below-threshold downgrade or a degraded merge writes no replacement copy but a concurrently published PRE-merge copy must still retire. An UNREADABLE payload (readFailed) skips the destructive pass. See promoteAndReconcileMergedTarget.
        await promoteAndReconcileMergedTarget({ promote: (payload) => promoteMemoryToShared({ sourceStorage: targetStorage, ...payload }), config: this.deps.config, getStorageRouter: this.deps.getStorageRouter, scopeProfileWritePlan, sourceStorage: targetStorage, sourceMemoryId: semanticMerge.targetId, mergedPromotion: mergedPromotion.payload, mergedPromotionReadFailed: mergedPromotion.readFailed, normalize: normalizeStoredHashSource, onReconciled: () => promotedCopyProbe.invalidate() });
        // Round N+7 (D): the merged body joins the INTERNAL temporal/tag index refresh (id-keyed, incremental); the PUBLIC persistedIds return stays new-fragment only. Round N+11 (B): the target is also persisted into the thread's DURABLE episode set via the same appendEpisodeIds path the create path uses — the batch-local adjacency list is not durable, so without this the target leaves the thread at the next extraction.
        trackPersistedId(targetStorage, semanticMerge.targetId, { includeReturnedIds: false });
        await persistMergedTargetThreadEpisode(this.deps.getThreading(), threadIdForExtraction, semanticMerge.targetId);
        // Finding B (round N+3): enqueue the surviving target so the end-of-batch harmonic pass covers the committed merged claims.
        if (harmonicConstructionEnabled) {
          await enqueueMergedTargetForHarmonicConstruction(harmonicFactsByStorage, targetStorage, harmonicFact, semanticMerge.targetId, semanticMerge.mergedContent, new Date(harmonicSourceInsertedAtBase + harmonicSourceOrder++).toISOString());
        }
        // Round N+5 (A+B): create-path parity — the create path's graph-edge build and
        // behavior-signal ledger entry must also observe a committed merge.
        trackBehaviorSignals(targetStorage, await runMergedTargetPostEffects(this.deps, targetStorage, semanticMerge, {
          category: writeCategory, incomingContent: fact.content, incomingConfidence: fact.confidence,
          namespace: this.deps.storageDirNamespace(targetStorage.dir), graphCaps,
          graphContext: await ensureGraphContext(targetStorage),
          threadIdForEdge: threadIdForExtraction ?? undefined, threadEpisodeIdsForGraph,
        }));
        // Round N+17 (B): artifact write LAST; the helper isolates its own failure.
        await writeMergedVerbatimArtifact(this.deps, targetStorage, semanticMerge.targetId, { category: writeCategory, citedContent: citedFactContent, confidence: fact.confidence, tags: fact.tags, intent: inferredIntent ?? undefined, sourceConnector: extractionSourceConnector, origin, toolScoped: factToolScoped });
        continue;
      }
      const factWriteEnvelope = composeSalvagedExtractionEnvelope(
        {
          content: citedFactContent,
          category: writeCategory,
          origin, confidence: fact.confidence,
          tags: [...fact.tags, ...injectionScreenTags],
          entityRef: typeof fact.entityRef === "string" ? fact.entityRef : undefined,
          structuredAttributes: fact.structuredAttributes,
          validAt: biTemporal ? biTemporal.validFrom : sourceContext?.validAt,
          ...(extractionSourceConnector ? { sourceConnector: extractionSourceConnector } : {}),
          ...(factSubject !== undefined ? { subject: factSubject } : {}),
        },
        { source: extractionWriteSource },
);
      const factWrite = await targetStorage.writeSealedMemory(factWriteEnvelope, {
        importance,
        supersedes,
        links: links.length > 0 ? links : undefined,
        intentGoal: inferredIntent?.goal,
        intentActionType: inferredIntent?.actionType,
        intentEntityTypes: inferredIntent?.entityTypes,
        memoryKind,
        ...(biTemporal ? { observedAt: biTemporal.observedAt, eventTimeSource: biTemporal.eventTimeSource, ...(biTemporal.validUntil ? { invalidAt: biTemporal.validUntil } : {}) } : {}),
        contentHashSource: writeCategory === "fact" ? fact.content : undefined,
        // Faithfulness gate (issue #1576).
        ...(faithfulnessFm ? { faithfulness: faithfulnessFm } : {}),
        ...(faithfulnessEnforceStatus ? { status: faithfulnessEnforceStatus } : {}),
        // Claim-level provenance spans (issue #1575 PR 2). Carry verified
        // sources + the coarse strength tag from the extraction validator
        // through to frontmatter so they survive end-to-end.
        ...(fact.sources && fact.sources.length > 0 ? { sources: fact.sources } : {}),
        ...(fact.provenance ? { provenance: fact.provenance } : {}),
        // #1909: defer the per-fact index flush to the batch save only when
        // fact dedup is on (the batch saver is a no-op otherwise).
        deferHashIndexSave: factDedupEnabled,
        ...(factToolScoped ? { toolScoped: true as const } : {}),
      });
      const memoryId = factWrite.id;
      // #1645: surface the tombstone block; gate active post-write paths like #1576
      // so a blocked fact creates no active shared copy / supersession / graph entry.
      const tombstoneBlocked = factWrite.tombstoneBlocked;
      const postWriteGuard = faithfulnessEnforceStatus === "pending_review" || tombstoneBlocked;
      // #1645: defer contradiction auto-resolve until tombstone status is
      // known (see applyDeferredContradictionResolve).
      try {
        const contradictionOutcome = await this.deps.applyDeferredContradictionResolve(
          contradiction,
          targetStorage,
          memoryId,
          postWriteGuard,
        );
        if (contradictionOutcome === "resolved" || contradictionOutcome === "lost_race") {
          await anchorSnapshots.remove(targetStorage, contradiction!.supersededId);
        }
      } catch (err) {
        await flushDeferredFactHashOnFailure(() => this.deps.saveContentHashIndexes(), factDedupEnabled);
        throw err;
      }
      if (routedRuleId) {
        log.debug(
          `routing applied for memory ${memoryId}: rule=${routedRuleId} category=${writeCategory} storage=${targetStorage.dir}`,
        );
      }
      // Temporal supersession (issue #375): when the new fact has structured
      // attributes, retire any older fact with the same entity + attribute
      // key that has a conflicting value. Faithfulness gate (#1576, cursor
      // High): skip for a pending_review fact — an unfaithful extraction in
      // the review queue must NOT retire older active memories.
      if (!postWriteGuard) {
        try {
          const temporalSupersession = await applyTemporalSupersession({
            storage: targetStorage,
            newMemoryId: memoryId,
            entityRef: factWriteEnvelope.entityRef,
            structuredAttributes: factWriteEnvelope.rawStructuredAttributes
              ? { ...factWriteEnvelope.rawStructuredAttributes }
              : undefined,
            createdAt: supersessionOrderingAt(biTemporal?.validFrom ?? sourceContext?.validAt),
            enabled: lifecycleCaps.temporalSupersession &&
              !(biTemporal && !biTemporal.validFrom),
            dependencyPropagationDelivery: this.dependencyPropagationDelivery,
            namespaceScope: this.deps.storageDirNamespace(targetStorage.dir),
          });
          for (const supersededId of temporalSupersession.supersededIds) {
            await anchorSnapshots.remove(targetStorage, supersededId);
          }
        } catch (err) {
          log.warn(`temporal-supersession: unexpected error: ${err}`);
        }
      }
      try {
        trackBehaviorSignals(
          targetStorage,
          buildBehaviorSignalsForMemory({
            memoryId,
            category: writeCategory,
            content: fact.content,
            namespace: this.deps.storageDirNamespace(targetStorage.dir),
            confidence: fact.confidence,
            source: "extraction",
          }),
        );
        trackPersistedId(targetStorage, memoryId, {
          pendingReview: postWriteGuard,
          category: writeCategory,
          harmonicFact,
        });
        await anchorSnapshots.replace(targetStorage, memoryId, writeCategory, memoryPathById);
        if (
          !postWriteGuard &&
          threadEpisodeIdsForGraph &&
          !threadEpisodeIdsForGraph.includes(memoryId)
        ) {
          threadEpisodeIdsForGraph.push(memoryId);
        }
        // #1645: a tombstone-blocked / pending_review fact must NOT enter the
        // embedding-fallback index — otherwise embedding recall surfaces the
        // pending_review row (resurrection). Gate on postWriteGuard like the
        // surrounding supersession / promotion / graph paths.
        if (!postWriteGuard) {
          await this.deps.indexPersistedMemory(targetStorage, memoryId);
        }
        // Faithfulness gate (#1576, chatgpt P2): skip promotion for a
        // pending_review fact so no active shared/profile copy bypasses the gate.
        if (!postWriteGuard) { await promoteMemoryToShared({
          sourceStorage: targetStorage,
          category: writeCategory,
          content: fact.content,
          confidence: fact.confidence,
          subject: factSubject,
          tags: fact.tags,
          entityRef:
            typeof (fact as any).entityRef === "string"
              ? (fact as any).entityRef
              : undefined,
          structuredAttributes: fact.structuredAttributes,
          sourceMemoryId: memoryId,
          importance,
          intentGoal: inferredIntent?.goal,
          intentActionType: inferredIntent?.actionType,
          intentEntityTypes: inferredIntent?.entityTypes,
          memoryKind,
          validAt: biTemporal ? biTemporal.validFrom : sourceContext?.validAt,
          ...(biTemporal
            ? {
                observedAt: biTemporal.observedAt,
                eventTimeSource: biTemporal.eventTimeSource,
                ...(biTemporal.validUntil ? { invalidAt: biTemporal.validUntil } : {}),
              }
            : {}),
          source: extractionWriteSource,
          ...(extractionSourceConnector ? { sourceConnector: extractionSourceConnector } : {}),
          ...(fact.procedureSteps && fact.procedureSteps.length ? { procedureSteps: fact.procedureSteps } : {}),
          ...(fact.sources && fact.sources.length > 0 ? { sources: fact.sources } : {}),
          ...(fact.provenance ? { provenance: fact.provenance } : {}),
          harmonicFact,
        }); promotedCopyProbe.invalidate(); }
        // v8.2: graph edge building (fail-open). #1576: skip pending_review facts.
        if (graphCaps.multiGraphMemory && !postWriteGuard) {
          try {
            const graphContext = await ensureGraphContext(targetStorage);
            // #2014 round 4: envelope-surviving entityRef (see chunked path).
            const entityRef = factWriteEnvelope.entityRef;
            const memoryRelPath = resolvePersistedMemoryRelativePath({
              memoryId,
              pathById: graphContext.memoryPathById,
              category: writeCategory,
            });
            graphContext.memoryPathById.set(memoryId, memoryRelPath);
            appendMemoryToGraphContext({
              allMemsForGraph: graphContext.allMemsForGraph,
              storageDir: targetStorage.dir,
              memoryRelPath: memoryRelPath,
              memoryId,
              category: writeCategory,
              content: fact.content ?? "",
              entityRef,
            });
            await this.deps.buildGraphEdge(
              targetStorage,
              memoryRelPath,
              entityRef,
              memoryId,
              fact.content ?? "",
              graphContext.allMemsForGraph,
              graphContext.memoryPathById,
              threadIdForExtraction ?? undefined,
              threadEpisodeIdsForGraph,
              graphContext.previousPersistedRelPath,
              graphCaps,
            );
            graphContext.previousPersistedRelPath = memoryRelPath;
          } catch {
            /* fail-open */
          }
        }
        if (
          resolvePresentationCapabilities(this.deps.config).verbatimArtifacts &&
          this.deps.config.verbatimArtifactCategories.includes(writeCategory) &&
          fact.confidence >= this.deps.config.verbatimArtifactsMinConfidence &&
          !postWriteGuard
        ) {
          // Reuse citedFactContent so the artifact carries the same citation
          // timestamp as the memory write above (Fix #3 — duplicate-citation).
          await targetStorage.writeArtifact(citedFactContent, {
            confidence: fact.confidence,
            tags: [...fact.tags, "artifact"],
            artifactType: this.deps.artifactTypeForCategory(writeCategory),
            sourceMemoryId: memoryId,
            intentGoal: inferredIntent?.goal,
            intentActionType: inferredIntent?.actionType,
            intentEntityTypes: inferredIntent?.entityTypes,
            ...(extractionSourceConnector ? { sourceConnector: extractionSourceConnector } : {}),
            ...(origin ? { origin } : {}),
            ...(factToolScoped ? { toolScoped: true as const } : {}),
          });
        }
        // Register in the target storage content-hash index after successful
        // write. Thread 3 fix: canonicalize by stripping any pre-existing
        // citation so the stored hash matches what the dedup check computes.
        try {
          const canonicalFactContent =
            citationEnabled &&
            hasCitationForTemplate(fact.content, citationTemplate)
              ? stripCitationForTemplate(fact.content, citationTemplate)
              : fact.content;
          const hashRegisterKey =
            writeCategory === "procedure"
              ? buildProcedurePersistBody(fact.content, fact.procedureSteps)
              : canonicalFactContent;
          // #1645: do NOT register a tombstone-blocked fact's content in the dedup
          // index (rule 44 defeat) — see chunked path comment.
          if (!tombstoneBlocked) {
            await this.deps.addContentHashDedup(targetStorage, hashRegisterKey);
          }
        } catch (err) {
          log.warn(
            `content-hash dedup registration failed for memory ${memoryId}: ${err}`,
          );
        }
      } catch (err) {
        // PR #2016: flush the deferred fact-hash before propagating so a durable
        // .md never outlives a missing shared fact-hash index entry.
        await flushDeferredFactHashOnFailure(() => this.deps.saveContentHashIndexes(), factDedupEnabled);
        throw err;
      }
    }

    // Tracks whether THIS extraction persisted any durable, non-fact output
    // (entity / relationship / profile / question) to the BASE namespace.
    // A fact-less extraction still records exactly one base-namespace catalog
    // touch after all writes complete (NHZEZ, codex P2).
    let durableNonFactWritten = false;
    let durableNonFactTouchRecorded = false;
    const touchBaseNonFactNamespace = () => {
      const baseTouchNamespace =
        baseNamespace && baseNamespace.length > 0
          ? baseNamespace
          : this.deps.storageDirNamespace(storage.dir);
    };
    const recordDurableNonFactWrite = () => {
      durableNonFactWritten = true;
      if (durableNonFactTouchRecorded) return;
      durableNonFactTouchRecorded = true;
      touchBaseNonFactNamespace();
    };
    // #1955 review: entity fields are screened before entering the index (screenEntityForIndex).
    const entityScreenOn = resolveSecurityCapabilities(this.deps.config).injectionScreen;
    const entityScreenProfile = resolveSecurityCapabilities(this.deps.config).injectionScreenProfile;
    for (const entity of entities) {
      try {
        const screened = screenEntityForIndex(entity, entityScreenOn, entityScreenProfile);
        if (!screened) continue;
        if (screened.withheldRules.length > 0) log.warn(`persistExtraction: injection screen withheld ${screened.withheldRules.length} entity field(s) for "${screened.name}" [${screened.withheldRules.join(", ")}]`);
        if (screened.withheld) continue;
        const id = await storage.writeEntity(screened.name, screened.type, screened.facts, {
          source: screened.source,
          timestamp: sourceContext?.validAt,
          sessionKey: sourceContext?.sessionKey,
          principal: sourceContext?.principal,
          origin,
          structuredSections: screened.structuredSections,
        });
        if (id) {
          trackPersistedId(storage, id);
          recordDurableNonFactWrite();
        }
      } catch (err) {
        log.warn(`persistExtraction: entity write failed: ${err}`);
      }
    }
    // Persist entity relationships (v7.0). #1955 review: source/label/target are screened.
    if (
      resolveRecallEnhancementCapabilities(this.deps.config).entityRelationships &&
      Array.isArray(result.relationships)
    ) {
      for (const rel of result.relationships.slice(0, 5)) {
        if (!rel.source || !rel.target || !rel.label) continue;
        const relScreen = screenPersistStrings([`${rel.source}\n${rel.label}\n${rel.target}`,
          `${rel.target}\n${rel.label} (reverse)\n${rel.source}`], entityScreenOn, entityScreenProfile);
        if (relScreen.warning) {
          log.warn(`persistExtraction(relationship): ${relScreen.warning}`);
          continue;
        }
        try {
          await storage.addEntityRelationship(rel.source, { target: rel.target, label: rel.label });
          recordDurableNonFactWrite();
          await storage.addEntityRelationship(rel.target, { target: rel.source, label: `${rel.label} (reverse)` });
          recordDurableNonFactWrite();
        } catch (err) {
          log.debug(`relationship persist failed: ${err}`);
        }
      }
    }

    // Persist entity activity (v7.0)
    if (resolveRecallEnhancementCapabilities(this.deps.config).entityActivityLog) {
      const today = new Date().toISOString().slice(0, 10);
      for (const entity of entities) {
        const name = (entity as any)?.name;
        const type = (entity as any)?.type;
        if (typeof name !== "string" || typeof type !== "string") continue;
        try {
          const normalized = storage.normalizeEntityName(name, type);
          await storage.addEntityActivity(
            normalized,
            { date: today, note: "Mentioned in conversation" },
            this.deps.config.entityActivityLogMaxEntries,
          );
        } catch (err) {
          log.debug(`activity persist failed: ${err}`);
        }
      }
    }
    // #1955 review: profile + questions render verbatim into model context —
    // screened; questions screen question+context JOINED (routing: #2397).
    const profileScreen = screenPersistStrings(profileUpdates, entityScreenOn, entityScreenProfile);
    if (profileScreen.warning) log.warn(`persistExtraction(profile): ${profileScreen.warning}`);
    if (profileScreen.kept.length > 0) {
      await storage.appendToProfile(profileScreen.kept);
      recordDurableNonFactWrite();
    }

    for (const q of questions) {
      const qScreen = screenPersistStrings([`${q.question}\n${q.context ?? ""}`], entityScreenOn, entityScreenProfile);
      if (qScreen.warning) {
        log.warn(`persistExtraction(question): ${qScreen.warning}`);
        continue;
      }
      const id = await storage.writeQuestion(q.question, q.context, q.priority);
      if (id) {
        trackPersistedId(storage, id);
        recordDurableNonFactWrite();
      }
    }

    // Persist identity reflection (screened — #1955): durable namespace-local
    // state; identity-ONLY extraction still counts as durable non-fact (NIIly).
    if (resolveRecallEnhancementCapabilities(this.deps.config).identity && result.identityReflection) {
      const idScreen = screenPersistStrings([result.identityReflection], entityScreenOn, entityScreenProfile);
      if (idScreen.warning) log.warn(`persistExtraction(identity): ${idScreen.warning}`);
      else {
        try {
          await storage.appendIdentityReflection(result.identityReflection);
          recordDurableNonFactWrite();
        } catch (err) {
          log.debug(`identity reflection write failed: ${err}`);
        }
      }
    }

    // Catalog touch for durable NON-FACT outputs (NHZEZ / NIIly, codex P2). The
    // per-fact catalog touch (storage chokepoint #1522) above only fires inside the fact write loop, so
    // an extraction that persists ONLY entities, relationships, profile updates,
    // questions, or an identity reflection (no facts) would record durable data to
    // the BASE namespace's storage without ever touching the catalog — leaving that
    // namespace's `lastWriteAt` stale so `listNamespaces({writtenSince})` /
    // write-recency QMD maintenance miss the write. All of these are written to the
    // BASE `storage` (not the per-fact routed `targetStorage`), so we record ONE
    // base-namespace touch here, AFTER every non-fact write completes. Use the
    // KNOWN base namespace name, not a dir-decoded guess (NCQI0). One touch per
    // namespace per extraction — `markWrite` is idempotent, so if the fact path
    // already touched the base namespace this only refreshes `lastWriteAt`.
    // Best-effort and failure-tolerant (storage chokepoint #1522 swallows errors).
    if (durableNonFactWritten) {
      touchBaseNonFactNamespace();
    }

    // Save any content-hash indexes touched during the batch via the removal-
    // aware, lock-held reconciling save (issue #1909). Round 11: the fact-hash
    // index is rebuilt from the corpus on every restart (no ready marker), so
    // this on-disk write is the in-process persisted view — never a cross-restart
    // trust anchor. A deferred write whose addContentHashDedup threw is still
    // safe: the fact .md is durable and the next restart's rebuild includes it.
    await this.deps.saveContentHashIndexes().catch((err) => {
      log.warn(`content-hash index save failed: ${err}`);
    });

    for (const {
      storage: targetStorage,
      events,
    } of behaviorSignalsByStorage.values()) {
      const dedupedSignals = dedupeBehaviorSignalsByMemoryAndHash(events);
      if (dedupedSignals.length === 0) continue;
      await targetStorage
        .appendBehaviorSignals(dedupedSignals)
        .catch((err) =>
          log.warn(`appendBehaviorSignals failed (non-fatal): ${err}`),
        );
    }

    const dedupSuffix = `${dedupedCount > 0 ? ` (${dedupedCount} deduped)` : ""}${semanticMergedCount > 0 ? ` (${semanticMergedCount} merged)` : ""}`;
    const gatedSuffix =
      importanceGatedCount > 0 ? ` (${importanceGatedCount} gated)` : "";
    const judgeSuffix =
      judgeGatedCount > 0 ? ` (${judgeGatedCount} judge-rejected)` : "";
    const redactionSuffix =
      redactionGatedCount > 0 ? ` (${redactionGatedCount} redacted)` : "";
    log.info(
      `persisted: ${facts.length - dedupedCount - importanceGatedCount - judgeGatedCount - redactionGatedCount - semanticMergedCount} facts${dedupSuffix}${gatedSuffix}${judgeSuffix}${redactionSuffix}, ${entities.length} entities, ${questions.length} questions, ${profileUpdates.length} profile updates`,
    );
    if (harmonicConstructionEnabled && harmonicFactsByStorage.size > 0) {
      await persistConstructedHarmonicRecords({
        entries: harmonicFactsByStorage.values(),
        baseStorageDir: storage.dir,
        abstractionNodeStoreDir:
          !scopeProfileWritePlan && harmonicBaseNamespace === this.deps.config.defaultNamespace
            ? this.deps.config.abstractionNodeStoreDir
            : undefined,
        sessionKey: sourceContext?.sessionKey,
        validAt: sourceContext?.validAt,
        episodeTitle: result.episodeTitle,
        anchorsEnabled: harmonicAnchorsEnabled,
        entityMentions: entities,
      });
    }
    // Update temporal + tag indexes (v8.1) — fire-and-forget, fail-open
    void (async () => {
      if (persistedIdsByStorage.size === 0) {
        await this.deps.updateTemporalTagIndexes(storage, []);
        return;
      }
      for (const entry of persistedIdsByStorage.values()) {
        await this.deps.updateTemporalTagIndexes(entry.storage, entry.ids);
      }
    })().catch((err) =>
      log.debug(`temporal-index update error (non-fatal): ${err}`),
    );
    // #1635: surface pending_review ids so the thread episode set excludes them.
    this.deps.setLastPersistExtractionPendingReviewIds(pendingReviewPersistedIds);
    // Return the persisted fact IDs for threading
    return { persistedIds, memoryPathById };
  }
}
