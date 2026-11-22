import { classifyExtractionOrigin, type ExtractionSourceContext } from "./extraction-origin-context.js";
import { confirmActiveFactDuplicate, persistUnderFactDedupWindow } from "./fact-dedup-window.js";
import { writePromotionUnderFactDedupWindow } from "./promotion-dedup-window.js";
import { type ArgsAfterFinalization, CommittedWriteFinalization, rethrowAfterCommittedWriteFinalization } from "./extraction-persist-failure.js";
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
import { buildBehaviorSignalsForMemory } from "../behavior-signals.js";
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
  finalizeExtractionCommittedWrites,
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
import { enqueueMergedTargetForHarmonicConstruction } from "./harmonic-construction-persist.js";
import { applySemanticMergeAtPersist, runMergedTargetPostEffects, writeMergedVerbatimArtifact } from "./semantic-merge-persist.js";
import { buildMergedTargetPromotionPayload } from "./semantic-merge-promotion-payload.js";
import { persistMergedTargetThreadEpisode } from "./semantic-merge-commit-effects.js";
import { ExtractionAnchorSnapshot } from "./extraction-anchor-snapshot.js";
import {
  applyInlineCitation as applyInlineCitationToContent,
  normalizeStoredHashSource as normalizeStoredHashSourceContent,
} from "./extraction-persist-citation.js";

/** One extraction run's persist outcome: per-run values, no shared side channels (#1526). */
export interface ExtractionPersistResult {
  persistedIds: string[];
  memoryPathById: Map<string, string>;
  /** Facts the judge deferred — drives this run's buffer retention (#562). */
  deferredCount: number;
  /** Persisted pending_review ids, excluded from the thread episode set (#1635). */
  pendingReviewIds: string[];
}

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

  persistExtraction(...args: ArgsAfterFinalization<Parameters<ExtractionPersistCoordinator["persistExtractionPass"]>>): Promise<ExtractionPersistResult> {
    const finalization = new CommittedWriteFinalization(); // #3288: one batch-end finalization boundary per pass
    return finalization.run(() => this.persistExtractionPass(finalization, ...args));
  }

  private async persistExtractionPass(
    finalization: CommittedWriteFinalization,
    result: ExtractionResult,
    storage: StorageManager,
    threadIdForExtraction?: string | null,
    sourceContext?: ExtractionSourceContext,
    baseNamespace?: string,
    scopeProfileWritePlan?: ResolvedScopeProfilePlan | null,
    sourceText?: string,
    graphCaps: GraphConstructionCapabilitySet = resolveGraphConstructionCapabilities(this.deps.config),
    lifecycleCaps: MemoryLifecycleCapabilitySet = resolveMemoryLifecycleCapabilities(this.deps.config),
  ): Promise<ExtractionPersistResult> {
    const citationEnabled = resolvePipelineProcessingCapabilities(this.deps.config).inlineSourceAttribution === true;
    const citationTemplate = this.deps.config.inlineSourceAttributionFormat;
    const citationHistory = this.deps.config.inlineSourceAttributionFormatHistory;
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

    const normalizeStoredHashSource = (raw: string): string =>
      normalizeStoredHashSourceContent(raw, citationEnabled, citationTemplate, citationHistory);
    const citationContextBase: Omit<CitationContext, "ts"> = citationEnabled
      ? {
          agent: sourceContext?.principal,
          session: sourceContext?.sessionKey,
        }
      : {};
    const applyInlineCitation = (content: string): string =>
      applyInlineCitationToContent(content, citationEnabled, citationTemplate, citationContextBase, citationHistory);
    const persistedIds: string[] = [];
    const memoryPathById = new Map<string, string>();
    const anchorSnapshots = new ExtractionAnchorSnapshot({
      enabled: coerceBool(this.deps.config.contradictionLocalization?.anchorEnabled) ?? true,
      candidateLimit: this.deps.config.contradictionLocalization?.anchorCandidates,
      onRefreshError: (error) => log.warn(`anchor snapshot update failed; using empty snapshot: ${error}`),
    });
    const supersessionOrderingAt = (validAt?: string): string =>
      validAt && validAt.length > 0 ? validAt : new Date().toISOString();
    const pendingReviewPersistedIds: string[] = [];
    let deferredCount = 0;
    const persistedIdsByStorage = new Map<string, { storage: StorageManager; ids: string[] }>();
    const trackPersistedId = (
      targetStorage: StorageManager,
      id: string,
      options: {
        includeReturnedIds?: boolean;
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
    let importanceGatedCount = 0;
    let batchBackendUnavailable = false;
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
    const namespacesEnabled = resolveNamespaceCapabilities(this.deps.config).namespaces;
    const sourceConnector = sourceContext?.sourceConnector; const origin = classifyExtractionOrigin(sourceContext);
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
        citationEnabled && hasCitationForTemplate(options.content, citationTemplate, citationHistory)
          ? stripCitationForTemplate(options.content, citationTemplate, citationHistory)
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
            if (options.invalidAt || options.validAt) {
              await this.deps.backfillTemporalBoundsOnDedupHit(
                targetStorage,
                dedupContent,
                {
                  invalidAt: options.invalidAt,
                  validFrom: options.validAt,
                  ...(options.observedAt ? { observedAt: options.observedAt } : {}),
                  ...(options.eventTimeSource ? { eventTimeSource: options.eventTimeSource } : {}),
                },
                targetPromotionEnvelope.entityRef,
                sourceContext?.sourceConnector,
              );
            }
            continue;
            }
          }
          const promotionWrite = await writePromotionUnderFactDedupWindow({
            destination: targetStorage,
            envelope: targetPromotionEnvelope,
            promotion: options,
            dedupContent,
            rawContent,
            toolScoped: options.toolScoped === true,
            connector: sourceContext?.sourceConnector,
            citationEnabled,
            citationTemplate,
            sameEntityGuardEnabled: false,
            survivingAttrs: targetSurvivingAttrs,
            supersession: { supersessionEnabled: lifecycleCaps.temporalSupersession, dependencyPropagationDelivery: this.dependencyPropagationDelivery, namespaceScope: this.deps.storageDirNamespace(targetStorage.dir) },
            backfillTemporalBoundsOnDedupHit: this.deps.backfillTemporalBoundsOnDedupHit,
          });
          if (promotionWrite.suppressed) continue;
          const targetPromotion = promotionWrite.result;
          const promotedId = targetPromotion.id;
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
      invalidAt?: string;
      observedAt?: string;
      eventTimeSource?: "extracted" | "assumed";
      source: string;
      origin?: string;
      sourceConnector?: string;
      /** Committed-record tool-scope marker — see {@link promotionWithholdsToolScope}. */
      toolScoped?: true;
      procedureSteps?: ReadonlyArray<{ toolCall?: { kind?: string } }>;
      sources?: ProvenanceSource[];
      provenance?: "verified" | "unverified" | "none";
      subject?: MemorySubject;
      harmonicFact?: Omit<
        HarmonicConstructionInput["persistedFacts"][number],
        "memoryId"
      >;
    }): Promise<string | undefined> => {
      const toolScoped = promotionWithholdsToolScope(options);
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
        const rawContent =
          citationEnabled &&
          hasCitationForTemplate(options.content, citationTemplate, citationHistory)
            ? stripCitationForTemplate(options.content, citationTemplate, citationHistory)
            : options.content;
        const citedContent = applyInlineCitation(rawContent);
        const sanitizedBase = sanitizeMemoryContent(rawContent);
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
              sharedSameConnector = false;
              log.warn(
                `connector-aware shared backfill scan failed; skipping backfill to avoid cross-connector mutation: ${scanErr instanceof Error ? scanErr.message : String(scanErr)}`,
              );
            }
          }
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
              sharedPromotionEnvelope.entityRef,
              sourceContext?.sourceConnector,
            );
          }
          if (
            lifecycleCaps.temporalSupersession &&
            sharedPromotionEnvelope.entityRef &&
            sharedSurvivingAttrs &&
            Object.keys(sharedSurvivingAttrs).length > 0
          ) {
            let hashDedupMatchingFact: MemoryFile | undefined;
            let hashDedupLookupComplete = false;
            try {
              const normalizedIncoming = ContentHashIndex.normalizeContent(dedupContent);
              const allShared = await readActiveMemoriesBothTiers(sharedStorage);
              const incomingEntityNorm = normalizeSupersessionKey(sharedPromotionEnvelope.entityRef);
              hashDedupMatchingFact = allShared.find((m) => {
                if (m.frontmatter.category !== "fact") return false;
                if ((m.frontmatter.status ?? "active") !== "active") return false;
                if (!m.frontmatter.entityRef) return false;
                if (normalizeSupersessionKey(m.frontmatter.entityRef) !== incomingEntityNorm) {
                  log.debug(
                    `persistExtraction: hash-dedup skipping cross-entity match (incoming="${incomingEntityNorm}" candidate="${normalizeSupersessionKey(m.frontmatter.entityRef)}")`,
                  );
                  return false;
                }
                if (normalizeStoredHashSource(m.content ?? "") !== normalizedIncoming) return false;
                const existingConnector = m.frontmatter.sourceConnector?.trim() || undefined;
                const newConnector = sourceContext?.sourceConnector?.trim() || undefined;
                if (existingConnector !== newConnector) return false;
                return true;
              });
              hashDedupLookupComplete = true;
              if (hashDedupMatchingFact) {
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
                if (hashDedupSupersession.supersededIds.length > 0) {
                }
                return promotedCopyId;
              }
              log.debug(
                `persistExtraction: hash-dedup found no active same-entity shared fact for ${options.sourceMemoryId}; falling through to write`,
              );
            } catch (hashDedupSupersessionErr) {
              log.warn(
                `persistExtraction: shared-namespace supersession on hash-dedup path failed open for ${options.sourceMemoryId}: ${hashDedupSupersessionErr}`,
              );
              if (hashDedupLookupComplete && hashDedupMatchingFact) {
                return promotedCopyId;
              }
              log.debug(
                `persistExtraction: hash-dedup catch: lookup incomplete or no candidate found for ${options.sourceMemoryId}; falling through to write`,
              );
            }
          } else {
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
        const sharedWrite = await writePromotionUnderFactDedupWindow({
          destination: sharedStorage,
          envelope: sharedPromotionEnvelope,
          promotion: options,
          dedupContent,
          rawContent,
          toolScoped,
          connector: sourceContext?.sourceConnector,
          citationEnabled,
          citationTemplate,
          sameEntityGuardEnabled: lifecycleCaps.temporalSupersession,
          survivingAttrs: sharedSurvivingAttrs,
          supersession: { supersessionEnabled: lifecycleCaps.temporalSupersession, dependencyPropagationDelivery: this.dependencyPropagationDelivery, namespaceScope: this.deps.storageDirNamespace(sharedStorage.dir) },
          backfillTemporalBoundsOnDedupHit: this.deps.backfillTemporalBoundsOnDedupHit,
        });
        if (sharedWrite.suppressed) return promotedCopyId;
        const sharedPromotion = sharedWrite.result;
        const promotedId = sharedPromotion.id;
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
      const hasExtractedStart =
        args.bounds.validFrom !== undefined &&
        args.bounds.eventTimeSource === "extracted";
      if (!args.bounds.invalidAt && !hasExtractedStart) return;
      const rawContent =
        citationEnabled && hasCitationForTemplate(args.content, citationTemplate, citationHistory)
          ? stripCitationForTemplate(args.content, citationTemplate, citationHistory)
          : args.content;
      const sanitizedBase = sanitizeMemoryContent(rawContent);
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

    if (!result || !Array.isArray(result.facts)) {
      log.warn(
        "persistExtraction: result or result.facts is invalid, skipping",
        { resultType: typeof result, factsType: typeof result?.facts },
      );
      return { persistedIds, memoryPathById, deferredCount, pendingReviewIds: pendingReviewPersistedIds };
    }

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
    const finalizeCommittedWrites = finalization.bind(async (scheduleQmd: boolean): Promise<void> => {
      await finalizeExtractionCommittedWrites({
        saveContentHashIndexes: () => this.deps.saveContentHashIndexes(),
        behaviorSignalsByStorage: behaviorSignalsByStorage.values(),
        harmonic: {
          enabled: harmonicConstructionEnabled,
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
        },
        updateTemporalTagIndexes: (target, ids) =>
          this.deps.updateTemporalTagIndexes(target, ids),
        fallbackStorage: storage,
        persistedIdsByStorage,
        requestQmdMaintenance: () => this.deps.requestQmdMaintenance(),
        scheduleQmd,
      });
    });

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

    const preRoutedCategories: Array<string | undefined> = new Array(facts.length);
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

    //
    let judgeVerdictsByFactIndex: Map<number, import("../extraction-judge.js").JudgeVerdict> | null = null;
    let judgeGatedCount = 0;
    if (lifecycleCaps.extractionJudge) {
      let preJudgeRedactionRules: CompiledRedactionRule[] = [];
      try {
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
          if (
            !isAboveImportanceThreshold(
              imp.level,
              this.deps.config.extractionMinImportanceLevel,
            )
          ) {
            continue;
          }
          let factRedactionRules = preJudgeRedactionRules;
          let factNs = preRoutedNamespaceByFact[fi];
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
        deferredCount = judgeResult.deferred;
      } catch (err) {
        log.warn(
          `extraction-judge: pipeline error, proceeding without filtering (fail-open): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

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
      (fact as any).category = (fact as any).category.trim();
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
      const factAnchor = pickFactEventTimeAnchor(fact, sourceContext?.validAt);
      const biTemporal = this.deps.config.temporalBiTemporal && factAnchor ? resolveFactEventTime(fact.eventTime, factAnchor) : undefined;
      //
      //
      //
      let writeCategory = fact.category;
      let targetStorage = storage;
      const sourceStorageDir = storage.dir; // #1669 thread #2: pre-routing source ns for redaction gate
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
      const factSubject = this.deps.config.subjectClassification?.enabled === true
        ? resolveWriteSubject(writeCategory, fact.subject)
        : undefined;
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

      const canonicalContentForHash =
        citationEnabled &&
        hasCitationForTemplate(fact.content, citationTemplate, citationHistory)
          ? stripCitationForTemplate(fact.content, citationTemplate, citationHistory)
          : fact.content;
      const contentHashDedupKey =
        writeCategory === "procedure"
          ? buildProcedurePersistBody(fact.content, fact.procedureSteps)
          : canonicalContentForHash;
      const importance = scoreImportance(
        fact.content,
        writeCategory,
        fact.tags,
      );
      let exactDuplicate = false;
      try {
        exactDuplicate = await this.deps.hasContentHashDedup(targetStorage, contentHashDedupKey);
      } catch (err) {
        exactDuplicate = false;
        log.warn(
          `content-hash dedup lookup unavailable for storage ${targetStorage.dir}; confirming against corpus: ${err}`,
        );
      }
      const raceDedupOpts = (key: string) => ({
        category: writeCategory,
        contentHashDedupKey: key,
        connector: sourceContext?.sourceConnector?.trim() || undefined,
        citationEnabled,
        citationTemplate,
      });
      if (factDedupEnabled) {
        exactDuplicate = await confirmActiveFactDuplicate(targetStorage, raceDedupOpts(contentHashDedupKey));
      }
      const finalizeOnWindowFailure = async (err: Error): Promise<never> => {
        await finalizeCommittedWrites(true).catch((finalizeErr) =>
          log.warn(`committed-write finalization after fact-dedup window failure failed: ${finalizeErr}`),
        );
        throw err;
      };
      const raceRecheck = (storage: StorageManager, key: string) => () => {
        if (!factDedupEnabled || injectionScreenStatus === "pending_review") return Promise.resolve(false);
        return confirmActiveFactDuplicate(storage, raceDedupOpts(key));
      };
      const backfillDuplicateTemporalBounds = async () => {
        if (!(biTemporal && writeCategory === "fact" && (biTemporal.validUntil || biTemporal.validFrom))) return;
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
        if (
          !isAboveImportanceThreshold(importance.level, this.deps.config.extractionMinImportanceLevel) ||
          faithfulnessWouldPending ||
          requireSpansWouldPending ||
          judgeWouldGate
        ) {
          return;
        }
        await this.deps.backfillTemporalBoundsOnDedupHit(
          targetStorage,
          contentHashDedupKey,
          {
            invalidAt: biTemporal.validUntil,
            validFrom: biTemporal.validFrom,
            observedAt: biTemporal.observedAt,
            eventTimeSource: biTemporal.eventTimeSource,
          },
          fact.entityRef,
          sourceContext?.sourceConnector,
        );
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
      };
      if (exactDuplicate && injectionScreenStatus !== "pending_review") {
        await backfillDuplicateTemporalBounds();
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
        log.debug(
          `metric:importance_gated level=${importance.level} threshold=${this.deps.config.extractionMinImportanceLevel} category=${writeCategory} count=${importanceGatedCount}`,
        );
        continue;
      }

      //
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

      const { faithfulness: faithfulnessFm, enforceStatus: faithfulnessGateStatus } =
        applyFaithfulnessVerdict(
          faithfulnessResultsByFactIndex,
          factLoopIndex,
          faithfulnessMode,
          fact.content,
          this.deps.getFaithfulnessCounters(),
        );

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
            { candidateConnector: sourceContext?.sourceConnector },
          ),
      });
      let pendingSemanticSkip: (SemanticDedupDecision & { action: "skip" }) | null = null;
      if (novelty.decision !== "add" && resolvePipelineProcessingCapabilities(this.deps.config).semanticDedup && injectionScreenStatus !== "pending_review") {
        let semanticDecision: SemanticDedupDecision;
        if (batchBackendUnavailable) {
          semanticDecision = { action: "keep", reason: "backend_unavailable" };
        } else {
          try {
            const lookupStorage = targetStorage;
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

      let supersedes: string | undefined;
      let links: MemoryLink[] = [];
      let contradictionDetected = false;
      let contradiction: {
        supersededId: string;
        confidence: number;
        reason: string;
        supersededPath: string;
        supersededCreated: string;
        supersededTags: string[];
      } | null | undefined;

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

      //
      //
      const isCorrection = writeCategory === "correction";
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
        continue;
      }

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
          const memoryKind = resolvePresentationCapabilities(this.deps.config).episodeNoteMode
            ? classifyMemoryKind(fact.content, fact.tags ?? [], writeCategory)
            : undefined;

          // Write the parent memory first (with full content for reference).
          //
          //
          const rawChunkedContent =
            citationEnabled &&
            hasCitationForTemplate(fact.content, citationTemplate, citationHistory)
              ? stripCitationForTemplate(fact.content, citationTemplate, citationHistory)
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
          const parentWriteOutcome = await persistUnderFactDedupWindow(
            targetStorage.dir,
            raceRecheck(targetStorage, contentHashDedupKey),
            async () =>
              targetStorage.writeSealedMemory(parentWriteEnvelope, {
            importance,
            supersedes,
            links: links.length > 0 ? links : undefined,
            intentGoal: inferredIntent?.goal,
            intentActionType: inferredIntent?.actionType,
            intentEntityTypes: inferredIntent?.entityTypes,
            memoryKind,
            ...(biTemporal ? { observedAt: biTemporal.observedAt, eventTimeSource: biTemporal.eventTimeSource, ...(biTemporal.validUntil ? { invalidAt: biTemporal.validUntil } : {}) } : {}),
            contentHashSource: rawChunkedContent,
            ...(faithfulnessFm ? { faithfulness: faithfulnessFm } : {}),
            ...(faithfulnessEnforceStatus ? { status: faithfulnessEnforceStatus } : {}),
            // Claim-level provenance spans (issue #1575 PR 2).
            ...(fact.sources && fact.sources.length > 0 ? { sources: fact.sources } : {}),
            ...(fact.provenance ? { provenance: fact.provenance } : {}),
            // PR #2016: never defer here — fallible chunk/artifact writes follow this
            deferHashIndexSave: false,
            ...(factToolScoped ? { toolScoped: true as const } : {}),
              }),
          ).catch(finalizeOnWindowFailure);
          if (parentWriteOutcome.suppressed) {
            await backfillDuplicateTemporalBounds();
            log.info(`dedup: raced duplicate suppressed in fact-dedup window (chunked parent) for storage ${targetStorage.dir}`);
            dedupedCount++;
            continue;
          }
          const parentWrite = parentWriteOutcome.result;
          const parentId = parentWrite.id;
          const tombstoneBlocked = parentWrite.tombstoneBlocked;
          const postWriteGuard =
            faithfulnessEnforceStatus === "pending_review" || tombstoneBlocked;
          // #3288: the parent is durable now. Track it before any post-write step
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
          trackPersistedId(targetStorage, parentId, {
            pendingReview: postWriteGuard,
            category: writeCategory,
            harmonicFact,
          });
          // #1645: defer contradiction auto-resolve until tombstone status is
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
            const chunkTags = parentWriteEnvelope.tags.filter((tag) => tag !== "chunked");
            for (const chunk of chunkResult.chunks) {
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
                applyInlineCitation(chunk.content),
                {
                  // #2014 round 4: sealed parent's confidence — raw
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
                  ...(faithfulnessFm ? { faithfulness: faithfulnessFm } : {}),
                  ...(postWriteGuard
                    ? { status: "pending_review" as const }
                    : (faithfulnessEnforceStatus ? { status: faithfulnessEnforceStatus } : {})),
                  ...(tombstoneBlocked && parentWrite.blockedBy
                    ? { blockedBy: parentWrite.blockedBy }
                    : {}),
                  // Claim-level provenance (issue #1575 PR 2): mirror the
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
          await anchorSnapshots.replace(targetStorage, parentId, writeCategory, memoryPathById);
          if (
            !postWriteGuard &&
            threadEpisodeIdsForGraph &&
            !threadEpisodeIdsForGraph.includes(parentId)
          ) {
            threadEpisodeIdsForGraph.push(parentId);
          }
          // #1645: same gate as the non-chunked path — a blocked chunked parent
          if (!postWriteGuard) {
            await this.deps.indexPersistedMemory(targetStorage, parentId);
          }
          // PR #402 Thread 1 fix: run source-namespace temporal supersession for
          if (!postWriteGuard) {
            try {
              // #2014 round 2: same envelope-surviving key rule as the
              const temporalSupersession = await applyTemporalSupersession({
                storage: targetStorage,
                newMemoryId: parentId,
                entityRef: parentWriteEnvelope.entityRef,
                structuredAttributes: parentWriteEnvelope.rawStructuredAttributes
                  ? { ...parentWriteEnvelope.rawStructuredAttributes }
                  : undefined,
                // #1578 r3: an extracted end-only bound (validFrom absent) is
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
          try {
            const canonicalChunkedContent =
              citationEnabled &&
              hasCitationForTemplate(fact.content, citationTemplate, citationHistory)
                ? stripCitationForTemplate(fact.content, citationTemplate, citationHistory)
                : fact.content;
            // #1645: do NOT register a tombstone-blocked fact's content in the
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
          continue; // Skip the normal write below
        }
      }

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
        const mergedPromotion = await buildMergedTargetPromotionPayload(targetStorage, semanticMerge);
        await promoteAndReconcileMergedTarget({ promote: (payload) => promoteMemoryToShared({ sourceStorage: targetStorage, ...payload }), config: this.deps.config, getStorageRouter: this.deps.getStorageRouter, scopeProfileWritePlan, sourceStorage: targetStorage, sourceMemoryId: semanticMerge.targetId, mergedPromotion: mergedPromotion.payload, mergedPromotionReadFailed: mergedPromotion.readFailed, normalize: normalizeStoredHashSource, onReconciled: () => promotedCopyProbe.invalidate() });
        trackPersistedId(targetStorage, semanticMerge.targetId, { includeReturnedIds: false });
        await persistMergedTargetThreadEpisode(this.deps.getThreading(), threadIdForExtraction, semanticMerge.targetId);
        if (harmonicConstructionEnabled) {
          await enqueueMergedTargetForHarmonicConstruction(harmonicFactsByStorage, targetStorage, harmonicFact, semanticMerge.targetId, semanticMerge.mergedContent, new Date(harmonicSourceInsertedAtBase + harmonicSourceOrder++).toISOString());
        }
        // Round N+5 (A+B): create-path parity — the create path's graph-edge build and
        trackBehaviorSignals(targetStorage, await runMergedTargetPostEffects(this.deps, targetStorage, semanticMerge, {
          category: writeCategory, incomingContent: fact.content, incomingConfidence: fact.confidence,
          namespace: this.deps.storageDirNamespace(targetStorage.dir), graphCaps,
          graphContext: await ensureGraphContext(targetStorage),
          threadIdForEdge: threadIdForExtraction ?? undefined, threadEpisodeIdsForGraph,
        }));
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
      const factWriteOutcome = await persistUnderFactDedupWindow(
        targetStorage.dir,
        raceRecheck(targetStorage, contentHashDedupKey),
        async () => {
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
        ...(fact.sources && fact.sources.length > 0 ? { sources: fact.sources } : {}),
        ...(fact.provenance ? { provenance: fact.provenance } : {}),
        // PR #2016: never defer inside the commit window (chunked-path
        deferHashIndexSave: false,
        ...(factToolScoped ? { toolScoped: true as const } : {}),
          });
          // Register the dedup hash inside the same commit window: writeMemory
          if (!factWrite.tombstoneBlocked) {
            try {
              await this.deps.addContentHashDedup(targetStorage, contentHashDedupKey);
            } catch (err) {
              log.warn(`content-hash dedup registration failed for memory ${factWrite.id}: ${err}`);
            }
          }
          return factWrite;
        },
      ).catch(finalizeOnWindowFailure);
      if (factWriteOutcome.suppressed) {
        await backfillDuplicateTemporalBounds();
        log.info(`dedup: raced duplicate suppressed in fact-dedup window for storage ${targetStorage.dir}`);
        dedupedCount++;
        continue;
      }
      const factWrite = factWriteOutcome.result;
      const memoryId = factWrite.id;
      const tombstoneBlocked = factWrite.tombstoneBlocked;
      const postWriteGuard = faithfulnessEnforceStatus === "pending_review" || tombstoneBlocked;
      // #3231: the fact is durable now. Track it before any post-write step
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
        await finalizeCommittedWrites(true).catch((finalizeErr) =>
          log.warn(`committed-write finalization after post-write failure failed: ${finalizeErr}`),
        );
        throw err;
      }
      if (routedRuleId) {
        log.debug(
          `routing applied for memory ${memoryId}: rule=${routedRuleId} category=${writeCategory} storage=${targetStorage.dir}`,
        );
      }
      // Temporal supersession (issue #375): when the new fact has structured
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
        await anchorSnapshots.replace(targetStorage, memoryId, writeCategory, memoryPathById);
        if (
          !postWriteGuard &&
          threadEpisodeIdsForGraph &&
          !threadEpisodeIdsForGraph.includes(memoryId)
        ) {
          threadEpisodeIdsForGraph.push(memoryId);
        }
        // #1645: a tombstone-blocked / pending_review fact must NOT enter the
        if (!postWriteGuard) {
          await this.deps.indexPersistedMemory(targetStorage, memoryId);
        }
        // Faithfulness gate (#1576, chatgpt P2): skip promotion for a
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
      } catch (err) {
        // PR #2016 / #3231: finalize deferred side effects for facts already
        await finalizeCommittedWrites(true).catch((finalizeErr) =>
          log.warn(`committed-write finalization after post-write failure failed: ${finalizeErr}`),
        );
        throw err;
      }
    }

    // Tracks whether THIS extraction persisted any durable, non-fact output
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
        await finalizeCommittedWrites(true).catch((finalizeErr) =>
          log.warn(`committed-write finalization after entity failure failed: ${finalizeErr}`),
        );
        throw err;
      }
    }
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
          await rethrowAfterCommittedWriteFinalization(finalizeCommittedWrites, err, "relationship");
        }
      }
    }

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
    if (resolveRecallEnhancementCapabilities(this.deps.config).identity && result.identityReflection) {
      const idScreen = screenPersistStrings([result.identityReflection], entityScreenOn, entityScreenProfile);
      if (idScreen.warning) log.warn(`persistExtraction(identity): ${idScreen.warning}`);
      else {
        try {
          await storage.appendIdentityReflection(result.identityReflection);
          recordDurableNonFactWrite();
        } catch (err) {
          await rethrowAfterCommittedWriteFinalization(finalizeCommittedWrites, err, "identity reflection");
        }
      }
    }

    // Catalog touch for durable NON-FACT outputs (NHZEZ / NIIly, codex P2). The
    if (durableNonFactWritten) {
      touchBaseNonFactNamespace();
    }

    // Shared batch-end finalization (hash, behavior, harmonic, temporal).
    await finalizeCommittedWrites(false);

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

    return { persistedIds, memoryPathById, deferredCount, pendingReviewIds: pendingReviewPersistedIds };
  }
}
