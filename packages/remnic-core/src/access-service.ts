import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { readdirSync, unlinkSync } from "node:fs";
import { stat } from "node:fs/promises";
import * as nodeFs from "node:fs/promises";
import { ZodError } from "zod";
import { summarizeHourlyStatus } from "./summarizer.js";
import { decodeCitationNamespace } from "./access-citation-namespace.js";
import {
  type CitationUsageRequest,
  type CitationUsageResult,
  recordCitationUsage as recordCitationUsageForAccess,
} from "./access-citation.js";
import type {
  EngramAccessHealthResponse,
  EngramAccessQmdCollectionState,
  EngramAccessQmdHealthResponse,
} from "./access-health-types.js";
import { AccessIdempotencyStore, hashAccessIdempotencyPayload } from "./access-idempotency.js";
import { type RecallCoordinatorHost, type RecallExecResult, coordinateRecall } from "./access-recall-concurrency.js";
import { enforceNamespaceAllowList, tokenCapabilityStore } from "./access-token-capabilities.js";
import {
  resolveCompressionCapabilities,
  resolveMemoryLifecycleCapabilities,
  resolveNamespaceCapabilities,
  resolveObjectiveStateCapabilities,
  resolveQmdCapabilities,
  resolveRecallAuxiliaryCapabilities,
  resolveSecurityCapabilities,
} from "./capabilities.js";
import { CorpusWatermarkCache, computeServiceCorpusCensus } from "./corpus-watermark.js";
import { ExtractionLivenessWarnThrottle, computeExtractionLivenessStatus } from "./extraction-liveness.js";
import { readAggregateExtractionWatermark } from "./orchestration/extraction-watermark.js";
import { ReplicaDivergenceMonitor } from "./replica-divergence.js";
import type { ResolveSecretRefFn } from "./resolve-auth-token.js";
import { buildAccessWriteRequestFingerprint, buildObserveRequestFingerprint } from "./write-envelope.js";
import { UNATTRIBUTED_ACCESS_WRITE_ORIGIN } from "./shared-context/envelope-io.js";
export type { EngramAccessHealthResponse, EngramAccessQmdCollectionState, EngramAccessQmdHealthResponse };
import { AccessAuditAdapter, type AccessAuditConfig, type AccessAuditResult } from "./access-audit.js";
import {
  type InterruptibleCodingScopeInput,
  resolveCodingContextFromOptions,
} from "./access-coding-context-resolution.js";
import {
  defaultNamespaceAtFlatRoot,
  memorySearchThroughScope,
  mergeMemorySearchDefaultFallback,
  resolveMemorySearchDefaultFallback,
} from "./access-memory-search-fanout.js";
import { buildArchitectureCard, createArchitectureCardSummariser } from "./coding/architecture-card.js";
import {
  ARCHITECTURE_CARD_TAG,
  type ArchitectureSurfaceRequest,
  type ArchitectureSurfaceResponse,
  type ArchitectureSurfaceStorage,
  createArchitectureVersioningHook,
  handleCodingArchitecture,
} from "./coding/architecture-surfaces.js";
import {
  type CodegraphStore,
  codegraphSurfaceVisible,
  getCodegraphStore,
  makeCodegraphRuntimeDelegates,
  resolveCodegraphProjectId,
} from "./coding/codegraph-runtime.js";
import {
  type CodegraphSurfaceContext,
  type CodegraphSurfaceRequest,
  type CodegraphSurfaceResponse,
  handleCodegraphTool,
} from "./coding/codegraph-surfaces.js";
import {
  type CodingNamespaceOverlay,
  combineNamespaces,
  lcmSessionKeyForNamespace,
  projectTagProjectId,
  resolveCodingNamespaceOverlay,
} from "./coding/coding-namespace.js";
import {
  type DecisionSurfaceRequest,
  type DecisionSurfaceResponse,
  handleCodingDecision,
} from "./coding/decision-surfaces.js";
import { resolveGitContext } from "./coding/git-context.js";
import { defaultGitInvokerSync } from "./coding/git-context.js";
import {
  type DeltaSurfaceRequest,
  type DeltaSurfaceResponse,
  type DeltaSurfaceStorage,
  handleCodingDelta,
} from "./coding/session-delta-surfaces.js";
import {
  type CorrectionOutcome,
  type CorrectionPlan,
  type CorrectionRequest,
  type CorrectionService,
  createCorrectionService,
  isCorrectionFeatureEnabled,
} from "./correction/index.js";
import { type BudgetWarning, CrossNamespaceBudget } from "./cross-namespace-budget.js";
import {
  type ExplicitCaptureInput,
  type ValidExplicitCapture,
  persistExplicitCapture,
  queueExplicitCaptureForReview,
  validateExplicitCaptureInput,
} from "./explicit-capture.js";
import type { LiveConnectorsRunSummary } from "./live-connectors-runner.js";
import { log } from "./logger.js";
import {
  buildProposedActions,
  buildQualityScore,
  groupActionsByStatus,
  listMemoryGovernanceRuns,
  type readMemoryGovernanceRunArtifact,
  runMemoryGovernance,
} from "./maintenance/memory-governance.js";
import type { PatternReinforcementResult } from "./maintenance/pattern-reinforcement.js";
import type { MeetingsDayBuildSummary } from "./meetings/build.js";
import type { MeetingsGetResult, MeetingsListResult } from "./meetings/service.js";
import { isSearchExcludedPath } from "./orchestration/generic-recall-paths.js";
import { createVersion } from "./page-versioning.js";
import { runProcedureMining } from "./procedural/procedure-miner.js";
import type { AnomalyDetectorResult } from "./recall-audit-anomaly.js";
import { isHandleToken } from "./recall-handles.js";
import { displayErrorDetail } from "./runtime/better-sqlite.js";
import {
  SUPPORT_PASSPORT_AUDIT_TAG,
  SUPPORT_PASSPORT_CARD_TAG,
  createSupportPassportPrivateFileExclusion,
  isSupportPassportPrivateMemory,
} from "./support-passport/card-projection.js";
import {
  applySupportPassportOfflineSyncChangeset,
  applySupportPassportOfflineSyncFileContent,
} from "./support-passport/offline-sync-guard.js";
import type { WearablesService } from "./wearables/service.js";
import { exportWorkBoardMarkdown, exportWorkBoardSnapshot, importWorkBoardSnapshot } from "./work/board.js";
import { wrapWorkLayerContext } from "./work/boundary.js";
import { WorkStorage } from "./work/storage.js";

import * as wearablesMeetings from "./access-wearables-meetings-surface.js";
import type { WearablesMeetingsHost, WearablesMeetingsScope } from "./access-wearables-meetings-surface.js";
export type { WearablesMeetingsScope };
import * as nodePath from "node:path";
import {
  type EngramAccessNamespaceWritableRequest,
  resolveNamespaceWritablePreflight,
} from "./access-namespace-preflight.js";
import {
  type EngramAccessExtractionForceFlushRequest,
  type EngramAccessExtractionForceFlushResponse,
  type EngramAccessLcmCompactionFlushRequest,
  type EngramAccessLcmCompactionFlushResponse,
  delegateExtractionForceFlush,
} from "./access-service-helpers.js";
import {
  type AdminNamespaceFilter,
  type AdminNamespaceQmdHealth,
  AdminPromotionError,
  type InspectScopeOptions,
  type MemoryPromotionTargetKind,
  type PromotionStorageProvider,
  type ScopeInspection,
  auditTranscripts,
  gatherMaintenanceHealth,
  inspectScope,
  listAdminNamespaces,
  promoteMemory,
  redactSensitive,
} from "./admin/admin-surfaces.js";
import { FileCalendarSource, buildBriefing, parseBriefingFocus, parseBriefingWindow } from "./briefing.js";
import { type DeepRecallResult, runBudgetedDeepRecall } from "./deep-recall.js";
import { callDeepRecallPolicyLlm } from "./deep-recall-policy-llm.js";
import { createDeepRecallSeedSearch } from "./deep-recall-seeds.js";
import { renderDeepRecallResult } from "./deep-recall-renderer.js";
import { readProjectedHarmonicGraph } from "./harmonic-retrieval.js";
import { stripAttributesSuffix } from "./structured-attributes.js";
import {
  type GraphSnapshotNodeMetadata,
  type GraphSnapshotRequest,
  type GraphSnapshotResponse,
  buildGraphSnapshot,
} from "./graph-snapshot.js";
import { inferMemoryStatus, toMemoryPathRel } from "./memory-lifecycle-ledger-utils.js";
import { normalizeProjectionPreview, normalizeProjectionTags } from "./memory-projection-format.js";
import { getMemoryProjectionPath } from "./memory-projection-store.js";
import { namespaceIdentityFromToken } from "./namespaces/identity.js";
import {
  canReadNamespace,
  canWriteNamespace,
  citationAuthorizedNamespaces,
  defaultNamespaceForPrincipal,
  recallNamespacesForPrincipal,
  resolvePrincipal,
} from "./namespaces/principal.js";
import {
  type ResolvedScopeProfilePlan,
  type ScopeProfileLayerResolution,
  type ScopeProfilePromotionResolution,
  expandScopeProfileReadNamespaces,
  resolveScopeProfilePlan,
} from "./namespaces/scope-profiles.js";
import { namespaceCollectionName } from "./namespaces/search.js";
import type {
  GraphRecallSnapshot,
  IntentDebugSnapshot,
  Orchestrator,
  RecallInvocationOptions,
} from "./orchestrator.js";
import { type ProcedureStatsReport, computeProcedureStats } from "./procedural/procedure-stats.js";
import {
  runProcedureLibraryMaintenance,
  type ProcedureLibraryMaintenanceReport,
} from "./procedural/library-maintenance.js";
import type { RecallContextComposition } from "./recall-context-composition.js";
import type { LastRecallSnapshot } from "./recall-state.js";
import {
  type ScopePlan,
  type WritableNamespaceResult,
  resolveScopePlan,
  resolveScopedWritableNamespaceValue,
  resolveWritableNamespaceValue,
} from "./scopes/scope-plan.js";
import { SecureStoreLockedError } from "./secure-store/index.js";
import { isPathInsideStorageRoot } from "./storage-paths.js";
import { type StorageManager, parseEntityFile, parseFrontmatter } from "./storage.js";
import {
  type TrustZoneDemoSeedResult,
  type TrustZoneName,
  type TrustZonePromotionResult,
  type TrustZoneProvenanceScore,
  type TrustZoneRecord,
  type TrustZoneRecordKind,
  type TrustZoneSourceClass,
  type TrustZoneStoreStatus,
  getTrustZoneStoreStatus,
  isTrustZoneName,
  listTrustZoneRecords,
  promoteTrustZoneRecord,
  scoreTrustZoneProvenance,
  seedTrustZoneDemoDataset,
  summarizeTrustZonePromotionReadiness,
} from "./trust-zones.js";
import type {
  CodingContext,
  EntityFile,
  MemoryActionOutcome,
  MemoryActionType,
  MemoryFile,
  MemoryLifecycleEvent,
  MemoryStatus,
  PluginConfig,
  RecallDisclosure,
  RecallPlanMode,
  SourceConnectorProvenance,
} from "./types.js";
import type { SupportPassportModelRoute } from "./support-passport/model-adapter.js";
export type {
  EngramAccessExtractionForceFlushRequest,
  EngramAccessExtractionForceFlushResponse,
  EngramAccessLcmCompactionFlushRequest,
  EngramAccessLcmCompactionFlushResponse,
};

import { AccessAdminOpsSurface } from "./access-admin-ops-surface.js";
import { AccessIdentityContinuitySurface } from "./access-identity-continuity-surface.js";
import { AccessLcmSurface } from "./access-lcm-surface.js";
import { AccessObserveWriteSurface } from "./access-observe-write-surface.js";
import { type OfflineSyncManifestStreamResponse, createOfflineSyncManifestStream } from "./access-offline-manifest.js";
import { AccessRecallSurface } from "./access-recall-surface.js";
import {
  type ActionConfidenceInput,
  type ActionConfidenceResult,
  evaluateActionConfidence,
} from "./action-confidence.js";
import {
  resolveAccessSetupCapabilities,
  resolveGraphConstructionCapabilities,
  resolveIndexingCapabilities,
} from "./capabilities.js";
import { resolveRecallEnhancementCapabilities } from "./capabilities.js";
import { type CapsuleListEntry, defaultCapsulesDir } from "./capsule-cli.js";
import type { SemanticDedupLookup } from "./dedup/semantic.js";
import type { FallbackLlmClient } from "./fallback-llm.js";
import type { LocalLlmClient } from "./local-llm.js";
import {
  type MemoryOutcomeKind,
  type RecordMemoryOutcomeResult,
  recordMemoryOutcome,
} from "./memory-worth-outcomes.js";
import type { LcmMessagePartInput, MessagePartSourceFormat } from "./message-parts/index.js";
import type { CategoryAliasCoercion, ObserveRequest, RecallRequest } from "./access-schema.js";
import { splitCanonicalWriteRequest } from "./access-observe-write-category.js";
import { recordObjectiveStateSnapshotsFromObservedMessages } from "./objective-state-writers.js";
import { objectiveStateStoreOverrideForNamespace } from "./objective-state.js";
import { offlineSyncStorageForSnapshot } from "./offline-sync-impression-drain.js";
import {
  OFFLINE_SYNC_SNAPSHOT_FORMAT,
  type OfflineSyncApplyChangesetResult,
  type OfflineSyncApplyFileContentChunkResult,
  type OfflineSyncFileContentChunk,
  type OfflineSyncFileRecord,
  type OfflineSyncFileState,
  type OfflineSyncSnapshot,
  buildOfflineSyncSnapshot,
  buildOfflineSyncSnapshotForPaths,
  buildOfflineSyncSnapshotFromBase,
  compileOfflineSyncExcludeGlobs,
  filterOfflineSyncDeletionRevisions,
  iterateOfflineSyncSnapshotFileRecords,
  readOfflineSyncFileContentChunk,
} from "./offline-sync.js";
import { selfDeps } from "./orchestration/self-deps.js";
import { ReviewDeckSurface } from "./review/review-deck-surface.js";
import { formatProfileTraceAscii } from "./profiling.js";
import { decideDisclosureEscalation } from "./recall-disclosure-escalation.js";
import { toRecallExplainJson } from "./recall-explain-renderer.js";
import { type TagMatchMode, applyTagFilter, normalizeTags, parseTagMatch } from "./recall-tag-filter.js";
import { type RecallXraySnapshot, estimateRecallTokens } from "./recall-xray.js";
import {
  computeWhoKnows,
  loadWhoKnowsEntities,
  validateWhoKnowsInput,
  WHO_KNOWS_DEFAULT_LIMIT,
  type WhoKnowsResult,
} from "./who-knows.js";
import { computePromotionCandidates, type PromotionCandidatesResult } from "./memory-subject.js";
import { SupportPassportAccessServiceBase } from "./support-passport/access-service-base.js";
import {
  type ExportCapsuleOptions,
  type ExportCapsuleResult,
  exportCapsule as exportCapsuleFn,
} from "./transfer/capsule-export.js";
import {
  type ImportCapsuleOptions,
  type ImportCapsuleResult,
  importCapsule as importCapsuleFn,
} from "./transfer/capsule-import.js";
import { DEFAULT_RECALL_DISCLOSURE, isRecallDisclosure } from "./types.js";

import { EngramAccessInputError, NamespaceNotWritableError } from "./access-errors.js";
// Re-exported so existing `import { … } from "./access-service.js"` callers keep
// working after these classes moved to ./access-errors (issue #1888).
export { EngramAccessInputError, NamespaceNotWritableError } from "./access-errors.js";

export type AccessProfilingReportRequest = {
  format?: string;
  limit?: number;
};

export type AccessProfilingReportResponse = {
  enabled: boolean;
  format?: "ascii" | "json";
  report?: string;
  traces?: unknown[];
  stats?: unknown;
  bottleneck?: string | null;
  reason?: string;
  message?: string;
};

let cachedPackageVersion: string | null = null;

async function getPackageVersion(): Promise<string> {
  if (cachedPackageVersion !== null) return cachedPackageVersion;
  try {
    const raw = await nodeFs.readFile(new URL("../package.json", import.meta.url), "utf-8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    cachedPackageVersion = typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : "unknown";
  } catch {
    cachedPackageVersion = "unknown";
  }
  return cachedPackageVersion;
}

function normalizeTrustZoneInputError(error: unknown): EngramAccessInputError | null {
  const message = error instanceof Error ? error.message : null;
  if (!message) {
    return null;
  }
  if (
    /^sourceRecordId must /.test(message) ||
    /^promotionReason must /.test(message) ||
    /^recordedAt must /.test(message) ||
    /^trust zone promotion requires /.test(message) ||
    /^source trust-zone record not found: /.test(message) ||
    /^trust-zone promotion denied: /.test(message) ||
    /^trust zone demo seed requires /.test(message) ||
    /^unsupported trust-zone demo scenario: /.test(message)
  ) {
    return new EngramAccessInputError(message);
  }
  return null;
}

export const ENGRAM_ACCESS_WRITE_SCHEMA_VERSION = 1;

/**
 * Recall request. Wire fields derive from the canonical zod schema
 * (`recallRequestSchema`, access-schema.ts — issue #2482) so the HTTP body,
 * the MCP args, and the service share ONE model. The overlay below carries
 * server-resolved transport fields no client may set.
 */
export interface EngramAccessRecallRequest extends RecallRequest {
  authenticatedPrincipal?: string;
  /** Trusted connector identity resolved at the transport boundary. */
  sourceConnector?: string;
  abortSignal?: AbortSignal;
  /**
   * Internal, server-set field (issue #1906): wall-clock ms the caller
   * waited for a per-principal recall slot / single-flight leader before
   * execution. Set by `recall()`, forwarded into `RecallInvocationOptions`,
   * and folded additively into recall-timings. Not part of the zod schema
   * (same pattern as `abortSignal`).
   */
  queueWaitMs?: number;
}

/**
 * Standalone request to attach / clear the coding context for a session
 * without performing a recall. Used by the Claude Code / Codex connectors
 * at session start, and by the `remnic.set_coding_context` MCP tool (PR 7).
 */
export interface EngramAccessSetCodingContextRequest {
  sessionKey: string;
  codingContext: {
    projectId: string;
    branch: string | null;
    rootPath: string;
    defaultBranch: string | null;
  } | null;
}

export interface EngramAccessRecallResponse {
  query: string;
  sessionKey?: string;
  namespace: string;
  context: string;
  /** Request-local split used by adapters that must re-render a tighter prompt budget. */
  contextComposition?: RecallContextComposition;
  count: number;
  memoryIds: string[];
  results: EngramAccessMemorySummary[];
  recordedAt?: string;
  traceId?: string;
  plannerMode?: RecallPlanMode;
  fallbackUsed: boolean;
  sourcesUsed: string[];
  /**
   * Disclosure depth applied to this recall (issue #677).  Reflects the
   * caller-requested level after defaulting; useful for surfaces that want
   * to render a "served at depth X" hint without re-deriving it.  PR 1 of
   * #677 wires this end-to-end for plumbing only — section/raw payload
   * shaping ships in later PRs.
   */
  disclosure: RecallDisclosure;
  budgetsApplied?: LastRecallSnapshot["budgetsApplied"];
  auditAnomalies?: AnomalyDetectorResult;
  budgetWarning?: BudgetWarning;
  latencyMs?: number;
  debug?: {
    snapshot?: LastRecallSnapshot;
    intent?: IntentDebugSnapshot | null;
    graph?: GraphRecallSnapshot | null;
  };
}

export interface EngramAccessRecallExplainRequest {
  sessionKey?: string;
  namespace?: string;
  /** Caller principal for namespace access checks. Transport-bound; never from untrusted payloads. */
  authenticatedPrincipal?: string;
}

export interface EngramAccessRecallExplainResponse {
  found: boolean;
  snapshot?: LastRecallSnapshot;
  intent?: IntentDebugSnapshot | null;
  graph?: GraphRecallSnapshot | null;
}

export interface EngramAccessDaySummaryRequest {
  memories?: string;
  sessionKey?: string;
  namespace?: string;
  /** Opt-in matched-place-name context for the auto-gathered summary (issue #2925). */
  includeLocation?: boolean;
  timeZone?: string;
}

/** Inputs accepted by the `remnic_briefing` MCP tool. */
export interface EngramAccessBriefingRequest {
  since?: string;
  focus?: string;
  namespace?: string;
  /** Opt-in matched-place-name section appended to markdown and json (issue #2925). */
  includeLocation?: boolean;
  format?: "markdown" | "json";
  maxFollowups?: number;
  /** Caller principal for namespace access checks. Transport-bound — never from untrusted payloads. */
  principal?: string;
}

/** Response for `remnic_briefing`. */
export interface EngramAccessBriefingResponse {
  format: "markdown" | "json";
  window: { from: string; to: string };
  namespace: string;
  markdown: string;
  json: Record<string, unknown>;
  followupsUnavailableReason?: string;
}

export interface EngramAccessMemoryRecord {
  id: string;
  path: string;
  category: string;
  status?: string;
  created?: string;
  updated?: string;
  content: string;
  frontmatter: MemoryFile["frontmatter"];
}

export interface EngramAccessMemorySummary {
  id: string;
  path: string;
  category: string;
  status: string;
  created?: string;
  updated?: string;
  tags: string[];
  entityRef?: string;
  preview: string;
  /**
   * Disclosure depth at which this result was served (issue #677).  Set by
   * recall paths; omitted on non-recall surfaces (e.g. memory browse) where
   * the concept does not apply.  PR 1 of #677 always reports the
   * request-level disclosure on recall results; per-result divergence is
   * reserved for the auto-escalation policy that ships in PR 4/4.
   */
  disclosure?: RecallDisclosure;
  /**
   * Full memory content (markdown body) — populated when `disclosure` is
   * `"section"` or `"raw"` (issue #677 PR 2/4).  At `"chunk"` depth callers
   * only receive the short `preview`, preserving the cheap-by-default
   * recall payload.  Browse/non-recall paths leave `content` undefined.
   */
  content?: string;
  /**
   * Raw transcript excerpts surfaced from the LCM archive when `disclosure`
   * is `"raw"` and the LCM engine is enabled (issue #677 PR 2/4).  Each
   * entry is a per-message excerpt sized by the LCM archive's
   * configured excerpt window.  Empty array when LCM is disabled or has
   * no matching transcript content.  Always omitted at chunk/section.
   */
  rawExcerpts?: Array<{
    turnIndex: number;
    role: string;
    content: string;
    sessionId: string;
  }>;
}

export interface EngramAccessMemoryBrowseRequest {
  query?: string;
  status?: string;
  category?: string;
  namespace?: string;
  authenticatedPrincipal?: string;
  sort?: "updated_desc" | "updated_asc" | "created_desc" | "created_asc";
  limit?: number;
  offset?: number;
}

export interface EngramAccessMemoryBrowseResponse {
  namespace: string;
  sort: "updated_desc" | "updated_asc" | "created_desc" | "created_asc";
  total: number;
  count: number;
  limit: number;
  offset: number;
  memories: EngramAccessMemorySummary[];
}

export interface EngramAccessMemoryResponse {
  found: boolean;
  namespace: string;
  memory?: EngramAccessMemoryRecord;
}

export interface EngramAccessTimelineResponse {
  found: boolean;
  namespace: string;
  count: number;
  timeline: MemoryLifecycleEvent[];
}

export interface EngramAccessEntitySummary {
  name: string;
  type: string;
  updated: string;
  summary?: string;
  aliases: string[];
}

export interface EngramAccessEntityListResponse {
  namespace: string;
  total: number;
  count: number;
  limit: number;
  offset: number;
  entities: EngramAccessEntitySummary[];
}

export interface EngramAccessEntityResponse {
  found: boolean;
  namespace: string;
  entity?: EntityFile;
}

export interface EngramAccessReviewQueueResponse {
  found: boolean;
  namespace?: string;
  runId?: string;
  summary?: Awaited<ReturnType<typeof readMemoryGovernanceRunArtifact>>["summary"];
  metrics?: Awaited<ReturnType<typeof readMemoryGovernanceRunArtifact>>["metrics"];
  qualityScore?: Awaited<ReturnType<typeof readMemoryGovernanceRunArtifact>>["qualityScore"];
  reviewQueue?: Awaited<ReturnType<typeof readMemoryGovernanceRunArtifact>>["reviewQueue"];
  appliedActions?: Awaited<ReturnType<typeof readMemoryGovernanceRunArtifact>>["appliedActions"];
  transitionReport?: Awaited<ReturnType<typeof readMemoryGovernanceRunArtifact>>["transitionReport"];
  report?: string;
}

export interface EngramAccessMaintenanceResponse {
  namespace: string;
  health: EngramAccessHealthResponse;
  latestGovernanceRun: EngramAccessReviewQueueResponse;
}

export interface EngramAccessTrustZoneStatusResponse {
  namespace: string;
  status: TrustZoneStoreStatus;
}

export interface EngramAccessTrustZoneRecordSummary {
  recordId: string;
  filePath: string;
  zone: TrustZoneName;
  recordedAt: string;
  kind: TrustZoneRecordKind;
  summary: string;
  sourceClass: TrustZoneSourceClass;
  sessionKey?: string;
  sourceId?: string;
  evidenceHashPresent: boolean;
  anchored: boolean;
  entityRefs: string[];
  tags: string[];
  metadata?: Record<string, string>;
  trustScore?: TrustZoneProvenanceScore;
  nextPromotionTarget?: TrustZoneName;
  nextPromotionAllowed: boolean;
  nextPromotionReasons: string[];
  corroborationCount?: number;
  corroborationSourceClasses?: TrustZoneSourceClass[];
}

export interface EngramAccessTrustZoneBrowseRequest {
  query?: string;
  zone?: TrustZoneName;
  kind?: TrustZoneRecordKind;
  sourceClass?: TrustZoneSourceClass;
  namespace?: string;
  limit?: number;
  offset?: number;
}

export interface EngramAccessTrustZoneBrowseResponse {
  namespace: string;
  total: number;
  count: number;
  limit: number;
  offset: number;
  records: EngramAccessTrustZoneRecordSummary[];
}

export interface EngramAccessTrustZonePromoteRequest {
  recordId: string;
  targetZone: TrustZoneName;
  promotionReason: string;
  recordedAt?: string;
  summary?: string;
  dryRun?: boolean;
  namespace?: string;
  authenticatedPrincipal?: string;
}

export interface EngramAccessTrustZonePromoteResponse extends TrustZonePromotionResult {
  namespace: string;
  dryRun: boolean;
}

export interface EngramAccessTrustZoneDemoSeedRequest {
  scenario?: string;
  recordedAt?: string;
  dryRun?: boolean;
  namespace?: string;
  authenticatedPrincipal?: string;
}

export interface EngramAccessTrustZoneDemoSeedResponse extends TrustZoneDemoSeedResult {
  namespace: string;
}

export interface EngramAccessQualityResponse {
  namespace: string;
  totalMemories: number;
  statusCounts: Record<string, number>;
  categoryCounts: Record<string, number>;
  confidenceTierCounts: Record<string, number>;
  ageBucketCounts: Record<string, number>;
  archivePressure: {
    pendingReview: number;
    quarantined: number;
    archived: number;
    staleActive: number;
    lowConfidenceActive: number;
  };
  latestGovernanceRun: {
    found: boolean;
    runId?: string;
    qualityScore?: EngramAccessReviewQueueResponse["qualityScore"];
    reviewQueueCount: number;
  };
}

export interface EngramAccessCapsuleListResponse {
  namespace: string;
  capsulesDir: string;
  capsules: CapsuleListEntry[];
}

export interface EngramAccessOfflineSyncSnapshotRequest {
  namespace?: string;
  principal?: string;
  includeTranscripts?: boolean;
  includeContent?: boolean;
  baseCapturedAt?: Date;
  baseFiles?: OfflineSyncFileState[];
}

export interface EngramAccessOfflineSyncManifestRequest {
  namespace?: string;
  principal?: string;
  includeTranscripts?: boolean;
}

export interface EngramAccessOfflineSyncFilesRequest {
  namespace?: string;
  principal?: string;
  includeTranscripts?: boolean;
  paths: string[];
}

export interface EngramAccessOfflineSyncFileContentRequest {
  namespace?: string;
  principal?: string;
  includeTranscripts?: boolean;
  path: string;
  offset?: number;
  length?: number;
}

export interface EngramAccessOfflineSyncApplyFileContentRequest {
  namespace?: string;
  principal?: string;
  includeTranscripts?: boolean;
  sourceId: string;
  path: string;
  sha256: string;
  bytes: number;
  mtimeMs: number;
  offset?: number;
  baseSha256?: string;
  content: Buffer;
}

export interface EngramAccessOfflineSyncApplyRequest {
  namespace?: string;
  principal?: string;
  changeset: unknown;
  returnCurrentFiles?: boolean;
}

export interface EngramAccessOfflineSyncFinalizeConvergenceRequest {
  namespaces?: string[];
  principal?: string;
  sourceId: string;
}

export interface EngramAccessOfflineSyncSnapshotResponse extends OfflineSyncSnapshot {
  namespace: string;
}

export interface EngramAccessOfflineSyncSnapshotStreamResponse extends Omit<OfflineSyncSnapshot, "files"> {
  namespace: string;
  files: AsyncIterable<OfflineSyncFileRecord>;
}

export interface EngramAccessOfflineSyncFilesResponse extends OfflineSyncSnapshot {
  namespace: string;
}

export interface EngramAccessOfflineSyncFileContentResponse extends OfflineSyncFileContentChunk {
  namespace: string;
}

export interface EngramAccessOfflineSyncApplyFileContentResponse extends OfflineSyncApplyFileContentChunkResult {
  namespace: string;
}

export interface EngramAccessOfflineSyncApplyResponse extends OfflineSyncApplyChangesetResult {
  namespace: string;
}

export interface EngramAccessOfflineSyncFinalizeConvergenceResponse {
  namespaces: string[];
  refreshed: true;
}

export type EngramAccessActionConfidenceRequest = ActionConfidenceInput;
export type EngramAccessActionConfidenceResponse = ActionConfidenceResult;

export async function buildProjectedGovernanceProposedActions(
  storage: Awaited<ReturnType<Orchestrator["getStorage"]>>,
  projected: NonNullable<
    Awaited<ReturnType<Awaited<ReturnType<Orchestrator["getStorage"]>>["getProjectedGovernanceRecord"]>>
  >
): Promise<Awaited<ReturnType<typeof readMemoryGovernanceRunArtifact>>["appliedActions"]> {
  const reviewQueue = projected.reviewQueueRows.map((row) => ({
    entryId: row.entryId,
    memoryId: row.memoryId,
    path: row.path,
    reasonCode: row.reasonCode,
    severity: row.severity,
    suggestedAction: row.suggestedAction,
    suggestedStatus: row.suggestedStatus,
    relatedMemoryIds: row.relatedMemoryIds,
  })) as Awaited<ReturnType<typeof readMemoryGovernanceRunArtifact>>["reviewQueue"];
  const memories = (
    await Promise.all(projected.reviewQueueRows.map((row) => storage.getMemoryById(row.memoryId)))
  ).filter((memory): memory is MemoryFile => Boolean(memory));
  return buildProposedActions(reviewQueue, memories);
}

export function hasGroupedGovernanceActions(
  grouped?: Awaited<ReturnType<typeof readMemoryGovernanceRunArtifact>>["transitionReport"]["proposed"]
): boolean {
  if (!grouped) return false;
  return Object.values(grouped).some((actions) => Array.isArray(actions) && actions.length > 0);
}

export interface EngramAccessReviewDispositionRequest {
  memoryId: string;
  status: MemoryStatus | "archived";
  reasonCode: string;
  namespace?: string;
  /**
   * Trusted transport-bound principal. This must never come from untrusted client payloads.
   * When present, write authorization is evaluated against this principal instead of sessionKey.
   */
  authenticatedPrincipal?: string;
}

export interface EngramAccessReviewDispositionResponse {
  ok: boolean;
  namespace: string;
  memoryId: string;
  status: MemoryStatus | "archived";
  previousStatus: MemoryStatus;
  currentPath?: string;
}

export interface EngramAccessWriteEnvelope {
  schemaVersion?: number;
  idempotencyKey?: string;
  dryRun?: boolean;
  sessionKey?: string;
  /** Trusted transport-bound principal (never from client payloads); authorizes writes instead of sessionKey. */
  authenticatedPrincipal?: string;
  /** When set, an ACL rejection is NOT dead-lettered (#1888) so `remnic quarantine replay` can re-submit through this same surface without re-quarantining and duplicating the parked record. */
  readonly suppressQuarantine?: boolean;
}

/**
 * Optional git/project context for project-scoped writes (#1434). When no
 * explicit `namespace` is supplied, these route the write to the same project
 * namespace recall/observe resolve from `cwd`/`projectTag` (rule 42 symmetry).
 */
export interface CodingScopedWriteInput {
  cwd?: string;
  projectTag?: string;
}

export type { EngramAccessNamespaceWritableRequest } from "./access-namespace-preflight.js";
/**
 * Internal, single-resolution plan describing the effective memory scope for a
 * write-producing access request (#1495, seed for epic #1494). One plan is
 * resolved per request and EVERY side effect (LCM archival, extraction replay,
 * objective-state snapshot, response) consumes the same `writeNamespace`, so an
 * observed turn and its extracted memories never drift away from the namespace a
 * same-session project-scoped recall searches (rule 39 / 42).
 *
 * The resolver that produces this is READ-ONLY with respect to namespace
 * authorization: an explicit namespace is authorized through the existing
 * `canWriteNamespace` policy path, and a coding overlay is always REBUILT from
 * the authenticated principal's base — never accepted as a caller string — so a
 * caller can never reach another principal's overlay by forging an
 * overlay-shaped namespace (rule 42 / 47 / 48).
 */
export interface MemoryScopePlan {
  /** Resolved request principal (auth precedence applied), or undefined. */
  principal?: string;
  /** Explicit `namespace` supplied by the caller, if any (already authorized). */
  explicitNamespace?: string;
  /** Principal self base namespace before any coding overlay. */
  baseNamespace: string;
  /** Effective write namespace — what every side effect must use. */
  writeNamespace: string;
  /**
   * Effective namespace the objective-state snapshot writer must target.
   *
   * Objective-state has a STRICTER, pre-#1495 contract than the LCM/extraction
   * write path (#928): an IMPLICIT (no explicit `namespace`) snapshot is based
   * on the PRINCIPAL SELF namespace (`defaultNamespaceForPrincipal`) and is
   * authorized against THAT base (rule 48, least-privilege) — never silently
   * routed to `config.defaultNamespace`. Only the LCM/extraction/response path
   * collapses an unqualified write to `config.defaultNamespace` (memory_store
   * parity, rule 39). With an explicit namespace, or once a coding overlay
   * applies, both targets converge: `objectiveStateNamespace === writeNamespace`.
   *
   * Keeping the two as separate fields of ONE plan preserves rule 22 (single
   * resolution point) while honoring each consumer's historical contract.
   */
  objectiveStateNamespace: string;
  /** Namespaces a same-session recall would read (cheap subset). */
  readNamespaces: string[];
  /** Active scope profile id, when `defaultScopeProfile` is configured. */
  scopeProfile?: string;
  /** Internal resolved profile used to keep scoped extraction persistence aligned with access resolution. */
  scopeProfilePlan?: ResolvedScopeProfilePlan | null;
  /** Resolved profile layer that supplied `writeNamespace`. */
  writeLayer?: string;
  /** Resolved profile layers in the active profile contract. */
  layers?: ScopeProfileLayerResolution[];
  /** Authorized promotion targets from the active profile contract. */
  promotionTargets?: ScopeProfilePromotionResolution[];
  /** Whether the coding overlay changed the base namespace. */
  codingOverlayApplied: boolean;
  /** Non-fatal diagnostics surfaced during resolution. */
  warnings: string[];
}

/**
 * Raw `category` spelling retained at the request boundary when the wire
 * schema's canonicalizing transform mapped a compat alias to "fact"
 * (issue #2829). Diagnostic only: drives the response's `categoryCoercion`
 * note and survives quarantine parking for replay. Never reaches the write
 * candidate or the idempotency fingerprint, and never parses from client
 * input (the wire schema strips it).
 */
export interface RetainedCategorySpelling {
  rawCategory?: string;
}

export interface EngramAccessMemoryStoreRequest
  extends EngramAccessWriteEnvelope,
    ExplicitCaptureInput,
    CodingScopedWriteInput,
    RetainedCategorySpelling {}

export interface EngramAccessSuggestionSubmitRequest
  extends EngramAccessWriteEnvelope,
    ExplicitCaptureInput,
    CodingScopedWriteInput,
    RetainedCategorySpelling {}

export interface EngramAccessWriteResponse {
  schemaVersion: 1;
  operation: "memory_store" | "suggestion_submit";
  namespace: string;
  dryRun: boolean;
  accepted: boolean;
  queued: boolean;
  status: "validated" | "stored" | "duplicate" | "queued_for_review";
  memoryId?: string;
  duplicateOf?: string;
  idempotencyKey?: string;
  idempotencyReplay?: boolean;
  /** Present when a project-shaped category alias was coerced to "fact" (#2780/#2829). */
  categoryCoercion?: CategoryAliasCoercion;
}

export interface EngramAccessObserveMessage {
  role: "user" | "assistant";
  content: string;
  parts?: LcmMessagePartInput[];
  rawContent?: unknown;
  sourceFormat?: MessagePartSourceFormat;
}

/**
 * Observe request. Wire fields derive from the canonical zod schema
 * (`observeRequestSchema`, access-schema.ts — issue #2482); the service
 * consumes the transport-cleaned message form (the wire schema tolerates
 * nullable `parts`/`sourceFormat`, the service maps them to `undefined`).
 */
export interface EngramAccessObserveRequest extends Omit<ObserveRequest, "messages">, SourceConnectorProvenance {
  messages: EngramAccessObserveMessage[];
  authenticatedPrincipal?: string;
  readonly suppressQuarantine?: boolean; // #1888: replay re-submit skips dead-lettering.
}

/**
 * Additive diagnostic view of the effective {@link MemoryScopePlan} resolved for
 * an `observe` request (#1495 / epic #1494). Lets callers and tests inspect
 * which namespace the operation actually wrote to without changing the
 * backward-compatible `namespace` field. Purely informational — never gates
 * authorization.
 */
export interface EngramAccessScopeDebug {
  /** Resolved principal, or `undefined` when none could be derived. */
  principal?: string;
  /** Explicit `namespace` from the request, if one was supplied. */
  explicitNamespace?: string;
  /** Principal self base before any coding overlay. */
  baseNamespace: string;
  /** Effective write namespace every side effect of the request uses. */
  writeNamespace: string;
  /** Whether the coding (project/branch) overlay changed the base namespace. */
  codingOverlayApplied: boolean;
  /** Namespaces a same-session recall would read, when cheap to compute. */
  readNamespaces?: string[];
  scopeProfile?: string;
  writeLayer?: string;
  layers?: ScopeProfileLayerResolution[];
  promotionTargets?: ScopeProfilePromotionResolution[];
}

export interface EngramAccessObserveResponse {
  accepted: number;
  sessionKey: string;
  /**
   * Backward-compatible base writable namespace (pre-#1495 semantics). Kept
   * unchanged so existing callers/tests are not broken. The namespace the
   * operation ACTUALLY wrote to is {@link EngramAccessObserveResponse.effectiveNamespace}.
   */
  namespace: string;
  /**
   * Effective write namespace every memory-producing side effect of this
   * request used (LCM archival, extraction replay, objective-state snapshot).
   * Equals the namespace a same-session project-scoped recall searches (#1495).
   */
  effectiveNamespace: string;
  /** Additive diagnostic view of the resolved scope plan (#1495). */
  scopeDebug?: EngramAccessScopeDebug;
  lcmArchived: boolean;
  extractionQueued: boolean;
  /** True when at least one observe-derived turn was appended to the transcript store (issue #2783). False when the transcript capability is off, every message was filtered/deduped, or every append failed. */
  transcriptPersisted: boolean;
  /** True when replayed from the idempotency cache (issue #1649); lets the HTTP surface skip the write-quota slot, matching memory_store replay semantics. */
  idempotencyReplay?: boolean;
}

export interface EngramAccessLcmSearchRequest {
  query: string;
  sessionKey?: string;
  sessionPrefix?: string;
  namespace?: string;
  limit?: number;
  authenticatedPrincipal?: string;
}

export interface EngramAccessLcmSearchResponse {
  query: string;
  namespace: string;
  results: Array<{ sessionId: string; content: string; turnIndex?: number }>;
  count: number;
  lcmEnabled: boolean;
}

export interface EngramAccessLcmStatusResponse {
  enabled: boolean;
  archiveAvailable: boolean;
  stats?: { totalTurns?: number };
}

export interface EngramAccessLcmCompactionRecordRequest {
  sessionKey: string;
  namespace?: string;
  tokensBefore: number;
  tokensAfter: number;
  authenticatedPrincipal?: string;
}

export interface EngramAccessLcmCompactionRecordResponse {
  enabled: boolean;
  recorded: boolean;
  sessionKey: string;
  namespace: string;
  reason?: string;
}

type EngramAccessIdempotencyStatus = "miss" | "replay" | "conflict";

function normalizePagination(limit?: number, offset?: number): { limit: number; offset: number } {
  const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit ?? 50))) : 50;
  const normalizedOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset ?? 0)) : 0;
  return { limit: normalizedLimit, offset: normalizedOffset };
}

function normalizeBrowseSort(
  sort?: EngramAccessMemoryBrowseRequest["sort"]
): NonNullable<EngramAccessMemoryBrowseRequest["sort"]> {
  switch (sort) {
    case "updated_asc":
    case "created_desc":
    case "created_asc":
      return sort;
    case "updated_desc":
    default:
      return "updated_desc";
  }
}

function bucketMemoryAge(referenceIso: string | undefined, nowMs: number): string {
  const referenceMs = referenceIso ? Date.parse(referenceIso) : Number.NaN;
  if (!Number.isFinite(referenceMs)) return "unknown";
  const ageDays = Math.floor((nowMs - referenceMs) / 86_400_000);
  if (ageDays <= 7) return "0_7_days";
  if (ageDays <= 30) return "8_30_days";
  if (ageDays <= 90) return "31_90_days";
  return "91_plus_days";
}

function incrementCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function summarizeTrustZoneRecord(
  record: TrustZoneRecord,
  filePath: string,
  allRecords: TrustZoneRecord[],
  poisoningDefenseEnabled: boolean,
  trustZonesEnabled: boolean,
  promotionEnabled: boolean
): EngramAccessTrustZoneRecordSummary {
  const trustScore = poisoningDefenseEnabled ? scoreTrustZoneProvenance(record) : undefined;
  const readiness = summarizeTrustZonePromotionReadiness({
    record,
    allRecords,
    poisoningDefenseEnabled,
  });
  const promotionReasons = [...readiness.reasons];
  const promotionAllowed = readiness.allowed && trustZonesEnabled === true && promotionEnabled === true;
  if (trustZonesEnabled !== true) {
    promotionReasons.push("trust zone promotion requires trustZonesEnabled=true");
  }
  if (promotionEnabled !== true) {
    promotionReasons.push("trust zone promotion requires quarantinePromotionEnabled=true");
  }
  return {
    recordId: record.recordId,
    filePath,
    zone: record.zone,
    recordedAt: record.recordedAt,
    kind: record.kind,
    summary: record.summary,
    sourceClass: record.provenance.sourceClass,
    sessionKey: record.provenance.sessionKey,
    sourceId: record.provenance.sourceId,
    evidenceHashPresent: typeof record.provenance.evidenceHash === "string",
    anchored: Boolean(record.provenance.sourceId && record.provenance.evidenceHash),
    entityRefs: [...(record.entityRefs ?? [])],
    tags: [...(record.tags ?? [])],
    metadata: record.metadata,
    trustScore,
    nextPromotionTarget: readiness.nextTargetZone,
    nextPromotionAllowed: promotionAllowed,
    nextPromotionReasons: promotionReasons,
    corroborationCount: readiness.requiresCorroboration ? readiness.corroborationCount : undefined,
    corroborationSourceClasses: readiness.requiresCorroboration ? readiness.corroborationSourceClasses : undefined,
  };
}

function compareBrowseMemory(
  sort: NonNullable<EngramAccessMemoryBrowseRequest["sort"]>,
  left: MemoryFile,
  right: MemoryFile
): number {
  const leftUpdated = left.frontmatter.updated ?? left.frontmatter.created ?? "";
  const rightUpdated = right.frontmatter.updated ?? right.frontmatter.created ?? "";
  const leftCreated = left.frontmatter.created ?? "";
  const rightCreated = right.frontmatter.created ?? "";

  switch (sort) {
    case "updated_asc":
      return (
        leftUpdated.localeCompare(rightUpdated) ||
        leftCreated.localeCompare(rightCreated) ||
        left.frontmatter.id.localeCompare(right.frontmatter.id)
      );
    case "created_desc":
      return (
        rightCreated.localeCompare(leftCreated) ||
        rightUpdated.localeCompare(leftUpdated) ||
        left.frontmatter.id.localeCompare(right.frontmatter.id)
      );
    case "created_asc":
      return (
        leftCreated.localeCompare(rightCreated) ||
        leftUpdated.localeCompare(rightUpdated) ||
        left.frontmatter.id.localeCompare(right.frontmatter.id)
      );
    case "updated_desc":
    default:
      return (
        rightUpdated.localeCompare(leftUpdated) ||
        rightCreated.localeCompare(leftCreated) ||
        left.frontmatter.id.localeCompare(right.frontmatter.id)
      );
  }
}

/**
 * Pure helper that shapes a {@link EngramAccessMemorySummary} from a
 * {@link MemoryFile} based on the requested disclosure depth (issue #677
 * PR 2/4).  Extracted so the shaping invariants — chunk emits preview
 * only, section attaches `content`, raw also surfaces `rawExcerpts` when
 * the caller passes them — can be unit-tested without booting an
 * orchestrator.
 *
 * Browse / non-recall paths pass `disclosure === undefined` so the
 * `disclosure`, `content`, and `rawExcerpts` fields are all omitted —
 * preserving the cheap-by-default browse projection.
 */
export function shapeMemorySummary(
  memory: MemoryFile,
  baseDir: string,
  disclosure?: RecallDisclosure,
  rawExcerpts?: EngramAccessMemorySummary["rawExcerpts"]
): EngramAccessMemorySummary {
  const includeFullContent = disclosure === "section" || disclosure === "raw";
  return {
    id: memory.frontmatter.id,
    path: memory.path,
    category: memory.frontmatter.category,
    status: inferMemoryStatus(memory.frontmatter, toMemoryPathRel(baseDir, memory.path)),
    created: memory.frontmatter.created,
    updated: memory.frontmatter.updated,
    tags: normalizeProjectionTags(memory.frontmatter.tags),
    entityRef: memory.frontmatter.entityRef,
    preview: normalizeProjectionPreview(memory.content),
    ...(disclosure !== undefined ? { disclosure } : {}),
    ...(includeFullContent ? { content: memory.content } : {}),
    ...(disclosure === "raw" && rawExcerpts !== undefined ? { rawExcerpts } : {}),
  };
}

export class EngramAccessService extends SupportPassportAccessServiceBase {
  private readonly idempotency: AccessIdempotencyStore;
  private readonly idempotencyLocks = new Map<string, Promise<void>>();
  private readonly recallSemaphores = new Map<string, unknown>();
  private readonly recallInFlight = new Map<string, unknown>();
  private readonly budget: CrossNamespaceBudget;
  private readonly auditAdapter: AccessAuditAdapter | null;
  private readonly corpusWatermarkCache = new CorpusWatermarkCache();
  private readonly replicaDivergenceMonitor: ReplicaDivergenceMonitor;
  private readonly injectedSupportPassportGatewayRoute: SupportPassportModelRoute | null;
  readonly reviewDeckEnabled: boolean;

  /** AccessObserveWriteSurface (access-service decomposition). Lazy; selfDeps live wiring. */
  private _accessObserveWriteSurface: AccessObserveWriteSurface | undefined;

  private get accessObserveWriteSurface(): AccessObserveWriteSurface {
    if (!this._accessObserveWriteSurface) {
      this._accessObserveWriteSurface = new AccessObserveWriteSurface(
        selfDeps<ConstructorParameters<typeof AccessObserveWriteSurface>[0]>(this)
      );
    }
    return this._accessObserveWriteSurface;
  }

  /** AccessLcmSurface (access-service decomposition). Lazy; selfDeps live wiring. */
  private _accessLcmSurface: AccessLcmSurface | undefined;

  private get accessLcmSurface(): AccessLcmSurface {
    if (!this._accessLcmSurface) {
      this._accessLcmSurface = new AccessLcmSurface(selfDeps<ConstructorParameters<typeof AccessLcmSurface>[0]>(this));
    }
    return this._accessLcmSurface;
  }

  /** AccessAdminOpsSurface (access-service decomposition). Lazy; selfDeps live wiring. */
  private _accessAdminOpsSurface: AccessAdminOpsSurface | undefined;

  private get accessAdminOpsSurface(): AccessAdminOpsSurface {
    if (!this._accessAdminOpsSurface) {
      this._accessAdminOpsSurface = new AccessAdminOpsSurface(
        selfDeps<ConstructorParameters<typeof AccessAdminOpsSurface>[0]>(this)
      );
    }
    return this._accessAdminOpsSurface;
  }

  private _reviewDeckSurface: ReviewDeckSurface | undefined;

  private get reviewDeckSurface(): ReviewDeckSurface {
    if (!this._reviewDeckSurface) {
      this._reviewDeckSurface = new ReviewDeckSurface(
        selfDeps<ConstructorParameters<typeof ReviewDeckSurface>[0]>(this)
      );
    }
    return this._reviewDeckSurface;
  }

  /** AccessRecallSurface (access-service decomposition). Lazy; selfDeps live wiring. */
  private _accessRecallSurface: AccessRecallSurface | undefined;

  private get accessRecallSurface(): AccessRecallSurface {
    if (!this._accessRecallSurface) {
      this._accessRecallSurface = new AccessRecallSurface(
        selfDeps<ConstructorParameters<typeof AccessRecallSurface>[0]>(this)
      );
    }
    return this._accessRecallSurface;
  }

  /** AccessIdentityContinuitySurface (access-service decomposition). Lazy; selfDeps live wiring. */
  private _accessIdentityContinuitySurface: AccessIdentityContinuitySurface | undefined;

  private get accessIdentityContinuitySurface(): AccessIdentityContinuitySurface {
    if (!this._accessIdentityContinuitySurface) {
      this._accessIdentityContinuitySurface = new AccessIdentityContinuitySurface(
        selfDeps<ConstructorParameters<typeof AccessIdentityContinuitySurface>[0]>(this)
      );
    }
    return this._accessIdentityContinuitySurface;
  }
  private readonly extractionLivenessWarn = new ExtractionLivenessWarnThrottle();

  constructor(
    private readonly orchestrator: Orchestrator,
    options: {
      resolveSecretRef?: ResolveSecretRefFn | null;
      supportPassportGatewayRoute?: SupportPassportModelRoute | null;
      reviewDeckEnabled?: boolean;
    } = {}
  ) {
    super();
    this.idempotency = new AccessIdempotencyStore(orchestrator.config.memoryDir);
    // Peer SecretRef tokens resolve at poll time through the host resolver, the
    // same indirection as agentAccessHttp.authToken (review round 1). Absent a
    // resolver, string/${ENV} tokens still work and a SecretRef degrades to a
    // per-peer `unreachable` (never a throw).
    this.replicaDivergenceMonitor = new ReplicaDivergenceMonitor({ resolveSecretRef: options.resolveSecretRef });
    this.injectedSupportPassportGatewayRoute = options.supportPassportGatewayRoute ?? null;
    this.reviewDeckEnabled = options.reviewDeckEnabled === true;
    const accessCaps = resolveAccessSetupCapabilities(orchestrator.config); // #1566 Cluster B
    this.budget = new CrossNamespaceBudget({
      enabled: accessCaps.recallCrossNamespaceBudget,
      windowMs: orchestrator.config.recallCrossNamespaceBudgetWindowMs,
      softLimit: orchestrator.config.recallCrossNamespaceBudgetSoftLimit,
      hardLimit: orchestrator.config.recallCrossNamespaceBudgetHardLimit,
    });

    const auditEnabled = accessCaps.recallAuditAnomalyDetection;
    const auditLogEnabled = false; // Audit JSONL logging — off until wired to a directory
    if (auditEnabled || auditLogEnabled) {
      const auditConfig: AccessAuditConfig = {
        audit: {
          enabled: auditLogEnabled,
          rootDir: orchestrator.config.memoryDir,
        },
        detection: {
          enabled: auditEnabled,
          windowMs: orchestrator.config.recallAuditAnomalyWindowMs,
          repeatQueryLimit: orchestrator.config.recallAuditAnomalyRepeatQueryLimit,
          namespaceWalkLimit: orchestrator.config.recallAuditAnomalyNamespaceWalkLimit,
          highCardinalityReturnLimit: orchestrator.config.recallAuditAnomalyHighCardinalityLimit,
          rapidFireLimit: orchestrator.config.recallAuditAnomalyRapidFireLimit,
        },
      };
      this.auditAdapter = new AccessAuditAdapter(auditConfig);
    } else {
      this.auditAdapter = null;
    }
  }

  override get supportPassportGatewayRouteRef(): SupportPassportModelRoute | null {
    return this.injectedSupportPassportGatewayRoute;
  }

  get briefingEnabled(): boolean {
    return this.orchestrator.config.briefing?.enabled === true;
  }

  private resolveNamespace(namespace?: string): string {
    const requested = namespace?.trim();
    if (!requested) return this.orchestrator.config.defaultNamespace;
    if (
      !resolveNamespaceCapabilities(this.orchestrator.config).namespaces &&
      requested !== this.orchestrator.config.defaultNamespace
    ) {
      throw new EngramAccessInputError(`unsupported namespace: ${requested}`);
    }
    return requested;
  }

  private normalizeRecallMode(mode?: RecallPlanMode | "auto"): RecallPlanMode | undefined {
    if (!mode || mode === "auto") return undefined;
    if (mode === "no_recall" || mode === "minimal" || mode === "full" || mode === "graph_mode") {
      return mode;
    }
    throw new EngramAccessInputError(`unsupported recall mode: ${mode}`);
  }

  private resolveRecallNamespace(
    namespace: string | undefined,
    sessionKey: string | undefined,
    authenticatedPrincipal?: string
  ): string | undefined {
    const requested = namespace?.trim();
    if (!requested) return undefined;
    const resolved = this.resolveNamespace(requested);
    const principal = this.resolveRequestPrincipal(sessionKey, authenticatedPrincipal);
    if (!canReadNamespace(principal, resolved, this.orchestrator.config)) {
      throw new EngramAccessInputError(`namespace override is not readable: ${resolved}`);
    }
    return resolved;
  }

  private resolveRequestPrincipal(sessionKey: string | undefined, authenticatedPrincipal?: string): string | undefined {
    const trusted = authenticatedPrincipal?.trim();
    if (trusted) return trusted;
    return resolvePrincipal(sessionKey, this.orchestrator.config);
  }

  private writableNamespaceFor(
    namespace: string | undefined,
    sessionKey: string | undefined,
    authenticatedPrincipal?: string
  ): string {
    // #1521: delegates to the scope-module resolver. The inline
    // namespace/principal resolution + writability check is retired so the
    // adHocNamespaceResolutions ratchet no longer counts this site.
    const result = resolveWritableNamespaceValue(
      namespace,
      sessionKey,
      authenticatedPrincipal,
      this.orchestrator.config
    );
    if (!result.ok) {
      if (result.reason === "unsupported") {
        throw new EngramAccessInputError(`unsupported namespace: ${result.namespace}`);
      }
      throw new NamespaceNotWritableError(
        result.namespace,
        this.resolveRequestPrincipal(sessionKey, authenticatedPrincipal)
      );
    }
    return result.namespace;
  }

  /** Shared coding-scope derivation for the read/write resolvers below —
   *  coding context, overlay, principal, scope-profile plan for an IMPLICIT
   *  request, IDENTICAL to recall precedence (session-first, per-call fallback)
   *  so a scoped store is discoverable by scoped recall (#1434). Single source
   *  of truth for the namespacesEnabled/projectScope gates (rule 22; keeps the
   *  scattered-config-read ratchet flat). READ-ONLY: never mutates session. */
  private async resolveCodingScopeInputs(
    request: InterruptibleCodingScopeInput & {
      namespace?: string;
      sessionKey?: string;
      authenticatedPrincipal?: string;
    }
  ): Promise<{
    principal: string | undefined;
    codingContext: CodingContext | null;
    overlay: CodingNamespaceOverlay | null;
    profilePlan: ResolvedScopeProfilePlan | null;
  }> {
    // A sessionKey is REQUIRED to apply the overlay. The recall path can only
    // attach/look up coding context per session, so a sessionless recall always
    // searches the base namespace; a sessionless write/read must too — otherwise
    // a client that injects cwd/projectTag but no sessionKey would land in a
    // `default-project-*` namespace its own recall never searches (Codex review).
    const hasSession = typeof request.sessionKey === "string" && request.sessionKey.length > 0;
    const codingContext =
      hasSession &&
      resolveNamespaceCapabilities(this.orchestrator.config).namespaces &&
      this.orchestrator.config.codingMode?.projectScope
        ? (this.orchestrator.getCodingContextForSession(request.sessionKey) ??
          (await resolveCodingContextFromOptions(request)))
        : null;
    const overlay =
      hasSession &&
      resolveNamespaceCapabilities(this.orchestrator.config).namespaces &&
      this.orchestrator.config.codingMode?.projectScope
        ? resolveCodingNamespaceOverlay(
            codingContext,
            this.orchestrator.config.codingMode,
            this.orchestrator.config.defaultNamespace
          )
        : null;
    const principal = this.resolveRequestPrincipal(request.sessionKey, request.authenticatedPrincipal);
    const profilePlan = resolveScopeProfilePlan({
      config: this.orchestrator.config,
      principal,
      codingContext,
      codingOverlay: overlay,
    });
    return { principal, codingContext, overlay, profilePlan };
  }

  private assertTokenCanWriteNamespace(namespace: string): void {
    enforceNamespaceAllowList(tokenCapabilityStore.getStore(), namespace, this.orchestrator.config.defaultNamespace);
  }

  /**
   * Resolve the write namespace for explicit-write tools (memory_store /
   * suggestion_submit), project-scoping the write the same way recall does so a
   * memory stored with a client-injected `cwd`/`projectTag` is discoverable by
   * project-scoped recall (#1434, rule 42). Shared derivation lives in
   * {@link resolveCodingScopeInputs}; this method enforces the WRITE acl
   * (`canWriteNamespace` / profile-layer writability). Read-only: never mutates
   * session coding context.
   */
  private async resolveCodingScopedWriteNamespace(
    request: CodingScopedWriteInput & {
      namespace?: string;
      sessionKey?: string;
      authenticatedPrincipal?: string;
    },
    enforceToken = true
  ): Promise<string> {
    const requested = request.namespace?.trim();
    if (requested) {
      const namespace = this.writableNamespaceFor(requested, request.sessionKey, request.authenticatedPrincipal);
      if (enforceToken) this.assertTokenCanWriteNamespace(namespace);
      return namespace;
    }

    const { principal, overlay, profilePlan } = await this.resolveCodingScopeInputs(request);
    const result = resolveScopedWritableNamespaceValue({
      sessionKey: request.sessionKey,
      authenticatedPrincipal: request.authenticatedPrincipal,
      principal,
      codingOverlay: overlay,
      scopeProfile: profilePlan,
      config: this.orchestrator.config,
    });
    if (result.ok) {
      if (enforceToken) this.assertTokenCanWriteNamespace(result.namespace);
      return result.namespace;
    }
    if (profilePlan && result.namespace === profilePlan.writeNamespace) {
      throw new NamespaceNotWritableError(
        result.namespace,
        principal,
        `scope profile ${profilePlan.profileId} has no writable layer for principal ${principal ?? "anonymous"}`
      );
    }

    if (result.reason === "unsupported") {
      throw new EngramAccessInputError(`unsupported namespace: ${result.namespace}`);
    }
    throw new NamespaceNotWritableError(result.namespace, principal);
  }

  async namespaceWritablePreflight(request: EngramAccessNamespaceWritableRequest): Promise<WritableNamespaceResult> {
    return resolveNamespaceWritablePreflight(request, (preflightRequest) =>
      this.resolveCodingScopedWriteNamespace(preflightRequest, false)
    );
  }

  /**
   *  `list`/`get` use this so a record written by a project-scoped session is
   *  listable/fetchable by the SAME session without manually supplying the
   *  overlaid namespace (review P2). Derivation is IDENTICAL to the write path
   *  (shared via {@link resolveCodingScopeInputs}); the only difference is the
   *  ACL — reads enforce {@link canReadNamespace}, so a read-but-not-write
   *  principal can still list/fetch (rule 42). */
  private async resolveCodingScopedReadableNamespace(
    request: CodingScopedWriteInput & {
      namespace?: string;
      sessionKey?: string;
      authenticatedPrincipal?: string;
    }
  ): Promise<string> {
    const principal = this.resolveRequestPrincipal(request.sessionKey, request.authenticatedPrincipal);
    const hasExplicitNamespace = typeof request.namespace === "string" && request.namespace.trim().length > 0;
    if (hasExplicitNamespace) {
      return this.resolveReadableNamespace(request.namespace, principal);
    }
    const inputs = await this.resolveCodingScopeInputs(request);
    const { overlay, profilePlan, principal: resolvedPrincipal } = inputs;
    if (profilePlan) {
      // The write layer is the namespace decisions are RECORDED under. The
      // WRITE path authorizes it through the profile plan (selectedLayer.
      // writable AND readNamespaces.includes(writeNamespace)), NOT the raw
      // namespace ACL, so the READ path must use the SAME profile-plan
      // authorization. canReadNamespace only recognizes explicit policies
      // plus default/shared namespaces, which would reject a profile-granted
      // layer the same session just wrote through (review P2: scope-profile
      // read authorization for decision reads; rule 42).
      const target = profilePlan.writeNamespace;
      if (!profilePlan.readNamespaces.includes(target)) {
        throw new EngramAccessInputError(`namespace is not readable: ${target}`);
      }
      return target;
    }
    if (!overlay) {
      // No coding overlay → read the base namespace through the standard read
      // ACL, identical to memory_get with no explicit namespace.
      return this.resolveReadableNamespace(undefined, resolvedPrincipal);
    }
    // Coding overlay → overlay onto the principal self base, the SAME namespace
    // the write path writes to, then enforce the read ACL.
    const base = defaultNamespaceForPrincipal(resolvedPrincipal, this.orchestrator.config);
    if (!canReadNamespace(resolvedPrincipal, base, this.orchestrator.config)) {
      throw new EngramAccessInputError(`namespace is not readable: ${base}`);
    }
    return combineNamespaces(base, overlay.namespace);
  }

  /**
   * Resolve ONE effective memory scope plan for a write-producing request
   * (#1495 / seed for epic #1494). The returned {@link MemoryScopePlan} is the
   * single source of truth `observe` (and, later, other write surfaces) consume
   * so every side effect lands in `plan.writeNamespace`.
   *
   * Authorization mirrors {@link resolveCodingScopedWriteNamespace} EXACTLY so
   * `observe`'s scoping is identical to `memory_store`/`suggestion_submit`
   * (rule 39 — feature gates identical across code paths):
   *  - an explicit `namespace` always wins and is authorized strictly through
   *    `resolveWritableNamespace` → `canWriteNamespace`; an overlay-shaped string
   *    is never a writable target (rule 42 / 47 / 48);
   *  - with NO overlay, the base stays on `config.defaultNamespace` (pre-#1434
   *    behavior), auth-checked;
   *  - WITH an overlay, the base is the principal self namespace and the overlay
   *    is REBUILT from that authorized base — never accepted as a caller string.
   *
   * READ-ONLY: this never mutates session coding context. Callers that need the
   * `cwd`/`projectTag` bound to the session (so a later bare recall is scoped)
   * must attach it via `maybeAttachCodingContext` BEFORE calling this, which
   * also preserves the no-orphan-context guard (attach only after auth passes).
   * The overlay here reads the session's attached context first (matching recall
   * precedence), falling back to the per-call `cwd`/`projectTag`.
   */
  private async resolveMemoryScopePlan(
    request: InterruptibleCodingScopeInput & {
      namespace?: string;
      sessionKey?: string;
      authenticatedPrincipal?: string;
    }
  ): Promise<MemoryScopePlan> {
    const warnings: string[] = [];
    const principal = this.resolveRequestPrincipal(request.sessionKey, request.authenticatedPrincipal);
    const hasExplicitNamespace = typeof request.namespace === "string" && request.namespace.trim().length > 0;

    if (hasExplicitNamespace) {
      // Explicit namespace wins; authorized through the existing policy path.
      // The overlay never applies, so base == write == the explicit namespace.
      // Objective-state converges on the same explicit target (the stricter
      // principal-self contract only governs the IMPLICIT path).
      const writeNamespace = this.writableNamespaceFor(
        request.namespace,
        request.sessionKey,
        request.authenticatedPrincipal
      );
      this.assertTokenCanWriteNamespace(writeNamespace);
      return {
        principal,
        explicitNamespace: request.namespace!.trim(),
        baseNamespace: writeNamespace,
        writeNamespace,
        objectiveStateNamespace: writeNamespace,
        readNamespaces: [writeNamespace],
        codingOverlayApplied: false,
        warnings,
      };
    }

    // No explicit namespace → principal self base, optionally overlaid with the
    // session's coding (project/branch) context — the SAME resolution recall and
    // the orchestrator buffer-flush write path use (rule 42 symmetry).
    const baseNamespace = defaultNamespaceForPrincipal(principal, this.orchestrator.config);

    // Resolve the coding context and overlay through the shared read-only
    // resolver used by the other scoped access paths. It applies the same
    // session-first, per-call fallback precedence without mutating session
    // state, so concurrent requests cannot observe temporary context.
    const { overlay: codingOverlay, profilePlan } = await this.resolveCodingScopeInputs(request);
    const overlaidBase = codingOverlay ? combineNamespaces(baseNamespace, codingOverlay.namespace) : baseNamespace;
    const codingOverlayApplied = overlaidBase !== baseNamespace;
    const assertWriteNamespaceAllowed = (namespace: string): void => {
      this.assertTokenCanWriteNamespace(namespace);
    };
    if (profilePlan) {
      const selectedLayer = profilePlan.layers.find((layer) => layer.id === profilePlan.writeLayer);
      const writeNamespaceReadable =
        profilePlan.writeNamespace.length > 0 && profilePlan.readNamespaces.includes(profilePlan.writeNamespace);
      if (!selectedLayer?.writable || !writeNamespaceReadable) {
        throw new NamespaceNotWritableError(
          profilePlan.writeNamespace,
          principal,
          `scope profile ${profilePlan.profileId} has no writable layer for principal ${principal ?? "anonymous"}`
        );
      }
      const legacyRecallNamespaces = Array.isArray(this.orchestrator.config.defaultRecallNamespaces)
        ? recallNamespacesForPrincipal(principal, this.orchestrator.config)
        : [];
      const expandedReadNamespaces = expandScopeProfileReadNamespaces({
        profilePlan,
        principalSelfNamespace: profilePlan.baseNamespace,
        config: this.orchestrator.config,
        principal,
        codingOverlay,
        legacyRecallNamespaces,
      });
      const readNamespaces = expandedReadNamespaces;
      const profileCodingOverlayApplied = Boolean(
        codingOverlay &&
          profilePlan.layers.some(
            (layer) =>
              (layer.id === "userProject" || layer.id === "teamProject") &&
              layer.readable &&
              layer.namespace &&
              readNamespaces.includes(layer.namespace)
          )
      );
      assertWriteNamespaceAllowed(profilePlan.writeNamespace);
      return {
        principal,
        baseNamespace: profilePlan.baseNamespace,
        writeNamespace: profilePlan.writeNamespace,
        objectiveStateNamespace: profilePlan.writeNamespace,
        readNamespaces,
        scopeProfile: profilePlan.profileId,
        scopeProfilePlan: profilePlan,
        writeLayer: profilePlan.writeLayer,
        layers: profilePlan.layers,
        promotionTargets: profilePlan.promotionTargets,
        codingOverlayApplied: profileCodingOverlayApplied,
        warnings: [...warnings, ...profilePlan.warnings],
      };
    }

    if (!codingOverlayApplied) {
      // No overlay → the LCM/extraction/response write namespace mirrors the
      // legacy memory_store path (resolveWritableNamespace with no explicit
      // namespace), collapsing the namespaces-disabled / no-session /
      // projectScope-off cases to config.defaultNamespace exactly as before
      // (rule 39 parity with resolveCodingScopedWriteNamespace).
      const writeNamespace = this.writableNamespaceFor(undefined, request.sessionKey, request.authenticatedPrincipal);
      // Objective-state keeps its STRICTER pre-#1495 contract (#928): an implicit
      // snapshot is based on the PRINCIPAL SELF namespace and authorized against
      // THAT base (rule 48 least-privilege). This rejection MUST stay (security):
      // an implicit observe by a principal that cannot write its own self
      // namespace must not silently snapshot objective-state to the default
      // store.
      //
      // GATED on objective-state writes being ENABLED, exactly like the pre-#1495
      // code (`if (shouldWriteObjectiveState && !hasExplicitNamespace && …)`).
      // The general LCM/extraction write path collapses an unqualified write to
      // config.defaultNamespace (always writable), so when objective-state writes
      // are OFF there is no self-base write to authorize and observe must NOT
      // reject (the "skips … when writes are disabled" invariant). When namespaces
      // are off the self base collapses to config.defaultNamespace, so this is a
      // no-op for single-store deployments either way.
      const willWriteObjectiveState =
        resolveObjectiveStateCapabilities(this.orchestrator.config).objectiveStateMemory === true &&
        resolveObjectiveStateCapabilities(this.orchestrator.config).objectiveStateSnapshotWrites === true;
      if (
        willWriteObjectiveState &&
        resolveNamespaceCapabilities(this.orchestrator.config).namespaces === true &&
        !canWriteNamespace(principal, baseNamespace, this.orchestrator.config)
      ) {
        throw new NamespaceNotWritableError(baseNamespace, principal);
      }
      assertWriteNamespaceAllowed(writeNamespace);
      return {
        principal,
        // scopeDebug.baseNamespace must report the principal SELF base
        // (`defaultNamespaceForPrincipal`), NOT the general write namespace —
        // which collapses to config.defaultNamespace on this implicit no-overlay
        // path (#1505 cursor "Wrong scopeDebug base namespace"). It already
        // matches `objectiveStateNamespace` below; `writeNamespace` is unchanged.
        baseNamespace,
        writeNamespace,
        // Implicit objective-state stays on the principal self base, NOT the
        // (possibly default) general write namespace — preserving the #928
        // semantics the objective-state suite asserts.
        objectiveStateNamespace: baseNamespace,
        readNamespaces: [writeNamespace],
        codingOverlayApplied: false,
        warnings,
      };
    }

    // Overlay applied → both the general write namespace AND objective-state
    // converge on the overlaid principal self base. Authorize the self base
    // (the overlay is a principal-owned `project-*` sub-namespace derived from
    // it, so it needs no separate write policy — rule 42 / 47 / 48).
    if (!canWriteNamespace(principal, baseNamespace, this.orchestrator.config)) {
      throw new NamespaceNotWritableError(baseNamespace, principal);
    }
    const writeNamespace = overlaidBase;
    const readNamespaces = [writeNamespace];
    // Include read fallbacks (branch→project→root) so the diagnostic readNamespaces
    // matches what a same-session recall searches. They come from the shared pure
    // coding-scope resolver, so the write namespace and read fallbacks agree.
    for (const fallback of codingOverlay?.readFallbacks ?? []) {
      const ns = combineNamespaces(baseNamespace, fallback);
      if (!readNamespaces.includes(ns)) readNamespaces.push(ns);
    }
    assertWriteNamespaceAllowed(writeNamespace);
    return {
      principal,
      baseNamespace,
      writeNamespace,
      objectiveStateNamespace: writeNamespace,
      readNamespaces,
      codingOverlayApplied: true,
      warnings,
    };
  }

  private legacyResponseNamespaceForScope(scope: MemoryScopePlan): string {
    if (scope.explicitNamespace) return scope.writeNamespace;
    // Legacy overlay compatibility only applies to the principal-owned
    // user-project layer. Hosted profile layers such as teamProject are not the
    // old overlay response shape; reporting default there hides the real write.
    if (scope.scopeProfile && scope.writeLayer !== "userProject") {
      return scope.writeNamespace;
    }
    return scope.codingOverlayApplied ? this.orchestrator.config.defaultNamespace : scope.writeNamespace;
  }

  private async objectiveStateStoreLocationForNamespace(namespace: string): Promise<{
    memoryDir: string;
    objectiveStateStoreDir?: string;
  }> {
    if (!resolveNamespaceCapabilities(this.orchestrator.config).namespaces) {
      return {
        memoryDir: this.orchestrator.config.memoryDir,
        objectiveStateStoreDir: this.orchestrator.config.objectiveStateStoreDir,
      };
    }
    const storage = await this.orchestrator.getStorage(namespace);
    return {
      memoryDir: storage.dir,
      objectiveStateStoreDir: objectiveStateStoreOverrideForNamespace({
        memoryDir: this.orchestrator.config.memoryDir,
        configuredStoreDir: this.orchestrator.config.objectiveStateStoreDir,
        namespacesEnabled: resolveNamespaceCapabilities(this.orchestrator.config).namespaces,
        namespace,
      }),
    };
  }

  private resolveReadableNamespace(namespace: string | undefined, principal?: string): string {
    const resolved = this.resolveNamespace(namespace);
    const namespacesEnabled = resolveNamespaceCapabilities(this.orchestrator.config).namespaces;

    if (!namespacesEnabled) {
      // Namespaces are disabled globally — no ACL needed for any caller.
      return resolved;
    }

    // Namespaces are enabled.  An absent principal means the caller is
    // unauthenticated.  Unauthenticated callers must NOT be allowed to read
    // arbitrary namespaces: that would bypass all readPrincipals policies.
    if (!principal) {
      throw new EngramAccessInputError("authentication required: namespaces are enabled and no principal was supplied");
    }

    // Authenticated caller — enforce the namespace ACL as normal.
    if (!canReadNamespace(principal, resolved, this.orchestrator.config)) {
      throw new EngramAccessInputError(`namespace is not readable: ${resolved}`);
    }
    return resolved;
  }

  private async resolveReadableNamespacesForSearch(
    namespace: string | undefined,
    principal?: string
  ): Promise<string[]> {
    const requested = namespace?.trim();
    if (requested) {
      return [this.resolveReadableNamespace(requested, principal)];
    }

    if (!resolveNamespaceCapabilities(this.orchestrator.config).namespaces) {
      return [this.resolveNamespace(undefined)];
    }

    if (!principal) {
      throw new EngramAccessInputError("authentication required: namespaces are enabled and no principal was supplied");
    }

    const legacyRecallNamespaces = recallNamespacesForPrincipal(principal, this.orchestrator.config);
    const profilePlan = resolveScopeProfilePlan({
      config: this.orchestrator.config,
      principal,
      codingContext: null,
      codingOverlay: null,
    });
    if (profilePlan) {
      // Issue #2018: memory_search has no sessionKey, so unlike recall it
      // cannot resolve a coding overlay. Reach the base collection (default
      // namespace) only when the profile intends a global layer and the
      // principal is authorized — see access-memory-search-fanout.ts. The
      // flat-root storage probe runs lazily HERE (after auth, no explicit
      // namespace, profile active) so explicit-namespace queries and auth
      // rejections never touch the default store (#2056 r5).
      const profileNamespaces = expandScopeProfileReadNamespaces({
        profilePlan,
        principalSelfNamespace: profilePlan.baseNamespace,
        config: this.orchestrator.config,
        principal,
        codingOverlay: null,
        legacyRecallNamespaces,
      });
      const fallback = await resolveMemorySearchDefaultFallback({
        profilePlan,
        config: this.orchestrator.config,
        principal,
        defaultAtFlatRootProvider: () =>
          defaultNamespaceAtFlatRoot((n) => this.orchestrator.getStorage(n), this.orchestrator.config),
      });
      return mergeMemorySearchDefaultFallback(profileNamespaces, fallback);
    }
    return legacyRecallNamespaces.filter((ns) => canReadNamespace(principal, ns, this.orchestrator.config));
  }

  private resolveAllReadableConfiguredNamespaces(principal: string): string[] {
    const config = this.orchestrator.config;
    const candidates = [
      config.defaultNamespace,
      config.sharedNamespace,
      ...config.namespacePolicies.map((policy) => policy.name),
    ];
    return [...new Set(candidates)].filter((namespace) => canReadNamespace(principal, namespace, config));
  }

  private resolveMemorySearchNamespacesForCollection(
    collection: string | undefined,
    namespaces: string[],
    collectionPrincipal?: string
  ): string[] {
    if (!resolveNamespaceCapabilities(this.orchestrator.config).namespaces) {
      return namespaces;
    }

    const baseCollection = this.orchestrator.config.qmdCollection;
    if (!collection || collection === "global" || collection === baseCollection) {
      return namespaces;
    }

    const activeScopeProfilePlan = collectionPrincipal
      ? resolveScopeProfilePlan({
          config: this.orchestrator.config,
          principal: collectionPrincipal,
          codingContext: null,
          codingOverlay: null,
        })
      : null;
    const candidates = collectionPrincipal
      ? activeScopeProfilePlan
        ? namespaces
        : this.resolveAllReadableConfiguredNamespaces(collectionPrincipal)
      : namespaces;
    const matchedNamespaces = candidates.filter((namespace) => {
      const canonical = namespaceCollectionName(baseCollection, namespace, {
        defaultNamespace: this.orchestrator.config.defaultNamespace,
        useLegacyDefaultCollection: false,
      });
      const legacyDefault = namespaceCollectionName(baseCollection, namespace, {
        defaultNamespace: this.orchestrator.config.defaultNamespace,
        useLegacyDefaultCollection: true,
      });
      return collection === canonical || collection === legacyDefault;
    });

    if (matchedNamespaces.length > 0) {
      return matchedNamespaces;
    }

    throw new EngramAccessInputError("collection is not namespace-scoped for the requested principal");
  }

  private async buildRecallDebug(
    snapshot: LastRecallSnapshot | null,
    namespace: string,
    includeDebug: boolean,
    sessionKey?: string
  ): Promise<EngramAccessRecallResponse["debug"] | undefined> {
    if (!includeDebug) return undefined;
    if (!sessionKey?.trim()) return undefined;
    const [intent, graph] = await Promise.all([
      this.orchestrator.recallIntrospection.getLastIntentSnapshot(namespace),
      this.orchestrator.recallIntrospection.getLastGraphRecallSnapshot(namespace),
    ]);
    return snapshot || intent || graph
      ? {
          snapshot: snapshot ?? undefined,
          intent,
          graph,
        }
      : undefined;
  }

  private async buildRecallResponseFromXraySnapshot(options: {
    query: string;
    sessionKey?: string;
    snapshot: RecallXraySnapshot;
    disclosure: RecallDisclosure;
    startedAt: number;
    requestedMode?: RecallPlanMode | "auto";
    normalizedMode?: RecallPlanMode;
    /**
     * Read-authorization-gated namespace for the raw-excerpt LCM lookup (#1505
     * thread 2f7). Threaded through to `serializeRecallResults` so the
     * `includeRecall` x-ray path honours the SAME read gate as normal recall and
     * never attaches overlay transcript rows the gate excludes.
     */
    rawExcerptNamespace?: string;
    /**
     * Ordered, read-authorized LCM read session_id SET (#1505 fallback
     * unification). Threaded through to `serializeRecallResults` so the x-ray raw
     * disclosure path also finds excerpts archived at the coding read fallbacks.
     */
    rawExcerptSessionIds?: string[];
    /**
     * Force NO raw excerpts (#1505 thread NBHWz). Set when the IMPLICIT
     * raw-excerpt read gate found NO readable LCM namespace, so the x-ray
     * includeRecall path degrades to empty excerpts rather than falling back to
     * the write/overlay namespace the read gate excludes.
     */
    rawExcerptsSuppressed?: boolean;
  }): Promise<EngramAccessRecallResponse> {
    return this.accessRecallSurface.buildRecallResponseFromXraySnapshot(options);
  }

  private async serializeRecallResults(
    snapshot: LastRecallSnapshot | null,
    disclosure: RecallDisclosure,
    rawContext: {
      query: string;
      sessionKey?: string;
      /**
       * Read-authorization-gated namespace for the raw-excerpt LCM lookup
       * (#1505 thread 2f7). When the caller supplies it, the raw lookup uses
       * THIS namespace prefix instead of `snapshot.namespace` (the
       * write/overlay namespace), so raw disclosure honours the SAME read
       * gate as normal recall + `lcmSearch`. Omitted ⇒ falls back to the
       * snapshot namespace (single-store / sessionless callers, unchanged).
       */
      rawExcerptNamespace?: string;
      /**
       * Ordered, read-authorized LCM read session_id SET (#1505 fallback
       * unification). When supplied, raw disclosure queries each key (primary
       * coding overlay → read fallbacks) and merges rows so a branch-scoped
       * session finds excerpts archived at project/root scope. Already
       * read-gated, so no unauthorized overlay key is present. Omitted ⇒ the
       * legacy single `rawExcerptNamespace`-prefixed key (unchanged).
       */
      rawExcerptSessionIds?: string[];
      /**
       * Force NO raw excerpts even when `disclosure === "raw"` (#1505 thread
       * NBHWz). Set by callers when the IMPLICIT raw-excerpt read gate found
       * NO readable LCM namespace (a restrictive `default` READ policy with
       * no readable overlay/self namespace). The lookup must NOT fall back to
       * `snapshot.namespace` (the write/overlay namespace the read gate
       * excludes) — it returns empty excerpts so raw recall degrades
       * gracefully instead of leaking unreadable rows or throwing.
       */
      rawExcerptsSuppressed?: boolean;
    } | null = null
  ): Promise<EngramAccessMemorySummary[]> {
    return this.accessRecallSurface.serializeRecallResults(snapshot, disclosure, rawContext);
  }

  private async storageForAbsoluteRecallPath(
    memoryPath: string,
    primaryNamespace: string,
    recallNamespaces: readonly string[] = []
  ): Promise<{ storage: StorageManager; dir: string; namespace: string } | null> {
    const resolvedPath = nodePath.resolve(memoryPath);
    const memoryRoot = nodePath.resolve(this.orchestrator.config.memoryDir);
    const namespacesRoot = nodePath.join(memoryRoot, "namespaces");
    const configuredNamespaces = new Set<string>();
    configuredNamespaces.add(primaryNamespace);
    for (const namespace of recallNamespaces) {
      configuredNamespaces.add(namespace);
    }
    configuredNamespaces.add(this.orchestrator.config.defaultNamespace);
    configuredNamespaces.add(this.orchestrator.config.sharedNamespace);
    // Legacy snapshots persist an absolute resultPath with no per-result namespace;
    // derive the on-disk owner (decoded) so those paths still resolve (#2020).
    if (isPathInsideStorageRoot(namespacesRoot, resolvedPath)) {
      const [seg] = nodePath.relative(namespacesRoot, resolvedPath).split(/[\\/]/);
      if (seg) configuredNamespaces.add(namespaceIdentityFromToken(seg) ?? seg);
    }
    for (const policy of this.orchestrator.config.namespacePolicies ?? []) configuredNamespaces.add(policy.name);

    const matches: Array<{ storage: StorageManager; dir: string; namespace: string }> = [];
    for (const ns of configuredNamespaces) {
      if (!ns) continue;
      let candidateStorage: StorageManager;
      try {
        candidateStorage = await this.orchestrator.getStorage(ns);
      } catch {
        continue;
      }
      const candidateRoot = nodePath.resolve(candidateStorage.dir);
      if (!isPathInsideStorageRoot(candidateRoot, resolvedPath)) continue;
      if (candidateRoot === memoryRoot && isPathInsideStorageRoot(namespacesRoot, resolvedPath)) {
        continue;
      }
      matches.push({ storage: candidateStorage, dir: candidateRoot, namespace: ns });
    }

    matches.sort((a, b) => b.dir.length - a.dir.length);
    return matches[0] ?? null;
  }

  private async fetchRawExcerpts(
    disclosure: RecallDisclosure,
    context: {
      query: string;
      sessionKey?: string;
      namespace?: string;
      /**
       * Pre-resolved, ordered, read-authorized LCM read session_id SET (#1505
       * fallback unification). When supplied, raw disclosure queries each key in
       * order (primary coding overlay → read fallbacks) and merges rows, exactly
       * as the orchestrator recall path and `lcmSearch` do, so a branch-scoped
       * session finds excerpts archived at project/root scope. Already
       * read-gated by `resolveLcmReadSessionIds`, so an unauthorized
       * `<principal>-project-*` key is never present. Falls back to the legacy
       * single `namespace`-prefixed key when absent (sessionless / legacy
       * callers).
       */
      lcmSessionIds?: string[];
    } | null
  ): Promise<EngramAccessMemorySummary["rawExcerpts"] | null> {
    return this.accessRecallSurface.fetchRawExcerpts(disclosure, context);
  }

  private async handleIdempotentWrite<T extends { idempotencyReplay?: boolean }>(options: {
    operation: string;
    idempotencyKey?: string;
    requestFingerprint: unknown;
    skip?: boolean;
    /**
     * Invoked exactly once, immediately before an ACTUAL (non-replay, non-skip)
     * write is committed — atomically with the idempotency miss determination.
     * The HTTP surface uses this to enforce the write rate limit against the
     * real write/miss (and the real resolved namespace), so a namespace-divergent
     * idempotency peek can never let a fresh write skip the quota check (#1434
     * Codex review). It is NOT called on dryRun (skip) or replay, preserving the
     * replay-bypasses-a-full-window behavior.
     */
    beforeExecute?: () => void | Promise<void>;
    execute: () => Promise<T>;
  }): Promise<T> {
    if (options.skip === true) {
      return options.execute();
    }
    const key = options.idempotencyKey?.trim();
    if (!key) {
      if (options.beforeExecute) await options.beforeExecute();
      return options.execute();
    }
    return this.withIdempotencyLock(key, async () => {
      return this.idempotency.withKeyLock(key, async () => {
        const requestHash = hashAccessIdempotencyPayload({
          operation: options.operation,
          request: options.requestFingerprint,
        });
        const existing = await this.idempotency.get(key, requestHash);
        if (existing.conflict) {
          throw new EngramAccessInputError(`idempotencyKey reuse conflict: ${key}`);
        }
        if (existing.response) {
          return {
            ...(existing.response as T),
            idempotencyReplay: true,
          };
        }
        if (options.beforeExecute) await options.beforeExecute();
        const response = await options.execute();
        await this.idempotency.put(key, requestHash, response);
        return response;
      });
    });
  }

  private async handleIdempotentRead<T>(options: {
    operation: string;
    idempotencyKey?: string;
    requestFingerprint: unknown;
    execute: () => Promise<T>;
    afterStore?: (response: T) => Promise<void> | void;
  }): Promise<T> {
    const key = options.idempotencyKey?.trim();
    if (!key) {
      const response = await options.execute();
      await options.afterStore?.(response);
      return response;
    }
    return this.withIdempotencyLock(key, async () => {
      return this.idempotency.withKeyLock(key, async () => {
        const requestHash = hashAccessIdempotencyPayload({
          operation: options.operation,
          request: options.requestFingerprint,
        });
        const existing = await this.idempotency.get(key, requestHash);
        if (existing.conflict) {
          throw new EngramAccessInputError(`idempotencyKey reuse conflict: ${key}`);
        }
        if (existing.response) {
          return existing.response as T;
        }
        const response = await options.execute();
        await this.idempotency.put(key, requestHash, response);
        await options.afterStore?.(response);
        return response;
      });
    });
  }

  private async peekIdempotentWrite(options: {
    operation: EngramAccessWriteResponse["operation"];
    idempotencyKey?: string;
    requestFingerprint: unknown;
    skip?: boolean;
  }): Promise<EngramAccessIdempotencyStatus> {
    if (options.skip === true) {
      return "miss";
    }
    const key = options.idempotencyKey?.trim();
    if (!key) {
      return "miss";
    }
    return this.withIdempotencyLock(key, async () => {
      return this.idempotency.withKeyLock(key, async () => {
        const requestHash = hashAccessIdempotencyPayload({
          operation: options.operation,
          request: options.requestFingerprint,
        });
        const existing = await this.idempotency.get(key, requestHash);
        if (existing.conflict) {
          return "conflict";
        }
        return existing.response ? "replay" : "miss";
      });
    });
  }

  private async withIdempotencyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.idempotencyLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(
      () => current,
      () => current
    );
    this.idempotencyLocks.set(key, queued);

    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.idempotencyLocks.get(key) === queued) {
        this.idempotencyLocks.delete(key);
      }
    }
  }

  async health(namespace?: string): Promise<EngramAccessHealthResponse> {
    const resolvedNamespace = this.resolveNamespace(namespace);
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    const searchBackend = this.orchestrator.config.searchBackend ?? "qmd";
    const qmdEnabled = resolveQmdCapabilities(this.orchestrator.config).qmd === true;
    const caps = tokenCapabilityStore.getStore();
    const extractionWatermark = await readAggregateExtractionWatermark({
      config: this.orchestrator.config,
      rootStorage: this.orchestrator.storage,
      storageForNamespace: (candidate) => this.orchestrator.getStorage(candidate),
      rootsCache: this.corpusWatermarkCache,
    });
    const extraction = await computeExtractionLivenessStatus(
      this.orchestrator,
      extractionWatermark,
      caps?.namespaces !== undefined ? undefined : this.extractionLivenessWarn
    );
    let scopedDegradedReason: string | null = null;
    if (extraction.degraded) {
      if (extraction.degradedReason?.includes("watermark unreadable")) {
        scopedDegradedReason = "daemon extraction pipeline degraded; extraction watermark unreadable";
      } else if (extraction.degradedReason?.includes("buffer unreadable")) {
        scopedDegradedReason = "daemon extraction pipeline degraded; extraction buffer unreadable";
      } else {
        scopedDegradedReason =
          `${extraction.bufferedSessionCount} buffered session(s), ` +
          `${extraction.pendingTurnCount} turn(s) pending extraction`;
      }
    }
    const visibleExtraction =
      caps?.namespaces !== undefined
        ? {
            ...extraction,
            lastExtractionAt: null,
            degradedReason: scopedDegradedReason,
          }
        : extraction;
    // ONE call: the corpus array and the flag describing it must not come from
    // two independently-cached scans (round 8, codex P1).
    const corpusCensus = await computeServiceCorpusCensus(this.orchestrator, {
      cache: this.corpusWatermarkCache,
      caps,
    });
    let projectionAvailable = false;
    try {
      await stat(getMemoryProjectionPath(storage.dir));
      projectionAvailable = true;
    } catch {
      projectionAvailable = false;
    }

    return {
      ok: true,
      memoryDir: storage.dir,
      namespacesEnabled: resolveNamespaceCapabilities(this.orchestrator.config).namespaces === true,
      defaultNamespace: this.orchestrator.config.defaultNamespace,
      searchBackend,
      qmdEnabled,
      qmd: await this.qmdHealth(
        searchBackend,
        qmdEnabled,
        resolvedNamespace,
        this.qmdCollectionForHealth(resolvedNamespace, storage.dir)
      ),
      nativeKnowledgeEnabled: this.orchestrator.config.nativeKnowledge?.enabled === true,
      projectionAvailable,
      extraction: visibleExtraction,
      corpus: corpusCensus.watermarks,
      // Describes THIS response's array (round 8): a separate scan could report
      // complete while the shipped corpus was partial, and peers trust it.
      corpusComplete: corpusCensus.complete,
      replica: this.replicaDivergenceMonitor.getReport({
        config: this.orchestrator.config.replicaPeers,
        // Capability-INDEPENDENT: this poll is cached instance-wide, so a
        // restricted caller's filtered census must never seed it (round 9).
        computeLocalWatermarks: () => computeServiceCorpusCensus(this.orchestrator, {}),
        caps,
        localCensusComplete: corpusCensus.complete,
      }),
    };
  }

  private qmdCollectionForHealth(namespace: string, storageDir: string): string {
    if (resolveNamespaceCapabilities(this.orchestrator.config).namespaces !== true) {
      return this.orchestrator.config.qmdCollection;
    }

    const useLegacyDefaultCollection =
      namespace === this.orchestrator.config.defaultNamespace && storageDir === this.orchestrator.config.memoryDir;
    return namespaceCollectionName(this.orchestrator.config.qmdCollection, namespace, {
      defaultNamespace: this.orchestrator.config.defaultNamespace,
      useLegacyDefaultCollection,
    });
  }

  private async qmdHealth(
    searchBackend: string,
    qmdEnabled: boolean,
    namespace: string,
    collection: string
  ): Promise<EngramAccessQmdHealthResponse> {
    return this.accessObserveWriteSurface.qmdHealth(searchBackend, qmdEnabled, namespace, collection);
  }

  private async namespaceQmdHealth(
    searchBackend: string,
    qmdEnabled: boolean,
    namespace: string,
    fallbackCollection: string
  ): Promise<EngramAccessQmdHealthResponse | null> {
    return this.accessObserveWriteSurface.namespaceQmdHealth(searchBackend, qmdEnabled, namespace, fallbackCollection);
  }

  private async qmdCollectionState(
    searchBackend: string,
    qmdEnabled: boolean,
    collection: string
  ): Promise<EngramAccessQmdCollectionState> {
    if (searchBackend !== "qmd" || !qmdEnabled) return "skipped";
    const qmd = this.orchestrator.qmd;
    if (!qmd.isAvailable()) return "unknown";
    if (!qmd.checkCollection) return "skipped";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    timer.unref?.();
    try {
      return await qmd.checkCollection(collection, {
        signal: controller.signal,
      });
    } catch {
      return "unknown";
    } finally {
      clearTimeout(timer);
    }
  }

  private async qmdProbeAvailable(searchBackend: string, qmdEnabled: boolean): Promise<boolean> {
    if (searchBackend !== "qmd" || !qmdEnabled) return false;
    const qmd = this.orchestrator.qmd;
    if (!qmd) return false;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    timer.unref?.();
    try {
      return await new Promise<boolean>((resolve) => {
        const onAbort = () => {
          controller.signal.removeEventListener("abort", onAbort);
          resolve(false);
        };
        controller.signal.addEventListener("abort", onAbort, { once: true });
        const probe =
          typeof qmd.checkAvailability === "function"
            ? qmd.checkAvailability({ signal: controller.signal })
            : qmd.probe();
        probe
          .then(resolve, () => resolve(false))
          .finally(() => {
            controller.signal.removeEventListener("abort", onAbort);
          });
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async actionConfidence(
    request: EngramAccessActionConfidenceRequest = {}
  ): Promise<EngramAccessActionConfidenceResponse> {
    return evaluateActionConfidence(request);
  }

  async daySummary(request: EngramAccessDaySummaryRequest): Promise<import("./types.js").DaySummaryResult | null> {
    if (!resolveRecallAuxiliaryCapabilities(this.orchestrator.config).daySummary) {
      throw new EngramAccessInputError("day summary is disabled");
    }

    const memories = (request.memories ?? "").trim();
    const namespace = this.resolveRecallNamespace(request.namespace, request.sessionKey);

    if (memories.length === 0) {
      // Auto-gather today's facts from the resolved namespace
      return this.orchestrator.generateDaySummaryAuto(namespace, {
        timeZone: request.timeZone,
        includeLocation: request.includeLocation === true,
      });
    }
    return this.orchestrator.generateDaySummary(memories);
  }

  async briefing(request: EngramAccessBriefingRequest): Promise<EngramAccessBriefingResponse> {
    return this.accessObserveWriteSurface.briefing(request);
  }

  /**
   * Attach a coding context to a session (issue #569). Used by the Claude
   * Code / Codex / generic-MCP connectors at session start so that recall +
   * write paths can route to a project- / branch-scoped namespace.
   *
   * Validates the input shape and rejects malformed payloads rather than
   * silently accepting them (CLAUDE.md #51). Pass `codingContext: null` to
   * clear.
   */
  setCodingContext(request: EngramAccessSetCodingContextRequest): void {
    const sessionKey = typeof request.sessionKey === "string" ? request.sessionKey.trim() : "";
    if (!sessionKey) {
      throw new EngramAccessInputError("sessionKey is required for setCodingContext");
    }
    if (request.codingContext === null) {
      this.orchestrator.setCodingContextForSession(sessionKey, null);
      return;
    }
    const ctx = request.codingContext;
    if (!ctx || typeof ctx !== "object") {
      throw new EngramAccessInputError("codingContext must be an object or null");
    }
    if (typeof ctx.projectId !== "string" || ctx.projectId.trim().length === 0) {
      throw new EngramAccessInputError("codingContext.projectId must be a non-empty string");
    }
    // Whitespace-only rootPath must be rejected just like whitespace-only
    // projectId — otherwise a payload like `{ rootPath: "   " }` slips past
    // validation and produces a session whose rootPath is meaningless for
    // `remnic doctor` output and for downstream namespace decisions.
    if (typeof ctx.rootPath !== "string" || ctx.rootPath.trim().length === 0) {
      throw new EngramAccessInputError("codingContext.rootPath must be a non-empty string");
    }
    if (ctx.branch !== null && typeof ctx.branch !== "string") {
      throw new EngramAccessInputError("codingContext.branch must be a string or null");
    }
    if (ctx.defaultBranch !== null && typeof ctx.defaultBranch !== "string") {
      throw new EngramAccessInputError("codingContext.defaultBranch must be a string or null");
    }
    this.orchestrator.setCodingContextForSession(sessionKey, {
      projectId: ctx.projectId,
      branch: ctx.branch,
      rootPath: ctx.rootPath,
      defaultBranch: ctx.defaultBranch,
    });
  }

  /**
   * Auto-resolve and attach a coding context for a session when one is not
   * already present. Resolves from `projectTag` (highest priority after
   * explicit `codingContext`), then from `cwd` via git detection.
   *
   * This is a no-op when:
   *   - `sessionKey` is missing
   *   - the session already has a coding context attached
   *   - codingMode.projectScope is disabled (CLAUDE.md #30)
   *   - neither `cwd` nor `projectTag` is provided
   *
   * Never throws — git resolution failures are silently ignored because not
   * being in a repo is a normal runtime state.
   */
  private async maybeAttachCodingContext(
    sessionKey: string | undefined,
    options: { cwd?: string; projectTag?: string }
  ): Promise<void> {
    if (!sessionKey) return;
    // Respect the configuration gate (CLAUDE.md #30).
    if (!this.orchestrator.config.codingMode?.projectScope) return;
    // Don't overwrite an already-attached context.
    if (this.orchestrator.getCodingContextForSession(sessionKey)) return;
    // projectTag takes priority over cwd.
    if (typeof options.projectTag === "string" && options.projectTag.trim().length > 0) {
      const projectId = projectTagProjectId(options.projectTag);
      this.orchestrator.setCodingContextForSession(sessionKey, {
        projectId,
        branch: null,
        rootPath: projectId,
        defaultBranch: null,
      });
      return;
    }
    // cwd → git resolution
    if (typeof options.cwd === "string" && options.cwd.trim().length > 0) {
      try {
        const gitCtx = await resolveGitContext(options.cwd);
        if (gitCtx) {
          this.setCodingContext({
            sessionKey,
            codingContext: {
              projectId: gitCtx.projectId,
              branch: gitCtx.branch,
              rootPath: gitCtx.rootPath,
              defaultBranch: gitCtx.defaultBranch,
            },
          });
        }
      } catch {
        // Silently ignore git resolution failures — not being in a repo
        // is normal. resolveGitContext itself never throws, but the
        // setCodingContext validation might reject edge-case rootPaths.
      }
    }
  }

  /**
   * Seed the session's coding binding AFTER a committed, project-scoped explicit
   * write (memory_store / suggestion_submit), mirroring the recall path's
   * `maybeAttachCodingContext` so a later bare recall/write on the same session
   * is scoped to the same project. Called only from the post-persist path, so it
   * never fires on dryRun, replay/conflict, or quota-rejected requests. Skips
   * when an explicit `namespace` was supplied — that write bypassed the coding
   * overlay, so binding the session to a project it never wrote to would make
   * later bare recalls miss (Codex review).
   */
  private async attachCodingContextAfterScopedWrite(
    request: CodingScopedWriteInput & { namespace?: string; sessionKey?: string }
  ): Promise<void> {
    const hasExplicitNamespace = typeof request.namespace === "string" && request.namespace.trim().length > 0;
    if (hasExplicitNamespace) return;
    await this.maybeAttachCodingContext(request.sessionKey, {
      cwd: request.cwd,
      projectTag: request.projectTag,
    });
  }

  async recall(request: EngramAccessRecallRequest): Promise<EngramAccessRecallResponse> {
    const query = request.query.trim();
    if (query.length === 0) {
      throw new EngramAccessInputError("query is required");
    }
    const normalizedRequest = { ...request, query };
    const { abortSignal: _abortSignal, ...requestFingerprint } = normalizedRequest;
    const authenticatedPrincipal = request.authenticatedPrincipal?.trim();
    const principal = this.resolveRequestPrincipal(request.sessionKey, authenticatedPrincipal);
    if (resolveNamespaceCapabilities(this.orchestrator.config).namespaces && !principal) {
      throw new EngramAccessInputError("authentication required: namespaces are enabled and no principal was supplied");
    }
    const principalKey = principal ?? "default";
    // Single-flight gate resolved through the shared access-setup capability
    // projection so the config flag is read only in capabilities.ts (#1523).
    const singleFlight = resolveAccessSetupCapabilities(this.orchestrator.config).recallSingleFlight;
    return coordinateRecall(
      this as unknown as RecallCoordinatorHost,
      request,
      normalizedRequest,
      requestFingerprint,
      principalKey,
      singleFlight
    );
  }

  private async executeRecall(request: EngramAccessRecallRequest): Promise<RecallExecResult> {
    return this.accessRecallSurface.executeRecall(request);
  }

  async recallExplain(request: EngramAccessRecallExplainRequest = {}): Promise<EngramAccessRecallExplainResponse> {
    const requestedNamespace = request.namespace?.trim() ? this.resolveNamespace(request.namespace) : undefined;
    const authenticatedPrincipal = request.authenticatedPrincipal?.trim();
    const principal = authenticatedPrincipal || resolvePrincipal(request.sessionKey, this.orchestrator.config);
    if (requestedNamespace) {
      if (!canReadNamespace(principal, requestedNamespace, this.orchestrator.config)) {
        return { found: false };
      }
    } else if (resolveNamespaceCapabilities(this.orchestrator.config).namespaces && !principal) {
      return { found: false };
    }
    const snapshot = request.sessionKey
      ? (() => {
          const candidate = this.orchestrator.lastRecall.get(request.sessionKey);
          if (!candidate) return null;
          if (!requestedNamespace) return candidate;
          return candidate.namespace === requestedNamespace ? candidate : null;
        })()
      : (() => {
          const candidate = this.orchestrator.lastRecall.getMostRecent();
          if (!candidate) return null;
          if (!requestedNamespace) return candidate;
          return candidate.namespace === requestedNamespace ? candidate : null;
        })();
    const readableSnapshot = (() => {
      if (!snapshot || !resolveNamespaceCapabilities(this.orchestrator.config).namespaces) return snapshot;
      const snapshotNamespace = snapshot.namespace ?? this.orchestrator.config.defaultNamespace;
      return canReadNamespace(principal, snapshotNamespace, this.orchestrator.config) ? snapshot : null;
    })();
    const namespace = (() => {
      if (requestedNamespace) return requestedNamespace;
      if (readableSnapshot?.namespace) return readableSnapshot.namespace;
      const fallbackNamespace = this.orchestrator.config.defaultNamespace;
      if (!resolveNamespaceCapabilities(this.orchestrator.config).namespaces) return fallbackNamespace;
      return canReadNamespace(principal, fallbackNamespace, this.orchestrator.config) ? fallbackNamespace : null;
    })();
    if (!namespace) return { found: false };
    const [intent, graph] = await Promise.all([
      this.orchestrator.recallIntrospection.getLastIntentSnapshot(namespace),
      this.orchestrator.recallIntrospection.getLastGraphRecallSnapshot(namespace),
    ]);
    if (!readableSnapshot && !intent && !graph) return { found: false };
    return { found: true, snapshot: readableSnapshot ?? undefined, intent, graph };
  }

  async recallTierExplain(sessionKey?: string, namespace?: string, authenticatedPrincipal?: string) {
    const namespacesEnabled = resolveNamespaceCapabilities(this.orchestrator.config).namespaces;
    const requestedNamespace = namespace?.trim() ? this.resolveNamespace(namespace) : undefined;
    const principal = authenticatedPrincipal?.trim() || resolvePrincipal(sessionKey, this.orchestrator.config);

    if (requestedNamespace) {
      if (!canReadNamespace(principal, requestedNamespace, this.orchestrator.config)) {
        return toRecallExplainJson(null);
      }
    } else if (namespacesEnabled && !authenticatedPrincipal?.trim() && !sessionKey?.trim()) {
      return toRecallExplainJson(null);
    }

    const candidate = sessionKey
      ? this.orchestrator.lastRecall.get(sessionKey)
      : this.orchestrator.lastRecall.getMostRecent();

    const snapshot = (() => {
      if (!candidate) return null;
      if (requestedNamespace) {
        return candidate.namespace === requestedNamespace ? candidate : null;
      }
      if (!namespacesEnabled) return candidate;
      const snapshotNs = candidate.namespace ?? this.orchestrator.config.defaultNamespace;
      return canReadNamespace(principal, snapshotNs, this.orchestrator.config) ? candidate : null;
    })();

    return toRecallExplainJson(snapshot);
  }

  /**
   * Budgeted REFINE/EXPAND/STOP deep recall (issue #2332). Deep surface
   * only — never called from the recall hot path. Single implementation
   * for MCP, HTTP, and CLI (rule 22: one renderer, one service method).
   */
  async deepRecall(request: {
    query: string;
    namespace?: string;
    sessionKey?: string;
    authenticatedPrincipal?: string;
    maxSteps?: number;
  }): Promise<DeepRecallResult & { rendered: string }> {
    const cfg = this.orchestrator.config.deepRecall;
    if (!cfg.enabled) {
      return {
        ok: false,
        error: "disabled",
        entries: [],
        trace: [],
        rendered: "deep recall is disabled; set deepRecall.enabled",
      };
    }
    const query = typeof request.query === "string" ? request.query.trim() : "";
    if (query.length === 0) {
      throw new EngramAccessInputError("deepRecall: query is required");
    }
    let effective = cfg;
    const requestedSteps = request.maxSteps;
    if (requestedSteps !== undefined) {
      if (typeof requestedSteps !== "number" || !Number.isInteger(requestedSteps) || requestedSteps < 0) {
        throw new EngramAccessInputError("deepRecall: maxSteps must be a non-negative integer");
      }
      // `deepRecall.maxSteps: 0` is a documented disable value (§33): the
      // policy loop is off, so ANY positive override is a refusal rather than
      // a ceiling comparison. The zero case resolves first, so the ceiling
      // threshold below only runs while the loop is enabled.
      if (cfg.maxSteps <= 0) {
        if (requestedSteps > 0) {
          throw new EngramAccessInputError(
            "deepRecall: the policy loop is disabled (deepRecall.maxSteps=0); maxSteps must be 0"
          );
        }
      } else if (requestedSteps > cfg.maxSteps) {
        throw new EngramAccessInputError(
          `deepRecall: maxSteps ${requestedSteps} exceeds the configured ceiling ${cfg.maxSteps}`
        );
      }
      effective = { ...cfg, maxSteps: requestedSteps };
    }
    const principal =
      request.authenticatedPrincipal?.trim() || resolvePrincipal(request.sessionKey, this.orchestrator.config);
    // Read path resolves through the SAME namespace layer as memoryGet (§30):
    // one resolved namespace, one storage instance, for seeds and expansions.
    const resolvedNamespace = this.resolveReadableNamespace(request.namespace, principal);
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    const config = this.orchestrator.config;
    // `abstractionNodeStoreDir` names the DEFAULT namespace's graph store and
    // takes precedence over `storage.dir` inside the store resolver, so only a
    // default-namespace read may pass it. This is the rule the harmonic WRITE
    // path already applies (persistConstructedHarmonicRecords: the override
    // goes to the base namespace only); passing it here made every non-default
    // namespace load the DEFAULT namespace's nodes and anchors, missing its own
    // anchor expansions and exposing foreign graph metadata on an id collision.
    const graphStoreDir = resolvedNamespace === config.defaultNamespace ? config.abstractionNodeStoreDir : undefined;
    // Seeds route through the namespace search router (never the base
    // `config.qmdCollection`, which is the DEFAULT namespace's collection):
    // a non-default caller must search its own suffixed collection or deep
    // recall silently misses its corpus and returns foreign doc ids. Hit ->
    // memory-id resolution is per hit through the shared QMD result resolver
    // (which also decodes the raw collection-qualified path forms the
    // namespaces-disabled fanout returns), so no invocation pre-scans the
    // namespace corpus.
    const result = await runBudgetedDeepRecall(
      {
        config: effective,
        searchSeed: createDeepRecallSeedSearch({
          namespace: resolvedNamespace,
          storage,
          router: this.orchestrator,
          resolver: this.orchestrator.qmdResultResolver,
        }),
        // Nodes and anchors are projected against the namespace's CURRENT
        // active memories through the SAME helper searchHarmonicRetrieval
        // uses. A raw read still carries the stored title, summary, and
        // anchor value of a memory that was later rejected or quarantined,
        // and the deep-recall state prompt hands those to the policy LLM long
        // before `loadMemory(...).active` can exclude the memory itself.
        loadGraph: async () =>
          readProjectedHarmonicGraph({
            memoryDir: storage.dir,
            abstractionNodeStoreDir: graphStoreDir,
            anchorsEnabled: true,
          }),
        loadMemory: async (memoryId) => {
          const memory = await storage.getMemoryById(memoryId);
          // Same private-record exclusion memoryGet applies (#2332): a
          // support-passport private record is reported as absent (null),
          // never as content — deep recall must not become the read surface
          // that answers what every other surface denies.
          if (!memory || isSupportPassportPrivateMemory(memory)) return null;
          return {
            memoryId,
            content: memory.frontmatter.structuredAttributes ? stripAttributesSuffix(memory.content) : memory.content,
            // Enumerate the active set — never an exclusion list (§41).
            active: inferMemoryStatus(memory.frontmatter, toMemoryPathRel(storage.dir, memory.path)) === "active",
          };
        },
        callPolicy: (statePrompt, timeoutMs) =>
          callDeepRecallPolicyLlm({
            statePrompt,
            config,
            localLlm: this.orchestrator.localLlm ?? null,
            fallbackLlm: this.orchestrator.fastGatewayLlm ?? null,
            timeoutMs,
          }),
      },
      query
    );
    return { ...result, rendered: renderDeepRecallResult(result) };
  }

  async recallXray(request: {
    query: string;
    sessionKey?: string;
    namespace?: string;
    budget?: number;
    authenticatedPrincipal?: string;
    sourceConnector?: string;
    /**
     * Disclosure depth used to shape per-result payload (issue #677
     * PR 3/4).  When set, each X-ray result is decorated with the
     * matching `disclosure` field and `estimatedTokens` computed from
     * the actual rendered content at that depth, so the renderer's
     * "Token spend by disclosure" summary reflects real spend rather
     * than staying empty when no caller wires the depth knob through.
     */
    disclosure?: RecallDisclosure;
    /**
     * Free-form recall tag filter (issue #689). Mirrors the field on
     * `EngramAccessRecallRequest`. When non-empty, the captured X-ray
     * snapshot's `results` are filtered down to memories whose
     * frontmatter tags satisfy `tagMatch` ("any" by default), and a
     * `tag-filter` entry is appended to `filters`.
     */
    tags?: string[];
    /** Match mode for `tags`. See `EngramAccessRecallRequest.tagMatch`. */
    tagMatch?: "any" | "all";
    /** Recall planner mode override. Mirrors `EngramAccessRecallRequest.mode`. */
    mode?: RecallPlanMode | "auto";
    /**
     * User-aware context scopes active for this recall. Forwarded into
     * provenance construction so boundary scopes are evaluated against
     * the caller's real context instead of an empty-context default.
     */
    currentContextScopes?: readonly unknown[];
    /**
     * Internal inspector affordance: include a recall-shaped response
     * derived from the same X-ray snapshot. Left off by default so the
     * regular X-ray API/CLI/MCP surfaces keep their existing payload shape.
     */
    includeRecall?: boolean;
    /** Cancel the capture before it starts and propagate cancellation to recall. */
    abortSignal?: AbortSignal;
  }): Promise<{
    snapshotFound: boolean;
    snapshot?: RecallXraySnapshot;
    recall?: EngramAccessRecallResponse;
  }> {
    return this.accessRecallSurface.recallXray(request);
  }

  /**
   * Rank entities by demonstrated expertise for a topic (issue #2057).
   * Deterministic — no LLM, no QMD. Reads the namespace-scoped corpus and
   * entity files only; namespace resolution + ACL mirror recall semantics
   * (`resolveReadableNamespace`), so a principal cannot rank outside a
   * namespace it cannot read.
   */
  async whoKnows(request: {
    topic: string;
    limit?: number;
    namespace?: string;
    authenticatedPrincipal?: string;
  }): Promise<WhoKnowsResult> {
    const topic = request.topic?.trim() ?? "";
    const limit = request.limit ?? WHO_KNOWS_DEFAULT_LIMIT;
    validateWhoKnowsInput(topic, limit);
    const resolvedNamespace = this.resolveReadableNamespace(request.namespace, request.authenticatedPrincipal);
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    const [memories, entities] = await Promise.all([
      storage.readAllMemories(),
      loadWhoKnowsEntities(storage, this.orchestrator.config.entitySchemas),
    ]);
    return computeWhoKnows({ topic, limit, memories, entities });
  }
  /**
   * Read-only promotion-candidate surfacing (issue #2372): agent-subject,
   * active, reuse-signaled memories in the caller's namespace with no
   * equivalent in the target layer. No auto-promotion — callers use the
   * existing promotion commands.
   */
  async promotionCandidates(request: {
    namespace?: string;
    targetNamespace?: string;
    limit?: number;
    authenticatedPrincipal?: string;
  }): Promise<PromotionCandidatesResult> {
    const limit = request.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new EngramAccessInputError(
        `promotion_candidates: limit expects an integer in [1, 100] (got ${String(request.limit)})`
      );
    }
    const resolvedNamespace = this.resolveReadableNamespace(request.namespace, request.authenticatedPrincipal);
    const resolvedTarget = this.resolveReadableNamespace(
      request.targetNamespace ?? this.orchestrator.config.sharedNamespace,
      request.authenticatedPrincipal
    );
    const minAccessCount = this.orchestrator.config.promotionCandidates.minAccessCount;
    const [memories, targetMemories] = await Promise.all([
      (await this.orchestrator.getStorage(resolvedNamespace)).readAllMemories(),
      (await this.orchestrator.getStorage(resolvedTarget)).readAllMemories(),
    ]);
    return {
      namespace: resolvedNamespace,
      targetNamespace: resolvedTarget,
      minAccessCount,
      candidates: computePromotionCandidates({ memories, targetMemories, minAccessCount, limit }),
    };
  }
  async memoryStore(
    request: EngramAccessMemoryStoreRequest,
    hooks?: { enforceWriteQuota?: () => void | Promise<void> }
  ): Promise<EngramAccessWriteResponse> {
    return this.accessObserveWriteSurface.memoryStore(request, hooks);
  }

  async peekMemoryStoreIdempotency(
    rawRequest: EngramAccessMemoryStoreRequest
  ): Promise<EngramAccessIdempotencyStatus> {
    // #2780/#2829: fingerprint the canonical category (schema transform already mapped aliases).
    const { canonical: request } = splitCanonicalWriteRequest(rawRequest);
    const namespace = await this.resolveCodingScopedWriteNamespace(request);
    const schemaVersion = request.schemaVersion ?? ENGRAM_ACCESS_WRITE_SCHEMA_VERSION;
    if (schemaVersion !== ENGRAM_ACCESS_WRITE_SCHEMA_VERSION) {
      throw new EngramAccessInputError(`unsupported schemaVersion: ${schemaVersion}`);
    }
    return this.peekIdempotentWrite({
      operation: "memory_store",
      idempotencyKey: request.idempotencyKey,
      // Shared builder (issue #1989 PR3): byte-parity with the historical
      // inline literal is asserted by access-fingerprint-parity.test.ts.
      requestFingerprint: buildAccessWriteRequestFingerprint({
        schemaVersion,
        namespace,
        content: request.content,
        category: request.category,
        confidence: request.confidence,
        tags: request.tags,
        entityRef: request.entityRef,
        ttl: request.ttl,
        sourceReason: request.sourceReason,
        sourceConnector: request.sourceConnector,
      }),
      skip: request.dryRun === true,
    });
  }

  async suggestionSubmit(
    request: EngramAccessSuggestionSubmitRequest,
    hooks?: { enforceWriteQuota?: () => void | Promise<void> }
  ): Promise<EngramAccessWriteResponse> {
    return this.accessObserveWriteSurface.suggestionSubmit(request, hooks);
  }

  async peekSuggestionSubmitIdempotency(
    rawRequest: EngramAccessSuggestionSubmitRequest
  ): Promise<EngramAccessIdempotencyStatus> {
    // #2780/#2829: fingerprint the canonical category (schema transform already mapped aliases).
    const { canonical: request } = splitCanonicalWriteRequest(rawRequest);
    const namespace = await this.resolveCodingScopedWriteNamespace(request);
    const schemaVersion = request.schemaVersion ?? ENGRAM_ACCESS_WRITE_SCHEMA_VERSION;
    if (schemaVersion !== ENGRAM_ACCESS_WRITE_SCHEMA_VERSION) {
      throw new EngramAccessInputError(`unsupported schemaVersion: ${schemaVersion}`);
    }
    return this.peekIdempotentWrite({
      operation: "suggestion_submit",
      idempotencyKey: request.idempotencyKey,
      // Shared builder (issue #1989 PR3): byte-parity with the historical
      // inline literal is asserted by access-fingerprint-parity.test.ts.
      requestFingerprint: buildAccessWriteRequestFingerprint({
        schemaVersion,
        namespace,
        content: request.content,
        category: request.category,
        confidence: request.confidence,
        tags: request.tags,
        entityRef: request.entityRef,
        ttl: request.ttl,
        sourceReason: request.sourceReason,
        sourceConnector: request.sourceConnector,
      }),
      skip: request.dryRun === true,
    });
  }

  private validateWriteCandidate(
    request: EngramAccessMemoryStoreRequest | EngramAccessSuggestionSubmitRequest,
    namespace: string
  ): ValidExplicitCapture {
    try {
      return {
        ...validateExplicitCaptureInput(
          {
            ...request,
            namespace,
          },
          "legacy_tool"
        ),
        // The namespace was resolved AND authorized by
        // resolveCodingScopedWriteNamespace (explicit namespaces via
        // resolveWritableNamespace; otherwise an auth-checked base + a
        // session-owned project overlay), so the persist/queue layer must not
        // re-reject a legitimately-derived dynamic project namespace (#1434).
        namespacePreResolved: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new EngramAccessInputError(message);
    }
  }

  async memoryGet(
    memoryId: string,
    namespace?: string,
    principal?: string,
    sessionKey?: string
  ): Promise<EngramAccessMemoryResponse> {
    // Issue #1582 — accept a `[m:xxxx]` handle in place of a memory id; resolve
    // it against the caller's session via the shared helper (rule 22). A raw id
    // passes through unchanged, so callers unaware of handles are unaffected.
    const resolvedId = this.resolveMemoryIdOrHandleInput(memoryId, sessionKey);
    const resolvedNamespace = this.resolveReadableNamespace(namespace, principal);
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    const memory = await storage.getMemoryById(resolvedId);
    if (!memory || isSupportPassportPrivateMemory(memory)) return { found: false, namespace: resolvedNamespace };
    return {
      found: true,
      namespace: resolvedNamespace,
      memory: this.serializeMemory(memory),
    };
  }

  /**
   * Codegraph parity tool delegate (issue #1554). All three surfaces (MCP,
   * HTTP, CLI) arrive here via the codegraph_* boundary operations. The
   * handler lives in coding/codegraph-surfaces.ts; this method just wires
   * the context. Memory dir + principal + coding-context lookup come from
   * the orchestrator/access-service fabric -- no handler-side state.
   */
  async codegraphTool(
    request: CodegraphSurfaceRequest,
    authenticatedPrincipal?: string,
    sourceConnector?: string
  ): Promise<CodegraphSurfaceResponse> {
    const principal = authenticatedPrincipal ?? "default";
    const memoryDir = this.orchestrator.config.memoryDir;
    const ctx: CodegraphSurfaceContext = {
      config: this.orchestrator.config,
      memoryDir,
      principal,
      getCodingContext: (sk) => this.orchestrator.getCodingContextForSession(sk),
      // Project resolution chokepoint lives in codegraph-runtime.ts so every
      // store-backed tool derives the same id and the tagged error flows back
      // as a structured response (issue #1554 threads 7/9/11). Thin wiring.
      resolveStore: async (req) => {
        const projectId = resolveCodegraphProjectId({
          request: req,
          getCodingContext: (sk) => this.orchestrator.getCodingContextForSession(sk),
        });
        return getCodegraphStore({
          config: this.orchestrator.config,
          memoryDir,
          principal,
          projectId,
          repoRoot: req.repoRoot,
        }) as Promise<CodegraphStore>;
      },
      listDirs: (dir) => {
        try {
          return readdirSync(dir) as readonly string[];
        } catch {
          return [];
        }
      },
      removeFile: (filePath) => unlinkSync(filePath), // propagate failures → deleteCodegraphProject classifies (thread 7)
      throwInputError: (msg) => {
        throw new EngramAccessInputError(msg);
      },
      delegateDecisionRecord: async (decisionRequest) => {
        return this.codingDecision(decisionRequest, authenticatedPrincipal, sourceConnector);
      },
      buildArchitectureCard: async (repoRoot) => {
        return buildArchitectureCard(repoRoot, {
          llmSummary: this.orchestrator.config.codingKnowledge?.architectureCardLlmSummary === true,
          summariser: createArchitectureCardSummariser(this.fallbackLlmRef ?? this.localLlmRef),
        });
      },
      ...makeCodegraphRuntimeDelegates(),
    };
    return handleCodegraphTool(request, ctx);
  }

  /** Whether the coding_decision tool should appear in tools/list (rule 39). */
  get decisionRecordSurfaceVisible(): boolean {
    return (
      this.orchestrator.config.codingKnowledge?.enabled === true &&
      this.orchestrator.config.codingKnowledge?.decisionRecords === true
    );
  }
  /**
   * Thin delegate — handler logic in coding/decision-surfaces.ts (#1548 PR2).
   * All three surfaces (MCP/HTTP/CLI) arrive here via the boundary operation.
   * Namespace resolution uses the SAME path as memory_store (principal ACL +
   * coding overlay + default fallback) so decision records land in the same
   * storage root.
   */
  async codingDecision(
    request: DecisionSurfaceRequest,
    authenticatedPrincipal?: string,
    sourceConnector?: string
  ): Promise<DecisionSurfaceResponse> {
    return handleCodingDecision(request, {
      codingKnowledge: this.orchestrator.config.codingKnowledge,
      getCodingContext: (sk) => this.orchestrator.getCodingContextForSession(sk),
      resolveStorage: async (req) => {
        const isWrite = req.subcommand === "record" || req.subcommand === "supersede";
        const ns = isWrite
          ? await this.resolveCodingScopedWriteNamespace({
              namespace: req.namespace,
              sessionKey: req.sessionKey,
              authenticatedPrincipal,
            })
          : await this.resolveCodingScopedReadableNamespace({
              namespace: req.namespace,
              sessionKey: req.sessionKey,
              authenticatedPrincipal,
            });
        const storage = await this.orchestrator.getStorage(ns);
        return Object.assign(storage, { namespace: ns });
      },
      throwInputError: (msg) => {
        throw new EngramAccessInputError(msg);
      },
      sourceConnector,
    });
  }

  /** Whether the coding_architecture tool should appear in tools/list (rule 39). */
  get architectureCardSurfaceVisible(): boolean {
    return (
      this.orchestrator.config.codingKnowledge?.enabled === true &&
      this.orchestrator.config.codingKnowledge?.architectureCard === true
    );
  }

  /**
   * Whether the 14 codegraph parity tools should appear in tools/list
   * (rule 39). Config-only -- runtime availability is checked at call time.
   * When false the tools array is byte-identical to pre-feature.
   */
  get codegraphSurfaceVisible(): boolean {
    return codegraphSurfaceVisible(this.orchestrator.config);
  }
  /**
   * Thin delegate — handler logic in coding/architecture-surfaces.ts (#1548 PR3).
   * All three surfaces (MCP/HTTP/CLI) arrive here via the boundary operation.
   * Namespace resolution uses the SAME coding-scoped path as decision records.
   */
  async codingArchitecture(
    request: ArchitectureSurfaceRequest,
    authenticatedPrincipal?: string,
    sourceConnector?: string
  ): Promise<ArchitectureSurfaceResponse> {
    const resolvedConfig = this.orchestrator.config;
    return handleCodingArchitecture(request, {
      codingKnowledge: this.orchestrator.config.codingKnowledge,
      getCodingContext: (sk) => this.orchestrator.getCodingContextForSession(sk),
      resolveStorage: async (req) => {
        const isWrite = req.subcommand === "refresh";
        const ns = isWrite
          ? await this.resolveCodingScopedWriteNamespace({
              namespace: req.namespace,
              sessionKey: req.sessionKey,
              authenticatedPrincipal,
            })
          : await this.resolveCodingScopedReadableNamespace({
              namespace: req.namespace,
              sessionKey: req.sessionKey,
              authenticatedPrincipal,
            });
        const storage = await this.orchestrator.getStorage(ns);
        return Object.assign(storage, { namespace: ns }) as ArchitectureSurfaceStorage;
      },
      buildCard: async (repoRoot) =>
        buildArchitectureCard(repoRoot, {
          llmSummary: this.orchestrator.config.codingKnowledge?.architectureCardLlmSummary === true,
          summariser: createArchitectureCardSummariser(this.fallbackLlmRef ?? this.localLlmRef),
        }),
      versioning: createArchitectureVersioningHook(
        resolvedConfig.versioningEnabled === true,
        resolvedConfig.versioningMaxPerPage,
        resolvedConfig.versioningSidecarDir,
        resolvedConfig.memoryDir,
        (p) => nodeFs.readFile(p, "utf-8"),
        createVersion
      ),
      throwInputError: (msg) => {
        throw new EngramAccessInputError(msg);
      },
      sourceConnector,
    });
  }

  /** Whether the coding_delta tool should appear in tools/list (rule 39). */
  get sessionDeltaSurfaceVisible(): boolean {
    return (
      this.orchestrator.config.codingKnowledge?.enabled === true &&
      this.orchestrator.config.codingKnowledge?.sessionDelta === true
    );
  }
  /**
   * Thin delegate — handler logic in coding/session-delta-surfaces.ts (#1548 PR4).
   * All three surfaces (MCP/HTTP/CLI) arrive here via the boundary operation.
   * Namespace resolution uses the SAME coding-scoped read path as the other
   * coding surfaces; the delta state file lives under
   * `<memoryDir>/state/coding-knowledge/<namespace>.json`.
   */
  async codingDelta(request: DeltaSurfaceRequest, authenticatedPrincipal?: string): Promise<DeltaSurfaceResponse> {
    return handleCodingDelta(request, {
      codingKnowledge: this.orchestrator.config.codingKnowledge,
      getCodingContext: (sk) => this.orchestrator.getCodingContextForSession(sk),
      resolveStorage: async (req) => {
        const ns = await this.resolveCodingScopedReadableNamespace({
          namespace: req.namespace,
          sessionKey: req.sessionKey,
          authenticatedPrincipal,
        });
        const storage = await this.orchestrator.getStorage(ns);
        // Delta only needs memoryDir + namespace (no readAllMemories). Use the
        // namespace-ROUTED root (storage.dir), not the global config.memoryDir:
        // non-default namespaces route to memoryDir/namespaces/<token>, so
        // session-delta markers must read/write from the routed tree, mirroring
        // the decision/architecture siblings (cursor review).
        // Issue #1630 fix 2: gate the marker write on the WRITE-path resolver
        // — it mirrors memory_store's exact authorization (base ACL for coding
        // overlays, selectedLayer.writable for scope-profiles), not the raw
        // canWriteNamespace which misses overlay/profile grants (cursor+codex
        // review). A throw = read-only caller; delta computed but no advance.
        let canAdvanceState = false;
        try {
          await this.resolveCodingScopedWriteNamespace({
            namespace: req.namespace,
            sessionKey: req.sessionKey,
            authenticatedPrincipal,
          });
          canAdvanceState = true;
        } catch {
          canAdvanceState = false;
        }
        return {
          memoryDir: storage.dir,
          namespace: ns,
          canAdvanceState,
        } satisfies DeltaSurfaceStorage;
      },
      gitInvoker: (cwd, args) => {
        // Session-delta remains a synchronous pure calculation; use the
        // bounded synchronous invoker rather than the abortable scope resolver.
        return defaultGitInvokerSync()(cwd, args);
      },
      throwInputError: (msg) => {
        throw new EngramAccessInputError(msg);
      },
    });
  }

  // -------------------------------------------------------------------------
  // Correction Contract (issue #1580) — one plan/apply pipeline for every
  // memory correction. The CorrectionService owns the planner + executor; the
  // access-service constructs it lazily via the wiring helper and delegates.
  // Each method below is thin wiring (≤4 lines) per the god-file ratchet.
  // -------------------------------------------------------------------------
  /** Whether the memory_correct_plan / memory_correct_apply tools should appear in tools/list (rule 39). Same reader as the runtime gate so visibility + enforcement stay in sync. */
  get correctionSurfaceVisible(): boolean {
    return isCorrectionFeatureEnabled(this.orchestrator.config);
  }

  private _correctionService: CorrectionService | null = null;

  /** Lazily construct + cache the CorrectionService with deps wired from the orchestrator. */
  private correctionService(): CorrectionService {
    if (this._correctionService) return this._correctionService;
    const service = createCorrectionService({
      orchestrator: this.orchestrator,
      resolveAuthorizedNamespace: async (req) =>
        this.writableNamespaceFor(req.namespace, req.sessionKey, req.principal),
      resolveReadableNamespaces: (req) => {
        const principal = this.resolveRequestPrincipal(req.sessionKey, req.principal);
        return recallNamespacesForPrincipal(principal, this.orchestrator.config);
      },
      canWriteNamespace: (req) => {
        // resolveWritableNamespace resolves + checks writability in one step;
        // reusing it avoids a second ad-hoc namespace-resolution call site.
        try {
          this.writableNamespaceFor(req.namespace, req.sessionKey, req.principal);
          return Promise.resolve(true);
        } catch {
          return Promise.resolve(false);
        }
      },
      // Wire the orchestrator's extraction LLM so classify+draft actually
      // drafts actions instead of always hitting the deterministic fallback
      // (review thread PG5). The planner's classifyAndDraft already falls back
      // on any LLM outage, so returning null (LLM disabled/cooldown) or a
      // thrown error both degrade safely to the deterministic path (rule 13).
      llmComplete: async ({ system, user }) => {
        const result = await this.orchestrator.localLlm.chatCompletion(
          [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          { operation: "correction-classify", priority: "background" }
        );
        if (!result) {
          throw new Error("correction classify+draft: local LLM unavailable (disabled or in cooldown)");
        }
        return result.content;
      },
    });
    this._correctionService = service;
    return service;
  }

  /**
   * Issue #1582 — resolve a single memoryId-or-handle reference to a concrete
   * memory id. Handles resolve against the session's recall history via the
   * orchestrator's shared helper (rule 22); raw ids pass through unchanged. A
   * handle that misses or is ambiguous becomes an EngramAccessInputError so the
   * boundary maps it to a 400 (rule 34/51 — list candidates, never guess).
   */
  private resolveMemoryIdOrHandleInput(ref: string, sessionKey: string | undefined): string {
    if (!isHandleToken(ref)) return ref;
    try {
      return this.orchestrator.resolveMemoryIdOrHandle(ref, sessionKey);
    } catch (err) {
      throw new EngramAccessInputError(err instanceof Error ? err.message : String(err));
    }
  }

  async correctionPlan(request: CorrectionRequest, opts?: { abortSignal?: AbortSignal }): Promise<CorrectionPlan> {
    if (request.targetIds?.some((id) => isHandleToken(id))) {
      const targetIds = request.targetIds.map((id) => this.resolveMemoryIdOrHandleInput(id, request.sessionKey));
      return this.correctionService().plan({ ...request, targetIds }, opts);
    }
    return this.correctionService().plan(request, opts);
  }

  async correctionApply(
    planId: string,
    opts: {
      confirm?: boolean;
      namespace?: string;
      sessionKey?: string;
      principal?: string;
      abortSignal?: AbortSignal;
    }
  ): Promise<CorrectionOutcome> {
    return this.correctionService().apply(planId, opts);
  }

  async correctionListPending(opts: {
    namespace?: string;
    sessionKey?: string;
    principal?: string;
  }): Promise<CorrectionPlan[]> {
    return this.correctionService().listPending(opts);
  }

  async correctionDiscard(
    planId: string,
    opts: { namespace?: string; sessionKey?: string; principal?: string }
  ): Promise<void> {
    return this.correctionService().discard(planId, opts);
  }

  async memoryBrowse(request: EngramAccessMemoryBrowseRequest = {}): Promise<EngramAccessMemoryBrowseResponse> {
    const resolvedNamespace = this.resolveReadableNamespace(request.namespace, request.authenticatedPrincipal);
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    const { limit, offset } = normalizePagination(request.limit, request.offset);
    const sort = normalizeBrowseSort(request.sort);
    const query = request.query?.trim().toLowerCase() ?? "";
    const statusFilter = request.status?.trim().toLowerCase();
    const categoryFilter = request.category?.trim().toLowerCase();

    const projected = await storage.browseProjectedMemories({
      query,
      status: statusFilter,
      category: categoryFilter,
      excludePrivateRecords: true,
      sort,
      limit,
      offset,
    });
    if (projected) {
      return {
        namespace: resolvedNamespace,
        sort,
        total: projected.total,
        count: projected.memories.length,
        limit,
        offset,
        memories: projected.memories.map((row) => ({ ...row })),
      };
    }

    let memories = [...(await storage.readAllMemories()), ...(await storage.readArchivedMemories())];
    memories = memories.filter((memory) => {
      if (isSupportPassportPrivateMemory(memory)) return false;
      const status = inferMemoryStatus(memory.frontmatter, toMemoryPathRel(storage.dir, memory.path)).toLowerCase();
      if (statusFilter && status !== statusFilter) return false;
      if (categoryFilter && memory.frontmatter.category.toLowerCase() !== categoryFilter) return false;
      if (!query) return true;
      const haystack = [
        memory.frontmatter.id,
        memory.path,
        memory.content,
        memory.frontmatter.entityRef ?? "",
        ...memory.frontmatter.tags,
      ]
        .join("\n")
        .toLowerCase();
      return haystack.includes(query);
    });

    memories.sort((left, right) => compareBrowseMemory(sort, left, right));

    const page = memories
      .slice(offset, offset + limit)
      .map((memory) => this.serializeMemorySummary(memory, storage.dir));
    return {
      namespace: resolvedNamespace,
      sort,
      total: memories.length,
      count: page.length,
      limit,
      offset,
      memories: page,
    };
  }

  async memoryTimeline(
    memoryId: string,
    namespace?: string,
    limit = 200,
    principal?: string
  ): Promise<EngramAccessTimelineResponse> {
    const resolvedNamespace = this.resolveReadableNamespace(namespace, principal);
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    const memory = await storage.getMemoryByIdIncludingArchived(memoryId);
    if (!memory || isSupportPassportPrivateMemory(memory))
      return { found: false, namespace: resolvedNamespace, count: 0, timeline: [] };
    const timeline = await storage.getMemoryTimeline(memoryId, limit);
    return {
      found: timeline.length > 0,
      namespace: resolvedNamespace,
      count: timeline.length,
      timeline,
    };
  }

  async entityList(
    options: {
      namespace?: string;
      query?: string;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<EngramAccessEntityListResponse> {
    const storage = await this.orchestrator.getStorage(options.namespace);
    const resolvedNamespace = options.namespace?.trim() || this.orchestrator.config.defaultNamespace;
    const { limit, offset } = normalizePagination(options.limit, options.offset);
    const query = options.query?.trim().toLowerCase() ?? "";

    const names = await storage.listEntityNames();
    const entities: EngramAccessEntitySummary[] = [];
    for (const name of names) {
      const raw = await storage.readEntity(name);
      if (!raw) continue;
      const entity = parseEntityFile(raw, this.orchestrator.config.entitySchemas);
      if (query) {
        const haystack = [
          entity.name,
          entity.type,
          entity.synthesis || entity.summary || "",
          ...entity.aliases,
          ...entity.facts,
          ...(entity.structuredSections ?? []).flatMap((section) => [section.title, ...section.facts]),
        ]
          .join("\n")
          .toLowerCase();
        if (!haystack.includes(query)) continue;
      }
      entities.push({
        name: entity.name,
        type: entity.type,
        updated: entity.updated,
        summary: entity.synthesis || entity.summary,
        aliases: entity.aliases,
      });
    }

    entities.sort((left, right) => left.name.localeCompare(right.name));
    const page = entities.slice(offset, offset + limit);
    return {
      namespace: resolvedNamespace,
      total: entities.length,
      count: page.length,
      limit,
      offset,
      entities: page,
    };
  }

  async entityGet(name: string, namespace?: string): Promise<EngramAccessEntityResponse> {
    const storage = await this.orchestrator.getStorage(namespace);
    const resolvedNamespace = namespace?.trim() || this.orchestrator.config.defaultNamespace;
    const raw = await storage.readEntity(name);
    if (!raw) return { found: false, namespace: resolvedNamespace };
    return {
      found: true,
      namespace: resolvedNamespace,
      entity: parseEntityFile(raw, this.orchestrator.config.entitySchemas),
    };
  }

  async reviewQueue(runId?: string, namespace?: string, principal?: string): Promise<EngramAccessReviewQueueResponse> {
    return this.accessAdminOpsSurface.reviewQueue(runId, namespace, principal);
  }

  async maintenance(namespace?: string, principal?: string): Promise<EngramAccessMaintenanceResponse> {
    const resolvedNamespace = this.resolveReadableNamespace(namespace, principal);
    return {
      namespace: resolvedNamespace,
      health: await this.health(resolvedNamespace),
      latestGovernanceRun: await this.reviewQueue(undefined, resolvedNamespace, principal),
    };
  }

  async quality(namespace?: string, principal?: string): Promise<EngramAccessQualityResponse> {
    const resolvedNamespace = this.resolveReadableNamespace(namespace, principal);
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    const governance = await this.reviewQueue(undefined, resolvedNamespace, principal);
    const nowMs = Date.now();
    const statusCounts: Record<string, number> = {};
    const categoryCounts: Record<string, number> = {};
    const confidenceTierCounts: Record<string, number> = {};
    const ageBucketCounts: Record<string, number> = {};
    let staleActive = 0;
    let lowConfidenceActive = 0;

    const memories = [...(await storage.readAllMemories()), ...(await storage.readArchivedMemories())];
    for (const memory of memories) {
      const status = inferMemoryStatus(memory.frontmatter, toMemoryPathRel(storage.dir, memory.path)).toLowerCase();
      const confidenceTier = memory.frontmatter.confidenceTier ?? "unknown";
      const ageBucket = bucketMemoryAge(memory.frontmatter.updated ?? memory.frontmatter.created, nowMs);

      incrementCount(statusCounts, status);
      incrementCount(categoryCounts, memory.frontmatter.category);
      incrementCount(confidenceTierCounts, confidenceTier);
      incrementCount(ageBucketCounts, ageBucket);

      if (status === "active") {
        if (ageBucket === "91_plus_days") staleActive += 1;
        if ((memory.frontmatter.confidence ?? 0) < 0.6) lowConfidenceActive += 1;
      }
    }

    return {
      namespace: resolvedNamespace,
      totalMemories: memories.length,
      statusCounts,
      categoryCounts,
      confidenceTierCounts,
      ageBucketCounts,
      archivePressure: {
        pendingReview: statusCounts.pending_review ?? 0,
        quarantined: statusCounts.quarantined ?? 0,
        archived: statusCounts.archived ?? 0,
        staleActive,
        lowConfidenceActive,
      },
      latestGovernanceRun: {
        found: governance.found,
        runId: governance.runId,
        qualityScore: governance.qualityScore ?? governance.metrics?.qualityScore,
        reviewQueueCount: governance.reviewQueue?.length ?? 0,
      },
    };
  }

  async governanceRun(
    request: {
      namespace?: string;
      mode?: "shadow" | "apply";
      recentDays?: number;
      maxMemories?: number;
      batchSize?: number;
      authenticatedPrincipal?: string;
    },
    principal?: string
  ): Promise<{
    namespace: string;
    runId: string;
    traceId: string;
    mode: "shadow" | "apply";
    reviewQueueCount: number;
    proposedActionCount: number;
    appliedActionCount: number;
    summaryPath: string;
    reportPath: string;
  }> {
    return this.accessAdminOpsSurface.governanceRun(request, principal);
  }

  async entitySynthesisRun(
    request: {
      namespace?: string;
      maxEntities?: number;
      authenticatedPrincipal?: string;
    },
    principal?: string
  ): Promise<{
    namespace: string;
    requested: number;
    processed: number;
    remaining: number;
  }> {
    return this.accessAdminOpsSurface.entitySynthesisRun(request, principal);
  }

  async procedureMiningRun(
    request: {
      namespace?: string;
      authenticatedPrincipal?: string;
    },
    principal?: string
  ): Promise<{
    namespace: string;
    clustersProcessed: number;
    proceduresWritten: number;
    skippedReason?: string;
  }> {
    const resolvedNamespace = this.writableNamespaceFor(
      request.namespace,
      undefined,
      request.authenticatedPrincipal ?? principal
    );
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    const result = await runProcedureMining({
      memoryDir: storage.dir,
      storage,
      config: this.orchestrator.config,
    });
    return {
      namespace: resolvedNamespace,
      clustersProcessed: result.clustersProcessed,
      proceduresWritten: result.proceduresWritten,
      skippedReason: result.skippedReason,
    };
  }

  async liveConnectorsRun(
    request: {
      authenticatedPrincipal?: string;
      force?: boolean;
    } = {},
    principal?: string
  ): Promise<LiveConnectorsRunSummary> {
    this.writableNamespaceFor(undefined, undefined, request.authenticatedPrincipal ?? principal);
    return this.orchestrator.runLiveConnectors({
      force: request.force === true,
    });
  }

  /**
   * Run the pattern-reinforcement maintenance job (issue #687 PR 2/4).
   *
   * Cluster duplicate non-procedural memories and reinforce the
   * canonical (most-recent) member.  Gated on
   * `patternReinforcementEnabled` — when disabled, returns
   * `{ ran: false, skippedReason: "disabled" }` so the cron payload
   * surface in CI logs cleanly.
   *
   * Resolves the namespace via the same writable path used by
   * `procedureMiningRun` so cross-tenant writes are impossible
   * (CLAUDE.md rule 42).
   *
   * Delegates the run to `orchestrator.runPatternReinforcement` so
   * the cadence floor (`patternReinforcementCadenceMs`) is enforced
   * uniformly across cron + MCP paths (PR #730 review feedback,
   * Codex P2).  Accepts `force: true` for ad-hoc operator runs that
   * must bypass the cadence floor — mirrors the pattern used by
   * other maintenance MCP tools.
   */
  async patternReinforcementRun(
    request: {
      namespace?: string;
      authenticatedPrincipal?: string;
      force?: boolean;
    } = {},
    principal?: string
  ): Promise<{
    namespace: string;
    ran: boolean;
    skippedReason?: "disabled" | "cadence";
    clustersFound: number;
    canonicalsUpdated: number;
    duplicatesSuperseded: number;
    result?: PatternReinforcementResult;
  }> {
    const resolvedNamespace = this.writableNamespaceFor(
      request.namespace,
      undefined,
      request.authenticatedPrincipal ?? principal
    );
    const outcome = await this.orchestrator.runPatternReinforcement({
      namespace: resolvedNamespace,
      force: request.force === true,
    });
    if (!outcome.ran) {
      return {
        namespace: resolvedNamespace,
        ran: false,
        skippedReason: outcome.skippedReason,
        clustersFound: 0,
        canonicalsUpdated: 0,
        duplicatesSuperseded: 0,
      };
    }
    const result = outcome.result!;
    return {
      namespace: resolvedNamespace,
      ran: true,
      clustersFound: result.clustersFound,
      canonicalsUpdated: result.canonicalsUpdated,
      duplicatesSuperseded: result.duplicatesSuperseded,
      result,
    };
  }

  /**
   * Procedural memory stats (issue #567 PR 5/5). Read-only — resolves the
   * namespace via the same path used by `recallExplain` / `trustZoneStatus`
   * so cross-tenant reads are impossible (CLAUDE.md rule 42).
   */
  async procedureStats(
    request: { namespace?: string } = {},
    principal?: string
  ): Promise<ProcedureStatsReport & { namespace: string }> {
    const resolvedNamespace = this.resolveReadableNamespace(request.namespace, principal);
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    const report = await computeProcedureStats({
      storage,
      config: this.orchestrator.config,
    });
    return { namespace: resolvedNamespace, ...report };
  }

  /**
   * Procedure library health maintenance (issue #2370). Shadow-first: the
   * gate is checked BEFORE any storage read, so `maintenance.enabled=false`
   * returns `{ enabled: false }` having touched nothing but config. Apply
   * mode additionally requires `apply: true`; `dryRun: true` forces shadow.
   *
   * The authenticated principal (never a client-supplied actor) drives the
   * namespace via the same writable resolver `procedureMiningRun` uses, so
   * cross-tenant writes are impossible.
   */
  async procedureLibraryMaintenance(
    request: {
      namespace?: string;
      apply?: boolean;
      dryRun?: boolean;
      authenticatedPrincipal?: string;
    },
    principal?: string
  ): Promise<
    | { enabled: false }
    | {
        enabled: true;
        namespace: string;
        report: ProcedureLibraryMaintenanceReport;
      }
  > {
    const procedural = this.orchestrator.config.procedural;
    if (procedural?.enabled !== true || procedural.maintenance?.enabled !== true) {
      return { enabled: false };
    }
    const resolvedNamespace = this.writableNamespaceFor(
      request.namespace,
      undefined,
      request.authenticatedPrincipal ?? principal
    );
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    const report = await runProcedureLibraryMaintenance({
      memoryDir: storage.dir,
      storage,
      config: this.orchestrator.config,
      apply: request.apply === true && request.dryRun !== true,
    });
    return { enabled: true, namespace: resolvedNamespace, report };
  }

  async memorySummarizeHourly(): Promise<{
    ok: true;
    message: string;
    sessionsConsidered: number;
    sessionsWithEntries: number;
    summariesWritten: number;
    staleStore: boolean;
    newestEntryTimestamp: string | null;
    scanFailed: boolean;
    warning?: string;
  }> {
    // Issue #2783: the summarizer must not report success on empty work.
    // Stats interpretation lives with the stats (summarizeHourlyStatus).
    const stats = await this.orchestrator.summarizer.runHourly();
    return { ok: true, ...stats, ...summarizeHourlyStatus(stats) };
  }

  async conversationIndexUpdate(
    request: {
      sessionKey?: string;
      hours?: number;
      embed?: boolean;
    } = {}
  ): Promise<{
    enabled: boolean;
    sessionKey?: string;
    sessions: number;
    chunks: number;
    skipped: number;
    skippedSessionKeys: string[];
    embeddedRuns: number;
    reason?: string;
    retryAfterMs?: number;
  }> {
    return this.accessAdminOpsSurface.conversationIndexUpdate(request);
  }

  async profilingReport(request: AccessProfilingReportRequest = {}): Promise<AccessProfilingReportResponse> {
    return this.accessAdminOpsSurface.profilingReport(request);
  }

  async trustZoneStatus(namespace?: string, principal?: string): Promise<EngramAccessTrustZoneStatusResponse> {
    const resolvedNamespace = this.resolveReadableNamespace(namespace, principal);
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    return {
      namespace: resolvedNamespace,
      status: await getTrustZoneStoreStatus({
        memoryDir: storage.dir,
        trustZoneStoreDir: this.orchestrator.config.trustZoneStoreDir,
        enabled: resolveSecurityCapabilities(this.orchestrator.config).trustZones === true,
        promotionEnabled: resolveSecurityCapabilities(this.orchestrator.config).quarantinePromotion === true,
        poisoningDefenseEnabled: resolveSecurityCapabilities(this.orchestrator.config).memoryPoisoningDefense === true,
      }),
    };
  }

  async trustZoneBrowse(
    request: EngramAccessTrustZoneBrowseRequest,
    principal?: string
  ): Promise<EngramAccessTrustZoneBrowseResponse> {
    const resolvedNamespace = this.resolveReadableNamespace(request.namespace, principal);
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    const result = await listTrustZoneRecords({
      memoryDir: storage.dir,
      trustZoneStoreDir: this.orchestrator.config.trustZoneStoreDir,
      query: request.query,
      zone: request.zone,
      kind: request.kind,
      sourceClass: request.sourceClass,
      limit: request.limit,
      offset: request.offset,
    });
    return {
      namespace: resolvedNamespace,
      total: result.total,
      count: result.count,
      limit: result.limit,
      offset: result.offset,
      records: result.records.map((entry) =>
        summarizeTrustZoneRecord(
          entry.record,
          entry.filePath,
          result.allRecords,
          resolveSecurityCapabilities(this.orchestrator.config).memoryPoisoningDefense === true,
          resolveSecurityCapabilities(this.orchestrator.config).trustZones === true,
          resolveSecurityCapabilities(this.orchestrator.config).quarantinePromotion === true
        )
      ),
    };
  }

  async trustZonePromote(request: EngramAccessTrustZonePromoteRequest): Promise<EngramAccessTrustZonePromoteResponse> {
    if (!isTrustZoneName(request.targetZone)) {
      throw new EngramAccessInputError(`unsupported trust-zone target: ${String(request.targetZone)}`);
    }
    const resolvedNamespace = this.writableNamespaceFor(request.namespace, undefined, request.authenticatedPrincipal);
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    let result: TrustZonePromotionResult;
    try {
      result = await promoteTrustZoneRecord({
        memoryDir: storage.dir,
        trustZoneStoreDir: this.orchestrator.config.trustZoneStoreDir,
        enabled: resolveSecurityCapabilities(this.orchestrator.config).trustZones === true,
        promotionEnabled: resolveSecurityCapabilities(this.orchestrator.config).quarantinePromotion === true,
        poisoningDefenseEnabled: resolveSecurityCapabilities(this.orchestrator.config).memoryPoisoningDefense === true,
        sourceRecordId: request.recordId,
        targetZone: request.targetZone,
        recordedAt: request.recordedAt ?? new Date().toISOString(),
        promotionReason: request.promotionReason,
        summary: request.summary,
        dryRun: request.dryRun === true,
      });
    } catch (error) {
      throw normalizeTrustZoneInputError(error) ?? error;
    }
    return {
      namespace: resolvedNamespace,
      ...result,
      dryRun: request.dryRun === true,
    };
  }

  async trustZoneDemoSeed(
    request: EngramAccessTrustZoneDemoSeedRequest
  ): Promise<EngramAccessTrustZoneDemoSeedResponse> {
    const resolvedNamespace = this.writableNamespaceFor(request.namespace, undefined, request.authenticatedPrincipal);
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    let result: TrustZoneDemoSeedResult;
    try {
      result = await seedTrustZoneDemoDataset({
        memoryDir: storage.dir,
        trustZoneStoreDir: this.orchestrator.config.trustZoneStoreDir,
        enabled: resolveSecurityCapabilities(this.orchestrator.config).trustZones === true,
        scenario: request.scenario,
        recordedAt: request.recordedAt,
        dryRun: request.dryRun === true,
      });
    } catch (error) {
      throw normalizeTrustZoneInputError(error) ?? error;
    }
    return {
      namespace: resolvedNamespace,
      ...result,
    };
  }

  async reviewDisposition(
    request: EngramAccessReviewDispositionRequest
  ): Promise<EngramAccessReviewDispositionResponse> {
    const memoryId = request.memoryId.trim();
    const reasonCode = request.reasonCode.trim();
    if (memoryId.length === 0) {
      throw new EngramAccessInputError("memoryId is required");
    }
    if (reasonCode.length === 0) {
      throw new EngramAccessInputError("reasonCode is required");
    }

    const resolvedNamespace = this.writableNamespaceFor(request.namespace, undefined, request.authenticatedPrincipal);
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    const memory = await storage.getMemoryById(memoryId);
    if (!memory || isSupportPassportPrivateMemory(memory)) {
      throw new EngramAccessInputError(`memory not found: ${memoryId}`);
    }

    const previousStatus = memory.frontmatter.status ?? "active";
    const updatedAt = new Date().toISOString();
    const lifecycle = {
      actor: "admin-console.review-disposition",
      reasonCode,
      ruleVersion: "memory-governance.v1",
    };

    if (request.status === "archived") {
      const archivedPath = await storage.archiveMemory(memory, {
        at: new Date(updatedAt),
        ...lifecycle,
      });
      if (!archivedPath) {
        throw new Error(`failed to archive memory disposition: ${memoryId}`);
      }
      return {
        ok: true,
        namespace: resolvedNamespace,
        memoryId,
        status: "archived",
        previousStatus,
        currentPath: archivedPath,
      };
    }

    const updated = await storage.writeMemoryFrontmatter(
      memory,
      {
        status: request.status,
        updated: updatedAt,
      },
      lifecycle
    );
    if (!updated) {
      throw new Error(`failed to update memory disposition: ${memoryId}`);
    }
    return {
      ok: true,
      namespace: resolvedNamespace,
      memoryId,
      status: request.status,
      previousStatus,
      currentPath: memory.path,
    };
  }

  private serializeMemory(memory: MemoryFile): EngramAccessMemoryRecord {
    return {
      id: memory.frontmatter.id,
      path: memory.path,
      category: memory.frontmatter.category,
      status: memory.frontmatter.status,
      created: memory.frontmatter.created,
      updated: memory.frontmatter.updated,
      content: memory.content,
      frontmatter: memory.frontmatter,
    };
  }

  private serializeMemorySummary(
    memory: MemoryFile,
    baseDir: string,
    disclosure?: RecallDisclosure,
    rawExcerpts?: EngramAccessMemorySummary["rawExcerpts"]
  ): EngramAccessMemorySummary {
    return shapeMemorySummary(memory, baseDir, disclosure, rawExcerpts);
  }

  async observe(
    request: EngramAccessObserveRequest,
    hooks?: { enforceWriteQuota?: () => void | Promise<void> }
  ): Promise<EngramAccessObserveResponse> {
    // Issue #1649: dedup retried observe POSTs server-side. A retry with the
    // same `idempotencyKey` replays the cached response and skips every side
    // effect (LCM/extraction/objective-state); divergent payload OR principal
    // reuse is a conflict (fingerprint folds in authenticatedPrincipal, so a
    // cross-identity replay can never be silent). `enforceWriteQuota` runs as
    // `beforeExecute` inside the lock — only on a real miss — so a response-lost
    // retry never 429s even when the first attempt filled the window (#1434).
    //
    // The fingerprint folds in the EFFECTIVE coding context (#1649 codex P2):
    // runObserve's scope can be derived from the session's ATTACHED coding
    // context (which takes PRECEDENCE over per-call cwd/projectTag per
    // resolveMemoryScopePlan), so neither cwd/projectTag NOR the raw ambient
    // context alone fully captures the effective scope. The effective context
    // is computed the SAME way resolveMemoryScopePlan does — session-attached
    // first, per-call cwd/projectTag fallback — but READ-ONLY: it does NOT seed
    // the session, so a conflict/quota-rejection path leaves no orphaned binding.
    // The value is stable across replays because resolveMemoryScopePlan's
    // seeding writes the IDENTICAL context that resolveCodingContextFromOptions
    // derives — so getCodingContextForSession returns the same object on the
    // replay as resolveCodingContextFromOptions returned on the first call.
    // Only computed when a key is present; non-keyed observes skip the work.
    const idempotencyKey = request.idempotencyKey?.trim();
    let effectiveCodingContext: CodingContext | null | undefined;
    if (idempotencyKey && !(typeof request.namespace === "string" && request.namespace.trim().length > 0)) {
      // Explicit namespace pins the scope (resolveMemoryScopePlan returns early),
      // so the coding context is irrelevant — skip it to avoid false conflicts
      // when the session context changes under a namespace-pinned observe.
      // Reuse the write resolver's namespace/projectScope gates so context
      // ignored by runObserve cannot change the retry fingerprint.
      effectiveCodingContext = (await this.resolveCodingScopeInputs(request)).codingContext;
    }
    return this.handleIdempotentWrite<EngramAccessObserveResponse>({
      operation: "observe",
      idempotencyKey: request.idempotencyKey,
      // Shared builder (issue #1989 PR3): byte-parity with the historical
      // inline literal is asserted by access-fingerprint-parity.test.ts.
      requestFingerprint: buildObserveRequestFingerprint({
        sessionKey: request.sessionKey,
        messages: request.messages,
        namespace: request.namespace,
        skipExtraction: request.skipExtraction,
        authenticatedPrincipal: request.authenticatedPrincipal,
        cwd: request.cwd,
        projectTag: request.projectTag,
        effectiveCodingContext: effectiveCodingContext ?? null,
        sourceConnector: request.sourceConnector,
      }),
      beforeExecute: hooks?.enforceWriteQuota,
      execute: () => this.runObserve(request),
    });
  }

  private async runObserve(request: EngramAccessObserveRequest): Promise<EngramAccessObserveResponse> {
    return this.accessObserveWriteSurface.runObserve(request);
  }

  async lcmSearch(request: EngramAccessLcmSearchRequest): Promise<EngramAccessLcmSearchResponse> {
    return this.accessLcmSurface.lcmSearch(request);
  }

  /**
   * Resolve the LCM `session_id` a same-session READER (compaction flush/record,
   * `lcmSearch`, raw-excerpt lookup) must target so it matches the key `observe`
   * archived under (#1495 thread 2 + #1505 round 3, rule 42). One helper for
   * EVERY access-surface LCM read so the read key cannot drift from the write key
   * (rule 22).
   *
   * Precedence mirrors `observe`'s effective write namespace:
   *  - With an explicit `request.namespace`, use the already-authorized
   *    `resolvedNamespace` (the overlay never applies to an explicit write).
   *  - With NO explicit namespace, an auto-scoped session was archived under
   *    its coding-overlay namespace, so overlay the session's bound coding
   *    context onto the principal self base — the SAME resolution
   *    `resolveMemoryScopePlan`/recall use. `applyCodingNamespaceOverlay`
   *    returns the base unchanged when projectScope/namespaces are off or no
   *    context is bound, so single-store / no-overlay flows collapse to the raw
   *    sessionKey exactly as before.
   *
   * Then encode the `${namespace}:${sessionKey}` prefix via the shared helper
   * so the read key is byte-for-byte what the LCM write and the recall readers
   * use.
   */
  private resolveLcmReadNamespace(
    explicitNamespace: string | undefined,
    resolvedNamespace: string,
    sessionKeyForOverlay: string | undefined,
    authenticatedPrincipal: string | undefined,
    purpose: "read" | "write" = "read"
  ): string {
    return this.accessLcmSurface.resolveLcmReadNamespace(
      explicitNamespace,
      resolvedNamespace,
      sessionKeyForOverlay,
      authenticatedPrincipal,
      purpose
    );
  }

  private resolveRawExcerptReadNamespace(
    explicitNamespace: string | undefined,
    sessionKey: string | undefined,
    authenticatedPrincipal: string | undefined
  ): string | undefined {
    return this.accessLcmSurface.resolveRawExcerptReadNamespace(explicitNamespace, sessionKey, authenticatedPrincipal);
  }

  /**
   * The base `resolvedNamespace` an IMPLICIT (no explicit `namespace`)
   * same-session LCM READER (`resolveRawExcerptReadNamespace`, `lcmSearch`)
   * passes into {@link resolveLcmReadNamespace} — WITHOUT pre-authorizing
   * `default` (#1505 thread NBHWz). It decides PROCEED vs SUPPRESS only; the
   * actual LCM prefix is then resolved by `resolveLcmReadNamespace`, which
   * mirrors the orchestrator's `lcmReadNamespaceForSession` EXACTLY (rule 39 /
   * 42): the coding overlay when the principal SELF base is in the readable
   * recall set, else `config.defaultNamespace` (the raw key).
   *
   * Returns `config.defaultNamespace` (PROCEED) whenever the principal has ANY
   * readable LCM access — either `default` itself is readable, OR a coding
   * overlay / self base is in the readable recall set. The returned value is
   * ALWAYS `config.defaultNamespace`, NEVER an arbitrary readable recall
   * namespace (e.g. `shared`): `resolveLcmReadNamespace` returns this fallback
   * verbatim only on the overlay-applies-but-self-unreadable branch, where the
   * orchestrator collapses to the default store — so returning anything but the
   * default store there would prefix LCM reads with `shared:sessionKey` while
   * in-prompt recall uses the raw `sessionKey`, diverging the two (cursor
   * "LCM read gate wrong fallback").
   *
   * Returns `undefined` (SUPPRESS) only when NO readable LCM namespace exists —
   * a restrictive `default` READ policy AND no readable overlay/self — so the
   * caller emits NO rows instead of throwing `namespace is not readable:
   * default`. Normal recall still succeeds through the readable self namespace.
   *
   * Single-store / namespaces-disabled deployments resolve to
   * `config.defaultNamespace`, keeping single-user recall byte-for-byte
   * unchanged.
   */
  private resolveImplicitLcmReadFallbackNamespace(principal: string | undefined): string | undefined {
    const config = this.orchestrator.config;
    if (!resolveNamespaceCapabilities(config).namespaces) return config.defaultNamespace;
    // PROCEED when `default` is readable (single-store / readable-default flows)
    // — the LCM prefix resolves to the overlay when self-authorized, else the
    // default raw key.
    if (canReadNamespace(principal, config.defaultNamespace, config)) {
      return config.defaultNamespace;
    }
    // Restrictive `default` READ policy. The ONLY way the implicit LCM read can
    // target an AUTHORIZED key is via the coding OVERLAY, which
    // `resolveLcmReadNamespace` switches to ONLY when the principal SELF base is
    // in the readable recall set (the SAME gate the orchestrator's
    // `lcmReadNamespaceForSession` uses). So PROCEED here ONLY when the SELF base
    // is readable-in-recall — NOT when merely some OTHER recall namespace (e.g.
    // `shared`) is readable: the LCM read can never legitimately target `shared`,
    // and returning `config.defaultNamespace` for that case would let a sessionless
    // `lcmSearch`/raw recall scan the DENIED default LCM store (codex P1 "Don't
    // treat any readable namespace as default LCM access"). The downstream
    // overlay-unreadable READ branch and `lcmSearch`'s sessionless guard both
    // collapse to the default raw key, so a self-readable PROCEED still yields the
    // scoped overlay key (with a session) or empty (sessionless). SUPPRESS
    // (`undefined`) when the self base is not readable-in-recall.
    const selfBase = defaultNamespaceForPrincipal(principal, config);
    const selfReadableInRecall = recallNamespacesForPrincipal(principal, config).includes(selfBase);
    return selfReadableInRecall ? config.defaultNamespace : undefined;
  }

  private resolveLcmReadSessionKey(
    explicitNamespace: string | undefined,
    resolvedNamespace: string,
    sessionKey: string,
    authenticatedPrincipal: string | undefined,
    purpose: "read" | "write" = "read"
  ): string {
    const effectiveNamespace = this.resolveLcmReadNamespace(
      explicitNamespace,
      resolvedNamespace,
      sessionKey,
      authenticatedPrincipal,
      purpose
    );
    return (
      lcmSessionKeyForNamespace(effectiveNamespace, sessionKey, this.orchestrator.config.defaultNamespace) ?? sessionKey
    );
  }

  /**
   * Resolve the ORDERED, read-authorized set of LCM `session_id`s a same-session
   * READER (`lcmSearch`, raw-excerpt disclosure) must query so it matches every
   * key `observe` archived under across the coding scope (#1505 thread "Include
   * coding fallback namespaces in LCM reads").
   *
   * Mirrors the orchestrator recall path exactly (rule 39): `observe` archives
   * each turn under `${effectiveNamespace}:${sessionKey}` for whichever namespace
   * was effective at write time, and normal QMD/file recall searches the primary
   * coding-overlay namespace AND `codingOverlay.readFallbacks` (project → root).
   * A single overlay key therefore MISSES rows a branch-scoped session archived at
   * project/root scope. This returns the primary overlay LCM key first, then one
   * per read fallback, deduped + ordered so the caller can short-circuit on the
   * first hit.
   *
   * READ-AUTHORIZATION (preserved from the round-3..5 `resolveLcmReadNamespace`
   * "read" gate; rule 42 / 48): the overlay + fallbacks are `<principal>-project-*`
   * sub-namespaces authorized transitively by the principal SELF base. They are
   * included ONLY when the self base is in the readable recall set
   * (`recallNamespacesForPrincipal`). When the self base is NOT readable (write-
   * only / self-omitted principal), or when an explicit namespace was supplied,
   * or no overlay applies, this collapses to the single key
   * {@link resolveLcmReadSessionKey} returns — byte-for-byte the prior behavior
   * (single-store / no-overlay flows stay the raw `sessionKey`). No
   * `<principal>-project-*` key is ever searched for an unauthorized reader (no
   * cross-tenant read leak).
   */
  private resolveScopeProfileLcmReadNamespaces(
    sessionKey: string | undefined,
    authenticatedPrincipal: string | undefined
  ): string[] | null {
    const config = this.orchestrator.config;
    const principal = this.resolveRequestPrincipal(sessionKey, authenticatedPrincipal);
    const codingContext = sessionKey ? this.orchestrator.getCodingContextForSession(sessionKey) : null;
    const codingOverlay = resolveCodingNamespaceOverlay(codingContext, config.codingMode, config.defaultNamespace);
    const profilePlan = resolveScopeProfilePlan({
      config,
      principal,
      codingContext,
      codingOverlay,
    });
    if (!profilePlan) return null;
    const principalSelfNamespace = defaultNamespaceForPrincipal(principal, config);
    const legacyRecallNamespaces = Array.isArray(config.defaultRecallNamespaces)
      ? recallNamespacesForPrincipal(principal, config)
      : [];
    return expandScopeProfileReadNamespaces({
      profilePlan,
      principalSelfNamespace: profilePlan.baseNamespace,
      config,
      principal,
      codingOverlay,
      legacyRecallNamespaces,
    });
  }

  private lcmSessionIdsForNamespaces(namespaces: string[], sessionKey: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const namespace of namespaces) {
      const key =
        lcmSessionKeyForNamespace(namespace, sessionKey, this.orchestrator.config.defaultNamespace) ?? sessionKey;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(key);
      }
    }
    return out;
  }

  private resolveLcmReadSessionIds(
    explicitNamespace: string | undefined,
    resolvedNamespace: string,
    sessionKey: string,
    authenticatedPrincipal: string | undefined
  ): string[] {
    return this.accessLcmSurface.resolveLcmReadSessionIds(
      explicitNamespace,
      resolvedNamespace,
      sessionKey,
      authenticatedPrincipal
    );
  }

  async lcmCompactionFlush(
    request: EngramAccessLcmCompactionFlushRequest
  ): Promise<EngramAccessLcmCompactionFlushResponse> {
    if (!request.sessionKey || typeof request.sessionKey !== "string" || request.sessionKey.trim().length === 0) {
      throw new EngramAccessInputError("sessionKey is required and must be a non-empty string");
    }

    // Authorize compaction against the same effective write namespace that
    // observe archived under, not a premature default writable-namespace check.
    const scope = await this.resolveMemoryScopePlan(request);
    const namespace = this.legacyResponseNamespaceForScope(scope);
    if (!this.orchestrator.lcmEngine || !this.orchestrator.lcmEngine.enabled) {
      return {
        enabled: false,
        flushed: false,
        sessionKey: request.sessionKey,
        namespace,
        reason: "LCM is disabled",
      };
    }

    // Flush the same LCM session ID observe archived under.
    const lcmSessionKey =
      lcmSessionKeyForNamespace(scope.writeNamespace, request.sessionKey, this.orchestrator.config.defaultNamespace) ??
      request.sessionKey;
    await this.orchestrator.lcmEngine.waitForSessionObserveIdle(lcmSessionKey);
    await this.orchestrator.lcmEngine.preCompactionFlush(lcmSessionKey);
    return {
      enabled: true,
      flushed: true,
      sessionKey: request.sessionKey,
      namespace,
    };
  }

  async extractionForceFlush(
    request: EngramAccessExtractionForceFlushRequest
  ): Promise<EngramAccessExtractionForceFlushResponse> {
    return delegateExtractionForceFlush(this.accessObserveWriteSurface, request);
  }
  cancelPendingObservePreparations(sessionKey: string, scopeHint?: string): void {
    this.accessObserveWriteSurface.cancelPendingObservePreparations(sessionKey, scopeHint);
  }

  cancelPendingObserveExtractions(
    sessionKey: string,
    principal?: string,
    namespace?: string,
    scopeHint?: string
  ): void {
    this.accessObserveWriteSurface.cancelPendingObserveExtractions(sessionKey, principal, namespace, scopeHint);
  }
  async lcmCompactionRecord(
    request: EngramAccessLcmCompactionRecordRequest
  ): Promise<EngramAccessLcmCompactionRecordResponse> {
    if (!request.sessionKey || typeof request.sessionKey !== "string" || request.sessionKey.trim().length === 0) {
      throw new EngramAccessInputError("sessionKey is required and must be a non-empty string");
    }
    if (!Number.isInteger(request.tokensBefore) || request.tokensBefore < 0) {
      throw new EngramAccessInputError("tokensBefore must be a non-negative integer");
    }
    if (!Number.isInteger(request.tokensAfter) || request.tokensAfter < 0) {
      throw new EngramAccessInputError("tokensAfter must be a non-negative integer");
    }

    // Authorize compaction against the SCOPED WRITE TARGET — the SAME effective
    // write namespace `observe` archived the LCM queue under — NOT a premature
    // the writable-namespace resolver (undefined ⇒ config.defaultNamespace) (#1505
    // thread NBHWs). See `lcmCompactionFlush` for the full rationale: under a
    // restrictive `default` WRITE policy where the principal can still write its
    // self/project overlay, the old premature default write-auth threw `namespace
    // is not writable: default` before the scoped key was computed, leaving the
    // overlay queue observe wrote unrecordable. `resolveMemoryScopePlan` is the
    // ONE write-scoped plan/gate observe uses; it authorizes the self base for an
    // overlay write and never throws `not writable: default` for a validly scoped
    // observe's queue.
    const scope = await this.resolveMemoryScopePlan(request);
    const namespace = this.legacyResponseNamespaceForScope(scope);
    if (!this.orchestrator.lcmEngine || !this.orchestrator.lcmEngine.enabled) {
      return {
        enabled: false,
        recorded: false,
        sessionKey: request.sessionKey,
        namespace,
        reason: "LCM is disabled",
      };
    }

    // Record against the SAME LCM session_id `observe` archived under — encode
    // the scope plan's EFFECTIVE write namespace through the SAME
    // `lcmSessionKeyForNamespace` helper observe uses, so the record key is
    // byte-for-byte the write key (#1495 thread 2 / #1505 thread NBHWs, rule 42).
    // A write-only / self-omitted principal still records on the overlay queue
    // because the scope plan authorized the write target by WRITE policy.
    const lcmSessionKey =
      lcmSessionKeyForNamespace(scope.writeNamespace, request.sessionKey, this.orchestrator.config.defaultNamespace) ??
      request.sessionKey;
    await this.orchestrator.lcmEngine.waitForSessionObserveIdle(lcmSessionKey);
    await this.orchestrator.lcmEngine.recordCompaction(lcmSessionKey, request.tokensBefore, request.tokensAfter);
    return {
      enabled: true,
      recorded: true,
      sessionKey: request.sessionKey,
      namespace,
    };
  }

  // ── Parity tools (match OpenClaw plugin feature set) ──────────────────

  // ── Continuity / Identity ──────────────────────────────────────────────

  async continuityAuditGenerate(request: {
    period?: "weekly" | "monthly";
    key?: string;
  }): Promise<{ enabled: boolean; reason?: string; period?: string; key?: string; reportPath?: string }> {
    return this.accessIdentityContinuitySurface.continuityAuditGenerate(request);
  }

  async continuityIncidentOpen(request: {
    symptom: string;
    namespace?: string;
    principal?: string;
    triggerWindow?: string;
    suspectedCause?: string;
  }): Promise<unknown> {
    return this.accessIdentityContinuitySurface.continuityIncidentOpen(request);
  }

  async continuityIncidentClose(request: {
    id: string;
    namespace?: string;
    principal?: string;
    fixApplied: string;
    verificationResult: string;
    preventiveRule?: string;
  }): Promise<unknown> {
    return this.accessIdentityContinuitySurface.continuityIncidentClose(request);
  }

  async continuityIncidentList(request: {
    state?: "open" | "closed" | "all";
    namespace?: string;
    principal?: string;
    limit?: number;
  }): Promise<unknown> {
    return this.accessIdentityContinuitySurface.continuityIncidentList(request);
  }

  async continuityLoopAddOrUpdate(request: {
    id: string;
    cadence: "daily" | "weekly" | "monthly" | "quarterly";
    purpose: string;
    status: "active" | "paused" | "retired";
    killCondition: string;
    namespace?: string;
    principal?: string;
    lastReviewed?: string;
    notes?: string;
  }): Promise<unknown> {
    return this.accessIdentityContinuitySurface.continuityLoopAddOrUpdate(request);
  }

  async continuityLoopReview(request: {
    id: string;
    namespace?: string;
    principal?: string;
    status?: "active" | "paused" | "retired";
    notes?: string;
    reviewedAt?: string;
  }): Promise<unknown> {
    return this.accessIdentityContinuitySurface.continuityLoopReview(request);
  }

  async identityAnchorGet(request: {
    namespace?: string;
    principal?: string;
  }): Promise<unknown> {
    return this.accessIdentityContinuitySurface.identityAnchorGet(request);
  }

  /**
   * @deprecated since issue #679 PR 5/5 — the identity-anchor model is
   * superseded by the peer registry. Use `peerSet({ id: "self", ... })` or
   * `remnic peer set self` to update the self peer's identity kernel, and
   * `remnic peer migrate` to seed `peers/self/identity.md` from existing
   * legacy anchor data. This method continues to function for backward
   * compatibility but will be removed in a future major version.
   */
  async identityAnchorUpdate(request: {
    namespace?: string;
    principal?: string;
    identityTraits?: string;
    communicationPreferences?: string;
    operatingPrinciples?: string;
    continuityNotes?: string;
  }): Promise<unknown> {
    return this.accessIdentityContinuitySurface.identityAnchorUpdate(request);
  }

  async memoryIdentity(request: {
    namespace?: string;
    principal?: string;
  }): Promise<unknown> {
    return this.accessIdentityContinuitySurface.memoryIdentity(request);
  }

  // ── Work Layer ──────────────────────────────────────────────────────────

  async workTask(request: {
    action: "create" | "get" | "list" | "update" | "transition" | "delete";
    id?: string;
    title?: string;
    description?: string;
    status?: string;
    priority?: string;
    owner?: string;
    assignee?: string;
    projectId?: string;
    tags?: string[];
    dueAt?: string;
  }): Promise<unknown> {
    return this.accessObserveWriteSurface.workTask(request);
  }

  async workProject(request: {
    action: "create" | "get" | "list" | "update" | "delete" | "link_task";
    id?: string;
    name?: string;
    description?: string;
    status?: string;
    owner?: string;
    tags?: string[];
    taskId?: string;
    projectId?: string;
  }): Promise<unknown> {
    return this.accessObserveWriteSurface.workProject(request);
  }

  async workBoard(request: {
    action: "export_markdown" | "export_snapshot" | "import_snapshot";
    projectId?: string;
    snapshotJson?: string;
    linkToMemory?: boolean;
  }): Promise<unknown> {
    return this.accessObserveWriteSurface.workBoard(request);
  }

  async sharedContextWriteOutput(request: {
    agentId: string;
    title: string;
    content: string;
    /** Authenticated principal resolved by the surface, never client-supplied. */
    principal?: string;
  }): Promise<unknown> {
    if (!this.orchestrator.sharedContext) {
      return { enabled: false, reason: "Shared context is disabled. Enable `sharedContextEnabled: true`." };
    }
    let fp: string;
    try {
      fp = await this.orchestrator.sharedContext.writeAgentOutput({
        agentId: request.agentId,
        title: request.title,
        content: request.content,
        // The origin is server-owned in BOTH cases (issue #1957 review
        // round 4): the authenticated principal when one resolved, and a
        // reserved unattributed token otherwise — a principal-less
        // authenticated request must never stamp the client's `agentId`
        // as audit metadata. The client label survives only as the
        // producer, which feeds grouping and display, never authority.
        ...(request.principal
          ? { authenticatedIdentity: request.principal }
          : { unattributedOrigin: UNATTRIBUTED_ACCESS_WRITE_ORIGIN }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("shared-context write origin mismatch")) {
        throw new EngramAccessInputError(message);
      }
      throw error;
    }
    return { written: true, path: fp };
  }

  async sharedFeedbackRecord(request: {
    agent: string;
    decision: "approved" | "approved_with_feedback" | "rejected";
    reason: string;
    date?: string;
    learning?: string;
    outcome?: string;
    severity?: "low" | "medium" | "high";
    confidence?: number;
    workflow?: string;
    tags?: string[];
    evidenceWindowStart?: string;
    evidenceWindowEnd?: string;
    refs?: string[];
  }): Promise<unknown> {
    if (!this.orchestrator.sharedContext) {
      return { enabled: false, reason: "Shared context is disabled. Enable `sharedContextEnabled: true`." };
    }
    await this.orchestrator.sharedContext.appendFeedback({
      agent: request.agent,
      decision: request.decision,
      reason: request.reason,
      date: request.date?.trim() || new Date().toISOString(),
      learning: request.learning,
      outcome: request.outcome,
      severity: request.severity,
      confidence: request.confidence,
      workflow: request.workflow,
      tags: request.tags,
      evidenceWindowStart: request.evidenceWindowStart,
      evidenceWindowEnd: request.evidenceWindowEnd,
      refs: request.refs,
    });
    return { recorded: true };
  }

  async sharedPrioritiesAppend(request: {
    agentId: string;
    text: string;
  }): Promise<unknown> {
    if (!this.orchestrator.sharedContext) {
      return { enabled: false, reason: "Shared context is disabled. Enable `sharedContextEnabled: true`." };
    }
    await this.orchestrator.sharedContext.appendPrioritiesInbox({
      agentId: request.agentId,
      text: request.text,
    });
    return { appended: true };
  }

  async sharedContextCrossSignalsRun(request: {
    date?: string;
  }): Promise<unknown> {
    if (!this.orchestrator.sharedContext) {
      return { enabled: false, reason: "Shared context is disabled. Enable `sharedContextEnabled: true`." };
    }
    const result = await this.orchestrator.sharedContext.synthesizeCrossSignals({ date: request.date });
    return {
      crossSignalsMarkdownPath: result.crossSignalsMarkdownPath,
      crossSignalsPath: result.crossSignalsPath,
      sourceCount: result.report.sourceCount,
      feedbackCount: result.report.feedbackCount,
      overlapCount: result.overlapCount,
    };
  }

  async sharedContextCurateDaily(request: {
    date?: string;
  }): Promise<unknown> {
    if (!this.orchestrator.sharedContext) {
      return { enabled: false, reason: "Shared context is disabled. Enable `sharedContextEnabled: true`." };
    }
    const result = await this.orchestrator.sharedContext.curateDaily({ date: request.date });
    return {
      roundtablePath: result.roundtablePath,
      crossSignalsMarkdownPath: result.crossSignalsMarkdownPath,
      crossSignalsPath: result.crossSignalsPath,
      overlapCount: result.overlapCount,
    };
  }

  async compoundingWeeklySynthesize(request: {
    weekId?: string;
  }): Promise<unknown> {
    if (!this.orchestrator.compounding) {
      return { enabled: false, reason: "Compounding engine is disabled. Enable `compoundingEnabled: true`." };
    }
    const res = await this.orchestrator.compounding.synthesizeWeekly({ weekId: request.weekId });
    return {
      weekId: res.weekId,
      reportPath: res.reportPath,
      reportJsonPath: res.reportJsonPath,
      rubricsPath: res.rubricsPath,
      rubricsIndexPath: res.rubricsIndexPath,
      mistakesCount: res.mistakesCount,
      promotionCandidateCount: res.promotionCandidateCount,
    };
  }

  async compoundingPromoteCandidate(request: {
    weekId: string;
    candidateId: string;
    dryRun?: boolean;
  }): Promise<unknown> {
    if (!this.orchestrator.compounding) {
      return { enabled: false, reason: "Compounding engine is disabled. Enable `compoundingEnabled: true`." };
    }
    return await this.orchestrator.compounding.promoteCandidate({
      weekId: request.weekId,
      candidateId: request.candidateId,
      dryRun: request.dryRun,
    });
  }

  async compressionGuidelinesOptimize(request: {
    dryRun?: boolean;
    eventLimit?: number;
  }): Promise<unknown> {
    if (!resolveCompressionCapabilities(this.orchestrator.config).compressionGuidelineLearning) {
      return {
        enabled: false,
        reason: "Compression guideline learning is disabled. Enable `compressionGuidelineLearningEnabled: true`.",
      };
    }
    return await this.orchestrator.compressionGuidelineCoordinator.optimizeCompressionGuidelines({
      dryRun: request.dryRun,
      eventLimit: request.eventLimit,
    });
  }

  async compressionGuidelinesActivate(request: {
    expectedContentHash?: string;
    expectedGuidelineVersion?: number;
  }): Promise<unknown> {
    if (!resolveCompressionCapabilities(this.orchestrator.config).compressionGuidelineLearning) {
      return { enabled: false, reason: "Compression guideline learning is disabled." };
    }
    return await this.orchestrator.compressionGuidelineCoordinator.activateCompressionGuidelineDraft({
      expectedContentHash: request.expectedContentHash,
      expectedGuidelineVersion: request.expectedGuidelineVersion,
    });
  }

  async memorySearch(request: {
    query: string;
    namespace?: string;
    maxResults?: number;
    collection?: string;
    mode?: "search" | "hybrid" | "bm25" | "vector";
    principal?: string;
  }): Promise<{ query: string; results: Array<{ path: string; score: number; snippet: string }>; count: number }> {
    const { qmd, config } = this.orchestrator;
    return memorySearchThroughScope(
      {
        namespacesEnabled: resolveNamespaceCapabilities(config).namespaces,
        memoryCollections: [config.qmdCollection, config.qmdColdCollection ?? "openclaw-engram-cold"],
        // `0` is preserved, never coerced: a zero limit is a runtime
        // compatibility guarantee (AGENTS.md guardrail 4), and it means the
        // same thing here as an explicit `maxResults: 0` from the caller - an
        // empty result with no backend call. Anything non-numeric falls back
        // to the documented default.
        defaultBudget: typeof config.qmdMaxResults === "number" ? config.qmdMaxResults : 10,
        // Search-specific: artifacts and the other dedicated surfaces stay
        // out, but ARCHIVED memories remain findable - explicit search is one
        // of the surfaces the lifecycle reserves them for.
        isExcluded: (memoryPath) =>
          isSearchExcludedPath(
            memoryPath,
            // The caller's own collection disambiguates a prefix that is also
            // a memory category name (`collection: "facts"`).
            { ...config, requestedCollection: request.collection?.trim() || undefined },
            "qmd"
          ),
        filterPrivate: this.orchestrator.filterPrivateSearchResults,
        authorizeFlatCorpus: (namespace, principal) => void this.resolveReadableNamespace(namespace, principal),
        authorizeNamespaces: async (namespace, principal, collection) =>
          this.resolveMemorySearchNamespacesForCollection(
            collection,
            await this.resolveReadableNamespacesForSearch(namespace, principal),
            namespace?.trim() ? undefined : principal
          ),
        searchAcrossNamespaces: (params) => this.orchestrator.searchAcrossNamespaces(params),
        searchGlobal: (query, maxResults) => qmd.searchGlobal(query, maxResults),
        search: (query, collection, maxResults) => qmd.search(query, collection, maxResults),
      },
      request
    );
  }

  async memoryProfile(namespace?: string, principal?: string): Promise<Record<string, unknown>> {
    const resolvedNs = this.resolveReadableNamespace(namespace, principal);
    const storage = await this.orchestrator.getStorage(resolvedNs);
    const profile = await storage.readProfile();
    return {
      profile: profile || "No profile built yet. The profile builds automatically through conversations.",
    };
  }

  async memoryEntitiesList(namespace?: string, principal?: string): Promise<{ entities: string[]; count: number }> {
    const resolvedNs = this.resolveReadableNamespace(namespace, principal);
    const storage = await this.orchestrator.getStorage(resolvedNs);
    const entities = await storage.readEntities();
    return { entities, count: entities.length };
  }

  async memoryQuestions(
    namespace?: string,
    principal?: string
  ): Promise<{ questions: Array<{ id: string; question: string; resolved: boolean }>; count: number }> {
    const resolvedNs = this.resolveReadableNamespace(namespace, principal);
    const storage = await this.orchestrator.getStorage(resolvedNs);
    const questions = await storage.readQuestions();
    return {
      questions: questions.map((q) => ({ id: q.id, question: q.question, resolved: q.resolved })),
      count: questions.length,
    };
  }

  async lastRecallSnapshot(sessionKey?: string): Promise<unknown> {
    const snapshot = sessionKey
      ? this.orchestrator.lastRecall.get(sessionKey)
      : this.orchestrator.lastRecall.getMostRecent();
    return snapshot ?? { message: "No recall snapshot available" };
  }

  async intentDebug(namespace?: string): Promise<unknown> {
    const snapshot = await this.orchestrator.recallIntrospection.getLastIntentSnapshot(namespace);
    return snapshot ?? { message: "No intent debug snapshot available" };
  }

  async qmdDebug(namespace?: string): Promise<unknown> {
    const snapshot = await this.orchestrator.recallIntrospection.getLastQmdRecallSnapshot(namespace);
    return snapshot ?? { message: "No QMD debug snapshot available" };
  }

  async graphExplainLastRecall(namespace?: string): Promise<unknown> {
    const explanation = await this.orchestrator.recallIntrospection.explainLastGraphRecall({ namespace });
    return { explanation };
  }

  async graphSnapshot(
    request: GraphSnapshotRequest & { namespace?: string },
    authenticatedPrincipal?: string
  ): Promise<GraphSnapshotResponse> {
    return this.accessAdminOpsSurface.graphSnapshot(request, authenticatedPrincipal);
  }

  async memoryFeedback(request: {
    memoryId: string;
    vote: "up" | "down";
    note?: string;
  }): Promise<{ recorded: boolean; enabled?: boolean; reason?: string }> {
    if (!resolveRecallEnhancementCapabilities(this.orchestrator.config).feedback) {
      return {
        recorded: false,
        enabled: false,
        reason: "Feedback is disabled. Enable `feedbackEnabled: true` in the Engram config to store feedback.",
      };
    }
    await this.orchestrator.recordMemoryFeedback(request.memoryId, request.vote, request.note);
    return { recorded: true };
  }

  /**
   * Record a Memory Worth outcome observation (issue #560 PR 3).
   *
   * This is distinct from `memoryFeedback` — feedback is a human thumbs
   * up/down on whether a recalled memory was relevant; outcome is an
   * automated signal about whether the session that consumed the memory
   * ultimately succeeded or failed. Outcomes feed the Laplace-smoothed
   * worth score (`computeMemoryWorth`, PR 2) that PR 4 will use to
   * downweight memories correlated with bad sessions.
   *
   * The underlying writer only touches fact-category memories. Corrections,
   * procedures, and other kinds return `{ ok: false, reason:
   * "ineligible_category" }` so a ledger drainer doesn't need to pre-filter.
   */
  async memoryOutcome(request: {
    memoryId: string;
    outcome: MemoryOutcomeKind;
    namespace?: string;
    principal?: string;
    sessionKey?: string;
    timestamp?: string;
  }): Promise<RecordMemoryOutcomeResult> {
    if (request.memoryId.includes("/") || request.memoryId.includes("\\")) {
      throw new EngramAccessInputError("memoryId must not contain path separators");
    }
    const resolvedNs = this.writableNamespaceFor(request.namespace, request.sessionKey, request.principal);
    const storage = await this.orchestrator.getStorage(resolvedNs);
    // We only have the ID at the access surface, but `recordMemoryOutcome`
    // accepts a path for the benefit of ledger-driven callers that already
    // have the path in hand. Build the conventional `<id>.md` shape —
    // `memoryIdFromPath` extracts the basename so the intermediate
    // directory layout doesn't matter.
    return recordMemoryOutcome(storage, {
      memoryPath: `${request.memoryId}.md`,
      outcome: request.outcome,
      timestamp: request.timestamp,
    });
  }

  async memoryPromote(request: {
    memoryId: string;
    namespace?: string;
    principal?: string;
    sessionKey?: string;
  }): Promise<unknown> {
    const resolvedNs = this.writableNamespaceFor(request.namespace, request.sessionKey, request.principal);
    const storage = await this.orchestrator.getStorage(resolvedNs);
    // Update frontmatter to active status (promote from pending/draft)
    await storage.updateMemoryFrontmatter(request.memoryId, {
      lifecycleState: "active",
      updated: new Date().toISOString(),
    });
    return { promoted: true, memoryId: request.memoryId };
  }

  async memoryActionApply(request: {
    action: string;
    outcome?: string;
    reason?: string;
    memoryId?: string;
    namespace?: string;
    principal?: string;
    sessionKey?: string;
    content?: string;
    category?: string;
    linkTargetId?: string;
    linkType?: string;
    linkStrength?: number;
    artifactType?: string;
    execute?: boolean;
    sourcePrompt?: string;
    dryRun?: boolean;
  }): Promise<unknown> {
    return this.accessObserveWriteSurface.memoryActionApply(request);
  }

  async contextCheckpoint(request: {
    sessionKey: string;
    context: string;
    namespace?: string;
    principal?: string;
  }): Promise<{ saved: boolean }> {
    const resolvedNs = this.writableNamespaceFor(request.namespace, request.sessionKey, request.principal);
    const storage = await this.orchestrator.getStorage(resolvedNs);
    const storageDir = storage.dir;
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { join, resolve } = await import("node:path");
    // Sanitize sessionKey to prevent path traversal
    const safeKey = request.sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!safeKey) throw new EngramAccessInputError("sessionKey is required");
    const checkpointDir = join(storageDir, "checkpoints", safeKey);
    // Double-check resolved path stays inside storageDir
    const resolved = resolve(checkpointDir);
    if (!resolved.startsWith(resolve(storageDir))) {
      throw new EngramAccessInputError("Invalid sessionKey");
    }
    await mkdir(checkpointDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = join(checkpointDir, `checkpoint-${ts}.md`);
    await writeFile(filePath, request.context, "utf-8");
    return { saved: true };
  }

  async lcmStatus(): Promise<EngramAccessLcmStatusResponse> {
    if (!this.orchestrator.lcmEngine || !this.orchestrator.lcmEngine.enabled) {
      return {
        enabled: false,
        archiveAvailable: false,
      };
    }

    const stats = await this.orchestrator.lcmEngine.getStats();
    return {
      enabled: true,
      archiveAvailable: true,
      stats: {
        totalTurns: stats.totalMessages,
      },
    };
  }

  async recordCitationUsage(request: CitationUsageRequest): Promise<CitationUsageResult> {
    return recordCitationUsageForAccess(
      {
        resolveNamespace: (namespace, sessionId, authenticatedPrincipal) =>
          this.writableNamespaceFor(namespace, sessionId, authenticatedPrincipal),
        resolveNamespaceForPath: async (memoryPath, fallbackNamespace, sessionId, authenticatedPrincipal) => {
          const principal = this.resolveRequestPrincipal(sessionId, authenticatedPrincipal);
          const namespacesEnabled = resolveNamespaceCapabilities(this.orchestrator.config).namespaces;
          if (namespacesEnabled && !canReadNamespace(principal, fallbackNamespace, this.orchestrator.config)) {
            throw new EngramAccessInputError(`namespace is not readable: ${fallbackNamespace}`);
          }
          const authorizedNamespaces = namespacesEnabled
            ? Array.from(
                new Set([...citationAuthorizedNamespaces(principal, this.orchestrator.config), fallbackNamespace])
              )
            : [fallbackNamespace];
          const resolved = await this.storageForAbsoluteRecallPath(memoryPath, fallbackNamespace, authorizedNamespaces);
          if (!resolved) {
            if (nodePath.isAbsolute(memoryPath)) {
              throw new EngramAccessInputError("cited path is outside the caller's readable namespaces");
            }
            return decodeCitationNamespace(
              (ns) => this.orchestrator.getStorage(ns),
              authorizedNamespaces,
              memoryPath,
              fallbackNamespace
            );
          }
          return resolved.namespace;
        },
        getStorage: (namespace) => this.orchestrator.getStorage(namespace),
        trackMemoryAccess: (memoryIds, memoryPaths, memoryNamespaces) =>
          this.orchestrator.trackMemoryAccess(memoryIds, memoryPaths, memoryNamespaces),
      },
      request
    );
  }

  // ── Operator Console state (issue #688 PR 2/3) ────────────────────────────

  /**
   * Gather a point-in-time `ConsoleStateSnapshot` from the orchestrator.
   *
   * Principal-aware: `resolveReadableNamespace` enforces ACL before the
   * snapshot is gathered, so callers cannot read a namespace they don't
   * have read access to (CLAUDE.md rule 42).  The resolved namespace's
   * storage directory is forwarded as `config.memoryDir` so the ledger-
   * tail reader in `gatherConsoleState` scans the correct namespace root
   * rather than the global root.  Read-only — never mutates orchestrator state.
   */
  async consoleState(
    namespace?: string,
    principal?: string
  ): Promise<import("./console/state.js").ConsoleStateSnapshot> {
    // Enforce namespace ACL — throws EngramAccessInputError if unauthorized.
    const resolvedNamespace = this.resolveReadableNamespace(namespace, principal);
    // Resolve the storage dir for the namespace so the ledger-tail reader
    // scans the right directory tree.
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    const { gatherConsoleState } = await import("./console/state.js");
    // Pass a thin proxy that overrides config.memoryDir with the namespace-
    // scoped storage dir while delegating everything else to the real
    // orchestrator (buffer, qmd, extraction queue, etc. are process-global
    // and don't require further namespace scoping for a read-only snapshot).
    const orchestratorProxy = Object.create(this.orchestrator, {
      config: {
        value: { ...this.orchestrator.config, memoryDir: storage.dir },
        enumerable: true,
        configurable: true,
      },
    }) as import("./console/state.js").ConsoleStateOrchestratorLike;
    return gatherConsoleState(orchestratorProxy);
  }

  // ── Peer Registry surfaces (issue #679 PR 4/5) ────────────────────────────

  /**
   * List all registered peers. Returns the array of `Peer` objects in
   * deterministic alphabetical order (mirroring `listPeers` storage semantics).
   */
  async peerList(): Promise<{ peers: import("./peers/types.js").Peer[] }> {
    const { listPeers } = await import("./peers/index.js");
    const peers = await listPeers(this.orchestrator.config.memoryDir);
    return { peers };
  }

  /**
   * Get a single peer by id. Returns `{ found: false }` when the peer does
   * not exist rather than throwing, matching the `memoryGet` / `entityGet`
   * pattern used throughout the service.
   */
  async peerGet(peerId: string): Promise<{ found: true; peer: import("./peers/types.js").Peer } | { found: false }> {
    const peers = await import("./peers/index.js");
    const validateId: (id: unknown) => void = peers.assertValidPeerId;
    try {
      validateId(peerId);
    } catch (err) {
      throw new EngramAccessInputError((err as Error).message);
    }
    const peer = await peers.readPeer(this.orchestrator.config.memoryDir, peerId);
    if (!peer) return { found: false };
    return { found: true, peer };
  }

  /**
   * Upsert a peer. Writes `peers/{id}/identity.md`. On first write the
   * `createdAt` timestamp is set to now; on subsequent writes only
   * `displayName` and `notes` are mutated (kind and createdAt are immutable
   * once set, per the storage contract).
   *
   * Returns `{ created: true }` on first write, `{ created: false }` on update.
   */
  async peerSet(input: {
    id: string;
    kind?: string;
    displayName?: string;
    notes?: string;
  }): Promise<{ ok: true; created: boolean; peer: import("./peers/types.js").Peer }> {
    const peers = await import("./peers/index.js");
    const validateId: (id: unknown) => void = peers.assertValidPeerId;

    const { id } = input;
    try {
      validateId(id);
    } catch (err) {
      throw new EngramAccessInputError((err as Error).message);
    }

    const memoryDir = this.orchestrator.config.memoryDir;
    const now = new Date().toISOString();
    const existing = await peers.readPeer(memoryDir, id);

    const ALLOWED_KINDS = new Set(["self", "human", "agent", "integration"]);
    if (!existing) {
      // First write — require kind.
      const kind = input.kind ?? "human";
      if (!ALLOWED_KINDS.has(kind)) {
        throw new EngramAccessInputError(`peer kind must be one of ${[...ALLOWED_KINDS].join(", ")}`);
      }
      const newPeer: import("./peers/types.js").Peer = {
        id,
        kind: kind as import("./peers/types.js").PeerKind,
        displayName: input.displayName ?? id,
        createdAt: now,
        updatedAt: now,
        ...(typeof input.notes === "string" ? { notes: input.notes } : {}),
      };
      await peers.writePeer(memoryDir, newPeer);
      return { ok: true, created: true, peer: newPeer };
    }

    // Update — kind and createdAt are immutable.
    const updated: import("./peers/types.js").Peer = {
      id: existing.id,
      kind: existing.kind,
      createdAt: existing.createdAt,
      updatedAt: now,
      displayName: input.displayName !== undefined ? input.displayName : existing.displayName,
      ...(input.notes !== undefined
        ? { notes: input.notes }
        : existing.notes !== undefined
          ? { notes: existing.notes }
          : {}),
    };
    await peers.writePeer(memoryDir, updated);
    return { ok: true, created: false, peer: updated };
  }

  /**
   * Delete a peer by removing `peers/{id}/identity.md`. If the file does not
   * exist the call is a no-op (idempotent). The peer directory itself
   * (`peers/{id}/`) is intentionally left in place — profile and interaction
   * log data are not destroyed.
   */
  async peerDelete(peerId: string): Promise<{ ok: true; deleted: boolean }> {
    const peers = await import("./peers/index.js");
    const validateId: (id: unknown) => void = peers.assertValidPeerId;
    try {
      validateId(peerId);
    } catch (err) {
      throw new EngramAccessInputError((err as Error).message);
    }
    // Cursor M (PR #756 review): route through `peers.deletePeer` so
    // the unlink runs `assertPeerDirNotEscaped`, the peers-root
    // symlink check, and the parent-inode-stable / O_NOFOLLOW guards
    // shared with `readPeer`/`writePeer`. A manual `path.join` +
    // raw `fs.unlink` would let a symlinked `peers/<id>/` redirect
    // the delete to an arbitrary `identity.md` outside `memoryDir`.
    const deleted = await peers.deletePeer(this.orchestrator.config.memoryDir, peerId);
    return { ok: true, deleted };
  }

  /**
   * Destructively purge the entire peer directory for a given peerId —
   * `identity.md`, `profile.md`, `interactions.log.md`, and any other
   * files in `peers/{id}/`. Requires `confirm: "yes"` to prevent
   * accidental invocation.
   *
   * This is the DESTRUCTIVE counterpart to `peerDelete`, which only
   * removes `identity.md`. All companion files are permanently removed.
   *
   * Returns `{ ok: true, purged: true }` when the directory existed and
   * was removed; `{ ok: true, purged: false }` when the directory did
   * not exist (idempotent no-op).
   */
  async peerForget(peerId: string, opts: { confirm: string }): Promise<{ ok: true; purged: boolean }> {
    const peers = await import("./peers/index.js");
    const validateId: (id: unknown) => void = peers.assertValidPeerId;
    try {
      validateId(peerId);
    } catch (err) {
      throw new EngramAccessInputError((err as Error).message);
    }
    if (opts.confirm !== "yes") {
      throw new EngramAccessInputError("peerForget requires confirm: 'yes' to prevent accidental data loss");
    }
    const result = await peers.forgetPeer(this.orchestrator.config.memoryDir, peerId, {
      confirm: "yes",
    });
    return { ok: true, purged: result.purged };
  }

  /**
   * Get the evolving cognitive profile for a peer. Returns `{ found: false }`
   * when no profile file exists yet (profile is written by the async reasoner,
   * PR 2/5). The peer identity itself need not exist for a profile to exist,
   * but in practice the reasoner only writes profiles for registered peers.
   */
  async peerProfileGet(
    peerId: string
  ): Promise<{ found: true; profile: import("./peers/types.js").PeerProfile } | { found: false }> {
    const peers = await import("./peers/index.js");
    const validateId: (id: unknown) => void = peers.assertValidPeerId;
    try {
      validateId(peerId);
    } catch (err) {
      throw new EngramAccessInputError((err as Error).message);
    }
    const profile = await peers.readPeerProfile(this.orchestrator.config.memoryDir, peerId);
    if (!profile) return { found: false };
    return { found: true, profile };
  }

  // ── Contradiction Review (issue #520) ──────────────────────────────────────

  get memoryDir(): string {
    return this.orchestrator.config.memoryDir;
  }

  /**
   * Resolve the storage directory for a given namespace.  Used by the SSE
   * graph-event handler to subscribe to the correct per-namespace bus rather
   * than the global root (CLAUDE.md rule 42 — read/write paths must resolve
   * through the same namespace layer).
   *
   * `principal` must be the transport-bound request principal (from
   * `resolveRequestPrincipal`).  When namespaces are enabled, an absent
   * principal causes `resolveReadableNamespace` to throw an auth error,
   * matching the behaviour of every other authenticated read path.
   *
   * Falls back to `this.memoryDir` when namespaces are disabled or the
   * namespace is absent, matching the behaviour of every other read path.
   */
  async getMemoryDirForNamespace(namespace?: string, principal?: string): Promise<string> {
    const resolved = this.resolveReadableNamespace(namespace, principal);
    const storage = await this.orchestrator.getStorage(resolved);
    return storage.dir;
  }

  async getReadableStorageForNamespace(
    namespace?: string,
    principal?: string
  ): Promise<{
    namespace: string;
    storage: StorageManager;
  }> {
    const resolved = this.resolveReadableNamespace(namespace, principal);
    const storage = await this.orchestrator.getStorage(resolved);
    return { namespace: resolved, storage };
  }

  async getWritableStorageForNamespace(
    namespace?: string,
    principal?: string
  ): Promise<{
    principal: string;
    namespace: string;
    storage: StorageManager;
  }> {
    if (resolveNamespaceCapabilities(this.orchestrator.config).namespaces && !principal?.trim()) {
      throw new EngramAccessInputError("authentication required: namespaces are enabled and no principal was supplied");
    }
    const resolved = this.writableNamespaceFor(namespace, undefined, principal);
    const storage = await this.orchestrator.getStorage(resolved);
    return { principal: principal?.trim() ?? "system", namespace: resolved, storage };
  }
  get storageRef(): StorageManager {
    return this.orchestrator.storage;
  }

  // #1522: recordCatalogWrite removed — catalog touch handled at the storage chokepoint.

  get configRef(): PluginConfig {
    return this.orchestrator.config;
  }
  getStorageForResolvedNamespace(namespace: string): Promise<StorageManager> {
    return this.orchestrator.getStorage(namespace);
  }

  get localLlmRef(): LocalLlmClient | null {
    return this.orchestrator.localLlm ?? null;
  }

  get fallbackLlmRef(): FallbackLlmClient | null {
    return this.orchestrator.fastGatewayLlm ?? null;
  }

  get embeddingLookupFactoryRef(): (storage: import("./storage.js").StorageManager) => SemanticDedupLookup | undefined {
    return (storage) => {
      if (!resolveMemoryLifecycleCapabilities(this.orchestrator.config).embeddingFallback) return undefined;
      return async (content: string, limit: number) => {
        try {
          return await this.orchestrator.semanticDedupLookup(content, limit, storage);
        } catch {
          return [];
        }
      };
    };
  }

  /**
   * Import a capsule archive into the orchestrator's memory directory.
   *
   * Delegates directly to the standalone {@link importCapsuleFn} function.
   * The `root` parameter defaults to the orchestrator's `memoryDir` when
   * omitted, so callers that only have access to the service do not need to
   * thread the config value through.
   *
   * `versioning` defaults to the orchestrator's page-versioning config so
   * `mode: "overwrite"` automatically snapshots prior content without the
   * caller having to construct the config object.
   */
  async capsuleImport(
    opts: Omit<ImportCapsuleOptions, "root" | "memoryDir"> & {
      root?: string;
      memoryDir?: string;
      namespace?: string;
      principal?: string;
    }
  ): Promise<ImportCapsuleResult> {
    const { namespace, principal, root: explicitRoot, memoryDir: explicitMemoryDir, ...importOptions } = opts;
    const resolvedNamespace = this.writableNamespaceFor(namespace, undefined, principal);
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    const root = explicitRoot ?? storage.dir;
    const memoryDir = explicitMemoryDir ?? this.orchestrator.config.memoryDir;
    const versioning = importOptions.versioning ?? {
      enabled: resolveRecallAuxiliaryCapabilities(this.orchestrator.config).versioning,
      maxVersionsPerPage: this.orchestrator.config.versioningMaxPerPage,
      sidecarDir: this.orchestrator.config.versioningSidecarDir,
    };
    await this.validateCapsuleImportArchivePath(importOptions.archivePath);
    try {
      return await importCapsuleFn({ ...importOptions, root, memoryDir, versioning });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.isCapsuleImportArchiveInputError(err, message)) {
        throw new EngramAccessInputError(`capsule import failed: ${message}`);
      }
      throw err;
    }
  }

  private async validateCapsuleImportArchivePath(archivePath: string): Promise<void> {
    let archiveStat;
    try {
      archiveStat = await stat(archivePath);
    } catch (err) {
      if (!this.isCapsuleImportPathInputFsError(err)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new EngramAccessInputError(`capsule import failed: archive is not readable: ${message}`);
    }
    if (!archiveStat.isFile()) {
      throw new EngramAccessInputError("capsule import failed: archivePath must point to a file");
    }
    try {
      await nodeFs.access(archivePath, fsConstants.R_OK);
    } catch (err) {
      if (!this.isCapsuleImportPathInputFsError(err)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new EngramAccessInputError(`capsule import failed: archive is not readable: ${message}`);
    }
  }

  private isCapsuleImportPathInputFsError(err: unknown): boolean {
    const code =
      typeof err === "object" && err !== null && "code" in err ? (err as { code?: unknown }).code : undefined;
    return code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM" || code === "ELOOP";
  }

  private isCapsuleImportArchiveInputError(err: unknown, message: string): boolean {
    if (err instanceof ZodError) return true;
    const code =
      typeof err === "object" && err !== null && "code" in err ? (err as { code?: unknown }).code : undefined;
    if (typeof code === "string" && code.startsWith("Z_")) return true;
    return (
      message.startsWith("importCapsule: archive") ||
      message.startsWith("importCapsule: bundle") ||
      message.startsWith("importCapsule: manifest") ||
      message.startsWith("importCapsule: record") ||
      /incorrect header check|invalid stored block lengths|not in gzip format|unexpected end of file/i.test(message)
    );
  }

  /**
   * Export a capsule archive from the orchestrator's memory directory.
   *
   * HTTP and future MCP surfaces use this rather than calling the transfer
   * helper directly so namespace ACL checks stay consistent with the archive
   * write side effect. The exporter still owns archive construction and
   * validation.
   */
  async capsuleExport(
    opts: Omit<ExportCapsuleOptions, "root" | "memoryDir"> & {
      root?: string;
      memoryDir?: string;
      namespace?: string;
      principal?: string;
    }
  ): Promise<ExportCapsuleResult> {
    const { namespace, principal, root: explicitRoot, memoryDir: explicitMemoryDir, ...exportOptions } = opts;
    const resolvedNamespace = this.writableNamespaceFor(namespace, undefined, principal);
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    const root = explicitRoot ?? storage.dir;
    const memoryDir = explicitMemoryDir ?? this.orchestrator.config.memoryDir;
    const pluginVersion = exportOptions.pluginVersion ?? (await getPackageVersion());
    return exportCapsuleFn({
      ...exportOptions,
      pluginVersion,
      root,
      memoryDir: exportOptions.encrypt === true ? memoryDir : undefined,
    });
  }

  async capsuleList(options?: {
    namespace?: string;
    principal?: string;
  }): Promise<EngramAccessCapsuleListResponse> {
    return this.accessAdminOpsSurface.capsuleList(options);
  }

  /**
   * Operator-configured offline-sync excludes (#1786), compiled once per
   * service instance. Applied to push-side (snapshot/read) enumeration
   * only — apply-side stays permissive so remote-authoritative runtime
   * files keep flowing in.
   */
  private _offlineSyncUserExcludes: RegExp[] | null = null;

  private get offlineSyncUserExcludes(): RegExp[] {
    if (!this._offlineSyncUserExcludes) {
      this._offlineSyncUserExcludes = compileOfflineSyncExcludeGlobs(
        this.orchestrator.config.offlineSyncExcludes ?? []
      );
    }
    return this._offlineSyncUserExcludes;
  }

  async offlineSyncSnapshot(
    options: EngramAccessOfflineSyncSnapshotRequest & { signal?: AbortSignal } = {}
  ): Promise<EngramAccessOfflineSyncSnapshotResponse> {
    const resolvedNamespace = this.resolveReadableNamespace(options.namespace, options.principal);
    const storage = await offlineSyncStorageForSnapshot(this.orchestrator, resolvedNamespace);
    const storageHash = createHash("sha256").update(storage.dir).digest("hex").slice(0, 16);
    const deletions = [...(await storage.readDeletionRevisions())].map(([path, mtimeMs]) => ({ path, mtimeMs }));
    const snapshotBuilder =
      options.includeContent === false && options.baseFiles && options.baseFiles.length > 0
        ? buildOfflineSyncSnapshotFromBase
        : buildOfflineSyncSnapshot;
    const snapshot = await snapshotBuilder({
      root: storage.dir,
      sourceId: `remnic:${resolvedNamespace}:${storageHash}`,
      ...(options.baseFiles && options.baseFiles.length > 0 ? { baseFiles: options.baseFiles } : {}),
      includeContent: options.includeContent !== false,
      includeTranscripts: options.includeTranscripts !== false,
      readFile: async ({ filePath }) => storage.readOfflineSyncFile(filePath),
      readFileDigest: async ({ filePath }) => storage.digestOfflineSyncFile(filePath),
      signal: options.signal,
      userExcludeRegexps: this.offlineSyncUserExcludes,
      deletions,
      excludeFile: createSupportPassportPrivateFileExclusion(storage),
    });
    return {
      namespace: resolvedNamespace,
      ...snapshot,
    };
  }

  async offlineSyncSnapshotStream(
    options: Omit<EngramAccessOfflineSyncSnapshotRequest, "baseCapturedAt" | "baseFiles"> & {
      signal?: AbortSignal;
    } = {}
  ): Promise<EngramAccessOfflineSyncSnapshotStreamResponse> {
    const resolvedNamespace = this.resolveReadableNamespace(options.namespace, options.principal);
    const storage = await offlineSyncStorageForSnapshot(this.orchestrator, resolvedNamespace);
    const storageHash = createHash("sha256").update(storage.dir).digest("hex").slice(0, 16);
    const deletions = await filterOfflineSyncDeletionRevisions({
      root: storage.dir,
      deletions: [...(await storage.readDeletionRevisions())].map(([path, mtimeMs]) => ({ path, mtimeMs })),
      includeTranscripts: options.includeTranscripts !== false,
      userExcludeRegexps: this.offlineSyncUserExcludes,
    });
    return {
      namespace: resolvedNamespace,
      format: OFFLINE_SYNC_SNAPSHOT_FORMAT,
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      sourceId: `remnic:${resolvedNamespace}:${storageHash}`,
      includeTranscripts: options.includeTranscripts !== false,
      deletions,
      files: iterateOfflineSyncSnapshotFileRecords({
        root: storage.dir,
        includeContent: options.includeContent === true,
        includeTranscripts: options.includeTranscripts !== false,
        readFile: async ({ filePath }) => storage.readOfflineSyncFile(filePath),
        readFileDigest: async ({ filePath }) => storage.digestOfflineSyncFile(filePath),
        signal: options.signal,
        userExcludeRegexps: this.offlineSyncUserExcludes,
        excludeFile: createSupportPassportPrivateFileExclusion(storage),
      }),
    };
  }
  async offlineSyncManifestStream(
    options: EngramAccessOfflineSyncManifestRequest & { signal?: AbortSignal } = {}
  ): Promise<OfflineSyncManifestStreamResponse> {
    const namespace = this.resolveReadableNamespace(options.namespace, options.principal);
    return createOfflineSyncManifestStream(
      this.orchestrator,
      namespace,
      this.offlineSyncUserExcludes,
      options,
      parseFrontmatter
    );
  }

  async offlineSyncFiles(options: EngramAccessOfflineSyncFilesRequest): Promise<EngramAccessOfflineSyncFilesResponse> {
    const resolvedNamespace = this.resolveReadableNamespace(options.namespace, options.principal);
    const storage = await offlineSyncStorageForSnapshot(this.orchestrator, resolvedNamespace);
    const storageHash = createHash("sha256").update(storage.dir).digest("hex").slice(0, 16);
    try {
      const snapshot = await buildOfflineSyncSnapshotForPaths({
        root: storage.dir,
        sourceId: `remnic:${resolvedNamespace}:${storageHash}`,
        paths: options.paths,
        includeContent: true,
        includeTranscripts: options.includeTranscripts !== false,
        readFile: async ({ filePath }) => storage.readOfflineSyncFile(filePath),
        userExcludeRegexps: this.offlineSyncUserExcludes,
        excludeFile: createSupportPassportPrivateFileExclusion(storage),
      });
      return {
        namespace: resolvedNamespace,
        ...snapshot,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.startsWith("paths[]:") ||
        message.startsWith("buildOfflineSyncSnapshotForPaths: record path ") ||
        message.startsWith("offline sync snapshot path is excluded:")
      ) {
        throw new EngramAccessInputError(message);
      }
      throw error;
    }
  }

  async offlineSyncFileContent(
    options: EngramAccessOfflineSyncFileContentRequest
  ): Promise<EngramAccessOfflineSyncFileContentResponse> {
    const resolvedNamespace = this.resolveReadableNamespace(options.namespace, options.principal);
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    try {
      const chunk = await readOfflineSyncFileContentChunk({
        root: storage.dir,
        path: options.path,
        offset: options.offset,
        length: options.length,
        includeTranscripts: options.includeTranscripts !== false,
        readFile: async ({ filePath }) => storage.readOfflineSyncFile(filePath),
        userExcludeRegexps: this.offlineSyncUserExcludes,
        excludeFile: createSupportPassportPrivateFileExclusion(storage),
      });
      return {
        namespace: resolvedNamespace,
        ...chunk,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.startsWith("path:") ||
        message.startsWith("offset ") ||
        message.startsWith("offset must ") ||
        message.startsWith("length ") ||
        message.startsWith("offline sync file content ")
      ) {
        throw new EngramAccessInputError(message);
      }
      throw error;
    }
  }

  async offlineSyncApplyFileContent(
    options: EngramAccessOfflineSyncApplyFileContentRequest
  ): Promise<EngramAccessOfflineSyncApplyFileContentResponse> {
    const resolvedNamespace = this.writableNamespaceFor(options.namespace, undefined, options.principal);
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    try {
      const result = await applySupportPassportOfflineSyncFileContent(storage, options);
      return {
        namespace: resolvedNamespace,
        ...result,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.startsWith("offline sync") ||
        message.startsWith("path:") ||
        message.startsWith("sourceId must ") ||
        message.startsWith("sha256 must ") ||
        message.startsWith("baseSha256 must ") ||
        message.startsWith("bytes must ") ||
        message.startsWith("mtimeMs must ") ||
        message.startsWith("offset must ") ||
        message.startsWith("content chunk ") ||
        message === "content must be a Buffer"
      ) {
        throw new EngramAccessInputError(message);
      }
      throw error;
    }
  }

  async offlineSyncFinalizeConvergence(
    options: EngramAccessOfflineSyncFinalizeConvergenceRequest
  ): Promise<EngramAccessOfflineSyncFinalizeConvergenceResponse> {
    if (options.sourceId !== "remnic-converge") {
      throw new EngramAccessInputError("sourceId must be remnic-converge");
    }
    const requestedNamespaces = options.namespaces?.length ? options.namespaces : [undefined];
    const resolvedNamespaces = Array.from(
      new Set(
        requestedNamespaces.map((namespace) => this.writableNamespaceFor(namespace, undefined, options.principal))
      )
    );
    await this.orchestrator.refreshNamespacesAfterConvergence(resolvedNamespaces);
    return {
      namespaces: resolvedNamespaces,
      refreshed: true,
    };
  }

  async offlineSyncApply(options: EngramAccessOfflineSyncApplyRequest): Promise<EngramAccessOfflineSyncApplyResponse> {
    const resolvedNamespace = this.writableNamespaceFor(options.namespace, undefined, options.principal);
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    try {
      const result = await applySupportPassportOfflineSyncChangeset(storage, options);
      return {
        namespace: resolvedNamespace,
        ...result,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("offline sync")) {
        throw new EngramAccessInputError(message);
      }
      throw error;
    }
  }

  // ── Dreams pipeline telemetry surfaces (issue #678 PR 3+4) ──────────────

  /**
   * Return per-phase Dreams telemetry for the last N hours (default 24).
   */
  async dreamsStatus(options?: {
    windowHours?: number;
    namespace?: string;
    principal?: string;
  }): Promise<import("./types.js").DreamsStatusResult> {
    const { getDreamsStatus, normalizeDreamsStatusWindowHours } = await import("./maintenance/dreams-ledger.js");
    let windowHours: number;
    try {
      windowHours = normalizeDreamsStatusWindowHours(options?.windowHours);
    } catch (error) {
      throw new EngramAccessInputError(error instanceof Error ? error.message : String(error));
    }
    const resolvedNamespace = this.resolveReadableNamespace(options?.namespace, options?.principal);
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    return getDreamsStatus(storage.dir, windowHours);
  }

  async dreamsRun(options: {
    phase: import("./types.js").DreamsPhase;
    dryRun?: boolean;
    namespace?: string;
    authenticatedPrincipal?: string;
  }): Promise<import("./types.js").DreamsRunResult> {
    return this.accessAdminOpsSurface.dreamsRun(options);
  }

  // ---------------------------------------------------------------------------
  // Wearables (Limitless / Bee / Omi transcript ingestion)
  //
  // Thin delegations to the orchestrator-owned WearablesService — the
  // same instance behind the CLI, so HTTP/MCP callers observe identical
  // behavior and validation (renderer-sharing rule).
  // ---------------------------------------------------------------------------

  /**
   * Structural host bound per call so the wearables + meetings ops (issue
   * #2123) delegate to the pure surface module while the namespace/principal
   * resolvers stay private.
   */
  private get wmHost(): WearablesMeetingsHost {
    return {
      orchestrator: this.orchestrator,
      resolveReadableNamespace: this.resolveReadableNamespace.bind(this),
      writableNamespaceFor: this.writableNamespaceFor.bind(this),
      resolveRequestPrincipal: this.resolveRequestPrincipal.bind(this),
    };
  }

  async wearablesStatus(scope?: WearablesMeetingsScope): Promise<Awaited<ReturnType<WearablesService["status"]>>> {
    return wearablesMeetings.wearablesStatus(this.wmHost, scope);
  }

  async wearablesSync(
    request: { source?: string; date?: string; days?: number; forceMemories?: boolean } & WearablesMeetingsScope
  ): Promise<Awaited<ReturnType<WearablesService["sync"]>>> {
    return wearablesMeetings.wearablesSync(this.wmHost, request);
  }

  async wearablesTranscriptDay(
    request: { date: string; source?: string } & WearablesMeetingsScope
  ): Promise<Awaited<ReturnType<WearablesService["dayTranscript"]>>> {
    return wearablesMeetings.wearablesTranscriptDay(this.wmHost, request);
  }

  async wearablesTranscriptSearch(
    request: { query: string; source?: string; from?: string; to?: string; limit?: number } & WearablesMeetingsScope
  ): Promise<Awaited<ReturnType<WearablesService["searchTranscripts"]>>> {
    return wearablesMeetings.wearablesTranscriptSearch(this.wmHost, request);
  }

  async wearablesTranscriptMemories(
    request: { source?: string; date?: string; limit?: number } & WearablesMeetingsScope
  ): Promise<Awaited<ReturnType<WearablesService["transcriptMemories"]>>> {
    return wearablesMeetings.wearablesTranscriptMemories(this.wmHost, request);
  }

  // Meetings (issue #1900): thin delegations to the caller-ns MeetingsService.
  async meetingsList(date?: string, scope?: WearablesMeetingsScope): Promise<MeetingsListResult> {
    return wearablesMeetings.meetingsList(this.wmHost, date, scope);
  }

  async meetingsGet(id: string, scope?: WearablesMeetingsScope): Promise<MeetingsGetResult> {
    return wearablesMeetings.meetingsGet(this.wmHost, id, scope);
  }

  async meetingsBuild(date: string, scope?: WearablesMeetingsScope): Promise<MeetingsDayBuildSummary> {
    return wearablesMeetings.meetingsBuild(this.wmHost, date, scope);
  }

  // ── Admin console surfaces (issue #1502) ────────────────────────────────
  //
  // Thin delegators. Every method threads `this.orchestrator` references
  // into the pure `admin/admin-surfaces.ts` functions so the dashboard
  // never re-resolves scope, re-derives promotion targets, or re-lists
  // namespaces.

  /**
   * Resolve an effective scope inspection for the console. Inputs are
   * redacted before return so an operator-supplied principal preview /
   * namespace override never echoes a pasted credential back.
   */
  async adminInspectScope(options: {
    sessionKey?: string;
    namespace?: string;
    principalOverride?: string;
    operation?: InspectScopeOptions["operation"];
  }): Promise<ScopeInspection> {
    const config = this.orchestrator.config;
    // Fetch the coding context when a session is supplied; the pure
    // inspectScope helper (admin-surfaces.ts) owns the single namespace-flag
    // read for this surface and threads it through resolveScopePlan.
    const codingContext = options.sessionKey
      ? (this.orchestrator.getCodingContextForSession(options.sessionKey) ?? null)
      : null;
    const inspection = inspectScope({
      config,
      sessionKey: options.sessionKey,
      namespace: options.namespace,
      principalOverride: options.principalOverride,
      codingContext,
      operation: options.operation,
    });
    // Redact operator free-text inputs that may carry credentials. The plan
    // itself is derived from config + storage layout, not user input, so its
    // fields stay intact for diagnostics.
    return redactSensitive(inspection);
  }

  /**
   * List configured + discovered namespaces from the catalog with the
   * admin filters the console exposes.
   */
  async adminListNamespaces(filter?: AdminNamespaceFilter) {
    const result = await listAdminNamespaces({
      catalog: this.orchestrator.namespaceCatalog,
      filter,
    });
    return redactSensitive(result);
  }

  /**
   * Per-namespace maintenance + QMD health. QMD diagnostics are probed via
   * the orchestrator's search health accessor (one probe per namespace).
   */
  async adminMaintenanceHealth() {
    const report = await gatherMaintenanceHealth({
      catalog: this.orchestrator.namespaceCatalog,
      qmdHealthProvider: async (namespace): Promise<AdminNamespaceQmdHealth | null> => {
        try {
          const health = await this.orchestrator.searchHealthForNamespace(namespace);
          return {
            namespace,
            collection: health.collection,
            available: health.available,
            collectionState: health.collectionState,
            debugStatus: health.debugStatus,
            installedVersion: health.installedVersion,
            supportedVersion: health.supportedVersion,
            supported: health.supported,
            upgradeAvailable: health.upgradeAvailable,
            daemonMode: health.daemonMode,
          };
        } catch (err) {
          // The report marks the namespace degraded and records the reason;
          // a probe failure must not abort the whole report.
          throw err;
        }
      },
    });
    return redactSensitive(report);
  }

  /**
   * Dry-run transcript/session audit. Detects mixed `other/default` data
   * and legacy stranded directories. Never applies a migration.
   */
  async adminTranscriptAudit() {
    const result = await auditTranscripts(this.orchestrator.config.memoryDir);
    return redactSensitive(result);
  }

  async adminPromoteMemory(request: {
    sourceMemoryId: string;
    namespace?: string;
    principal?: string;
    sessionKey?: string;
    targets: ReadonlyArray<{ kind: MemoryPromotionTargetKind; namespace?: string }>;
    reason: string;
    actor?: never; // ignored — actor is derived from the authenticated principal
  }) {
    return this.accessAdminOpsSurface.adminPromoteMemory(request);
  }

  async reviewDeckList(opts: Parameters<ReviewDeckSurface["list"]>[0]) {
    return this.reviewDeckSurface.list(opts);
  }

  async reviewDeckAction(...args: Parameters<ReviewDeckSurface["action"]>) {
    return this.reviewDeckSurface.action(...args);
  }

  async reviewDeckUndo(...args: Parameters<ReviewDeckSurface["undo"]>) {
    return this.reviewDeckSurface.undo(...args);
  }
}
