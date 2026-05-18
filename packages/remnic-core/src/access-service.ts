import { stat } from "node:fs/promises";
import * as nodeFs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { ZodError } from "zod";
import { AccessIdempotencyStore, hashAccessIdempotencyPayload } from "./access-idempotency.js";
import { AccessAuditAdapter, type AccessAuditConfig, type AccessAuditResult } from "./access-audit.js";
import type { AnomalyDetectorResult } from "./recall-audit-anomaly.js";
import { resolveGitContext } from "./coding/git-context.js";
import { WorkStorage } from "./work/storage.js";
import {
  exportWorkBoardMarkdown,
  exportWorkBoardSnapshot,
  importWorkBoardSnapshot,
} from "./work/board.js";
import { wrapWorkLayerContext } from "./work/boundary.js";
import {
  persistExplicitCapture,
  queueExplicitCaptureForReview,
  validateExplicitCaptureInput,
  type ExplicitCaptureInput,
  type ValidExplicitCapture,
} from "./explicit-capture.js";
import { CrossNamespaceBudget, type BudgetDecision } from "./cross-namespace-budget.js";
import { log } from "./logger.js";
import {
  buildQualityScore,
  buildProposedActions,
  groupActionsByStatus,
  listMemoryGovernanceRuns,
  readMemoryGovernanceRunArtifact,
  runMemoryGovernance,
} from "./maintenance/memory-governance.js";
import { runProcedureMining } from "./procedural/procedure-miner.js";
import type { PatternReinforcementResult } from "./maintenance/pattern-reinforcement.js";
import type { LiveConnectorsRunSummary } from "./live-connectors-runner.js";
import {
  computeProcedureStats,
  type ProcedureStatsReport,
} from "./procedural/procedure-stats.js";
import {
  normalizeProjectionPreview,
  normalizeProjectionTags,
} from "./memory-projection-format.js";
import {
  inferMemoryStatus,
  toMemoryPathRel,
} from "./memory-lifecycle-ledger-utils.js";
import { getMemoryProjectionPath } from "./memory-projection-store.js";
import { canReadNamespace, canWriteNamespace, defaultNamespaceForPrincipal, recallNamespacesForPrincipal, resolvePrincipal } from "./namespaces/principal.js";
import type { LastRecallSnapshot } from "./recall-state.js";
import type {
  GraphRecallSnapshot,
  IntentDebugSnapshot,
  Orchestrator,
  RecallInvocationOptions,
} from "./orchestrator.js";
import { parseEntityFile, StorageManager } from "./storage.js";
import {
  buildGraphSnapshot,
  type GraphSnapshotRequest,
  type GraphSnapshotResponse,
  type GraphSnapshotNodeMetadata,
} from "./graph-snapshot.js";
import * as nodePath from "node:path";
import {
  buildBriefing,
  FileCalendarSource,
  parseBriefingFocus,
  parseBriefingWindow,
} from "./briefing.js";
import {
  getTrustZoneStoreStatus,
  isTrustZoneName,
  listTrustZoneRecords,
  promoteTrustZoneRecord,
  scoreTrustZoneProvenance,
  seedTrustZoneDemoDataset,
  summarizeTrustZonePromotionReadiness,
  type TrustZoneDemoSeedResult,
  type TrustZoneName,
  type TrustZonePromotionResult,
  type TrustZoneProvenanceScore,
  type TrustZoneRecord,
  type TrustZoneRecordKind,
  type TrustZoneSourceClass,
  type TrustZoneStoreStatus,
} from "./trust-zones.js";
import type {
  EntityFile,
  MemoryFile,
  MemoryActionOutcome,
  MemoryActionType,
  MemoryLifecycleEvent,
  MemoryStatus,
  PluginConfig,
  RecallDisclosure,
  RecallPlanMode,
} from "./types.js";
import { DEFAULT_RECALL_DISCLOSURE, isRecallDisclosure } from "./types.js";
import { estimateRecallTokens, type RecallXraySnapshot } from "./recall-xray.js";
import type {
  LcmMessagePartInput,
  MessagePartSourceFormat,
} from "./message-parts/index.js";
import {
  applyTagFilter,
  normalizeTags,
  parseTagMatch,
  type TagMatchMode,
} from "./recall-tag-filter.js";
import { decideDisclosureEscalation } from "./recall-disclosure-escalation.js";
import type { LocalLlmClient } from "./local-llm.js";
import type { FallbackLlmClient } from "./fallback-llm.js";
import type { SemanticDedupLookup } from "./dedup/semantic.js";
import { toRecallExplainJson } from "./recall-explain-renderer.js";
import {
  recordMemoryOutcome,
  type MemoryOutcomeKind,
  type RecordMemoryOutcomeResult,
} from "./memory-worth-outcomes.js";
import { objectiveStateStoreOverrideForNamespace } from "./objective-state.js";
import { recordObjectiveStateSnapshotsFromObservedMessages } from "./objective-state-writers.js";
import {
  importCapsule as importCapsuleFn,
  type ImportCapsuleOptions,
  type ImportCapsuleResult,
} from "./transfer/capsule-import.js";
import {
  exportCapsule as exportCapsuleFn,
  type ExportCapsuleOptions,
  type ExportCapsuleResult,
} from "./transfer/capsule-export.js";
import {
  defaultCapsulesDir,
  type CapsuleListEntry,
} from "./capsule-cli.js";
import {
  evaluateActionConfidence,
  type ActionConfidenceInput,
  type ActionConfidenceResult,
} from "./action-confidence.js";
import { formatProfileTraceAscii } from "./profiling.js";

export class EngramAccessInputError extends Error {}

type AccessProfilingReportRequest = {
  format?: string;
  limit?: number;
};

type AccessProfilingReportResponse = {
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
    cachedPackageVersion = typeof parsed.version === "string" && parsed.version.length > 0
      ? parsed.version
      : "unknown";
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

export interface EngramAccessHealthResponse {
  ok: true;
  memoryDir: string;
  namespacesEnabled: boolean;
  defaultNamespace: string;
  searchBackend: string;
  qmdEnabled: boolean;
  nativeKnowledgeEnabled: boolean;
  projectionAvailable: boolean;
}

export interface EngramAccessRecallRequest {
  query: string;
  sessionKey?: string;
  namespace?: string;
  authenticatedPrincipal?: string;
  topK?: number;
  mode?: RecallPlanMode | "auto";
  includeDebug?: boolean;
  /**
   * Recall disclosure depth (issue #677).  Selects how much content each
   * result returns: `"chunk"` (default), `"section"`, or `"raw"`.  Omitting
   * this field is equivalent to passing `"chunk"` and preserves pre-#677
   * behavior.  Surfaces (CLI / HTTP / MCP) and per-level token telemetry
   * are wired in subsequent PRs of #677.
   */
  disclosure?: RecallDisclosure;
  /**
   * Coding-agent context (issue #569). When a connector resolves a git
   * context for the session's cwd, it passes it here and the access service
   * attaches it to the orchestrator before recall so project- / branch-
   * scoped namespace overlays apply.
   *
   * Keyed by `sessionKey`; ignored when `sessionKey` is absent.
   */
  codingContext?: {
    projectId: string;
    branch: string | null;
    rootPath: string;
    defaultBranch: string | null;
  } | null;
  /**
   * Working directory of the calling agent session. When provided and no
   * `codingContext` is already attached to the session, the service resolves
   * git context from this path and attaches it automatically. This enables
   * Claude Code hooks (and any connector that knows its cwd) to get
   * project-scoped memory without explicitly constructing a `codingContext`.
   */
  cwd?: string;
  /**
   * Arbitrary project tag for non-git-based project scoping. When provided,
   * creates a `CodingContext` with `projectId: "tag:<projectTag>"`.
   * Useful for OpenClaw sessions where the whole workspace is one git repo
   * but different conversations correspond to different client projects.
   * Takes precedence over `cwd`-based git resolution but NOT over an
   * explicit `codingContext`.
   */
  projectTag?: string;
  /**
   * Historical recall pin (issue #680).  ISO 8601 timestamp.  When set,
   * the orchestrator filters out memories whose `valid_at` is after this
   * instant OR whose `invalid_at` is at-or-before this instant, so the
   * caller sees the corpus as it existed at `asOf`.  Invalid values are
   * rejected here with `EngramAccessInputError` (CLAUDE.md rule 51).
   */
  asOf?: string;
  /**
   * Free-form recall tag filter (issue #689). When non-empty, recall results
   * whose frontmatter `tags` do not match are removed from the response.
   * Comparison is case-sensitive exact match against tags stored on each
   * memory's frontmatter (see `storage.ts` and `docs/tags.md`).
   */
  tags?: string[];
  /**
   * Match mode for `tags` (issue #689). `"any"` (default when omitted)
   * admits results that carry at least one filter tag. `"all"` requires
   * every filter tag to be present. Ignored when `tags` is absent or empty.
   */
  tagMatch?: "any" | "all";
  /**
   * Issue #681 — when `true`, bypasses the configured
   * `graphTraversalConfidenceFloor` for this recall and includes graph edges
   * below the floor in traversal.  Useful for diagnostic queries that need to
   * surface results pruned by confidence decay.  Default `false`.
   */
  includeLowConfidence?: boolean;
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
  budgetWarning?: BudgetDecision;
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
}

/** Inputs accepted by the `remnic_briefing` MCP tool. */
export interface EngramAccessBriefingRequest {
  since?: string;
  focus?: string;
  namespace?: string;
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

export type EngramAccessActionConfidenceRequest = ActionConfidenceInput;
export type EngramAccessActionConfidenceResponse = ActionConfidenceResult;

async function buildProjectedGovernanceProposedActions(
  storage: Awaited<ReturnType<Orchestrator["getStorage"]>>,
  projected: NonNullable<Awaited<ReturnType<Awaited<ReturnType<Orchestrator["getStorage"]>>["getProjectedGovernanceRecord"]>>>,
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
  const memories = (await Promise.all(projected.reviewQueueRows.map((row) => storage.getMemoryById(row.memoryId))))
    .filter((memory): memory is MemoryFile => Boolean(memory));
  return buildProposedActions(reviewQueue, memories);
}

function hasGroupedGovernanceActions(
  grouped?: Awaited<ReturnType<typeof readMemoryGovernanceRunArtifact>>["transitionReport"]["proposed"],
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
  /**
   * Trusted transport-bound principal. This must never come from untrusted client payloads.
   * When present, write authorization is evaluated against this principal instead of sessionKey.
   */
  authenticatedPrincipal?: string;
}

export interface EngramAccessMemoryStoreRequest extends EngramAccessWriteEnvelope, ExplicitCaptureInput {}

export interface EngramAccessSuggestionSubmitRequest extends EngramAccessWriteEnvelope, ExplicitCaptureInput {}

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
}

export interface EngramAccessObserveMessage {
  role: "user" | "assistant";
  content: string;
  parts?: LcmMessagePartInput[];
  rawContent?: unknown;
  sourceFormat?: MessagePartSourceFormat;
}

export interface EngramAccessObserveRequest {
  sessionKey: string;
  messages: EngramAccessObserveMessage[];
  namespace?: string;
  authenticatedPrincipal?: string;
  skipExtraction?: boolean;
  /**
   * Working directory of the calling agent session (issue #569 wiring).
   * When provided and no `codingContext` is attached for this session,
   * resolves git context from the path and attaches it so writes route to
   * the correct project namespace.
   */
  cwd?: string;
  /**
   * Arbitrary project tag for non-git-based project scoping (issue #569).
   * Creates a `CodingContext` with `projectId: "tag:<projectTag>"`.
   */
  projectTag?: string;
}

export interface EngramAccessObserveResponse {
  accepted: number;
  sessionKey: string;
  namespace: string;
  lcmArchived: boolean;
  extractionQueued: boolean;
}

export interface EngramAccessLcmSearchRequest {
  query: string;
  sessionKey?: string;
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

export interface EngramAccessLcmCompactionFlushRequest {
  sessionKey: string;
  namespace?: string;
  authenticatedPrincipal?: string;
}

export interface EngramAccessLcmCompactionFlushResponse {
  enabled: boolean;
  flushed: boolean;
  sessionKey: string;
  namespace: string;
  reason?: string;
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
  sort?: EngramAccessMemoryBrowseRequest["sort"],
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
  promotionEnabled: boolean,
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
  right: MemoryFile,
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
  rawExcerpts?: EngramAccessMemorySummary["rawExcerpts"],
): EngramAccessMemorySummary {
  const includeFullContent =
    disclosure === "section" || disclosure === "raw";
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
    ...(disclosure === "raw" && rawExcerpts !== undefined
      ? { rawExcerpts }
      : {}),
  };
}

export class EngramAccessService {
  private readonly idempotency: AccessIdempotencyStore;
  private readonly idempotencyLocks = new Map<string, Promise<void>>();
  private readonly budget: CrossNamespaceBudget;
  private readonly auditAdapter: AccessAuditAdapter | null;

  constructor(private readonly orchestrator: Orchestrator) {
    this.idempotency = new AccessIdempotencyStore(orchestrator.config.memoryDir);
    this.budget = new CrossNamespaceBudget({
      enabled: orchestrator.config.recallCrossNamespaceBudgetEnabled,
      windowMs: orchestrator.config.recallCrossNamespaceBudgetWindowMs,
      softLimit: orchestrator.config.recallCrossNamespaceBudgetSoftLimit,
      hardLimit: orchestrator.config.recallCrossNamespaceBudgetHardLimit,
    });

    const auditEnabled = orchestrator.config.recallAuditAnomalyDetectionEnabled === true;
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

  get briefingEnabled(): boolean {
    return this.orchestrator.config.briefing?.enabled === true;
  }

  private resolveNamespace(namespace?: string): string {
    const requested = namespace?.trim();
    if (!requested) return this.orchestrator.config.defaultNamespace;
    if (!this.orchestrator.config.namespacesEnabled && requested !== this.orchestrator.config.defaultNamespace) {
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
    authenticatedPrincipal?: string,
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

  private resolveRequestPrincipal(sessionKey: string | undefined, authenticatedPrincipal?: string): string {
    const trusted = authenticatedPrincipal?.trim();
    if (trusted) return trusted;
    return resolvePrincipal(sessionKey, this.orchestrator.config);
  }

  private resolveWritableNamespace(
    namespace: string | undefined,
    sessionKey: string | undefined,
    authenticatedPrincipal?: string,
  ): string {
    const resolved = this.resolveNamespace(namespace);
    const principal = this.resolveRequestPrincipal(sessionKey, authenticatedPrincipal);
    if (!canWriteNamespace(principal, resolved, this.orchestrator.config)) {
      throw new EngramAccessInputError(`namespace is not writable: ${resolved}`);
    }
    return resolved;
  }

  private async objectiveStateStoreLocationForNamespace(namespace: string): Promise<{
    memoryDir: string;
    objectiveStateStoreDir?: string;
  }> {
    if (!this.orchestrator.config.namespacesEnabled) {
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
        namespacesEnabled: this.orchestrator.config.namespacesEnabled,
        namespace,
      }),
    };
  }

  private resolveReadableNamespace(namespace: string | undefined, principal?: string): string {
    const resolved = this.resolveNamespace(namespace);
    const namespacesEnabled = this.orchestrator.config.namespacesEnabled;

    if (!namespacesEnabled) {
      // Namespaces are disabled globally — no ACL needed for any caller.
      return resolved;
    }

    // Namespaces are enabled.  An absent principal means the caller is
    // unauthenticated.  Unauthenticated callers must NOT be allowed to read
    // arbitrary namespaces: that would bypass all readPrincipals policies.
    if (!principal) {
      throw new EngramAccessInputError(
        "authentication required: namespaces are enabled and no principal was supplied",
      );
    }

    // Authenticated caller — enforce the namespace ACL as normal.
    if (!canReadNamespace(principal, resolved, this.orchestrator.config)) {
      throw new EngramAccessInputError(`namespace is not readable: ${resolved}`);
    }
    return resolved;
  }

  private async buildRecallDebug(
    snapshot: LastRecallSnapshot | null,
    namespace: string,
    includeDebug: boolean,
    sessionKey?: string,
  ): Promise<EngramAccessRecallResponse["debug"] | undefined> {
    if (!includeDebug) return undefined;
    if (!sessionKey?.trim()) return undefined;
    const [intent, graph] = await Promise.all([
      this.orchestrator.getLastIntentSnapshot(namespace),
      this.orchestrator.getLastGraphRecallSnapshot(namespace),
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
  }): Promise<EngramAccessRecallResponse> {
    const memoryIds = options.snapshot.results.map((result) => result.memoryId);
    const resultPaths = options.snapshot.results.map((result) => result.path);
    const namespace = options.snapshot.namespace
      ? this.resolveNamespace(options.snapshot.namespace)
      : this.orchestrator.config.defaultNamespace;
    const sourcesUsed = Array.from(
      new Set(options.snapshot.results.map((result) => result.servedBy)),
    );
    const snapshotForSerialization: LastRecallSnapshot = {
      sessionKey: options.sessionKey ?? "",
      recordedAt: new Date(options.snapshot.capturedAt).toISOString(),
      queryHash: createHash("sha256").update(options.query).digest("hex"),
      queryLen: options.query.length,
      memoryIds,
      namespace,
      traceId: options.snapshot.traceId,
      plannerMode: options.normalizedMode,
      requestedMode:
        options.requestedMode && options.requestedMode !== "auto"
          ? options.requestedMode
          : undefined,
      sourcesUsed,
      budgetsApplied: {
        appliedTopK: memoryIds.length,
        recallBudgetChars: options.snapshot.budget.chars,
        maxMemoryTokens: this.orchestrator.config.maxMemoryTokens,
        finalContextChars: options.snapshot.budget.used,
      },
      latencyMs: Date.now() - options.startedAt,
      resultPaths,
    };
    const results = await this.serializeRecallResults(
      snapshotForSerialization,
      options.disclosure,
      {
        query: options.query,
        ...(options.sessionKey ? { sessionKey: options.sessionKey } : {}),
      },
    );
    const context = results
      .map((result) => {
        const content =
          typeof result.content === "string" && result.content.length > 0
            ? result.content
            : "";
        return content || result.preview;
      })
      .filter((text) => text.length > 0)
      .join("\n\n");

    return {
      query: options.query,
      ...(options.sessionKey ? { sessionKey: options.sessionKey } : {}),
      namespace,
      context,
      count: memoryIds.length,
      memoryIds,
      results,
      recordedAt: snapshotForSerialization.recordedAt,
      traceId: options.snapshot.traceId,
      plannerMode: options.normalizedMode,
      fallbackUsed: sourcesUsed.some((source) => source !== "hybrid"),
      sourcesUsed,
      disclosure: options.disclosure,
      budgetsApplied: snapshotForSerialization.budgetsApplied,
      latencyMs: snapshotForSerialization.latencyMs,
    };
  }

  private async serializeRecallResults(
    snapshot: LastRecallSnapshot | null,
    disclosure: RecallDisclosure,
    rawContext: { query: string; sessionKey?: string } | null = null,
  ): Promise<EngramAccessMemorySummary[]> {
    if (!snapshot) return [];
    const namespace = snapshot.namespace ? this.resolveNamespace(snapshot.namespace) : this.orchestrator.config.defaultNamespace;
    const storage = await this.orchestrator.getStorage(namespace);
    const storageDir = storage.dir;
    const results: EngramAccessMemorySummary[] = [];
    const seen = new Set<string>();

    // Pre-fetch raw excerpts once when `disclosure === "raw"` so we don't
    // hit the LCM archive per-result (issue #677 PR 2/4).  Excerpts are
    // attached to the first result; per-result attribution is reserved
    // for a future PR if/when the LCM index can be joined to memory ids.
    // Coerce `null` (non-raw disclosure) to `undefined` so the optional
    // serializer field is never explicitly `null`.
    // Pass the resolved namespace so the LCM lookup can mirror the
    // `${namespace}:${sessionKey}` prefix that `observe()` writes.
    const rawExcerptsResult = await this.fetchRawExcerpts(
      disclosure,
      rawContext ? { ...rawContext, namespace } : null,
    );
    const rawExcerpts = rawExcerptsResult ?? undefined;

    for (const memoryPath of snapshot.resultPaths ?? []) {
      if (!memoryPath || seen.has(memoryPath)) continue;
      const memory = await storage.readMemoryByPath(memoryPath);
      if (!memory) continue;
      seen.add(memoryPath);
      results.push(
        this.serializeMemorySummary(
          memory,
          storageDir,
          disclosure,
          // Attach the (possibly empty) raw excerpts to the first raw
          // result; subsequent results do not duplicate the array.
          results.length === 0 ? rawExcerpts : undefined,
        ),
      );
    }

    if (results.length > 0) return results;

    for (const memoryId of snapshot.memoryIds) {
      const memory = await storage.getMemoryById(memoryId);
      if (!memory || seen.has(memory.path)) continue;
      seen.add(memory.path);
      results.push(
        this.serializeMemorySummary(
          memory,
          storageDir,
          disclosure,
          results.length === 0 ? rawExcerpts : undefined,
        ),
      );
    }
    return results;
  }

  /**
   * Fetch raw transcript excerpts from the LCM archive for `disclosure ===
   * "raw"` recalls (issue #677 PR 2/4).  Returns `null` for non-raw recall
   * depths, an empty array when LCM is disabled / not initialized / has no
   * matches, and an array of LCM-side excerpts otherwise.  Errors are
   * swallowed and treated as "no excerpts" so a failing LCM never breaks
   * the recall response.
   *
   * Namespace handling: LCM archival prefixes non-default-namespace
   * sessions with `${namespace}:${sessionKey}` (see `observe()` around
   * line 2498), so the lookup must mirror that prefix or raw recalls in
   * non-default namespaces miss their own excerpts.
   */
  private async fetchRawExcerpts(
    disclosure: RecallDisclosure,
    context: { query: string; sessionKey?: string; namespace?: string } | null,
  ): Promise<EngramAccessMemorySummary["rawExcerpts"] | null> {
    if (disclosure !== "raw") return null;
    if (!context || !context.query) return [];
    // Privacy guard: raw disclosure must be session-scoped.  Without a
    // sessionKey, `lcm.searchContextFull(query, n, undefined)` searches
    // across every archived session in the LCM store and would return
    // excerpts from unrelated sessions (potentially crossing namespaces
    // via their `${namespace}:${sessionKey}` prefix encoding).  Treat a
    // missing sessionKey as "no excerpts" — callers asking for raw
    // disclosure outside a session get an empty list, not a leak.
    if (!context.sessionKey) return [];
    const lcm = this.orchestrator.lcmEngine;
    if (!lcm || !lcm.enabled) return [];
    try {
      const lcmSessionKey =
        context.namespace &&
        context.namespace !== this.orchestrator.config.defaultNamespace
          ? `${context.namespace}:${context.sessionKey}`
          : context.sessionKey;
      const rows = await lcm.searchContextFull(
        context.query,
        // Cap the excerpt fanout so recall responses stay bounded.  Five
        // matches is enough to anchor the model in the raw transcript
        // without ballooning token spend; raw is meant as the escape
        // hatch, not the default.
        5,
        lcmSessionKey,
      );
      return rows.map((r) => ({
        turnIndex: r.turn_index,
        role: r.role,
        content: r.content,
        sessionId: r.session_id,
      }));
    } catch {
      // CLAUDE.md rule 13: never let an external subsystem (LCM/SQLite)
      // crash the primary recall flow.
      return [];
    }
  }

  private async handleIdempotentWrite<T extends EngramAccessWriteResponse>(options: {
    operation: T["operation"];
    idempotencyKey?: string;
    requestFingerprint: unknown;
    skip?: boolean;
    execute: () => Promise<T>;
  }): Promise<T> {
    if (options.skip === true) {
      return options.execute();
    }
    const key = options.idempotencyKey?.trim();
    if (!key) {
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
        const response = await options.execute();
        await this.idempotency.put(key, requestHash, response);
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
    const queued = previous.then(() => current, () => current);
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
      namespacesEnabled: this.orchestrator.config.namespacesEnabled === true,
      defaultNamespace: this.orchestrator.config.defaultNamespace,
      searchBackend: this.orchestrator.config.searchBackend ?? "qmd",
      qmdEnabled: this.orchestrator.config.qmdEnabled === true,
      nativeKnowledgeEnabled: this.orchestrator.config.nativeKnowledge?.enabled === true,
      projectionAvailable,
    };
  }

  async actionConfidence(
    request: EngramAccessActionConfidenceRequest = {},
  ): Promise<EngramAccessActionConfidenceResponse> {
    return evaluateActionConfidence(request);
  }

  async daySummary(
    request: EngramAccessDaySummaryRequest,
  ): Promise<import("./types.js").DaySummaryResult | null> {
    if (!this.orchestrator.config.daySummaryEnabled) {
      throw new EngramAccessInputError("day summary is disabled");
    }

    const memories = (request.memories ?? "").trim();
    const namespace = this.resolveRecallNamespace(request.namespace, request.sessionKey);

    if (memories.length === 0) {
      // Auto-gather today's facts from the resolved namespace
      return this.orchestrator.generateDaySummaryAuto(namespace);
    }
    return this.orchestrator.generateDaySummary(memories);
  }

  /**
   * Build a daily context briefing. Gracefully degrades when the OpenAI key
   * or Responses API is unavailable — never throws for LLM-related problems.
   */
  async briefing(
    request: EngramAccessBriefingRequest,
  ): Promise<EngramAccessBriefingResponse> {
    const config = this.orchestrator.config;
    if (!config.briefing.enabled) {
      throw new EngramAccessInputError("briefing is disabled");
    }

    const namespace = this.resolveReadableNamespace(request.namespace, request.principal);
    const storage = await this.orchestrator.getStorage(namespace);

    const token = typeof request.since === "string" && request.since.trim().length > 0
      ? request.since.trim()
      : config.briefing.defaultWindow;
    const window = parseBriefingWindow(token);
    if (!window) {
      throw new EngramAccessInputError(`invalid briefing window: ${token}`);
    }

    // Validate focus: only treat undefined / empty strings as "no filter".
    // Anything else that parses to null (e.g. "project:", "topic:") is malformed
    // and must be rejected so a templating miss never silently broadens the
    // briefing from a targeted project view to all memories.
    const rawFocus = typeof request.focus === "string" ? request.focus.trim() : "";
    let focus = null;
    if (rawFocus.length > 0) {
      focus = parseBriefingFocus(rawFocus);
      if (!focus) {
        throw new EngramAccessInputError(
          `invalid briefing focus filter: ${request.focus}`,
        );
      }
    }

    // Reject unsupported format values explicitly.  Programmatic callers that
    // bypass CLI/MCP pre-validation (which already use validateBriefingFormat)
    // could otherwise send a typo like "jsno" and silently receive a response
    // in the default format, masking the client bug and breaking format-dependent
    // automation.  Only undefined / absent format falls through to the default.
    const SUPPORTED_FORMATS = ["markdown", "json"] as const;
    if (
      typeof request.format === "string" &&
      !(SUPPORTED_FORMATS as readonly string[]).includes(request.format)
    ) {
      throw new EngramAccessInputError(
        `unsupported briefing format: "${request.format}". Accepted: ${SUPPORTED_FORMATS.join(", ")}.`,
      );
    }
    const format: "markdown" | "json" = request.format === "json"
      ? "json"
      : request.format === "markdown"
        ? "markdown"
        : config.briefing.defaultFormat;

    const maxFollowups = typeof request.maxFollowups === "number" && Number.isFinite(request.maxFollowups)
      ? Math.max(0, Math.min(10, Math.floor(request.maxFollowups)))
      : config.briefing.maxFollowups;

    const calendarSource = config.briefing.calendarSource
      ? new FileCalendarSource(config.briefing.calendarSource)
      : undefined;

    const result = await buildBriefing({
      storage,
      namespace,
      window,
      focus,
      calendarSource,
      maxFollowups,
      allowLlm: config.briefing.llmFollowups,
      openaiApiKey: config.openaiApiKey,
      openaiBaseUrl: config.openaiBaseUrl,
      model: config.model,
    });

    return {
      format,
      window: result.window,
      namespace,
      markdown: result.markdown,
      json: result.json,
      followupsUnavailableReason: result.followupsUnavailableReason,
    };
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
    options: { cwd?: string; projectTag?: string },
  ): Promise<void> {
    if (!sessionKey) return;
    // Respect the configuration gate (CLAUDE.md #30).
    if (!this.orchestrator.config.codingMode?.projectScope) return;
    // Don't overwrite an already-attached context.
    if (this.orchestrator.getCodingContextForSession(sessionKey)) return;
    // projectTag takes priority over cwd.
    if (typeof options.projectTag === "string" && options.projectTag.trim().length > 0) {
      const tag = options.projectTag.trim();
      this.orchestrator.setCodingContextForSession(sessionKey, {
        projectId: `tag:${tag}`,
        branch: null,
        rootPath: `tag:${tag}`,
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

  async recall(request: EngramAccessRecallRequest): Promise<EngramAccessRecallResponse> {
    const query = request.query.trim();
    if (query.length === 0) {
      throw new EngramAccessInputError("query is required");
    }
    // Disclosure depth (issue #677).  Default to `"chunk"` when omitted so
    // pre-#677 callers see unchanged behavior.  Reject explicitly invalid
    // string values per CLAUDE.md rule 51 (do not silently fall back).
    const callerProvidedDisclosure =
      request.disclosure !== undefined && request.disclosure !== null;
    const requestedDisclosure: RecallDisclosure = (() => {
      if (!callerProvidedDisclosure) {
        return DEFAULT_RECALL_DISCLOSURE;
      }
      if (!isRecallDisclosure(request.disclosure)) {
        throw new EngramAccessInputError(
          `disclosure must be one of: chunk, section, raw (got: ${String(request.disclosure)})`,
        );
      }
      return request.disclosure;
    })();
    // Attach any coding context shipped with the recall request BEFORE
    // namespace resolution so the overlay applies to this recall (issue #569).
    if (request.codingContext !== undefined && request.sessionKey) {
      this.setCodingContext({
        sessionKey: request.sessionKey,
        codingContext: request.codingContext,
      });
    }
    // Auto-resolve coding context from cwd/projectTag when no explicit
    // codingContext was supplied (issue #569 wiring). This allows Claude
    // Code hooks and OpenClaw connectors to get project-scoped memory
    // transparently.
    if (request.codingContext === undefined && request.sessionKey) {
      await this.maybeAttachCodingContext(request.sessionKey, {
        cwd: request.cwd,
        projectTag: request.projectTag,
      });
    }
    const authenticatedPrincipal = request.authenticatedPrincipal?.trim();
    const namespaceOverride = this.resolveRecallNamespace(
      request.namespace,
      request.sessionKey,
      authenticatedPrincipal,
    );
    const namespace = namespaceOverride ?? this.orchestrator.config.defaultNamespace;
    // Normalize mode early so that no_recall / invalid modes skip budget
    // accounting (Codex P1: budget recorded before mode validation).
    const mode = this.normalizeRecallMode(request.mode);
    const principal = this.resolveRequestPrincipal(request.sessionKey, authenticatedPrincipal);
    const principalNamespace = defaultNamespaceForPrincipal(principal, this.orchestrator.config);
    // Skip budget checks for modes that never perform a cross-namespace read.
    const modeSkipsBudget = mode === "no_recall";
    // Derive the full set of namespaces the orchestrator will actually search.
    // When no explicit override is provided, `recallNamespacesForPrincipal()` may
    // expand to shared / policy-default namespaces.  Budget must be checked
    // against every cross-namespace entry in the effective set so that omitting
    // `namespace` cannot bypass the limiter (Cursor/Codex review feedback).
    //
    // NOTE: coding overlays (branch/project scope) are resolved inside
    // orchestrator.recall() AFTER this check.  The access-service does not
    // duplicate that resolution here to avoid tight coupling.  Coding-overlay
    // namespaces are a second-layer defense covered by the anomaly detector
    // (PR 5/5 of issue #565).
    const effectiveNamespaces = namespaceOverride
      ? [namespaceOverride]
      : recallNamespacesForPrincipal(principal, this.orchestrator.config);
    let budgetDecision: BudgetDecision;
    if (modeSkipsBudget) {
      budgetDecision = {
        allowed: true as const,
        reason: "allowed-same-namespace" as const,
        count: 0,
        limit: {
          softLimit: this.orchestrator.config.recallCrossNamespaceBudgetSoftLimit ?? 10,
          hardLimit: this.orchestrator.config.recallCrossNamespaceBudgetHardLimit ?? 30,
          windowMs: this.orchestrator.config.recallCrossNamespaceBudgetWindowMs ?? 60_000,
        },
      };
    } else {
      // Peek at every effective namespace to determine whether ANY would be
      // cross-namespace WITHOUT recording side effects (Cursor review:
      // multi-count bug).  Record a single budget event only when at least
      // one effective namespace differs from the principal's self namespace.
      let anyCrossNamespace = false;
      let denied: BudgetDecision | null = null;
      for (const ns of effectiveNamespaces) {
        const peek = this.budget.peek({
          principal,
          principalNamespace,
          queryNamespace: ns,
        });
        if (peek.reason !== "allowed-same-namespace") {
          anyCrossNamespace = true;
        }
        if (!peek.allowed) {
          denied = peek;
          break;
        }
      }
      if (denied) {
        // The peek projected a denial — deny without recording so the
        // bucket is not inflated by rejected attempts.
        budgetDecision = denied;
      } else if (anyCrossNamespace) {
        budgetDecision = this.budget.record(principal);
      } else {
        budgetDecision = {
          allowed: true as const,
          reason: "allowed-same-namespace" as const,
          count: 0,
          limit: {
            softLimit: this.orchestrator.config.recallCrossNamespaceBudgetSoftLimit ?? 10,
            hardLimit: this.orchestrator.config.recallCrossNamespaceBudgetHardLimit ?? 30,
            windowMs: this.orchestrator.config.recallCrossNamespaceBudgetWindowMs ?? 60_000,
          },
        };
      }
      if (!budgetDecision.allowed) {
        throw new EngramAccessInputError(
          `recall denied: cross-namespace budget exceeded (${budgetDecision.count}/${budgetDecision.limit.hardLimit} in ${budgetDecision.limit.windowMs}ms window)`,
        );
      }
      // Prune expired principal buckets to prevent unbounded Map growth from
      // high-cardinality / transient principals (Codex P2 review feedback).
      this.budget.gc();
    }
    const topK = Number.isFinite(request.topK) ? Math.max(0, Math.floor(request.topK ?? 0)) : undefined;
    // Issue #680 — historical recall pin.  Validate at the input
    // boundary so a malformed `asOf` is rejected with a structured
    // 400 instead of silently flooring at NaN inside the orchestrator
    // (CLAUDE.md rule 51, gotcha #51).  Empty / undefined is fine —
    // means "no pin".
    let asOf: string | undefined;
    if (request.asOf !== undefined && request.asOf !== null) {
      if (typeof request.asOf !== "string" || request.asOf.trim().length === 0) {
        throw new EngramAccessInputError(
          "asOf must be a non-empty ISO 8601 timestamp string",
        );
      }
      const parsed = Date.parse(request.asOf);
      if (!Number.isFinite(parsed)) {
        throw new EngramAccessInputError(
          `asOf must be a parseable ISO 8601 timestamp (got: "${request.asOf}")`,
        );
      }
      asOf = request.asOf;
    }
    const recallOptions: RecallInvocationOptions = {
      namespace: namespaceOverride,
      topK,
      mode,
      ...(authenticatedPrincipal ? { principalOverride: authenticatedPrincipal } : {}),
      ...(asOf !== undefined ? { asOf } : {}),
      ...(request.includeLowConfidence === true ? { includeLowConfidence: true } : {}),
    };
    const startedAt = Date.now();
    const context = await this.orchestrator.recall(query, request.sessionKey, recallOptions);
    const snapshot = request.sessionKey
      ? this.orchestrator.lastRecall.get(request.sessionKey)
      : null;
    const effectiveNamespace = snapshot?.namespace
      ? this.resolveNamespace(snapshot.namespace)
      : namespace;
    // Auto-escalation policy (issue #677 PR 4/4).  When the operator
    // configured `recallDisclosureEscalation: "auto"` AND the caller
    // did not explicitly choose a disclosure level AND recall produced
    // a low-confidence result set (proxied by fill ratio: results
    // returned / topK requested), we escalate the default `chunk`
    // shape to `section` so the LLM gets richer context to compensate
    // for ambiguous retrieval.  Manual mode and explicit caller
    // disclosure both bypass the policy.  Documented in
    // `recall-disclosure-escalation.ts` and unit-tested there.
    // Confidence-proxy denominator: priority order is
    //   1. `snapshot.budgetsApplied.appliedTopK` (ALWAYS wins) — this is
    //      the limit the orchestrator actually applied after planner /
    //      minimal-mode / section-cap narrowing.  Codex P1 rounds 2+3
    //      on #705 emphasize that even a caller's explicit `request.topK`
    //      is wrong when the orchestrator caps below it (e.g. topK=50
    //      but appliedTopK=3 makes a 2-hit recall actually 0.67, not
    //      0.04).
    //   2. The caller's explicit `topK` when the snapshot lacks
    //      `budgetsApplied` (early-return paths, error cases).
    //   3. Config `qmdMaxResults` as a last-resort fallback.
    // Floor at observed-results so the ratio stays in [0, 1] even if
    // any of the signals drifts below the actual hit count.
    const resultsReturned = snapshot?.memoryIds?.length ?? 0;
    const appliedTopK = snapshot?.budgetsApplied?.appliedTopK;
    const configMaxResults =
      typeof this.orchestrator.config.qmdMaxResults === "number" &&
      Number.isFinite(this.orchestrator.config.qmdMaxResults) &&
      this.orchestrator.config.qmdMaxResults > 0
        ? this.orchestrator.config.qmdMaxResults
        : 0;
    const topKDenominator =
      typeof appliedTopK === "number" &&
      Number.isFinite(appliedTopK) &&
      appliedTopK > 0
        ? Math.max(appliedTopK, resultsReturned)
        : typeof topK === "number" && topK > 0
          ? Math.max(topK, resultsReturned)
          : Math.max(configMaxResults, resultsReturned, 1);
    // When the recall produced no snapshot (sessionless / namespace
    // mismatch / early-return path), there is no confidence signal to
    // base escalation on.  Pass `undefined` so the helper takes its
    // `no-top-k-confidence` branch instead of computing 0/N=0 and
    // forcing auto-escalation on every sessionless caller (Codex P2
    // review on PR #705).
    const topKConfidence =
      snapshot && topKDenominator > 0
        ? Math.min(1, resultsReturned / topKDenominator)
        : undefined;
    const escalationDecision = decideDisclosureEscalation({
      mode: this.orchestrator.config.recallDisclosureEscalation,
      threshold: this.orchestrator.config.recallDisclosureEscalationThreshold,
      originalDisclosure: requestedDisclosure,
      callerProvidedDisclosure,
      topKConfidence,
    });
    const disclosure = escalationDecision.effective;
    let results = await this.serializeRecallResults(snapshot, disclosure, {
      query,
      sessionKey: request.sessionKey,
    });

    // Tag filter (issue #689). Applied post-recall, post-serialization so
    // the actual frontmatter tags are already loaded onto each result. When
    // `tags` is absent or empty the filter is a no-op; an invalid `tagMatch`
    // throws via `parseTagMatch` (CLAUDE.md rule 51).
    const filterTags = normalizeTags(request.tags);
    let tagMatchMode: TagMatchMode | undefined;
    try {
      tagMatchMode = parseTagMatch(request.tagMatch);
    } catch (err) {
      throw new EngramAccessInputError(
        err instanceof Error ? err.message : String(err),
      );
    }
    let effectiveContext = context;
    if (filterTags && filterTags.length > 0) {
      const beforeIds = results.map((r) => r.id);
      const { results: admitted } = applyTagFilter(results, {
        tags: filterTags,
        tagMatch: tagMatchMode,
      });
      results = admitted;
      // Codex P1: `context` was generated by orchestrator.recall(...)
      // BEFORE the tag filter ran, so it can contain memories that don't
      // match the requested tags. Surfaces consuming `context` (the
      // prompt-injection string) would leak excluded content into the
      // LLM. When the filter actually drops any result, rebuild context
      // from the admitted set so excluded content is unreachable through
      // any field of the response. The rebuilt context concatenates each
      // admitted result's available text (full content at section/raw
      // disclosure, otherwise the preview) — a different wire format
      // than the orchestrator's native context, but a strict subset
      // safe to inject.
      const admittedIds = new Set(results.map((r) => r.id));
      const droppedAny = beforeIds.some((id) => !admittedIds.has(id));
      if (droppedAny) {
        effectiveContext = results
          .map((r) => {
            const content =
              typeof (r as { content?: unknown }).content === "string"
                ? ((r as { content?: string }).content ?? "")
                : "";
            const preview =
              typeof (r as { preview?: unknown }).preview === "string"
                ? ((r as { preview?: string }).preview ?? "")
                : "";
            return content || preview;
          })
          .filter((s) => s.length > 0)
          .join("\n\n");
      }
    }
    const filteredMemoryIds = filterTags && filterTags.length > 0
      ? results.map((r) => r.id)
      : (snapshot?.memoryIds ?? []);
    const debug = await this.buildRecallDebug(
      snapshot,
      effectiveNamespace,
      request.includeDebug === true,
      request.sessionKey,
    );

    // Fire-and-forget audit recording. Must never block or crash recall.
    let auditAnomalies: AccessAuditResult["anomalies"] | undefined;
    if (this.auditAdapter) {
      try {
        const resolvedAgentId = principal;
        const auditEntry = {
          ts: new Date().toISOString(),
          sessionKey: request.sessionKey ?? "",
          agentId: resolvedAgentId,
          trigger: "access-surface",
          queryText: query,
          candidateMemoryIds: snapshot?.memoryIds ?? [],
          // Audit must reflect what was actually injected, not what
          // recall produced before the tag filter. Using `context`
          // (pre-filter) overstates injectedChars and can leak content
          // from excluded memories into the audit summary (cursor
          // Medium on PR #712).
          summary: effectiveContext.slice(0, 200) || null,
          injectedChars: effectiveContext.length,
          toggleState: "enabled" as const,
          latencyMs: Date.now() - startedAt,
          plannerMode: snapshot?.plannerMode ?? mode,
          requestedMode: mode,
          fallbackUsed: snapshot?.fallbackUsed ?? false,
        };
        const auditResult = await this.auditAdapter.record(
          resolvedAgentId || "__anonymous__",
          auditEntry,
        );
        auditAnomalies = auditResult.anomalies;
      } catch {
        // Audit failures must never crash the recall path.
      }
    }

    return {
      query,
      sessionKey: request.sessionKey,
      namespace: effectiveNamespace,
      context: effectiveContext,
      count: filterTags && filterTags.length > 0
        ? results.length
        : (snapshot?.memoryIds.length ?? results.length),
      memoryIds: filteredMemoryIds,
      results,
      recordedAt: snapshot?.recordedAt,
      traceId: snapshot?.traceId,
      plannerMode: snapshot?.plannerMode ?? mode,
      fallbackUsed: snapshot?.fallbackUsed ?? false,
      sourcesUsed: snapshot?.sourcesUsed ?? [],
      disclosure,
      budgetsApplied: snapshot?.budgetsApplied,
      auditAnomalies,
      budgetWarning: budgetDecision.reason === "warn-over-soft" ? budgetDecision : undefined,
      latencyMs: snapshot?.latencyMs ?? (Date.now() - startedAt),
      debug,
    };
  }

  async recallExplain(
    request: EngramAccessRecallExplainRequest = {},
  ): Promise<EngramAccessRecallExplainResponse> {
    const requestedNamespace = request.namespace?.trim()
      ? this.resolveNamespace(request.namespace)
      : undefined;
    if (requestedNamespace) {
      const principal = resolvePrincipal(request.sessionKey, this.orchestrator.config);
      if (!canReadNamespace(principal, requestedNamespace, this.orchestrator.config)) {
        return { found: false };
      }
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
    const namespace = requestedNamespace ?? snapshot?.namespace ?? this.orchestrator.config.defaultNamespace;
    const [intent, graph] = await Promise.all([
      this.orchestrator.getLastIntentSnapshot(namespace),
      this.orchestrator.getLastGraphRecallSnapshot(namespace),
    ]);
    if (!snapshot && !intent && !graph) return { found: false };
    return { found: true, snapshot: snapshot ?? undefined, intent, graph };
  }

  async recallTierExplain(
    sessionKey?: string,
    namespace?: string,
    authenticatedPrincipal?: string,
  ) {
    const namespacesEnabled = this.orchestrator.config.namespacesEnabled;
    const requestedNamespace = namespace?.trim()
      ? this.resolveNamespace(namespace)
      : undefined;
    const principal = authenticatedPrincipal?.trim()
      || resolvePrincipal(sessionKey, this.orchestrator.config);

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
      const snapshotNs = candidate.namespace
        ?? this.orchestrator.config.defaultNamespace;
      return canReadNamespace(principal, snapshotNs, this.orchestrator.config)
        ? candidate
        : null;
    })();

    return toRecallExplainJson(snapshot);
  }

  /**
   * Recall X-ray (issue #570).  Runs a recall with `xrayCapture: true`
   * and returns the resulting snapshot as structured JSON so every
   * surface (CLI / HTTP / MCP) gets the same payload.  Namespace scope
   * is enforced before the recall fires (CLAUDE.md rule 42 — read and
   * write paths must resolve through the same namespace layer) so an
   * unauthorized principal cannot capture an x-ray for a namespace it
   * cannot read.
   */
  async recallXray(request: {
    query: string;
    sessionKey?: string;
    namespace?: string;
    budget?: number;
    authenticatedPrincipal?: string;
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
  }): Promise<{
    snapshotFound: boolean;
    snapshot?: RecallXraySnapshot;
    recall?: EngramAccessRecallResponse;
  }> {
    const query = typeof request.query === "string" ? request.query : "";
    if (query.trim().length === 0) {
      // Match the CLI contract (CLAUDE.md rule 51): reject empty
      // input with an explicit error rather than silently producing
      // an empty snapshot.
      throw new Error("recallXray: query is required and must be non-empty");
    }
    // Validate disclosure UP FRONT — before recall executes, before
    // the xray queue mutex is acquired, before namespace resolution.
    // A bad value should fail fast rather than after we've burned
    // cycles on an irreversible recall (Cursor Medium review on PR
    // #699).
    if (
      request.disclosure !== undefined &&
      !isRecallDisclosure(request.disclosure)
    ) {
      throw new EngramAccessInputError(
        `recallXray: disclosure must be one of: chunk, section, raw (got: ${String(request.disclosure)})`,
      );
    }

    const namespacesEnabled = this.orchestrator.config.namespacesEnabled;
    const requestedNamespace = request.namespace?.trim()
      ? this.resolveNamespace(request.namespace)
      : undefined;
    const authenticatedPrincipal = request.authenticatedPrincipal?.trim();
    const principal =
      authenticatedPrincipal
      || resolvePrincipal(request.sessionKey, this.orchestrator.config);

    if (requestedNamespace) {
      if (
        !canReadNamespace(
          principal,
          requestedNamespace,
          this.orchestrator.config,
        )
      ) {
        return { snapshotFound: false };
      }
    } else if (
      namespacesEnabled
      && !authenticatedPrincipal
      && !request.sessionKey?.trim()
    ) {
      // Namespaces enabled but no identity supplied — reject rather
      // than scanning the global namespace (CLAUDE.md rule 48:
      // least-privileged default).
      return { snapshotFound: false };
    }

    // Optional `--budget` override must be a positive integer.  Invalid
    // values throw rather than silently defaulting (CLAUDE.md rule 51).
    let budgetOverride: number | undefined;
    if (request.budget !== undefined && request.budget !== null) {
      const parsed =
        typeof request.budget === "number"
          ? request.budget
          : Number(request.budget);
      if (
        !Number.isFinite(parsed)
        || parsed <= 0
        || !Number.isInteger(parsed)
      ) {
        throw new Error(
          `recallXray: budget expects a positive integer; got ${JSON.stringify(request.budget)}`,
        );
      }
      budgetOverride = parsed;
    }
    const mode = this.normalizeRecallMode(request.mode);
    const disclosure = request.disclosure ?? DEFAULT_RECALL_DISCLOSURE;

    // Serialize x-ray invocations behind a per-service mutex so the
    // per-process `getLastXraySnapshot()` slot cannot be clobbered by
    // a concurrent capturing call before this caller reads it back.
    // Budget and principal are now threaded through
    // `RecallInvocationOptions`, so global config mutation is gone
    // (CLAUDE.md rule 47: no shared mutable state across async
    // boundaries).  The mutex stays only for the snapshot-slot
    // ordering guarantee.
    const previousQueue = this.xrayQueue;
    let release: () => void = () => {};
    this.xrayQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previousQueue;
    const recallStartedAt = Date.now();

    const recallSessionKey = request.sessionKey?.trim() || undefined;
    let xrayResponse: {
      snapshotFound: boolean;
      snapshot?: RecallXraySnapshot;
    } = { snapshotFound: false };

    try {
      // Clear any prior snapshot so a capture failure surfaces as
      // `{snapshotFound: false}` rather than returning stale data
      // from an earlier call on the same orchestrator.
      this.orchestrator.clearLastXraySnapshot();
      await this.orchestrator.recall(query, recallSessionKey, {
        xrayCapture: true,
        ...(requestedNamespace ? { namespace: requestedNamespace } : {}),
        ...(budgetOverride !== undefined
          ? { budgetCharsOverride: budgetOverride }
          : {}),
        ...(mode !== undefined ? { mode } : {}),
        // When the caller supplies an authenticated principal, forward
        // it via the dedicated override channel so orchestrator-side
        // ACL decisions use the SAME principal the access-surface
        // pre-check above authorized.  Threading an
        // `authenticatedPrincipal` through `sessionKey` would be wrong:
        // `resolvePrincipal(sessionKey)` only maps configured raw
        // session keys and otherwise collapses to `"default"`, which
        // in namespace-enabled deployments produces false denials /
        // wrong-scope serving despite the pre-check passing
        // (CLAUDE.md rule 42).
        ...(authenticatedPrincipal
          ? { principalOverride: authenticatedPrincipal }
          : {}),
        ...(request.currentContextScopes !== undefined
          ? { currentContextScopes: request.currentContextScopes }
          : {}),
      });

      const rawSnapshot = this.orchestrator.getLastXraySnapshot();
      // Re-check namespace after capture: the recall may have served
      // from a different namespace than the caller requested.  Drop
      // the snapshot rather than leak cross-tenant data (CLAUDE.md
      // rules 42 + 47).  The comparison is strict so a snapshot whose
      // namespace is `undefined` cannot bypass the scope the caller
      // asked for.
      const namespaceMismatch =
        requestedNamespace !== undefined &&
        rawSnapshot?.namespace !== requestedNamespace;
      if (!rawSnapshot) {
        xrayResponse = { snapshotFound: false };
      } else if (namespaceMismatch) {
        xrayResponse = { snapshotFound: false };
      } else {
        // Tag filter (issue #689). Mirrors `recall()` semantics — applied
        // post-capture by reading each result's frontmatter tags and
        // dropping non-matching results. Filter activity surfaces as a
        // `tag-filter` entry in `snapshot.filters` so X-ray consumers can
        // see the "considered → admitted" delta.
        let snapshot = rawSnapshot;
        const xrayFilterTags = normalizeTags(request.tags);
        let xrayTagMatch: TagMatchMode | undefined;
        try {
          xrayTagMatch = parseTagMatch(request.tagMatch);
        } catch (err) {
          throw new EngramAccessInputError(
            err instanceof Error ? err.message : String(err),
          );
        }
        if (xrayFilterTags && xrayFilterTags.length > 0) {
          const namespace = snapshot.namespace
            ? this.resolveNamespace(snapshot.namespace)
            : this.orchestrator.config.defaultNamespace;
          const tagsByIndex = await Promise.all(
            snapshot.results.map(async (result) => {
              try {
                const storage = await this.orchestrator.getStorage(namespace);
                const memory = await storage.readMemoryByPath(result.path);
                const t = memory?.frontmatter?.tags;
                // Normalize identically to the recall path
                // (`normalizeProjectionTags`): trim and drop empty strings
                // so X-ray tag matching stays consistent with the recall
                // surface. Without this, a frontmatter tag like " draft "
                // would match in recall but not in X-ray (cursor review).
                return Array.isArray(t) ? normalizeProjectionTags(t) : [];
              } catch {
                return [];
              }
            }),
          );
          const tagged = snapshot.results.map((result, index) => ({
            result,
            tags: tagsByIndex[index] ?? [],
          }));
          const { results: admittedTagged, trace } = applyTagFilter(tagged, {
            tags: xrayFilterTags,
            tagMatch: xrayTagMatch,
          });
          const admittedResults = admittedTagged.map((entry) => entry.result);
          const filters = trace ? [...snapshot.filters, trace] : snapshot.filters;
          snapshot = { ...snapshot, results: admittedResults, filters };
        }
        // Decorate per-result disclosure + token estimate when the caller
        // wired a depth knob (issue #677 PR 3/4 — codex review on #699
        // flagged that the renderer's per-disclosure summary stays empty
        // until callers populate these fields).  Estimate tokens from
        // the actual rendered payload at the requested depth so the
        // summary reflects real spend; chunk uses the preview, section
        // and raw use full content.  Best-effort only — a missing
        // memory or read failure is silently dropped (CLAUDE.md rule 13).
        if (request.disclosure !== undefined) {
          // Disclosure already validated up front; pin to the narrowed
          // type here.  Re-validation inside the queue would be dead code.
          const disclosure: RecallDisclosure = request.disclosure;
          const namespace = snapshot.namespace
            ? this.resolveNamespace(snapshot.namespace)
            : this.orchestrator.config.defaultNamespace;
          // Pre-fetch raw excerpts ONCE so the first raw-disclosure
          // result's token estimate includes the LCM-side excerpt spend
          // that `shapeMemorySummary` actually attaches in the recall
          // response.  Without this, raw recalls systematically
          // undercounted spend on the first result (Cursor Medium review
          // on PR #699).  Excerpts are scoped to the same session +
          // namespace as the recall.
          // Trim sessionKey to match what `orchestrator.recall(...)`
          // already does (`request.sessionKey?.trim() || undefined`),
          // otherwise a whitespace-padded key drives recall under one
          // identity but probes LCM under a different prefix and
          // misses stored excerpts (Cursor Low review on PR #699).
          const trimmedSessionKey = request.sessionKey?.trim() || undefined;
          const rawExcerpts =
            disclosure === "raw"
              ? await this.fetchRawExcerpts(disclosure, {
                  query,
                  ...(trimmedSessionKey ? { sessionKey: trimmedSessionKey } : {}),
                  namespace,
                })
              : null;
          const rawExcerptText =
            rawExcerpts && rawExcerpts.length > 0
              ? rawExcerpts.map((e) => e.content).join("\n")
              : "";
          // Pre-load every memory in parallel so we can:
          //   (a) re-attribute raw excerpts to the *first readable* result
          //       rather than always to index 0 (Cursor Low review on PR
          //       #699: a missing/unreadable result[0] orphaned the excerpt
          //       budget); and
          //   (b) include the metadata fields `shapeMemorySummary` actually
          //       emits at every depth (id, path, category, status, created,
          //       updated, tags, entityRef) in the token estimate, so the
          //       summary reflects real spend rather than only payload-body
          //       spend (Cursor Low review on PR #699).
          const memoryByIndex = await Promise.all(
            snapshot.results.map(async (result) => {
              try {
                const storage = await this.orchestrator.getStorage(namespace);
                return await storage.readMemoryByPath(result.path);
              } catch {
                return null;
              }
            }),
          );
          const firstReadableIndex = memoryByIndex.findIndex((m) => m !== null);
          const baseDir =
            (await this.orchestrator.getStorage(namespace)).dir;
          const decorated = snapshot.results.map((result, index) => {
            const memory = memoryByIndex[index];
            if (!memory) {
              // Unreadable result: attach the disclosure tag anyway so
              // the per-disclosure summary classifies it correctly,
              // but skip the token estimate since we don't have the
              // content to measure.  Without the disclosure tag the
              // result silently flows into the `unspecified` bucket
              // even though the caller explicitly requested a depth
              // (Cursor Low review on PR #699).
              return { ...result, disclosure };
            }
            // Build a representative shaped summary so the estimate
            // counts every field `shapeMemorySummary` actually emits.
            // The serialized JSON form is a close-enough proxy for the
            // wire payload size.
            const shaped = shapeMemorySummary(
              memory,
              baseDir,
              disclosure,
              disclosure === "raw" &&
              index === firstReadableIndex &&
              rawExcerpts &&
              rawExcerpts.length > 0
                ? rawExcerpts
                : undefined,
            );
            return {
              ...result,
              disclosure,
              estimatedTokens: estimateRecallTokens(JSON.stringify(shaped)),
            };
          });
          // Edge case: every result was unreadable but rawExcerpts
          // still has content — credit that spend to result[0] rather
          // than dropping it on the floor.  Without this, the raw row
          // in the per-disclosure summary under-reports spend whenever
          // every memory file is missing/unreadable.
          if (
            disclosure === "raw" &&
            firstReadableIndex === -1 &&
            rawExcerptText.length > 0 &&
            decorated.length > 0
          ) {
            decorated[0] = {
              ...decorated[0]!,
              disclosure,
              estimatedTokens: estimateRecallTokens(rawExcerptText),
            };
          }
          const decoratedSnapshot = { ...snapshot, results: decorated };
          xrayResponse = {
            snapshotFound: true,
            snapshot: decoratedSnapshot,
          };
        } else {
          xrayResponse = {
            snapshotFound: true,
            snapshot,
          };
        }
      }
    } finally {
      release();
    }

    if (
      request.includeRecall === true &&
      xrayResponse.snapshotFound === true &&
      xrayResponse.snapshot
    ) {
      return {
        ...xrayResponse,
        recall: await this.buildRecallResponseFromXraySnapshot({
          query,
          sessionKey: recallSessionKey,
          snapshot: xrayResponse.snapshot,
          disclosure,
          startedAt: recallStartedAt,
          requestedMode: request.mode,
          normalizedMode: mode,
        }),
      };
    }
    return xrayResponse;
  }
  // Sequence lock for `recallXray` — see comment inside the method.
  // Lives on the instance so every x-ray call on the same service
  // shares it, and so separate services in the same process (e.g.
  // per-tenant) do not block each other.
  private xrayQueue: Promise<void> = Promise.resolve();

  async memoryStore(request: EngramAccessMemoryStoreRequest): Promise<EngramAccessWriteResponse> {
    const namespace = this.resolveWritableNamespace(
      request.namespace,
      request.sessionKey,
      request.authenticatedPrincipal,
    );
    const schemaVersion = request.schemaVersion ?? ENGRAM_ACCESS_WRITE_SCHEMA_VERSION;
    if (schemaVersion !== ENGRAM_ACCESS_WRITE_SCHEMA_VERSION) {
      throw new EngramAccessInputError(`unsupported schemaVersion: ${schemaVersion}`);
    }
    const execute = async (): Promise<EngramAccessWriteResponse> => {
      const candidate = this.validateWriteCandidate(request, namespace);
      if (request.dryRun === true) {
        return {
          schemaVersion: ENGRAM_ACCESS_WRITE_SCHEMA_VERSION,
          operation: "memory_store",
          namespace,
          dryRun: true,
          accepted: true,
          queued: false,
          status: "validated",
          idempotencyKey: request.idempotencyKey?.trim() || undefined,
        };
      }
      const result = await persistExplicitCapture(this.orchestrator, candidate, "memory_store");
      const response: EngramAccessWriteResponse = {
        schemaVersion: ENGRAM_ACCESS_WRITE_SCHEMA_VERSION,
        operation: "memory_store",
        namespace,
        dryRun: false,
        accepted: true,
        queued: false,
        status: result.duplicateOf ? "duplicate" : "stored",
        memoryId: result.id,
        duplicateOf: result.duplicateOf,
        idempotencyKey: request.idempotencyKey?.trim() || undefined,
      };
      log.info(
        `access-write op=memory_store namespace=${namespace} dryRun=false status=${response.status} memoryId=${response.memoryId ?? "-"} idempotency=${response.idempotencyKey ? "yes" : "no"}`,
      );
      return response;
    };
    return this.handleIdempotentWrite({
      operation: "memory_store",
      idempotencyKey: request.idempotencyKey,
      requestFingerprint: {
        schemaVersion,
        content: request.content,
        category: request.category,
        confidence: request.confidence,
        namespace,
        tags: request.tags,
        entityRef: request.entityRef,
        ttl: request.ttl,
        sourceReason: request.sourceReason,
      },
      skip: request.dryRun === true,
      execute,
    });
  }

  async peekMemoryStoreIdempotency(request: EngramAccessMemoryStoreRequest): Promise<EngramAccessIdempotencyStatus> {
    const namespace = this.resolveWritableNamespace(
      request.namespace,
      request.sessionKey,
      request.authenticatedPrincipal,
    );
    const schemaVersion = request.schemaVersion ?? ENGRAM_ACCESS_WRITE_SCHEMA_VERSION;
    if (schemaVersion !== ENGRAM_ACCESS_WRITE_SCHEMA_VERSION) {
      throw new EngramAccessInputError(`unsupported schemaVersion: ${schemaVersion}`);
    }
    return this.peekIdempotentWrite({
      operation: "memory_store",
      idempotencyKey: request.idempotencyKey,
      requestFingerprint: {
        schemaVersion,
        content: request.content,
        category: request.category,
        confidence: request.confidence,
        namespace,
        tags: request.tags,
        entityRef: request.entityRef,
        ttl: request.ttl,
        sourceReason: request.sourceReason,
      },
      skip: request.dryRun === true,
    });
  }

  async suggestionSubmit(request: EngramAccessSuggestionSubmitRequest): Promise<EngramAccessWriteResponse> {
    const namespace = this.resolveWritableNamespace(
      request.namespace,
      request.sessionKey,
      request.authenticatedPrincipal,
    );
    const schemaVersion = request.schemaVersion ?? ENGRAM_ACCESS_WRITE_SCHEMA_VERSION;
    if (schemaVersion !== ENGRAM_ACCESS_WRITE_SCHEMA_VERSION) {
      throw new EngramAccessInputError(`unsupported schemaVersion: ${schemaVersion}`);
    }
    const execute = async (): Promise<EngramAccessWriteResponse> => {
      const candidate = this.validateWriteCandidate(request, namespace);
      if (request.dryRun === true) {
        return {
          schemaVersion: ENGRAM_ACCESS_WRITE_SCHEMA_VERSION,
          operation: "suggestion_submit",
          namespace,
          dryRun: true,
          accepted: true,
          queued: true,
          status: "validated",
          idempotencyKey: request.idempotencyKey?.trim() || undefined,
        };
      }
      const result = await queueExplicitCaptureForReview(
        this.orchestrator,
        candidate,
        "suggestion_submit",
        new Error(request.sourceReason?.trim() || "submitted via engram suggestion_submit"),
      );
      const response: EngramAccessWriteResponse = {
        schemaVersion: ENGRAM_ACCESS_WRITE_SCHEMA_VERSION,
        operation: "suggestion_submit",
        namespace,
        dryRun: false,
        accepted: true,
        queued: true,
        status: "queued_for_review",
        memoryId: result.id,
        duplicateOf: result.duplicateOf,
        idempotencyKey: request.idempotencyKey?.trim() || undefined,
      };
      log.info(
        `access-write op=suggestion_submit namespace=${namespace} dryRun=false status=${response.status} memoryId=${response.memoryId ?? "-"} idempotency=${response.idempotencyKey ? "yes" : "no"}`,
      );
      return response;
    };
    return this.handleIdempotentWrite({
      operation: "suggestion_submit",
      idempotencyKey: request.idempotencyKey,
      requestFingerprint: {
        schemaVersion,
        content: request.content,
        category: request.category,
        confidence: request.confidence,
        namespace,
        tags: request.tags,
        entityRef: request.entityRef,
        ttl: request.ttl,
        sourceReason: request.sourceReason,
      },
      skip: request.dryRun === true,
      execute,
    });
  }

  async peekSuggestionSubmitIdempotency(
    request: EngramAccessSuggestionSubmitRequest,
  ): Promise<EngramAccessIdempotencyStatus> {
    const namespace = this.resolveWritableNamespace(
      request.namespace,
      request.sessionKey,
      request.authenticatedPrincipal,
    );
    const schemaVersion = request.schemaVersion ?? ENGRAM_ACCESS_WRITE_SCHEMA_VERSION;
    if (schemaVersion !== ENGRAM_ACCESS_WRITE_SCHEMA_VERSION) {
      throw new EngramAccessInputError(`unsupported schemaVersion: ${schemaVersion}`);
    }
    return this.peekIdempotentWrite({
      operation: "suggestion_submit",
      idempotencyKey: request.idempotencyKey,
      requestFingerprint: {
        schemaVersion,
        content: request.content,
        category: request.category,
        confidence: request.confidence,
        namespace,
        tags: request.tags,
        entityRef: request.entityRef,
        ttl: request.ttl,
        sourceReason: request.sourceReason,
      },
      skip: request.dryRun === true,
    });
  }

  private validateWriteCandidate(
    request: EngramAccessMemoryStoreRequest | EngramAccessSuggestionSubmitRequest,
    namespace: string,
  ): ValidExplicitCapture {
    try {
      return validateExplicitCaptureInput(
        {
          ...request,
          namespace,
        },
        "legacy_tool",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new EngramAccessInputError(message);
    }
  }

  async memoryGet(memoryId: string, namespace?: string, principal?: string): Promise<EngramAccessMemoryResponse> {
    const resolvedNamespace = this.resolveReadableNamespace(namespace, principal);
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    const memory = await storage.getMemoryById(memoryId);
    if (!memory) {
      return { found: false, namespace: resolvedNamespace };
    }
    return {
      found: true,
      namespace: resolvedNamespace,
      memory: this.serializeMemory(memory),
    };
  }

  async memoryBrowse(
    request: EngramAccessMemoryBrowseRequest = {},
  ): Promise<EngramAccessMemoryBrowseResponse> {
    const storage = await this.orchestrator.getStorage(request.namespace);
    const resolvedNamespace = request.namespace?.trim() || this.orchestrator.config.defaultNamespace;
    const { limit, offset } = normalizePagination(request.limit, request.offset);
    const sort = normalizeBrowseSort(request.sort);
    const query = request.query?.trim().toLowerCase() ?? "";
    const statusFilter = request.status?.trim().toLowerCase();
    const categoryFilter = request.category?.trim().toLowerCase();

    const projected = await storage.browseProjectedMemories({
      query,
      status: statusFilter,
      category: categoryFilter,
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

    let memories = [...await storage.readAllMemories(), ...await storage.readArchivedMemories()];
    memories = memories.filter((memory) => {
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
      ].join("\n").toLowerCase();
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
    limit: number = 200,
    principal?: string,
  ): Promise<EngramAccessTimelineResponse> {
    const resolvedNamespace = this.resolveReadableNamespace(namespace, principal);
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    const timeline = await storage.getMemoryTimeline(memoryId, limit);
    return {
      found: timeline.length > 0,
      namespace: resolvedNamespace,
      count: timeline.length,
      timeline,
    };
  }

  async entityList(options: {
    namespace?: string;
    query?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<EngramAccessEntityListResponse> {
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
        ].join("\n").toLowerCase();
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
    const resolvedNamespace = this.resolveReadableNamespace(namespace, principal);
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    const projected = await storage.getProjectedGovernanceRecord();
    if (projected && (!runId || projected.runId === runId.trim())) {
      const projectedAppliedActions = projected.appliedActionRows.map((row) => ({
        action: row.action,
        memoryId: row.memoryId,
        reasonCode: row.reasonCode,
        beforeStatus: row.beforeStatus,
        afterStatus: row.afterStatus,
        originalPath: row.originalPath,
        currentPath: row.currentPath,
      })) as Awaited<
        ReturnType<typeof readMemoryGovernanceRunArtifact>
      >["appliedActions"];
      const projectedProposedActions = await buildProjectedGovernanceProposedActions(storage, projected);
      const projectedArtifact = await (async () => {
        try {
          return await readMemoryGovernanceRunArtifact(storage.dir, projected.runId);
        } catch {
          return null;
        }
      })();
      const metrics = projected.metrics as Awaited<ReturnType<typeof readMemoryGovernanceRunArtifact>>["metrics"];
      const fallbackTransitionReport = {
        proposed: groupActionsByStatus(projectedProposedActions),
        applied: groupActionsByStatus(projectedAppliedActions),
      };
      const transitionReport = projectedArtifact?.transitionReport
        ? {
            proposed:
              hasGroupedGovernanceActions(projectedArtifact.transitionReport.proposed) || projectedProposedActions.length === 0
                ? projectedArtifact.transitionReport.proposed
                : fallbackTransitionReport.proposed,
            applied:
              hasGroupedGovernanceActions(projectedArtifact.transitionReport.applied) || projectedAppliedActions.length === 0
                ? projectedArtifact.transitionReport.applied
                : fallbackTransitionReport.applied,
          }
        : fallbackTransitionReport;
      const qualityScore = projectedArtifact?.qualityScore ?? metrics?.qualityScore ?? buildQualityScore(metrics?.reviewReasons ?? {
        exact_duplicate: 0,
        semantic_duplicate_candidate: 0,
        disputed_memory: 0,
        speculative_low_confidence: 0,
        archive_candidate: 0,
        explicit_capture_review: 0,
        malformed_import: 0,
      });
      const effectiveMetrics = metrics ? { ...metrics, qualityScore: metrics.qualityScore ?? qualityScore } : metrics;

      return {
        found: true,
        namespace: resolvedNamespace,
        runId: projected.runId,
        summary: projected.summary as Awaited<ReturnType<typeof readMemoryGovernanceRunArtifact>>["summary"],
        metrics: effectiveMetrics,
        qualityScore,
        reviewQueue: projected.reviewQueueRows.map((row) => ({
          entryId: row.entryId,
          memoryId: row.memoryId,
          path: row.path,
          reasonCode: row.reasonCode,
          severity: row.severity,
          suggestedAction: row.suggestedAction,
          suggestedStatus: row.suggestedStatus,
          relatedMemoryIds: row.relatedMemoryIds,
        })) as Awaited<
          ReturnType<typeof readMemoryGovernanceRunArtifact>
        >["reviewQueue"],
        appliedActions: projectedAppliedActions,
        transitionReport,
        report: projected.report,
      };
    }

    const resolvedRunId = runId?.trim() || (await listMemoryGovernanceRuns(storage.dir))[0];
    if (!resolvedRunId) return { found: false, namespace: resolvedNamespace };
    const artifact = await readMemoryGovernanceRunArtifact(storage.dir, resolvedRunId);
    return {
      found: true,
      namespace: resolvedNamespace,
      runId: resolvedRunId,
      summary: artifact.summary,
      metrics: artifact.metrics,
      qualityScore: artifact.qualityScore,
      reviewQueue: artifact.reviewQueue,
      appliedActions: artifact.appliedActions,
      transitionReport: artifact.transitionReport,
      report: artifact.report,
    };
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

    const memories = [...await storage.readAllMemories(), ...await storage.readArchivedMemories()];
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
    principal?: string,
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
    const deepSleep = this.orchestrator.config.dreamsPhases.deepSleep;
    if (deepSleep.enabled === false && deepSleep.enabledExplicitlySet === true) {
      throw new Error("memory governance is disabled by dreams.phases.deepSleep.enabled=false");
    }
    const resolvedNamespace = this.resolveWritableNamespace(
      request.namespace,
      undefined,
      request.authenticatedPrincipal ?? principal,
    );
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    const mode = request.mode === "apply" ? "apply" : "shadow";
    const boundedBatchSize =
      typeof request.batchSize === "number" && Number.isFinite(request.batchSize)
        ? Math.max(1, Math.floor(request.batchSize))
        : undefined;
    const result = await runMemoryGovernance({
      memoryDir: storage.dir,
      mode,
      recentDays:
        typeof request.recentDays === "number" && Number.isFinite(request.recentDays)
          ? Math.max(1, Math.floor(request.recentDays))
          : undefined,
      maxMemories:
        typeof request.maxMemories === "number" && Number.isFinite(request.maxMemories)
          ? Math.max(1, Math.floor(request.maxMemories))
          : undefined,
      batchSize: boundedBatchSize,
    });
    if (mode === "apply") {
      try {
        await this.orchestrator.processEntitySynthesisQueue(
          resolvedNamespace,
          Math.min(boundedBatchSize ?? 5, 5),
        );
      } catch (error) {
        log.debug(`governanceRun: entity synthesis refresh failed after governance apply: ${error}`);
      }
    }

    return {
      namespace: resolvedNamespace,
      runId: result.runId,
      traceId: result.traceId,
      mode: result.mode,
      reviewQueueCount: result.reviewQueue.length,
      proposedActionCount: result.proposedActions.length,
      appliedActionCount: result.appliedActions.length,
      summaryPath: result.summaryPath,
      reportPath: result.reportPath,
    };
  }

  async procedureMiningRun(
    request: {
      namespace?: string;
      authenticatedPrincipal?: string;
    },
    principal?: string,
  ): Promise<{
    namespace: string;
    clustersProcessed: number;
    proceduresWritten: number;
    skippedReason?: string;
  }> {
    const resolvedNamespace = this.resolveWritableNamespace(
      request.namespace,
      undefined,
      request.authenticatedPrincipal ?? principal,
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
    principal?: string,
  ): Promise<LiveConnectorsRunSummary> {
    this.resolveWritableNamespace(
      undefined,
      undefined,
      request.authenticatedPrincipal ?? principal,
    );
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
    principal?: string,
  ): Promise<{
    namespace: string;
    ran: boolean;
    skippedReason?: "disabled" | "cadence";
    clustersFound: number;
    canonicalsUpdated: number;
    duplicatesSuperseded: number;
    result?: PatternReinforcementResult;
  }> {
    const resolvedNamespace = this.resolveWritableNamespace(
      request.namespace,
      undefined,
      request.authenticatedPrincipal ?? principal,
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
    principal?: string,
  ): Promise<ProcedureStatsReport & { namespace: string }> {
    const resolvedNamespace = this.resolveReadableNamespace(
      request.namespace,
      principal,
    );
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    const report = await computeProcedureStats({
      storage,
      config: this.orchestrator.config,
    });
    return { namespace: resolvedNamespace, ...report };
  }

  async memorySummarizeHourly(): Promise<{
    ok: true;
    message: string;
  }> {
    await this.orchestrator.summarizer.runHourly();
    return {
      ok: true,
      message: "Hourly summarization completed. Check the summaries directory for results.",
    };
  }

  async conversationIndexUpdate(
    request: {
      sessionKey?: string;
      hours?: number;
      embed?: boolean;
    } = {},
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
    if (!this.orchestrator.config.conversationIndexEnabled) {
      return {
        enabled: false,
        sessions: 0,
        chunks: 0,
        skipped: 0,
        skippedSessionKeys: [],
        embeddedRuns: 0,
        reason: "disabled",
      };
    }

    const hours =
      typeof request.hours === "number" && Number.isFinite(request.hours)
        ? Math.max(1, Math.floor(request.hours))
        : 24;

    let sessionKey: string | undefined;
    if (request.sessionKey !== undefined) {
      if (typeof request.sessionKey !== "string" || request.sessionKey.trim().length === 0) {
        throw new EngramAccessInputError("sessionKey must be a non-empty string when provided");
      }
      sessionKey = request.sessionKey.trim();
    }

    if (sessionKey) {
      const result = await this.orchestrator.updateConversationIndex(
        sessionKey,
        hours,
        { embed: request.embed },
      );
      return {
        enabled: true,
        sessionKey,
        sessions: 1,
        chunks: result.chunks,
        skipped: result.skipped ? 1 : 0,
        skippedSessionKeys: result.skipped ? [sessionKey] : [],
        embeddedRuns: result.embedded ? 1 : 0,
        reason: result.reason,
        retryAfterMs: result.retryAfterMs,
      };
    }

    const sessionKeys = await this.orchestrator.transcript.listSessionKeys();
    let chunks = 0;
    let skipped = 0;
    const skippedSessionKeys: string[] = [];
    let embeddedRuns = 0;

    for (const sessionKey of sessionKeys) {
      const result = await this.orchestrator.updateConversationIndex(
        sessionKey,
        hours,
        { embed: request.embed },
      );
      chunks += result.chunks;
      if (result.skipped) {
        skipped += 1;
        skippedSessionKeys.push(sessionKey);
      }
      if (result.embedded) {
        embeddedRuns += 1;
      }
    }

    return {
      enabled: true,
      sessions: sessionKeys.length,
      chunks,
      skipped,
      skippedSessionKeys,
      embeddedRuns,
    };
  }

  async profilingReport(
    request: AccessProfilingReportRequest = {},
  ): Promise<AccessProfilingReportResponse> {
    const profiler = this.orchestrator.profiler;
    if (!profiler.isEnabled) {
      return {
        enabled: false,
        reason: "disabled",
        message: "Profiling is disabled. Set profilingEnabled: true in your plugin config to enable.",
      };
    }

    const format = request.format ?? "ascii";
    if (format !== "ascii" && format !== "json") {
      throw new EngramAccessInputError("format must be one of: ascii, json");
    }

    const limit = request.limit ?? 5;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new EngramAccessInputError("limit must be an integer between 1 and 20");
    }

    const traces = profiler.getRecentTraces(limit);
    const stats = profiler.getStats();
    const bottleneck = profiler.identifyBottleneck();

    if (format === "json") {
      return {
        enabled: true,
        format,
        traces,
        stats,
        bottleneck,
      };
    }

    const lines: string[] = [];
    lines.push("Engram Profiling Report");
    lines.push("=".repeat(60));
    lines.push("");

    type BucketEntry = { count: number; avgMs: number; p50Ms: number; p95Ms: number; maxMs: number };
    const allBuckets: Array<[string, Record<string, BucketEntry>]> = [
      ["byKind", stats.byKind],
      ["bySpan", stats.bySpan],
    ];
    const hasStats = allBuckets.some(([, entries]) => Object.keys(entries).length > 0);
    if (hasStats) {
      lines.push("Aggregate Stats (all retained traces):");
      for (const [bucket, entries] of allBuckets) {
        for (const [key, summary] of Object.entries(entries)) {
          lines.push(
            `  ${bucket}/${key}: avg=${summary.avgMs}ms p50=${summary.p50Ms}ms p95=${summary.p95Ms}ms max=${summary.maxMs}ms (n=${summary.count})`,
          );
        }
      }
      lines.push("");
    }

    if (bottleneck) {
      lines.push(`Bottleneck: ${bottleneck}`);
      lines.push("");
    }

    if (traces.length === 0) {
      lines.push("No traces recorded yet. Trigger a recall or extraction to see timing data.");
    } else {
      for (const trace of traces) {
        lines.push(formatProfileTraceAscii(trace));
        lines.push("");
      }
    }

    return {
      enabled: true,
      format,
      report: lines.join("\n"),
    };
  }

  async trustZoneStatus(namespace?: string, principal?: string): Promise<EngramAccessTrustZoneStatusResponse> {
    const resolvedNamespace = this.resolveReadableNamespace(namespace, principal);
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    return {
      namespace: resolvedNamespace,
      status: await getTrustZoneStoreStatus({
        memoryDir: storage.dir,
        trustZoneStoreDir: this.orchestrator.config.trustZoneStoreDir,
        enabled: this.orchestrator.config.trustZonesEnabled === true,
        promotionEnabled: this.orchestrator.config.quarantinePromotionEnabled === true,
        poisoningDefenseEnabled: this.orchestrator.config.memoryPoisoningDefenseEnabled === true,
      }),
    };
  }

  async trustZoneBrowse(
    request: EngramAccessTrustZoneBrowseRequest,
    principal?: string,
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
          this.orchestrator.config.memoryPoisoningDefenseEnabled === true,
          this.orchestrator.config.trustZonesEnabled === true,
          this.orchestrator.config.quarantinePromotionEnabled === true,
        )),
    };
  }

  async trustZonePromote(
    request: EngramAccessTrustZonePromoteRequest,
  ): Promise<EngramAccessTrustZonePromoteResponse> {
    if (!isTrustZoneName(request.targetZone)) {
      throw new EngramAccessInputError(`unsupported trust-zone target: ${String(request.targetZone)}`);
    }
    const resolvedNamespace = this.resolveWritableNamespace(
      request.namespace,
      undefined,
      request.authenticatedPrincipal,
    );
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    let result: TrustZonePromotionResult;
    try {
      result = await promoteTrustZoneRecord({
        memoryDir: storage.dir,
        trustZoneStoreDir: this.orchestrator.config.trustZoneStoreDir,
        enabled: this.orchestrator.config.trustZonesEnabled === true,
        promotionEnabled: this.orchestrator.config.quarantinePromotionEnabled === true,
        poisoningDefenseEnabled: this.orchestrator.config.memoryPoisoningDefenseEnabled === true,
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
    request: EngramAccessTrustZoneDemoSeedRequest,
  ): Promise<EngramAccessTrustZoneDemoSeedResponse> {
    const resolvedNamespace = this.resolveWritableNamespace(
      request.namespace,
      undefined,
      request.authenticatedPrincipal,
    );
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    let result: TrustZoneDemoSeedResult;
    try {
      result = await seedTrustZoneDemoDataset({
        memoryDir: storage.dir,
        trustZoneStoreDir: this.orchestrator.config.trustZoneStoreDir,
        enabled: this.orchestrator.config.trustZonesEnabled === true,
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
    request: EngramAccessReviewDispositionRequest,
  ): Promise<EngramAccessReviewDispositionResponse> {
    const memoryId = request.memoryId.trim();
    const reasonCode = request.reasonCode.trim();
    if (memoryId.length === 0) {
      throw new EngramAccessInputError("memoryId is required");
    }
    if (reasonCode.length === 0) {
      throw new EngramAccessInputError("reasonCode is required");
    }

    const resolvedNamespace = this.resolveWritableNamespace(
      request.namespace,
      undefined,
      request.authenticatedPrincipal,
    );
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    const memory = await storage.getMemoryById(memoryId);
    if (!memory) {
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

    const updated = await storage.writeMemoryFrontmatter(memory, {
      status: request.status,
      updated: updatedAt,
    }, lifecycle);
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
    rawExcerpts?: EngramAccessMemorySummary["rawExcerpts"],
  ): EngramAccessMemorySummary {
    return shapeMemorySummary(memory, baseDir, disclosure, rawExcerpts);
  }

  async observe(request: EngramAccessObserveRequest): Promise<EngramAccessObserveResponse> {
    if (!request.sessionKey || typeof request.sessionKey !== "string" || request.sessionKey.trim().length === 0) {
      throw new EngramAccessInputError("sessionKey is required and must be a non-empty string");
    }
    if (!Array.isArray(request.messages) || request.messages.length === 0) {
      throw new EngramAccessInputError("messages is required and must be a non-empty array");
    }
    for (const msg of request.messages) {
      if (!msg || typeof msg !== "object" || typeof msg.role !== "string" || typeof msg.content !== "string") {
        throw new EngramAccessInputError("each message must have a string 'role' and 'content'");
      }
      if (msg.role !== "user" && msg.role !== "assistant") {
        throw new EngramAccessInputError(`invalid message role: ${msg.role} (expected 'user' or 'assistant')`);
      }
    }

    // Validate namespace authorization BEFORE attaching coding context so
    // a failed auth check doesn't leave orphaned context on the session
    // (Codex review P2).
    const hasExplicitNamespace =
      typeof request.namespace === "string" &&
      request.namespace.trim().length > 0;
    const principal = this.resolveRequestPrincipal(
      request.sessionKey,
      request.authenticatedPrincipal,
    );
    const namespace = this.resolveWritableNamespace(
      request.namespace,
      request.sessionKey,
      request.authenticatedPrincipal,
    );
    const shouldWriteObjectiveState =
      this.orchestrator.config.objectiveStateMemoryEnabled === true &&
      this.orchestrator.config.objectiveStateSnapshotWritesEnabled === true;
    const objectiveStateBaseNamespace = hasExplicitNamespace
      ? namespace
      : defaultNamespaceForPrincipal(principal, this.orchestrator.config);
    if (
      shouldWriteObjectiveState &&
      !hasExplicitNamespace &&
      !canWriteNamespace(
        principal,
        objectiveStateBaseNamespace,
        this.orchestrator.config,
      )
    ) {
      throw new EngramAccessInputError(
        `namespace is not writable: ${objectiveStateBaseNamespace}`,
      );
    }

    // Auto-resolve coding context from cwd/projectTag so observe writes
    // route to the correct project namespace (rule 42: same namespace layer
    // as recall).
    await this.maybeAttachCodingContext(request.sessionKey, {
      cwd: request.cwd,
      projectTag: request.projectTag,
    });

    const objectiveStateNamespace = hasExplicitNamespace
      ? namespace
      : this.orchestrator.applyCodingNamespaceOverlay(
          request.sessionKey,
          objectiveStateBaseNamespace,
        );

    // Prefix sessionKey with namespace for LCM archival so turns are namespace-scoped.
    // This ensures multi-tenant isolation in the LCM archive.
    const lcmSessionKey = namespace !== this.orchestrator.config.defaultNamespace
      ? `${namespace}:${request.sessionKey}`
      : request.sessionKey;

    if (shouldWriteObjectiveState) {
      try {
        const objectiveStateLocation =
          await this.objectiveStateStoreLocationForNamespace(
            objectiveStateNamespace,
          );
        await recordObjectiveStateSnapshotsFromObservedMessages({
          memoryDir: objectiveStateLocation.memoryDir,
          objectiveStateStoreDir: objectiveStateLocation.objectiveStateStoreDir,
          objectiveStateMemoryEnabled: this.orchestrator.config.objectiveStateMemoryEnabled,
          objectiveStateSnapshotWritesEnabled:
            this.orchestrator.config.objectiveStateSnapshotWritesEnabled,
          sessionKey: request.sessionKey,
          recordedAt: new Date().toISOString(),
          messages: request.messages,
        });
      } catch (err) {
        log.error(`access-observe objective-state snapshot write failed: ${err}`);
      }
    }

    // lcmArchived in the response means "LCM archival was queued" (not
    // "completed"), matching extractionQueued semantics.  Both run async.
    let lcmArchived = false;
    if (this.orchestrator.lcmEngine && this.orchestrator.lcmEngine.enabled) {
      // Fire-and-forget: LCM archival writes to SQLite and builds summary
      // DAGs, which can take tens of seconds for large sessions.  Don't
      // block the HTTP response — the caller only needs acknowledgment.
      try {
        this.orchestrator.lcmEngine.enqueueObserveMessages(lcmSessionKey, request.messages);
        lcmArchived = true;
      } catch (err) {
        log.error(`access-observe LCM enqueue failed: ${err}`);
      }
    }

    let extractionQueued = false;
    if (request.skipExtraction !== true) {
      const turns = request.messages.map((m) => ({
        source: "openclaw" as const,
        sessionKey: lcmSessionKey,
        role: m.role,
        content: m.content,
        parts: m.parts,
        rawContent: m.rawContent,
        sourceFormat: m.sourceFormat,
        timestamp: new Date().toISOString(),
      }));
      // Fire-and-forget: queue extraction in the background so the HTTP
      // response returns immediately. LCM archival (above) is also
      // enqueue-only; extraction involves LLM calls that can take
      // minutes under load and should not block the caller.
      //
      // Backpressure: the orchestrator's own extraction queue already
      // limits concurrency (one extraction at a time per session via
      // queueBufferedExtraction). Fire-and-forget here just decouples
      // the HTTP response from the queue drain.
      try {
        const extractionPromise = this.orchestrator.ingestReplayBatch(turns, {
          archiveLcm: false,
        });
        extractionPromise.catch((err) => {
          log.error(`access-observe background extraction failed: ${err}`);
        });
        extractionQueued = true;
      } catch (err) {
        // Synchronous enqueue failure (e.g. orchestrator disposed)
        log.error(`access-observe extraction enqueue failed: ${err}`);
      }
    }

    log.info(
      `access-observe namespace=${namespace} sessionKey=${request.sessionKey} messages=${request.messages.length} lcm=${lcmArchived} extraction=${extractionQueued}`,
    );

    return {
      accepted: request.messages.length,
      sessionKey: request.sessionKey,
      namespace,
      lcmArchived,
      extractionQueued,
    };
  }

  async lcmSearch(request: EngramAccessLcmSearchRequest): Promise<EngramAccessLcmSearchResponse> {
    if (!request.query || typeof request.query !== "string" || request.query.trim().length === 0) {
      throw new EngramAccessInputError("query is required and must be a non-empty string");
    }

    const principal = this.resolveRequestPrincipal(request.sessionKey, request.authenticatedPrincipal);
    const namespace = this.resolveReadableNamespace(request.namespace, principal);

    if (!this.orchestrator.lcmEngine || !this.orchestrator.lcmEngine.enabled) {
      return {
        query: request.query,
        namespace,
        results: [],
        count: 0,
        lcmEnabled: false,
      };
    }

    const limit = Math.max(1, Math.min(request.limit ?? 10, 100));
    const lcmSessionKey = request.sessionKey && namespace !== this.orchestrator.config.defaultNamespace
      ? `${namespace}:${request.sessionKey}`
      : request.sessionKey;
    const rawResults = await this.orchestrator.lcmEngine.searchContextFull(
      request.query,
      limit,
      lcmSessionKey,
    );

    const results = rawResults.map((r: { session_id: string; content: string; turn_index: number }) => ({
      sessionId: r.session_id,
      content: r.content,
      turnIndex: r.turn_index,
    }));

    return {
      query: request.query,
      namespace,
      results,
      count: results.length,
      lcmEnabled: true,
    };
  }

  async lcmCompactionFlush(
    request: EngramAccessLcmCompactionFlushRequest,
  ): Promise<EngramAccessLcmCompactionFlushResponse> {
    if (!request.sessionKey || typeof request.sessionKey !== "string" || request.sessionKey.trim().length === 0) {
      throw new EngramAccessInputError("sessionKey is required and must be a non-empty string");
    }

    const namespace = this.resolveWritableNamespace(
      request.namespace,
      request.sessionKey,
      request.authenticatedPrincipal,
    );
    if (!this.orchestrator.lcmEngine || !this.orchestrator.lcmEngine.enabled) {
      return {
        enabled: false,
        flushed: false,
        sessionKey: request.sessionKey,
        namespace,
        reason: "LCM is disabled",
      };
    }

    const lcmSessionKey = namespace !== this.orchestrator.config.defaultNamespace
      ? `${namespace}:${request.sessionKey}`
      : request.sessionKey;
    await this.orchestrator.lcmEngine.waitForSessionObserveIdle(lcmSessionKey);
    await this.orchestrator.lcmEngine.preCompactionFlush(lcmSessionKey);
    return {
      enabled: true,
      flushed: true,
      sessionKey: request.sessionKey,
      namespace,
    };
  }

  async lcmCompactionRecord(
    request: EngramAccessLcmCompactionRecordRequest,
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

    const namespace = this.resolveWritableNamespace(
      request.namespace,
      request.sessionKey,
      request.authenticatedPrincipal,
    );
    if (!this.orchestrator.lcmEngine || !this.orchestrator.lcmEngine.enabled) {
      return {
        enabled: false,
        recorded: false,
        sessionKey: request.sessionKey,
        namespace,
        reason: "LCM is disabled",
      };
    }

    const lcmSessionKey = namespace !== this.orchestrator.config.defaultNamespace
      ? `${namespace}:${request.sessionKey}`
      : request.sessionKey;
    await this.orchestrator.lcmEngine.waitForSessionObserveIdle(lcmSessionKey);
    await this.orchestrator.lcmEngine.recordCompaction(
      lcmSessionKey,
      request.tokensBefore,
      request.tokensAfter,
    );
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
    if (!this.orchestrator.config.identityContinuityEnabled) {
      return { enabled: false, reason: "Identity continuity is disabled. Enable `identityContinuityEnabled: true`." };
    }
    if (!this.orchestrator.config.continuityAuditEnabled) {
      return { enabled: false, reason: "Continuity audits are disabled. Enable `continuityAuditEnabled: true`." };
    }
    if (!this.orchestrator.compounding) {
      return { enabled: false, reason: "Compounding engine is disabled. Enable `compoundingEnabled: true`." };
    }
    const period = request.period === "monthly" ? "monthly" : "weekly";
    const key = request.key?.trim() || undefined;
    const audit = await this.orchestrator.compounding.synthesizeContinuityAudit({ period, key });
    return { enabled: true, period: audit.period, key: audit.key, reportPath: audit.reportPath };
  }

  async continuityIncidentOpen(request: {
    symptom: string;
    namespace?: string;
    principal?: string;
    triggerWindow?: string;
    suspectedCause?: string;
  }): Promise<unknown> {
    if (!this.orchestrator.config.identityContinuityEnabled) {
      return { enabled: false, reason: "Identity continuity is disabled. Enable `identityContinuityEnabled: true`." };
    }
    if (!this.orchestrator.config.continuityIncidentLoggingEnabled) {
      return { enabled: false, reason: "Continuity incident logging is disabled. Enable `continuityIncidentLoggingEnabled: true`." };
    }
    const symptom = request.symptom?.trim();
    if (!symptom) throw new EngramAccessInputError("symptom is required");
    const resolvedNs = this.resolveWritableNamespace(request.namespace, undefined, request.principal);
    const storage = await this.orchestrator.getStorage(resolvedNs);
    const created = await storage.appendContinuityIncident({
      symptom,
      triggerWindow: request.triggerWindow?.trim() || undefined,
      suspectedCause: request.suspectedCause?.trim() || undefined,
    });
    return { created: true, incident: created };
  }

  async continuityIncidentClose(request: {
    id: string;
    namespace?: string;
    principal?: string;
    fixApplied: string;
    verificationResult: string;
    preventiveRule?: string;
  }): Promise<unknown> {
    if (!this.orchestrator.config.identityContinuityEnabled) {
      return { enabled: false, reason: "Identity continuity is disabled." };
    }
    if (!this.orchestrator.config.continuityIncidentLoggingEnabled) {
      return { enabled: false, reason: "Continuity incident logging is disabled." };
    }
    const id = request.id?.trim();
    if (!id) throw new EngramAccessInputError("id is required");
    const fixApplied = request.fixApplied?.trim();
    if (!fixApplied) throw new EngramAccessInputError("fixApplied is required");
    const verificationResult = request.verificationResult?.trim();
    if (!verificationResult) throw new EngramAccessInputError("verificationResult is required");
    const resolvedNs = this.resolveWritableNamespace(request.namespace, undefined, request.principal);
    const storage = await this.orchestrator.getStorage(resolvedNs);
    const closed = await storage.closeContinuityIncident(id, {
      fixApplied,
      verificationResult,
      preventiveRule: request.preventiveRule?.trim() || undefined,
    });
    if (!closed) return { closed: false, reason: `Incident not found: ${id}` };
    return { closed: true, incident: closed };
  }

  async continuityIncidentList(request: {
    state?: "open" | "closed" | "all";
    namespace?: string;
    principal?: string;
    limit?: number;
  }): Promise<unknown> {
    if (!this.orchestrator.config.identityContinuityEnabled) {
      return { enabled: false, reason: "Identity continuity is disabled." };
    }
    const state = request.state === "closed" || request.state === "all" ? request.state : "open";
    const limit = Math.max(1, Math.min(200, Math.floor(request.limit ?? 25)));
    const resolvedNs = this.resolveReadableNamespace(request.namespace, request.principal);
    const storage = await this.orchestrator.getStorage(resolvedNs);
    const incidents = await storage.readContinuityIncidents(limit, state);
    return { state, incidents, count: incidents.length };
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
    if (!this.orchestrator.config.identityContinuityEnabled) {
      return { enabled: false, reason: "Identity continuity is disabled." };
    }
    const resolvedNs = this.resolveWritableNamespace(request.namespace, undefined, request.principal);
    const storage = await this.orchestrator.getStorage(resolvedNs);
    const loop = await storage.upsertIdentityImprovementLoop({
      id: request.id?.trim() || "",
      cadence: request.cadence,
      purpose: request.purpose?.trim() || "",
      status: request.status,
      killCondition: request.killCondition?.trim() || "",
      lastReviewed: request.lastReviewed?.trim() || undefined,
      notes: request.notes?.trim() || undefined,
    });
    return { saved: true, loop };
  }

  async continuityLoopReview(request: {
    id: string;
    namespace?: string;
    principal?: string;
    status?: "active" | "paused" | "retired";
    notes?: string;
    reviewedAt?: string;
  }): Promise<unknown> {
    if (!this.orchestrator.config.identityContinuityEnabled) {
      return { enabled: false, reason: "Identity continuity is disabled." };
    }
    const id = request.id?.trim();
    if (!id) throw new EngramAccessInputError("id is required");
    const resolvedNs = this.resolveWritableNamespace(request.namespace, undefined, request.principal);
    const storage = await this.orchestrator.getStorage(resolvedNs);
    const reviewed = await storage.reviewIdentityImprovementLoop(id, {
      status: request.status,
      notes: request.notes?.trim() || undefined,
      reviewedAt: request.reviewedAt?.trim() || undefined,
    });
    if (!reviewed) return { reviewed: false, reason: `Continuity loop not found: ${id}` };
    return { reviewed: true, loop: reviewed };
  }

  async identityAnchorGet(request: {
    namespace?: string;
    principal?: string;
  }): Promise<unknown> {
    if (!this.orchestrator.config.identityContinuityEnabled) {
      return { enabled: false, reason: "Identity continuity is disabled." };
    }
    const resolvedNs = this.resolveReadableNamespace(request.namespace, request.principal);
    const storage = await this.orchestrator.getStorage(resolvedNs);
    const anchor = await storage.readIdentityAnchor();
    if (!anchor) return { found: false, message: "No identity anchor found yet. Use identity_anchor_update to create one." };
    return { found: true, anchor };
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
    if (!this.orchestrator.config.identityContinuityEnabled) {
      return { enabled: false, reason: "Identity continuity is disabled." };
    }

    const updates: Record<string, string | undefined> = {
      "Identity Traits": request.identityTraits?.trim() || undefined,
      "Communication Preferences": request.communicationPreferences?.trim() || undefined,
      "Operating Principles": request.operatingPrinciples?.trim() || undefined,
      "Continuity Notes": request.continuityNotes?.trim() || undefined,
    };
    const hasUpdate = Object.values(updates).some((v) => typeof v === "string" && v.length > 0);
    if (!hasUpdate) throw new EngramAccessInputError("At least one section field is required.");

    const resolvedNs = this.resolveWritableNamespace(request.namespace, undefined, request.principal);
    const storage = await this.orchestrator.getStorage(resolvedNs);
    const existing = await storage.readIdentityAnchor();

    // Merge sections conservatively (append, don't overwrite)
    const merged = this.mergeIdentityAnchorSections(existing, updates);
    await storage.writeIdentityAnchor(merged);

    const updatedSections = Object.entries(updates)
      .filter(([, v]) => typeof v === "string" && v.length > 0)
      .map(([name]) => name);
    return { updated: true, sections: updatedSections, anchor: merged };
  }

  async memoryIdentity(request: {
    namespace?: string;
    principal?: string;
  }): Promise<unknown> {
    const resolvedNs = this.resolveReadableNamespace(request.namespace, request.principal);
    const storage = await this.orchestrator.getStorage(resolvedNs);
    const identity = await storage.readIdentityReflections();
    if (!identity) return { found: false, message: "No identity reflections found." };
    return { found: true, identity };
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
    const STATUSES = new Set(["todo", "in_progress", "blocked", "done", "cancelled"]);
    const PRIORITIES = new Set(["low", "medium", "high"]);
    const asStatus = (v?: string) => (v && STATUSES.has(v) ? v as "todo" | "in_progress" | "blocked" | "done" | "cancelled" : undefined);
    const asPriority = (v?: string) => (v && PRIORITIES.has(v) ? v as "low" | "medium" | "high" : undefined);

    const storage = new WorkStorage(this.orchestrator.config.memoryDir);
    await storage.ensureDirectories();
    const action = request.action;

    if (action === "create") {
      if (!request.title?.trim()) throw new EngramAccessInputError("title is required for create");
      const task = await storage.createTask({
        title: request.title,
        description: request.description,
        status: asStatus(request.status),
        priority: asPriority(request.priority),
        owner: request.owner?.trim() || undefined,
        assignee: request.assignee?.trim() || undefined,
        projectId: request.projectId?.trim() || undefined,
        tags: request.tags,
        dueAt: request.dueAt?.trim() || undefined,
      });
      return { action, task };
    }
    if (action === "get") {
      if (!request.id?.trim()) throw new EngramAccessInputError("id is required for get");
      return { action, task: await storage.getTask(request.id) };
    }
    if (action === "list") {
      const tasks = await storage.listTasks({
        status: asStatus(request.status),
        owner: request.owner?.trim() || undefined,
        assignee: request.assignee?.trim() || undefined,
        projectId: request.projectId?.trim() || undefined,
      });
      return { action, count: tasks.length, tasks };
    }
    if (action === "update") {
      if (!request.id?.trim()) throw new EngramAccessInputError("id is required for update");
      const patch: Record<string, unknown> = {};
      if (request.title !== undefined) patch.title = request.title;
      if (request.description !== undefined) patch.description = request.description;
      const st = asStatus(request.status); if (st) patch.status = st;
      const pr = asPriority(request.priority); if (pr) patch.priority = pr;
      if (request.owner !== undefined) patch.owner = request.owner || null;
      if (request.assignee !== undefined) patch.assignee = request.assignee || null;
      if (request.projectId !== undefined) patch.projectId = request.projectId || null;
      if (request.tags) patch.tags = request.tags;
      if (request.dueAt !== undefined) patch.dueAt = request.dueAt || null;
      return { action, task: await storage.updateTask(request.id, patch as any) };
    }
    if (action === "transition") {
      if (!request.id?.trim()) throw new EngramAccessInputError("id is required for transition");
      const st = asStatus(request.status);
      if (!st) throw new EngramAccessInputError("valid status is required for transition");
      return { action, task: await storage.transitionTask(request.id, st) };
    }
    if (action === "delete") {
      if (!request.id?.trim()) throw new EngramAccessInputError("id is required for delete");
      return { action, deleted: await storage.deleteTask(request.id) };
    }
    throw new EngramAccessInputError(`Unsupported work_task action: ${action}`);
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
    const STATUSES = new Set(["active", "on_hold", "completed", "archived"]);
    const asStatus = (v?: string) => (v && STATUSES.has(v) ? v as "active" | "on_hold" | "completed" | "archived" : undefined);

    const storage = new WorkStorage(this.orchestrator.config.memoryDir);
    await storage.ensureDirectories();
    const action = request.action;

    if (action === "create") {
      if (!request.name?.trim()) throw new EngramAccessInputError("name is required for create");
      const project = await storage.createProject({
        name: request.name,
        description: request.description,
        status: asStatus(request.status),
        owner: request.owner?.trim() || undefined,
        tags: request.tags,
      });
      return { action, project };
    }
    if (action === "get") {
      if (!request.id?.trim()) throw new EngramAccessInputError("id is required for get");
      return { action, project: await storage.getProject(request.id) };
    }
    if (action === "list") {
      const projects = await storage.listProjects();
      return { action, count: projects.length, projects };
    }
    if (action === "update") {
      if (!request.id?.trim()) throw new EngramAccessInputError("id is required for update");
      const patch: Record<string, unknown> = {};
      if (request.name !== undefined) patch.name = request.name;
      if (request.description !== undefined) patch.description = request.description;
      const st = asStatus(request.status); if (st) patch.status = st;
      if (request.owner !== undefined) patch.owner = request.owner || null;
      if (request.tags) patch.tags = request.tags;
      return { action, project: await storage.updateProject(request.id, patch as any) };
    }
    if (action === "delete") {
      if (!request.id?.trim()) throw new EngramAccessInputError("id is required for delete");
      return { action, deleted: await storage.deleteProject(request.id) };
    }
    if (action === "link_task") {
      if (!request.taskId?.trim() || !request.projectId?.trim()) {
        throw new EngramAccessInputError("taskId and projectId are required for link_task");
      }
      return { action, linked: await storage.linkTaskToProject(request.taskId, request.projectId) };
    }
    throw new EngramAccessInputError(`Unsupported work_project action: ${action}`);
  }

  async workBoard(request: {
    action: "export_markdown" | "export_snapshot" | "import_snapshot";
    projectId?: string;
    snapshotJson?: string;
    linkToMemory?: boolean;
  }): Promise<unknown> {
    const memoryDir = this.orchestrator.config.memoryDir;
    await new WorkStorage(memoryDir).ensureDirectories();
    const action = request.action;
    const projectId = request.projectId?.trim() || undefined;

    if (action === "export_markdown") {
      const markdown = await exportWorkBoardMarkdown({ memoryDir, projectId });
      return { action, markdown: wrapWorkLayerContext(markdown, { linkToMemory: request.linkToMemory === true }) };
    }
    if (action === "export_snapshot") {
      const snapshot = await exportWorkBoardSnapshot({ memoryDir, projectId });
      return { action, snapshot };
    }
    if (action === "import_snapshot") {
      if (!request.snapshotJson?.trim()) throw new EngramAccessInputError("snapshotJson is required for import_snapshot");
      const snapshot = JSON.parse(request.snapshotJson);
      const result = await importWorkBoardSnapshot({ memoryDir, snapshot, projectId });
      return { action, result };
    }
    throw new EngramAccessInputError(`Unsupported work_board action: ${action}`);
  }

  // ── Shared Context / Compounding ────────────────────────────────────────

  async sharedContextWriteOutput(request: {
    agentId: string;
    title: string;
    content: string;
  }): Promise<unknown> {
    if (!this.orchestrator.sharedContext) {
      return { enabled: false, reason: "Shared context is disabled. Enable `sharedContextEnabled: true`." };
    }
    const fp = await this.orchestrator.sharedContext.writeAgentOutput({
      agentId: request.agentId,
      title: request.title,
      content: request.content,
    });
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

  // ── Compression Guidelines ────────────────────────────────────────────

  async compressionGuidelinesOptimize(request: {
    dryRun?: boolean;
    eventLimit?: number;
  }): Promise<unknown> {
    if (!this.orchestrator.config.compressionGuidelineLearningEnabled) {
      return { enabled: false, reason: "Compression guideline learning is disabled. Enable `compressionGuidelineLearningEnabled: true`." };
    }
    return await this.orchestrator.optimizeCompressionGuidelines({
      dryRun: request.dryRun,
      eventLimit: request.eventLimit,
    });
  }

  async compressionGuidelinesActivate(request: {
    expectedContentHash?: string;
    expectedGuidelineVersion?: number;
  }): Promise<unknown> {
    if (!this.orchestrator.config.compressionGuidelineLearningEnabled) {
      return { enabled: false, reason: "Compression guideline learning is disabled." };
    }
    return await this.orchestrator.activateCompressionGuidelineDraft({
      expectedContentHash: request.expectedContentHash,
      expectedGuidelineVersion: request.expectedGuidelineVersion,
    });
  }

  /** Conservative identity anchor section merge (matches tools.ts mergeIdentityAnchor logic). */
  private mergeIdentityAnchorSections(
    existingRaw: string | null,
    updates: Record<string, string | undefined>,
  ): string {
    const TITLE = "# Identity Continuity Anchor";
    const SECTION_ORDER = ["Identity Traits", "Communication Preferences", "Operating Principles", "Continuity Notes"];

    const lines = (existingRaw ?? "").replace(/\r/g, "").split("\n");
    const headerLines: string[] = [];
    const sectionContent = new Map<string, string[]>();
    const order: string[] = [];
    let current: string | null = null;
    for (const line of lines) {
      const m = line.match(/^##\s+(.+?)\s*$/);
      if (m) { current = m[1].trim(); if (!sectionContent.has(current)) { sectionContent.set(current, []); order.push(current); } continue; }
      if (!current) { headerLines.push(line); } else { sectionContent.get(current)?.push(line); }
    }
    const sections = new Map<string, string>();
    for (const [name, cLines] of sectionContent) sections.set(name, cLines.join("\n").trim());

    const header = headerLines.join("\n").trim() || TITLE;
    for (const sectionName of SECTION_ORDER) {
      const prev = sections.get(sectionName)?.trim();
      const next = updates[sectionName]?.trim();
      const existing = prev === "- (empty)" ? "" : prev;
      if (!next) { if (!sections.has(sectionName)) sections.set(sectionName, ""); continue; }
      if (!existing) { sections.set(sectionName, next); continue; }
      if (existing.includes(next)) continue;
      if (next.includes(existing)) { sections.set(sectionName, next); continue; }
      sections.set(sectionName, `${existing}\n\n${next}`);
    }

    const finalOrder = [...SECTION_ORDER.filter((s) => sections.has(s)), ...order.filter((s) => !SECTION_ORDER.includes(s) && sections.has(s))];
    const out: string[] = [header, ""];
    for (const name of finalOrder) {
      out.push(`## ${name}`, "");
      const body = sections.get(name)?.trim();
      if (body) out.push(body, "");
      else out.push("");
    }
    return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  }

  // ── Memory search & debug ─────────────────────────────────────────────

  async memorySearch(request: {
    query: string;
    namespace?: string;
    maxResults?: number;
    collection?: string;
    principal?: string;
  }): Promise<{ query: string; results: Array<{ path: string; score: number; snippet: string }>; count: number }> {
    const { query, namespace, maxResults, collection, principal } = request;
    const resolvedNs = this.resolveReadableNamespace(namespace, principal);
    const namespaceFilter = resolvedNs !== this.orchestrator.config.defaultNamespace ? resolvedNs : undefined;

    const results = collection === "global"
      ? (await this.orchestrator.qmd.searchGlobal(query, maxResults)).filter((r) =>
          namespaceFilter
            ? r.path.includes(`/namespaces/${namespaceFilter}/`) ||
              (!r.path.includes("/namespaces/") && namespaceFilter === this.orchestrator.config.defaultNamespace)
            : true,
        )
      : await this.orchestrator.searchAcrossNamespaces({
          query,
          namespaces: namespaceFilter ? [namespaceFilter] : undefined,
          maxResults,
          mode: "search",
        });

    return {
      query,
      results: results.map((r) => ({
        path: r.path,
        score: r.score,
        snippet: (r.snippet ?? "").slice(0, 800),
      })),
      count: results.length,
    };
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

  async memoryQuestions(namespace?: string, principal?: string): Promise<{ questions: Array<{ id: string; question: string; resolved: boolean }>; count: number }> {
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
    const snapshot = await this.orchestrator.getLastIntentSnapshot(namespace);
    return snapshot ?? { message: "No intent debug snapshot available" };
  }

  async qmdDebug(namespace?: string): Promise<unknown> {
    const snapshot = await this.orchestrator.getLastQmdRecallSnapshot(namespace);
    return snapshot ?? { message: "No QMD debug snapshot available" };
  }

  async graphExplainLastRecall(namespace?: string): Promise<unknown> {
    const explanation = await this.orchestrator.explainLastGraphRecall({ namespace });
    return { explanation };
  }

  /**
   * Read-only graph snapshot for the admin pane (issue #691 PR 2/5).
   *
   * Reads adjacency from the JSONL edge store written by `GraphIndex` and
   * resolves node metadata via the namespaced storage manager.  Namespace
   * resolution mirrors the read-side path used by `recall` /
   * `procedureStats`, so multi-principal deployments can't leak edges from
   * a peer namespace (CLAUDE.md rule 42).
   */
  async graphSnapshot(
    request: GraphSnapshotRequest & { namespace?: string },
    authenticatedPrincipal?: string,
  ): Promise<GraphSnapshotResponse> {
    const namespace = this.resolveReadableNamespace(
      request.namespace,
      authenticatedPrincipal,
    );
    const storage = await this.orchestrator.getStorage(namespace);
    const cfg = this.orchestrator.config;
    // Canonicalize the storage root once — through `realpath` so that any
    // symlink in the namespace root path itself is resolved before we
    // compare children against it.  This is required because
    // `GraphEdge.from` / `to` are JSONL-parsed strings — a malformed edge
    // with an absolute path, a `..` segment, OR a symlink that resolves
    // to a file outside the namespace would otherwise read a memory file
    // from a peer namespace, leaking metadata across tenants
    // (codex P1 + follow-up on PR #734; CLAUDE.md rule 42).
    let namespaceRootReal: string;
    try {
      namespaceRootReal = await nodeFs.realpath(storage.dir);
    } catch {
      // If the namespace root itself doesn't exist on disk yet (fresh
      // install with no memories), fall back to the lexical resolve so
      // the snapshot can still return an empty result rather than
      // throwing.  No symlink can resolve through a missing path, so
      // this fallback is safe — every candidate we see will fail the
      // realpath step below and surface as `null`.
      namespaceRootReal = nodePath.resolve(storage.dir);
    }
    const namespaceRootWithSep = namespaceRootReal.endsWith(nodePath.sep)
      ? namespaceRootReal
      : namespaceRootReal + nodePath.sep;
    const loadNode = async (relPath: string): Promise<GraphSnapshotNodeMetadata | null> => {
      // `GraphEdge.from` / `to` are storage-relative paths; resolve against
      // the namespaced storage root so the metadata read honors namespace
      // boundaries even when the same memory id exists in multiple
      // namespaces.
      //
      // Three-stage guard:
      //   1. Reject absolute paths up front — only relative endpoints are
      //      ever produced by the writer, so anything else is malformed.
      //   2. Lexical containment check on the resolved path.  This catches
      //      `..` traversals before we touch the filesystem.
      //   3. `fs.realpath` containment check — resolves symlinks so an
      //      in-namespace path that *points* at an out-of-namespace file
      //      is still rejected.  Without this step a symlinked endpoint
      //      could leak a peer namespace's frontmatter.
      // Bad paths surface a length-only warning (never echo the offending
      // segments — those would themselves cross namespace boundaries
      // through the log surface) and fall through to a `null` metadata
      // result.
      if (nodePath.isAbsolute(relPath)) {
        log.warn(
          `graphSnapshot: rejected absolute edge endpoint (len=${relPath.length}) `
          + `outside namespace root`,
        );
        return null;
      }
      const candidate = nodePath.resolve(namespaceRootReal, relPath);
      if (candidate !== namespaceRootReal && !candidate.startsWith(namespaceRootWithSep)) {
        log.warn(
          `graphSnapshot: rejected traversing edge endpoint (len=${relPath.length}) `
          + `outside namespace root`,
        );
        return null;
      }
      let canonical: string;
      try {
        canonical = await nodeFs.realpath(candidate);
      } catch {
        // Missing file — `readMemoryByPath` will return null too.  We
        // intentionally still call it so callers see a consistent
        // "unknown" result rather than special-casing missing edges.
        canonical = candidate;
      }
      if (canonical !== namespaceRootReal && !canonical.startsWith(namespaceRootWithSep)) {
        log.warn(
          `graphSnapshot: rejected symlinked edge endpoint (len=${relPath.length}) `
          + `that resolved outside namespace root`,
        );
        return null;
      }
      // Both `canonical` (realpath of candidate) and `namespaceRootReal`
      // (realpath of storage.dir) are fully resolved here, so the
      // containment check above is comparing apples-to-apples even when
      // storage.dir (= storage.baseDir) is itself a symlink to the real
      // directory.  Pass `canonical` — not the pre-realpath `candidate` —
      // so the storage read also uses the stable real path.
      const memory = await storage.readMemoryByPath(canonical);
      if (!memory) return null;
      const fm = memory.frontmatter;
      return {
        category: fm.category ?? "unknown",
        label: fm.id ?? nodePath.basename(canonical, nodePath.extname(canonical)),
        updated: fm.updated,
      };
    };
    // Use the realpath-resolved namespace root for the edge-file read so
    // the JSONL location is stable whether storage.dir is a direct path
    // or a symlink.  namespaceRootReal was computed via `fs.realpath`
    // above; using it here keeps both the graph-file I/O and the loadNode
    // containment check on the same resolved base path.
    return buildGraphSnapshot({
      memoryDir: namespaceRootReal,
      graphConfig: {
        entityGraphEnabled: cfg.entityGraphEnabled === true,
        timeGraphEnabled: cfg.timeGraphEnabled === true,
        causalGraphEnabled: cfg.causalGraphEnabled === true,
      },
      request: {
        limit: request.limit,
        since: request.since,
        focusNodeId: request.focusNodeId,
        categories: request.categories,
      },
      loadNode,
    });
  }

  async memoryFeedback(request: {
    memoryId: string;
    vote: "up" | "down";
    note?: string;
  }): Promise<{ recorded: boolean; enabled?: boolean; reason?: string }> {
    if (!this.orchestrator.config.feedbackEnabled) {
      return {
        recorded: false,
        enabled: false,
        reason: "Feedback is disabled. Enable `feedbackEnabled: true` in the Engram config to store feedback.",
      };
    }
    await this.orchestrator.recordMemoryFeedback(
      request.memoryId,
      request.vote,
      request.note,
    );
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
      throw new EngramAccessInputError(
        "memoryId must not contain path separators",
      );
    }
    const resolvedNs = this.resolveWritableNamespace(
      request.namespace,
      request.sessionKey,
      request.principal,
    );
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
    const resolvedNs = this.resolveWritableNamespace(request.namespace, request.sessionKey, request.principal);
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
    const actionTypes = new Set<MemoryActionType>([
      "store_episode",
      "store_note",
      "update_note",
      "create_artifact",
      "summarize_node",
      "discard",
      "link_graph",
    ]);
    if (!actionTypes.has(request.action as MemoryActionType)) {
      throw new EngramAccessInputError(
        `memory_action_apply: invalid action ${JSON.stringify(request.action)}`,
      );
    }

    if (this.orchestrator.config.contextCompressionActionsEnabled !== true) {
      throw new EngramAccessInputError(
        "memory_action_apply is disabled; enable contextCompressionActionsEnabled to use this tool",
      );
    }

    const outcome = request.outcome ?? "skipped";
    if (outcome !== "applied" && outcome !== "skipped" && outcome !== "failed") {
      throw new EngramAccessInputError(
        `memory_action_apply: outcome must be "applied", "skipped", or "failed"; got ${JSON.stringify(outcome)}`,
      );
    }

    const resolvedNs = this.resolveWritableNamespace(
      request.namespace,
      request.sessionKey,
      request.principal,
    );
    const inputSummaryParts = [
      request.content,
      request.category ? `category=${request.category}` : undefined,
      request.linkTargetId ? `linkTargetId=${request.linkTargetId}` : undefined,
      request.linkType ? `linkType=${request.linkType}` : undefined,
      typeof request.linkStrength === "number"
        ? `linkStrength=${request.linkStrength}`
        : undefined,
      request.artifactType ? `artifactType=${request.artifactType}` : undefined,
      typeof request.execute === "boolean" ? `execute=${request.execute}` : undefined,
    ].filter((part): part is string => typeof part === "string" && part.length > 0);

    const event = {
      action: request.action as MemoryActionType,
      outcome: outcome as MemoryActionOutcome,
      namespace: resolvedNs,
      actor: "access.memory_action_apply",
      subsystem: "access.memory_action_apply",
      reason: request.reason,
      memoryId: request.memoryId,
      sourceSessionKey: request.sessionKey,
      inputSummary: inputSummaryParts.length > 0
        ? inputSummaryParts.join(" | ").slice(0, 500)
        : undefined,
      dryRun: request.dryRun === true,
      promptHash:
        typeof request.sourcePrompt === "string" && request.sourcePrompt.length > 0
          ? createHash("sha256").update(request.sourcePrompt).digest("hex")
          : undefined,
    };
    const preview = this.orchestrator.previewMemoryActionEvent(event);
    if (request.dryRun === true) {
      return { recorded: false, dryRun: true, event: preview };
    }

    const recorded = await this.orchestrator.appendMemoryActionEvent(event);
    return { recorded, event: preview };
  }

  async contextCheckpoint(request: {
    sessionKey: string;
    context: string;
    namespace?: string;
    principal?: string;
  }): Promise<{ saved: boolean }> {
    const resolvedNs = this.resolveWritableNamespace(request.namespace, request.sessionKey, request.principal);
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

  /**
   * Record citation usage from an observed oai-mem-citation block.
   * For each citation entry, extract the memory ID from the path and
   * increment its access tracking via the orchestrator. Returns the
   * count of submitted IDs and the count of IDs that matched real memories.
   */
  async recordCitationUsage(request: {
    sessionId?: string;
    namespace?: string;
    authenticatedPrincipal?: string;
    entries: Array<{ path: string; lineStart: number; lineEnd: number; note: string }>;
    rolloutIds: string[];
  }): Promise<{ submitted: number; matched: number }> {
    if (request.entries.length === 0) return { submitted: 0, matched: 0 };

    // Enforce namespace ACLs — citation tracking is a write-like operation.
    // Pass authenticatedPrincipal so the principal resolution matches other
    // write endpoints (gotcha #42: read and write paths must resolve through
    // the same namespace layer).
    const resolvedNamespace = this.resolveWritableNamespace(
      request.namespace,
      request.sessionId,
      request.authenticatedPrincipal,
    );

    // Extract memory IDs from citation paths. The path in citations
    // follows the pattern `facts/<id>.md` or just `<id>.md`.
    const memoryIds: string[] = [];
    for (const entry of request.entries) {
      // Strip directory prefix and .md extension to derive the memory ID.
      const basename = entry.path.split("/").pop() ?? entry.path;
      const id = basename.endsWith(".md") ? basename.slice(0, -3) : basename;
      if (id.length > 0) {
        memoryIds.push(id);
      }
    }

    if (memoryIds.length === 0) return { submitted: 0, matched: 0 };

    // Determine which IDs correspond to real memories in storage using a
    // targeted file-existence scan instead of loading all memories (Finding #2).
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    const existingIds = await storage.filterExistingMemoryIds(memoryIds);
    const matchedIds = memoryIds.filter((id) => existingIds.has(id));

    if (matchedIds.length > 0) {
      try {
        this.orchestrator.trackMemoryAccess(matchedIds);
      } catch {
        // Fail gracefully — citation usage tracking is best-effort.
        log.debug("citation usage tracking: failed to record access for cited memories");
      }
    }

    return { submitted: memoryIds.length, matched: matchedIds.length };
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
    principal?: string,
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
  async peerGet(
    peerId: string,
  ): Promise<
    | { found: true; peer: import("./peers/types.js").Peer }
    | { found: false }
  > {
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
        throw new EngramAccessInputError(
          `peer kind must be one of ${[...ALLOWED_KINDS].join(", ")}`,
        );
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
  async peerForget(
    peerId: string,
    opts: { confirm: string },
  ): Promise<{ ok: true; purged: boolean }> {
    const peers = await import("./peers/index.js");
    const validateId: (id: unknown) => void = peers.assertValidPeerId;
    try {
      validateId(peerId);
    } catch (err) {
      throw new EngramAccessInputError((err as Error).message);
    }
    if (opts.confirm !== "yes") {
      throw new EngramAccessInputError(
        "peerForget requires confirm: 'yes' to prevent accidental data loss",
      );
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
    peerId: string,
  ): Promise<
    | { found: true; profile: import("./peers/types.js").PeerProfile }
    | { found: false }
  > {
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

  async getReadableStorageForNamespace(namespace?: string, principal?: string): Promise<{
    namespace: string;
    storage: StorageManager;
  }> {
    const resolved = this.resolveReadableNamespace(namespace, principal);
    const storage = await this.orchestrator.getStorage(resolved);
    return { namespace: resolved, storage };
  }

  async getWritableStorageForNamespace(namespace?: string, principal?: string): Promise<{
    namespace: string;
    storage: StorageManager;
  }> {
    if (this.orchestrator.config.namespacesEnabled && !principal?.trim()) {
      throw new EngramAccessInputError(
        "authentication required: namespaces are enabled and no principal was supplied",
      );
    }
    const resolved = this.resolveWritableNamespace(namespace, undefined, principal);
    const storage = await this.orchestrator.getStorage(resolved);
    return { namespace: resolved, storage };
  }

  get storageRef(): StorageManager {
    return this.orchestrator.storage;
  }

  get configRef(): PluginConfig {
    return this.orchestrator.config;
  }

  get localLlmRef(): LocalLlmClient | null {
    return this.orchestrator.localLlm ?? null;
  }

  get fallbackLlmRef(): FallbackLlmClient | null {
    return this.orchestrator.fastGatewayLlm ?? null;
  }

  get embeddingLookupFactoryRef(): (storage: import("./storage.js").StorageManager) => SemanticDedupLookup | undefined {
    return (storage) => {
      if (!this.orchestrator.config.embeddingFallbackEnabled) return undefined;
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
    },
  ): Promise<ImportCapsuleResult> {
    const { namespace, principal, root: explicitRoot, memoryDir: explicitMemoryDir, ...importOptions } = opts;
    const resolvedNamespace = this.resolveWritableNamespace(namespace, undefined, principal);
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    const root = explicitRoot ?? storage.dir;
    const memoryDir = explicitMemoryDir ?? this.orchestrator.config.memoryDir;
    const versioning = importOptions.versioning ?? {
      enabled: this.orchestrator.config.versioningEnabled,
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
    const code = typeof err === "object" && err !== null && "code" in err
      ? (err as { code?: unknown }).code
      : undefined;
    return (
      code === "ENOENT" ||
      code === "ENOTDIR" ||
      code === "EACCES" ||
      code === "EPERM" ||
      code === "ELOOP"
    );
  }

  private isCapsuleImportArchiveInputError(err: unknown, message: string): boolean {
    if (err instanceof ZodError) return true;
    const code = typeof err === "object" && err !== null && "code" in err
      ? (err as { code?: unknown }).code
      : undefined;
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
    },
  ): Promise<ExportCapsuleResult> {
    const { namespace, principal, root: explicitRoot, memoryDir: explicitMemoryDir, ...exportOptions } = opts;
    const resolvedNamespace = this.resolveWritableNamespace(namespace, undefined, principal);
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    const root = explicitRoot ?? storage.dir;
    const memoryDir = explicitMemoryDir ?? this.orchestrator.config.memoryDir;
    const pluginVersion = exportOptions.pluginVersion ?? await getPackageVersion();
    return exportCapsuleFn({
      ...exportOptions,
      pluginVersion,
      root,
      memoryDir: exportOptions.encrypt === true ? memoryDir : undefined,
    });
  }

  /**
   * List capsule archives in the namespace-scoped capsule store.
   *
   * MCP uses this access-layer method instead of reading arbitrary paths so
   * capsule discovery remains bound to the same namespace ACLs as export and
   * import.
   */
  async capsuleList(options?: {
    namespace?: string;
    principal?: string;
  }): Promise<EngramAccessCapsuleListResponse> {
    const resolvedNamespace = this.resolveReadableNamespace(options?.namespace, options?.principal);
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    const capsulesDir = defaultCapsulesDir(storage.dir);
    let dirEntries: import("node:fs").Dirent[];
    try {
      const capsulesDirStat = await nodeFs.lstat(capsulesDir);
      if (capsulesDirStat.isSymbolicLink()) {
        throw new EngramAccessInputError("capsule list failed: capsule store directory must not be a symlink");
      }
      if (!capsulesDirStat.isDirectory()) {
        throw new EngramAccessInputError("capsule list failed: capsule store path must be a directory");
      }
      dirEntries = await nodeFs.readdir(capsulesDir, { withFileTypes: true });
    } catch (err) {
      const code = typeof err === "object" && err !== null && "code" in err
        ? (err as { code?: unknown }).code
        : undefined;
      if (code === "ENOENT") {
        return { namespace: resolvedNamespace, capsulesDir, capsules: [] };
      }
      throw err;
    }

    const archiveNames = dirEntries
      .filter(
        (entry) =>
          entry.isFile() &&
          (entry.name.endsWith(".capsule.json.gz") ||
            entry.name.endsWith(".capsule.json.gz.enc")),
      )
      .map((entry) => entry.name)
      .sort();

    const capsules: CapsuleListEntry[] = [];
    for (const archiveName of archiveNames) {
      const archivePath = nodePath.join(capsulesDir, archiveName);
      const id = archiveName
        .replace(/\.capsule\.json\.gz\.enc$/, "")
        .replace(/\.capsule\.json\.gz$/, "");
      const manifestPath = nodePath.join(capsulesDir, `${id}.manifest.json`);

      let createdAt: string | null = null;
      let pluginVersion: string | null = null;
      let fileCount: number | null = null;
      let description: string | null = null;
      let manifestPathOrNull: string | null = manifestPath;

      try {
        const manifestStat = await nodeFs.lstat(manifestPath);
        if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
          capsules.push({
            id,
            archivePath,
            manifestPath: manifestPathOrNull,
            createdAt,
            pluginVersion,
            fileCount,
            description,
          });
          continue;
        }
        const raw = await nodeFs.readFile(manifestPath, "utf-8");
        const sidecar = JSON.parse(raw) as Record<string, unknown>;
        createdAt = typeof sidecar.createdAt === "string" ? sidecar.createdAt : null;
        pluginVersion = typeof sidecar.pluginVersion === "string" ? sidecar.pluginVersion : null;
        fileCount = Array.isArray(sidecar.files) ? sidecar.files.length : null;
        const capsule = sidecar.capsule as Record<string, unknown> | undefined;
        description = capsule && typeof capsule.description === "string"
          ? capsule.description
          : null;
      } catch (err) {
        const code = typeof err === "object" && err !== null && "code" in err
          ? (err as { code?: unknown }).code
          : undefined;
        if (code === "ENOENT") {
          manifestPathOrNull = null;
        }
      }

      capsules.push({
        id,
        archivePath,
        manifestPath: manifestPathOrNull,
        createdAt,
        pluginVersion,
        fileCount,
        description,
      });
    }

    return { namespace: resolvedNamespace, capsulesDir, capsules };
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

  /**
   * Manually invoke a single Dreams phase pass (PR 4/4).
   *
   * Deep-sleep delegates to memory governance (shadow → dry-run, apply → live).
   * Light-sleep and REM scan the observation ledger and memory corpus
   * respectively, returning the same telemetry shape as a scheduled run.
   */
  async dreamsRun(options: {
    phase: import("./types.js").DreamsPhase;
    dryRun?: boolean;
    namespace?: string;
    authenticatedPrincipal?: string;
  }): Promise<import("./types.js").DreamsRunResult> {
    const { runDreamsPhase } = await import("./maintenance/dreams-ledger.js");
    const validPhases = ["lightSleep", "rem", "deepSleep"];
    if (!validPhases.includes(options.phase)) {
      throw new EngramAccessInputError(
        `Invalid phase: ${String(options.phase)}. Must be one of: ${validPhases.join(", ")}`,
      );
    }
    const deepSleep = this.orchestrator.config.dreamsPhases.deepSleep;
    if (
      options.phase === "deepSleep" &&
      deepSleep.enabled === false &&
      deepSleep.enabledExplicitlySet === true
    ) {
      throw new EngramAccessInputError(
        "memory governance is disabled by dreams.phases.deepSleep.enabled=false",
      );
    }
    const dryRun = options.dryRun === true;
    const resolvedNamespace = this.resolveWritableNamespace(
      options.namespace,
      undefined,
      options.authenticatedPrincipal,
    );
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    const memoryDir = storage.dir;
    const phaseRunner = dryRun || options.phase === "deepSleep"
      ? undefined
      : async (_opts: { memoryDir: string; phase: "lightSleep" | "rem" }) => {
          if (_opts.phase === "lightSleep") {
            const result = await this.orchestrator.runLifecyclePolicyNow(storage);
            return {
              itemsProcessed: result.memoriesAssessed,
              notes: `scored ${result.memoriesAssessed} memories`,
            };
          }
          const result = await this.orchestrator.runSemanticConsolidationNow({
            dryRun: false,
            storage,
          });
          const itemsProcessed = result.clusters.reduce(
            (sum, cluster) => sum + cluster.memories.length,
            0,
          );
          return {
            itemsProcessed,
            notes: `REM consolidation found ${result.clustersFound} clusters`,
          };
        };
    const governanceRunner = options.phase === "deepSleep"
      ? async (_opts: { memoryDir: string; dryRun: boolean }) => {
          return this.orchestrator.runDeepSleepGovernanceNow({
            storage,
            dryRun: _opts.dryRun,
          });
        }
      : undefined;
    const result = await runDreamsPhase(
      { memoryDir, phase: options.phase, dryRun },
      governanceRunner,
      phaseRunner,
    );
    return {
      phase: result.phase,
      dryRun: result.dryRun,
      durationMs: result.durationMs,
      itemsProcessed: result.itemsProcessed,
      notes: result.notes,
    };
  }
}
