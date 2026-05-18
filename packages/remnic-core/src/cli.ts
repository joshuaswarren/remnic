import os from "node:os";
import path from "node:path";
import { access, readFile, readdir, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import type { Orchestrator } from "./orchestrator.js";
import { ThreadingManager } from "./threading.js";
import type {
  BehaviorSignalEvent,
  ContinuityIncidentRecord,
  MemoryActionEvent,
  MemoryFile,
  MemoryStatus,
  QmdSearchResult,
  RecallDisclosure,
  TranscriptEntry,
} from "./types.js";
import { isRecallDisclosure, RECALL_DISCLOSURE_LEVELS } from "./types.js";
import { chunkContent } from "./chunking.js";
import { rescoreMemoryImportance } from "./importance.js";
import { exportJsonBundle } from "./transfer/export-json.js";
import { exportMarkdownBundle } from "./transfer/export-md.js";
import { backupMemoryDir } from "./transfer/backup.js";
import { exportSqlite } from "./transfer/export-sqlite.js";
import { importJsonBundle } from "./transfer/import-json.js";
import { importSqlite } from "./transfer/import-sqlite.js";
import { importMarkdownBundle } from "./transfer/import-md.js";
import { detectImportFormat } from "./transfer/autodetect.js";
import { buildReplayNormalizerRegistry, clampBatchSize, runReplay, type ReplayRunSummary } from "./replay/runner.js";
import { chatgptReplayNormalizer } from "./replay/normalizers/chatgpt.js";
import { claudeReplayNormalizer } from "./replay/normalizers/claude.js";
import { openclawReplayNormalizer } from "./replay/normalizers/openclaw.js";
import { isReplaySource, normalizeReplaySessionKey, type ReplaySource, type ReplayTurn } from "./replay/types.js";
import {
  getBulkImportSource,
  listBulkImportSources,
  registerBulkImportSource,
  runBulkImportPipeline,
  type BulkImportResult,
  type BulkImportSourceAdapter,
  type ProcessBatchFn,
} from "./bulk-import/index.js";
import { archiveObservations } from "./maintenance/archive-observations.js";
import { rebuildMemoryLifecycleLedger } from "./maintenance/rebuild-memory-lifecycle-ledger.js";
import {
  listMemoryGovernanceRuns,
  readMemoryGovernanceRunArtifact,
  restoreMemoryGovernanceRun,
  runMemoryGovernance,
} from "./maintenance/memory-governance.js";
import {
  rebuildMemoryProjection,
  repairMemoryProjection,
  verifyMemoryProjection,
} from "./maintenance/rebuild-memory-projection.js";
import { rebuildObservations } from "./maintenance/rebuild-observations.js";
import { migrateObservations } from "./maintenance/migrate-observations.js";
import {
  listNamespaces,
  runNamespaceMigration,
  verifyNamespaces,
} from "./namespaces/migrate.js";
import {
  runBenchmarkRecall,
  runOperatorConfigReview,
  runOperatorDoctor,
  runOperatorInventory,
  runOperatorRepair,
  runOperatorSetup,
  type BenchmarkRecallReport,
  type OperatorConfigReviewReport,
  type OperatorDoctorReport,
  type OperatorInventoryReport,
  type OperatorRepairReport,
  type OperatorSetupReport,
} from "./operator-toolkit.js";
import { WorkStorage } from "./work/storage.js";
import type { WorkProjectStatus, WorkTaskPriority, WorkTaskStatus } from "./work/types.js";
import {
  selectRouteRule,
  validateRouteTarget,
  type RoutePatternType,
  type RouteRule,
  type RouteTarget,
} from "./routing/engine.js";
import { RoutingRulesStore } from "./routing/store.js";
import { TailscaleHelper, type TailscaleSyncOptions } from "./network/tailscale.js";
import { WebDavServer } from "./network/webdav.js";
import { GraphDashboardServer, type DashboardStatus } from "./dashboard-runtime.js";
import { EngramAccessService } from "./access-service.js";
import { EngramAccessHttpServer } from "./access-http.js";
import {
  buildActionConfidenceInputFromOptions,
  evaluateActionConfidence,
  renderActionConfidenceText,
} from "./action-confidence.js";
import {
  resolveAgentAccessAuthToken,
  type ResolveSecretRefFn,
} from "./resolve-auth-token.js";
import { EngramMcpServer } from "./access-mcp.js";
import { runCompatChecks } from "./compat/checks.js";
import { parseConfig } from "./config.js";
import type { CompatReport, CompatRunner } from "./compat/types.js";
import {
  createEvalBaselineSnapshot,
  getEvalHarnessStatus,
  importEvalBenchmarkPack,
  type EvalBaselineSnapshot,
  type EvalBaselineDeltaReport,
  type EvalBenchmarkPackSummary,
  type EvalCiGateReport,
  type EvalStoredBaselineCiGateReport,
  type EvalHarnessStatus,
  runEvalBaselineDeltaReport,
  runEvalBenchmarkCiGate,
  runEvalStoredBaselineCiGate,
  validateEvalBenchmarkPack,
} from "./evals.js";
import { analyzeGraphHealth, type GraphHealthReport } from "./graph.js";
import {
  getCausalTrajectoryStoreStatus,
  type CausalTrajectoryStoreStatus,
} from "./causal-trajectory.js";
import {
  getAbstractionNodeStoreStatus,
  type AbstractionNodeStoreStatus,
} from "./abstraction-nodes.js";
import {
  getCueAnchorStoreStatus,
  type CueAnchorStoreStatus,
} from "./cue-anchors.js";
import {
  searchHarmonicRetrieval,
  type HarmonicRetrievalResult,
} from "./harmonic-retrieval.js";
import {
  searchVerifiedEpisodes,
  type VerifiedEpisodeResult,
} from "./verified-recall.js";
import {
  searchVerifiedSemanticRules,
  type VerifiedSemanticRuleResult,
} from "./semantic-rule-verifier.js";
import {
  applyCommitmentLedgerLifecycle,
  getCommitmentLedgerStatus,
  recordCommitmentLedgerEntry,
  transitionCommitmentLedgerEntryState,
  type CommitmentLedgerEntry,
  type CommitmentLedgerLifecycleResult,
  type CommitmentLedgerStatus,
} from "./commitment-ledger.js";
import {
  getWorkProductLedgerStatus,
  recordWorkProductLedgerEntry,
  searchWorkProductLedgerEntries,
  type WorkProductLedgerEntry,
  type WorkProductLedgerSearchResult,
  type WorkProductLedgerStatus,
} from "./work-product-ledger.js";
import {
  getUtilityTelemetryStatus,
  recordUtilityTelemetryEvent,
  type UtilityTelemetryEvent,
  type UtilityTelemetryStatus,
} from "./utility-telemetry.js";
import {
  getUtilityLearningStatus,
  learnUtilityPromotionWeights,
  type UtilityLearningResult,
  type UtilityLearningStatus,
} from "./utility-learner.js";
import {
  buildResumeBundleFromState,
  getResumeBundleStatus,
  recordResumeBundle,
  type ResumeBundle,
  type ResumeBundleStatus,
} from "./resume-bundles.js";
import {
  promoteSemanticRuleFromMemory,
  type SemanticRulePromotionReport,
} from "./semantic-rule-promotion.js";
import { getObjectiveStateStoreStatus, type ObjectiveStateStoreStatus } from "./objective-state.js";
import {
  getTrustZoneStoreStatus,
  promoteTrustZoneRecord,
  seedTrustZoneDemoDataset,
  type TrustZoneDemoSeedResult,
  type TrustZoneName,
  type TrustZonePromotionResult,
  type TrustZoneStoreStatus,
} from "./trust-zones.js";
import {
  analyzeSessionIntegrity,
  applySessionRepair,
  planSessionRepair,
  type SessionIntegrityReport,
  type SessionRepairApplyResult,
  type SessionRepairPlan,
} from "./session-integrity.js";
import type { TierMigrationCycleSummary, TierMigrationStatusSnapshot } from "./recall-state.js";
import {
  readRuntimePolicySnapshot as readPolicyRuntimeSnapshot,
  sanitizeRuntimePolicyValues,
  type RuntimePolicyValues,
} from "./policy-runtime.js";
import { resolveHomeDir } from "./runtime/env.js";
import { expandTildePath } from "./utils/path.js";
import { convertMemoriesToRecords } from "./training-export/converter.js";
import { parseStrictCliDate as parseStrictCliDateShared } from "./training-export/date-parse.js";
import { getTrainingExportAdapter, listTrainingExportAdapters } from "./training-export/registry.js";
import { renderRecallExplain, parseRecallExplainFormat } from "./recall-explain-renderer.js";
import { renderXray } from "./recall-xray-renderer.js";
import { parseXrayCliOptions } from "./recall-xray-cli.js";
import {
  collectPatternMemories,
  explainPatternMemory,
  parsePatternsExplainOptions,
  parsePatternsListOptions,
  renderPatternExplain,
  renderPatternsList,
} from "./patterns-cli.js";
import {
  parseConnectorsListOptions,
  parseConnectorsRunName,
  parseConnectorsStatusOptions,
  renderConnectorsList,
  renderConnectorsRunResult,
  runConnectorPollOnce,
  type ConnectorsOutputFormat,
  type ConnectorRow,
  type ConnectorRunResult,
} from "./connectors-cli.js";
import {
  listConnectorStates,
  GOOGLE_DRIVE_CONNECTOR_ID,
  NOTION_CONNECTOR_ID,
  createGoogleDriveConnector,
  validateGoogleDriveConfig,
  createNotionConnector,
  validateNotionConfig,
} from "./connectors/live/index.js";

interface CliApi {
  registerCli(
    handler: (opts: { program: CliProgram }) => void,
    options: { commands: string[] },
  ): void;
}

type RegisterCliOptions = {
  resolveSecretRef?: ResolveSecretRefFn | null;
  loadResolveSecretRef?: () =>
    | Promise<ResolveSecretRefFn | null | undefined>
    | ResolveSecretRefFn
    | null
    | undefined;
};

interface CliProgram {
  command(name: string): CliCommand;
}

interface CliCommand {
  description(desc: string): CliCommand;
  option(
    flags: string,
    desc: string,
    parserOrDefault?: string | ((value: string, prev: unknown) => unknown),
    defaultValue?: unknown,
  ): CliCommand;
  requiredOption(flags: string, desc: string, defaultValue?: string): CliCommand;
  argument(name: string, desc: string): CliCommand;
  action(fn: (...args: unknown[]) => Promise<void> | void): CliCommand;
  command(name: string): CliCommand;
}

interface EngramMcpServerLike {
  runStdio(input: Readable, output: Writable): Promise<void>;
}

export interface ConnectorsRunCliOutputOptions {
  connectorId: string;
  result: ConnectorRunResult;
  format: ConnectorsOutputFormat;
  stdout?: (output: string) => void;
  stderr?: (output: string) => void;
}

export interface DedupeCandidate {
  path: string;
  content: string;
  frontmatter: {
    id?: string;
    confidence?: number;
    updated?: string;
    created?: string;
  };
}

export function emitConnectorsRunCliResult({
  connectorId,
  result,
  format,
  stdout = (output) => process.stdout.write(output),
  stderr = (output) => process.stderr.write(output),
}: ConnectorsRunCliOutputOptions): number {
  const output = renderConnectorsRunResult(connectorId, result, format);
  const failed = result.error !== undefined || result.stateWriteError !== undefined;
  if (failed) {
    stderr(output + "\n");
    return 1;
  }

  stdout(output + "\n");
  return 0;
}

export interface ExactDedupePlan {
  groups: number;
  duplicates: number;
  keepPaths: string[];
  deletePaths: string[];
}

function rankCandidateForKeep(a: DedupeCandidate, b: DedupeCandidate): number {
  const aConfidence = typeof a.frontmatter.confidence === "number" ? a.frontmatter.confidence : 0;
  const bConfidence = typeof b.frontmatter.confidence === "number" ? b.frontmatter.confidence : 0;
  if (aConfidence !== bConfidence) return bConfidence - aConfidence;

  const aTs = Date.parse(a.frontmatter.updated ?? a.frontmatter.created ?? "");
  const bTs = Date.parse(b.frontmatter.updated ?? b.frontmatter.created ?? "");
  const aTime = Number.isNaN(aTs) ? 0 : aTs;
  const bTime = Number.isNaN(bTs) ? 0 : bTs;
  if (aTime !== bTime) return bTime - aTime;

  return a.path.localeCompare(b.path);
}

function buildDedupePlan(
  memories: DedupeCandidate[],
  keyBuilder: (memory: DedupeCandidate) => string,
): ExactDedupePlan {
  const byKey = new Map<string, DedupeCandidate[]>();
  for (const memory of memories) {
    const key = keyBuilder(memory);
    if (key.length === 0) continue;
    const existing = byKey.get(key);
    if (existing) {
      existing.push(memory);
    } else {
      byKey.set(key, [memory]);
    }
  }

  const keepPaths: string[] = [];
  const deletePaths: string[] = [];
  let groups = 0;
  let duplicates = 0;

  for (const entries of byKey.values()) {
    if (entries.length <= 1) continue;
    groups += 1;
    duplicates += entries.length - 1;
    const ranked = [...entries].sort(rankCandidateForKeep);
    keepPaths.push(ranked[0].path);
    for (let i = 1; i < ranked.length; i += 1) {
      deletePaths.push(ranked[i].path);
    }
  }

  return { groups, duplicates, keepPaths, deletePaths };
}

function normalizeAggressiveBody(content: string): string {
  return content
    .normalize("NFKC")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_~>#-]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function planExactDuplicateDeletions(memories: DedupeCandidate[]): ExactDedupePlan {
  return buildDedupePlan(memories, (memory) => memory.content.trim());
}

export function planAggressiveDuplicateDeletions(memories: DedupeCandidate[]): ExactDedupePlan {
  return buildDedupePlan(memories, (memory) => normalizeAggressiveBody(memory.content));
}

export interface ReplayCliCommandOptions {
  source: ReplaySource;
  inputPath: string;
  from?: string;
  to?: string;
  dryRun?: boolean;
  startOffset?: number;
  maxTurns?: number;
  batchSize?: number;
  defaultSessionKey?: string;
  strict?: boolean;
  runConsolidation?: boolean;
  extractionIdleTimeoutMs?: number;
}

export interface ReplayCliOrchestrator {
  ingestReplayBatch(
    turns: ReplayTurn[],
    options?: { deadlineMs?: number },
  ): Promise<void>;
  waitForConsolidationIdle(timeoutMs?: number): Promise<boolean>;
  runConsolidationNow(): Promise<{ memoriesProcessed: number; merged: number; invalidated: number }>;
}

export interface ArchiveObservationsCliCommandOptions {
  memoryDir: string;
  retentionDays?: number;
  write?: boolean;
  now?: Date;
}

export interface RebuildObservationsCliCommandOptions {
  memoryDir: string;
  write?: boolean;
  now?: Date;
}

export interface RebuildMemoryLifecycleLedgerCliCommandOptions {
  memoryDir: string;
  write?: boolean;
  now?: Date;
}

export interface RebuildMemoryProjectionCliCommandOptions {
  memoryDir: string;
  defaultNamespace?: string;
  write?: boolean;
  now?: Date;
  updatedAfter?: string;
  updatedBefore?: string;
}

export interface VerifyMemoryProjectionCliCommandOptions {
  memoryDir: string;
  defaultNamespace?: string;
  updatedAfter?: string;
  updatedBefore?: string;
}

export interface RepairMemoryProjectionCliCommandOptions {
  memoryDir: string;
  defaultNamespace?: string;
  write?: boolean;
  now?: Date;
  updatedAfter?: string;
  updatedBefore?: string;
}

export interface MemoryTimelineCliCommandOptions {
  memoryDir: string;
  memoryId: string;
  limit?: number;
}

export interface MemoryGovernanceCliCommandOptions {
  memoryDir: string;
  mode: "shadow" | "apply";
  now?: Date;
  maxMemories?: number;
  batchSize?: number;
  recentDays?: number;
}

export interface MemoryGovernanceReportCliCommandOptions {
  memoryDir: string;
  runId?: string;
}

export interface MemoryGovernanceRestoreCliCommandOptions {
  memoryDir: string;
  runId: string;
  now?: Date;
}

export interface MemoryReviewDispositionCliCommandOptions {
  memoryDir: string;
  memoryId: string;
  status: Extract<MemoryStatus, "active" | "pending_review" | "rejected" | "quarantined">;
  reasonCode?: string;
  now?: Date;
}

export interface MigrateObservationsCliCommandOptions {
  memoryDir: string;
  write?: boolean;
  now?: Date;
}

interface WorkTaskPatchInput {
  title?: string;
  description?: string;
  status?: WorkTaskStatus;
  priority?: WorkTaskPriority;
  owner?: string | null;
  assignee?: string | null;
  projectId?: string | null;
  tags?: string[];
  dueAt?: string | null;
}

interface WorkProjectPatchInput {
  name?: string;
  description?: string;
  status?: WorkProjectStatus;
  owner?: string | null;
  tags?: string[];
}

export interface WorkTaskCliCommandOptions {
  memoryDir: string;
  action: "create" | "get" | "list" | "update" | "transition" | "delete" | "link";
  id?: string;
  title?: string;
  description?: string;
  status?: WorkTaskStatus;
  priority?: WorkTaskPriority;
  owner?: string;
  assignee?: string;
  projectId?: string;
  tags?: string[];
  dueAt?: string;
  patch?: WorkTaskPatchInput;
}

export interface WorkProjectCliCommandOptions {
  memoryDir: string;
  action: "create" | "get" | "list" | "update" | "delete";
  id?: string;
  name?: string;
  description?: string;
  status?: WorkProjectStatus;
  owner?: string;
  tags?: string[];
  patch?: WorkProjectPatchInput;
}

export interface RouteCliCommandOptions {
  memoryDir: string;
  stateFile?: string;
  action: "list" | "add" | "remove" | "test";
  pattern?: string;
  patternType?: RoutePatternType;
  priority?: number;
  targetRaw?: string;
  text?: string;
  id?: string;
}

interface TailscaleHelperLike {
  status(): Promise<{
    available: boolean;
    running: boolean;
    backendState?: string;
    version?: string;
    selfHostname?: string;
    selfIp?: string;
  }>;
  syncDirectory(options: TailscaleSyncOptions): Promise<void>;
}

export interface ConversationIndexHealthCliOrchestrator {
  getConversationIndexHealth(): Promise<{
    enabled: boolean;
    backend: "qmd" | "faiss";
    status: "ok" | "degraded" | "disabled";
    chunkDocCount: number;
    lastUpdateAt: string | null;
    qmdAvailable?: boolean;
    faiss?: {
      ok: boolean;
      status: "ok" | "degraded" | "error";
      indexPath: string;
      message?: string;
      manifest?: {
        version: number;
        modelId: string;
        normalizedModelId: string;
        dimension: number;
        chunkCount: number;
        updatedAt: string;
        lastSuccessfulRebuildAt: string;
      };
    };
  }>;
  inspectConversationIndex(): Promise<{
    enabled: boolean;
    backend: "qmd" | "faiss";
    status: "ok" | "degraded" | "disabled";
    available: boolean;
    indexPath: string;
    supportsIncrementalUpdate: boolean;
    message?: string;
    chunkDocCount: number;
    lastUpdateAt: string | null;
    metadata: {
      chunkCount: number | null;
      qmdAvailable?: boolean;
      debugStatus?: string;
      hasIndex?: boolean;
      hasMetadata?: boolean;
      hasManifest?: boolean;
      manifest?: {
        version: number;
        modelId: string;
        normalizedModelId: string;
        dimension: number;
        chunkCount: number;
        updatedAt: string;
        lastSuccessfulRebuildAt: string;
      };
    };
  }>;
  rebuildConversationIndex(
    sessionKey?: string,
    hours?: number,
    opts?: { embed?: boolean },
  ): Promise<{
    chunks: number;
    skipped: boolean;
    reason?: string;
    embedded?: boolean;
    rebuilt?: boolean;
  }>;
}

export interface GraphHealthCliCommandOptions {
  memoryDir: string;
  entityGraphEnabled?: boolean;
  timeGraphEnabled?: boolean;
  causalGraphEnabled?: boolean;
  includeRepairGuidance?: boolean;
}

export interface SessionIntegrityCliCommandOptions {
  memoryDir: string;
}

export interface SessionRepairCliCommandOptions {
  memoryDir: string;
  apply?: boolean;
  dryRun?: boolean;
  allowSessionFileRepair?: boolean;
  sessionFilesDir?: string;
}

export interface TierMigrationCliOrchestrator {
  getTierMigrationStatus(): Promise<TierMigrationStatusSnapshot>;
  runTierMigrationNow(options?: { dryRun?: boolean; limit?: number }): Promise<TierMigrationCycleSummary>;
}

export interface MemoryActionAuditCliCommandOptions {
  namespace?: string;
  limit?: number;
}

export interface MemoryActionAuditCliNamespaceSummary {
  namespace: string;
  eventCount: number;
  actions: Record<string, number>;
  outcomes: Record<string, number>;
  policyDecisions: Record<string, number>;
}

export interface MemoryActionAuditCliReport {
  generatedAt: string;
  limit: number;
  namespaces: MemoryActionAuditCliNamespaceSummary[];
  totals: {
    eventCount: number;
    actions: Record<string, number>;
    outcomes: Record<string, number>;
    policyDecisions: Record<string, number>;
  };
}

interface MemoryActionAuditCliOrchestrator {
  config: {
    defaultNamespace: string;
    sharedNamespace: string;
    namespacesEnabled: boolean;
    namespacePolicies: Array<{ name: string }>;
  };
  getStorage(namespace?: string): Promise<{
    readMemoryActionEvents(limit?: number): Promise<MemoryActionEvent[]>;
  }>;
}

export interface TailscaleStatusCliCommandOptions {
  helper?: TailscaleHelperLike;
  timeoutMs?: number;
}

export interface TailscaleSyncCliCommandOptions extends TailscaleSyncOptions {
  helper?: TailscaleHelperLike;
}

interface WebDavServerLike {
  start(): Promise<{ running: boolean; host: string; port: number; rootCount: number }>;
  stop(): Promise<void>;
  status(): { running: boolean; host: string; port: number; rootCount: number };
}

export interface WebDavServeCliCommandOptions {
  enabled?: boolean;
  host?: string;
  port?: number;
  allowlistDirs: string[];
  authUsername?: string;
  authPassword?: string;
  createServer?: (options: {
    enabled?: boolean;
    host?: string;
    port: number;
    allowlistDirs: string[];
    auth?: {
      username: string;
      password: string;
    };
  }) => Promise<WebDavServerLike>;
}

export interface CompatCliCommandOptions {
  repoRoot?: string;
  strict?: boolean;
  runner?: CompatRunner;
  now?: Date;
}

interface DashboardServerLike {
  start(): Promise<DashboardStatus>;
  stop(): Promise<void>;
  status(): DashboardStatus;
}

interface AccessHttpServerLike {
  start(): Promise<{ running: boolean; host: string; port: number; maxBodyBytes: number }>;
  stop(): Promise<void>;
  status(): { running: boolean; host: string; port: number; maxBodyBytes: number };
}

export interface DashboardStartCliCommandOptions {
  memoryDir: string;
  host?: string;
  port?: number;
  publicDir?: string;
  createServer?: (options: {
    memoryDir: string;
    host?: string;
    port?: number;
    publicDir?: string;
  }) => DashboardServerLike;
}

export interface AccessHttpServeCliCommandOptions {
  service: EngramAccessService;
  enabled?: boolean;
  host?: string;
  port?: number;
  authToken?: string;
  principal?: string;
  maxBodyBytes?: number;
  trustPrincipalHeader?: boolean;
  citationsEnabled?: boolean;
  citationsAutoDetect?: boolean;
  createServer?: (options: {
    service: EngramAccessService;
    host?: string;
    port?: number;
    authToken?: string;
    principal?: string;
    maxBodyBytes?: number;
    trustPrincipalHeader?: boolean;
    citationsEnabled?: boolean;
    citationsAutoDetect?: boolean;
  }) => AccessHttpServerLike;
}

export interface TrainingExportCliCommandOptions {
  memoryDir: string;
  format: string;
  output: string;
  since?: string;
  until?: string;
  minConfidence?: number;
  categories?: string[];
  includeEntities?: boolean;
  dryRun?: boolean;
  stdout: Writable;
  stderr: Writable;
}

export function resolveAccessPrincipalOverride(
  explicitPrincipal: unknown,
  configuredPrincipal?: string,
): string | undefined {
  if (typeof explicitPrincipal === "string" && explicitPrincipal.trim().length > 0) {
    return explicitPrincipal.trim();
  }
  return configuredPrincipal?.trim() || undefined;
}

let activeWebDavServer: WebDavServerLike | null = null;
let webDavOperationChain: Promise<void> = Promise.resolve();
let activeDashboardServer: DashboardServerLike | null = null;
let dashboardOperationChain: Promise<void> = Promise.resolve();
let activeAccessHttpServer: AccessHttpServerLike | null = null;
let accessHttpOperationChain: Promise<void> = Promise.resolve();

async function withWebDavLock<T>(operation: () => Promise<T>): Promise<T> {
  const run = webDavOperationChain.then(operation, operation);
  webDavOperationChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function withDashboardLock<T>(operation: () => Promise<T>): Promise<T> {
  const run = dashboardOperationChain.then(operation, operation);
  dashboardOperationChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function withAccessHttpLock<T>(operation: () => Promise<T>): Promise<T> {
  const run = accessHttpOperationChain.then(operation, operation);
  accessHttpOperationChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function isRoutePatternType(value: string | undefined): value is RoutePatternType {
  return value === "keyword" || value === "regex";
}

function parseRouteTargetCliArg(raw: string): RouteTarget {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new Error("missing target");

  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as RouteTarget;
    if (!parsed || typeof parsed !== "object") throw new Error("invalid target JSON");
    return parsed;
  }

  const target: RouteTarget = {};
  for (const token of trimmed.split(",")) {
    const part = token.trim();
    if (part.length === 0) continue;
    const normalized = part.replace(":", "=");
    const [rawKey, ...rawValueParts] = normalized.split("=");
    if (!rawKey || rawValueParts.length === 0) continue;
    const key = rawKey.trim().toLowerCase();
    const value = rawValueParts.join("=").trim();
    if (value.length === 0) continue;
    if (key === "category") {
      target.category = value as RouteTarget["category"];
      continue;
    }
    if (key === "namespace") {
      target.namespace = value;
    }
  }

  return target;
}

function normalizeNullableCliValue(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === "null") return null;
  return trimmed;
}

function parseTagsCsv(raw: string | undefined, preserveEmpty = false): string[] | undefined {
  if (raw === undefined) return undefined;
  const tags = raw
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  if (tags.length === 0) {
    return preserveEmpty ? [] : undefined;
  }
  return tags;
}

function isWorkTaskStatus(value: string | undefined): value is "todo" | "in_progress" | "blocked" | "done" | "cancelled" {
  return value === "todo" || value === "in_progress" || value === "blocked" || value === "done" || value === "cancelled";
}

function isWorkTaskPriority(value: string | undefined): value is "low" | "medium" | "high" {
  return value === "low" || value === "medium" || value === "high";
}

function isWorkProjectStatus(value: string | undefined): value is "active" | "on_hold" | "completed" | "archived" {
  return value === "active" || value === "on_hold" || value === "completed" || value === "archived";
}

export async function runTrainingExportCliCommand(
  opts: TrainingExportCliCommandOptions,
): Promise<void> {
  // Expand ~ in user-facing paths (CLAUDE.md #17: applies to memoryDir AND
  // output — Node.js fs does not expand ~ on any path).
  const expandedMemoryDir = expandTildePath(opts.memoryDir);
  const expandedOutput = expandTildePath(opts.output);

  // 1. Validate format is registered (reject invalid per CLAUDE.md #51)
  const adapter = getTrainingExportAdapter(opts.format);
  if (!adapter) {
    const registered = listTrainingExportAdapters();
    const validList = registered.length > 0
      ? `Valid formats: [${registered.join(", ")}]`
      : "No adapters are currently registered.";
    throw new Error(
      `Unknown training-export format "${opts.format}". ${validList}`,
    );
  }

  // 2. Validate memoryDir exists and is a directory (CLAUDE.md #24: existsSync
  // returns true for files; must use statSync().isDirectory() when a directory
  // is required, otherwise we silently generate an empty export).
  const { statSync, existsSync } = await import("node:fs");
  if (!existsSync(expandedMemoryDir)) {
    throw new Error(
      `--memory-dir "${opts.memoryDir}" does not exist. Provide the path to an existing memory directory.`,
    );
  }
  try {
    if (!statSync(expandedMemoryDir).isDirectory()) {
      throw new Error(
        `--memory-dir "${opts.memoryDir}" is not a directory. Provide the path to a memory directory, not a file.`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("--memory-dir ")) throw err;
    throw new Error(
      `Unable to stat --memory-dir "${opts.memoryDir}": ${(err as Error).message}`,
    );
  }

  // 3. Parse date filters (strict: reject overflowed dates like Feb 31)
  let since: Date | undefined;
  if (opts.since !== undefined) {
    since = parseStrictCliDate(opts.since, "--since");
  }

  let until: Date | undefined;
  if (opts.until !== undefined) {
    until = parseStrictCliDate(opts.until, "--until");
  }

  // 4. Convert memories to records
  const records = await convertMemoriesToRecords({
    memoryDir: expandedMemoryDir,
    since,
    until,
    minConfidence: opts.minConfidence,
    categories: opts.categories,
    includeEntities: opts.includeEntities,
  });

  // 5. Dry run — print statistics and return
  if (opts.dryRun) {
    opts.stdout.write(`Training export dry run\n`);
    opts.stdout.write(`Format: ${adapter.name}\n`);
    opts.stdout.write(`Records: ${records.length}\n`);
    const cats = new Map<string, number>();
    for (const r of records) {
      const c = r.category ?? "unknown";
      cats.set(c, (cats.get(c) ?? 0) + 1);
    }
    for (const [cat, count] of [...cats.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      opts.stdout.write(`  ${cat}: ${count}\n`);
    }
    return;
  }

  // 6. Format records using adapter
  const formatted = adapter.formatRecords(records);

  // 7. Write to output file
  const { writeFile: fsWriteFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const { mkdirSync } = await import("node:fs");
  try {
    mkdirSync(dirname(expandedOutput), { recursive: true });
  } catch {
    // parent already exists
  }
  await fsWriteFile(expandedOutput, formatted, "utf-8");
  opts.stdout.write(
    `Exported ${records.length} records to ${expandedOutput} (${adapter.name} format)\n`,
  );
}

export async function runArchiveObservationsCliCommand(
  options: ArchiveObservationsCliCommandOptions,
) {
  return archiveObservations({
    memoryDir: options.memoryDir,
    retentionDays: options.retentionDays,
    dryRun: options.write !== true,
    now: options.now,
  });
}

export async function runRebuildObservationsCliCommand(
  options: RebuildObservationsCliCommandOptions,
) {
  return rebuildObservations({
    memoryDir: options.memoryDir,
    dryRun: options.write !== true,
    now: options.now,
  });
}

export async function runRebuildMemoryLifecycleLedgerCliCommand(
  options: RebuildMemoryLifecycleLedgerCliCommandOptions,
) {
  return rebuildMemoryLifecycleLedger({
    memoryDir: options.memoryDir,
    dryRun: options.write !== true,
    now: options.now,
  });
}

export async function runRebuildMemoryProjectionCliCommand(
  options: RebuildMemoryProjectionCliCommandOptions,
) {
  return rebuildMemoryProjection({
    memoryDir: options.memoryDir,
    defaultNamespace: options.defaultNamespace,
    dryRun: options.write !== true,
    now: options.now,
    updatedAfter: options.updatedAfter,
    updatedBefore: options.updatedBefore,
  });
}

export async function runVerifyMemoryProjectionCliCommand(
  options: VerifyMemoryProjectionCliCommandOptions,
) {
  return verifyMemoryProjection({
    memoryDir: options.memoryDir,
    defaultNamespace: options.defaultNamespace,
    updatedAfter: options.updatedAfter,
    updatedBefore: options.updatedBefore,
  });
}

export async function runRepairMemoryProjectionCliCommand(
  options: RepairMemoryProjectionCliCommandOptions,
) {
  return repairMemoryProjection({
    memoryDir: options.memoryDir,
    defaultNamespace: options.defaultNamespace,
    dryRun: options.write !== true,
    now: options.now,
    updatedAfter: options.updatedAfter,
    updatedBefore: options.updatedBefore,
  });
}

export async function runMemoryTimelineCliCommand(
  options: MemoryTimelineCliCommandOptions,
) {
  const storage = new (await import("./storage.js")).StorageManager(options.memoryDir);
  return storage.getMemoryTimeline(options.memoryId, options.limit);
}

export async function runMemoryGovernanceCliCommand(
  options: MemoryGovernanceCliCommandOptions,
) {
  return runMemoryGovernance({
    memoryDir: options.memoryDir,
    mode: options.mode,
    now: options.now,
    maxMemories: options.maxMemories,
    batchSize: options.batchSize,
    recentDays: options.recentDays,
  });
}

export async function runMemoryGovernanceReportCliCommand(
  options: MemoryGovernanceReportCliCommandOptions,
) {
  const runId = options.runId ?? (await listMemoryGovernanceRuns(options.memoryDir))[0];
  if (!runId) {
    throw new Error("no governance runs found");
  }
  return readMemoryGovernanceRunArtifact(options.memoryDir, runId);
}

export async function runMemoryGovernanceRestoreCliCommand(
  options: MemoryGovernanceRestoreCliCommandOptions,
) {
  return restoreMemoryGovernanceRun({
    memoryDir: options.memoryDir,
    runId: options.runId,
    now: options.now,
  });
}

export async function runMemoryReviewDispositionCliCommand(
  options: MemoryReviewDispositionCliCommandOptions,
) {
  const storage = new (await import("./storage.js")).StorageManager(options.memoryDir);
  const memory = await storage.getMemoryById(options.memoryId);
  if (!memory) throw new Error(`memory not found: ${options.memoryId}`);
  const updated = await storage.writeMemoryFrontmatter(memory, {
    status: options.status,
    updated: (options.now ?? new Date()).toISOString(),
  }, {
    actor: "cli.review-disposition",
    reasonCode: options.reasonCode,
    ruleVersion: "memory-governance.v1",
  });
  if (!updated) {
    throw new Error(`failed to update memory disposition: ${options.memoryId}`);
  }
  return {
    memoryId: options.memoryId,
    status: options.status,
    reasonCode: options.reasonCode,
  };
}

export async function runMigrateObservationsCliCommand(
  options: MigrateObservationsCliCommandOptions,
) {
  return migrateObservations({
    memoryDir: options.memoryDir,
    dryRun: options.write !== true,
    now: options.now,
  });
}

export async function runConversationIndexHealthCliCommand(
  orchestrator: ConversationIndexHealthCliOrchestrator,
): Promise<{
  enabled: boolean;
  backend: "qmd" | "faiss";
  status: "ok" | "degraded" | "disabled";
  chunkDocCount: number;
  lastUpdateAt: string | null;
  qmdAvailable?: boolean;
  faiss?: {
    ok: boolean;
    status: "ok" | "degraded" | "error";
    indexPath: string;
    message?: string;
    manifest?: {
      version: number;
      modelId: string;
      normalizedModelId: string;
      dimension: number;
      chunkCount: number;
      updatedAt: string;
      lastSuccessfulRebuildAt: string;
    };
  };
}> {
  return orchestrator.getConversationIndexHealth();
}

export async function runConversationIndexInspectCliCommand(
  orchestrator: ConversationIndexHealthCliOrchestrator,
) {
  return orchestrator.inspectConversationIndex();
}

export async function runConversationIndexRebuildCliCommand(
  orchestrator: ConversationIndexHealthCliOrchestrator,
  options: {
    sessionKey?: string;
    hours?: number;
    embed?: boolean;
  },
) {
  return orchestrator.rebuildConversationIndex(
    options.sessionKey,
    options.hours,
    { embed: options.embed },
  );
}

export async function runGraphHealthCliCommand(
  options: GraphHealthCliCommandOptions,
): Promise<GraphHealthReport> {
  return analyzeGraphHealth(options.memoryDir, {
    entityGraphEnabled: options.entityGraphEnabled,
    timeGraphEnabled: options.timeGraphEnabled,
    causalGraphEnabled: options.causalGraphEnabled,
    includeRepairGuidance: options.includeRepairGuidance,
  });
}

export async function runBenchmarkStatusCliCommand(options: {
  memoryDir: string;
  evalStoreDir?: string;
  evalHarnessEnabled: boolean;
  evalShadowModeEnabled: boolean;
  benchmarkBaselineSnapshotsEnabled: boolean;
  memoryRedTeamBenchEnabled: boolean;
}): Promise<EvalHarnessStatus> {
  return getEvalHarnessStatus({
    memoryDir: options.memoryDir,
    evalStoreDir: options.evalStoreDir,
    enabled: options.evalHarnessEnabled,
    shadowModeEnabled: options.evalShadowModeEnabled,
    baselineSnapshotsEnabled: options.benchmarkBaselineSnapshotsEnabled,
    memoryRedTeamBenchEnabled: options.memoryRedTeamBenchEnabled,
  });
}

export async function runBenchmarkBaselineSnapshotCliCommand(options: {
  memoryDir: string;
  evalStoreDir?: string;
  benchmarkBaselineSnapshotsEnabled: boolean;
  snapshotId: string;
  createdAt?: string;
  notes?: string;
  gitRef?: string;
}): Promise<{ targetPath: string; snapshot: EvalBaselineSnapshot }> {
  return createEvalBaselineSnapshot({
    memoryDir: options.memoryDir,
    evalStoreDir: options.evalStoreDir,
    baselineSnapshotsEnabled: options.benchmarkBaselineSnapshotsEnabled,
    snapshotId: options.snapshotId,
    createdAt: options.createdAt,
    notes: options.notes,
    gitRef: options.gitRef,
  });
}

export async function runBenchmarkValidateCliCommand(options: {
  path: string;
  memoryRedTeamBenchEnabled: boolean;
}): Promise<EvalBenchmarkPackSummary> {
  return validateEvalBenchmarkPack(options.path, {
    memoryRedTeamBenchEnabled: options.memoryRedTeamBenchEnabled,
  });
}

export async function runBenchmarkImportCliCommand(options: {
  path: string;
  memoryDir: string;
  evalStoreDir?: string;
  force?: boolean;
  memoryRedTeamBenchEnabled: boolean;
}): Promise<EvalBenchmarkPackSummary & { targetDir: string; overwritten: boolean }> {
  return importEvalBenchmarkPack({
    sourcePath: options.path,
    memoryDir: options.memoryDir,
    evalStoreDir: options.evalStoreDir,
    force: options.force === true,
    memoryRedTeamBenchEnabled: options.memoryRedTeamBenchEnabled,
  });
}

export async function runBenchmarkCiGateCliCommand(options: {
  baseEvalStoreDir: string;
  candidateEvalStoreDir: string;
}): Promise<EvalCiGateReport> {
  return runEvalBenchmarkCiGate({
    baseEvalStoreDir: options.baseEvalStoreDir,
    candidateEvalStoreDir: options.candidateEvalStoreDir,
  });
}

export async function runBenchmarkStoredBaselineCiGateCliCommand(options: {
  baseEvalStoreDir: string;
  candidateEvalStoreDir: string;
  snapshotId: string;
}): Promise<EvalStoredBaselineCiGateReport> {
  return runEvalStoredBaselineCiGate({
    baseEvalStoreDir: options.baseEvalStoreDir,
    candidateEvalStoreDir: options.candidateEvalStoreDir,
    snapshotId: options.snapshotId,
  });
}

export async function runBenchmarkBaselineReportCliCommand(options: {
  memoryDir: string;
  evalStoreDir?: string;
  benchmarkDeltaReporterEnabled: boolean;
  snapshotId: string;
}): Promise<EvalBaselineDeltaReport> {
  return runEvalBaselineDeltaReport({
    memoryDir: options.memoryDir,
    evalStoreDir: options.evalStoreDir,
    benchmarkDeltaReporterEnabled: options.benchmarkDeltaReporterEnabled,
    snapshotId: options.snapshotId,
  });
}

export async function runObjectiveStateStatusCliCommand(options: {
  memoryDir: string;
  objectiveStateStoreDir?: string;
  objectiveStateMemoryEnabled: boolean;
  objectiveStateSnapshotWritesEnabled: boolean;
}): Promise<ObjectiveStateStoreStatus> {
  return getObjectiveStateStoreStatus({
    memoryDir: options.memoryDir,
    objectiveStateStoreDir: options.objectiveStateStoreDir,
    enabled: options.objectiveStateMemoryEnabled,
    writesEnabled: options.objectiveStateSnapshotWritesEnabled,
  });
}

export async function runCausalTrajectoryStatusCliCommand(options: {
  memoryDir: string;
  causalTrajectoryStoreDir?: string;
  causalTrajectoryMemoryEnabled: boolean;
}): Promise<CausalTrajectoryStoreStatus> {
  return getCausalTrajectoryStoreStatus({
    memoryDir: options.memoryDir,
    causalTrajectoryStoreDir: options.causalTrajectoryStoreDir,
    enabled: options.causalTrajectoryMemoryEnabled,
  });
}

export async function runTrustZoneStatusCliCommand(options: {
  memoryDir: string;
  trustZoneStoreDir?: string;
  trustZonesEnabled: boolean;
  quarantinePromotionEnabled: boolean;
  memoryPoisoningDefenseEnabled: boolean;
}): Promise<TrustZoneStoreStatus> {
  return getTrustZoneStoreStatus({
    memoryDir: options.memoryDir,
    trustZoneStoreDir: options.trustZoneStoreDir,
    enabled: options.trustZonesEnabled,
    promotionEnabled: options.quarantinePromotionEnabled,
    poisoningDefenseEnabled: options.memoryPoisoningDefenseEnabled,
  });
}

export async function runAbstractionNodeStatusCliCommand(options: {
  memoryDir: string;
  abstractionNodeStoreDir?: string;
  harmonicRetrievalEnabled: boolean;
  abstractionAnchorsEnabled: boolean;
}): Promise<AbstractionNodeStoreStatus> {
  return getAbstractionNodeStoreStatus({
    memoryDir: options.memoryDir,
    abstractionNodeStoreDir: options.abstractionNodeStoreDir,
    enabled: options.harmonicRetrievalEnabled,
    anchorsEnabled: options.abstractionAnchorsEnabled,
  });
}

export async function runCueAnchorStatusCliCommand(options: {
  memoryDir: string;
  abstractionNodeStoreDir?: string;
  harmonicRetrievalEnabled: boolean;
  abstractionAnchorsEnabled: boolean;
}): Promise<CueAnchorStoreStatus> {
  return getCueAnchorStoreStatus({
    memoryDir: options.memoryDir,
    abstractionNodeStoreDir: options.abstractionNodeStoreDir,
    enabled: options.harmonicRetrievalEnabled,
    anchorsEnabled: options.abstractionAnchorsEnabled,
  });
}

export async function runHarmonicSearchCliCommand(options: {
  memoryDir: string;
  abstractionNodeStoreDir?: string;
  harmonicRetrievalEnabled: boolean;
  abstractionAnchorsEnabled: boolean;
  query: string;
  maxResults?: number;
  sessionKey?: string;
}): Promise<HarmonicRetrievalResult[]> {
  if (!options.harmonicRetrievalEnabled) return [];
  return searchHarmonicRetrieval({
    memoryDir: options.memoryDir,
    abstractionNodeStoreDir: options.abstractionNodeStoreDir,
    query: options.query,
    maxResults: Math.max(1, Math.floor(options.maxResults ?? 3)),
    sessionKey: options.sessionKey,
    anchorsEnabled: options.abstractionAnchorsEnabled,
  });
}

export async function runVerifiedRecallSearchCliCommand(options: {
  memoryDir: string;
  verifiedRecallEnabled: boolean;
  query: string;
  maxResults?: number;
  boxRecallDays?: number;
}): Promise<VerifiedEpisodeResult[]> {
  if (!options.verifiedRecallEnabled) return [];
  return searchVerifiedEpisodes({
    memoryDir: options.memoryDir,
    query: options.query,
    maxResults: Math.max(1, Math.floor(options.maxResults ?? 3)),
    boxRecallDays: options.boxRecallDays,
  });
}

export function isNormalRetrievalVisibleMemory(memory: MemoryFile): boolean {
  return memory.frontmatter.status !== "forgotten";
}

export async function filterNormalMemorySearchResults(
  results: QmdSearchResult[],
  storage: {
    readMemoryByPath(path: string): Promise<MemoryFile | null>;
  },
): Promise<QmdSearchResult[]> {
  const filtered: QmdSearchResult[] = [];
  for (const result of results) {
    if (!result.path) continue;
    const memory = await storage.readMemoryByPath(result.path);
    if (!memory || !isNormalRetrievalVisibleMemory(memory)) continue;
    filtered.push(result);
  }
  return filtered;
}

export async function runSemanticRulePromoteCliCommand(options: {
  memoryDir: string;
  semanticRulePromotionEnabled: boolean;
  sourceMemoryId: string;
  dryRun?: boolean;
}): Promise<SemanticRulePromotionReport> {
  return promoteSemanticRuleFromMemory({
    memoryDir: options.memoryDir,
    enabled: options.semanticRulePromotionEnabled,
    sourceMemoryId: options.sourceMemoryId,
    dryRun: options.dryRun,
  });
}

export async function runCompoundingPromoteCliCommand(options: {
  memoryDir: string;
  compoundingEnabled: boolean;
  compoundingSemanticEnabled: boolean;
  weekId: string;
  candidateId: string;
  dryRun?: boolean;
}) {
  const { CompoundingEngine } = await import("./compounding/engine.js");
  const config = parseConfig({
    memoryDir: options.memoryDir,
    qmdEnabled: false,
    sharedContextEnabled: false,
    compoundingEnabled: options.compoundingEnabled,
    compoundingSemanticEnabled: options.compoundingSemanticEnabled,
  });
  const engine = new CompoundingEngine(config);
  return engine.promoteCandidate({
    weekId: options.weekId,
    candidateId: options.candidateId,
    dryRun: options.dryRun,
  });
}

export async function runSemanticRuleVerifyCliCommand(options: {
  memoryDir: string;
  semanticRuleVerificationEnabled: boolean;
  query: string;
  maxResults?: number;
}): Promise<VerifiedSemanticRuleResult[]> {
  if (!options.semanticRuleVerificationEnabled) return [];
  return searchVerifiedSemanticRules({
    memoryDir: options.memoryDir,
    query: options.query,
    maxResults: Math.max(1, Math.floor(options.maxResults ?? 3)),
  });
}

export async function runWorkProductStatusCliCommand(options: {
  memoryDir: string;
  workProductLedgerDir?: string;
  creationMemoryEnabled: boolean;
}): Promise<WorkProductLedgerStatus> {
  return getWorkProductLedgerStatus({
    memoryDir: options.memoryDir,
    workProductLedgerDir: options.workProductLedgerDir,
    enabled: options.creationMemoryEnabled,
  });
}

export async function runUtilityTelemetryStatusCliCommand(options: {
  memoryDir: string;
  memoryUtilityLearningEnabled: boolean;
  promotionByOutcomeEnabled: boolean;
}): Promise<UtilityTelemetryStatus> {
  return getUtilityTelemetryStatus({
    memoryDir: options.memoryDir,
    enabled: options.memoryUtilityLearningEnabled,
    promotionByOutcomeEnabled: options.promotionByOutcomeEnabled,
  });
}

export async function runUtilityTelemetryRecordCliCommand(options: {
  memoryDir: string;
  memoryUtilityLearningEnabled: boolean;
  event: UtilityTelemetryEvent;
}): Promise<string | null> {
  if (!options.memoryUtilityLearningEnabled) return null;
  return recordUtilityTelemetryEvent({
    memoryDir: options.memoryDir,
    event: options.event,
  });
}

export async function runUtilityLearningStatusCliCommand(options: {
  memoryDir: string;
  memoryUtilityLearningEnabled: boolean;
  promotionByOutcomeEnabled: boolean;
}): Promise<UtilityLearningStatus> {
  return getUtilityLearningStatus({
    memoryDir: options.memoryDir,
    enabled: options.memoryUtilityLearningEnabled,
    promotionByOutcomeEnabled: options.promotionByOutcomeEnabled,
  });
}

export async function runUtilityLearningCliCommand(options: {
  memoryDir: string;
  memoryUtilityLearningEnabled: boolean;
  learningWindowDays?: number;
  minEventCount?: number;
  maxWeightMagnitude?: number;
}): Promise<UtilityLearningResult> {
  return learnUtilityPromotionWeights({
    memoryDir: options.memoryDir,
    enabled: options.memoryUtilityLearningEnabled,
    learningWindowDays: options.learningWindowDays ?? 14,
    minEventCount: options.minEventCount ?? 3,
    maxWeightMagnitude: options.maxWeightMagnitude ?? 0.35,
  });
}

export async function runWorkProductRecordCliCommand(options: {
  memoryDir: string;
  workProductLedgerDir?: string;
  creationMemoryEnabled: boolean;
  entry: WorkProductLedgerEntry;
}): Promise<string | null> {
  if (!options.creationMemoryEnabled) return null;
  return recordWorkProductLedgerEntry({
    memoryDir: options.memoryDir,
    workProductLedgerDir: options.workProductLedgerDir,
    entry: options.entry,
  });
}

export async function runWorkProductRecallSearchCliCommand(options: {
  memoryDir: string;
  workProductLedgerDir?: string;
  creationMemoryEnabled: boolean;
  workProductRecallEnabled: boolean;
  query: string;
  maxResults?: number;
  sessionKey?: string;
}): Promise<WorkProductLedgerSearchResult[]> {
  if (!options.creationMemoryEnabled || !options.workProductRecallEnabled) return [];
  return searchWorkProductLedgerEntries({
    memoryDir: options.memoryDir,
    workProductLedgerDir: options.workProductLedgerDir,
    query: options.query,
    maxResults: Math.max(1, Math.floor(options.maxResults ?? 3)),
    sessionKey: options.sessionKey,
  });
}

export async function runResumeBundleStatusCliCommand(options: {
  memoryDir: string;
  resumeBundleDir?: string;
  creationMemoryEnabled: boolean;
  resumeBundlesEnabled: boolean;
}): Promise<ResumeBundleStatus> {
  return getResumeBundleStatus({
    memoryDir: options.memoryDir,
    resumeBundleDir: options.resumeBundleDir,
    enabled: options.creationMemoryEnabled && options.resumeBundlesEnabled,
  });
}

export async function runResumeBundleRecordCliCommand(options: {
  memoryDir: string;
  resumeBundleDir?: string;
  creationMemoryEnabled: boolean;
  resumeBundlesEnabled: boolean;
  bundle: ResumeBundle;
}): Promise<string | null> {
  if (!options.creationMemoryEnabled || !options.resumeBundlesEnabled) return null;
  return recordResumeBundle({
    memoryDir: options.memoryDir,
    resumeBundleDir: options.resumeBundleDir,
    bundle: options.bundle,
  });
}

export async function runResumeBundleBuildCliCommand(options: {
  memoryDir: string;
  resumeBundleDir?: string;
  objectiveStateStoreDir?: string;
  workProductLedgerDir?: string;
  commitmentLedgerDir?: string;
  creationMemoryEnabled: boolean;
  resumeBundlesEnabled: boolean;
  transcriptEnabled: boolean;
  objectiveStateMemoryEnabled: boolean;
  commitmentLedgerEnabled: boolean;
  bundleId: string;
  recordedAt: string;
  sessionKey: string;
  scope: string;
}): Promise<{ bundle: ResumeBundle; filePath: string } | null> {
  if (!options.creationMemoryEnabled || !options.resumeBundlesEnabled) {
    return null;
  }

  const bundle = await buildResumeBundleFromState({
    memoryDir: options.memoryDir,
    sessionKey: options.sessionKey,
    bundleId: options.bundleId,
    recordedAt: options.recordedAt,
    scope: options.scope,
    transcriptEnabled: options.transcriptEnabled,
    objectiveStateMemoryEnabled: options.objectiveStateMemoryEnabled,
    objectiveStateStoreDir: options.objectiveStateStoreDir,
    creationMemoryEnabled: options.creationMemoryEnabled,
    workProductLedgerDir: options.workProductLedgerDir,
    commitmentLedgerEnabled: options.commitmentLedgerEnabled,
    commitmentLedgerDir: options.commitmentLedgerDir,
  });

  const filePath = await recordResumeBundle({
    memoryDir: options.memoryDir,
    resumeBundleDir: options.resumeBundleDir,
    bundle,
  });

  return { bundle, filePath };
}

export async function runCommitmentStatusCliCommand(options: {
  memoryDir: string;
  commitmentLedgerDir?: string;
  creationMemoryEnabled: boolean;
  commitmentLedgerEnabled: boolean;
  commitmentLifecycleEnabled?: boolean;
  commitmentStaleDays?: number;
  commitmentDecayDays?: number;
  now?: string;
}): Promise<CommitmentLedgerStatus> {
  return getCommitmentLedgerStatus({
    memoryDir: options.memoryDir,
    commitmentLedgerDir: options.commitmentLedgerDir,
    enabled: options.creationMemoryEnabled && options.commitmentLedgerEnabled,
    lifecycleEnabled:
      options.creationMemoryEnabled &&
      options.commitmentLedgerEnabled &&
      options.commitmentLifecycleEnabled === true,
    staleDays: options.commitmentStaleDays,
    decayDays: options.commitmentDecayDays,
    now: options.now,
  });
}

export async function runCommitmentRecordCliCommand(options: {
  memoryDir: string;
  commitmentLedgerDir?: string;
  creationMemoryEnabled: boolean;
  commitmentLedgerEnabled: boolean;
  entry: CommitmentLedgerEntry;
}): Promise<string | null> {
  if (!options.creationMemoryEnabled || !options.commitmentLedgerEnabled) return null;
  return recordCommitmentLedgerEntry({
    memoryDir: options.memoryDir,
    commitmentLedgerDir: options.commitmentLedgerDir,
    entry: options.entry,
  });
}

export async function runCommitmentSetStateCliCommand(options: {
  memoryDir: string;
  commitmentLedgerDir?: string;
  creationMemoryEnabled: boolean;
  commitmentLedgerEnabled: boolean;
  commitmentLifecycleEnabled: boolean;
  entryId: string;
  nextState: CommitmentLedgerEntry["state"];
  changedAt: string;
}): Promise<CommitmentLedgerEntry | null> {
  if (
    !options.creationMemoryEnabled ||
    !options.commitmentLedgerEnabled ||
    !options.commitmentLifecycleEnabled
  ) {
    return null;
  }

  return transitionCommitmentLedgerEntryState({
    memoryDir: options.memoryDir,
    commitmentLedgerDir: options.commitmentLedgerDir,
    entryId: options.entryId,
    nextState: options.nextState,
    changedAt: options.changedAt,
  });
}

export async function runCommitmentLifecycleCliCommand(options: {
  memoryDir: string;
  commitmentLedgerDir?: string;
  creationMemoryEnabled: boolean;
  commitmentLedgerEnabled: boolean;
  commitmentLifecycleEnabled: boolean;
  commitmentDecayDays: number;
  now?: string;
}): Promise<CommitmentLedgerLifecycleResult | null> {
  if (
    !options.creationMemoryEnabled ||
    !options.commitmentLedgerEnabled ||
    !options.commitmentLifecycleEnabled
  ) {
    return null;
  }

  return applyCommitmentLedgerLifecycle({
    memoryDir: options.memoryDir,
    commitmentLedgerDir: options.commitmentLedgerDir,
    enabled: true,
    decayDays: options.commitmentDecayDays,
    now: options.now,
  });
}

export async function runTrustZonePromoteCliCommand(options: {
  memoryDir: string;
  trustZoneStoreDir?: string;
  trustZonesEnabled: boolean;
  quarantinePromotionEnabled: boolean;
  memoryPoisoningDefenseEnabled: boolean;
  sourceRecordId: string;
  targetZone: TrustZoneName;
  promotionReason: string;
  recordedAt?: string;
  summary?: string;
  dryRun?: boolean;
}): Promise<TrustZonePromotionResult & { dryRun: boolean }> {
  const result = await promoteTrustZoneRecord({
    memoryDir: options.memoryDir,
    trustZoneStoreDir: options.trustZoneStoreDir,
    enabled: options.trustZonesEnabled,
    promotionEnabled: options.quarantinePromotionEnabled,
    poisoningDefenseEnabled: options.memoryPoisoningDefenseEnabled,
    sourceRecordId: options.sourceRecordId,
    targetZone: options.targetZone,
    recordedAt: options.recordedAt ?? new Date().toISOString(),
    promotionReason: options.promotionReason,
    summary: options.summary,
    dryRun: options.dryRun === true,
  });

  return {
    ...result,
    dryRun: options.dryRun === true,
  };
}

export async function runTrustZoneDemoSeedCliCommand(options: {
  memoryDir: string;
  trustZoneStoreDir?: string;
  trustZonesEnabled: boolean;
  scenario?: string;
  recordedAt?: string;
  dryRun?: boolean;
}): Promise<TrustZoneDemoSeedResult> {
  return seedTrustZoneDemoDataset({
    memoryDir: options.memoryDir,
    trustZoneStoreDir: options.trustZoneStoreDir,
    enabled: options.trustZonesEnabled,
    scenario: options.scenario,
    recordedAt: options.recordedAt,
    dryRun: options.dryRun === true,
  });
}

export async function runSessionCheckCliCommand(
  options: SessionIntegrityCliCommandOptions,
): Promise<SessionIntegrityReport> {
  return analyzeSessionIntegrity({ memoryDir: options.memoryDir });
}

export async function runSessionRepairCliCommand(
  options: SessionRepairCliCommandOptions,
): Promise<{ report: SessionIntegrityReport; plan: SessionRepairPlan; applyResult: SessionRepairApplyResult }> {
  const report = await analyzeSessionIntegrity({ memoryDir: options.memoryDir });
  const dryRun = options.apply !== true || options.dryRun === true;
  const plan = planSessionRepair({
    report,
    dryRun,
    allowSessionFileRepair: options.allowSessionFileRepair === true,
    sessionFilesDir: options.sessionFilesDir,
  });
  const applyResult = await applySessionRepair({ plan });
  return { report, plan, applyResult };
}

export async function runTierStatusCliCommand(
  orchestrator: TierMigrationCliOrchestrator,
): Promise<TierMigrationStatusSnapshot> {
  return orchestrator.getTierMigrationStatus();
}

export async function runTierMigrateCliCommand(
  orchestrator: TierMigrationCliOrchestrator,
  options: { dryRun?: boolean; limit?: number } = {},
): Promise<TierMigrationCycleSummary> {
  return orchestrator.runTierMigrationNow({
    dryRun: options.dryRun === true,
    limit: options.limit,
  });
}

const MIGRATE_LIMIT_CAP = 2000;
const REEXTRACT_LIMIT_CAP = 500;

type MigrateMemoryStorage = {
  readAllMemories(): Promise<MemoryFile[]>;
  readArchivedMemories(): Promise<MemoryFile[]>;
  writeMemoryFrontmatter(memory: MemoryFile, patch: Partial<MemoryFile["frontmatter"]>): Promise<boolean>;
  getChunksForParent(parentId: string): Promise<MemoryFile[]>;
  updateMemory(id: string, newContent: string): Promise<boolean>;
  updateMemoryFrontmatter(id: string, patch: Partial<MemoryFile["frontmatter"]>): Promise<boolean>;
  writeChunk(
    parentId: string,
    chunkIndex: number,
    chunkTotal: number,
    category: MemoryFile["frontmatter"]["category"],
    content: string,
    options?: {
      confidence?: number;
      tags?: string[];
      entityRef?: string;
      source?: string;
      importance?: MemoryFile["frontmatter"]["importance"];
      intentGoal?: string;
      intentActionType?: string;
      intentEntityTypes?: string[];
      memoryKind?: MemoryFile["frontmatter"]["memoryKind"];
    },
  ): Promise<string>;
  invalidateMemory(id: string): Promise<boolean>;
  appendReextractJobs(events: Array<{
    memoryId: string;
    model: string;
    requestedAt: string;
    source: "cli-migrate";
  }>): Promise<number>;
};

export interface MigrateCliOrchestrator {
  config: {
    defaultNamespace: string;
  };
  getStorage(namespace?: string): Promise<MigrateMemoryStorage>;
}

export interface MigrateCliReport {
  action: "normalize-frontmatter" | "rescore-importance" | "rechunk" | "reextract";
  dryRun: boolean;
  scanned: number;
  changed: number;
  queued: number;
  limit: number;
  model?: string;
}

function clampMigrateLimit(limit: number | undefined, cap: number, fallback: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(cap, Math.floor(limit)));
}

async function readMigrateCandidateMemories(
  storage: MigrateMemoryStorage,
  options: { includeArchived: boolean },
): Promise<MemoryFile[]> {
  const merged = new Map<string, MemoryFile>();
  const addMany = (items: MemoryFile[]) => {
    for (const item of items) {
      if (!item.frontmatter?.id) continue;
      merged.set(item.path, item);
    }
  };
  addMany(await storage.readAllMemories());
  if (options.includeArchived) {
    addMany(await storage.readArchivedMemories());
  }
  return [...merged.values()]
    .sort((a, b) => a.path.localeCompare(b.path));
}

function sameImportance(a: MemoryFile["frontmatter"]["importance"], b: MemoryFile["frontmatter"]["importance"]): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (Math.abs(a.score - b.score) > 0.000001) return false;
  if (a.level !== b.level) return false;
  if (a.reasons.join("|") !== b.reasons.join("|")) return false;
  if (a.keywords.join("|") !== b.keywords.join("|")) return false;
  return true;
}

function sameChunkContent(existing: MemoryFile[], desired: string[]): boolean {
  if (existing.length !== desired.length) return false;
  for (let i = 0; i < desired.length; i += 1) {
    const current = existing[i]?.content?.trim() ?? "";
    if (current !== desired[i]?.trim()) {
      return false;
    }
  }
  return true;
}

export async function runMigrateNormalizeFrontmatterCliCommand(
  orchestrator: MigrateCliOrchestrator,
  options: { write?: boolean; limit?: number } = {},
): Promise<MigrateCliReport> {
  const limit = clampMigrateLimit(options.limit, MIGRATE_LIMIT_CAP, 200);
  const storage = await orchestrator.getStorage(orchestrator.config.defaultNamespace);
  const candidates = (await readMigrateCandidateMemories(storage, { includeArchived: true }))
    .slice(0, limit);
  if (options.write === true) {
    for (const memory of candidates) {
      await storage.writeMemoryFrontmatter(memory, {});
    }
  }
  return {
    action: "normalize-frontmatter",
    dryRun: options.write !== true,
    scanned: candidates.length,
    changed: candidates.length,
    queued: 0,
    limit,
  };
}

export async function runMigrateRescoreImportanceCliCommand(
  orchestrator: MigrateCliOrchestrator,
  options: { write?: boolean; limit?: number } = {},
): Promise<MigrateCliReport> {
  const limit = clampMigrateLimit(options.limit, MIGRATE_LIMIT_CAP, 200);
  const storage = await orchestrator.getStorage(orchestrator.config.defaultNamespace);
  const candidates = (await readMigrateCandidateMemories(storage, { includeArchived: true }))
    .slice(0, limit);
  let changed = 0;
  for (const memory of candidates) {
    const nextImportance = rescoreMemoryImportance(memory);
    if (sameImportance(memory.frontmatter.importance, nextImportance)) continue;
    changed += 1;
    if (options.write === true) {
      await storage.writeMemoryFrontmatter(memory, {
        importance: nextImportance,
        updated: new Date().toISOString(),
      });
    }
  }

  return {
    action: "rescore-importance",
    dryRun: options.write !== true,
    scanned: candidates.length,
    changed,
    queued: 0,
    limit,
  };
}

export async function runMigrateRechunkCliCommand(
  orchestrator: MigrateCliOrchestrator,
  options: { write?: boolean; limit?: number } = {},
): Promise<MigrateCliReport> {
  const limit = clampMigrateLimit(options.limit, MIGRATE_LIMIT_CAP, 200);
  const storage = await orchestrator.getStorage(orchestrator.config.defaultNamespace);
  const candidates = (await readMigrateCandidateMemories(storage, { includeArchived: false }))
    .filter((memory) => memory.frontmatter.parentId === undefined)
    .slice(0, limit);

  let changed = 0;
  for (const memory of candidates) {
    const existing = await storage.getChunksForParent(memory.frontmatter.id);
    const chunked = chunkContent(memory.content);
    if (!chunked.chunked) {
      if (existing.length === 0) continue;
      changed += 1;
      if (options.write === true) {
        for (const stale of existing) {
          await storage.invalidateMemory(stale.frontmatter.id);
        }
      }
      continue;
    }
    const desired = chunked.chunks.map((chunk) => chunk.content);
    if (sameChunkContent(existing, desired)) continue;
    changed += 1;
    if (options.write !== true) continue;

    const total = chunked.chunks.length;
    for (const chunk of chunked.chunks) {
      const existingChunk = existing[chunk.index];
      if (existingChunk) {
        await storage.updateMemory(existingChunk.frontmatter.id, chunk.content);
        await storage.updateMemoryFrontmatter(existingChunk.frontmatter.id, {
          chunkIndex: chunk.index,
          chunkTotal: total,
          updated: new Date().toISOString(),
        });
        continue;
      }
      await storage.writeChunk(
        memory.frontmatter.id,
        chunk.index,
        total,
        memory.frontmatter.category,
        chunk.content,
        {
          confidence: memory.frontmatter.confidence,
          tags: memory.frontmatter.tags,
          entityRef: memory.frontmatter.entityRef,
          source: "migration-rechunk",
          importance: memory.frontmatter.importance,
          intentGoal: memory.frontmatter.intentGoal,
          intentActionType: memory.frontmatter.intentActionType,
          intentEntityTypes: memory.frontmatter.intentEntityTypes,
          memoryKind: memory.frontmatter.memoryKind,
        },
      );
    }
    for (let idx = total; idx < existing.length; idx += 1) {
      const stale = existing[idx];
      if (stale?.frontmatter?.id) {
        await storage.invalidateMemory(stale.frontmatter.id);
      }
    }
  }

  return {
    action: "rechunk",
    dryRun: options.write !== true,
    scanned: candidates.length,
    changed,
    queued: 0,
    limit,
  };
}

export async function runMigrateReextractCliCommand(
  orchestrator: MigrateCliOrchestrator,
  options: { model: string; write?: boolean; limit?: number },
): Promise<MigrateCliReport> {
  const model = options.model.trim();
  if (model.length === 0) {
    throw new Error("missing --model for migrate reextract");
  }
  const limit = clampMigrateLimit(options.limit, REEXTRACT_LIMIT_CAP, 100);
  const storage = await orchestrator.getStorage(orchestrator.config.defaultNamespace);
  const candidates = (await readMigrateCandidateMemories(storage, { includeArchived: false }))
    .filter((memory) => memory.frontmatter.parentId === undefined);
  const selected = candidates.slice(0, limit);
  let queued = 0;
  if (options.write === true && selected.length > 0) {
    queued = await storage.appendReextractJobs(
      selected.map((memory) => ({
        memoryId: memory.frontmatter.id,
        model,
        requestedAt: new Date().toISOString(),
        source: "cli-migrate",
      })),
    );
  }

  return {
    action: "reextract",
    dryRun: options.write !== true,
    scanned: selected.length,
    changed: selected.length,
    queued,
    limit,
    model,
  };
}

interface RuntimePolicySnapshotPayload {
  version: number;
  updatedAt: string;
  values: RuntimePolicyValues;
  sourceAdjustmentCount: number;
}

interface PolicySignalContribution {
  signalType: string;
  direction: string;
  count: number;
  lastSeenAt: string;
}

export interface PolicyStatusCliReport {
  generatedAt: string;
  autoTuneEnabled: boolean;
  current: (RuntimePolicySnapshotPayload & { policyVersion: string }) | null;
  previous: (RuntimePolicySnapshotPayload & { policyVersion: string }) | null;
  topContributingSignals: PolicySignalContribution[];
}

export interface PolicyDiffEntry {
  parameter: string;
  previousValue: number | null;
  nextValue: number | null;
  delta: number;
  evidenceCount: number;
}

export interface PolicyDiffCliReport {
  generatedAt: string;
  since: string;
  sinceIso: string;
  currentPolicyVersion: string | null;
  previousPolicyVersion: string | null;
  deltas: PolicyDiffEntry[];
  topContributingSignals: PolicySignalContribution[];
}

export interface PolicyRollbackCliReport {
  generatedAt: string;
  rolledBack: boolean;
  current: (RuntimePolicySnapshotPayload & { policyVersion: string }) | null;
}

export interface PolicyTuningCliOrchestrator {
  config: {
    memoryDir: string;
    defaultNamespace: string;
    sharedNamespace: string;
    namespacesEnabled: boolean;
    behaviorLoopAutoTuneEnabled: boolean;
    behaviorLoopLearningWindowDays: number;
    lifecycleArchiveDecayThreshold: number;
    recencyWeight: number;
    lifecyclePromoteHeatThreshold: number;
    lifecycleStaleDecayThreshold: number;
    cronRecallInstructionHeavyTokenCap: number;
    namespacePolicies: Array<{ name: string }>;
  };
  getStorage(namespace?: string): Promise<{
    readBehaviorSignals(limit?: number): Promise<BehaviorSignalEvent[]>;
  }>;
  rollbackBehaviorRuntimePolicy(): Promise<boolean>;
}

function effectivePolicyValuesForVersion(
  values: RuntimePolicyValues,
  config: PolicyTuningCliOrchestrator["config"],
): Required<RuntimePolicyValues> {
  const candidate: RuntimePolicyValues = {
    recencyWeight: values.recencyWeight ?? config.recencyWeight,
    lifecyclePromoteHeatThreshold: values.lifecyclePromoteHeatThreshold ?? config.lifecyclePromoteHeatThreshold,
    lifecycleStaleDecayThreshold: values.lifecycleStaleDecayThreshold ?? config.lifecycleStaleDecayThreshold,
    cronRecallInstructionHeavyTokenCap:
      values.cronRecallInstructionHeavyTokenCap ?? config.cronRecallInstructionHeavyTokenCap,
  };
  const normalized = sanitizeRuntimePolicyValues(candidate, {
    maxStaleDecayThreshold: config.lifecycleArchiveDecayThreshold,
  });
  return {
    recencyWeight: normalized.recencyWeight ?? config.recencyWeight,
    lifecyclePromoteHeatThreshold:
      normalized.lifecyclePromoteHeatThreshold ?? config.lifecyclePromoteHeatThreshold,
    lifecycleStaleDecayThreshold:
      normalized.lifecycleStaleDecayThreshold ?? config.lifecycleStaleDecayThreshold,
    cronRecallInstructionHeavyTokenCap:
      normalized.cronRecallInstructionHeavyTokenCap ?? config.cronRecallInstructionHeavyTokenCap,
  };
}

function policyVersionForValues(
  values: RuntimePolicyValues,
  config: PolicyTuningCliOrchestrator["config"],
): string {
  const normalized = effectivePolicyValuesForVersion(values, config);
  return createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex")
    .slice(0, 12);
}

async function readRuntimePolicySnapshot(
  config: PolicyTuningCliOrchestrator["config"],
  fileName: string,
): Promise<RuntimePolicySnapshotPayload | null> {
  const filePath = path.join(config.memoryDir, "state", fileName);
  const snapshot = await readPolicyRuntimeSnapshot(filePath, {
    maxStaleDecayThreshold: config.lifecycleArchiveDecayThreshold,
  });
  if (!snapshot) return null;
  return {
    version: snapshot.version,
    updatedAt: snapshot.updatedAt,
    values: snapshot.values,
    sourceAdjustmentCount: Math.max(0, Math.floor(snapshot.sourceAdjustmentCount)),
  };
}

/**
 * Parse a date string strictly. Thin re-export of the canonical
 * implementation in `training-export/date-parse.ts` so that the
 * `@remnic/cli` front-end and the core CLI use identical semantics
 * (CLAUDE.md #22: shared helpers must not be re-implemented per caller).
 *
 * Existing imports of `parseStrictCliDate` from `./cli.js` continue to
 * work — this re-export preserves backward compatibility for the
 * `cli-date-validation.test.ts` suite.
 */
export const parseStrictCliDate = parseStrictCliDateShared;

function parseSinceDurationMs(since: string): number {
  const trimmed = since.trim().toLowerCase();
  const match = trimmed.match(/^(\d+)\s*([mhd])$/);
  if (!match) {
    throw new Error(`invalid --since value: ${since} (expected formats like 30m, 12h, 7d)`);
  }
  const amount = Number.parseInt(match[1] ?? "0", 10);
  const unit = match[2];
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`invalid --since value: ${since}`);
  }
  if (unit === "m") return amount * 60 * 1000;
  if (unit === "h") return amount * 60 * 60 * 1000;
  return amount * 24 * 60 * 60 * 1000;
}

/**
 * Parse an ISO 8601 duration string (e.g. "P1Y", "P90D", "P6M") or a plain
 * integer number of days (e.g. "365", "90") into milliseconds.
 *
 * Returns null if the value cannot be parsed.
 */
export function parseDurationToMs(raw: string): number | null {
  const trimmed = raw.trim();

  // Plain number of days
  if (/^\d+$/.test(trimmed)) {
    const days = Number.parseInt(trimmed, 10);
    return Number.isFinite(days) && days > 0 ? days * 86_400_000 : null;
  }

  // ISO 8601 duration: P[nY][nM][nW][nD][T[nH][nM][nS]]
  // Calendar units are normalized for retention policy use: 1Y=365D, 1M=30D.
  // Must be fully consumed by recognised components; partial matches like
  // "P90DX" or "P1Yjunk" are rejected rather than silently truncated.
  const iso = trimmed.toUpperCase();
  if (!iso.startsWith("P")) return null;

  const match = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
  if (
    !match ||
    (match[1] === undefined &&
      match[2] === undefined &&
      match[3] === undefined &&
      match[4] === undefined &&
      match[5] === undefined &&
      match[6] === undefined &&
      match[7] === undefined)
  ) {
    return null;
  }
  if (iso.includes("T") && match[5] === undefined && match[6] === undefined && match[7] === undefined) {
    return null;
  }

  let totalMs = 0;
  if (match[1]) totalMs += Number.parseInt(match[1], 10) * 365 * 86_400_000;
  if (match[2]) totalMs += Number.parseInt(match[2], 10) * 30 * 86_400_000;
  if (match[3]) totalMs += Number.parseInt(match[3], 10) * 7 * 86_400_000;
  if (match[4]) totalMs += Number.parseInt(match[4], 10) * 86_400_000;
  if (match[5]) totalMs += Number.parseInt(match[5], 10) * 60 * 60 * 1000;
  if (match[6]) totalMs += Number.parseInt(match[6], 10) * 60 * 1000;
  if (match[7]) totalMs += Number.parseInt(match[7], 10) * 1000;

  return Number.isFinite(totalMs) && totalMs > 0 ? totalMs : null;
}

const NON_FATAL_PURGE_ERROR_IDS = new Set([
  "(purge-audit)",
  "(fact-hash-index)",
]);

export function hasDestructivePurgeFailures(
  errors: Array<{ id: string }>,
): boolean {
  return errors.some((error) => !NON_FATAL_PURGE_ERROR_IDS.has(error.id));
}

function resolvePolicySignalNamespaces(orchestrator: PolicyTuningCliOrchestrator): string[] {
  const names = new Set<string>([orchestrator.config.defaultNamespace]);
  if (orchestrator.config.namespacesEnabled) {
    names.add(orchestrator.config.sharedNamespace);
    for (const policy of orchestrator.config.namespacePolicies) {
      if (policy?.name) names.add(policy.name);
    }
  }
  return [...names];
}

async function readBehaviorSignalsForNamespaces(
  orchestrator: PolicyTuningCliOrchestrator,
  limitPerNamespace: number,
): Promise<BehaviorSignalEvent[]> {
  const namespaces = resolvePolicySignalNamespaces(orchestrator);
  const merged: BehaviorSignalEvent[] = [];
  for (const namespace of namespaces) {
    const storage = await orchestrator.getStorage(namespace);
    const events = await storage.readBehaviorSignals(limitPerNamespace);
    merged.push(...events);
  }
  return merged;
}

function summarizeTopSignals(
  signals: BehaviorSignalEvent[],
  cutoffIso?: string,
  topN: number = 5,
): PolicySignalContribution[] {
  const cutoffMs = cutoffIso ? Date.parse(cutoffIso) : Number.NEGATIVE_INFINITY;
  const grouped = new Map<string, PolicySignalContribution>();
  for (const signal of signals) {
    const ts = Date.parse(signal.timestamp);
    if (Number.isFinite(cutoffMs) && (!Number.isFinite(ts) || ts < cutoffMs)) continue;
    const key = `${signal.signalType}:${signal.direction}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
      if (signal.timestamp > existing.lastSeenAt) {
        existing.lastSeenAt = signal.timestamp;
      }
    } else {
      grouped.set(key, {
        signalType: signal.signalType,
        direction: signal.direction,
        count: 1,
        lastSeenAt: signal.timestamp,
      });
    }
  }

  return [...grouped.values()]
    .sort((a, b) => b.count - a.count || b.lastSeenAt.localeCompare(a.lastSeenAt))
    .slice(0, Math.max(1, topN));
}

export async function runPolicyStatusCliCommand(
  orchestrator: PolicyTuningCliOrchestrator,
): Promise<PolicyStatusCliReport> {
  const now = new Date();
  const current = await readRuntimePolicySnapshot(orchestrator.config, "policy-runtime.json");
  const previous = await readRuntimePolicySnapshot(orchestrator.config, "policy-runtime.prev.json");
  const signals = await readBehaviorSignalsForNamespaces(orchestrator, 1000);
  const defaultWindowMs = Math.max(0, orchestrator.config.behaviorLoopLearningWindowDays) * 24 * 60 * 60 * 1000;
  const cutoffIso = defaultWindowMs > 0 ? new Date(now.getTime() - defaultWindowMs).toISOString() : undefined;

  return {
    generatedAt: now.toISOString(),
    autoTuneEnabled: orchestrator.config.behaviorLoopAutoTuneEnabled,
    current: current
      ? {
        ...current,
        policyVersion: policyVersionForValues(current.values, orchestrator.config),
      }
      : null,
    previous: previous
      ? {
        ...previous,
        policyVersion: policyVersionForValues(previous.values, orchestrator.config),
      }
      : null,
    topContributingSignals: summarizeTopSignals(signals, cutoffIso),
  };
}

export async function runPolicyDiffCliCommand(
  orchestrator: PolicyTuningCliOrchestrator,
  options: { since?: string } = {},
): Promise<PolicyDiffCliReport> {
  const since = options.since?.trim() || "7d";
  const sinceMs = parseSinceDurationMs(since);
  const sinceIso = new Date(Date.now() - sinceMs).toISOString();
  const current = await readRuntimePolicySnapshot(orchestrator.config, "policy-runtime.json");
  const previous = await readRuntimePolicySnapshot(orchestrator.config, "policy-runtime.prev.json");
  const currentValues = current?.values ?? {};
  const previousValues = previous?.values ?? {};
  const parameterKeys = new Set<string>([
    ...Object.keys(currentValues),
    ...Object.keys(previousValues),
  ]);
  const deltas: PolicyDiffEntry[] = [];
  for (const parameter of parameterKeys) {
    const previousRaw = (previousValues as Record<string, unknown>)[parameter];
    const nextRaw = (currentValues as Record<string, unknown>)[parameter];
    const previousValue = typeof previousRaw === "number" ? previousRaw : null;
    const nextValue = typeof nextRaw === "number" ? nextRaw : null;
    if (previousValue === nextValue) continue;
    deltas.push({
      parameter,
      previousValue,
      nextValue,
      delta: (nextValue ?? 0) - (previousValue ?? 0),
      evidenceCount: current?.sourceAdjustmentCount ?? 0,
    });
  }
  deltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.parameter.localeCompare(b.parameter));

  const signals = await readBehaviorSignalsForNamespaces(orchestrator, 1000);
  return {
    generatedAt: new Date().toISOString(),
    since,
    sinceIso,
    currentPolicyVersion: current ? policyVersionForValues(current.values, orchestrator.config) : null,
    previousPolicyVersion: previous ? policyVersionForValues(previous.values, orchestrator.config) : null,
    deltas,
    topContributingSignals: summarizeTopSignals(signals, sinceIso),
  };
}

export async function runPolicyRollbackCliCommand(
  orchestrator: PolicyTuningCliOrchestrator,
): Promise<PolicyRollbackCliReport> {
  const rolledBack = await orchestrator.rollbackBehaviorRuntimePolicy();
  const current = await readRuntimePolicySnapshot(orchestrator.config, "policy-runtime.json");
  return {
    generatedAt: new Date().toISOString(),
    rolledBack,
    current: current
      ? {
        ...current,
        policyVersion: policyVersionForValues(current.values, orchestrator.config),
      }
      : null,
  };
}

function incrementCounter(target: Record<string, number>, key: string): void {
  const normalized = key && key.length > 0 ? key : "unknown";
  target[normalized] = (target[normalized] ?? 0) + 1;
}

function resolveAuditNamespaces(
  orchestrator: MemoryActionAuditCliOrchestrator,
  namespace?: string,
): string[] {
  if (namespace && namespace.length > 0) {
    return [namespace];
  }

  const names = new Set<string>([orchestrator.config.defaultNamespace]);
  if (orchestrator.config.namespacesEnabled) {
    names.add(orchestrator.config.sharedNamespace);
    for (const policy of orchestrator.config.namespacePolicies) {
      if (policy?.name) names.add(policy.name);
    }
  }

  return [...names];
}

export async function runMemoryActionAuditCliCommand(
  orchestrator: MemoryActionAuditCliOrchestrator,
  options: MemoryActionAuditCliCommandOptions = {},
): Promise<MemoryActionAuditCliReport> {
  const limit = Math.max(0, Math.floor(options.limit ?? 200));
  const namespaces = resolveAuditNamespaces(orchestrator, options.namespace);

  const namespaceSummaries: MemoryActionAuditCliNamespaceSummary[] = [];
  const totalsActions: Record<string, number> = {};
  const totalsOutcomes: Record<string, number> = {};
  const totalsPolicyDecisions: Record<string, number> = {};
  let totalEventCount = 0;

  for (const ns of namespaces) {
    const storage = await orchestrator.getStorage(ns);
    const events = await storage.readMemoryActionEvents(limit);

    const actions: Record<string, number> = {};
    const outcomes: Record<string, number> = {};
    const policyDecisions: Record<string, number> = {};

    for (const event of events) {
      incrementCounter(actions, event.action);
      incrementCounter(outcomes, event.outcome);
      incrementCounter(policyDecisions, event.policyDecision ?? "unknown");

      incrementCounter(totalsActions, event.action);
      incrementCounter(totalsOutcomes, event.outcome);
      incrementCounter(totalsPolicyDecisions, event.policyDecision ?? "unknown");
    }

    totalEventCount += events.length;
    namespaceSummaries.push({
      namespace: ns,
      eventCount: events.length,
      actions,
      outcomes,
      policyDecisions,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    limit,
    namespaces: namespaceSummaries,
    totals: {
      eventCount: totalEventCount,
      actions: totalsActions,
      outcomes: totalsOutcomes,
      policyDecisions: totalsPolicyDecisions,
    },
  };
}

export async function runTailscaleStatusCliCommand(
  options: TailscaleStatusCliCommandOptions = {},
): Promise<{
  available: boolean;
  running: boolean;
  backendState?: string;
  version?: string;
  selfHostname?: string;
  selfIp?: string;
}> {
  const helper = options.helper ?? new TailscaleHelper({ timeoutMs: options.timeoutMs });
  return helper.status();
}

export async function runTailscaleSyncCliCommand(
  options: TailscaleSyncCliCommandOptions,
): Promise<{ ok: true }> {
  const helper = options.helper ?? new TailscaleHelper();
  await helper.syncDirectory({
    sourceDir: options.sourceDir,
    destination: options.destination,
    delete: options.delete,
    dryRun: options.dryRun,
    extraArgs: options.extraArgs,
  });
  return { ok: true };
}

export async function runWebDavServeCliCommand(
  options: WebDavServeCliCommandOptions,
): Promise<{ running: boolean; host: string; port: number; rootCount: number }> {
  return withWebDavLock(async () => {
    if (!Array.isArray(options.allowlistDirs) || options.allowlistDirs.length === 0) {
      throw new Error("webdav allowlist requires at least one directory");
    }

    const usernameProvided = options.authUsername !== undefined;
    const passwordProvided = options.authPassword !== undefined;
    const username = options.authUsername?.trim();
    const password = options.authPassword?.trim();

    if ((usernameProvided && !username) || (passwordProvided && !password)) {
      throw new Error("webdav auth username/password must be non-empty when provided");
    }

    if ((username && !password) || (!username && password)) {
      throw new Error("webdav auth requires both username and password");
    }

    if (activeWebDavServer) {
      const current = activeWebDavServer.status();
      if (current.running) return current;
    }

    const createServer = options.createServer ?? WebDavServer.create;
    const server = await createServer({
      enabled: options.enabled ?? true,
      host: options.host,
      port: options.port ?? 8080,
      allowlistDirs: options.allowlistDirs,
      auth: username && password ? { username, password } : undefined,
    });

    activeWebDavServer = server;
    try {
      return await server.start();
    } catch (err) {
      if (activeWebDavServer === server) {
        activeWebDavServer = null;
      }
      throw err;
    }
  });
}

export async function runWebDavStopCliCommand(): Promise<{ stopped: boolean }> {
  return withWebDavLock(async () => {
    if (!activeWebDavServer) {
      return { stopped: false };
    }

    const server = activeWebDavServer;
    await server.stop();
    if (activeWebDavServer === server) {
      activeWebDavServer = null;
    }
    return { stopped: true };
  });
}

export async function runDashboardStartCliCommand(
  options: DashboardStartCliCommandOptions,
): Promise<DashboardStatus> {
  return withDashboardLock(async () => {
    if (activeDashboardServer) {
      const status = activeDashboardServer.status();
      if (status.running) return status;
    }

    const createServer = options.createServer ?? ((opts: DashboardStartCliCommandOptions) =>
      new GraphDashboardServer({
        memoryDir: opts.memoryDir,
        host: opts.host,
        port: opts.port,
        publicDir: opts.publicDir,
      }));

    const server = createServer(options);
    activeDashboardServer = server;
    try {
      return await server.start();
    } catch (err) {
      if (activeDashboardServer === server) {
        activeDashboardServer = null;
      }
      throw err;
    }
  });
}

export async function runDashboardStopCliCommand(): Promise<{ stopped: boolean }> {
  return withDashboardLock(async () => {
    if (!activeDashboardServer) return { stopped: false };
    const server = activeDashboardServer;
    await server.stop();
    if (activeDashboardServer === server) {
      activeDashboardServer = null;
    }
    return { stopped: true };
  });
}

export async function runDashboardStatusCliCommand(): Promise<{ running: false } | DashboardStatus> {
  return withDashboardLock(async () => {
    if (!activeDashboardServer) return { running: false };
    return activeDashboardServer.status();
  });
}

export async function runAccessHttpServeCliCommand(
  options: AccessHttpServeCliCommandOptions,
): Promise<{ running: boolean; host: string; port: number; maxBodyBytes: number }> {
  return withAccessHttpLock(async () => {
    if (options.enabled === false) {
      throw new Error("engram access HTTP is disabled");
    }
    if (activeAccessHttpServer) {
      const status = activeAccessHttpServer.status();
      if (status.running) return status;
    }

    const createServer = options.createServer ?? ((input: AccessHttpServeCliCommandOptions) =>
      new EngramAccessHttpServer({
        service: input.service,
        host: input.host,
        port: input.port,
        authToken: input.authToken,
        principal: input.principal,
        maxBodyBytes: input.maxBodyBytes,
        trustPrincipalHeader: input.trustPrincipalHeader,
        citationsEnabled: input.citationsEnabled,
        citationsAutoDetect: input.citationsAutoDetect,
      }));

    const server = createServer(options);
    activeAccessHttpServer = server;
    try {
      return await server.start();
    } catch (err) {
      if (activeAccessHttpServer === server) {
        activeAccessHttpServer = null;
      }
      throw err;
    }
  });
}

export async function runAccessHttpStopCliCommand(): Promise<{ stopped: boolean }> {
  return withAccessHttpLock(async () => {
    if (!activeAccessHttpServer) return { stopped: false };
    const server = activeAccessHttpServer;
    await server.stop();
    if (activeAccessHttpServer === server) {
      activeAccessHttpServer = null;
    }
    return { stopped: true };
  });
}

export async function runAccessHttpStatusCliCommand(): Promise<
  { running: false } | { running: boolean; host: string; port: number; maxBodyBytes: number }
> {
  return withAccessHttpLock(async () => {
    if (!activeAccessHttpServer) return { running: false };
    return activeAccessHttpServer.status();
  });
}

export async function runAccessMcpServeCliCommand(
  service: EngramAccessService,
  options: {
    principal?: string;
    createServer?: (service: EngramAccessService, options: { principal?: string }) => EngramMcpServerLike;
    stdin?: Readable;
    stdout?: Writable;
  } = {},
): Promise<{ ok: true }> {
  const server = options.createServer?.(service, { principal: options.principal }) ?? new EngramMcpServer(service, {
    principal: options.principal,
  });
  await server.runStdio(options.stdin ?? process.stdin, options.stdout ?? process.stdout);
  return { ok: true };
}

export async function runCompatCliCommand(
  options: CompatCliCommandOptions = {},
): Promise<{ report: CompatReport; exitCode: number }> {
  const report = await runCompatChecks({
    repoRoot: options.repoRoot ?? process.cwd(),
    runner: options.runner,
    now: options.now,
  });
  const hasWarnOrError = report.summary.warn > 0 || report.summary.error > 0;
  const exitCode = options.strict === true && hasWarnOrError ? 1 : 0;
  return { report, exitCode };
}

export async function runRouteCliCommand(options: RouteCliCommandOptions): Promise<unknown> {
  const store = new RoutingRulesStore(options.memoryDir, options.stateFile);

  if (options.action === "list") {
    const rules = await store.read();
    return [...rules].sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.pattern.localeCompare(b.pattern);
    });
  }

  if (options.action === "add") {
    const pattern = options.pattern?.trim();
    if (!pattern) throw new Error("missing pattern");
    if (!options.targetRaw || options.targetRaw.trim().length === 0) throw new Error("missing target");
    const patternType = options.patternType ?? "keyword";
    if (!isRoutePatternType(patternType)) throw new Error(`invalid route pattern type: ${patternType}`);
    const priority = options.priority ?? 0;
    if (!Number.isFinite(priority)) throw new Error("invalid priority");
    const target = parseRouteTargetCliArg(options.targetRaw);
    const validation = validateRouteTarget(target);
    if (!validation.ok || !validation.target) throw new Error(validation.error ?? "invalid target");

    const rule: RouteRule = {
      id: options.id?.trim() || "",
      patternType,
      pattern,
      priority: Math.trunc(priority),
      target: validation.target,
      enabled: true,
    };
    return store.upsert(rule);
  }

  if (options.action === "remove") {
    const pattern = options.pattern?.trim();
    if (!pattern) throw new Error("missing pattern");
    return store.removeByPattern(pattern);
  }

  if (options.action === "test") {
    const text = options.text?.trim();
    if (!text) throw new Error("missing text");
    const rules = await store.read();
    return selectRouteRule(text, rules);
  }

  throw new Error(`unsupported route action: ${options.action}`);
}

export async function runWorkTaskCliCommand(options: WorkTaskCliCommandOptions): Promise<unknown> {
  const storage = new WorkStorage(options.memoryDir);

  if (options.action === "create") {
    if (!options.title || options.title.trim().length === 0) throw new Error("missing title");
    if (options.status !== undefined && !isWorkTaskStatus(options.status)) throw new Error(`invalid task status: ${options.status}`);
    if (options.priority !== undefined && !isWorkTaskPriority(options.priority)) {
      throw new Error(`invalid task priority: ${options.priority}`);
    }
    const explicitId = options.id?.trim();
    if (explicitId && explicitId.length > 0) {
      const existing = await storage.getTask(explicitId);
      if (existing) throw new Error(`task already exists: ${explicitId}`);
    }
    return storage.createTask({
      id: explicitId && explicitId.length > 0 ? explicitId : undefined,
      title: options.title.trim(),
      description: options.description?.trim(),
      status: options.status,
      priority: options.priority,
      owner: normalizeNullableCliValue(options.owner),
      assignee: normalizeNullableCliValue(options.assignee),
      projectId: normalizeNullableCliValue(options.projectId),
      tags: options.tags,
      dueAt: normalizeNullableCliValue(options.dueAt),
    });
  }

  if (options.action === "get") {
    if (!options.id || options.id.trim().length === 0) throw new Error("missing id");
    return storage.getTask(options.id.trim());
  }

  if (options.action === "list") {
    if (options.status !== undefined && !isWorkTaskStatus(options.status)) throw new Error(`invalid task status: ${options.status}`);
    return storage.listTasks({
      status: options.status,
      owner: options.owner?.trim() || undefined,
      assignee: options.assignee?.trim() || undefined,
      projectId: options.projectId?.trim() || undefined,
    });
  }

  if (options.action === "update") {
    if (!options.id || options.id.trim().length === 0) throw new Error("missing id");
    const patch = options.patch ?? {};
    if (patch.status !== undefined && !isWorkTaskStatus(patch.status)) throw new Error(`invalid task status: ${patch.status}`);
    if (patch.priority !== undefined && !isWorkTaskPriority(patch.priority)) {
      throw new Error(`invalid task priority: ${patch.priority}`);
    }

    const sparsePatch: WorkTaskPatchInput = {};
    if (Object.prototype.hasOwnProperty.call(patch, "title")) sparsePatch.title = patch.title;
    if (Object.prototype.hasOwnProperty.call(patch, "description")) sparsePatch.description = patch.description;
    if (Object.prototype.hasOwnProperty.call(patch, "status")) sparsePatch.status = patch.status;
    if (Object.prototype.hasOwnProperty.call(patch, "priority")) sparsePatch.priority = patch.priority;
    if (Object.prototype.hasOwnProperty.call(patch, "owner")) sparsePatch.owner = patch.owner;
    if (Object.prototype.hasOwnProperty.call(patch, "assignee")) sparsePatch.assignee = patch.assignee;
    if (Object.prototype.hasOwnProperty.call(patch, "projectId")) sparsePatch.projectId = patch.projectId;
    if (Object.prototype.hasOwnProperty.call(patch, "tags")) sparsePatch.tags = patch.tags;
    if (Object.prototype.hasOwnProperty.call(patch, "dueAt")) sparsePatch.dueAt = patch.dueAt;

    return storage.updateTask(options.id.trim(), sparsePatch);
  }

  if (options.action === "transition") {
    if (!options.id || options.id.trim().length === 0) throw new Error("missing id");
    if (!options.status || !isWorkTaskStatus(options.status)) throw new Error(`invalid task status: ${options.status}`);
    return storage.transitionTask(options.id.trim(), options.status);
  }

  if (options.action === "delete") {
    if (!options.id || options.id.trim().length === 0) throw new Error("missing id");
    return storage.deleteTask(options.id.trim());
  }

  if (options.action === "link") {
    if (!options.id || options.id.trim().length === 0) throw new Error("missing id");
    if (!options.projectId || options.projectId.trim().length === 0) throw new Error("missing projectId");
    return storage.linkTaskToProject(options.id.trim(), options.projectId.trim());
  }

  throw new Error(`unsupported task action: ${options.action}`);
}

export async function runWorkProjectCliCommand(options: WorkProjectCliCommandOptions): Promise<unknown> {
  const storage = new WorkStorage(options.memoryDir);

  if (options.action === "create") {
    if (!options.name || options.name.trim().length === 0) throw new Error("missing name");
    if (options.status !== undefined && !isWorkProjectStatus(options.status)) {
      throw new Error(`invalid project status: ${options.status}`);
    }
    const explicitId = options.id?.trim();
    if (explicitId && explicitId.length > 0) {
      const existing = await storage.getProject(explicitId);
      if (existing) throw new Error(`project already exists: ${explicitId}`);
    }
    return storage.createProject({
      id: explicitId && explicitId.length > 0 ? explicitId : undefined,
      name: options.name.trim(),
      description: options.description?.trim(),
      status: options.status,
      owner: normalizeNullableCliValue(options.owner),
      tags: options.tags,
    });
  }

  if (options.action === "get") {
    if (!options.id || options.id.trim().length === 0) throw new Error("missing id");
    return storage.getProject(options.id.trim());
  }

  if (options.action === "list") {
    return storage.listProjects();
  }

  if (options.action === "update") {
    if (!options.id || options.id.trim().length === 0) throw new Error("missing id");
    const patch = options.patch ?? {};
    if (patch.status !== undefined && !isWorkProjectStatus(patch.status)) {
      throw new Error(`invalid project status: ${patch.status}`);
    }

    const sparsePatch: WorkProjectPatchInput = {};
    if (Object.prototype.hasOwnProperty.call(patch, "name")) sparsePatch.name = patch.name;
    if (Object.prototype.hasOwnProperty.call(patch, "description")) sparsePatch.description = patch.description;
    if (Object.prototype.hasOwnProperty.call(patch, "status")) sparsePatch.status = patch.status;
    if (Object.prototype.hasOwnProperty.call(patch, "owner")) sparsePatch.owner = patch.owner;
    if (Object.prototype.hasOwnProperty.call(patch, "tags")) sparsePatch.tags = patch.tags;

    return storage.updateProject(options.id.trim(), sparsePatch);
  }

  if (options.action === "delete") {
    if (!options.id || options.id.trim().length === 0) throw new Error("missing id");
    return storage.deleteProject(options.id.trim());
  }

  throw new Error(`unsupported project action: ${options.action}`);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runReplayCliCommand(
  orchestrator: ReplayCliOrchestrator,
  options: ReplayCliCommandOptions,
): Promise<ReplayRunSummary> {
  const extractionIdleTimeoutMs = Number.isFinite(options.extractionIdleTimeoutMs as number)
    ? Math.max(1_000, Math.floor(options.extractionIdleTimeoutMs as number))
    : 15 * 60_000;
  const inputRaw = await readFile(options.inputPath, "utf-8");
  const registry = buildReplayNormalizerRegistry([
    openclawReplayNormalizer,
    claudeReplayNormalizer,
    chatgptReplayNormalizer,
  ]);
  const ingestBatchSize = clampBatchSize(options.batchSize);
  const turnsBySession = new Map<string, ReplayTurn[]>();
  const ingestSessionChunk = async (sessionTurns: ReplayTurn[]): Promise<void> => {
    const deadlineMs = Date.now() + extractionIdleTimeoutMs;
    await withTimeout(
      orchestrator.ingestReplayBatch(sessionTurns, { deadlineMs }),
      extractionIdleTimeoutMs,
      `replay extraction batch did not complete before timeout (${extractionIdleTimeoutMs}ms)`,
    );
  };

  const summary = await runReplay(
    options.source,
    inputRaw,
    registry,
    {
      onBatch: async (batch) => {
        for (const turn of batch) {
          const key = normalizeReplaySessionKey(turn.sessionKey);
          const turns = turnsBySession.get(key) ?? [];
          turns.push(turn);
          turnsBySession.set(key, turns);
          while (turns.length >= ingestBatchSize) {
            const chunk = turns.splice(0, ingestBatchSize);
            await ingestSessionChunk(chunk);
          }
        }
      },
    },
    {
      from: options.from,
      to: options.to,
      dryRun: options.dryRun === true,
      startOffset: options.startOffset,
      maxTurns: options.maxTurns,
      batchSize: options.batchSize,
      defaultSessionKey: options.defaultSessionKey,
      strict: options.strict,
    },
  );

  if (!summary.dryRun) {
    for (const turns of turnsBySession.values()) {
      if (turns.length === 0) continue;
      await ingestSessionChunk(turns);
    }
    if (options.runConsolidation === true) {
      const consolidationIdle = await orchestrator.waitForConsolidationIdle(extractionIdleTimeoutMs);
      if (!consolidationIdle) {
        throw new Error(
          `replay consolidation did not become idle before timeout (${extractionIdleTimeoutMs}ms)`,
        );
      }
      await orchestrator.runConsolidationNow();
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Bulk-import CLI command
// ---------------------------------------------------------------------------

export interface BulkImportCliCommandOptions {
  memoryDir: string;
  source: string;
  file: string;
  batchSize?: number;
  dryRun?: boolean;
  verbose?: boolean;
  strict?: boolean;
  /**
   * Optional adapter-specific platform hint forwarded to `adapter.parse`.
   * Some bulk-import adapters (e.g. weclone) accept a platform discriminator
   * so a single adapter can parse Telegram JSON, WeChat JSON, etc. without
   * shipping a separate source for each. When undefined, adapters pick a
   * default based on file shape.
   */
  platform?: string;
  /**
   * Callback that actually performs extraction + persistence for a batch of
   * parsed turns. Supplied by the host CLI (which has the orchestrator in
   * scope). When omitted, non-dryRun invocations fail fast with a clear
   * error — this protects library callers that have not wired persistence
   * yet and keeps the contract explicit rather than silently dropping turns.
   */
  ingestBatch?: ProcessBatchFn;
  stdout: Writable;
  stderr: Writable;
}

/**
 * Attempt to lazily register built-in bulk-import adapters.  Adapters
 * live in optional workspace packages (e.g. `@remnic/import-weclone`)
 * so that core stays framework-agnostic; we try the dynamic import and
 * silently continue if the package is absent or the adapter is already
 * registered.  Errors from the dynamic import are swallowed so a missing
 * optional package does not break other bulk-import sources.
 */
async function ensureBuiltInBulkImportAdapters(): Promise<void> {
  // weclone — imported via a computed specifier so the TypeScript dts
  // resolver doesn't require `@remnic/import-weclone` to be present at
  // core-build time.  The package declares it as an optional workspace
  // dependency; if it's missing from a given deployment we silently
  // skip registration.
  if (!getBulkImportSource("weclone")) {
    const wecloneSpecifier = "@remnic/" + "import-weclone";
    try {
      const mod = (await import(wecloneSpecifier)) as {
        wecloneImportAdapter?: BulkImportSourceAdapter;
      };
      if (mod.wecloneImportAdapter) {
        try {
          registerBulkImportSource(mod.wecloneImportAdapter);
        } catch {
          // Already registered by another caller — fine.
        }
      }
    } catch {
      // Package not installed in this deployment; skip.
    }
  }
}

export async function runBulkImportCliCommand(
  opts: BulkImportCliCommandOptions,
): Promise<BulkImportResult> {
  await ensureBuiltInBulkImportAdapters();

  const adapter = getBulkImportSource(opts.source);
  if (!adapter) {
    const registered = listBulkImportSources();
    const list =
      registered.length > 0
        ? registered.map((n) => `'${n}'`).join(", ")
        : "(none registered)";
    throw new Error(
      `Unknown bulk-import source '${opts.source}'. ` +
        `Valid sources: ${list}`,
    );
  }

  // Guard: library callers that invoke `runBulkImportCliCommand` without an
  // `ingestBatch` wiring must fail loudly BEFORE reading/parsing the file.
  // Running the full parse would incur file I/O and memory pressure (imports
  // can be 100k+ messages) only to inevitably throw inside processBatch. The
  // adapter check above still fires first so `--source <unknown>` surfaces
  // the more-actionable "Unknown bulk-import source" error.
  if (opts.dryRun !== true && typeof opts.ingestBatch !== "function") {
    throw new Error(
      "Bulk import persistence is not wired: no ingestBatch callback " +
        "was provided by the host CLI. Use --dry-run to validate without " +
        "persisting, or invoke via `openclaw engram bulk-import` which " +
        "supplies the orchestrator-backed ingestion path.",
    );
  }

  const inputRaw = await readFile(opts.file, "utf-8");
  let inputParsed: unknown;
  try {
    inputParsed = JSON.parse(inputRaw);
  } catch (err) {
    throw new Error(
      `Failed to parse import file as JSON: ${(err as Error).message}`,
    );
  }
  if (typeof inputParsed !== "object" || inputParsed === null) {
    throw new Error(
      "Import file must contain a JSON object or array, got " +
        (inputParsed === null ? "null" : typeof inputParsed),
    );
  }
  const parsed = await adapter.parse(inputParsed, {
    strict: opts.strict === true,
    platform: opts.platform,
  });

  const processBatch: ProcessBatchFn =
    opts.ingestBatch ??
    (async () => {
      // Defensive fallback: the pipeline never calls processBatch in dryRun
      // mode and the guard above rejects non-dryRun without an ingestBatch,
      // so reaching here would indicate a bug in the pipeline contract.
      throw new Error(
        "Bulk import persistence is not wired: no ingestBatch callback " +
          "was provided by the host CLI.",
      );
    });

  const result = await runBulkImportPipeline(
    parsed,
    {
      batchSize: opts.batchSize,
      dryRun: opts.dryRun,
      dedup: true,
      trustLevel: "import",
    },
    processBatch,
  );

  const out = opts.stdout;
  out.write(`Bulk import complete (source: ${opts.source})\n`);
  out.write(`  Turns processed:     ${result.turnsProcessed}\n`);
  out.write(`  Batches processed:   ${result.batchesProcessed}\n`);
  out.write(`  Memories created:    ${result.memoriesCreated}\n`);
  out.write(`  Duplicates skipped:  ${result.duplicatesSkipped}\n`);
  if (result.errors.length > 0) {
    out.write(`  Errors:              ${result.errors.length}\n`);
    if (opts.verbose) {
      for (const err of result.errors) {
        opts.stderr.write(
          `    [batch ${err.batchIndex}] ${err.message}\n`,
        );
      }
    }
  }
  if (opts.dryRun) {
    out.write("  (dry run — no memories were stored)\n");
  }

  return result;
}

async function getPluginVersion(): Promise<string> {
  try {
    const pkgPath = new URL("../package.json", import.meta.url);
    const raw = await readFile(pkgPath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function resolveMemoryDirForNamespace(
  orchestrator: Orchestrator,
  namespace?: string,
  options?: { rejectUnsupportedOverride?: boolean },
): Promise<string> {
  const ns = (namespace ?? "").trim();
  if (!ns) return orchestrator.config.memoryDir;
  if (!orchestrator.config.namespacesEnabled) {
    if (options?.rejectUnsupportedOverride && ns !== orchestrator.config.defaultNamespace) {
      throw new Error(`namespaces are disabled; cannot target namespace: ${ns}`);
    }
    return orchestrator.config.memoryDir;
  }

  const candidate = path.join(orchestrator.config.memoryDir, "namespaces", ns);
  if (ns === orchestrator.config.defaultNamespace) {
    return (await exists(candidate)) ? candidate : orchestrator.config.memoryDir;
  }
  return candidate;
}

/**
 * Walk `memoryDir/{facts,corrections}` recursively and invoke `visit` for
 * every `*.md` file. Intentionally swallows per-directory errors so a missing
 * subdir reads as empty. Shared primitive for `listMemoryMarkdownFilePaths`,
 * `readAllMemoryFiles`, and any future walker that needs the same roots +
 * `.md` filter.
 */
async function walkMemoryMarkdownFiles(
  memoryDir: string,
  visit: (fullPath: string) => void | Promise<void>,
): Promise<void> {
  const roots = [path.join(memoryDir, "facts"), path.join(memoryDir, "corrections")];

  const walk = async (dir: string): Promise<void> => {
    let entries: Array<{ isDirectory(): boolean; isFile(): boolean; name: string | Buffer }>;
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as Array<{
        isDirectory(): boolean;
        isFile(): boolean;
        name: string | Buffer;
      }>;
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryName = typeof entry.name === "string" ? entry.name : entry.name.toString("utf-8");
      const fullPath = path.join(dir, entryName);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !entryName.endsWith(".md")) continue;
      await visit(fullPath);
    }
  };

  for (const root of roots) {
    await walk(root);
  }
}

/**
 * List absolute paths of every `*.md` file under `memoryDir/{facts,corrections}`.
 * Used by the bulk-import CLI to derive a per-batch `memoriesCreated` count
 * via set-subtraction of "paths after extraction" against "paths before
 * extraction". Caveat: the extraction queue is shared across sessions, so
 * concurrent organic extractions that write memories between the two
 * snapshots will still inflate the reported count. Filename-set diff at
 * least correctly ignores pre-existing files and files that were deleted
 * while the batch ran.
 */
async function listMemoryMarkdownFilePaths(memoryDir: string): Promise<string[]> {
  const paths: string[] = [];
  await walkMemoryMarkdownFiles(memoryDir, (fullPath) => {
    paths.push(fullPath);
  });
  return paths;
}

async function readAllMemoryFiles(memoryDir: string): Promise<DedupeCandidate[]> {
  const out: DedupeCandidate[] = [];
  await walkMemoryMarkdownFiles(memoryDir, async (fullPath) => {
    try {
      const raw = await readFile(fullPath, "utf-8");
      const parsed = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      if (!parsed) return;
      const fmRaw = parsed[1];
      const body = parsed[2] ?? "";
      const get = (key: string): string => {
        const match = fmRaw.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
        return match ? match[1].trim() : "";
      };
      const confidenceRaw = get("confidence");
      const confidence = confidenceRaw.length > 0 ? Number(confidenceRaw) : undefined;
      out.push({
        path: fullPath,
        content: body,
        frontmatter: {
          id: get("id") || undefined,
          confidence: Number.isFinite(confidence as number) ? confidence : undefined,
          updated: get("updated") || undefined,
          created: get("created") || undefined,
        },
      });
    } catch {
      // Skip unreadable/malformed files.
    }
  });
  return out;
}

function formatContinuityIncidentCli(incident: ContinuityIncidentRecord): string {
  const lines = [
    `${incident.id} [${incident.state}]`,
    `  opened: ${incident.openedAt}`,
  ];
  if (incident.closedAt) lines.push(`  closed: ${incident.closedAt}`);
  if (incident.triggerWindow) lines.push(`  window: ${incident.triggerWindow}`);
  lines.push(`  symptom: ${incident.symptom}`);
  if (incident.suspectedCause) lines.push(`  suspected-cause: ${incident.suspectedCause}`);
  if (incident.fixApplied) lines.push(`  fix-applied: ${incident.fixApplied}`);
  if (incident.verificationResult) lines.push(`  verification: ${incident.verificationResult}`);
  if (incident.preventiveRule) lines.push(`  preventive-rule: ${incident.preventiveRule}`);
  if (incident.filePath) lines.push(`  path: ${incident.filePath}`);
  return lines.join("\n");
}

function formatOperatorSetupCli(report: OperatorSetupReport): string {
  const lines = [
    "=== Engram Setup ===",
    "",
    `Config: ${report.config.parsed ? "ok" : "error"} (${report.config.path})`,
    `Memory dir: ${report.memoryDir}`,
    `Workspace dir: ${report.workspaceDir}`,
    `QMD: ${report.qmd.enabled ? `${report.qmd.available ? "available" : "unavailable"} (${report.qmd.collectionState})` : "disabled"}`,
    `Explicit capture: ${report.explicitCapture.enabled ? report.explicitCapture.captureMode : "disabled"}`,
    "",
    "Directories:",
    ...report.directories.map((entry) => `- ${entry.path} (${entry.exists ? "present" : "missing"}, ${entry.writable ? "writable" : "read-only"})`),
  ];
  if (report.explicitCapture.enabled) {
    lines.push(`Capture doc: ${report.explicitCapture.memoryDocPath} (${report.explicitCapture.memoryDocExists ? "present" : "missing"})`);
    if (report.explicitCapture.memoryDocInstalled) lines.push("Capture instructions: installed");
    if (report.explicitCapture.memoryDocUpdated) lines.push("Capture instructions: updated");
    if (report.explicitCapture.memoryDocRemoved) lines.push("Capture instructions: removed");
    if (report.explicitCapture.preview) {
      lines.push("", "Capture instructions preview:", report.explicitCapture.preview);
    }
  }
  lines.push("", "Next steps:", ...report.nextSteps.map((step) => `- ${step}`));
  return lines.join("\n");
}

function formatOperatorDoctorCli(report: OperatorDoctorReport): string {
  const lines = [
    "=== Engram Doctor ===",
    "",
    `Summary: ok=${report.summary.ok} warn=${report.summary.warn} error=${report.summary.error}`,
  ];
  for (const check of report.checks) {
    lines.push(`- [${check.status.toUpperCase()}] ${check.key}: ${check.summary}`);
    if (check.remediation) lines.push(`  remediation: ${check.remediation}`);
  }
  return lines.join("\n");
}

function formatOperatorConfigReviewCli(report: OperatorConfigReviewReport): string {
  const lines = [
    "=== Engram Config Review ===",
    "",
    `Config parsed: ${report.config.parsed ? "yes" : "no"}`,
    `Config path: ${report.config.path}`,
    `Preset: ${report.profile.memoryOsPreset ?? "(unset)"}`,
    `Search backend: ${report.profile.searchBackend}`,
    `QMD enabled: ${report.profile.qmdEnabled ? "yes" : "no"}`,
    `QMD daemon enabled: ${report.profile.qmdDaemonEnabled ? "yes" : "no"}`,
    `Native knowledge enabled: ${report.profile.nativeKnowledgeEnabled ? "yes" : "no"}`,
    `File hygiene enabled: ${report.profile.fileHygieneEnabled ? "yes" : "no"}`,
    `Conversation index enabled: ${report.profile.conversationIndexEnabled ? "yes" : "no"}`,
    "",
    `Summary: recommend=${report.summary.recommend} problem=${report.summary.problem}`,
  ];
  if (!report.config.parsed && report.config.error) {
    lines.push(`Config error: ${report.config.error}`);
  }
  for (const finding of report.findings) {
    lines.push(`- [${finding.status.toUpperCase()}] ${finding.key}: ${finding.summary}`);
    lines.push(`  setting: ${finding.setting}`);
    lines.push(`  current/default/recommended: ${finding.currentValue} / ${finding.defaultValue} / ${finding.recommendedValue}`);
    lines.push(`  why: ${finding.rationale}`);
  }
  return lines.join("\n");
}

function formatOperatorInventoryCli(report: OperatorInventoryReport): string {
  const lines = [
    "=== Engram Inventory ===",
    "",
    `Memories: ${report.totals.memories}`,
    `Entities: ${report.totals.entities}`,
    `Namespaces: ${report.totals.namespaces}`,
    `Review queue: ${report.totals.reviewQueue}`,
    `Storage: ${report.totals.storageBytes} bytes`,
    `Conversation index: ${report.conversationIndex.status} (${report.conversationIndex.backend})`,
    "",
    "By status:",
    ...Object.entries(report.statuses).sort((a, b) => a[0].localeCompare(b[0])).map(([status, count]) => `- ${status}: ${count}`),
    "",
    "By category:",
    ...Object.entries(report.categories).sort((a, b) => a[0].localeCompare(b[0])).map(([category, count]) => `- ${category}: ${count}`),
  ];
  return lines.join("\n");
}

function formatBenchmarkRecallCli(report: BenchmarkRecallReport): string {
  const lines = [
    "=== Engram Benchmark Recall ===",
    "",
    `Mode: ${report.mode}`,
    `Harness enabled: ${report.status.enabled ? "yes" : "no"}`,
    `Benchmarks: ${report.status.benchmarks.valid}/${report.status.benchmarks.total} valid`,
    `Latest run: ${report.status.runs.latestRunId ?? "none"}`,
  ];
  if (report.validate) {
    lines.push(`Validated pack: ${report.validate.benchmarkId} (${report.validate.totalCases} cases)`);
  }
  if (report.snapshot) {
    lines.push(`Snapshot: ${report.snapshot.snapshotId}`);
    lines.push(`Path: ${report.snapshot.targetPath}`);
  }
  if (report.baselineReport) {
    lines.push(`Baseline passed: ${report.baselineReport.passed ? "yes" : "no"}`);
  }
  if (report.ciGate) {
    lines.push(`CI gate passed: ${report.ciGate.passed ? "yes" : "no"}`);
  }
  return lines.join("\n");
}

function formatOperatorRepairCli(report: OperatorRepairReport): string {
  const lines = [
    "=== Engram Repair ===",
    "",
    `Mode: ${report.dryRun ? "dry-run" : "apply"}`,
    `Session actions planned: ${report.sessionRepairPlan.actions.length}`,
    `Session actions applied: ${report.sessionRepairApply.actionsApplied}`,
    `Graph health: corruptLines=${report.graphHealth.totals.corruptLines}, validEdges=${report.graphHealth.totals.validEdges}`,
  ];
  if (report.graphHealth.repairGuidance && report.graphHealth.repairGuidance.length > 0) {
    lines.push("Graph guidance:");
    for (const entry of report.graphHealth.repairGuidance) {
      lines.push(`- ${entry}`);
    }
  }
  return lines.join("\n");
}

function reportHasMachineReadableOutput(options: Record<string, unknown>): boolean {
  return options.json === true;
}

function setupReportPassed(report: OperatorSetupReport): boolean {
  return report.directories.every((entry) => entry.exists && entry.writable);
}

function buildConversationIndexRebuildAction(orchestrator: Orchestrator) {
  return async (...args: unknown[]) => {
    const options = (args[0] ?? {}) as Record<string, unknown>;
    const hours = typeof options.hours === "string"
      ? Number.parseInt(options.hours, 10)
      : 24;
    const result = await runConversationIndexRebuildCliCommand(orchestrator, {
      sessionKey:
        typeof options.sessionKey === "string" && options.sessionKey.trim().length > 0
          ? options.sessionKey.trim()
          : undefined,
      hours: Number.isFinite(hours) ? hours : 24,
      embed: options.embed === true,
    });
    console.log(JSON.stringify(result, null, 2));
    console.log("OK");
  };
}

export function registerCli(
  api: CliApi,
  orchestrator: Orchestrator,
  registerOptions: RegisterCliOptions = {},
): void {
  api.registerCli(
    ({ program }) => {
      const cmd = program
        .command("engram")
        .description("Engram local memory commands");

      cmd
        .command("stats")
        .description("Show memory system statistics")
        .action(async () => {
          // Ensure QMD is probed before checking availability
          await orchestrator.qmd.probe();

          const meta = await orchestrator.storage.loadMeta();
          const memories = await orchestrator.storage.readAllMemories();
          const entities = await orchestrator.storage.readEntities();
          const profile = await orchestrator.storage.readProfile();

          console.log("=== Engram Memory Stats ===\n");
          console.log(`Total memories: ${memories.length}`);
          console.log(`Total entities: ${entities.length}`);
          console.log(`Profile size: ${profile.length} chars`);
          console.log(`Extractions: ${meta.extractionCount}`);
          console.log(`Last extraction: ${meta.lastExtractionAt ?? "never"}`);
          console.log(
            `Last consolidation: ${meta.lastConsolidationAt ?? "never"}`,
          );
          console.log(`QMD: ${orchestrator.qmd.isAvailable() ? "available" : "not available"}`);

          // Category breakdown
          const categories: Record<string, number> = {};
          for (const m of memories) {
            categories[m.frontmatter.category] =
              (categories[m.frontmatter.category] ?? 0) + 1;
          }
          if (Object.keys(categories).length > 0) {
            console.log("\nBy category:");
            for (const [cat, count] of Object.entries(categories)) {
              console.log(`  ${cat}: ${count}`);
            }
          }
        });

      cmd
        .command("judge-stats")
        .description(
          "Show extraction-judge verdict stats from the observation ledger",
        )
        .option("--since <iso>", "Start timestamp (inclusive, ISO-8601)")
        .option("--until <iso>", "End timestamp (exclusive, ISO-8601)")
        .option("--json", "Emit machine-readable JSON only")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const sinceRaw =
            typeof options.since === "string" ? options.since : undefined;
          const untilRaw =
            typeof options.until === "string" ? options.until : undefined;
          const sinceMs = sinceRaw ? Date.parse(sinceRaw) : undefined;
          const untilMs = untilRaw ? Date.parse(untilRaw) : undefined;
          if (sinceRaw && !Number.isFinite(sinceMs)) {
            throw new Error(
              `Invalid --since value: ${sinceRaw}. Use ISO-8601, e.g. 2026-04-01T00:00:00Z`,
            );
          }
          if (untilRaw && !Number.isFinite(untilMs)) {
            throw new Error(
              `Invalid --until value: ${untilRaw}. Use ISO-8601, e.g. 2026-04-15T00:00:00Z`,
            );
          }
          const { readJudgeVerdictStats } = await import(
            "./extraction-judge-telemetry.js"
          );
          const stats = await readJudgeVerdictStats(
            orchestrator.config.memoryDir,
            {
              ...(typeof sinceMs === "number" && Number.isFinite(sinceMs)
                ? { sinceMs }
                : {}),
              ...(typeof untilMs === "number" && Number.isFinite(untilMs)
                ? { untilMs }
                : {}),
            },
          );
          if (options.json === true) {
            console.log(JSON.stringify(stats, null, 2));
            return;
          }
          console.log("=== Extraction Judge Verdict Stats ===\n");
          console.log(`Total verdicts: ${stats.total}`);
          if (stats.total === 0) {
            if (!orchestrator.config.extractionJudgeTelemetryEnabled) {
              console.log(
                "\nNote: extractionJudgeTelemetryEnabled is OFF. Enable it in plugin config to collect verdict telemetry.",
              );
            }
            return;
          }
          console.log(
            `  accept: ${stats.accept} (${((stats.accept / stats.total) * 100).toFixed(1)}%)`,
          );
          console.log(
            `  reject: ${stats.reject} (${((stats.reject / stats.total) * 100).toFixed(1)}%)`,
          );
          console.log(
            `  defer:  ${stats.defer} (${(stats.deferRate * 100).toFixed(1)}%)`,
          );
          if (stats.deferCapTriggered > 0) {
            console.log(
              `    of which ${stats.deferCapTriggered} cap-rejected (defer → reject)`,
            );
          }
          console.log(`  mean elapsed: ${stats.meanElapsedMs.toFixed(1)} ms`);
          if (stats.firstTs && stats.lastTs) {
            console.log(`  window: ${stats.firstTs} … ${stats.lastTs}`);
          }
          if (stats.malformed > 0) {
            console.log(`  malformed rows skipped: ${stats.malformed}`);
          }
        });

      cmd
        .command("setup")
        .description("Validate config, scaffold directories, and print first-run next steps")
        .option("--install-capture-instructions", "Create workspace MEMORY.md when explicit capture is enabled and missing")
        .option("--preview-capture-instructions", "Print the managed explicit-capture instruction snippet without writing files")
        .option("--remove-capture-instructions", "Remove the managed explicit-capture instruction snippet from MEMORY.md")
        .option("--json", "Emit machine-readable JSON only")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const captureInstructionsMode =
            options.removeCaptureInstructions === true
              ? "remove"
              : options.previewCaptureInstructions === true
                ? "preview"
                : options.installCaptureInstructions === true
                  ? "install"
                  : undefined;
          const report = await runOperatorSetup({
            orchestrator,
            installCaptureInstructions: options.installCaptureInstructions === true,
            captureInstructionsMode,
          });
          if (reportHasMachineReadableOutput(options)) {
            console.log(JSON.stringify(report, null, 2));
          } else {
            console.log(formatOperatorSetupCli(report));
          }
          if (!setupReportPassed(report)) {
            process.exitCode = 1;
            return;
          }
          if (!reportHasMachineReadableOutput(options)) console.log("OK");
        });

      cmd
        .command("doctor")
        .description("Run safe Engram health diagnostics with remediation guidance")
        .option("--json", "Emit machine-readable JSON only")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const report = await runOperatorDoctor({ orchestrator });
          if (reportHasMachineReadableOutput(options)) {
            console.log(JSON.stringify(report, null, 2));
          } else {
            console.log(formatOperatorDoctorCli(report));
          }
          if (!report.ok) {
            process.exitCode = 1;
            return;
          }
          if (!reportHasMachineReadableOutput(options)) console.log("OK");
        });

      // Tier visibility (issue #686 PR 5/6) — operator-facing read-only
      // surfaces for inspecting hot↔cold tier distribution and
      // explaining why a single memory ended up where it did.
      const tierCmd = cmd
        .command("tier")
        .description(
          "Tier-distribution visibility (issue #686). `tier list` summarizes hot/cold counts and per-status breakdown; `tier explain <id>` shows the value-score components and tier-transition decision for a single memory.",
        );
      tierCmd
        .command("list")
        .description("Summarize tier distribution across all memories")
        .option("--json", "Emit machine-readable JSON only")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const { summarizeTiers, formatTierSummaryText } = await import(
            "./maintenance/tier-stats.js"
          );
          const summary = await summarizeTiers(orchestrator.storage);
          if (reportHasMachineReadableOutput(options)) {
            console.log(JSON.stringify(summary, null, 2));
          } else {
            console.log(formatTierSummaryText(summary));
          }
        });
      tierCmd
        .command("explain")
        .description("Explain the tier-transition decision for a single memory")
        .argument("<id>", "Memory id to explain")
        .option("--json", "Emit machine-readable JSON only")
        .action(async (...args: unknown[]) => {
          const idArg = typeof args[0] === "string" ? args[0] : "";
          const options = (args[1] ?? {}) as Record<string, unknown>;
          const { explainTierForMemory, formatTierExplainText } = await import(
            "./maintenance/tier-stats.js"
          );
          try {
            const explain = await explainTierForMemory(
              orchestrator.storage,
              idArg,
              orchestrator.config,
            );
            if (reportHasMachineReadableOutput(options)) {
              console.log(JSON.stringify(explain, null, 2));
            } else {
              console.log(formatTierExplainText(explain));
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (reportHasMachineReadableOutput(options)) {
              console.log(JSON.stringify({ ok: false, error: message }, null, 2));
            } else {
              console.error(
                message.startsWith("tier explain:")
                  ? message
                  : `tier explain: ${message}`,
              );
            }
            process.exitCode = 1;
          }
        });

      cmd
        .command("forget")
        .description(
          "Forget a memory by id (issue #686 PR 4/6). Soft-delete: sets " +
          "status='forgotten' and stamps forgottenAt; the file stays on " +
          "disk and the act is reversible by editing the YAML directly. " +
          "Forgotten memories are excluded from recall, browse, and entity " +
          "attribution.",
        )
        .argument("<id>", "Memory id (frontmatter `id`) to forget")
        .option(
          "--reason <text>",
          "Optional human-readable reason captured in YAML and the lifecycle ledger",
        )
        .option("--json", "Emit machine-readable JSON only")
        .action(async (...args: unknown[]) => {
          const idArg = typeof args[0] === "string" ? args[0] : "";
          const options = (args[1] ?? {}) as Record<string, unknown>;
          const reason =
            typeof options.reason === "string" && options.reason.trim().length > 0
              ? options.reason.trim()
              : undefined;
          const { forgetMemory } = await import("./maintenance/forget.js");
          try {
            const result = await forgetMemory(orchestrator.storage, {
              id: idArg,
              ...(reason !== undefined ? { reason } : {}),
            });
            if (reportHasMachineReadableOutput(options)) {
              console.log(JSON.stringify(result, null, 2));
            } else {
              console.log(`forgot ${result.id}`);
              console.log(`  path: ${result.path}`);
              console.log(`  prior status: ${result.priorStatus}`);
              console.log(`  forgotten at: ${result.forgottenAt}`);
              if (result.reason.length > 0) {
                console.log(`  reason: ${result.reason}`);
              }
              console.log(
                "Forgotten memories are excluded from recall + browse. " +
                "Edit the YAML to restore.",
              );
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (reportHasMachineReadableOutput(options)) {
              console.log(JSON.stringify({ ok: false, error: message }, null, 2));
            } else {
              console.error(`forget: ${message}`);
            }
            process.exitCode = 1;
          }
        });

      cmd
        .command("purge")
        .description(
          "Hard-delete memories by age + tier (issue #686 retention-completion). " +
          "Removes files from disk, removes from QMD index, and logs to the " +
          "observation ledger. Requires --confirm yes to execute. Defaults to " +
          "--dry-run when --confirm is absent.",
        )
        .option(
          "--older-than <duration>",
          "Delete memories older than this duration. Accepts ISO 8601 durations " +
          "(e.g. P1Y, P90D) or plain numbers of days (e.g. 365).",
        )
        .option(
          "--tier <tier>",
          "Which tier to purge: 'cold' (default) or 'all'",
        )
        .option(
          "--forgotten-only",
          "Only purge memories with status=forgotten",
        )
        .option("--dry-run", "Report candidates without deleting (default when --confirm absent)")
        .option(
          "--confirm <value>",
          "Must be the literal string 'yes' to execute mutations",
        )
        .option("--json", "Emit machine-readable JSON only")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;

          // Validate --older-than
          const olderThanRaw = options.olderThan ?? options["older-than"];
          if (typeof olderThanRaw !== "string" || olderThanRaw.trim().length === 0) {
            const msg = "purge: --older-than <duration> is required (e.g. --older-than P1Y or --older-than 365)";
            if (reportHasMachineReadableOutput(options)) {
              console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
            } else {
              console.error(msg);
            }
            process.exitCode = 1;
            return;
          }

          // Parse duration to ms
          const olderThanMs = parseDurationToMs(olderThanRaw.trim());
          if (olderThanMs === null || olderThanMs <= 0) {
            const msg = `purge: cannot parse duration '${olderThanRaw}'. Use ISO 8601 (P1Y, P90D, P30D) or plain days (365).`;
            if (reportHasMachineReadableOutput(options)) {
              console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
            } else {
              console.error(msg);
            }
            process.exitCode = 1;
            return;
          }

          // Validate --tier
          const tierRaw = typeof options.tier === "string" ? options.tier.trim() : "cold";
          if (tierRaw !== "cold" && tierRaw !== "all") {
            const msg = `purge: invalid --tier '${tierRaw}'. Valid values: cold, all`;
            if (reportHasMachineReadableOutput(options)) {
              console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
            } else {
              console.error(msg);
            }
            process.exitCode = 1;
            return;
          }

          // --confirm guard: must be literally "yes" to execute mutations.
          // Validate explicitly BEFORE computing dryRun so that an invalid
          // --confirm value (e.g. --confirm maybe) produces an error rather
          // than silently falling back to dry-run mode.
          const confirmValue = options.confirm;
          const hasDryRunFlag = options.dryRun === true || options["dry-run"] === true;

          // If --confirm was provided but is not "yes", reject immediately.
          if (confirmValue !== undefined && confirmValue !== "yes") {
            const msg =
              "purge: --confirm must be exactly \"yes\" to execute mutations. " +
              "Run with --dry-run to preview candidates without deleting.";
            if (reportHasMachineReadableOutput(options)) {
              console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
            } else {
              console.error(msg);
            }
            process.exitCode = 1;
            return;
          }

          const confirmed = confirmValue === "yes";
          const dryRun = hasDryRunFlag || !confirmed;

          const { purgeMemories } = await import("./maintenance/purge.js");
          try {
            const result = await purgeMemories({
              storage: orchestrator.storage,
              olderThanMs,
              tier: tierRaw as "cold" | "all",
              forgottenOnly: options.forgottenOnly === true || options["forgotten-only"] === true,
              dryRun,
              qmd: confirmed ? orchestrator.qmd : undefined,
              hotCollection: orchestrator.config.qmdCollection,
              coldCollection: orchestrator.config.qmdColdCollection,
              afterFactHashRemoval: () => orchestrator.invalidateLiveContentHashIndex(),
            });
            const hasDeleteFailures = hasDestructivePurgeFailures(result.errors);
            if (reportHasMachineReadableOutput(options)) {
              console.log(JSON.stringify(result, null, 2));
              if (!result.dryRun && hasDeleteFailures) {
                process.exitCode = 1;
              }
            } else {
              if (result.dryRun) {
                console.log(`=== Purge dry-run: ${result.candidates.length} candidate(s) would be deleted ===`);
              } else {
                const absentPart = result.alreadyAbsentCount > 0 ? `, ${result.alreadyAbsentCount} already absent` : "";
                console.log(`=== Purge complete: ${result.purgedCount} deleted${absentPart}, ${result.errorCount} error(s) ===`);
              }
              console.log(`  tier:       ${result.tier}`);
              console.log(`  older-than: ${olderThanRaw} (${Math.round(olderThanMs / 86_400_000)}d)`);
              if (result.candidates.length === 0) {
                console.log("  No candidates found.");
              } else {
                for (const c of result.candidates.slice(0, 20)) {
                  console.log(`  ${c.id}  [${c.tier}] status=${c.status}  age=${Math.round(c.ageMs / 86_400_000)}d  ${c.path}`);
                }
                if (result.candidates.length > 20) {
                  console.log(`  ... and ${result.candidates.length - 20} more`);
                }
              }
              if (!result.dryRun && result.errors.length > 0) {
                console.error(`  ${hasDeleteFailures ? "Errors" : "Warnings"} (${result.errors.length}):`);
                for (const e of result.errors) {
                  console.error(`    ${e.id}: ${e.error}`);
                }
                if (hasDeleteFailures) {
                  process.exitCode = 1;
                }
              }
              if (result.dryRun) {
                console.log("\nRe-run with --confirm yes to execute.");
              }
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (reportHasMachineReadableOutput(options)) {
              console.log(JSON.stringify({ ok: false, error: message }, null, 2));
            } else {
              console.error(`purge: ${message}`);
            }
            process.exitCode = 1;
          }
        });

      cmd
        .command("config-review")
        .description("Review Engram config defaults, recommendations, and contradictory settings")
        .option("--json", "Emit machine-readable JSON only")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const report = await runOperatorConfigReview({ orchestrator });
          if (reportHasMachineReadableOutput(options)) {
            console.log(JSON.stringify(report, null, 2));
          } else {
            console.log(formatOperatorConfigReviewCli(report));
          }
          if (!report.ok) {
            process.exitCode = 1;
            return;
          }
          if (!reportHasMachineReadableOutput(options)) console.log("OK");
        });

      cmd
        .command("inventory")
        .description("Report namespace, memory, review, and storage inventory")
        .option("--json", "Emit machine-readable JSON only")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const report = await runOperatorInventory({ orchestrator });
          if (reportHasMachineReadableOutput(options)) {
            console.log(JSON.stringify(report, null, 2));
          } else {
            console.log(formatOperatorInventoryCli(report));
          }
          if (!reportHasMachineReadableOutput(options)) console.log("OK");
        });

      const namespacesCmd = cmd
        .command("namespaces")
        .description("Manage namespace roots, migration, and verification");

      namespacesCmd
        .command("ls")
        .description("List configured namespaces and their storage roots")
        .action(async () => {
          const namespaces = await listNamespaces({ config: orchestrator.config });
          if (namespaces.length === 0) {
            console.log("No namespaces configured.");
            return;
          }

          console.log("=== Engram Namespaces ===\n");
          for (const entry of namespaces) {
            console.log(
              `${entry.namespace}\n  root: ${entry.rootDir}\n  exists: ${entry.exists ? "yes" : "no"}\n  legacy-root: ${entry.usesLegacyRoot ? "yes" : "no"}\n  has-data: ${entry.hasMemoryData ? "yes" : "no"}\n  collection: ${entry.collection}`,
            );
          }
        });

      namespacesCmd
        .command("verify")
        .description("Verify namespace roots and detect legacy root drift")
        .action(async () => {
          const report = await verifyNamespaces({ config: orchestrator.config });
          console.log("=== Namespace Verification ===\n");
          for (const entry of report.namespaces) {
            console.log(
              `${entry.namespace}\n  root: ${entry.rootDir}\n  exists: ${entry.exists ? "yes" : "no"}\n  legacy-root: ${entry.usesLegacyRoot ? "yes" : "no"}\n  has-data: ${entry.hasMemoryData ? "yes" : "no"}\n  collection: ${entry.collection}`,
            );
          }

          if (report.ok) {
            console.log("\nOK");
            return;
          }

          console.log("\nProblems:");
          for (const problem of report.problems) {
            console.log(`- ${problem}`);
          }
          process.exitCode = 1;
        });

      namespacesCmd
        .command("migrate")
        .description("Move legacy root memory layout into a namespaced root")
        .option("--to <ns>", "Target namespace (default: config defaultNamespace)", "")
        .option("--dry-run", "Show the migration plan without moving files")
        .action(async (optionsRaw: unknown) => {
          const options =
            optionsRaw && typeof optionsRaw === "object"
              ? optionsRaw as { to?: string; dryRun?: boolean }
              : {};
          const targetNamespace =
            typeof options.to === "string" && options.to.trim().length > 0
              ? options.to.trim()
              : orchestrator.config.defaultNamespace;
          const dryRun = options.dryRun === true;

          const plan = await runNamespaceMigration({
            config: orchestrator.config,
            to: targetNamespace,
            dryRun,
          });

          console.log("=== Namespace Migration Plan ===\n");
          console.log(`target namespace: ${targetNamespace}`);
          console.log(`source root: ${plan.fromRoot}`);
          console.log(`target root: ${plan.targetRoot}`);
          console.log(`entries: ${plan.moved.length}`);
          console.log(`collection: ${plan.collection}`);

          if (plan.moved.length > 0) {
            console.log("\nEntries:");
            for (const move of plan.moved) {
              console.log(`- ${path.basename(move.from)}`);
            }
          }

          if (dryRun) {
            console.log("\nDRY RUN");
            return;
          }

          console.log("\nOK");
        });

      cmd
        .command("export")
        .description("Export Remnic memory to JSON, Markdown bundle, or SQLite")
        .option("--format <format>", "Export format: json|md|sqlite", "json")
        .option("--out <path>", "Output path (dir for json/md, file for sqlite)")
        .option("--include-transcripts", "Include transcripts in export (default: false)")
        .option("--namespace <ns>", "Namespace to export (v3.0+, default: config defaultNamespace)", "")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const format = String(options.format ?? "json");
          const out = options.out ? String(options.out) : "";
          const includeTranscripts = options.includeTranscripts === true;
          const namespace = options.namespace ? String(options.namespace) : "";
          if (!out) {
            console.log("Missing --out. Example: openclaw engram export --format json --out /tmp/engram-export");
            return;
          }

          const pluginVersion = await getPluginVersion();
          const memoryDir = await resolveMemoryDirForNamespace(orchestrator, namespace, {
            rejectUnsupportedOverride: true,
          });
          if (format === "json") {
            await exportJsonBundle({
              memoryDir,
              outDir: out,
              includeTranscripts,
              pluginVersion,
              workspaceDir: orchestrator.config.workspaceDir,
              includeWorkspaceIdentity: true,
            });
          } else if (format === "md") {
            await exportMarkdownBundle({
              memoryDir,
              outDir: out,
              includeTranscripts,
              pluginVersion,
            });
          } else if (format === "sqlite") {
            await exportSqlite({
              memoryDir,
              outFile: out,
              includeTranscripts,
              pluginVersion,
            });
          } else {
            console.log(`Unknown format: ${format}`);
            return;
          }
          console.log("OK");
        });

      cmd
        .command("import")
        .description("Import Remnic memory from JSON bundle, Markdown bundle, or SQLite")
        .option("--from <path>", "Import source path (dir or file)")
        .option("--format <format>", "Import format: auto|json|md|sqlite", "auto")
        .option("--conflict <mode>", "Conflict policy: skip|overwrite|dedupe", "skip")
        .option("--dry-run", "Validate import without writing files")
        .option("--namespace <ns>", "Namespace to import into (v3.0+, default: config defaultNamespace)", "")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const from = options.from ? String(options.from) : "";
          const formatOpt = String(options.format ?? "auto");
          const conflict = String(options.conflict ?? "skip") as "skip" | "overwrite" | "dedupe";
          const dryRun = options.dryRun === true;
          const namespace = options.namespace ? String(options.namespace) : "";
          if (!from) {
            console.log("Missing --from. Example: openclaw engram import --from /tmp/engram-export --format auto");
            return;
          }

          const detected = formatOpt === "auto" ? await detectImportFormat(from) : (formatOpt as any);
          if (!detected) {
            console.log("Could not detect import format (use --format json|md|sqlite).");
            return;
          }

          const targetMemoryDir = await resolveMemoryDirForNamespace(orchestrator, namespace);

          if (detected === "json") {
            await importJsonBundle({
              targetMemoryDir,
              fromDir: from,
              conflict,
              dryRun,
              workspaceDir: orchestrator.config.workspaceDir,
            });
          } else if (detected === "sqlite") {
            await importSqlite({
              targetMemoryDir,
              fromFile: from,
              conflict,
              dryRun,
            });
          } else if (detected === "md") {
            await importMarkdownBundle({
              targetMemoryDir,
              fromDir: from,
              conflict,
              dryRun,
            });
          } else {
            console.log(`Unknown detected format: ${detected}`);
            return;
          }
          console.log("OK");
        });

      cmd
        .command("backup")
        .description("Create a timestamped backup of the Remnic memory directory")
        .option("--out-dir <dir>", "Backup root directory")
        .option("--retention-days <n>", "Delete backups older than N days", "0")
        .option("--include-transcripts", "Include transcripts (default false)")
        .option("--namespace <ns>", "Namespace to back up (v3.0+, default: config defaultNamespace)", "")
        .option("--encrypt", "Encrypt the backup archive with the secure-store master key (must be unlocked)")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const outDir = options.outDir ? String(options.outDir) : "";
          const retentionDays = parseInt(String(options.retentionDays ?? "0"), 10);
          const includeTranscripts = options.includeTranscripts === true;
          const namespace = options.namespace ? String(options.namespace) : "";
          const doEncrypt = options.encrypt === true;
          if (!outDir) {
            console.log("Missing --out-dir. Example: openclaw engram backup --out-dir /tmp/engram-backups");
            return;
          }
          const pluginVersion = await getPluginVersion();
          const memoryDir = await resolveMemoryDirForNamespace(orchestrator, namespace, {
            rejectUnsupportedOverride: true,
          });
          const outPath = await backupMemoryDir({
            memoryDir,
            outDir,
            retentionDays: Number.isFinite(retentionDays) ? retentionDays : undefined,
            includeTranscripts,
            pluginVersion,
            encrypt: doEncrypt,
          });
          if (doEncrypt) {
            console.log(`Encrypted backup: ${outPath}`);
          } else {
            console.log(`Backup: ${outPath}`);
          }
          console.log("OK");
        });

      // ── Capsule subcommand (issue #690 PR 4/4 + #676 PR 2-3/6) ─────────
      // `remnic capsule export` — produce a portable V2 capsule archive.
      // `remnic capsule import` — restore a capsule archive into a memory dir.
      // --encrypt flag requires the secure-store to be unlocked (#690 PR 4/4).
      const capsuleCmd = cmd
        .command("capsule")
        .description("Portable capsule archive export / import (issue #676, #690)");

      capsuleCmd
        .command("export")
        .description(
          "Export the memory directory as a portable .capsule.json.gz archive. " +
            "Pass --encrypt to seal the archive with the secure-store master key.",
        )
        .option("--name <id>", "Capsule id (alphanumeric + dashes, ≤ 64 chars)")
        .option("--out-dir <dir>", "Output directory (default: <memoryDir>/.capsules)")
        .option("--since <iso8601>", "Only include files modified on or after this date")
        .option("--include-kinds <kinds>", "Comma-separated top-level dir allow-list (e.g. facts,entities)")
        .option("--peer-ids <ids>", "Comma-separated peer id allow-list for the peers/ subtree")
        .option("--include-transcripts", "Include transcripts (excluded by default)")
        .option("--encrypt", "Encrypt the output archive with the secure-store master key (must be unlocked)")
        .option("--namespace <ns>", "Namespace (v3.0+, default: config defaultNamespace)", "")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const name = options.name ? String(options.name) : "";
          if (!name) {
            console.error("--name is required. Example: remnic capsule export --name my-capsule");
            process.exitCode = 1;
            return;
          }
          const namespace = options.namespace ? String(options.namespace) : "";
          const doEncrypt = options.encrypt === true;
          const outDir = options.outDir ? String(options.outDir) : undefined;
          const since = options.since ? String(options.since) : undefined;
          const includeKinds = options.includeKinds
            ? String(options.includeKinds)
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : undefined;
          const peerIds = options.peerIds
            ? String(options.peerIds)
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : undefined;
          const includeTranscripts = options.includeTranscripts === true;

          const pluginVersion = await getPluginVersion();
          const memoryDir = await resolveMemoryDirForNamespace(orchestrator, namespace, {
            rejectUnsupportedOverride: true,
          });

          const { exportCapsule } = await import("./transfer/capsule-export.js");
          const result = await exportCapsule({
            name,
            root: memoryDir,
            since,
            // Pass `includeKinds` only when the user explicitly provided it.
            // Do NOT merge transcripts into an explicit list here: doing so would
            // produce a hard-coded allow-list that silently drops other valid
            // memory dirs (peers/, forks/, etc.). Instead, use `includeTranscripts`
            // so the exporter adds transcripts while keeping the default "all dirs"
            // walk. (Cursor / #747)
            includeKinds,
            includeTranscripts,
            peerIds,
            outDir,
            pluginVersion,
            encrypt: doEncrypt,
            memoryDir: doEncrypt ? memoryDir : undefined,
          });
          console.log(`Archive:  ${result.archivePath}`);
          console.log(`Manifest: ${result.manifestPath}`);
          if (result.encryptedArchivePath) {
            console.log(`Encrypted: yes`);
          }
          console.log("OK");
        });

      capsuleCmd
        .command("import")
        .description(
          "Import a capsule archive into the memory directory. " +
            "Auto-detects encrypted archives (REMNIC-ENC header); " +
            "requires --encrypt-key-dir or the memory dir to have an unlocked secure-store.",
        )
        .argument("<archive>", "Path to the .capsule.json.gz (or .enc) archive")
        .option("--mode <mode>", "Conflict mode: skip (default), overwrite, fork", "skip")
        .option("--namespace <ns>", "Target namespace (v3.0+, default: config defaultNamespace)", "")
        .action(async (...args: unknown[]) => {
          const archivePath = args[0] ? String(args[0]) : "";
          const options = (args[1] ?? {}) as Record<string, unknown>;
          if (!archivePath) {
            console.error("Usage: remnic capsule import <archive>");
            process.exitCode = 1;
            return;
          }
          const mode = options.mode ? String(options.mode) : "skip";
          if (mode !== "skip" && mode !== "overwrite" && mode !== "fork") {
            console.error(`Invalid --mode '${mode}'. Expected: skip, overwrite, fork`);
            process.exitCode = 1;
            return;
          }
          const namespace = options.namespace ? String(options.namespace) : "";
          const memoryDir = await resolveMemoryDirForNamespace(orchestrator, namespace, {
            rejectUnsupportedOverride: true,
          });

          const { importCapsule } = await import("./transfer/capsule-import.js");
          const result = await importCapsule({
            archivePath: expandTildePath(archivePath),
            root: memoryDir,
            mode: mode as "skip" | "overwrite" | "fork",
            memoryDir,
          });
          console.log(`Imported: ${result.imported.length} record(s)`);
          if (result.skipped.length > 0) {
            console.log(`Skipped:  ${result.skipped.length} (mode=${mode})`);
          }
          console.log("OK");
        });

      // ── Capsule merge / list / inspect (issue #676 PR 6/6) ──────────────
      // Augments the export + import subcommands above with three-way merge,
      // directory listing, and manifest inspection surfaces. Option parsing
      // and rendering live in `capsule-cli.ts` for unit-testability.

      capsuleCmd
        .command("merge")
        .description(
          "Three-way merge of a capsule archive into the memory directory. " +
            "New files are always written; conflicts are resolved by --conflict-mode.",
        )
        .argument("<archive>", "Path to a .capsule.json.gz archive")
        .option(
          "--conflict-mode <mode>",
          "Conflict mode: skip-conflicts (default) | prefer-source | prefer-local",
        )
        .action(async (...args: unknown[]) => {
          const archiveArg = args[0];
          const opts = (args[1] ?? {}) as Record<string, unknown>;
          const {
            parseCapsuleMergeOptions,
            defaultCapsulesDir,
          } = await import("./capsule-cli.js");
          const parsed = parseCapsuleMergeOptions(archiveArg, opts);

          const memoryDir = expandTildePath(orchestrator.config.memoryDir);
          const capsulesDir = defaultCapsulesDir(memoryDir);

          // Resolve archive path — same 3-step precedence as `capsule inspect`
          // so that merge also accepts capsule IDs from the store directory.
          //   1. Explicit path (starts with /, ./, ../, or contains sep) → tilde-expand and use as-is.
          //   2. Bare name matching an existing cwd file → resolve to absolute.
          //   3. Otherwise treat as a capsule id and look up in the capsules store.
          const { stat: statMerge } = await import("node:fs/promises");
          let sourceArchive = expandTildePath(parsed.archive);
          const looksLikePath =
            sourceArchive.startsWith("/") ||
            sourceArchive.startsWith("./") ||
            sourceArchive.startsWith("../") ||
            sourceArchive.includes(path.sep);

          if (!looksLikePath) {
            const cwdResolved = path.resolve(sourceArchive);
            const cwdSt = await statMerge(cwdResolved).catch(() => null);
            if (cwdSt && cwdSt.isFile()) {
              sourceArchive = cwdResolved;
            } else {
              const byId = path.join(capsulesDir, `${sourceArchive}.capsule.json.gz`);
              const byIdEnc = path.join(capsulesDir, `${sourceArchive}.capsule.json.gz.enc`);
              const stId = await statMerge(byId).catch(() => null);
              if (stId && stId.isFile()) {
                sourceArchive = byId;
              } else {
                const stEnc = await statMerge(byIdEnc).catch(() => null);
                if (stEnc && stEnc.isFile()) {
                  sourceArchive = byIdEnc;
                }
              }
            }
          }

          // Reject encrypted archives before attempting gunzip — mergeCapsule
          // does not support decryption and would throw a confusing "not a
          // valid gzip" error. Detect by extension and magic header.
          // (Codex P1 PRRT_kwDORJXyws59so7S / Cursor PRRT_kwDORJXyws59spK7)
          if (sourceArchive.endsWith(".enc")) {
            const { isEncryptedCapsuleFile } = await import("./transfer/capsule-crypto.js");
            const encDetected = await isEncryptedCapsuleFile(sourceArchive).catch(() => true);
            if (encDetected) {
              throw new Error(
                `capsule merge: encrypted archives (.enc) are not supported by merge. ` +
                  `Decrypt the archive first with "remnic capsule import" ` +
                  `(requires unlocked secure-store), then use the decrypted .capsule.json.gz.`,
              );
            }
          }

          const { mergeCapsule } = await import("./transfer/capsule-merge.js");
          const result = await mergeCapsule({
            sourceArchive,
            targetRoot: memoryDir,
            conflictMode: parsed.conflictMode,
          });

          const mergedCount = result.merged.length;
          const skippedCount = result.skipped.length;
          const conflictCount = result.conflicts.length;
          console.log(
            `Capsule merged: ${result.manifest.capsule.id}\n` +
              `  conflict-mode: ${parsed.conflictMode}\n` +
              `  merged:        ${mergedCount}\n` +
              `  conflicts:     ${conflictCount}\n` +
              `  skipped:       ${skippedCount}`,
          );
        });

      capsuleCmd
        .command("list")
        .description(
          "List all capsule archives in the capsule store directory " +
            "(<memoryDir>/.capsules by default). Reads the sidecar manifest.json for metadata.",
        )
        .option(
          "--dir <path>",
          "Override the capsule store directory to list",
        )
        .option(
          "--format <fmt>",
          "Output format: text (default) | markdown | json",
        )
        .action(async (...args: unknown[]) => {
          const opts = (args[0] ?? {}) as Record<string, unknown>;
          const {
            parseCapsuleListOptions,
            renderCapsuleList,
            defaultCapsulesDir,
          } = await import("./capsule-cli.js");
          type CapsuleListEntry = import("./capsule-cli.js").CapsuleListEntry;

          const memoryDir = expandTildePath(orchestrator.config.memoryDir);
          const defaultDir = defaultCapsulesDir(memoryDir);
          // Track whether --dir was explicitly supplied so we can give a clear
          // error when it doesn't exist (Cursor PRRT_kwDORJXyws59spK8).
          const dirWasExplicit =
            typeof opts.dir === "string" && opts.dir.trim() !== "";
          const parsed = parseCapsuleListOptions(opts, defaultDir);
          // Expand tilde in the resolved capsules dir (covers --dir ~/... inputs).
          const capsulesDir = expandTildePath(parsed.capsulesDir);

          // Scan the capsule store directory for *.capsule.json.gz archives.
          const { readdir, readFile, stat } = await import("node:fs/promises");
          let dirEntries: string[];
          try {
            dirEntries = await readdir(capsulesDir);
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (dirWasExplicit) {
              // User explicitly provided --dir <path>: any error (including
              // ENOENT) must be surfaced — a silent empty list would hide a
              // typo or missing mount. (Cursor PRRT_kwDORJXyws59spK8)
              throw new Error(
                `capsule list: cannot read --dir ${capsulesDir}: ${(err as Error).message}`,
              );
            }
            // Default capsulesDir: ENOENT means the directory hasn't been
            // created yet — treat as empty. Re-throw other errors (EACCES,
            // ENOTDIR, …). (Codex P1 PRRT_kwDORJXyws59smmg)
            if (code !== "ENOENT") {
              throw new Error(
                `capsule list: cannot read capsule store directory ${capsulesDir}: ${(err as Error).message}`,
              );
            }
            dirEntries = [];
          }

          const archives = dirEntries
            .filter(
              (e) =>
                e.endsWith(".capsule.json.gz") ||
                e.endsWith(".capsule.json.gz.enc"),
            )
            .sort();

          const entries: CapsuleListEntry[] = [];
          for (const archiveName of archives) {
            const archivePath = path.join(capsulesDir, archiveName);
            // Capsule id is the filename stem before ".capsule.json.gz[.enc]".
            const id = archiveName
              .replace(/\.capsule\.json\.gz\.enc$/, "")
              .replace(/\.capsule\.json\.gz$/, "");
            const manifestName = `${id}.manifest.json`;
            const manifestPath = path.join(capsulesDir, manifestName);

            let createdAt: string | null = null;
            let pluginVersion: string | null = null;
            let fileCount: number | null = null;
            let description: string | null = null;
            let hasManifest = false;

            try {
              await stat(manifestPath);
              hasManifest = true;
            } catch {
              // sidecar missing — leave metadata as null.
            }

            if (hasManifest) {
              try {
                const raw = await readFile(manifestPath, "utf-8");
                const sidecar = JSON.parse(raw) as Record<string, unknown>;
                createdAt =
                  typeof sidecar.createdAt === "string" ? sidecar.createdAt : null;
                pluginVersion =
                  typeof sidecar.pluginVersion === "string"
                    ? sidecar.pluginVersion
                    : null;
                fileCount =
                  Array.isArray(sidecar.files) ? (sidecar.files as unknown[]).length : null;
                const capsule = sidecar.capsule as Record<string, unknown> | undefined;
                if (capsule && typeof capsule.description === "string") {
                  description = capsule.description;
                }
              } catch {
                // malformed sidecar — leave metadata as null.
              }
            }

            entries.push({
              id,
              archivePath,
              manifestPath: hasManifest ? manifestPath : null,
              createdAt,
              pluginVersion,
              fileCount,
              description,
            });
          }

          console.log(renderCapsuleList(entries, parsed.format));
        });

      capsuleCmd
        .command("inspect")
        .description(
          "Show capsule archive manifest without unpacking. " +
            "Reads the sidecar .manifest.json when present; otherwise decompresses the archive.",
        )
        .argument("<archive>", "Path to a .capsule.json.gz archive (or its id in the capsule store)")
        .option(
          "--format <fmt>",
          "Output format: text (default) | markdown | json",
        )
        .action(async (...args: unknown[]) => {
          const archiveArg = args[0];
          const opts = (args[1] ?? {}) as Record<string, unknown>;
          const {
            parseCapsuleInspectOptions,
            renderCapsuleInspect,
            defaultCapsulesDir,
          } = await import("./capsule-cli.js");
          type CapsuleInspectData = import("./capsule-cli.js").CapsuleInspectData;

          const memoryDir = expandTildePath(orchestrator.config.memoryDir);
          const capsulesDir = defaultCapsulesDir(memoryDir);
          const parsed = parseCapsuleInspectOptions(archiveArg, opts);

          // Resolve archive path.
          //
          // Precedence (CLAUDE.md gotcha — bare relative names must not be
          // misclassified as capsule ids):
          //   1. If the argument looks like an explicit path (starts with /,
          //      ./, ../, or contains a path separator) → use as-is after tilde
          //      expansion.
          //   2. Otherwise, check whether the argument resolves to an existing
          //      file relative to cwd.  A bare name like "my-capsule.capsule.json.gz"
          //      in the working directory must win over a capsule-id lookup.
          //   3. If the file does not exist at cwd, treat as a capsule id and
          //      look it up in the capsules store (plain then encrypted variant).
          const { stat } = await import("node:fs/promises");
          let archivePath = expandTildePath(parsed.archive);
          const looksLikePath =
            archivePath.startsWith("/") ||
            archivePath.startsWith("./") ||
            archivePath.startsWith("../") ||
            archivePath.includes(path.sep);

          if (!looksLikePath) {
            // Step 2: check for an existing file at cwd before treating as id.
            const cwdResolved = path.resolve(archivePath);
            const cwdSt = await stat(cwdResolved).catch(() => null);
            if (cwdSt && cwdSt.isFile()) {
              archivePath = cwdResolved;
            } else {
              // Step 3: Treat as a capsule id — find it in the capsules dir.
              // Try plain archive first, then encrypted variant.
              const byId = path.join(capsulesDir, `${archivePath}.capsule.json.gz`);
              const byIdEnc = path.join(capsulesDir, `${archivePath}.capsule.json.gz.enc`);
              const st = await stat(byId).catch(() => null);
              if (st && st.isFile()) {
                archivePath = byId;
              } else {
                const stEnc = await stat(byIdEnc).catch(() => null);
                if (stEnc && stEnc.isFile()) {
                  archivePath = byIdEnc;
                }
              }
            }
          }

          const isEncrypted = archivePath.endsWith(".capsule.json.gz.enc");

          // Derive sidecar path: strip ".enc" suffix first (if present), then
          // replace ".capsule.json.gz" with ".manifest.json".
          const sidecarPath = archivePath
            .replace(/\.enc$/, "")
            .replace(/\.capsule\.json\.gz$/, ".manifest.json");

          // Prefer sidecar manifest for cheap inspection.
          let sidecar: Record<string, unknown> | null = null;
          try {
            const { readFile } = await import("node:fs/promises");
            const raw = await readFile(sidecarPath, "utf-8");
            sidecar = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            // No sidecar — fall back to decompressing the archive (plain only).
          }

          let manifest: Record<string, unknown>;
          if (sidecar !== null) {
            manifest = sidecar;
          } else if (isEncrypted) {
            // No sidecar — attempt in-memory decryption if the secure-store is
            // unlocked.  decryptCapsuleFileInMemory returns the plaintext gzip
            // bytes; we then gunzip and parse exactly like the plaintext path.
            const { gunzipSync } = await import("node:zlib");
            const { parseExportBundle } = await import("./transfer/types.js");
            let decryptedBuf: Buffer;
            try {
              const { decryptCapsuleFileInMemory } = await import(
                "./transfer/capsule-crypto.js"
              );
              decryptedBuf = await decryptCapsuleFileInMemory(archivePath, memoryDir);
            } catch (decErr) {
              const msg =
                decErr instanceof Error ? decErr.message : String(decErr);
              const isLocked = msg.includes("locked") || msg.includes("no key");
              process.stderr.write(
                isLocked
                  ? `capsule inspect: secure-store is locked — unlock it first ` +
                      `(remnic secure-store unlock) or provide the sidecar ` +
                      `.manifest.json to inspect without decrypting.\n`
                  : `capsule inspect: failed to decrypt archive — ${msg}\n`,
              );
              process.exitCode = 1;
              return;
            }
            const json = gunzipSync(decryptedBuf).toString("utf-8");
            const parsed2 = parseExportBundle(JSON.parse(json));
            if (parsed2.capsuleVersion !== 2) {
              process.stderr.write(
                `capsule inspect: only V2 capsule archives are supported\n`,
              );
              process.exitCode = 1;
              return;
            }
            manifest = (parsed2.bundle as { manifest: Record<string, unknown> }).manifest;
          } else {
            const { readFile } = await import("node:fs/promises");
            const { gunzipSync } = await import("node:zlib");
            const { parseExportBundle } = await import("./transfer/types.js");
            const buf = await readFile(archivePath);
            const json = gunzipSync(buf).toString("utf-8");
            const parsed2 = parseExportBundle(JSON.parse(json));
            if (parsed2.capsuleVersion !== 2) {
              process.stderr.write(
                `capsule inspect: only V2 capsule archives are supported\n`,
              );
              process.exitCode = 1;
              return;
            }
            manifest = (parsed2.bundle as { manifest: Record<string, unknown> }).manifest;
          }

          const capsule = (manifest.capsule ?? {}) as Record<string, unknown>;
          const files = Array.isArray(manifest.files) ? manifest.files : [];
          const TOP_N = 20;
          const topFiles = (files as Array<{ path: string }>)
            .slice(0, TOP_N)
            .map((f) => f.path ?? "");

          const retrievalPolicy = (capsule.retrievalPolicy ?? {}) as Record<string, unknown>;
          const includes = (capsule.includes ?? {}) as Record<string, unknown>;

          const data: CapsuleInspectData = {
            capsuleId: typeof capsule.id === "string" ? capsule.id : "(unknown)",
            version: typeof capsule.version === "string" ? capsule.version : "—",
            schemaVersion:
              typeof capsule.schemaVersion === "string" ? capsule.schemaVersion : "—",
            createdAt:
              typeof manifest.createdAt === "string" ? manifest.createdAt : null,
            pluginVersion:
              typeof manifest.pluginVersion === "string" ? manifest.pluginVersion : null,
            fileCount: files.length,
            includesTranscripts: manifest.includesTranscripts === true,
            description:
              typeof capsule.description === "string" ? capsule.description : "",
            parentCapsule:
              typeof capsule.parentCapsule === "string" ? capsule.parentCapsule : null,
            retrievalPolicy: {
              tierWeights:
                retrievalPolicy.tierWeights != null &&
                typeof retrievalPolicy.tierWeights === "object"
                  ? (retrievalPolicy.tierWeights as Record<string, number>)
                  : {},
              directAnswerEnabled: retrievalPolicy.directAnswerEnabled === true,
            },
            includes: {
              taxonomy: includes.taxonomy === true,
              identityAnchors: includes.identityAnchors === true,
              peerProfiles: includes.peerProfiles === true,
              procedural: includes.procedural === true,
            },
            topFiles,
          };

          console.log(renderCapsuleInspect(data, parsed.format));
        });

      cmd
        .command("compat")
        .description("Run local compatibility diagnostics for Engram plugin wiring")
        .option("--json", "Emit JSON output for automation")
        .option("--strict", "Exit non-zero when warnings or errors are present")
        .option("--repo-root <path>", "Repository root to inspect", process.cwd())
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const strict = options.strict === true;
          const jsonOutput = options.json === true;
          const repoRoot =
            typeof options.repoRoot === "string" && options.repoRoot.trim().length > 0
              ? options.repoRoot.trim()
              : process.cwd();

          const result = await runCompatCliCommand({ repoRoot, strict });

          if (jsonOutput) {
            console.log(JSON.stringify({ strict, exitCode: result.exitCode, report: result.report }, null, 2));
          } else {
            console.log("=== Engram Compatibility Report ===");
            for (const check of result.report.checks) {
              console.log(`- [${check.level.toUpperCase()}] ${check.title}: ${check.message}`);
              if (check.remediation) {
                console.log(`    remediation: ${check.remediation}`);
              }
            }
            console.log(
              `Summary: ok=${result.report.summary.ok} warn=${result.report.summary.warn} error=${result.report.summary.error}`,
            );
          }

          if (result.exitCode !== 0) {
            process.exitCode = result.exitCode;
          }
        });

      cmd
        .command("replay")
        .description("Import replay transcripts from external exports")
        .option("--source <source>", "Replay source: openclaw|claude|chatgpt")
        .option("--input <path>", "Path to replay export file")
        .option("--from <iso>", "Inclusive lower bound timestamp (ISO UTC)")
        .option("--to <iso>", "Inclusive upper bound timestamp (ISO UTC)")
        .option("--dry-run", "Parse and validate only; do not enqueue extraction")
        .option("--start-offset <n>", "Start replay at offset", "0")
        .option("--max-turns <n>", "Maximum turns to process", "0")
        .option("--batch-size <n>", "Replay ingestion batch size", "100")
        .option("--default-session-key <key>", "Fallback session key when source session identifiers are missing")
        .option("--strict", "Fail on invalid source rows")
        .option("--run-consolidation", "Run consolidation after replay ingestion completes")
        .option("--idle-timeout-ms <n>", "Extraction idle timeout per replay batch/final drain in milliseconds", "900000")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const sourceRaw = typeof options.source === "string" ? options.source.trim().toLowerCase() : "";
          const inputPath = typeof options.input === "string" ? options.input.trim() : "";
          if (!isReplaySource(sourceRaw)) {
            console.log("Missing or invalid --source. Use one of: openclaw, claude, chatgpt.");
            return;
          }
          if (inputPath.length === 0) {
            console.log("Missing --input. Example: openclaw engram replay --source openclaw --input /tmp/replay.jsonl");
            return;
          }

          const startOffset = parseInt(String(options.startOffset ?? "0"), 10);
          const maxTurnsRaw = parseInt(String(options.maxTurns ?? "0"), 10);
          const batchSize = parseInt(String(options.batchSize ?? "100"), 10);
          const idleTimeoutMs = parseInt(String(options.idleTimeoutMs ?? "900000"), 10);
          const summary = await runReplayCliCommand(orchestrator, {
            source: sourceRaw,
            inputPath,
            from: typeof options.from === "string" ? options.from : undefined,
            to: typeof options.to === "string" ? options.to : undefined,
            dryRun: options.dryRun === true,
            startOffset: Number.isFinite(startOffset) ? Math.max(0, startOffset) : 0,
            maxTurns: Number.isFinite(maxTurnsRaw) && maxTurnsRaw > 0 ? maxTurnsRaw : undefined,
            batchSize: Number.isFinite(batchSize) && batchSize > 0 ? batchSize : 100,
            defaultSessionKey:
              typeof options.defaultSessionKey === "string" && options.defaultSessionKey.trim().length > 0
                ? options.defaultSessionKey.trim()
                : undefined,
            strict: options.strict === true,
            runConsolidation: options.runConsolidation === true,
            extractionIdleTimeoutMs: Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0 ? idleTimeoutMs : 900_000,
          });

          console.log(`Replay source: ${summary.source}`);
          console.log(`Parsed turns: ${summary.parsedTurns}`);
          console.log(`Valid turns: ${summary.validTurns}`);
          console.log(`Invalid turns: ${summary.invalidTurns}`);
          console.log(`Filtered by date: ${summary.filteredByDate}`);
          console.log(`Skipped by offset: ${summary.skippedByOffset}`);
          console.log(`Processed turns: ${summary.processedTurns}`);
          console.log(`Batches: ${summary.batchCount}`);
          console.log(`Dry run: ${summary.dryRun ? "yes" : "no"}`);
          console.log(`Next offset: ${summary.nextOffset}`);
          if (summary.firstTimestamp) console.log(`First timestamp: ${summary.firstTimestamp}`);
          if (summary.lastTimestamp) console.log(`Last timestamp: ${summary.lastTimestamp}`);
          if (summary.warnings.length > 0) {
            console.log(`Warnings (${summary.warnings.length}):`);
            for (const warning of summary.warnings.slice(0, 20)) {
              const idx = typeof warning.index === "number" ? ` @${warning.index}` : "";
              console.log(`  - ${warning.code}${idx}: ${warning.message}`);
            }
            if (summary.warnings.length > 20) {
              console.log(`  ... and ${summary.warnings.length - 20} more`);
            }
          }
          console.log("OK");
        });

      cmd
        .command("bulk-import")
        .description(
          "Bulk-import chat history via a registered source adapter " +
            "(e.g. --source weclone).",
        )
        .option("--source <source>", "Bulk-import source adapter name (e.g. weclone)")
        .option("--file <path>", "Path to the import file (JSON)")
        .option("--platform <platform>", "Optional platform override forwarded to the adapter")
        .option("--batch-size <n>", "Turns per batch", "50")
        .option("--dry-run", "Parse and validate only; do not persist")
        .option("--strict", "Fail on any invalid source row")
        .option("--verbose", "Print per-batch error details")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const sourceRaw = typeof options.source === "string" ? options.source.trim() : "";
          const filePathRaw = typeof options.file === "string" ? options.file.trim() : "";
          if (sourceRaw.length === 0) {
            console.log("Missing --source. Example: openclaw engram bulk-import --source weclone --file /tmp/export.json");
            return;
          }
          if (filePathRaw.length === 0) {
            console.log("Missing --file. Example: openclaw engram bulk-import --source weclone --file /tmp/export.json");
            return;
          }
          const batchSizeRaw = parseInt(String(options.batchSize ?? "50"), 10);
          const batchSize = Number.isFinite(batchSizeRaw) && batchSizeRaw > 0 ? batchSizeRaw : 50;
          const platformRaw = typeof options.platform === "string" ? options.platform.trim() : "";
          // Ask the orchestrator for the EXACT namespace bulk-import will
          // write to, rather than assuming `config.defaultNamespace`. The two
          // can differ — e.g. when `namespacesEnabled` is on and a policy
          // named `"default"` exists alongside a different
          // `config.defaultNamespace`, `defaultNamespaceForPrincipal` would
          // pick the policy's `"default"`. Using the orchestrator's
          // `bulkImportWriteNamespace()` guarantees the snapshot anchor
          // matches `runExtraction`'s writeNamespaceOverride.
          const writeNamespace = orchestrator.bulkImportWriteNamespace();
          const writeStorage = await orchestrator.getStorageForNamespace(
            writeNamespace,
          );
          const writeRoot = writeStorage.dir;
          const ingestBatch: ProcessBatchFn = async (turns) => {
            // Filename-set diff correctly excludes files that already existed
            // (vs. a naïve `after - before` integer subtraction, which would
            // inflate when unrelated files are deleted mid-batch). Concurrent
            // organic extractions against the same writeRoot can still inflate
            // this count; the extraction engine does not expose a per-session
            // hook for "files created by this run", so full isolation against
            // concurrent writes is tracked as a follow-up.
            const before = new Set(await listMemoryMarkdownFilePaths(writeRoot));
            await orchestrator.ingestBulkImportBatch(turns, {});
            const after = await listMemoryMarkdownFilePaths(writeRoot);
            let memoriesCreated = 0;
            for (const p of after) {
              if (!before.has(p)) memoriesCreated += 1;
            }
            return { memoriesCreated, duplicatesSkipped: 0 };
          };
          try {
            const result = await runBulkImportCliCommand({
              memoryDir: writeRoot,
              source: sourceRaw,
              file: filePathRaw,
              platform: platformRaw.length > 0 ? platformRaw : undefined,
              batchSize,
              dryRun: options.dryRun === true,
              verbose: options.verbose === true,
              strict: options.strict === true,
              ingestBatch,
              stdout: process.stdout,
              stderr: process.stderr,
            });
            if (result.errors.length > 0) {
              console.error(`Bulk import completed with ${result.errors.length} batch error(s).`);
              process.exitCode = 1;
            } else {
              console.log("OK");
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`Bulk import failed: ${message}`);
            process.exitCode = 1;
          }
        });

      cmd
        .command("benchmark-status")
        .description("Show benchmark/evaluation harness status, benchmark packs, and latest run summary")
        .action(async () => {
          const status = await runBenchmarkStatusCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            evalStoreDir: orchestrator.config.evalStoreDir,
            evalHarnessEnabled: orchestrator.config.evalHarnessEnabled,
            evalShadowModeEnabled: orchestrator.config.evalShadowModeEnabled,
            benchmarkBaselineSnapshotsEnabled: orchestrator.config.benchmarkBaselineSnapshotsEnabled,
            memoryRedTeamBenchEnabled: orchestrator.config.memoryRedTeamBenchEnabled,
          });
          console.log(JSON.stringify(status, null, 2));
          console.log("OK");
        });

      const benchmarkCmd = cmd
        .command("benchmark")
        .description("Grouped benchmark and recall-evaluation operator workflows");

      benchmarkCmd
        .command("recall")
        .description("Status, validate, snapshot, or compare recall benchmark artifacts")
        .option("--validate <path>", "Validate a benchmark pack/manifest before import or rollout")
        .option("--snapshot-id <id>", "Compare against or create a named stored baseline snapshot")
        .option("--create-snapshot", "Create a baseline snapshot instead of reading an existing one")
        .option("--notes <text>", "Optional notes to attach when creating a snapshot")
        .option("--git-ref <ref>", "Git ref to record when creating a snapshot")
        .option("--created-at <iso>", "Override snapshot creation timestamp")
        .option("--base <path>", "Base eval store directory for CI-style comparison")
        .option("--candidate <path>", "Candidate eval store directory for CI-style comparison")
        .option("--json", "Emit machine-readable JSON only")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const report = await runBenchmarkRecall({
            config: {
              memoryDir: orchestrator.config.memoryDir,
              evalStoreDir: orchestrator.config.evalStoreDir,
              evalHarnessEnabled: orchestrator.config.evalHarnessEnabled,
              evalShadowModeEnabled: orchestrator.config.evalShadowModeEnabled,
              benchmarkBaselineSnapshotsEnabled: orchestrator.config.benchmarkBaselineSnapshotsEnabled,
              benchmarkDeltaReporterEnabled: orchestrator.config.benchmarkDeltaReporterEnabled,
              memoryRedTeamBenchEnabled: orchestrator.config.memoryRedTeamBenchEnabled,
            },
            validatePath: typeof options.validate === "string" ? options.validate : undefined,
            baseEvalStoreDir: typeof options.base === "string" ? options.base : undefined,
            candidateEvalStoreDir: typeof options.candidate === "string" ? options.candidate : undefined,
            snapshotId: typeof options.snapshotId === "string" ? options.snapshotId : undefined,
            createSnapshot: options.createSnapshot === true,
            snapshotNotes: typeof options.notes === "string" ? options.notes : undefined,
            gitRef: typeof options.gitRef === "string" ? options.gitRef : undefined,
            createdAt: typeof options.createdAt === "string" ? options.createdAt : undefined,
          });
          if (reportHasMachineReadableOutput(options)) {
            console.log(JSON.stringify(report, null, 2));
          } else {
            console.log(formatBenchmarkRecallCli(report));
          }
          const passed = report.ciGate?.passed ?? report.baselineReport?.passed ?? true;
          if (!passed) {
            process.exitCode = 1;
            return;
          }
          if (!reportHasMachineReadableOutput(options)) console.log("OK");
        });

      cmd
        .command("recall")
        .description(
          "Run a recall against memory.  Pass --disclosure to control payload depth (chunk|section|raw).  Part of #677.",
        )
        .argument("<query>", "Query to recall against")
        .option(
          "--disclosure <level>",
          `Disclosure depth (one of: ${RECALL_DISCLOSURE_LEVELS.join(", ")}).  Defaults to chunk.`,
        )
        .option(
          "--namespace <ns>",
          "Namespace to scope the recall to (defaults to configured namespace)",
        )
        .option(
          "--session <key>",
          "Session key (used for session-scoped raw transcript excerpts when --disclosure=raw)",
        )
        .option(
          "--top-k <n>",
          "Maximum number of memory results to include (positive integer)",
        )
        .option(
          "--format <fmt>",
          "Output format: text (default) or json",
          "text",
        )
        .option(
          "--as-of <iso>",
          "Historical recall pin (issue #680). ISO 8601 timestamp; returns the corpus as it existed at this instant.",
        )
        .option(
          "--tag <tag>",
          "Filter recall results by tag. Repeatable; alternatively pass a comma-separated list (issue #689).",
          (val: string, prev: unknown) =>
            Array.isArray(prev) ? [...(prev as string[]), val] : [val],
        )
        .option(
          "--tag-match <mode>",
          "Tag-filter match mode: any (default) or all. Ignored when --tag is absent.",
        )
        .option(
          "--include-low-confidence",
          "Include graph edges below the configured graphTraversalConfidenceFloor in traversal (issue #681). Default off.",
        )
        .action(async (...args: unknown[]) => {
          const query = typeof args[0] === "string" ? args[0] : String(args[0] ?? "");
          if (!query || query.trim().length === 0) {
            throw new Error("missing required argument: <query>");
          }
          const options = (args[1] ?? {}) as Record<string, unknown>;

          // Disclosure validation (CLAUDE.md rule 51): explicit values
          // must be on the allow-list; otherwise reject loudly so a typo
          // (e.g. --disclosure full) does not silently default to chunk.
          let disclosure: RecallDisclosure | undefined;
          if (options.disclosure !== undefined) {
            if (typeof options.disclosure !== "string" || !isRecallDisclosure(options.disclosure)) {
              throw new Error(
                `invalid --disclosure value: ${String(options.disclosure)} (expected one of: ${RECALL_DISCLOSURE_LEVELS.join(", ")})`,
              );
            }
            disclosure = options.disclosure;
          }

          // Top-K validation: positive integer or undefined.  Reject
          // strings that don't parse so the operator notices typos.
          // `Number.parseInt` silently truncates floats and accepts
          // trailing garbage (`3.7` -> 3, `10abc` -> 10), so we require
          // an exact decimal-integer match before parsing.
          let topK: number | undefined;
          if (options.topK !== undefined) {
            const raw = String(options.topK);
            if (!/^\d+$/.test(raw)) {
              throw new Error(`invalid --top-k value: ${raw} (expected positive integer)`);
            }
            const parsed = Number.parseInt(raw, 10);
            if (!Number.isFinite(parsed) || parsed <= 0) {
              throw new Error(`invalid --top-k value: ${raw} (expected positive integer)`);
            }
            topK = parsed;
          }

          const namespace =
            typeof options.namespace === "string" && options.namespace.length > 0
              ? options.namespace
              : undefined;
          const sessionKey =
            typeof options.session === "string" && options.session.length > 0
              ? options.session
              : undefined;
          // Strict --format validation: reject unrecognized values
          // instead of silently defaulting (CLAUDE.md rule 51).
          // Only "text" and "json" are supported; an absent flag falls
          // back to "text" by intent, but `--format csv` (or anything
          // else) must throw.  Mirrors --disclosure / --top-k strictness
          // in the same handler.
          let format: "text" | "json" = "text";
          if (options.format !== undefined) {
            const raw = String(options.format).toLowerCase();
            if (raw !== "text" && raw !== "json") {
              throw new Error(
                `invalid --format value: ${String(options.format)} (expected one of: text, json)`,
              );
            }
            format = raw as "text" | "json";
          }

          // Issue #680 — `--as-of` validation at the input boundary
          // (CLAUDE.md rule 51 / gotcha #14).
          let asOf: string | undefined;
          if (options.asOf !== undefined) {
            const raw = String(options.asOf).trim();
            if (raw.length === 0) {
              throw new Error("--as-of requires a non-empty ISO 8601 timestamp");
            }
            const parsedAsOf = Date.parse(raw);
            if (!Number.isFinite(parsedAsOf)) {
              throw new Error(
                `invalid --as-of value: ${raw} (expected an ISO 8601 timestamp parseable by Date.parse)`,
              );
            }
            asOf = raw;
          }

          // Tag filter (issue #689). `--tag` accepts comma-separated
          // and repeated invocations.
          let tags: string[] | undefined;
          if (options.tag !== undefined) {
            const raw = Array.isArray(options.tag)
              ? options.tag
              : [options.tag];
            const cleaned: string[] = [];
            const seen = new Set<string>();
            for (const entry of raw) {
              if (typeof entry !== "string") continue;
              for (const part of entry.split(",")) {
                const trimmed = part.trim();
                if (trimmed.length === 0) continue;
                if (seen.has(trimmed)) continue;
                seen.add(trimmed);
                cleaned.push(trimmed);
              }
            }
            tags = cleaned.length > 0 ? cleaned : undefined;
          }
          let tagMatch: "any" | "all" | undefined;
          if (options.tagMatch !== undefined) {
            const raw = String(options.tagMatch).trim();
            if (raw !== "any" && raw !== "all") {
              throw new Error(
                `invalid --tag-match value: ${String(options.tagMatch)} (expected one of: any, all)`,
              );
            }
            tagMatch = raw;
          }

          // Issue #681 — `--include-low-confidence` is a boolean flag; no
          // value coercion needed beyond checking presence (Commander sets
          // it to `true` when the flag is present, undefined otherwise).
          const includeLowConfidence = options.includeLowConfidence === true;

          const accessService = new EngramAccessService(orchestrator);
          const response = await accessService.recall({
            query,
            ...(sessionKey !== undefined ? { sessionKey } : {}),
            ...(namespace !== undefined ? { namespace } : {}),
            ...(topK !== undefined ? { topK } : {}),
            ...(disclosure !== undefined ? { disclosure } : {}),
            ...(asOf !== undefined ? { asOf } : {}),
            ...(tags !== undefined ? { tags } : {}),
            ...(tagMatch !== undefined ? { tagMatch } : {}),
            ...(includeLowConfidence ? { includeLowConfidence: true } : {}),
          });

          if (format === "json") {
            console.log(JSON.stringify(response, null, 2));
            return;
          }

          // Plain-text rendering.  Keep this terse — the JSON format is
          // the canonical surface for tooling.  Per-result disclosure is
          // shown inline so operators can confirm the requested depth
          // was honored end-to-end.
          console.log(`=== Recall: "${query}" ===`);
          console.log(`namespace: ${response.namespace}`);
          console.log(`disclosure: ${response.disclosure}`);
          console.log(`results: ${response.count}`);
          if (response.results.length === 0) {
            console.log("(no results)");
            return;
          }
          for (const r of response.results) {
            console.log("");
            console.log(`- ${r.path}`);
            console.log(`  category: ${r.category}`);
            if (r.tags.length > 0) {
              console.log(`  tags: ${r.tags.join(", ")}`);
            }
            console.log(`  preview: ${r.preview}`);
            if (r.content) {
              console.log(`  content (${r.content.length} chars):`);
              console.log(
                r.content
                  .split("\n")
                  .map((line) => `    ${line}`)
                  .join("\n"),
              );
            }
            if (r.rawExcerpts && r.rawExcerpts.length > 0) {
              console.log(`  raw excerpts (${r.rawExcerpts.length}):`);
              for (const ex of r.rawExcerpts) {
                console.log(
                  `    [turn ${ex.turnIndex}, ${ex.role}] ${ex.content.slice(0, 200)}`,
                );
              }
            }
          }
        });

      cmd
        .command("recall-explain")
        .description(
          "Show tier explain for the most recent recall (or a specific session)",
        )
        .option(
          "--session <key>",
          "Session key to look up; omit to use the most recent snapshot",
        )
        .option("--format <fmt>", "Output format: text (default) or json", "text")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const format = parseRecallExplainFormat(options.format);
          await orchestrator.lastRecall.load();
          const sessionKey =
            typeof options.session === "string" && options.session.length > 0
              ? options.session
              : undefined;
          let snapshot: ReturnType<typeof orchestrator.lastRecall.get> = null;
          try {
            snapshot = sessionKey
              ? orchestrator.lastRecall.get(sessionKey)
              : orchestrator.lastRecall.getMostRecent();
          } catch {
            snapshot = null;
          }
          console.log(renderRecallExplain(snapshot, format));
        });

      cmd
        .command("xray")
        .description(
          "Run a recall with X-ray capture and print the unified snapshot (tier + audit + MMR + filters).  Part of #570.",
        )
        .argument("<query>", "Query to recall against")
        .option(
          "--format <fmt>",
          "Output format: text (default), markdown, or json",
          "text",
        )
        .option(
          "--budget <chars>",
          "Override recall character budget for this call (positive integer)",
        )
        .option(
          "--namespace <ns>",
          "Namespace to scope the recall to (defaults to configured namespace)",
        )
        .option(
          "--out <path>",
          "Write the rendered snapshot to a file instead of stdout",
        )
        .option(
          "--disclosure <level>",
          "Disclosure depth (chunk | section | raw). Populates the per-disclosure token-spend summary.",
        )
        .action(async (...args: unknown[]) => {
          // Commander passes positional args first, then the options
          // object as the last argument.  `parseXrayCliOptions` is a
          // pure helper that throws listed-options errors for invalid
          // --format / --budget / --namespace / --out values — it's
          // imported from `recall-xray-cli.ts` so the validation path
          // can be unit-tested without booting an orchestrator
          // (CLAUDE.md rules 14 + 51).
          const parsed = parseXrayCliOptions(
            args[0],
            (args[1] ?? {}) as Record<string, unknown>,
          );
          // Route the xray capture through `EngramAccessService` so
          // the CLI shares the same `xrayQueue` mutex that the HTTP
          // and MCP surfaces use — otherwise the
          // `clearLastXraySnapshot() → recall() → getLastXraySnapshot()`
          // sequence races with concurrent callers (e.g., a gateway
          // agent hitting the same orchestrator) and could swap in
          // their snapshot mid-flight, or our capture could overwrite
          // theirs (cursor Medium + codex P1 review on #597).  The
          // service enforces CLAUDE.md rules 40 (serialized state) and
          // 47 (no shared mutable state across async boundaries).
          const xrayService = new EngramAccessService(orchestrator);
          const response = await xrayService.recallXray({
            query: parsed.query,
            ...(parsed.namespace ? { namespace: parsed.namespace } : {}),
            ...(parsed.budget !== undefined ? { budget: parsed.budget } : {}),
            ...(parsed.disclosure !== undefined
              ? { disclosure: parsed.disclosure }
              : {}),
          });
          const snapshot = response.snapshotFound
            ? response.snapshot ?? null
            : null;
          const rendered = renderXray(snapshot, parsed.format);
          if (parsed.outPath) {
            const { writeFile: fsWriteFile } = await import("node:fs/promises");
            await fsWriteFile(expandTildePath(parsed.outPath), rendered, "utf8");
          } else {
            console.log(rendered);
          }
        });

      // ── Patterns subcommand (issue #687 PR 4/4) ──────────────────────────
      // `remnic patterns list` and `remnic patterns explain <id>` surface
      // the pattern-reinforcement output written by PR 2/4.  Validation
      // helpers live in `patterns-cli.ts` (pure functions, unit-testable
      // without booting an orchestrator — CLAUDE.md rules 14 + 51).
      const patternsCmd = cmd
        .command("patterns")
        .description(
          "Inspect reinforced pattern memories produced by the pattern-reinforcement job (#687 PR 2/4).",
        );

      patternsCmd
        .command("list")
        .description(
          "List memories with reinforcement_count > 0, sorted by count desc.  Part of #687.",
        )
        .option(
          "--limit <N>",
          "Maximum number of rows to show (default 50, positive integer)",
        )
        .option(
          "--category <list>",
          "Comma-separated category filter (e.g. fact,preference)",
        )
        .option(
          "--since <ISO>",
          "Only include memories reinforced on or after this ISO 8601 timestamp",
        )
        .option(
          "--format <fmt>",
          "Output format: text (default), markdown, or json",
        )
        .action(async (...args: unknown[]) => {
          // Commander passes the options object as the only / last arg
          // for a command with no positional arguments.
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const parsed = parsePatternsListOptions(options);
          const memories = await orchestrator.storage.readAllMemories();
          const rows = collectPatternMemories(memories, parsed);
          console.log(renderPatternsList(rows, parsed.format));
        });

      patternsCmd
        .command("explain")
        .description(
          "Show reinforcement detail for a single pattern canonical: count, provenance chain, and cluster members.  Part of #687.",
        )
        .argument("<memoryId>", "ID of the canonical memory to explain")
        .option(
          "--format <fmt>",
          "Output format: text (default), markdown, or json",
        )
        .action(async (...args: unknown[]) => {
          const rawId = args[0];
          const options = (args[1] ?? {}) as Record<string, unknown>;
          const parsed = parsePatternsExplainOptions(rawId, options);
          const memories = await orchestrator.storage.readAllMemories();
          const detail = explainPatternMemory(memories, parsed.id);
          if (detail === null) {
            process.stderr.write(
              `patterns explain: "${parsed.id}" was not found or has no reinforcement_count > 0.\n`,
            );
            process.exitCode = 1;
            return;
          }
          console.log(renderPatternExplain(detail, parsed.format));
        });

      // ── Connectors subcommand (issue #683 PR 6/N) ────────────────────────
      // `remnic connectors list` — show all configured live connectors with
      //   their enabled state, last poll time, and last error.
      // `remnic connectors status` — same data, defaults to JSON for scripting.
      // `remnic connectors run <name>` — manually trigger a single
      //   `syncIncremental()` pass for the named connector (operator debug).
      //
      // Pure-function helpers live in `connectors-cli.ts` so this handler
      // stays thin and the logic is unit-testable without booting an
      // orchestrator (CLAUDE.md rules 14 + 51).  Connector state is read from
      // `<memoryDir>/state/connectors/<id>.json` via `listConnectorStates`.
      {
        /**
         * Build the list of known connector rows from parsed config +
         * persisted state.  Adding a new built-in connector here is a
         * one-liner: add a row with the connector's id, display name, and
         * enabled flag from `orchestrator.config.connectors`.
         */
        async function buildConnectorRows(): Promise<ConnectorRow[]> {
          const states = await listConnectorStates(
            orchestrator.config.memoryDir,
          );
          const stateMap = new Map(states.map((s) => [s.id, s]));
          const builtIn: Array<{
            id: string;
            displayName: string;
            enabled: boolean;
          }> = [
            {
              id: GOOGLE_DRIVE_CONNECTOR_ID,
              displayName: "Google Drive",
              enabled: orchestrator.config.connectors.googleDrive.enabled,
            },
            {
              id: NOTION_CONNECTOR_ID,
              displayName: "Notion",
              enabled: orchestrator.config.connectors.notion.enabled,
            },
          ];
          return builtIn.map((c) => ({
            id: c.id,
            displayName: c.displayName,
            enabled: c.enabled,
            state: stateMap.get(c.id) ?? null,
          }));
        }

        const connectorsCmd = cmd
          .command("connectors")
          .description(
            "Manage live connectors (Google Drive, Notion, …). Subcommands: list, status, run. See docs/live-connectors.md.",
          );

        connectorsCmd
          .command("list")
          .description(
            "List all configured live connectors with their enabled state, last poll time, and last error.",
          )
          .option(
            "--format <fmt>",
            "Output format: text (default), markdown, or json",
          )
          .action(async (...args: unknown[]) => {
            const options = (args[0] ?? {}) as Record<string, unknown>;
            let parsed;
            try {
              parsed = parseConnectorsListOptions(options);
            } catch (err) {
              process.stderr.write(
                `connectors list: ${err instanceof Error ? err.message : String(err)}\n`,
              );
              process.exitCode = 2;
              return;
            }
            const rows = await buildConnectorRows();
            console.log(renderConnectorsList(rows, parsed.format));
          });

        connectorsCmd
          .command("status")
          .description(
            "Print connector status. Defaults to JSON output for scripting. Use --format text|markdown to override.",
          )
          .option(
            "--format <fmt>",
            "Output format: json (default), text, or markdown",
          )
          .action(async (...args: unknown[]) => {
            const options = (args[0] ?? {}) as Record<string, unknown>;
            let parsed;
            try {
              parsed = parseConnectorsStatusOptions(options);
            } catch (err) {
              process.stderr.write(
                `connectors status: ${err instanceof Error ? err.message : String(err)}\n`,
              );
              process.exitCode = 2;
              return;
            }
            const rows = await buildConnectorRows();
            console.log(renderConnectorsList(rows, parsed.format));
          });

        connectorsCmd
          .command("run")
          .description(
            "Manually trigger one incremental sync pass for the named connector. Operator debug surface.",
          )
          .argument("<name>", "Connector id (e.g. google-drive, notion)")
          .option(
            "--format <fmt>",
            "Output format: text (default), markdown, or json",
          )
          .action(async (...args: unknown[]) => {
            const rawName = args[0];
            const options = (args[1] ?? {}) as Record<string, unknown>;
            let name: string;
            try {
              name = parseConnectorsRunName(rawName);
            } catch (err) {
              process.stderr.write(
                `connectors run: ${err instanceof Error ? err.message : String(err)}\n`,
              );
              process.exitCode = 2;
              return;
            }
            // Validate --format early so we can error before doing I/O.
            // `run` defaults to "text" (same as `list`).
            let format: "text" | "markdown" | "json";
            try {
              format = parseConnectorsListOptions({ format: options.format }).format;
            } catch (err) {
              process.stderr.write(
                `connectors run: ${err instanceof Error ? err.message : String(err)}\n`,
              );
              process.exitCode = 2;
              return;
            }

            // Route to the matching built-in connector.
            //
            // Shared ingestFn and writeCursorFn are identical for every
            // built-in connector; only the syncFn (connector-specific factory
            // + config validator) differs.  Extract both as local closures so
            // adding a new connector is a one-liner (Cursor thread
            // PRRT_kwDORJXyws59slAJ — DRY the per-connector scaffolding).
            const cfg = orchestrator.config.connectors;

            const { readConnectorState, writeConnectorState } = await import(
              "./connectors/live/state-store.js"
            );

            /**
             * Shared ingest callback: each fetched document is ingested as an
             * assistant-role bulk-import turn so the extraction pipeline can
             * distil it into memories.  The title (when present) is prepended
             * as a Markdown heading to give the extractor extra context.
             */
            const sharedIngestFn = async (docs: import("./connectors/live/index.js").ConnectorDocument[]) => {
              const fetchedAt = new Date().toISOString();
              const turns = docs.map((doc) => ({
                role: "assistant" as const,
                content: doc.title
                  ? `# ${doc.title}\n\n${doc.content}`
                  : doc.content,
                timestamp: fetchedAt,
              }));
              await orchestrator.ingestBulkImportBatch(turns);
            };

            /**
             * Shared state-persistence callback: writes the connector's cursor
             * and sync metadata to `<memoryDir>/state/connectors/<id>.json`.
             * Used on both the success path (advancing cursor) and the error
             * path (retaining prior cursor).
             */
            const makeWriteCursorFn =
              (connectorName: string) =>
              async ({
                cursor,
                lastSyncStatus,
                lastSyncError,
                totalDocsImported,
              }: {
                cursor: import("./connectors/live/index.js").ConnectorCursor | null;
                lastSyncStatus: import("./connectors/live/index.js").ConnectorSyncStatus;
                lastSyncError?: string;
                totalDocsImported: number;
              }) => {
                await writeConnectorState(
                  orchestrator.config.memoryDir,
                  connectorName,
                  {
                    id: connectorName,
                    cursor,
                    lastSyncAt: new Date().toISOString(),
                    lastSyncStatus,
                    ...(lastSyncError !== undefined ? { lastSyncError } : {}),
                    totalDocsImported,
                  },
                );
              };

            let runResult: ConnectorRunResult;
            if (name === GOOGLE_DRIVE_CONNECTOR_ID) {
              if (!cfg.googleDrive.enabled) {
                process.stderr.write(
                  `connectors run: connector "${name}" is disabled. Set connectors.googleDrive.enabled=true in config.\n`,
                );
                process.exitCode = 1;
                return;
              }
              let validatedCfg;
              try {
                validatedCfg = validateGoogleDriveConfig(cfg.googleDrive);
              } catch (err) {
                process.stderr.write(
                  `connectors run: invalid config for "${name}": ${err instanceof Error ? err.message : String(err)}\n`,
                );
                process.exitCode = 1;
                return;
              }
              const connector = createGoogleDriveConnector();
              const state = await readConnectorState(
                orchestrator.config.memoryDir,
                name,
              );
              // runConnectorPollOnce enforces: ingest docs BEFORE advancing the
              // cursor (CLAUDE.md gotcha #25 + #43).  If ingestFn throws, the
              // catch branch in runConnectorPollOnce writes the OLD cursor so
              // the next poll re-fetches the same document window.
              runResult = await runConnectorPollOnce({
                connectorId: name,
                priorState: state,
                syncFn: (cursor) =>
                  connector.syncIncremental({
                    cursor,
                    // GoogleDriveConnectorConfig is narrower than ConnectorConfig
                    // (no index signature) but is structurally compatible at
                    // runtime. Double-cast via unknown to satisfy the interface.
                    config: validatedCfg as unknown as Record<string, unknown>,
                  }),
                ingestFn: sharedIngestFn,
                writeCursorFn: makeWriteCursorFn(name),
              });
            } else if (name === NOTION_CONNECTOR_ID) {
              if (!cfg.notion.enabled) {
                process.stderr.write(
                  `connectors run: connector "${name}" is disabled. Set connectors.notion.enabled=true in config.\n`,
                );
                process.exitCode = 1;
                return;
              }
              let validatedCfg;
              try {
                validatedCfg = validateNotionConfig(cfg.notion);
              } catch (err) {
                process.stderr.write(
                  `connectors run: invalid config for "${name}": ${err instanceof Error ? err.message : String(err)}\n`,
                );
                process.exitCode = 1;
                return;
              }
              const connector = createNotionConnector();
              const state = await readConnectorState(
                orchestrator.config.memoryDir,
                name,
              );
              // runConnectorPollOnce enforces: ingest docs BEFORE advancing the
              // cursor (CLAUDE.md gotcha #25 + #43).  Same guarantee as the
              // Drive block above — if ingestFn throws, old cursor is kept.
              runResult = await runConnectorPollOnce({
                connectorId: name,
                priorState: state,
                syncFn: (cursor) =>
                  connector.syncIncremental({
                    cursor,
                    // NotionConnectorConfig is narrower than ConnectorConfig (no
                    // index signature) but is structurally compatible at runtime.
                    // Double-cast via unknown to satisfy the interface boundary.
                    config: validatedCfg as unknown as Record<string, unknown>,
                  }),
                ingestFn: sharedIngestFn,
                writeCursorFn: makeWriteCursorFn(name),
              });
            } else {
              process.stderr.write(
                `connectors run: unknown connector "${name}". Known connectors: ${GOOGLE_DRIVE_CONNECTOR_ID}, ${NOTION_CONNECTOR_ID}.\n`,
              );
              process.exitCode = 1;
              return;
            }

            const exitCode = emitConnectorsRunCliResult({
              connectorId: name,
              result: runResult,
              format,
            });
            if (exitCode !== 0) process.exitCode = exitCode;
          });
      }

      cmd
        .command("benchmark-validate")
        .description("Validate a benchmark manifest file or pack directory without importing it")
        .argument("<path>", "Path to a benchmark manifest JSON file or a directory with manifest.json")
        .action(async (...args: unknown[]) => {
          const inputPath = args[0];
          const summary = await runBenchmarkValidateCliCommand({
            path: typeof inputPath === "string" ? inputPath : "",
            memoryRedTeamBenchEnabled: orchestrator.config.memoryRedTeamBenchEnabled,
          });
          console.log(JSON.stringify(summary, null, 2));
          console.log("OK");
        });

      cmd
        .command("benchmark-baseline-snapshot")
        .description("Capture a versioned baseline snapshot of the latest completed benchmark runs")
        .requiredOption("--snapshot-id <id>", "Stable snapshot identifier")
        .option("--created-at <iso>", "Override snapshot creation timestamp")
        .option("--git-ref <ref>", "Override the git ref recorded in the snapshot")
        .option("--notes <text>", "Optional operator notes for the snapshot")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const summary = await runBenchmarkBaselineSnapshotCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            evalStoreDir: orchestrator.config.evalStoreDir,
            benchmarkBaselineSnapshotsEnabled: orchestrator.config.benchmarkBaselineSnapshotsEnabled,
            snapshotId: typeof options.snapshotId === "string" ? options.snapshotId : "",
            createdAt: typeof options.createdAt === "string" ? options.createdAt : undefined,
            gitRef: typeof options.gitRef === "string" ? options.gitRef : undefined,
            notes: typeof options.notes === "string" ? options.notes : undefined,
          });
          console.log(JSON.stringify(summary, null, 2));
          console.log("OK");
        });

      cmd
        .command("benchmark-import")
        .description("Validate and import a benchmark manifest file or pack directory into Engram's eval store")
        .argument("<path>", "Path to a benchmark manifest JSON file or a directory with manifest.json")
        .option("--force", "Replace an existing imported benchmark pack with the same benchmarkId")
        .action(async (...args: unknown[]) => {
          const inputPath = args[0];
          const options = (args[1] ?? {}) as Record<string, unknown>;
          const summary = await runBenchmarkImportCliCommand({
            path: typeof inputPath === "string" ? inputPath : "",
            memoryDir: orchestrator.config.memoryDir,
            evalStoreDir: orchestrator.config.evalStoreDir,
            force: options.force === true,
            memoryRedTeamBenchEnabled: orchestrator.config.memoryRedTeamBenchEnabled,
          });
          console.log(JSON.stringify(summary, null, 2));
          console.log("OK");
        });

      cmd
        .command("benchmark-ci-gate")
        .description("Compare two eval stores and fail when the candidate regresses benchmark outcomes")
        .requiredOption("--base <path>", "Path to the base eval store directory")
        .requiredOption("--candidate <path>", "Path to the candidate eval store directory")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const summary = await runBenchmarkCiGateCliCommand({
            baseEvalStoreDir: typeof options.base === "string" ? options.base : "",
            candidateEvalStoreDir: typeof options.candidate === "string" ? options.candidate : "",
          });
          console.log(JSON.stringify(summary, null, 2));
          if (!summary.passed) {
            throw new Error("benchmark CI gate detected regressions");
          }
          console.log("OK");
        });

      cmd
        .command("benchmark-baseline-report")
        .description("Compare the current eval store against a named stored benchmark baseline snapshot")
        .requiredOption("--snapshot-id <id>", "Stable baseline snapshot identifier")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const summary = await runBenchmarkBaselineReportCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            evalStoreDir: orchestrator.config.evalStoreDir,
            benchmarkDeltaReporterEnabled: orchestrator.config.benchmarkDeltaReporterEnabled,
            snapshotId: typeof options.snapshotId === "string" ? options.snapshotId : "",
          });
          const { markdownReport, ...jsonSummary } = summary;
          console.log(JSON.stringify(jsonSummary, null, 2));
          console.log(markdownReport);
          if (!summary.passed) {
            throw new Error("benchmark baseline report detected regressions");
          }
          console.log("OK");
        });

      cmd
        .command("objective-state-status")
        .description("Show objective-state store status, snapshot counts, and latest stored snapshot")
        .action(async () => {
          const status = await runObjectiveStateStatusCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            objectiveStateStoreDir: orchestrator.config.objectiveStateStoreDir,
            objectiveStateMemoryEnabled: orchestrator.config.objectiveStateMemoryEnabled,
            objectiveStateSnapshotWritesEnabled: orchestrator.config.objectiveStateSnapshotWritesEnabled,
          });
          console.log(JSON.stringify(status, null, 2));
          console.log("OK");
        });

      cmd
        .command("causal-trajectory-status")
        .description("Show causal-trajectory store status, record counts, and latest stored chain")
        .action(async () => {
          const status = await runCausalTrajectoryStatusCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            causalTrajectoryStoreDir: orchestrator.config.causalTrajectoryStoreDir,
            causalTrajectoryMemoryEnabled: orchestrator.config.causalTrajectoryMemoryEnabled,
          });
          console.log(JSON.stringify(status, null, 2));
          console.log("OK");
        });

      cmd
        .command("trust-zone-status")
        .description("Show trust-zone store status, zoned record counts, and latest stored record")
        .action(async () => {
          const status = await runTrustZoneStatusCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            trustZoneStoreDir: orchestrator.config.trustZoneStoreDir,
            trustZonesEnabled: orchestrator.config.trustZonesEnabled,
            quarantinePromotionEnabled: orchestrator.config.quarantinePromotionEnabled,
            memoryPoisoningDefenseEnabled: orchestrator.config.memoryPoisoningDefenseEnabled,
          });
          console.log(JSON.stringify(status, null, 2));
          console.log("OK");
        });

      cmd
        .command("trust-zone-demo-seed")
        .description("Explicitly seed an opt-in trust-zone demo dataset for buyer-facing walkthroughs")
        .option("--scenario <scenario>", "Demo scenario id (default: enterprise-buyer-v1)")
        .option("--recorded-at <isoTimestamp>", "Base ISO timestamp used to anchor demo records")
        .option("--dry-run", "Preview the demo dataset without writing any trust-zone records")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const result = await runTrustZoneDemoSeedCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            trustZoneStoreDir: orchestrator.config.trustZoneStoreDir,
            trustZonesEnabled: orchestrator.config.trustZonesEnabled,
            scenario: typeof options.scenario === "string" ? options.scenario : undefined,
            recordedAt: typeof options.recordedAt === "string" ? options.recordedAt : undefined,
            dryRun: options.dryRun === true,
          });
          console.log(JSON.stringify(result, null, 2));
          console.log("OK");
        });

      cmd
        .command("abstraction-node-status")
        .description("Show abstraction-node store status, abstraction counts, and latest stored node")
        .action(async () => {
          const status = await runAbstractionNodeStatusCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            abstractionNodeStoreDir: orchestrator.config.abstractionNodeStoreDir,
            harmonicRetrievalEnabled: orchestrator.config.harmonicRetrievalEnabled,
            abstractionAnchorsEnabled: orchestrator.config.abstractionAnchorsEnabled,
          });
          console.log(JSON.stringify(status, null, 2));
          console.log("OK");
        });

      cmd
        .command("cue-anchor-status")
        .description("Show cue-anchor index status, anchor counts, and the latest stored cue anchor")
        .action(async () => {
          const status = await runCueAnchorStatusCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            abstractionNodeStoreDir: orchestrator.config.abstractionNodeStoreDir,
            harmonicRetrievalEnabled: orchestrator.config.harmonicRetrievalEnabled,
            abstractionAnchorsEnabled: orchestrator.config.abstractionAnchorsEnabled,
          });
          console.log(JSON.stringify(status, null, 2));
          console.log("OK");
        });

      cmd
        .command("harmonic-search")
        .description("Preview harmonic retrieval blending over abstraction nodes and cue anchors")
        .argument("<query>", "Prompt-like query to evaluate against harmonic retrieval storage")
        .option("--max-results <count>", "Maximum number of blended results to return", "3")
        .option("--session-key <sessionKey>", "Optional session key for same-session tie-breaking")
        .action(async (...args: unknown[]) => {
          const query = typeof args[0] === "string" ? args[0] : "";
          const options = (args[1] ?? {}) as Record<string, unknown>;
          const maxResults = typeof options.maxResults === "string"
            ? Number.parseInt(options.maxResults, 10)
            : 3;
          const results = await runHarmonicSearchCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            abstractionNodeStoreDir: orchestrator.config.abstractionNodeStoreDir,
            harmonicRetrievalEnabled: orchestrator.config.harmonicRetrievalEnabled,
            abstractionAnchorsEnabled: orchestrator.config.abstractionAnchorsEnabled,
            query,
            maxResults: Number.isFinite(maxResults) ? maxResults : 3,
            sessionKey: typeof options.sessionKey === "string" ? options.sessionKey : undefined,
          });
          console.log(JSON.stringify(results, null, 2));
          console.log("OK");
        });

      cmd
        .command("utility-status")
        .description("Show utility-learning telemetry status, event counts, and the latest utility event")
        .action(async () => {
          const status = await runUtilityTelemetryStatusCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            memoryUtilityLearningEnabled: orchestrator.config.memoryUtilityLearningEnabled,
            promotionByOutcomeEnabled: orchestrator.config.promotionByOutcomeEnabled,
          });
          console.log(JSON.stringify(status, null, 2));
          console.log("OK");
        });

      cmd
        .command("utility-record")
        .description("Record a utility-learning telemetry event when utility learning is enabled")
        .requiredOption("--event-id <eventId>", "Utility telemetry event id")
        .requiredOption("--recorded-at <recordedAt>", "ISO timestamp for the event")
        .requiredOption("--session-key <sessionKey>", "Session key associated with the event")
        .requiredOption("--source <source>", "Event source (cli|system|benchmark|tool_result)")
        .requiredOption("--target <target>", "Telemetry target (promotion|ranking)")
        .requiredOption("--decision <decision>", "Decision taken (promote|demote|hold|boost|suppress)")
        .requiredOption("--outcome <outcome>", "Observed outcome (helpful|neutral|harmful)")
        .requiredOption("--utility-score <utilityScore>", "Bounded utility score between -1 and 1")
        .requiredOption("--summary <summary>", "Human-readable summary of the measured utility event")
        .option("--memory-id <memoryId...>", "Memory ids linked to the utility event")
        .option("--entity-ref <entityRef...>", "Entity refs linked to the utility event")
        .option("--tag <tag...>", "Tags to attach to the utility event")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const utilityScore = typeof options.utilityScore === "string"
            ? Number.parseFloat(options.utilityScore)
            : Number.NaN;
          const filePath = await runUtilityTelemetryRecordCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            memoryUtilityLearningEnabled: orchestrator.config.memoryUtilityLearningEnabled,
            event: {
              schemaVersion: 1,
              eventId: String(options.eventId ?? ""),
              recordedAt: String(options.recordedAt ?? ""),
              sessionKey: String(options.sessionKey ?? ""),
              source: String(options.source ?? "") as UtilityTelemetryEvent["source"],
              target: String(options.target ?? "") as UtilityTelemetryEvent["target"],
              decision: String(options.decision ?? "") as UtilityTelemetryEvent["decision"],
              outcome: String(options.outcome ?? "") as UtilityTelemetryEvent["outcome"],
              utilityScore,
              summary: String(options.summary ?? ""),
              memoryIds: Array.isArray(options.memoryId) ? options.memoryId.map(String) : undefined,
              entityRefs: Array.isArray(options.entityRef) ? options.entityRef.map(String) : undefined,
              tags: Array.isArray(options.tag) ? options.tag.map(String) : undefined,
            },
          });
          console.log(JSON.stringify({ wrote: filePath !== null, filePath }, null, 2));
          console.log("OK");
        });

      cmd
        .command("utility-learning-status")
        .description("Show offline utility-learning snapshot status and learned weight counts")
        .action(async () => {
          const status = await runUtilityLearningStatusCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            memoryUtilityLearningEnabled: orchestrator.config.memoryUtilityLearningEnabled,
            promotionByOutcomeEnabled: orchestrator.config.promotionByOutcomeEnabled,
          });
          console.log(JSON.stringify(status, null, 2));
          console.log("OK");
        });

      cmd
        .command("utility-learn")
        .description("Learn bounded offline promotion/ranking weights from recorded utility telemetry")
        .option("--window-days <days>", "Telemetry lookback window in days", "14")
        .option("--min-event-count <count>", "Minimum event count required per target/decision group", "3")
        .option("--max-weight-magnitude <value>", "Maximum absolute learned weight magnitude", "0.35")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const learningWindowDays = typeof options.windowDays === "string"
            ? Number.parseInt(options.windowDays, 10)
            : 14;
          const minEventCount = typeof options.minEventCount === "string"
            ? Number.parseInt(options.minEventCount, 10)
            : 3;
          const maxWeightMagnitude = typeof options.maxWeightMagnitude === "string"
            ? Number.parseFloat(options.maxWeightMagnitude)
            : 0.35;
          const result = await runUtilityLearningCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            memoryUtilityLearningEnabled: orchestrator.config.memoryUtilityLearningEnabled,
            learningWindowDays,
            minEventCount,
            maxWeightMagnitude,
          });
          console.log(JSON.stringify(result, null, 2));
          console.log("OK");
        });

      cmd
        .command("resume-bundle-status")
        .description("Show resume bundle status, bundle counts, and the latest recorded handoff bundle")
        .action(async () => {
          const status = await runResumeBundleStatusCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            resumeBundleDir: orchestrator.config.resumeBundleDir,
            creationMemoryEnabled: orchestrator.config.creationMemoryEnabled,
            resumeBundlesEnabled: orchestrator.config.resumeBundlesEnabled,
          });
          console.log(JSON.stringify(status, null, 2));
          console.log("OK");
        });

      cmd
        .command("resume-bundle-record")
        .description("Record an explicit resume bundle when creation-memory handoff bundles are enabled")
        .requiredOption("--bundle-id <bundleId>", "Resume bundle id")
        .requiredOption("--recorded-at <recordedAt>", "ISO timestamp for the bundle")
        .requiredOption("--session-key <sessionKey>", "Session key that owns the bundle")
        .requiredOption("--source <source>", "Bundle source (tool_result|cli|system|manual)")
        .requiredOption("--scope <scope>", "Primary scope or recovery domain for the bundle")
        .requiredOption("--summary <summary>", "Human-readable summary of what this bundle preserves")
        .option("--key-fact <keyFact...>", "Short facts that a resumed agent should retain")
        .option("--next-action <nextAction...>", "Explicit next actions for the resumed agent")
        .option("--risk-flag <riskFlag...>", "Open risks or cautions attached to the bundle")
        .option(
          "--objective-state-snapshot-ref <objectiveStateSnapshotRef...>",
          "Objective-state snapshot refs attached to the bundle",
        )
        .option(
          "--work-product-entry-ref <workProductEntryRef...>",
          "Work-product ledger refs attached to the bundle",
        )
        .option(
          "--commitment-entry-ref <commitmentEntryRef...>",
          "Commitment ledger refs attached to the bundle",
        )
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const filePath = await runResumeBundleRecordCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            resumeBundleDir: orchestrator.config.resumeBundleDir,
            creationMemoryEnabled: orchestrator.config.creationMemoryEnabled,
            resumeBundlesEnabled: orchestrator.config.resumeBundlesEnabled,
            bundle: {
              schemaVersion: 1,
              bundleId: String(options.bundleId ?? ""),
              recordedAt: String(options.recordedAt ?? ""),
              sessionKey: String(options.sessionKey ?? ""),
              source: String(options.source ?? "") as ResumeBundle["source"],
              scope: String(options.scope ?? ""),
              summary: String(options.summary ?? ""),
              keyFacts: Array.isArray(options.keyFact) ? options.keyFact.map(String) : undefined,
              nextActions: Array.isArray(options.nextAction) ? options.nextAction.map(String) : undefined,
              riskFlags: Array.isArray(options.riskFlag) ? options.riskFlag.map(String) : undefined,
              objectiveStateSnapshotRefs: Array.isArray(options.objectiveStateSnapshotRef)
                ? options.objectiveStateSnapshotRef.map(String)
                : undefined,
              workProductEntryRefs: Array.isArray(options.workProductEntryRef)
                ? options.workProductEntryRef.map(String)
                : undefined,
              commitmentEntryRefs: Array.isArray(options.commitmentEntryRef)
                ? options.commitmentEntryRef.map(String)
                : undefined,
            },
          });
          console.log(JSON.stringify({ wrote: filePath !== null, filePath }, null, 2));
          console.log("OK");
        });

      cmd
        .command("resume-bundle-build")
        .description("Build and persist a resume bundle from transcript recovery, objective state, work products, and open commitments")
        .requiredOption("--bundle-id <bundleId>", "Resume bundle id")
        .requiredOption("--recorded-at <recordedAt>", "ISO timestamp for the bundle")
        .requiredOption("--session-key <sessionKey>", "Session key that owns the bundle")
        .requiredOption("--scope <scope>", "Primary scope or recovery domain for the bundle")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const built = await runResumeBundleBuildCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            resumeBundleDir: orchestrator.config.resumeBundleDir,
            objectiveStateStoreDir: orchestrator.config.objectiveStateStoreDir,
            workProductLedgerDir: orchestrator.config.workProductLedgerDir,
            commitmentLedgerDir: orchestrator.config.commitmentLedgerDir,
            creationMemoryEnabled: orchestrator.config.creationMemoryEnabled,
            resumeBundlesEnabled: orchestrator.config.resumeBundlesEnabled,
            transcriptEnabled: orchestrator.config.transcriptEnabled,
            objectiveStateMemoryEnabled: orchestrator.config.objectiveStateMemoryEnabled,
            commitmentLedgerEnabled: orchestrator.config.commitmentLedgerEnabled,
            bundleId: String(options.bundleId ?? ""),
            recordedAt: String(options.recordedAt ?? ""),
            sessionKey: String(options.sessionKey ?? ""),
            scope: String(options.scope ?? ""),
          });
          console.log(JSON.stringify({
            wrote: built !== null,
            filePath: built?.filePath ?? null,
            bundle: built?.bundle ?? null,
          }, null, 2));
          console.log("OK");
        });

      cmd
        .command("commitment-status")
        .description("Show commitment ledger status, entry counts, and the latest recorded commitment")
        .action(async () => {
          const status = await runCommitmentStatusCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            commitmentLedgerDir: orchestrator.config.commitmentLedgerDir,
            creationMemoryEnabled: orchestrator.config.creationMemoryEnabled,
            commitmentLedgerEnabled: orchestrator.config.commitmentLedgerEnabled,
            commitmentLifecycleEnabled: orchestrator.config.commitmentLifecycleEnabled,
            commitmentStaleDays: orchestrator.config.commitmentStaleDays,
            commitmentDecayDays: orchestrator.config.commitmentDecayDays,
          });
          console.log(JSON.stringify(status, null, 2));
          console.log("OK");
        });

      cmd
        .command("commitment-record")
        .description("Record a commitment ledger entry when commitment memory is enabled")
        .requiredOption("--entry-id <entryId>", "Commitment entry id")
        .requiredOption("--recorded-at <recordedAt>", "ISO timestamp for the entry")
        .requiredOption("--session-key <sessionKey>", "Session key that owns the commitment")
        .requiredOption("--source <source>", "Entry source (tool_result|cli|system|manual)")
        .requiredOption("--kind <kind>", "Entry kind (promise|follow_up|deadline|deliverable)")
        .requiredOption("--state <state>", "Entry state (open|fulfilled|cancelled|expired)")
        .requiredOption("--scope <scope>", "Primary scope or identifier for the commitment")
        .requiredOption("--summary <summary>", "Human-readable summary of the commitment")
        .option("--due-at <dueAt>", "Optional due timestamp for the commitment")
        .option("--tag <tag...>", "Tags to attach to the commitment entry")
        .option("--entity-ref <entityRef...>", "Entity refs to attach to the commitment entry")
        .option(
          "--work-product-entry-ref <workProductEntryRef...>",
          "Work-product ledger refs that this commitment depends on",
        )
        .option(
          "--objective-state-snapshot-ref <objectiveStateSnapshotRef...>",
          "Objective-state snapshot refs to link to this commitment",
        )
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const filePath = await runCommitmentRecordCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            commitmentLedgerDir: orchestrator.config.commitmentLedgerDir,
            creationMemoryEnabled: orchestrator.config.creationMemoryEnabled,
            commitmentLedgerEnabled: orchestrator.config.commitmentLedgerEnabled,
            entry: {
              schemaVersion: 1,
              entryId: String(options.entryId ?? ""),
              recordedAt: String(options.recordedAt ?? ""),
              sessionKey: String(options.sessionKey ?? ""),
              source: String(options.source ?? "") as CommitmentLedgerEntry["source"],
              kind: String(options.kind ?? "") as CommitmentLedgerEntry["kind"],
              state: String(options.state ?? "") as CommitmentLedgerEntry["state"],
              scope: String(options.scope ?? ""),
              summary: String(options.summary ?? ""),
              dueAt: typeof options.dueAt === "string" ? options.dueAt : undefined,
              tags: Array.isArray(options.tag) ? options.tag.map(String) : undefined,
              entityRefs: Array.isArray(options.entityRef) ? options.entityRef.map(String) : undefined,
              workProductEntryRefs: Array.isArray(options.workProductEntryRef)
                ? options.workProductEntryRef.map(String)
                : undefined,
              objectiveStateSnapshotRefs: Array.isArray(options.objectiveStateSnapshotRef)
                ? options.objectiveStateSnapshotRef.map(String)
                : undefined,
            },
          });
          console.log(JSON.stringify({ wrote: filePath !== null, filePath }, null, 2));
          console.log("OK");
        });

      cmd
        .command("commitment-set-state")
        .description("Transition an existing commitment ledger entry when commitment lifecycle is enabled")
        .requiredOption("--entry-id <entryId>", "Commitment entry id")
        .requiredOption("--state <state>", "Next state (open|fulfilled|cancelled|expired)")
        .requiredOption("--changed-at <changedAt>", "ISO timestamp for the lifecycle transition")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const entry = await runCommitmentSetStateCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            commitmentLedgerDir: orchestrator.config.commitmentLedgerDir,
            creationMemoryEnabled: orchestrator.config.creationMemoryEnabled,
            commitmentLedgerEnabled: orchestrator.config.commitmentLedgerEnabled,
            commitmentLifecycleEnabled: orchestrator.config.commitmentLifecycleEnabled,
            entryId: String(options.entryId ?? ""),
            nextState: String(options.state ?? "") as CommitmentLedgerEntry["state"],
            changedAt: String(options.changedAt ?? ""),
          });
          console.log(JSON.stringify({ updated: entry !== null, entry }, null, 2));
          console.log("OK");
        });

      cmd
        .command("commitment-lifecycle-run")
        .description("Apply overdue-expiry and resolved-entry cleanup to the commitment ledger")
        .option("--now <now>", "Override the lifecycle timestamp for testing or backfills")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const result = await runCommitmentLifecycleCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            commitmentLedgerDir: orchestrator.config.commitmentLedgerDir,
            creationMemoryEnabled: orchestrator.config.creationMemoryEnabled,
            commitmentLedgerEnabled: orchestrator.config.commitmentLedgerEnabled,
            commitmentLifecycleEnabled: orchestrator.config.commitmentLifecycleEnabled,
            commitmentDecayDays: orchestrator.config.commitmentDecayDays,
            now: typeof options.now === "string" ? options.now : undefined,
          });
          console.log(JSON.stringify({ applied: result !== null, result }, null, 2));
          console.log("OK");
        });

      cmd
        .command("work-product-status")
        .description("Show work-product ledger status, entry counts, and the latest recorded work product")
        .action(async () => {
          const status = await runWorkProductStatusCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            workProductLedgerDir: orchestrator.config.workProductLedgerDir,
            creationMemoryEnabled: orchestrator.config.creationMemoryEnabled,
          });
          console.log(JSON.stringify(status, null, 2));
          console.log("OK");
        });

      cmd
        .command("work-product-record")
        .description("Record a work-product ledger entry when creation-memory is enabled")
        .requiredOption("--entry-id <entryId>", "Ledger entry id")
        .requiredOption("--recorded-at <recordedAt>", "ISO timestamp for the entry")
        .requiredOption("--session-key <sessionKey>", "Session key that created the work product")
        .requiredOption("--source <source>", "Entry source (tool_result|cli|system|manual)")
        .requiredOption("--kind <kind>", "Entry kind (artifact|file|record|report|workspace)")
        .requiredOption(
          "--entry-action <entryAction>",
          "Entry action (created|updated|deleted|referenced|published)",
        )
        .requiredOption("--scope <scope>", "Primary scope or identifier for the created work product")
        .requiredOption("--summary <summary>", "Human-readable summary of the work product")
        .option("--artifact-path <artifactPath>", "Optional path to the created artifact")
        .option("--tag <tag...>", "Tags to attach to the work-product entry")
        .option("--entity-ref <entityRef...>", "Entity refs to attach to the work-product entry")
        .option(
          "--objective-state-snapshot-ref <objectiveStateSnapshotRef...>",
          "Objective-state snapshot refs to link to this work product",
        )
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const filePath = await runWorkProductRecordCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            workProductLedgerDir: orchestrator.config.workProductLedgerDir,
            creationMemoryEnabled: orchestrator.config.creationMemoryEnabled,
            entry: {
              schemaVersion: 1,
              entryId: String(options.entryId ?? ""),
              recordedAt: String(options.recordedAt ?? ""),
              sessionKey: String(options.sessionKey ?? ""),
              source: String(options.source ?? "") as WorkProductLedgerEntry["source"],
              kind: String(options.kind ?? "") as WorkProductLedgerEntry["kind"],
              action: String(options.entryAction ?? "") as WorkProductLedgerEntry["action"],
              scope: String(options.scope ?? ""),
              summary: String(options.summary ?? ""),
              artifactPath: typeof options.artifactPath === "string" ? options.artifactPath : undefined,
              tags: Array.isArray(options.tag) ? options.tag.map(String) : undefined,
              entityRefs: Array.isArray(options.entityRef) ? options.entityRef.map(String) : undefined,
              objectiveStateSnapshotRefs: Array.isArray(options.objectiveStateSnapshotRef)
                ? options.objectiveStateSnapshotRef.map(String)
                : undefined,
            },
          });
          console.log(JSON.stringify({ wrote: filePath !== null, filePath }, null, 2));
          console.log("OK");
        });

      cmd
        .command("work-product-recall-search")
        .description("Preview work-product recovery candidates when creation-memory recall is enabled")
        .argument("<query>", "Prompt-like query to evaluate against the work-product ledger")
        .option("--max-results <count>", "Maximum number of work-product results to return", "3")
        .option("--session-key <sessionKey>", "Optional session key to boost same-session work products")
        .action(async (...args: unknown[]) => {
          const query = typeof args[0] === "string" ? args[0] : "";
          const options = (args[1] ?? {}) as Record<string, unknown>;
          const maxResults = typeof options.maxResults === "string"
            ? Number.parseInt(options.maxResults, 10)
            : 3;
          const results = await runWorkProductRecallSearchCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            workProductLedgerDir: orchestrator.config.workProductLedgerDir,
            creationMemoryEnabled: orchestrator.config.creationMemoryEnabled,
            workProductRecallEnabled: orchestrator.config.workProductRecallEnabled,
            query,
            maxResults: Number.isFinite(maxResults) ? maxResults : 3,
            sessionKey: typeof options.sessionKey === "string" ? options.sessionKey : undefined,
          });
          console.log(JSON.stringify(results, null, 2));
          console.log("OK");
        });

      cmd
        .command("trust-zone-promote")
        .description("Dry-run or apply a trust-zone promotion with provenance enforcement")
        .requiredOption("--record-id <recordId>", "Source trust-zone record id")
        .requiredOption("--target-zone <targetZone>", "Promotion target zone (working|trusted)")
        .requiredOption("--reason <reason>", "Human-readable promotion reason")
        .option("--recorded-at <isoTimestamp>", "Promotion timestamp (defaults to now)")
        .option("--summary <summary>", "Optional replacement summary for the promoted record")
        .option("--dry-run", "Show the promotion plan without writing the promoted record")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const result = await runTrustZonePromoteCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            trustZoneStoreDir: orchestrator.config.trustZoneStoreDir,
            trustZonesEnabled: orchestrator.config.trustZonesEnabled,
            quarantinePromotionEnabled: orchestrator.config.quarantinePromotionEnabled,
            memoryPoisoningDefenseEnabled: orchestrator.config.memoryPoisoningDefenseEnabled,
            sourceRecordId: String(options.recordId ?? ""),
            targetZone: String(options.targetZone ?? "") as TrustZoneName,
            promotionReason: String(options.reason ?? ""),
            recordedAt: typeof options.recordedAt === "string" ? options.recordedAt : undefined,
            summary: typeof options.summary === "string" ? options.summary : undefined,
            dryRun: options.dryRun === true,
          });
          console.log(JSON.stringify(result, null, 2));
          console.log("OK");
        });

      cmd
        .command("verified-recall-search")
        .description("Preview verified episodic recall over recent memory boxes")
        .argument("<query>", "Prompt-like query to evaluate against verified episodic recall")
        .option("--max-results <count>", "Maximum number of verified episodic results to return", "3")
        .action(async (...args: unknown[]) => {
          const query = typeof args[0] === "string" ? args[0] : "";
          const options = (args[1] ?? {}) as Record<string, unknown>;
          const maxResults = typeof options.maxResults === "string"
            ? Number.parseInt(options.maxResults, 10)
            : 3;
          const results = await runVerifiedRecallSearchCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            verifiedRecallEnabled: orchestrator.config.verifiedRecallEnabled,
            query,
            maxResults: Number.isFinite(maxResults) ? maxResults : 3,
            boxRecallDays: orchestrator.config.boxRecallDays,
          });
          console.log(JSON.stringify(results, null, 2));
          console.log("OK");
        });

      cmd
        .command("semantic-rule-promote")
        .description("Promote an explicit IF/THEN rule from a verified episodic memory")
        .requiredOption("--memory-id <memoryId>", "Verified episodic memory id to promote from")
        .option("--dry-run", "Preview the promoted semantic rule without writing it")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const result = await runSemanticRulePromoteCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            semanticRulePromotionEnabled: orchestrator.config.semanticRulePromotionEnabled,
            sourceMemoryId: String(options.memoryId ?? ""),
            dryRun: options.dryRun === true,
          });
          console.log(JSON.stringify(result, null, 2));
          console.log("OK");
        });

      cmd
        .command("compounding-promote")
        .description("Promote an advisory compounding candidate into a durable rule/principle memory")
        .requiredOption("--week-id <weekId>", "Weekly compounding artifact id (YYYY-Www)")
        .requiredOption("--candidate-id <candidateId>", "Promotion candidate id from weekly compounding JSON/report")
        .option("--dry-run", "Preview the promoted guidance without writing it")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const result = await runCompoundingPromoteCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            compoundingEnabled: orchestrator.config.compoundingEnabled,
            compoundingSemanticEnabled: orchestrator.config.compoundingSemanticEnabled,
            weekId: String(options.weekId ?? ""),
            candidateId: String(options.candidateId ?? ""),
            dryRun: options.dryRun === true,
          });
          console.log(JSON.stringify(result, null, 2));
          console.log("OK");
        });

      cmd
        .command("semantic-rule-verify")
        .description("Preview verified semantic-rule recall with provenance-aware confidence downgrades")
        .argument("<query>", "Prompt-like query to evaluate against verified semantic-rule recall")
        .option("--max-results <count>", "Maximum number of verified semantic rules to return", "3")
        .action(async (...args: unknown[]) => {
          const query = typeof args[0] === "string" ? args[0] : "";
          const options = (args[1] ?? {}) as Record<string, unknown>;
          const maxResults = typeof options.maxResults === "string"
            ? Number.parseInt(options.maxResults, 10)
            : 3;
          const results = await runSemanticRuleVerifyCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            semanticRuleVerificationEnabled: orchestrator.config.semanticRuleVerificationEnabled,
            query,
            maxResults: Number.isFinite(maxResults) ? maxResults : 3,
          });
          console.log(JSON.stringify(results, null, 2));
          console.log("OK");
        });

      cmd
        .command("conversation-index-health")
        .description("Show conversation index backend health and index stats")
        .action(async () => {
          const health = await runConversationIndexHealthCliCommand(orchestrator);
          console.log(JSON.stringify(health, null, 2));
          console.log("OK");
        });

      cmd
        .command("conversation-index-inspect")
        .description("Inspect conversation index backend metadata and artifact state")
        .action(async () => {
          const inspection = await runConversationIndexInspectCliCommand(orchestrator);
          console.log(JSON.stringify(inspection, null, 2));
          console.log("OK");
        });

      cmd
        .command("conversation-index-rebuild")
        .description("Rebuild the conversation index backend from transcript history")
        .option("--session-key <sessionKey>", "Optional session key to rebuild instead of all recent transcripts")
        .option("--hours <count>", "Hours of transcript history to scan", "24")
        .option("--embed", "Force embedding step for backends that support it")
        .action(buildConversationIndexRebuildAction(orchestrator));

      cmd
        .command("rebuild-index")
        .description("Alias for conversation-index-rebuild with operator-friendly naming")
        .option("--session-key <sessionKey>", "Optional session key to rebuild instead of all recent transcripts")
        .option("--hours <count>", "Hours of transcript history to scan", "24")
        .option("--embed", "Force embedding step for backends that support it")
        .action(buildConversationIndexRebuildAction(orchestrator));

      cmd
        .command("graph-health")
        .description("Show graph edge-file integrity, node coverage, and corruption counts")
        .option("--repair-guidance", "Include non-destructive repair guidance")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const report = await runGraphHealthCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            entityGraphEnabled: orchestrator.config.entityGraphEnabled,
            timeGraphEnabled: orchestrator.config.timeGraphEnabled,
            causalGraphEnabled: orchestrator.config.causalGraphEnabled,
            includeRepairGuidance: options.repairGuidance === true,
          });
          console.log(JSON.stringify(report, null, 2));
          console.log("OK");
        });

      cmd
        .command("session-check")
        .description("Analyze transcript/checkpoint continuity integrity without mutating files")
        .action(async () => {
          const report = await runSessionCheckCliCommand({
            memoryDir: orchestrator.config.memoryDir,
          });
          console.log(JSON.stringify(report, null, 2));
          console.log("OK");
        });

      cmd
        .command("session-repair")
        .description("Generate/apply bounded Engram session integrity repairs (dry-run by default)")
        .option("--apply", "Apply repairs (default: dry-run)")
        .option("--dry-run", "Force dry-run output")
        .option("--allow-session-file-repair", "Allow explicit OpenClaw session-file repair path (still no automatic rewiring)")
        .option("--session-files-dir <path>", "Optional OpenClaw session files directory for guarded repair workflow")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const result = await runSessionRepairCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            apply: options.apply === true,
            dryRun: options.dryRun === true,
            allowSessionFileRepair: options.allowSessionFileRepair === true,
            sessionFilesDir:
              typeof options.sessionFilesDir === "string" && options.sessionFilesDir.trim().length > 0
                ? options.sessionFilesDir.trim()
                : undefined,
          });
          console.log(JSON.stringify(result, null, 2));
          console.log("OK");
        });

      cmd
        .command("repair")
        .description("Aggregate safe repair planning across session integrity and graph health")
        .option("--apply", "Apply bounded Engram-managed session repairs")
        .option("--dry-run", "Force dry-run output")
        .option("--allow-session-file-repair", "Allow explicit OpenClaw session-file repair path (still no automatic rewiring)")
        .option("--session-files-dir <path>", "Optional OpenClaw session files directory for guarded repair workflow")
        .option("--json", "Emit machine-readable JSON only")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const report = await runOperatorRepair({
            config: {
              memoryDir: orchestrator.config.memoryDir,
              entityGraphEnabled: orchestrator.config.entityGraphEnabled,
              timeGraphEnabled: orchestrator.config.timeGraphEnabled,
              causalGraphEnabled: orchestrator.config.causalGraphEnabled,
            },
            apply: options.apply === true,
            dryRun: options.dryRun === true,
            allowSessionFileRepair: options.allowSessionFileRepair === true,
            sessionFilesDir:
              typeof options.sessionFilesDir === "string" && options.sessionFilesDir.trim().length > 0
                ? options.sessionFilesDir.trim()
                : undefined,
          });
          if (reportHasMachineReadableOutput(options)) {
            console.log(JSON.stringify(report, null, 2));
          } else {
            console.log(formatOperatorRepairCli(report));
          }
          if (!reportHasMachineReadableOutput(options)) console.log("OK");
        });

      cmd
        .command("tier-status")
        .description("Show tier migration telemetry and last-cycle summary")
        .action(async () => {
          const status = await runTierStatusCliCommand(orchestrator);
          console.log(JSON.stringify(status, null, 2));
          console.log("OK");
        });

      cmd
        .command("tier-migrate")
        .description("Run one tier migration pass (dry-run by default)")
        .option("--dry-run", "Evaluate and report moves without writing")
        .option("--write", "Apply migration writes (default: dry-run)")
        .option("--limit <n>", "Override migration move limit for this run")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const limitRaw = parseInt(String(options.limit ?? ""), 10);
          const explicitDryRun = options.dryRun === true;
          const summary = await runTierMigrateCliCommand(orchestrator, {
            dryRun: explicitDryRun || options.write !== true,
            limit: Number.isFinite(limitRaw) ? Math.max(0, limitRaw) : undefined,
          });
          console.log(JSON.stringify(summary, null, 2));
          console.log("OK");
        });

      cmd
        .command("policy-status")
        .description("Show runtime behavior-loop policy status and top contributing signals")
        .action(async () => {
          const status = await runPolicyStatusCliCommand(orchestrator);
          console.log(JSON.stringify(status, null, 2));
          console.log("OK");
        });

      cmd
        .command("policy-diff")
        .description("Show runtime policy deltas and evidence since a relative duration (default: 7d)")
        .option("--since <window>", "Relative duration window like 30m, 12h, 7d", "7d")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const since = typeof options.since === "string" ? options.since : "7d";
          const report = await runPolicyDiffCliCommand(orchestrator, { since });
          console.log(JSON.stringify(report, null, 2));
          console.log("OK");
        });

      cmd
        .command("policy-rollback")
        .description("Roll back runtime behavior policy to the previous snapshot")
        .action(async () => {
          const report = await runPolicyRollbackCliCommand(orchestrator);
          console.log(JSON.stringify(report, null, 2));
          console.log("OK");
        });

      const migrateCmd = cmd
        .command("migrate")
        .description("Run memory migration helpers (dry-run by default)");

      migrateCmd
        .command("normalize-frontmatter")
        .description("Normalize memory frontmatter serialization")
        .option("--write", "Apply frontmatter rewrites (default: dry-run)")
        .option("--limit <n>", "Maximum memories to scan", "200")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const limitRaw = parseInt(String(options.limit ?? "200"), 10);
          const report = await runMigrateNormalizeFrontmatterCliCommand(orchestrator, {
            write: options.write === true,
            limit: Number.isFinite(limitRaw) ? limitRaw : 200,
          });
          console.log(JSON.stringify(report, null, 2));
          console.log("OK");
        });

      migrateCmd
        .command("rescore-importance")
        .description("Recompute memory importance scores using current local heuristics")
        .option("--write", "Apply frontmatter updates (default: dry-run)")
        .option("--limit <n>", "Maximum memories to scan", "200")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const limitRaw = parseInt(String(options.limit ?? "200"), 10);
          const report = await runMigrateRescoreImportanceCliCommand(orchestrator, {
            write: options.write === true,
            limit: Number.isFinite(limitRaw) ? limitRaw : 200,
          });
          console.log(JSON.stringify(report, null, 2));
          console.log("OK");
        });

      migrateCmd
        .command("rechunk")
        .description("Rebuild chunk files from current chunking heuristics")
        .option("--write", "Apply chunk rewrites (default: dry-run)")
        .option("--limit <n>", "Maximum parent memories to scan", "200")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const limitRaw = parseInt(String(options.limit ?? "200"), 10);
          const report = await runMigrateRechunkCliCommand(orchestrator, {
            write: options.write === true,
            limit: Number.isFinite(limitRaw) ? limitRaw : 200,
          });
          console.log(JSON.stringify(report, null, 2));
          console.log("OK");
        });

      migrateCmd
        .command("reextract")
        .description("Queue bounded memory re-extraction jobs for an explicit model")
        .option("--model <id>", "Model id used for re-extraction request")
        .option("--write", "Queue re-extraction jobs (default: dry-run)")
        .option("--limit <n>", "Maximum memories to queue", "100")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const model = typeof options.model === "string" ? options.model : "";
          const limitRaw = parseInt(String(options.limit ?? "100"), 10);
          const report = await runMigrateReextractCliCommand(orchestrator, {
            model,
            write: options.write === true,
            limit: Number.isFinite(limitRaw) ? limitRaw : 100,
          });
          console.log(JSON.stringify(report, null, 2));
          console.log("OK");
        });

      cmd
        .command("action-audit")
        .description("Show namespace-aware memory action policy outcomes")
        .option("--namespace <name>", "Filter to a single namespace")
        .option("--limit <n>", "Max events to read per namespace", "200")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const limitRaw = parseInt(String(options.limit ?? "200"), 10);
          const report = await runMemoryActionAuditCliCommand(orchestrator, {
            namespace:
              typeof options.namespace === "string" && options.namespace.trim().length > 0
                ? options.namespace.trim()
                : undefined,
            limit: Number.isFinite(limitRaw) ? Math.max(0, limitRaw) : 200,
          });
          console.log(JSON.stringify(report, null, 2));
          console.log("OK");
        });

      cmd
        .command("action-confidence")
        .description("Evaluate the read-only ask/draft/act/refuse/escalate advisory policy")
        .option("--action <text>", "Intended action being evaluated")
        .option("--confidence <0-1>", "Current confidence score")
        .option("--risk <level>", "Risk: low, medium, high, irreversible, restricted")
        .option("--context <state>", "Context readiness: none, partial, sufficient")
        .option("--rule <kinds>", "Comma-separated user rules: ask-before, do-not-use-outside-this-context, never, requires-escalation")
        .option("--current-scope <scopes>", "Comma-separated current context scopes")
        .option("--memory-scope <scopes>", "Comma-separated scopes on the supplied memory")
        .option("--stale", "Treat the supplied memory as stale")
        .option("--corrected", "Treat the supplied memory as corrected")
        .option("--unsafe", "Treat the supplied memory as blocked by safety metadata")
        .option("--json", "Emit machine-readable JSON")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          try {
            const result = evaluateActionConfidence(buildActionConfidenceInputFromOptions(options));
            if (options.json === true) {
              console.log(JSON.stringify(result, null, 2));
            } else {
              process.stdout.write(renderActionConfidenceText(result));
            }
          } catch (err) {
            console.error(`action-confidence: ${(err as Error).message}`);
            process.exitCode = 2;
          }
        });

      cmd
        .command("tailscale-status")
        .description("Show Tailscale availability and daemon status")
        .option("--timeout-ms <n>", "Command timeout in milliseconds", "10000")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const timeoutMsRaw = parseInt(String(options.timeoutMs ?? "10000"), 10);
          const status = await runTailscaleStatusCliCommand({
            timeoutMs: Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? timeoutMsRaw : 10_000,
          });
          console.log(JSON.stringify(status, null, 2));
          console.log("OK");
        });

      cmd
        .command("tailscale-sync")
        .description("Sync a local memory directory to a Tailscale destination using rsync")
        .option("--source-dir <path>", "Source directory to sync")
        .option("--destination <target>", "Rsync destination (for example host:/path)")
        .option("--delete", "Delete destination entries that do not exist in source")
        .option("--dry-run", "Show what would change without writing")
        .option("--extra-args <csv>", "Additional rsync args as comma-separated values")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const sourceDir = typeof options.sourceDir === "string" ? options.sourceDir.trim() : "";
          const destination = typeof options.destination === "string" ? options.destination.trim() : "";
          if (!sourceDir) {
            throw new Error("missing --source-dir");
          }
          if (!destination) {
            throw new Error("missing --destination");
          }
          const extraArgs = typeof options.extraArgs === "string"
            ? options.extraArgs
                .split(",")
                .map((value) => value.trim())
                .filter((value) => value.length > 0)
            : undefined;

          await runTailscaleSyncCliCommand({
            sourceDir,
            destination,
            delete: options.delete === true,
            dryRun: options.dryRun === true,
            extraArgs,
          });
          console.log("OK");
        });

      cmd
        .command("webdav-serve")
        .description("Start local WebDAV service for allowlisted directories")
        .option("--allowlist <csv>", "Comma-separated directories to expose")
        .option("--host <host>", "Bind host", "127.0.0.1")
        .option("--port <n>", "Bind port", "8080")
        .option("--username <username>", "Optional basic auth username")
        .option("--password <password>", "Optional basic auth password")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const allowlistRaw = typeof options.allowlist === "string" ? options.allowlist : "";
          const allowlistDirs = allowlistRaw
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0);
          if (allowlistDirs.length === 0) {
            throw new Error("missing --allowlist");
          }
          const portRaw = parseInt(String(options.port ?? "8080"), 10);
          const status = await runWebDavServeCliCommand({
            allowlistDirs,
            host: typeof options.host === "string" ? options.host : "127.0.0.1",
            port: Number.isFinite(portRaw) ? portRaw : 8080,
            authUsername: typeof options.username === "string" ? options.username : undefined,
            authPassword: typeof options.password === "string" ? options.password : undefined,
          });
          console.log(JSON.stringify(status, null, 2));
          console.log("OK");
        });

      cmd
        .command("webdav-stop")
        .description("Stop the in-process WebDAV service")
        .action(async () => {
          const result = await runWebDavStopCliCommand();
          console.log(JSON.stringify(result, null, 2));
          console.log("OK");
        });

      const dashboardCmd = cmd
        .command("dashboard")
        .description("Manage live graph dashboard service");

      dashboardCmd
        .command("start")
        .description("Start dashboard server (localhost by default)")
        .option("--host <host>", "Bind host", "127.0.0.1")
        .option("--port <n>", "Bind port", "4319")
        .option("--public-dir <path>", "Override static dashboard assets path")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const portRaw = parseInt(String(options.port ?? "4319"), 10);
          const status = await runDashboardStartCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            host: typeof options.host === "string" ? options.host : "127.0.0.1",
            port: Number.isFinite(portRaw) ? portRaw : 4319,
            publicDir: typeof options.publicDir === "string" ? options.publicDir : undefined,
          });
          console.log(JSON.stringify(status, null, 2));
          console.log("OK");
        });

      dashboardCmd
        .command("stop")
        .description("Stop dashboard server")
        .action(async () => {
          const result = await runDashboardStopCliCommand();
          console.log(JSON.stringify(result, null, 2));
          console.log("OK");
        });

      dashboardCmd
        .command("status")
        .description("Show dashboard server status")
        .action(async () => {
          const status = await runDashboardStatusCliCommand();
          console.log(JSON.stringify(status, null, 2));
          console.log("OK");
        });

      const accessService = new EngramAccessService(orchestrator);
      const accessCmd = cmd
        .command("access")
        .description("Manage Engram HTTP and MCP access surfaces");

      accessCmd
        .command("http-serve")
        .description("Start local authenticated HTTP access server")
        .option("--host <host>", "Bind host", "127.0.0.1")
        .option("--port <n>", "Bind port", "4318")
        .option("--token <token>", "Bearer token (defaults to config/env)")
        .option("--principal <principal>", "Trusted principal (defaults to config/env)")
        .option("--max-body-bytes <n>", "Maximum request body size", "131072")
        .option("--trust-principal-header", "Trust the X-Engram-Principal header for per-request principal resolution. Only enable when the server is behind a trusted proxy or when the auth token provides sufficient trust.")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const portRaw = parseInt(String(options.port ?? "4318"), 10);
          const maxBodyBytesRaw = parseInt(String(options.maxBodyBytes ?? "131072"), 10);
          // Start the HTTP server FIRST so the port is available immediately,
          // then initialize the orchestrator in the background.  Recall requests
          // that arrive during warmup still work — orchestrator.recall() awaits
          // its internal init gate (15s timeout) so callers get a correct (if
          // slightly delayed) response rather than "connection refused".
          // Resolve SecretRef authToken if config carries one (issue #757).
          // The CLI flag override (--token) wins; otherwise, resolve config.
          const cliTokenOverride =
            typeof options.token === "string" && options.token.trim().length > 0
              ? options.token
              : undefined;
          const resolveSecretRef =
            registerOptions.resolveSecretRef ??
            (registerOptions.loadResolveSecretRef
              ? await registerOptions.loadResolveSecretRef()
              : null);
          const resolvedConfigAuthToken = cliTokenOverride
            ? undefined
            : await resolveAgentAccessAuthToken(
                orchestrator.config.agentAccessHttp.authToken,
                { resolveSecretRef },
              );
          const status = await runAccessHttpServeCliCommand({
            service: accessService,
            enabled: true,
            host: typeof options.host === "string" ? options.host : "127.0.0.1",
            port: Number.isFinite(portRaw) ? portRaw : 4318,
            authToken: cliTokenOverride ?? resolvedConfigAuthToken,
            principal: resolveAccessPrincipalOverride(options.principal, orchestrator.config.agentAccessHttp.principal),
            maxBodyBytes: Number.isFinite(maxBodyBytesRaw) ? maxBodyBytesRaw : 131072,
            trustPrincipalHeader: options.trustPrincipalHeader === true,
            citationsEnabled: orchestrator.config.citationsEnabled,
            citationsAutoDetect: orchestrator.config.citationsAutoDetect,
          });
          console.log(JSON.stringify(status, null, 2));
          console.log("OK");
          // Initialize the orchestrator AFTER the HTTP server is listening.
          // Without this call the init gate Promise never resolves, so every
          // recall waits the full 15s gate timeout — and QMD is never probed,
          // causing the embedding fallback to load a 300 MB JSON on every cold
          // path. But by running it here (not before), the port is available
          // immediately while warmup proceeds in the background.
          await orchestrator.initialize();
        });

      accessCmd
        .command("http-stop")
        .description("Stop the in-process Engram HTTP access server")
        .action(async () => {
          const result = await runAccessHttpStopCliCommand();
          console.log(JSON.stringify(result, null, 2));
          console.log("OK");
        });

      accessCmd
        .command("http-status")
        .description("Show Engram HTTP access server status")
        .action(async () => {
          const status = await runAccessHttpStatusCliCommand();
          console.log(JSON.stringify(status, null, 2));
          console.log("OK");
        });

      accessCmd
        .command("mcp-serve")
        .description("Run the Engram MCP server over stdio")
        .option("--principal <principal>", "Trusted principal (defaults to config/env)")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          await runAccessMcpServeCliCommand(accessService, {
            principal: resolveAccessPrincipalOverride(options.principal, orchestrator.config.agentAccessHttp.principal),
          });
        });

      const routeCmd = cmd
        .command("route")
        .description("Manage custom memory routing rules");

      routeCmd
        .command("list")
        .description("List configured routing rules")
        .action(async () => {
          const rules = await runRouteCliCommand({
            action: "list",
            memoryDir: orchestrator.config.memoryDir,
            stateFile: orchestrator.config.routingRulesStateFile,
          }) as RouteRule[];

          if (rules.length === 0) {
            console.log("No routing rules configured.");
            return;
          }
          for (const rule of rules) {
            const targetParts = [
              rule.target.category ? `category=${rule.target.category}` : "",
              rule.target.namespace ? `namespace=${rule.target.namespace}` : "",
            ].filter((value) => value.length > 0);
            console.log(
              `${rule.id} type=${rule.patternType} priority=${rule.priority} pattern="${rule.pattern}" target=${targetParts.join(",")}`,
            );
          }
        });

      routeCmd
        .command("add")
        .description("Add or update a routing rule")
        .argument("<pattern>", "Keyword or regex pattern")
        .argument("<target>", "Target (JSON or category=<cat>,namespace=<ns>)")
        .option("--type <type>", "Pattern type: keyword|regex", "keyword")
        .option("--priority <n>", "Rule priority", "0")
        .option("--id <id>", "Optional stable rule id")
        .action(async (...args: unknown[]) => {
          const pattern = typeof args[0] === "string" ? args[0] : "";
          const targetRaw = typeof args[1] === "string" ? args[1] : "";
          const options = (args[2] ?? {}) as Record<string, unknown>;
          const patternTypeRaw = typeof options.type === "string" ? options.type.trim().toLowerCase() : "keyword";
          if (!isRoutePatternType(patternTypeRaw)) {
            throw new Error(`invalid route pattern type: ${patternTypeRaw}`);
          }
          const priorityInput = String(options.priority ?? "0").trim();
          if (!/^-?\d+$/.test(priorityInput)) {
            throw new Error(`invalid route priority: ${priorityInput}`);
          }
          const priorityRaw = Number(priorityInput);
          const updated = await runRouteCliCommand({
            action: "add",
            memoryDir: orchestrator.config.memoryDir,
            stateFile: orchestrator.config.routingRulesStateFile,
            pattern,
            patternType: patternTypeRaw,
            priority: priorityRaw,
            targetRaw,
            id: typeof options.id === "string" ? options.id : undefined,
          }) as RouteRule[];
          console.log(`OK (${updated.length} rules)`);
        });

      routeCmd
        .command("remove")
        .description("Remove routing rules by exact pattern")
        .argument("<pattern>", "Pattern to remove")
        .action(async (...args: unknown[]) => {
          const pattern = typeof args[0] === "string" ? args[0] : "";
          const next = await runRouteCliCommand({
            action: "remove",
            memoryDir: orchestrator.config.memoryDir,
            stateFile: orchestrator.config.routingRulesStateFile,
            pattern,
          }) as RouteRule[];
          console.log(`OK (${next.length} rules remain)`);
        });

      routeCmd
        .command("test")
        .description("Test routing rule match for input text")
        .argument("<text>", "Text to evaluate")
        .action(async (...args: unknown[]) => {
          const text = typeof args[0] === "string" ? args[0] : "";
          const selection = await runRouteCliCommand({
            action: "test",
            memoryDir: orchestrator.config.memoryDir,
            stateFile: orchestrator.config.routingRulesStateFile,
            text,
          }) as { rule: RouteRule; target: RouteTarget } | null;
          if (!selection) {
            console.log("No route match.");
            return;
          }
          const targetParts = [
            selection.target.category ? `category=${selection.target.category}` : "",
            selection.target.namespace ? `namespace=${selection.target.namespace}` : "",
          ].filter((value) => value.length > 0);
          console.log(
            `Matched ${selection.rule.id} type=${selection.rule.patternType} priority=${selection.rule.priority} target=${targetParts.join(",")}`,
          );
        });

      cmd
        .command("archive-observations")
        .description("Archive aged observation artifacts (dry-run by default)")
        .option("--retention-days <n>", "Archive files older than N days", "30")
        .option("--write", "Apply archive mutations (default: dry-run)")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const retentionDays = parseInt(String(options.retentionDays ?? "30"), 10);
          const result = await runArchiveObservationsCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            retentionDays: Number.isFinite(retentionDays) ? retentionDays : 30,
            write: options.write === true,
          });

          console.log(`Dry run: ${result.dryRun ? "yes" : "no"}`);
          console.log(`Retention days: ${result.retentionDays}`);
          console.log(`Scanned files: ${result.scannedFiles}`);
          console.log(`Archived files: ${result.archivedFiles}`);
          console.log(`Archived bytes: ${result.archivedBytes}`);
          if (result.archivedRelativePaths.length > 0) {
            console.log("Archived paths:");
            for (const relPath of result.archivedRelativePaths.slice(0, 20)) {
              console.log(`  - ${relPath}`);
            }
            if (result.archivedRelativePaths.length > 20) {
              console.log(`  ... and ${result.archivedRelativePaths.length - 20} more`);
            }
          }
          console.log("OK");
        });

      cmd
        .command("rebuild-observations")
        .description("Rebuild observation ledger from transcript history (dry-run by default)")
        .option("--write", "Write rebuilt ledger (default: dry-run)")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const result = await runRebuildObservationsCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            write: options.write === true,
          });

          console.log(`Dry run: ${result.dryRun ? "yes" : "no"}`);
          console.log(`Scanned transcript files: ${result.scannedFiles}`);
          console.log(`Parsed turns: ${result.parsedTurns}`);
          console.log(`Malformed lines: ${result.malformedLines}`);
          console.log(`Rebuilt rows: ${result.rebuiltRows}`);
          console.log(`Output path: ${result.outputPath}`);
          if (result.backupPath) console.log(`Backup path: ${result.backupPath}`);
          console.log("OK");
        });

      cmd
        .command("rebuild-memory-lifecycle-ledger")
        .description("Rebuild the generic memory lifecycle ledger from markdown memories (dry-run by default)")
        .option("--write", "Write rebuilt ledger (default: dry-run)")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const result = await runRebuildMemoryLifecycleLedgerCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            write: options.write === true,
          });

          console.log(`Dry run: ${result.dryRun ? "yes" : "no"}`);
          console.log(`Scanned memories: ${result.scannedMemories}`);
          console.log(`Rebuilt rows: ${result.rebuiltRows}`);
          console.log(`Output path: ${result.outputPath}`);
          if (result.backupPath) console.log(`Backup path: ${result.backupPath}`);
          console.log("OK");
        });

      cmd
        .command("rebuild-memory-projection")
        .description("Rebuild the derived memory projection store from markdown memories and lifecycle events (dry-run by default)")
        .option("--write", "Write rebuilt projection (default: dry-run)")
        .option("--namespace <ns>", "Namespace to rebuild (default: config defaultNamespace)", "")
        .option("--updated-after <iso>", "Only report/rebuild memories updated on or after this ISO timestamp", "")
        .option("--updated-before <iso>", "Only report/rebuild memories updated on or before this ISO timestamp", "")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const namespace = typeof options.namespace === "string" && options.namespace.trim().length > 0
            ? options.namespace.trim()
            : undefined;
          const memoryDir = await resolveMemoryDirForNamespace(orchestrator, namespace, {
            rejectUnsupportedOverride: true,
          });
          const result = await runRebuildMemoryProjectionCliCommand({
            memoryDir,
            defaultNamespace: namespace ?? orchestrator.config.defaultNamespace,
            write: options.write === true,
            updatedAfter: typeof options.updatedAfter === "string" && options.updatedAfter.trim().length > 0
              ? options.updatedAfter.trim()
              : undefined,
            updatedBefore: typeof options.updatedBefore === "string" && options.updatedBefore.trim().length > 0
              ? options.updatedBefore.trim()
              : undefined,
          });

          console.log(`Dry run: ${result.dryRun ? "yes" : "no"}`);
          console.log(`Scanned memories: ${result.scannedMemories}`);
          console.log(`Current-state rows: ${result.currentRows}`);
          console.log(`Timeline rows: ${result.timelineRows}`);
          console.log(`Entity-mention rows: ${result.entityMentionRows}`);
          console.log(`Native-knowledge rows: ${result.nativeKnowledgeRows}`);
          console.log(`Review-queue rows: ${result.reviewQueueRows}`);
          console.log(`Used lifecycle ledger: ${result.usedLifecycleLedger ? "yes" : "no"}`);
          console.log(`Updated-after scope: ${result.scope.updatedAfter ?? "none"}`);
          console.log(`Updated-before scope: ${result.scope.updatedBefore ?? "none"}`);
          console.log(`Output path: ${result.outputPath}`);
          if (result.backupPath) console.log(`Backup path: ${result.backupPath}`);
          console.log("OK");
        });

      cmd
        .command("verify-memory-projection")
        .description("Verify the derived memory projection against markdown memories and lifecycle events")
        .option("--namespace <ns>", "Namespace to verify (default: config defaultNamespace)", "")
        .option("--updated-after <iso>", "Only verify memories updated on or after this ISO timestamp", "")
        .option("--updated-before <iso>", "Only verify memories updated on or before this ISO timestamp", "")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const namespace = typeof options.namespace === "string" && options.namespace.trim().length > 0
            ? options.namespace.trim()
            : undefined;
          const memoryDir = await resolveMemoryDirForNamespace(orchestrator, namespace);
          const result = await runVerifyMemoryProjectionCliCommand({
            memoryDir,
            defaultNamespace: namespace ?? orchestrator.config.defaultNamespace,
            updatedAfter: typeof options.updatedAfter === "string" && options.updatedAfter.trim().length > 0
              ? options.updatedAfter.trim()
              : undefined,
            updatedBefore: typeof options.updatedBefore === "string" && options.updatedBefore.trim().length > 0
              ? options.updatedBefore.trim()
              : undefined,
          });

          console.log(`Projection exists: ${result.projectionExists ? "yes" : "no"}`);
          console.log(`OK: ${result.ok ? "yes" : "no"}`);
          console.log(`Expected current rows: ${result.expectedCurrentRows}`);
          console.log(`Actual current rows: ${result.actualCurrentRows}`);
          console.log(`Expected timeline rows: ${result.expectedTimelineRows}`);
          console.log(`Actual timeline rows: ${result.actualTimelineRows}`);
          console.log(`Expected entity-mention rows: ${result.expectedEntityMentionRows}`);
          console.log(`Actual entity-mention rows: ${result.actualEntityMentionRows}`);
          console.log(`Expected native-knowledge rows: ${result.expectedNativeKnowledgeRows}`);
          console.log(`Actual native-knowledge rows: ${result.actualNativeKnowledgeRows}`);
          console.log(`Expected review-queue rows: ${result.expectedReviewQueueRows}`);
          console.log(`Actual review-queue rows: ${result.actualReviewQueueRows}`);
          console.log(`Missing current memories: ${result.missingCurrentMemoryIds.join(", ") || "none"}`);
          console.log(`Extra current memories: ${result.extraCurrentMemoryIds.join(", ") || "none"}`);
          console.log(`Mismatched current memories: ${result.mismatchedCurrentMemoryIds.join(", ") || "none"}`);
          console.log(`Missing timeline events: ${result.missingTimelineEventIds.join(", ") || "none"}`);
          console.log(`Extra timeline events: ${result.extraTimelineEventIds.join(", ") || "none"}`);
          console.log(`Missing entity mentions: ${result.missingEntityMentionKeys.join(", ") || "none"}`);
          console.log(`Extra entity mentions: ${result.extraEntityMentionKeys.join(", ") || "none"}`);
          console.log(`Mismatched entity mentions: ${result.mismatchedEntityMentionKeys.join(", ") || "none"}`);
          console.log(`Missing native-knowledge chunks: ${result.missingNativeKnowledgeChunkIds.join(", ") || "none"}`);
          console.log(`Extra native-knowledge chunks: ${result.extraNativeKnowledgeChunkIds.join(", ") || "none"}`);
          console.log(`Mismatched native-knowledge chunks: ${result.mismatchedNativeKnowledgeChunkIds.join(", ") || "none"}`);
          console.log(`Missing review-queue entries: ${result.missingReviewQueueEntryIds.join(", ") || "none"}`);
          console.log(`Extra review-queue entries: ${result.extraReviewQueueEntryIds.join(", ") || "none"}`);
          console.log(`Mismatched review-queue entries: ${result.mismatchedReviewQueueEntryIds.join(", ") || "none"}`);
          console.log("OK");
        });

      cmd
        .command("repair-memory-projection")
        .description("Repair projection drift by rebuilding the derived projection (dry-run by default)")
        .option("--write", "Write repaired projection (default: dry-run)")
        .option("--namespace <ns>", "Namespace to repair (default: config defaultNamespace)", "")
        .option("--updated-after <iso>", "Only repair memories updated on or after this ISO timestamp", "")
        .option("--updated-before <iso>", "Only repair memories updated on or before this ISO timestamp", "")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const namespace = typeof options.namespace === "string" && options.namespace.trim().length > 0
            ? options.namespace.trim()
            : undefined;
          const memoryDir = await resolveMemoryDirForNamespace(orchestrator, namespace);
          const result = await runRepairMemoryProjectionCliCommand({
            memoryDir,
            defaultNamespace: namespace ?? orchestrator.config.defaultNamespace,
            write: options.write === true,
            updatedAfter: typeof options.updatedAfter === "string" && options.updatedAfter.trim().length > 0
              ? options.updatedAfter.trim()
              : undefined,
            updatedBefore: typeof options.updatedBefore === "string" && options.updatedBefore.trim().length > 0
              ? options.updatedBefore.trim()
              : undefined,
          });

          console.log(`Dry run: ${result.dryRun ? "yes" : "no"}`);
          console.log(`Repaired: ${result.repaired ? "yes" : "no"}`);
          console.log(`Verification OK: ${result.verify.ok ? "yes" : "no"}`);
          if (result.rebuild) {
            console.log(`Output path: ${result.rebuild.outputPath}`);
            if (result.rebuild.backupPath) console.log(`Backup path: ${result.rebuild.backupPath}`);
          }
          console.log("OK");
        });

      cmd
        .command("memory-timeline <memoryId>")
        .description("Read one memory timeline from the derived projection store")
        .option("--limit <n>", "Maximum timeline rows to print", "200")
        .action(async (...args: unknown[]) => {
          const memoryId = String(args[0] ?? "");
          const options = (args[1] ?? {}) as Record<string, unknown>;
          const limit = parseInt(String(options.limit ?? "200"), 10);
          const rows = await runMemoryTimelineCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            memoryId,
            limit: Number.isFinite(limit) ? limit : 200,
          });

          if (rows.length === 0) {
            console.log("No timeline rows found. Rebuild the memory projection first if needed.");
            console.log("OK");
            return;
          }

          for (const row of rows) {
            console.log(`${row.timestamp} ${row.eventType} ${row.actor}`);
          }
          console.log("OK");
        });

      cmd
        .command("governance-run")
        .description("Run memory governance in shadow/apply mode and write audit artifacts")
        .option("--mode <mode>", "Governance mode (shadow|apply)", "shadow")
        .option("--max-memories <n>", "Maximum memories to scan in this run")
        .option("--batch-size <n>", "File-read batch size for bounded governance runs")
        .option("--recent-days <n>", "Only govern memories updated within the last N days")
        .option("--namespace <ns>", "Namespace to govern (default: current default namespace)")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const mode = options.mode === "apply" ? "apply" : "shadow";
          const maxMemoriesRaw = Number.parseInt(String(options.maxMemories ?? ""), 10);
          const batchSizeRaw = Number.parseInt(String(options.batchSize ?? ""), 10);
          const recentDaysRaw = Number.parseInt(String(options.recentDays ?? ""), 10);
          const namespace = typeof options.namespace === "string" && options.namespace.trim().length > 0
            ? options.namespace.trim()
            : undefined;
          const memoryDir = await resolveMemoryDirForNamespace(orchestrator, namespace, {
            rejectUnsupportedOverride: true,
          });
          const deepSleep = orchestrator.config.dreamsPhases.deepSleep;
          if (deepSleep.enabled === false && deepSleep.enabledExplicitlySet === true) {
            throw new Error("memory governance is disabled by dreams.phases.deepSleep.enabled=false");
          }
          const result = await runMemoryGovernanceCliCommand({
            memoryDir,
            mode,
            maxMemories: Number.isFinite(maxMemoriesRaw) ? maxMemoriesRaw : undefined,
            batchSize: Number.isFinite(batchSizeRaw) ? batchSizeRaw : undefined,
            recentDays: Number.isFinite(recentDaysRaw) ? recentDaysRaw : undefined,
          });
          console.log(JSON.stringify(result, null, 2));
          console.log("OK");
        });

      cmd
        .command("governance-report")
        .description("Read the latest or a named governance run artifact bundle")
        .option("--run-id <id>", "Governance run id (default: latest)")
        .option("--namespace <ns>", "Namespace to inspect (default: current default namespace)")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const namespace = typeof options.namespace === "string" && options.namespace.trim().length > 0
            ? options.namespace.trim()
            : undefined;
          const memoryDir = await resolveMemoryDirForNamespace(orchestrator, namespace, {
            rejectUnsupportedOverride: true,
          });
          const report = await runMemoryGovernanceReportCliCommand({
            memoryDir,
            runId: typeof options.runId === "string" && options.runId.trim().length > 0
              ? options.runId.trim()
              : undefined,
          });
          console.log(JSON.stringify(report, null, 2));
          console.log("OK");
        });

      cmd
        .command("governance-restore")
        .description("Restore memory files from a previous governance apply run")
        .requiredOption("--run-id <id>", "Governance run id to restore")
        .option("--namespace <ns>", "Namespace to restore (default: current default namespace)")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          if (typeof options.runId !== "string" || options.runId.trim().length === 0) {
            throw new Error("missing --run-id");
          }
          const namespace = typeof options.namespace === "string" && options.namespace.trim().length > 0
            ? options.namespace.trim()
            : undefined;
          const memoryDir = await resolveMemoryDirForNamespace(orchestrator, namespace, {
            rejectUnsupportedOverride: true,
          });
          const result = await runMemoryGovernanceRestoreCliCommand({
            memoryDir,
            runId: options.runId.trim(),
          });
          console.log(JSON.stringify(result, null, 2));
          console.log("OK");
        });

      cmd
        .command("review-disposition <memoryId>")
        .description("Manually set an operator review disposition on one memory")
        .requiredOption("--status <status>", "Disposition status (active|pending_review|rejected|quarantined)")
        .option("--reason-code <code>", "Optional reason code recorded in CLI output")
        .action(async (...args: unknown[]) => {
          const memoryId = String(args[0] ?? "");
          const options = (args[1] ?? {}) as Record<string, unknown>;
          const statusOpt = typeof options.status === "string" ? options.status.trim() : "";
          if (
            statusOpt !== "active"
            && statusOpt !== "pending_review"
            && statusOpt !== "rejected"
            && statusOpt !== "quarantined"
          ) {
            throw new Error(`invalid review disposition status: ${statusOpt}`);
          }
          const result = await runMemoryReviewDispositionCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            memoryId,
            status: statusOpt,
            reasonCode: typeof options.reasonCode === "string" && options.reasonCode.trim().length > 0
              ? options.reasonCode.trim()
              : undefined,
          });
          console.log(JSON.stringify(result, null, 2));
          console.log("OK");
        });

      cmd
        .command("migrate-observations")
        .description("Migrate legacy observation ledgers into rebuilt format (dry-run by default)")
        .option("--write", "Write migrated ledger (default: dry-run)")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const result = await runMigrateObservationsCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            write: options.write === true,
          });

          console.log(`Dry run: ${result.dryRun ? "yes" : "no"}`);
          console.log(`Scanned legacy files: ${result.scannedFiles}`);
          console.log(`Parsed rows: ${result.parsedRows}`);
          console.log(`Malformed lines: ${result.malformedLines}`);
          console.log(`Migrated rows: ${result.migratedRows}`);
          if (result.sourceRelativePaths.length > 0) {
            console.log("Source files:");
            for (const relPath of result.sourceRelativePaths) {
              console.log(`  - ${relPath}`);
            }
          }
          console.log(`Output path: ${result.outputPath}`);
          if (result.backupPath) console.log(`Backup path: ${result.backupPath}`);
          console.log("OK");
        });

      cmd
        .command("task")
        .description("Manage work tasks")
        .argument("<action>", "create|get|list|update|transition|delete|link")
        .option("--id <id>", "Task ID")
        .option("--title <title>", "Task title")
        .option("--description <description>", "Task description")
        .option("--status <status>", "Task status")
        .option("--priority <priority>", "Task priority")
        .option("--owner <owner>", "Task owner")
        .option("--assignee <assignee>", "Task assignee")
        .option("--project-id <projectId>", "Project ID")
        .option("--tags <csv>", "Comma-separated tags")
        .option("--due-at <iso>", "Due timestamp (ISO)")
        .action(async (...args: unknown[]) => {
          const actionRaw = typeof args[0] === "string" ? args[0].trim().toLowerCase() : "";
          const options = (args[1] ?? {}) as Record<string, unknown>;
          const statusOptRaw = typeof options.status === "string" ? options.status.trim().toLowerCase() : undefined;
          const priorityOptRaw = typeof options.priority === "string" ? options.priority.trim().toLowerCase() : undefined;
          if (statusOptRaw !== undefined && !isWorkTaskStatus(statusOptRaw)) {
            throw new Error(`invalid task status: ${statusOptRaw}`);
          }
          if (priorityOptRaw !== undefined && !isWorkTaskPriority(priorityOptRaw)) {
            throw new Error(`invalid task priority: ${priorityOptRaw}`);
          }

          const patch: WorkTaskPatchInput = {};
          if (typeof options.title === "string") patch.title = options.title.trim();
          if (typeof options.description === "string") patch.description = options.description.trim();
          if (statusOptRaw !== undefined) patch.status = statusOptRaw;
          if (priorityOptRaw !== undefined) patch.priority = priorityOptRaw;
          if (typeof options.owner === "string") patch.owner = normalizeNullableCliValue(options.owner) ?? null;
          if (typeof options.assignee === "string") patch.assignee = normalizeNullableCliValue(options.assignee) ?? null;
          if (typeof options.projectId === "string") patch.projectId = normalizeNullableCliValue(options.projectId) ?? null;
          if (typeof options.tags === "string") {
            patch.tags = parseTagsCsv(options.tags, true);
          }
          if (typeof options.dueAt === "string") patch.dueAt = normalizeNullableCliValue(options.dueAt) ?? null;

          const result = await runWorkTaskCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            action: actionRaw as WorkTaskCliCommandOptions["action"],
            id: typeof options.id === "string" ? options.id : undefined,
            title: typeof options.title === "string" ? options.title : undefined,
            description: typeof options.description === "string" ? options.description : undefined,
            status: statusOptRaw,
            priority: priorityOptRaw,
            owner: typeof options.owner === "string" ? options.owner : undefined,
            assignee: typeof options.assignee === "string" ? options.assignee : undefined,
            projectId: typeof options.projectId === "string" ? options.projectId : undefined,
            tags: typeof options.tags === "string"
              ? parseTagsCsv(options.tags, true)
              : undefined,
            dueAt: typeof options.dueAt === "string" ? options.dueAt : undefined,
            patch,
          });

          if (Array.isArray(result)) {
            console.log(`Count: ${result.length}`);
          }
          console.log(JSON.stringify(result, null, 2));
          console.log("OK");
        });

      cmd
        .command("project")
        .description("Manage work projects")
        .argument("<action>", "create|get|list|update|delete")
        .option("--id <id>", "Project ID")
        .option("--name <name>", "Project name")
        .option("--description <description>", "Project description")
        .option("--status <status>", "Project status")
        .option("--owner <owner>", "Project owner")
        .option("--tags <csv>", "Comma-separated tags")
        .action(async (...args: unknown[]) => {
          const actionRaw = typeof args[0] === "string" ? args[0].trim().toLowerCase() : "";
          const options = (args[1] ?? {}) as Record<string, unknown>;
          const statusOptRaw = typeof options.status === "string" ? options.status.trim().toLowerCase() : undefined;
          if (statusOptRaw !== undefined && !isWorkProjectStatus(statusOptRaw)) {
            throw new Error(`invalid project status: ${statusOptRaw}`);
          }

          const patch: WorkProjectPatchInput = {};
          if (typeof options.name === "string") patch.name = options.name.trim();
          if (typeof options.description === "string") patch.description = options.description.trim();
          if (statusOptRaw !== undefined) patch.status = statusOptRaw;
          if (typeof options.owner === "string") patch.owner = normalizeNullableCliValue(options.owner) ?? null;
          if (typeof options.tags === "string") {
            patch.tags = parseTagsCsv(options.tags, true);
          }

          const result = await runWorkProjectCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            action: actionRaw as WorkProjectCliCommandOptions["action"],
            id: typeof options.id === "string" ? options.id : undefined,
            name: typeof options.name === "string" ? options.name : undefined,
            description: typeof options.description === "string" ? options.description : undefined,
            status: statusOptRaw,
            owner: typeof options.owner === "string" ? options.owner : undefined,
            tags: typeof options.tags === "string"
              ? parseTagsCsv(options.tags, true)
              : undefined,
            patch,
          });

          if (Array.isArray(result)) {
            console.log(`Count: ${result.length}`);
          }
          console.log(JSON.stringify(result, null, 2));
          console.log("OK");
        });

      cmd
        .command("dedupe-exact")
        .description("Delete exact duplicate memory entries (same body text), keeping highest-confidence/newest copy")
        .option("--dry-run", "Show what would be deleted without deleting files")
        .option("--namespace <ns>", "Namespace to dedupe (v3.0+, default: config defaultNamespace)", "")
        .option("--qmd-sync", "Run QMD update/embed after deletions (default: off)")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const dryRun = options.dryRun === true;
          const namespace = options.namespace ? String(options.namespace) : "";
          const qmdSync = options.qmdSync === true;

          const memoryDir = await resolveMemoryDirForNamespace(orchestrator, namespace);
          const memories = await readAllMemoryFiles(memoryDir);
          const plan = planExactDuplicateDeletions(memories);

          console.log(`Scanned ${memories.length} memory files in ${memoryDir}`);
          console.log(`Duplicate groups: ${plan.groups}`);
          console.log(`Duplicate files to delete: ${plan.deletePaths.length}`);

          if (plan.deletePaths.length === 0) {
            console.log("No exact duplicates found.");
            return;
          }

          if (dryRun) {
            console.log("Dry run enabled. No files deleted.");
            for (const filePath of plan.deletePaths.slice(0, 50)) {
              console.log(`  - ${filePath}`);
            }
            if (plan.deletePaths.length > 50) {
              console.log(`  ... and ${plan.deletePaths.length - 50} more`);
            }
            return;
          }

          let deleted = 0;
          for (const filePath of plan.deletePaths) {
            try {
              await unlink(filePath);
              deleted += 1;
            } catch (err) {
              console.log(`  failed to delete ${filePath}: ${String(err)}`);
            }
          }
          console.log(`Deleted ${deleted}/${plan.deletePaths.length} duplicate files.`);

          if (qmdSync) {
            await orchestrator.qmd.probe();
            if (orchestrator.qmd.isAvailable()) {
              await orchestrator.qmd.update();
              await orchestrator.qmd.embed();
              console.log("QMD sync complete.");
            } else {
              console.log(`QMD unavailable in this process; skipped sync. Status: ${orchestrator.qmd.debugStatus()}`);
            }
          }
        });

      cmd
        .command("dedupe-aggressive")
        .description(
          "Delete aggressively-normalized duplicate memory entries (formatting/case/punctuation-insensitive)",
        )
        .option("--dry-run", "Show what would be deleted without deleting files")
        .option("--namespace <ns>", "Namespace to dedupe (v3.0+, default: config defaultNamespace)", "")
        .option("--qmd-sync", "Run QMD update/embed after deletions (default: off)")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const dryRun = options.dryRun === true;
          const namespace = options.namespace ? String(options.namespace) : "";
          const qmdSync = options.qmdSync === true;

          const memoryDir = await resolveMemoryDirForNamespace(orchestrator, namespace);
          const memories = await readAllMemoryFiles(memoryDir);
          const plan = planAggressiveDuplicateDeletions(memories);

          console.log(`Scanned ${memories.length} memory files in ${memoryDir}`);
          console.log(`Duplicate groups: ${plan.groups}`);
          console.log(`Duplicate files to delete: ${plan.deletePaths.length}`);

          if (plan.deletePaths.length === 0) {
            console.log("No aggressive duplicates found.");
            return;
          }

          if (dryRun) {
            console.log("Dry run enabled. No files deleted.");
            for (const filePath of plan.deletePaths.slice(0, 50)) {
              console.log(`  - ${filePath}`);
            }
            if (plan.deletePaths.length > 50) {
              console.log(`  ... and ${plan.deletePaths.length - 50} more`);
            }
            return;
          }

          let deleted = 0;
          for (const filePath of plan.deletePaths) {
            try {
              await unlink(filePath);
              deleted += 1;
            } catch (err) {
              console.log(`  failed to delete ${filePath}: ${String(err)}`);
            }
          }
          console.log(`Deleted ${deleted}/${plan.deletePaths.length} duplicate files.`);

          if (qmdSync) {
            await orchestrator.qmd.probe();
            if (orchestrator.qmd.isAvailable()) {
              await orchestrator.qmd.update();
              await orchestrator.qmd.embed();
              console.log("QMD sync complete.");
            } else {
              console.log(`QMD unavailable in this process; skipped sync. Status: ${orchestrator.qmd.debugStatus()}`);
            }
          }
        });

      cmd
        .command("search")
        .argument("<query>", "Search query")
        .option("-n, --max-results <number>", "Max results", "8")
        .description("Search memories via QMD")
        .action(async (...args: unknown[]) => {
          const query = typeof args[0] === "string" ? args[0] : String(args[0] ?? "");
          const options = (args[1] ?? {}) as Record<string, string>;
          const maxResults = parseInt(options.maxResults ?? "8", 10);
          if (!query) {
            console.log("Missing query. Usage: openclaw engram search <query>");
            return;
          }

          // Probe in this CLI process before availability check.
          await orchestrator.qmd.probe();

          if (orchestrator.qmd.isAvailable()) {
            const rawResults = await orchestrator.qmd.search(
              query,
              undefined,
              maxResults,
            );
            const results = await filterNormalMemorySearchResults(
              rawResults,
              orchestrator.storage,
            );
            if (results.length === 0) {
              console.log(`No results for: "${query}"`);
              return;
            }
            console.log(`\n=== Memory Search: "${query}" ===\n`);
            for (const r of results) {
              console.log(`  ${r.path} (score: ${r.score.toFixed(3)})`);
              if (r.snippet) {
                console.log(
                  `    ${r.snippet.slice(0, 150).replace(/\n/g, " ")}`,
                );
              }
              console.log();
            }
          } else {
            // Fallback: search filenames
            const memories = await orchestrator.storage.readAllMemories();
            const lowerQuery = query.toLowerCase();
            const matches = memories.filter(
              (m) =>
                isNormalRetrievalVisibleMemory(m) &&
                (m.content.toLowerCase().includes(lowerQuery) ||
                  m.frontmatter.tags.some((t) => t.includes(lowerQuery))),
            );
            const qmdStatus = orchestrator.qmd.debugStatus();
            if (matches.length === 0) {
              console.log(
                `No results for: "${query}" (QMD unavailable in this CLI process; text search fallback).`,
              );
              console.log(`QMD status: ${qmdStatus}`);
              return;
            }
            console.log(`\n=== Text Search Fallback: "${query}" (${matches.length} results) ===\n`);
            console.log(`QMD status: ${qmdStatus}\n`);
            for (const m of matches.slice(0, maxResults)) {
              console.log(`  [${m.frontmatter.category}] ${m.content.slice(0, 120)}`);
            }
          }
        });

      cmd
        .command("profile")
        .description("Show current user profile")
        .action(async () => {
          const profile = await orchestrator.storage.readProfile();
          if (!profile) {
            console.log("No profile built yet.");
            return;
          }
          console.log(profile);
        });

      cmd
        .command("entities")
        .description("List all tracked entities")
        .action(async () => {
          const entities = await orchestrator.storage.readEntities();
          if (entities.length === 0) {
            console.log("No entities tracked yet.");
            return;
          }
          console.log(`=== Entities (${entities.length}) ===\n`);
          for (const e of entities) {
            console.log(`  - ${e}`);
          }
        });

      cmd
        .command("entities-migrate")
        .description("Rewrite entity files into the compiled truth + timeline format")
        .action(async () => {
          const storage = await orchestrator.getStorage(orchestrator.config.defaultNamespace);
          const result = await storage.migrateEntityFilesToCompiledTruthTimeline();
          console.log(
            `Migrated ${result.migrated} of ${result.total} entity file(s) to the compiled truth + timeline format.`,
          );
        });

      cmd
        .command("extract")
        .description("Force extraction of buffered turns")
        .action(async () => {
          await orchestrator.buffer.load();
          const turns = orchestrator.buffer.getTurns();
          if (turns.length === 0) {
            console.log("Buffer is empty. Nothing to extract.");
            return;
          }
          console.log(`Extracting ${turns.length} buffered turns...`);
          // Trigger extraction by processing a dummy turn that forces extraction
          // Actually we need to call the internal extraction method
          // For now, inform the user
          console.log(
            "Use the memory system in conversation to trigger extraction, or wait for the buffer threshold.",
          );
        });

      cmd
        .command("bootstrap")
        .description("Scan transcript history and seed memory from high-signal past turns")
        .option("--dry-run", "Scan and report without writing memories")
        .option("--sessions-dir <path>", "Override transcript sessions directory")
        .option("--limit <number>", "Maximum sessions to process")
        .option("--since <date>", "Only process turns after date (YYYY-MM-DD or ISO)")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const dryRun = options.dryRun === true;
          const sessionsDir = options.sessionsDir ? String(options.sessionsDir) : undefined;
          const limitRaw = options.limit ? Number(options.limit) : undefined;
          const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw) && limitRaw > 0
            ? Math.floor(limitRaw)
            : undefined;

          let since: Date | undefined;
          if (options.since) {
            const parsed = new Date(String(options.since));
            if (Number.isNaN(parsed.getTime())) {
              console.log(`Invalid --since value: ${String(options.since)}`);
              return;
            }
            since = parsed;
          }

          console.log("Running bootstrap scan...");
          const result = await orchestrator.runBootstrap({
            dryRun,
            sessionsDir,
            limit,
            since,
          });
          console.log(
            `Bootstrap complete. sessions=${result.sessionsScanned}, turns=${result.turnsProcessed}, highSignal=${result.highSignalTurns}, created=${result.memoriesCreated}, skipped=${result.skipped}`,
          );
        });

      cmd
        .command("consolidate")
        .description("Run memory consolidation immediately")
        .option("--verbose", "Show detailed consolidation stats")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const verbose = options.verbose === true;
          console.log("Running consolidation...");
          const stats = await orchestrator.runConsolidationNow();
          if (verbose) {
            console.log(
              `Consolidation complete. memoriesProcessed=${stats.memoriesProcessed}, merged=${stats.merged}, invalidated=${stats.invalidated}`,
            );
          } else {
            console.log(`Consolidation complete. merged=${stats.merged}, invalidated=${stats.invalidated}`);
          }
        });

      cmd
        .command("semantic-consolidate")
        .description("Run semantic consolidation of similar memories")
        .option("--dry-run", "Show what would be consolidated without making changes")
        .option("--verbose", "Show detailed cluster information")
        .option("--threshold <n>", "Override token overlap threshold (0-1)")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const dryRun = options.dryRun === true;
          const verbose = options.verbose === true;
          const thresholdOverride = typeof options.threshold === "string"
            ? parseFloat(options.threshold)
            : undefined;

          console.log(`Running semantic consolidation${dryRun ? " (dry run)" : ""}...`);
          const result = await orchestrator.runSemanticConsolidationNow({
            dryRun,
            thresholdOverride,
          });

          if (verbose || dryRun) {
            console.log(`\nClusters found: ${result.clustersFound}`);
            for (const cluster of result.clusters) {
              console.log(`\n  Category: ${cluster.category} (${cluster.memories.length} memories, overlap=${cluster.overlapScore.toFixed(2)})`);
              for (const m of cluster.memories) {
                const preview = m.content.length > 80 ? m.content.slice(0, 80) + "..." : m.content;
                console.log(`    - ${m.frontmatter.id}: ${preview}`);
              }
              if (cluster.canonicalContent) {
                const preview = cluster.canonicalContent.length > 120
                  ? cluster.canonicalContent.slice(0, 120) + "..."
                  : cluster.canonicalContent;
                console.log(`    → Canonical: ${preview}`);
              }
            }
          }

          console.log(
            `\nSemantic consolidation complete. clusters=${result.clustersFound}, consolidated=${result.memoriesConsolidated}, archived=${result.memoriesArchived}, errors=${result.errors}`,
          );
        });

      // consolidate-undo (issue #561 PR 5) — reverts a consolidated memory
      // by restoring each source from its page-version snapshot and
      // archiving the target.  See `consolidation-undo.ts` for the helper.
      cmd
        .command("consolidate-undo <target>")
        .description(
          "Undo a consolidation: restore source memories from their derived_from snapshots and archive the target",
        )
        .option("--dry-run", "Show the restore plan without modifying files")
        .action(async (...args: unknown[]) => {
          const rawTarget = typeof args[0] === "string" ? args[0] : "";
          const options = (args[1] ?? {}) as Record<string, unknown>;
          const dryRun = options.dryRun === true;
          if (!rawTarget) {
            console.error("consolidate-undo: missing <target> argument");
            process.exitCode = 1;
            return;
          }
          // Expand `~` first (gotcha #17 — Node's fs doesn't do this
          // automatically).  Accept either an absolute path or a path
          // relative to the configured memory directory so operators
          // can point at the file the way they would in a text editor
          // or via `ls`.
          const expandedTarget = expandTildePath(rawTarget);
          const targetPath = path.isAbsolute(expandedTarget)
            ? expandedTarget
            : path.join(orchestrator.config.memoryDir, expandedTarget);

          const { runConsolidationUndo, formatConsolidationUndoResult } = await import(
            "./consolidation-undo.js"
          );
          const result = await runConsolidationUndo({
            storage: orchestrator.storage,
            memoryDir: orchestrator.config.memoryDir,
            targetPath,
            versioning: {
              enabled: orchestrator.config.versioningEnabled,
              maxVersionsPerPage: orchestrator.config.versioningMaxPerPage,
              sidecarDir: orchestrator.config.versioningSidecarDir,
            },
            dryRun,
          });
          console.log(formatConsolidationUndoResult(result));
          if (result.error) {
            process.exitCode = 1;
          }
        });

      cmd
        .command("questions")
        .description("List open questions from memory extraction")
        .option("-a, --all", "Show all questions including resolved")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const showAll = options.all === true;
          const questions = await orchestrator.storage.readQuestions({ unresolvedOnly: !showAll });
          if (questions.length === 0) {
            console.log(showAll ? "No questions found." : "No unresolved questions.");
            return;
          }
          console.log(`\n=== Questions (${questions.length}) ===\n`);
          for (const q of questions) {
            const status = q.resolved ? "[RESOLVED]" : `[priority: ${q.priority.toFixed(2)}]`;
            console.log(`  ${q.id} ${status}`);
            console.log(`    ${q.question}`);
            console.log(`    Context: ${q.context}`);
            console.log();
          }
        });

      cmd
        .command("identity")
        .description("Show agent identity reflections")
        .action(async () => {
          const workspaceDir = path.join(resolveHomeDir(), ".openclaw", "workspace");
          const identity = await orchestrator.storage.readIdentity(workspaceDir);
          if (!identity) {
            console.log("No identity file found.");
            return;
          }
          console.log(identity);
        });

      const continuityCmd = cmd
        .command("continuity")
        .description("Identity continuity incident workflow commands");

      continuityCmd
        .command("incidents")
        .description("List continuity incidents")
        .option("--state <state>", "Filter by state: open|closed|all", "open")
        .option("--limit <number>", "Maximum incidents to list", "25")
        .action(async (...args: unknown[]) => {
          if (!orchestrator.config.identityContinuityEnabled) {
            console.log("Identity continuity is disabled.");
            return;
          }
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const stateRaw = String(options.state ?? "open").toLowerCase();
          const state: "open" | "closed" | "all" =
            stateRaw === "closed" || stateRaw === "all" ? stateRaw : "open";
          const limit = Math.max(1, Math.min(200, parseInt(String(options.limit ?? "25"), 10) || 25));
          const filtered = await orchestrator.storage.readContinuityIncidents(limit, state);
          if (filtered.length === 0) {
            console.log(`No continuity incidents found for state=${state}.`);
            return;
          }
          console.log(`=== Continuity Incidents (${filtered.length}, state=${state}) ===\n`);
          for (const incident of filtered) {
            console.log(formatContinuityIncidentCli(incident));
            console.log();
          }
        });

      continuityCmd
        .command("incident-open")
        .description("Open a continuity incident")
        .option("--symptom <text>", "Required symptom description")
        .option("--trigger-window <window>", "Optional incident trigger window")
        .option("--suspected-cause <text>", "Optional suspected cause")
        .action(async (...args: unknown[]) => {
          if (!orchestrator.config.identityContinuityEnabled) {
            console.log("Identity continuity is disabled.");
            return;
          }
          if (!orchestrator.config.continuityIncidentLoggingEnabled) {
            console.log("Continuity incident logging is disabled.");
            return;
          }
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const symptom = String(options.symptom ?? "").trim();
          if (!symptom) {
            console.log("Missing required --symptom.");
            return;
          }
          const created = await orchestrator.storage.appendContinuityIncident({
            symptom,
            triggerWindow: options.triggerWindow ? String(options.triggerWindow) : undefined,
            suspectedCause: options.suspectedCause ? String(options.suspectedCause) : undefined,
          });
          console.log("Opened continuity incident:\n");
          console.log(formatContinuityIncidentCli(created));
        });

      continuityCmd
        .command("incident-close")
        .description("Close a continuity incident")
        .option("--id <id>", "Required incident ID")
        .option("--fix-applied <text>", "Required fix description")
        .option("--verification-result <text>", "Required verification result")
        .option("--preventive-rule <text>", "Optional preventive rule")
        .action(async (...args: unknown[]) => {
          if (!orchestrator.config.identityContinuityEnabled) {
            console.log("Identity continuity is disabled.");
            return;
          }
          if (!orchestrator.config.continuityIncidentLoggingEnabled) {
            console.log("Continuity incident logging is disabled.");
            return;
          }
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const id = String(options.id ?? "").trim();
          const fixApplied = String(options.fixApplied ?? "").trim();
          const verificationResult = String(options.verificationResult ?? "").trim();
          const preventiveRule = options.preventiveRule ? String(options.preventiveRule).trim() : undefined;

          if (!id) {
            console.log("Missing required --id.");
            return;
          }
          if (!fixApplied) {
            console.log("Missing required --fix-applied.");
            return;
          }
          if (!verificationResult) {
            console.log("Missing required --verification-result.");
            return;
          }

          const closed = await orchestrator.storage.closeContinuityIncident(id, {
            fixApplied,
            verificationResult,
            preventiveRule,
          });
          if (!closed) {
            console.log(`Incident not found: ${id}`);
            return;
          }
          console.log("Closed continuity incident:\n");
          console.log(formatContinuityIncidentCli(closed));
        });

      cmd
        .command("access-stats")
        .description("Show memory access statistics")
        .option("-n, --top <number>", "Show top N most accessed", "20")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, string>;
          const top = parseInt(options.top ?? "20", 10);

          const memories = await orchestrator.storage.readAllMemories();
          const withAccess = memories.filter((m) => m.frontmatter.accessCount && m.frontmatter.accessCount > 0);

          if (withAccess.length === 0) {
            console.log("No access tracking data yet. Memories will be tracked as they are retrieved.");
            return;
          }

          // Sort by access count descending
          const sorted = withAccess.sort(
            (a, b) => (b.frontmatter.accessCount ?? 0) - (a.frontmatter.accessCount ?? 0),
          );

          console.log(`\n=== Top ${Math.min(top, sorted.length)} Most Accessed Memories ===\n`);
          for (const m of sorted.slice(0, top)) {
            const lastAccessed = m.frontmatter.lastAccessed
              ? new Date(m.frontmatter.lastAccessed).toLocaleDateString()
              : "unknown";
            console.log(`  ${m.frontmatter.accessCount}x  [${m.frontmatter.category}] ${m.content.slice(0, 80)}`);
            console.log(`       Last accessed: ${lastAccessed}  ID: ${m.frontmatter.id}`);
            console.log();
          }

          // Summary stats
          const totalAccess = withAccess.reduce((sum, m) => sum + (m.frontmatter.accessCount ?? 0), 0);
          console.log(`Total accesses tracked: ${totalAccess}`);
          console.log(`Memories with access data: ${withAccess.length} / ${memories.length}`);
        });

      cmd
        .command("flush-access")
        .description("Flush pending access tracking updates to disk")
        .action(async () => {
          await orchestrator.flushAccessTracking();
          console.log("Access tracking buffer flushed.");
        });

      cmd
        .command("importance")
        .description("Show importance score distribution across memories")
        .option("-l, --level <level>", "Filter by importance level (critical, high, normal, low, trivial)")
        .option("-n, --top <number>", "Show top N memories by importance", "15")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, string>;
          const filterLevel = options.level;
          const top = parseInt(options.top ?? "15", 10);

          const memories = await orchestrator.storage.readAllMemories();
          const withImportance = memories.filter((m) => m.frontmatter.importance);

          if (withImportance.length === 0) {
            console.log("No importance data yet. Importance is scored during extraction.");
            return;
          }

          // Count by level
          const levelCounts: Record<string, number> = {
            critical: 0,
            high: 0,
            normal: 0,
            low: 0,
            trivial: 0,
          };
          for (const m of withImportance) {
            const level = m.frontmatter.importance?.level ?? "normal";
            levelCounts[level] = (levelCounts[level] ?? 0) + 1;
          }

          console.log("\n=== Importance Distribution ===\n");
          for (const [level, count] of Object.entries(levelCounts)) {
            const bar = "█".repeat(Math.min(count, 50));
            console.log(`  ${level.padEnd(10)} ${count.toString().padStart(4)} ${bar}`);
          }
          console.log(`\n  Total scored: ${withImportance.length} / ${memories.length} memories\n`);

          // Filter by level if specified
          let filtered = withImportance;
          if (filterLevel) {
            filtered = withImportance.filter(
              (m) => m.frontmatter.importance?.level === filterLevel,
            );
            if (filtered.length === 0) {
              console.log(`No memories with importance level: ${filterLevel}`);
              return;
            }
          }

          // Sort by importance score descending
          const sorted = filtered.sort(
            (a, b) =>
              (b.frontmatter.importance?.score ?? 0) -
              (a.frontmatter.importance?.score ?? 0),
          );

          const heading = filterLevel
            ? `Top ${Math.min(top, sorted.length)} "${filterLevel}" Importance Memories`
            : `Top ${Math.min(top, sorted.length)} Most Important Memories`;
          console.log(`=== ${heading} ===\n`);

          for (const m of sorted.slice(0, top)) {
            const imp = m.frontmatter.importance!;
            console.log(
              `  ${imp.score.toFixed(2)} [${imp.level}] [${m.frontmatter.category}]`,
            );
            console.log(`    ${m.content.slice(0, 100)}`);
            if (imp.keywords.length > 0) {
              console.log(`    Keywords: ${imp.keywords.join(", ")}`);
            }
            console.log();
          }
        });
      cmd
        .command("topics")
        .description("Show extracted topics from memory corpus")
        .option("-n, --top <number>", "Show top N topics", "20")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, string>;
          const top = parseInt(options.top ?? "20", 10);

          const { topics, updatedAt } = await orchestrator.storage.loadTopics();

          if (topics.length === 0) {
            console.log("No topics extracted yet. Topics are extracted during consolidation.");
            return;
          }

          console.log(`\n=== Top ${Math.min(top, topics.length)} Topics ===`);
          console.log(`Last updated: ${updatedAt ?? "unknown"}\n`);

          for (const topic of topics.slice(0, top)) {
            const bar = "█".repeat(Math.min(Math.round(topic.score * 10), 30));
            console.log(`  ${topic.term.padEnd(20)} ${topic.score.toFixed(3)} (${topic.count}x) ${bar}`);
          }
        });

      cmd
        .command("summaries")
        .description("Show memory summaries")
        .option("-n, --top <number>", "Show top N most recent summaries", "5")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, string>;
          const top = parseInt(options.top ?? "5", 10);

          const summaries = await orchestrator.storage.readSummaries();

          if (summaries.length === 0) {
            console.log("No summaries yet. Summaries are created during consolidation when memory count exceeds threshold.");
            return;
          }

          // Sort by createdAt desc
          const sorted = summaries.sort(
            (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
          );

          console.log(`\n=== Memory Summaries (${Math.min(top, sorted.length)} of ${sorted.length}) ===\n`);

          for (const summary of sorted.slice(0, top)) {
            console.log(`  ${summary.id}`);
            console.log(`    Created: ${summary.createdAt}`);
            console.log(`    Time range: ${summary.timeRangeStart.slice(0, 10)} to ${summary.timeRangeEnd.slice(0, 10)}`);
            console.log(`    Source memories: ${summary.sourceEpisodeIds.length}`);
            console.log(`    Key facts: ${summary.keyFacts.length}`);
            console.log(`\n    Summary: ${summary.summaryText.slice(0, 200)}...`);
            console.log();
          }
        });

      cmd
        .command("threads")
        .description("Show conversation threads")
        .option("-n, --top <number>", "Show top N most recent threads", "10")
        .option("-t, --thread <id>", "Show details for a specific thread")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, string>;
          const threadId = options.thread;
          const top = parseInt(options.top ?? "10", 10);

          const memoryDir = path.join(resolveHomeDir(), ".openclaw", "workspace", "memory", "local");
          const threading = new ThreadingManager(path.join(memoryDir, "threads"));

          if (threadId) {
            const thread = await threading.loadThread(threadId);
            if (!thread) {
              console.log(`Thread not found: ${threadId}`);
              return;
            }

            console.log(`\n=== Thread: ${thread.title} ===\n`);
            console.log(`  ID: ${thread.id}`);
            console.log(`  Created: ${thread.createdAt}`);
            console.log(`  Updated: ${thread.updatedAt}`);
            console.log(`  Session: ${thread.sessionKey ?? "(none)"}`);
            console.log(`  Episodes: ${thread.episodeIds.length}`);

            if (thread.episodeIds.length > 0) {
              console.log("\n  Episode IDs:");
              for (const id of thread.episodeIds.slice(0, 20)) {
                console.log(`    - ${id}`);
              }
              if (thread.episodeIds.length > 20) {
                console.log(`    ... and ${thread.episodeIds.length - 20} more`);
              }
            }

            if (thread.linkedThreadIds.length > 0) {
              console.log("\n  Linked threads:");
              for (const id of thread.linkedThreadIds) {
                console.log(`    - ${id}`);
              }
            }
            return;
          }

          const threads = await threading.getAllThreads();

          if (threads.length === 0) {
            console.log("No conversation threads yet. Enable threading with threadingEnabled: true");
            return;
          }

          console.log(`\n=== Conversation Threads (${Math.min(top, threads.length)} of ${threads.length}) ===\n`);
          for (const thread of threads.slice(0, top)) {
            const updated = new Date(thread.updatedAt).toLocaleString();
            console.log(`  ${thread.title}`);
            console.log(`    ID: ${thread.id}`);
            console.log(`    Episodes: ${thread.episodeIds.length} | Updated: ${updated}`);
            console.log();
          }
        });

      cmd
        .command("chunks")
        .description("Show chunking statistics and orphaned chunks")
        .option("-p, --parent <id>", "Show chunks for a specific parent memory ID")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, string>;
          const parentId = options.parent;

          const memories = await orchestrator.storage.readAllMemories();

          if (parentId) {
            // Show chunks for specific parent
            const chunks = memories
              .filter((m) => m.frontmatter.parentId === parentId)
              .sort((a, b) => (a.frontmatter.chunkIndex ?? 0) - (b.frontmatter.chunkIndex ?? 0));

            if (chunks.length === 0) {
              console.log(`No chunks found for parent: ${parentId}`);
              return;
            }

            const parent = memories.find((m) => m.frontmatter.id === parentId);
            console.log(`\n=== Chunks for ${parentId} ===\n`);
            if (parent) {
              console.log(`Parent: ${parent.content.slice(0, 100)}...`);
              console.log();
            }

            for (const chunk of chunks) {
              console.log(
                `  [${(chunk.frontmatter.chunkIndex ?? 0) + 1}/${chunk.frontmatter.chunkTotal}] ${chunk.content.slice(0, 80)}...`,
              );
            }
            return;
          }

          // Show overall chunking stats
          const chunked = memories.filter((m) => m.frontmatter.tags?.includes("chunked"));
          const chunks = memories.filter((m) => m.frontmatter.parentId);

          // Find orphaned chunks (parent no longer exists)
          const parentIds = new Set(chunked.map((m) => m.frontmatter.id));
          const orphans = chunks.filter((m) => !parentIds.has(m.frontmatter.parentId!));

          console.log("\n=== Chunking Statistics ===\n");
          console.log(`  Chunked memories (parents): ${chunked.length}`);
          console.log(`  Total chunks: ${chunks.length}`);
          console.log(`  Orphaned chunks: ${orphans.length}`);

          if (chunked.length > 0) {
            // Calculate average chunks per parent
            const avgChunks = chunks.length / chunked.length;
            console.log(`  Average chunks per parent: ${avgChunks.toFixed(1)}`);
          }

          if (orphans.length > 0) {
            console.log("\n  Orphaned chunk IDs:");
            for (const orphan of orphans.slice(0, 10)) {
              console.log(`    - ${orphan.frontmatter.id}`);
            }
            if (orphans.length > 10) {
              console.log(`    ... and ${orphans.length - 10} more`);
            }
          }
        });

      // Transcript commands
      cmd
        .command("transcript")
        .description("View conversation transcripts")
        .option("--date <date>", "View transcript for specific date (YYYY-MM-DD)")
        .option("--recent <duration>", "View recent transcript (e.g., 12h, 30m)")
        .option("--channel <key>", "Filter by channel/session key")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, string>;
          const date = options.date;
          const recent = options.recent;
          let channel = options.channel;

          // Expand shorthand channel names to full sessionKey patterns
          if (channel && !channel.includes(":")) {
            // Convert "main" -> "agent:generalist:main"
            // Convert "discord" -> "agent:generalist:discord" (will match all discord channels)
            // Convert "cron" -> "agent:generalist:cron" (will match all cron jobs)
            if (channel === "main") {
              channel = "agent:generalist:main";
            } else if (["discord", "slack", "cron", "telegram"].includes(channel)) {
              channel = `agent:generalist:${channel}`;
            }
          }

          if (date) {
            // Read specific date
            const entries = await orchestrator.transcript.readRange(
              `${date}T00:00:00Z`,
              `${date}T23:59:59Z`,
              channel,
            );
            console.log(formatTranscript(entries));
          } else if (recent) {
            // Parse duration (e.g., "12h", "30m")
            const hours = parseDuration(recent);
            const entries = await orchestrator.transcript.readRecent(hours, channel);
            console.log(formatTranscript(entries));
          } else {
            // Default: show today's transcript
            const today = new Date().toISOString().slice(0, 10);
            const entries = await orchestrator.transcript.readRange(
              `${today}T00:00:00Z`,
              `${today}T23:59:59Z`,
              channel,
            );
            console.log(formatTranscript(entries));
          }
        });

      // Checkpoint command
      cmd
        .command("checkpoint")
        .description("View current compaction checkpoint (if any)")
        .action(async () => {
          const checkpoint = await orchestrator.transcript.loadCheckpoint();
          if (!checkpoint) {
            console.log("No active checkpoint found.");
            return;
          }
          console.log(`Checkpoint for session: ${checkpoint.sessionKey}`);
          console.log(`Captured at: ${checkpoint.capturedAt}`);
          console.log(`Expires at: ${checkpoint.ttl}`);
          console.log(`Turns: ${checkpoint.turns.length}`);
          console.log("\n---\n");
          console.log(orchestrator.transcript.formatForRecall(checkpoint.turns, 2000));
        });

      // Summaries command
      cmd
        .command("hourly")
        .description("View hourly summaries")
        .option("--channel <key>", "Filter by channel/session key")
        .option("--recent <hours>", "Show recent summaries (hours)")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, string>;
          const channel = options.channel ?? "default";
          const recentHours = options.recent ? parseInt(options.recent, 10) : 24;

          const summaries = await orchestrator.summarizer.readRecent(channel, recentHours);
          if (summaries.length === 0) {
            console.log(`No summaries found for channel: ${channel}`);
            return;
          }

          console.log(orchestrator.summarizer.formatForRecall(summaries, summaries.length));
        });

      // ── Review subcommand (issue #520) ──────────────────────────────────
      const reviewCmd = cmd.command("review").description("Manage contradiction review queue");

      reviewCmd
        .command("list")
        .description("List contradiction review items")
        .option("--filter <type>", "Filter: all, unresolved, contradicts, independent, duplicates, needs-user", "unresolved")
        .option("--namespace <ns>", "Filter by namespace")
        .option("--limit <n>", "Max items (default 50)", "50")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, string>;
          const filter = options.filter ?? "unresolved";
          const validFilters = ["all", "unresolved", "contradicts", "independent", "duplicates", "needs-user"];
          if (!validFilters.includes(filter)) {
            console.error(`Invalid filter: ${filter}. Must be one of: ${validFilters.join(", ")}`);
            process.exit(1);
          }
          const limit = parseInt(options.limit ?? "50", 10);
          const { listPairs } = await import("./contradiction/contradiction-review.js");
          const result = listPairs(orchestrator.config.memoryDir, {
            filter: filter as "all" | "unresolved" | "contradicts" | "independent" | "duplicates" | "needs-user",
            namespace: options.namespace,
            limit: Number.isFinite(limit) ? limit : 50,
          });
          if (result.pairs.length === 0) {
            console.log("No review items found.");
            return;
          }
          console.log(`Found ${result.total} item(s) (${result.durationMs}ms):\n`);
          for (const pair of result.pairs) {
            console.log(`  [${pair.verdict}] ${pair.pairId}`);
            console.log(`    Memories: ${pair.memoryIds.join(", ")}`);
            console.log(`    Rationale: ${pair.rationale}`);
            console.log(`    Confidence: ${pair.confidence.toFixed(2)}`);
            if (pair.resolution) console.log(`    Resolution: ${pair.resolution}`);
            console.log();
          }
        });

      reviewCmd
        .command("show <pairId>")
        .description("Show details of a contradiction pair")
        .action(async (...args: unknown[]) => {
          const pairId = typeof args[0] === "string" ? args[0] : "";
          if (!pairId) {
            console.error("pairId is required");
            process.exit(1);
          }
          const { readPair } = await import("./contradiction/contradiction-review.js");
          const pair = readPair(orchestrator.config.memoryDir, pairId);
          if (!pair) {
            console.error(`Pair ${pairId} not found.`);
            process.exit(1);
          }
          console.log(JSON.stringify(pair, null, 2));
        });

      reviewCmd
        .command("resolve <pairId>")
        .description("Resolve a contradiction pair")
        .requiredOption("--verb <verb>", "Resolution verb: keep-a, keep-b, merge, both-valid, needs-more-context")
        .option("--merged-memory-id <id>", "Existing merged memory ID to use when --verb merge")
        .option("--merged-content <content>", "Content for a new merged memory when --verb merge")
        .action(async (...args: unknown[]) => {
          const pairId = typeof args[0] === "string" ? args[0] : "";
          const cmdOpts = (args[1] ?? {}) as Record<string, string | undefined>;
          if (!pairId) {
            console.error("pairId is required");
            process.exit(1);
          }
          const verb = cmdOpts.verb;
          if (!verb) {
            console.error("--verb is required. Must be one of: keep-a, keep-b, merge, both-valid, needs-more-context");
            process.exit(1);
          }
          const { isValidResolutionVerb, executeResolution } = await import("./contradiction/resolution.js");
          if (!isValidResolutionVerb(verb)) {
            console.error(`Invalid verb: ${verb}. Must be one of: keep-a, keep-b, merge, both-valid, needs-more-context`);
            process.exit(1);
          }
          const result = await executeResolution(orchestrator.config.memoryDir, orchestrator.storage, pairId, verb, {
            mergedMemoryId: cmdOpts.mergedMemoryId,
            mergedContent: cmdOpts.mergedContent,
            storageForNamespace: (namespace) => {
              const requested = namespace?.trim();
              if (!orchestrator.config.namespacesEnabled) {
                if (requested && requested !== orchestrator.config.defaultNamespace) {
                  throw new Error(`unsupported namespace: ${requested}`);
                }
                return orchestrator.storage;
              }
              return orchestrator.getStorageForNamespace(requested || orchestrator.config.defaultNamespace);
            },
          });
          console.log(result.message);
          if (result.affectedIds.length > 0) {
            console.log(`Affected: ${result.affectedIds.join(", ")}`);
          }
        });

      reviewCmd
        .command("scan")
        .description("Run an on-demand contradiction scan")
        .option("--namespace <ns>", "Namespace to scan")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, string>;
          const { runContradictionScan } = await import("./contradiction/contradiction-scan.js");
          console.log("Running contradiction scan...");
          const result = await runContradictionScan({
            storage: orchestrator.storage,
            config: orchestrator.config,
            memoryDir: orchestrator.config.memoryDir,
            embeddingLookupFactory: (storage) => {
              if (!orchestrator.config.embeddingFallbackEnabled) return undefined;
              return async (content: string, limit: number) => {
                try {
                  return await orchestrator.semanticDedupLookup(content, limit, storage);
                } catch {
                  return [];
                }
              };
            },
            storageForNamespace: async (namespace) => {
              const resolvedNamespace =
                namespace?.trim() ||
                (orchestrator.config.namespacesEnabled ? orchestrator.config.defaultNamespace : undefined);
              const storage = await orchestrator.getStorageForNamespace(resolvedNamespace);
              return { storage, namespace: resolvedNamespace };
            },
            localLlm: orchestrator.localLlm ?? null,
            fallbackLlm: orchestrator.fastGatewayLlm ?? null,
            namespace: options.namespace,
          });
          console.log(`Scan complete in ${result.elapsedMs}ms:`);
          console.log(`  Scanned: ${result.scanned} memories`);
          console.log(`  Candidates: ${result.candidates} pairs`);
          console.log(`  Judged: ${result.judged}`);
          console.log(`  Queued: ${result.queued}`);
          console.log(`  Cooled down: ${result.cooledDown}`);
        });

      // ── Dreams subcommand (issue #678 PR 3+4) ───────────────────────────
      // `remnic dreams status` — per-phase telemetry for the last N hours.
      // `remnic dreams run`    — manually invoke a single phase pass.
      const dreamsCmd = cmd.command("dreams").description("Inspect and manually trigger Dreams consolidation pipeline phases");

      dreamsCmd
        .command("status")
        .description("Show per-phase Dreams telemetry for the last N hours")
        .option("--window-hours <n>", "Look-back window in hours (default 24)", "24")
        .option("--format <fmt>", "Output format: text, json, markdown (default text)", "text")
        .option("--namespace <ns>", "Namespace to inspect (default: current default namespace)")
        .option("--principal <principal>", "Trusted principal for namespace ACLs (defaults to config/env)")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, string>;
          const fmt = options.format ?? "text";
          if (fmt !== "text" && fmt !== "json" && fmt !== "markdown") {
            console.error(`Invalid --format '${fmt}'. Must be one of: text, json, markdown`);
            process.exit(1);
          }
          const { normalizeDreamsStatusWindowHours } = await import("./maintenance/dreams-ledger.js");
          let windowHours: number;
          const rawWindowHours = options.windowHours;
          try {
            if (typeof rawWindowHours !== "string" || rawWindowHours.trim() === "") {
              throw new Error("missing window");
            }
            windowHours = normalizeDreamsStatusWindowHours(Number(rawWindowHours));
          } catch {
            console.error("--window-hours must be a positive integer");
            process.exit(1);
          }
          const accessService = new EngramAccessService(orchestrator);
          const result = await accessService.dreamsStatus({
            windowHours,
            namespace: typeof options.namespace === "string" ? options.namespace : undefined,
            principal: resolveAccessPrincipalOverride(
              options.principal,
              orchestrator.config.agentAccessHttp.principal,
            ),
          });

          if (fmt === "json") {
            console.log(JSON.stringify(result, null, 2));
            return;
          }

          const phaseLabels: Record<string, string> = {
            lightSleep: "Light Sleep",
            rem: "REM",
            deepSleep: "Deep Sleep",
          };

          if (fmt === "markdown") {
            console.log(`## Dreams Status (last ${windowHours}h)\n`);
            console.log(`Window: ${result.windowStart} → ${result.windowEnd}\n`);
            console.log("| Phase | Runs | Total Duration | Items Processed | Last Run |");
            console.log("|-------|------|----------------|-----------------|----------|");
            for (const phase of ["lightSleep", "rem", "deepSleep"] as const) {
              const p = result.phases[phase];
              const lastRun = p.lastRunAt ? p.lastRunAt.slice(0, 19).replace("T", " ") : "—";
              console.log(
                `| ${phaseLabels[phase]} | ${p.runCount} | ${p.totalDurationMs}ms | ${p.totalItemsProcessed} | ${lastRun} |`,
              );
            }
            return;
          }

          // text format
          console.log(`Dreams status (last ${windowHours}h):`);
          console.log(`  Window: ${result.windowStart} → ${result.windowEnd}\n`);
          for (const phase of ["lightSleep", "rem", "deepSleep"] as const) {
            const p = result.phases[phase];
            const label = phaseLabels[phase];
            console.log(`  ${label}:`);
            console.log(`    Runs:            ${p.runCount}`);
            console.log(`    Total duration:  ${p.totalDurationMs}ms`);
            console.log(`    Items processed: ${p.totalItemsProcessed}`);
            console.log(`    Last run:        ${p.lastRunAt ?? "—"}`);
            console.log();
          }
        });

      dreamsCmd
        .command("run")
        .description("Manually invoke a single Dreams phase pass")
        .requiredOption("--phase <phase>", "Phase to run: light-sleep, rem, deep-sleep")
        .option("--dry-run", "Preview without committing writes")
        .option("--format <fmt>", "Output format: text, json (default text)", "text")
        .option("--namespace <ns>", "Namespace to run in (default: current default namespace)")
        .option("--principal <principal>", "Trusted principal for namespace ACLs (defaults to config/env)")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, string | boolean>;
          const phaseInput = typeof options.phase === "string" ? options.phase : "";
          if (
            "dryRun" in options &&
            options.dryRun !== undefined &&
            typeof options.dryRun !== "boolean"
          ) {
            console.error("--dry-run must be a boolean flag");
            process.exit(1);
          }
          const dryRun = options.dryRun === true;
          const fmt = typeof options.format === "string" ? options.format : "text";

          if (fmt !== "text" && fmt !== "json") {
            console.error(`Invalid --format '${fmt}'. Must be one of: text, json`);
            process.exit(1);
          }

          // Accept both kebab-case (light-sleep) and camelCase (lightSleep).
          const phaseMap: Record<string, string> = {
            "light-sleep": "lightSleep",
            lightsleep: "lightSleep",
            lightSleep: "lightSleep",
            rem: "rem",
            REM: "rem",
            "deep-sleep": "deepSleep",
            deepsleep: "deepSleep",
            deepSleep: "deepSleep",
          };
          const phase = phaseMap[phaseInput] as import("./maintenance/dreams-ledger.js").DreamsPhase | undefined;
          if (!phase) {
            console.error(
              `Invalid --phase '${phaseInput}'. Must be one of: light-sleep, rem, deep-sleep`,
            );
            process.exit(1);
          }

          const accessService = new EngramAccessService(orchestrator);
          const result = await accessService.dreamsRun({
            phase,
            dryRun,
            namespace: typeof options.namespace === "string" ? options.namespace : undefined,
            authenticatedPrincipal: resolveAccessPrincipalOverride(
              options.principal,
              orchestrator.config.agentAccessHttp.principal,
            ),
          });

          if (fmt === "json") {
            console.log(JSON.stringify(result, null, 2));
            return;
          }

          const phaseLabel = { lightSleep: "Light Sleep", rem: "REM", deepSleep: "Deep Sleep" }[phase];
          console.log(`Dreams run: ${phaseLabel}${dryRun ? " (dry-run)" : ""}`);
          console.log(`  Duration:   ${result.durationMs}ms`);
          console.log(`  Items:      ${result.itemsProcessed}`);
          if (result.notes) {
            console.log(`  Notes:      ${result.notes}`);
          }
        });

      // ── Secure-store subcommand (issue #690 PR 2/4) ─────────────────────
      // CLI for the at-rest encryption header + in-memory keyring. Pure
      // primitives (KDF + cipher + metadata) shipped in PR 1/4. This PR
      // wires the operator-facing init / unlock / lock / status flow.
      // Storage integration (PR 3/4) and capsule export --encrypt (PR 4/4)
      // build on the keyring registered here.
      const secureStoreCmd = cmd
        .command("secure-store")
        .description(
          "At-rest encryption keyring (issue #690). Manage the secure-store header and the in-memory master key used by the running daemon.",
        );

      secureStoreCmd
        .command("init")
        .description(
          "Initialize a new secure-store header. Prompts for a passphrase, derives a master key via Argon2id by default, and writes the verifier to <memoryDir>/.secure-store/header.json. Refuses to overwrite an existing header.",
        )
        .option("--kdf <algorithm>", "KDF algorithm: argon2id (default) or scrypt", "argon2id")
        .option("--note <text>", "Optional human-readable note recorded in metadata. Never include secrets.")
        .option("--json", "Emit machine-readable JSON only")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const {
            runSecureStoreInit,
            createPassphraseReader,
            renderInitReport,
          } = await import("./secure-store/index.js");
          const memoryDir = expandTildePath(orchestrator.config.memoryDir);
          const kdf = typeof options.kdf === "string" ? options.kdf.trim() : "argon2id";
          if (kdf !== "argon2id" && kdf !== "scrypt") {
            console.error(`Invalid --kdf '${String(options.kdf)}'. Must be one of: argon2id, scrypt`);
            process.exit(1);
          }
          const initOpts: Parameters<typeof runSecureStoreInit>[0] = {
            memoryDir,
            readPassphrase: createPassphraseReader(),
            algorithm: kdf,
          };
          if (typeof options.note === "string") initOpts.note = options.note;
          const report = await runSecureStoreInit(initOpts);
          if (options.json === true) {
            console.log(JSON.stringify(report, null, 2));
            return;
          }
          console.log(renderInitReport(report));
        });

      secureStoreCmd
        .command("unlock")
        .description(
          "Unlock the secure-store. Prompts for the passphrase, validates it against the header verifier, and registers the master key in the daemon's in-memory keyring. The key is cleared on `lock`, daemon restart, or process exit.",
        )
        .option("--json", "Emit machine-readable JSON only")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const {
            runSecureStoreUnlock,
            createPassphraseReader,
            renderUnlockReport,
          } = await import("./secure-store/index.js");
          const memoryDir = expandTildePath(orchestrator.config.memoryDir);
          const report = await runSecureStoreUnlock({
            memoryDir,
            readPassphrase: createPassphraseReader(),
          });
          if (options.json === true) {
            console.log(JSON.stringify(report, null, 2));
          } else {
            console.log(renderUnlockReport(report));
          }
          if (!report.ok) {
            process.exitCode = 1;
          }
        });

      secureStoreCmd
        .command("lock")
        .description(
          "Lock the secure-store. Clears the master key from the daemon's in-memory keyring. Idempotent — succeeds even if the store is already locked.",
        )
        .option("--json", "Emit machine-readable JSON only")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const { runSecureStoreLock, renderLockReport } = await import(
            "./secure-store/index.js"
          );
          const memoryDir = expandTildePath(orchestrator.config.memoryDir);
          const report = runSecureStoreLock({ memoryDir });
          if (options.json === true) {
            console.log(JSON.stringify(report, null, 2));
            return;
          }
          console.log(renderLockReport(report));
        });

      secureStoreCmd
        .command("migrate")
        .description(
          "Encrypt existing plaintext storage-managed memory files in an initialized, unlocked secure-store. Idempotent; already-encrypted files are skipped.",
        )
        .option("--json", "Emit machine-readable JSON only")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const { runSecureStoreMigrate, renderMigrateReport } = await import(
            "./secure-store/index.js"
          );
          const memoryDir = expandTildePath(orchestrator.config.memoryDir);
          const report = await runSecureStoreMigrate({ memoryDir });
          if (options.json === true) {
            console.log(JSON.stringify(report, null, 2));
          } else {
            console.log(renderMigrateReport(report));
          }
          if (!report.ok) {
            process.exitCode = 1;
          }
        });

      async function runSecureStoreDisableCommand(options: Record<string, unknown>): Promise<void> {
        const { runSecureStoreDisable, renderDisableReport } = await import(
          "./secure-store/index.js"
        );
        const memoryDir = expandTildePath(orchestrator.config.memoryDir);
        const report = await runSecureStoreDisable({ memoryDir });
        if (options.json === true) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          console.log(renderDisableReport(report));
        }
        if (!report.ok) {
          process.exitCode = 1;
        }
      }

      secureStoreCmd
        .command("disable")
        .description(
          "Decrypt storage-managed secure-store files back to plaintext. Requires an initialized, unlocked secure-store and keeps .secure-store metadata in place.",
        )
        .option("--json", "Emit machine-readable JSON only")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          await runSecureStoreDisableCommand(options);
        });

      secureStoreCmd
        .command("decrypt")
        .description("Alias for `secure-store disable`.")
        .option("--json", "Emit machine-readable JSON only")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          await runSecureStoreDisableCommand(options);
        });

      secureStoreCmd
        .command("status")
        .description(
          "Report secure-store status: whether a header exists, whether the daemon currently holds the key, KDF parameters, and last-unlock timestamp.",
        )
        .option("--json", "Emit machine-readable JSON only")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const { runSecureStoreStatus, renderStatusReport } = await import(
            "./secure-store/index.js"
          );
          const memoryDir = expandTildePath(orchestrator.config.memoryDir);
          const report = await runSecureStoreStatus({ memoryDir });
          if (options.json === true) {
            console.log(JSON.stringify(report, null, 2));
            return;
          }
          console.log(renderStatusReport(report));
        });

      // ── Peer Registry subcommand (issue #679 PR 4/5) ────────────────────
      const peerCmd = cmd.command("peer").description("Manage the peer registry (issue #679).");

      peerCmd
        .command("list")
        .description("List all registered peers")
        .option("--json", "Emit machine-readable JSON only")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const { listPeers } = await import("./peers/index.js");
          const peers = await listPeers(orchestrator.config.memoryDir);
          if (options.json === true) {
            console.log(JSON.stringify({ peers }, null, 2));
            return;
          }
          if (peers.length === 0) {
            console.log("No peers registered.");
            return;
          }
          console.log(`${peers.length} peer(s):\n`);
          for (const p of peers) {
            console.log(`  ${p.id} (${p.kind})  ${p.displayName}`);
            console.log(`    created: ${p.createdAt}  updated: ${p.updatedAt}`);
          }
        });

      peerCmd
        .command("show <id>")
        .description("Show a peer's identity record")
        .option("--json", "Emit machine-readable JSON only")
        .action(async (...args: unknown[]) => {
          const id = typeof args[0] === "string" ? args[0] : "";
          const options = (args[1] ?? {}) as Record<string, unknown>;
          if (!id) {
            console.error("peer id is required");
            process.exit(1);
          }
          const peersShow = await import("./peers/index.js");
          const validateIdShow: (id: unknown) => void = peersShow.assertValidPeerId;
          try {
            validateIdShow(id);
          } catch (err) {
            console.error(`Invalid peer id: ${(err as Error).message}`);
            process.exit(1);
          }
          const peer = await peersShow.readPeer(orchestrator.config.memoryDir, id);
          if (!peer) {
            console.error(`Peer "${id}" not found.`);
            process.exit(1);
          }
          if (options.json === true) {
            console.log(JSON.stringify(peer, null, 2));
            return;
          }
          console.log(`Peer: ${peer.id}`);
          console.log(`  Kind:         ${peer.kind}`);
          console.log(`  Display name: ${peer.displayName}`);
          console.log(`  Created:      ${peer.createdAt}`);
          console.log(`  Updated:      ${peer.updatedAt}`);
          if (peer.notes) {
            console.log(`  Notes:\n${peer.notes.split("\n").map((l) => `    ${l}`).join("\n")}`);
          }
        });

      peerCmd
        .command("set <id>")
        .description("Create or update a peer identity record")
        // Cursor H (PR #756 round 2): no Commander default for --kind. A
        // default would make `options.kind` always present, so the CLI
        // would forward kind on every call — including updates where
        // the user only set --display-name. peerSet treats kind as
        // immutable on update, but forcing the default also overrides
        // any future change to the service-layer create-time default.
        // Let the service own the default; the CLI only forwards an
        // explicit --kind flag.
        .option("--kind <kind>", "Peer kind: self | human | agent | integration (only on first write)")
        .option("--display-name <name>", "Human-readable display name")
        .option("--notes <text>", "Optional free-form markdown notes")
        .option("--json", "Emit machine-readable JSON only")
        .action(async (...args: unknown[]) => {
          const id = typeof args[0] === "string" ? args[0] : "";
          const options = (args[1] ?? {}) as Record<string, unknown>;
          if (!id) {
            console.error("peer id is required");
            process.exit(1);
          }
          // Cursor L (PR #756 review): route through EngramAccessService.peerSet
          // so the CLI shares the canonical create-or-update flow (existence
          // check, kind validation, immutable-field preservation, notes/displayName
          // merge) with HTTP and MCP. Reimplementing here previously risked
          // silent divergence when the service-layer semantics changed.
          const peerSetService = new EngramAccessService(orchestrator);
          try {
            const result = await peerSetService.peerSet({
              id,
              ...(typeof options.kind === "string" ? { kind: options.kind } : {}),
              ...(typeof options.displayName === "string" ? { displayName: options.displayName } : {}),
              ...(typeof options.notes === "string" ? { notes: options.notes } : {}),
            });
            if (options.json === true) {
              console.log(JSON.stringify(result, null, 2));
              return;
            }
            console.log(`${result.created ? "Created" : "Updated"} peer "${id}".`);
          } catch (err) {
            console.error(`Failed to set peer: ${(err as Error).message}`);
            process.exit(1);
          }
        });

      peerCmd
        .command("delete <id>")
        .description("Delete a peer's identity record (idempotent; directory and profile are preserved)")
        .option("--json", "Emit machine-readable JSON only")
        .action(async (...args: unknown[]) => {
          const id = typeof args[0] === "string" ? args[0] : "";
          const options = (args[1] ?? {}) as Record<string, unknown>;
          if (!id) {
            console.error("peer id is required");
            process.exit(1);
          }
          // Cursor M (PR #756 review): route through EngramAccessService.peerDelete
          // so the CLI gets the same `assertPeerDirNotEscaped` + symlink + parent-
          // inode-stable guards used by HTTP and MCP. The previous direct
          // `path.join` + `fs.unlink` bypassed the storage module's protections
          // and would have followed a symlinked `peers/<id>/` to an arbitrary
          // `identity.md` outside `memoryDir`.
          const peerDeleteService = new EngramAccessService(orchestrator);
          try {
            const result = await peerDeleteService.peerDelete(id);
            if (options.json === true) {
              console.log(JSON.stringify(result, null, 2));
              return;
            }
            console.log(result.deleted ? `Deleted peer "${id}".` : `Peer "${id}" not found (no-op).`);
          } catch (err) {
            console.error(`Failed to delete peer: ${(err as Error).message}`);
            process.exit(1);
          }
        });

      // ── peer forget (issue #679 completion) ────────────────────────────
      peerCmd
        .command("forget <id>")
        .description(
          "DESTRUCTIVELY purge the entire peer directory (identity.md + profile.md + " +
          "interactions.log.md and any other companion files). Requires --confirm yes. " +
          "Idempotent: safe to run twice.",
        )
        .option(
          "--confirm <value>",
          'Confirmation guard — must be exactly "yes" to proceed',
        )
        .option("--json", "Emit machine-readable JSON only")
        .action(async (...args: unknown[]) => {
          const id = typeof args[0] === "string" ? args[0] : "";
          const options = (args[1] ?? {}) as Record<string, unknown>;
          if (!id) {
            console.error("peer id is required");
            process.exit(1);
          }
          // Gotcha #14 — validate --confirm argument exists and equals "yes"
          // exactly. An absent or non-"yes" value must refuse the operation
          // rather than silently proceeding or defaulting.
          const confirm = typeof options.confirm === "string" ? options.confirm : "";
          if (confirm !== "yes") {
            console.error(
              `peer forget: refuses to run without --confirm yes (got ${
                confirm.length > 0 ? JSON.stringify(confirm) : "<not provided>"
              }). ` +
              "This operation permanently removes all peer data.",
            );
            process.exit(1);
          }
          const peerForgetService = new EngramAccessService(orchestrator);
          try {
            const result = await peerForgetService.peerForget(id, { confirm: "yes" });
            if (options.json === true) {
              console.log(JSON.stringify(result, null, 2));
              return;
            }
            console.log(
              result.purged
                ? `Purged all data for peer "${id}".`
                : `Peer "${id}" directory not found (no-op).`,
            );
          } catch (err) {
            console.error(`Failed to forget peer: ${(err as Error).message}`);
            process.exit(1);
          }
        });

      peerCmd
        .command("profile <id>")
        .description("Show the evolving cognitive profile for a peer")
        .option("--json", "Emit machine-readable JSON only")
        .action(async (...args: unknown[]) => {
          const id = typeof args[0] === "string" ? args[0] : "";
          const options = (args[1] ?? {}) as Record<string, unknown>;
          if (!id) {
            console.error("peer id is required");
            process.exit(1);
          }
          const peersProfile = await import("./peers/index.js");
          const validateIdProfile: (id: unknown) => void = peersProfile.assertValidPeerId;
          try {
            validateIdProfile(id);
          } catch (err) {
            console.error(`Invalid peer id: ${(err as Error).message}`);
            process.exit(1);
          }
          const profile = await peersProfile.readPeerProfile(orchestrator.config.memoryDir, id);
          if (!profile) {
            console.error(`No profile found for peer "${id}". The profile is written by the async reasoner.`);
            process.exit(1);
          }
          if (options.json === true) {
            console.log(JSON.stringify(profile, null, 2));
            return;
          }
          console.log(`Profile for peer: ${id}`);
          console.log(`  Updated: ${profile.updatedAt}`);
          const fieldKeys = Object.keys(profile.fields);
          if (fieldKeys.length === 0) {
            console.log("  No profile fields yet.");
          } else {
            for (const k of fieldKeys) {
              console.log(`  ${k}:`);
              console.log(`    ${profile.fields[k]}`);
            }
          }
        });

      // ── peer migrate (issue #679 PR 5/5) ────────────────────────────────
      peerCmd
        .command("migrate")
        .description(
          "Migrate legacy identity-anchor data into peers/self/identity.md (issue #679 PR 5/5). " +
          "Idempotent: safe to run multiple times. Use --dry-run to preview without writing.",
        )
        .option("--dry-run", "Preview the proposed peer record without writing anything to disk")
        .option("--display-name <name>", "Override the default display name for the self peer (default: \"Self\")")
        .option("--json", "Emit machine-readable JSON result")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const isDryRun = options.dryRun === true;
          const displayName =
            typeof options.displayName === "string" && options.displayName.length > 0
              ? options.displayName
              : undefined;
          const { migrateFromIdentityAnchor } = await import("./peers/migrate-from-identity-anchor.js");
          let result;
          try {
            result = await migrateFromIdentityAnchor({
              memoryDir: orchestrator.config.memoryDir,
              dryRun: isDryRun,
              ...(displayName !== undefined ? { displayName } : {}),
            });
          } catch (err) {
            console.error(`Migration failed: ${(err as Error).message}`);
            process.exit(1);
          }
          if (options.json === true) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          if (result.skipped) {
            console.log(`Peer "self" already exists — migration skipped (idempotent).`);
            console.log(`  peers/self/identity.md is unchanged.`);
            return;
          }
          if (result.dryRun) {
            console.log(`[dry-run] Migration preview — nothing was written.`);
            console.log(`  Proposed peer id:   ${result.peer.id}`);
            console.log(`  Proposed kind:      ${result.peer.kind}`);
            console.log(`  Proposed name:      ${result.peer.displayName}`);
            if (result.identityAnchorSource) {
              console.log(`  Would read anchor:  ${result.identityAnchorSource}`);
            }
            if (result.identityMdSource) {
              console.log(`  Would read identity:${result.identityMdSource}`);
            }
            if (!result.identityAnchorSource && !result.identityMdSource) {
              console.log(`  No legacy source files found — self peer would be created with no notes.`);
            }
            return;
          }
          // Written successfully.
          console.log(`Migrated identity-anchor data to peers/self/identity.md.`);
          if (result.identityAnchorSource) {
            console.log(`  Read anchor:  ${result.identityAnchorSource}`);
          }
          if (result.identityMdSource) {
            console.log(`  Read identity:${result.identityMdSource}`);
          }
          if (!result.identityAnchorSource && !result.identityMdSource) {
            console.log(`  No legacy source files found — self peer created with no notes.`);
          }
          console.log(`\nLegacy identity-anchor files are untouched. Verify the migration result`);
          console.log(`with \`remnic peer show self\` before archiving legacy files.`);
        });

      // ── Console subcommand (issue #688) ─────────────────────────────────
      // PR 1/3 (#721) shipped the structured engine-state aggregator
      // and the `--state-only` flag (one-shot JSON snapshot). PR 2/3
      // wires the interactive TUI: invoking `remnic console` with no
      // flags starts a clear+repaint refresh loop. Trace replay
      // (`--trace <session-id>`) lands in PR 3/3 along with the HTTP
      // `/console/state` endpoint and the MCP `engram.console_state`
      // tool.
      cmd
        .command("console")
        .description(
          "Operator console (issue #688). With no flags: launches the interactive TUI. With --state-only: prints a single JSON snapshot. With --record-trace <path>: appends every snapshot to a JSONL file. With --trace <path>: replays a recorded trace at the original cadence (or --speed N).",
        )
        .option(
          "--state-only",
          "Print a single console-state snapshot as JSON and exit",
        )
        .option(
          "--record-trace <path>",
          "Append every snapshot to <path> as JSONL while the TUI runs",
        )
        .option(
          "--trace <path>",
          "Replay a recorded JSONL trace file frame-by-frame at the original cadence",
        )
        .option(
          "--speed <multiplier>",
          "Replay speed multiplier (default 1.0). 2.0 = twice as fast; 0.5 = half speed.",
        )
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          if (options.stateOnly === true) {
            const { gatherConsoleState } = await import("./console/state.js");
            const snapshot = await gatherConsoleState(orchestrator);
            console.log(JSON.stringify(snapshot, null, 2));
            return;
          }
          // Replay mode: fully sandboxed, no orchestrator state read.
          if (typeof options.trace === "string" && options.trace.length > 0) {
            const { replayTrace, parseSpeedFlag } = await import(
              "./console/trace.js"
            );
            const { expandTildePath } = await import("./utils/path.js");
            const tracePath = expandTildePath(options.trace);
            let speed: number;
            try {
              speed = parseSpeedFlag(options.speed);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`remnic console: ${msg}`);
              process.exitCode = 2;
              return;
            }
            // Codex P2: mirror the live TUI's SIGINT handling so
            // Ctrl-C aborts replay cleanly. Without this, Node's
            // default SIGINT terminates the process before
            // `replayTrace`'s `finally` block restores the cursor,
            // leaving the terminal in a hidden-cursor state.
            const replayAbort = new AbortController();
            const replaySigintHandler = () => replayAbort.abort();
            process.on("SIGINT", replaySigintHandler);
            try {
              await replayTrace(tracePath, {
                speed,
                signal: replayAbort.signal,
              });
            } finally {
              try {
                process.removeListener("SIGINT", replaySigintHandler);
              } catch {
                // ignore
              }
            }
            return;
          }
          // Live TUI mode, optionally with trace recording.
          const { runConsoleTui } = await import("./console/tui.js");
          let recorder:
            | {
                append: (snapshot: import("./console/state.js").ConsoleStateSnapshot) => Promise<void>;
                close: (signal?: AbortSignal) => Promise<void>;
              }
            | null = null;
          if (
            typeof options.recordTrace === "string" &&
            options.recordTrace.length > 0
          ) {
            const { openTraceRecorder } = await import("./console/trace.js");
            const { expandTildePath } = await import("./utils/path.js");
            recorder = await openTraceRecorder(
              expandTildePath(options.recordTrace),
            );
          }
          const handle = runConsoleTui(orchestrator, {
            traceRecorder: recorder ?? undefined,
          });
          try {
            await handle.done;
          } finally {
            if (recorder) {
              // Codex P1 (PR #732 follow-up): `recorder.close()`
              // drains the internal writeChain, which can block
              // indefinitely on a wedged network-backed filesystem.
              // Race the drain against a 2s deadline so Ctrl-C exits
              // the CLI cleanly even when a write is stuck. If the
              // timeout wins, log a warning so the operator knows
              // some final frames may have been lost and shutdown
              // proceeds. `flushWithTimeout` returns a structured
              // result instead of throwing so shutdown ordering stays
              // deterministic.
              const CLOSE_TIMEOUT_MS = 2000;
              const { flushWithTimeout } = await import("./console/trace.js");
              const flushResult = await flushWithTimeout(
                (signal) => recorder!.close(signal),
                CLOSE_TIMEOUT_MS,
              );
              if (flushResult.timedOut) {
                console.warn(
                  `[remnic console] trace flush timed out after ${CLOSE_TIMEOUT_MS}ms; some final frames may be lost`,
                );
              }
              // Codex P2 (PR #732 round 5): surface flush errors at
              // warn level so operators learn about I/O failures instead
              // of silently losing them. The error message is
              // stringified (not spread with %o) to avoid accidentally
              // logging object internals that might contain paths or
              // other sensitive strings.
              if (flushResult.error != null) {
                const msg =
                  flushResult.error instanceof Error
                    ? flushResult.error.message
                    : String(flushResult.error);
                console.warn(
                  `[remnic console] trace flush error: ${msg}`,
                );
              }
            }
          }
        });
    },
    { commands: ["engram"] },
  );
}

function formatTranscript(entries: TranscriptEntry[]): string {
  if (entries.length === 0) return "No transcript entries found.";

  return entries
    .map((e) => {
      const time = e.timestamp.slice(11, 16); // HH:MM
      return `[${time}] ${e.role}: ${e.content.slice(0, 200)}${e.content.length > 200 ? "..." : ""}`;
    })
    .join("\n");
}

function parseDuration(duration: string): number {
  // Parse strings like "12h", "30m", "2h30m"
  const hours = duration.match(/(\d+)h/);
  const minutes = duration.match(/(\d+)m/);
  let total = 0;
  if (hours) total += parseInt(hours[1], 10);
  if (minutes) total += parseInt(minutes[1], 10) / 60;
  return total || 12; // Default to 12 hours
}
