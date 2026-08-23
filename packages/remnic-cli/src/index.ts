/**
 * @remnic/cli
 *
 * Command-line interface for Remnic memory.
 *
 * Commands:
 *   init              Create remnic.config.json in the current directory
 *   status            Show server/daemon status
 *   query/xray <text> Query memories; xray renders tier + filters + scores
 *   who-knows <topic> Rank entities by expertise on a topic
 *   wearables <cmd>   Wearable transcript sources (Limitless / Bee / Omi)
 *   location <cmd>    Location day sync (status | check | sync | backfill | day)
 *   doctor            Run diagnostics
 *   config            Show current config
 *   daemon <cmd>      start | stop | restart | status | install | uninstall the system service
 *   token <cmd>       generate | list | revoke auth tokens for a connector
 *   bench list        List published benchmark packs
 *   bench run         Run published benchmark packs
 *   bench publish     Generate the Remnic.ai benchmark feed
 *   bench ui          Launch the local benchmark overview UI
 *   bench attribute   Attribute failures to memory operations; drift-gen validates drift corpora
 *   tree              Generate context tree
 *   onboard [dir]     Onboard project directory
 *   curate <path>     Curate files into memory
 *   review            Review inbox management
 *   sync              Diff-aware sync
 *   dedup             Find duplicate memories
 *   promotion-candidates  List agent-subject memories ready to promote to a shared layer
 *   connectors        Manage host adapters
 *   oauth <cmd>       Manage pending OAuth authorizations (ChatGPT MCP)
 */

import { persistEnrichmentCandidate } from "./enrichment-persist.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { writeFile as fsWriteFile } from "node:fs/promises";
import * as childProcess from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import {
  parseConfig,
  type PluginConfig,
  isOpenaiApiKeyDisabled,
  resolveEnvVars,
  resolveRemnicConfigRecord,
  Orchestrator,
  EngramAccessService,
  initLogger,
  onboard,
  curate,
  listReviewItems,
  performReview,
  syncChanges,
  watchForChanges,
  findDuplicates,
  listConnectors,
  installConnector,
  removeConnector,
  doctorConnector,
  generateToken,
  listTokens,
  revokeToken,
  listSpaces,
  getActiveSpace,
  createSpace,
  deleteSpace,
  switchSpace,
  pushToSpace,
  pullFromSpace,
  shareSpace,
  promoteSpace,
  getAuditLog,
  getManifestPath,
  generateContextTree,
  migrateFromEngram,
  rollbackFromEngramMigration,
  buildBriefing,
  parseBriefingWindow,
  parseBriefingFocus,
  validateBriefingFormat,
  resolveBriefingSaveDir,
  briefingFilename,
  FileCalendarSource,
  listVersions,
  getVersion,
  revertToVersion,
  diffVersions,
  readManifest,
  writeManifest,
  createBackend,
  runBinaryLifecyclePipeline,
  DEFAULT_SCAN_PATTERNS,
  DEFAULT_MAX_BINARY_SIZE_BYTES,
  DEFAULT_GRACE_PERIOD_DAYS,
  publisherForConnector,
  hostIdForConnector,
  registerPublisher,
  PUBLISHERS,
  CodexMemoryExtensionPublisher,
  ClaudeCodeMemoryExtensionPublisher,
  HermesMemoryExtensionPublisher,
  DEFAULT_TAXONOMY,
  resolveCategory,
  generateResolverDocument,
  loadTaxonomy,
  saveTaxonomy,
  validateSlug,
  validateTaxonomy,
  getTaxonomyFilePath,
  generateMarketplaceManifest,
  checkMarketplaceManifest,
  writeMarketplaceManifest,
  installFromMarketplace,
  type MarketplaceInstallType,
  EnrichmentProviderRegistry,
  WebSearchProvider,
  runEnrichmentPipeline,
  appendAuditEntry,
  readAuditLog,
  defaultEnrichmentPipelineConfig,
  discoverMemoryExtensions,
  resolveExtensionsRoot,
  coerceInstallExtension,
  StorageManager,
  parseXrayCliOptions,
  renderXray,
  extractWhoKnowsRawArgs,
  parseWhoKnowsCliOptions,
  renderWhoKnows,
  type WhoKnowsResult,
  runAuditMemoryCliCommand, formatAuditMemoryReport,
  OFFLINE_SYNC_APPLY_MAX_BODY_BYTES,
  OFFLINE_SYNC_FILE_CONTENT_MAX_CHUNK_BYTES,
  OFFLINE_SYNC_FILE_CONTENT_TRANSFER_CHUNK_BYTES,
  OFFLINE_SYNC_SNAPSHOT_BASE_MAX_BODY_BYTES,
  applyOfflineSyncFileContentChunk, applyOfflineSyncSnapshot,
  buildOfflineSyncChangeset, runPromotionCandidatesCommand,
  buildOfflineSyncChangesetFromSnapshot,
  drainPendingLifecycleForOfflineSync,
  compileOfflineSyncExcludeGlobs,
  buildOfflineSyncSnapshotFromBase,
  defaultOfflineSyncStatePath,
  normalizeOfflineSyncSnapshot,
  offlineSyncStateFromSnapshot,
  readOfflineSyncFileContentChunk,
  readOfflineSyncState,
  shouldPreferIncomingOfflineRuntimeFile,
  summarizeOfflineSyncChangeset,
  summarizeOfflineSyncPendingChanges,
  summarizeOfflineSyncPendingFiles, writeOfflineSyncState,
  type OfflineSyncApplyFileContentChunkResult,
  type OfflineSyncFileDigest,
  type OfflineSyncFileRecord,
  type OfflineSyncFileState,
  type OfflineSyncFileTarget,
  type OfflineSyncFileWriteTarget,
  type OfflineSyncSnapshot,
  type OfflineSyncState,
  buildActionConfidenceInputFromOptions,
  evaluateActionConfidence,
  renderActionConfidenceText,
  expandTildePath,
  readCompatEnv,
  forkCapsule,
  readForkLineage,
  OPERATION_NAMES,
  validateCapabilitiesForMint,
} from "@remnic/core";
import { PLUGIN_ID as REMNIC_OPENCLAW_PLUGIN_ID, resolveRemnicPluginEntry } from "@remnic/core/plugin-id.js";
import { runMeetingsBinaryCommand } from "./commands/meetings.js"; import { runTimelineBinaryCommand } from "./commands/timeline.js"; import { runWearablesBinaryCommand } from "./commands/wearables.js"; import { runLocationBinaryCommand } from "./commands/location.js";
import { runOkfBinaryCommand } from "./commands/okf.js";
import { runExportOkfBinaryCommand } from "./commands/export-okf.js";
import { runCodegraphBinaryCommand } from "./commands/codegraph.js";
import { runStandupBinaryCommand } from "./commands/standup.js";
import { runJournalBinaryCommand } from "./commands/journal.js";
import { runJournalVaultBinaryCommand } from "./commands/journal-vault.js";
import { runActivityPrivacyBinaryCommand } from "./commands/activity-privacy.js";
import { runActivityExportBinaryCommand } from "./commands/activity-export.js";
import { runVaultPublishBinaryCommand } from "./commands/vault-publish.js";
import { runExternalWikiBinaryCommand } from "./commands/external-wiki.js";
import { runProceduralBinaryCommand } from "./commands/procedural.js";
import { runDriftBinaryCommand } from "./commands/drift.js";
import { runRecallNavigateCommand } from "./commands/recall-navigate.js";
// @remnic/export-weclone is an optional install surface (training:export
// only uses it). Load lazily so the CLI works without it — see
// optional-weclone-export.ts for the install-hint behaviour.
import { loadWecloneExportModule } from "./optional-weclone-export.js";
import { cmdConverge } from "./converge.js";
import {
  type ConfiguredNamespace,
  readConfiguredNamespace,
  buildNamespacePolicyCheck,
} from "./doctor-namespace-lint.js";
import { WriteQuarantineStore } from "@remnic/core/write-quarantine.js";
import { renderQuarantineList, type QuarantineFormat } from "./quarantine-cli.js";
import { runQuarantineReplay } from "./quarantine-replay.js";
import { drainOfflineSyncImpressions, resolveOfflineImpressionRotation, parseConfigQuietly, pickOfflineConfigRecord } from "./offline-impression-rotation.js";
import {
  createConfiguredOfflineStorage,
  createOfflineStorageForPath,
  createOfflineStorageIo,
  filterOfflineSyncBaseFiles,
  resolveOfflineDirectHydrationPath,
} from "./offline-storage-io.js";
import type {
  BinaryLifecycleConfig,
} from "@remnic/core";
import type {
  ActionConfidenceInput,
  MemoryExtensionPublisher,
  MemoryCategory,
  PublishContext,
  PublishResult,
  Taxonomy,
  TaxonomyCategory,
  TokenEntry,
} from "@remnic/core";
// @remnic/bench is an optional install surface. Import types only at the
// top level (erased at compile time); runtime access goes through
// loadBenchModule() / tryLoadBenchModule() so the CLI stays functional for
// users who never run `remnic bench *`.
import {
  assertBenchModuleFreshForDevelopment,
  loadBenchModule,
  tryLoadBenchModule,
} from "./optional-bench.js";
import { cmdSecurity } from "./cmd-security.js";
import {
  LAUNCHD_LABEL,
  LAUNCHD_LABEL_CANDIDATES,
  SYSTEMD_SERVICE,
  SYSTEMD_SERVICE_CANDIDATES,
  anyFileExists,
  launchdPlistPaths,
  systemdUnitPaths,
} from "./daemon-service-candidates.js";
import type {
  BenchConfig,
  BenchMemoryAdapter,
  BenchmarkDefinition,
  BenchmarkResult,
  ComparisonResult,
  McpMemoryToolMapping,
  PairedAnswerReplayCache,
  ResolvedLocalLabProfile,
} from "@remnic/bench";
import { firstSuccessfulCandidate, firstSuccessfulResult } from "./service-candidates.js";
import {
  type BenchAction,
  type ParsedBenchArgs,
  PUBLISHED_BENCHMARK_NAMES,
  createBenchWorkItems,
  deriveRuntimeProfilesFromBenchWorkItems,
  filterBenchWorkItemsForPreviousStatus,
  parseBenchActionArgs,
  parseBenchArgs,
} from "./bench-args.js";
import { readBenchOptionValue } from "./bench-flags.js";
import {
  assertCalibrationProvenanceMatches,
  validateCalibrationProvenancePinSet,
} from "./bench-calibration-binding.js";
import {
  createBenchStatusPath,
  initBenchStatus,
  updateBenchmarkStarted,
  updateBenchmarkCompleted,
  updateBenchmarkFailed,
  updateTaskProgress as updateBenchStatusTaskProgress,
  finalizeBenchStatus,
  findLatestBenchStatusFile,
  readBenchStatus,
} from "./bench-status.js";
import {
  buildBenchRunnerArgs,
  createFallbackBenchOutputDir,
  findUnsupportedFallbackBenchOptions,
  resolveFallbackBenchResultPath,
} from "./bench-fallback.js";
import {
  atomicWriteFileSync, cleanupRollbackDirectoryBestEffort,
  createOpenclawUpgradeRollbackFailure,
  runBestEffortGatewayRestart,
  rollbackOpenclawUpgrade,
  restoreOpenclawConfigWithRetry,
} from "./openclaw-upgrade-swap.js";
import type { OpenclawCommandRunner } from "@remnic/plugin-openclaw/managed-upgrade";
import {
  buildOpenclawManagedUpgradePackageSpec,
  loadOpenclawManagedUpgradeModule,
} from "./openclaw-managed-upgrade-loader.js";
import { expandTilde, resolveHomeDir } from "./path-utils.js";
import { resolveConfigPath } from "./config-path.js";
export { resolveConfigPath };
import {
  hostedOnlyDaemonRefusalMessage,
  probeDaemonHealth,
  printHealthCheck,
  remoteRecall,
  remoteRecallXray,
  resolveDaemonBaseUrl,
  resolveHostedOnlyDaemonRefusal,
  resolveOperatorToken,
  resolveRemoteDaemon,
  type RemoteRecallResult,
} from "./remote-daemon.js";
import {
  inspectLaunchdPlist,
  launchdLoadPlist,
  launchdUnloadPlist,
  readVerifiedDaemonPid,
  resolveServerBin,
  resolveServerBinDetails,
} from "./daemon-service.js";
export {
  hasFlag,
  parseTaxonomyResolveArgs,
  resolveFlag,
  stripResolveFlags,
  TAXONOMY_RESOLVE_BOOLEAN_FLAGS,
  TAXONOMY_RESOLVE_VALUE_FLAGS,
} from "./cli-args.js";
import {
  hasFlag,
  parseTaxonomyResolveArgs,
  resolveFlag,
} from "./cli-args.js";
import { parseConnectorConfig, stripConfigArgv } from "./parse-connector-config.js";
// `remnic import` top-level command (issue #568 slice 1). The adapter packages
// are optional à-la-carte installs loaded via computed-specifier dynamic
// import; slice 1 ships only the dispatcher and surfaces a clean install hint
// when an adapter package is absent.
import { cmdImport, IMPORT_USAGE } from "./import-dispatch.js";
import { cmdCapture } from "./capture-dispatch.js";
import { cmdImportLosslessClaw } from "./import-lossless-claw-cmd.js";

export { parseConnectorConfig, stripConfigArgv };
export {
  type BenchAction,
  type ParsedBenchArgs,
  parseBenchArgs,
} from "./bench-args.js";

export type { PairedAnswerReplayCache };
type PiPublisherModule = {
  PiMemoryExtensionPublisher: new () => MemoryExtensionPublisher;
  OmpMemoryExtensionPublisher: new () => MemoryExtensionPublisher;
  PrimeAgentMemoryExtensionPublisher: new () => MemoryExtensionPublisher;
};

/**
 * Lazily loads a Pi-family publisher class from the optional @remnic/plugin-pi
 * package so it is only imported when a Pi-family connector (pi, omp,
 * prime-agent) is actually installed. All hosts share one runtime extension
 * module; only the publisher class (install location + token) differs.
 */
class LazyPluginPiPublisher implements MemoryExtensionPublisher {
  private delegate: Promise<MemoryExtensionPublisher> | undefined;

  constructor(
    readonly hostId: string,
    private readonly select: (mod: PiPublisherModule) => new () => MemoryExtensionPublisher,
  ) {}

  async resolveExtensionRoot(env?: NodeJS.ProcessEnv): Promise<string> {
    return (await this.load()).resolveExtensionRoot(env);
  }

  async isHostAvailable(): Promise<boolean> {
    return (await this.load()).isHostAvailable();
  }

  async renderInstructions(ctx: PublishContext): Promise<string> {
    return (await this.load()).renderInstructions(ctx);
  }

  async publish(ctx: PublishContext): Promise<PublishResult> {
    return (await this.load()).publish(ctx);
  }

  async unpublish(): Promise<void> {
    return (await this.load()).unpublish();
  }

  private async load(): Promise<MemoryExtensionPublisher> {
    this.delegate ??= loadPiPublisherModule()
      .then((mod) => new (this.select(mod))())
      .catch((err) => {
        this.delegate = undefined;
        throw err;
      });
    return this.delegate;
  }
}

async function loadPiPublisherModule(): Promise<PiPublisherModule> {
  return await import("@remnic/plugin-pi/publisher") as PiPublisherModule;
}

// ── Host-specific publisher registrations ───────────────────────────────────
// Publisher classes live in @remnic/core, but wiring them into the registry
// belongs in the host adapter layer (CLAUDE.md gotcha #31).
registerPublisher("codex", () => new CodexMemoryExtensionPublisher());
registerPublisher("claude-code", () => new ClaudeCodeMemoryExtensionPublisher());
registerPublisher("hermes", () => new HermesMemoryExtensionPublisher());
registerPublisher("pi", () => new LazyPluginPiPublisher("pi", (mod) => mod.PiMemoryExtensionPublisher));
registerPublisher("omp", () => new LazyPluginPiPublisher("omp", (mod) => mod.OmpMemoryExtensionPublisher));
registerPublisher("prime-agent", () =>
  new LazyPluginPiPublisher("prime-agent", (mod) => mod.PrimeAgentMemoryExtensionPublisher));

type CommandName =
  | "init"
  | "migrate"
  | "status"
  | "query"
  | "recall"
  | "doctor"
  | "config"
  | "daemon"
  | "token"
  | "tree"
  | "onboard"
  | "curate"
  | "review"
  | "sync"
  | "dedup"
  | "connectors"
  | "quarantine"
  | "space"
  | "bench"
  | "benchmark"
  | "briefing"
  | "versions"
  | "binary"
  | "taxonomy"
  | "enrich"
  | "procedural"
  | "drift"
  | "openclaw"
  | "extensions"
  | "training:export"
  | "import"
  | "import-lossless-claw"
  | "action-confidence"
  | "xray"
  | "who-knows"
  | "promotion-candidates"
  | "security"
  | "wearables"
  | "meetings" | "timeline" | "okf" | "location" | "export" | "standup" | "journal" | "journal-vault" | "activity-privacy" | "activity-export" | "vault-publish" | "codegraph"
  | "external-wiki"
  | "capsule"
  | "offline"
  | "capture"
  | "oauth"
  | "converge";

type DaemonAction = "start" | "stop" | "restart" | "install" | "uninstall" | "status";
type TokenAction = "generate" | "list" | "revoke";
type ReviewAction = "approve" | "dismiss" | "flag";
export interface BenchCatalogEntry {
  id: string;
  title: string;
  category: "agentic" | "retrieval" | "conversational" | "ingestion";
  summary: string;
}

// ── Constants ────────────────────────────────────────────────────────────────



const PID_DIR = path.join(resolveHomeDir(), ".remnic");
const LEGACY_PID_DIR = path.join(resolveHomeDir(), ".engram");
const PID_FILE = path.join(PID_DIR, "server.pid");
const LEGACY_PID_FILE = path.join(LEGACY_PID_DIR, "server.pid");
const LOG_FILE = path.join(PID_DIR, "server.log");
const LEGACY_LOG_FILE = path.join(LEGACY_PID_DIR, "server.log");
const CLI_MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI_REPO_ROOT = path.resolve(CLI_MODULE_DIR, "../../..");
const EVAL_RUNNER_PATH = path.join(CLI_REPO_ROOT, "evals", "run.ts");
const OPENCLAW_GATEWAY_LABEL = "ai.openclaw.gateway";
// QMD teardown and cache reads can leave short-lived filesystem requests after
// successful one-shot commands; give them enough time to drain before forcing.
const CLI_SUCCESS_EXIT_GRACE_MS = 5_000;
const CLI_OUTPUT_FLUSH_GRACE_MS = 250;

export const BENCHMARK_CATALOG: BenchCatalogEntry[] = [
  {
    id: "ama-bench",
    title: "AMA-Bench",
    category: "agentic",
    summary: "Agent Memory Abilities benchmark for long-horizon agent workflows.",
  },
  {
    id: "memory-arena",
    title: "Memory Arena",
    category: "agentic",
    summary: "Interdependent multi-session tasks that stress operational recall.",
  },
  {
    id: "amemgym",
    title: "AMemGym",
    category: "agentic",
    summary: "Interactive personalization benchmark for agent memory adaptation.",
  },
  {
    id: "longmemeval",
    title: "LongMemEval",
    category: "retrieval",
    summary: "Long-term memory retrieval benchmark across core memory abilities.",
  },
  {
    id: "locomo",
    title: "LoCoMo",
    category: "conversational",
    summary: "Long-conversation memory benchmark for persistent dialogue context.",
  },
  {
    id: "beam",
    title: "BEAM",
    category: "retrieval",
    summary: "Beyond a Million Tokens benchmark for long-term memory abilities.",
  },
];

const BENCHMARK_IDS = new Set(BENCHMARK_CATALOG.map((entry) => entry.id));

type PackageBenchProviderConfig = {
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  retryOptions?: {
    maxAttempts?: number;
    baseBackoffMs?: number;
    timeoutMs?: number;
    max429WaitMs?: number;
  };
  temperature?: number;
  seed?: number;
  disableThinking?: boolean;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
};

type PackageBenchTaskSelector = {
  kind: "explicit-task-ids";
  taskIds: string[];
  expectedSelectedTaskIdsSha256: string;
};

type PackageBenchModule = {
  getBenchmark?: (id: string) => {
    runnerAvailable?: boolean;
    meta?: { category?: string };
  } | undefined;
  resolveBenchRuntimeProfile?: (
    options: ResolveBenchRuntimeProfileOptions,
  ) => Promise<ResolvedBenchRuntimeProfile>;
  resolveLocalLabJudgeProviderConfig?: (options: {
    localLabManifestPath: string;
    requestTimeout?: number;
    max429WaitMs?: number;
    disableThinking?: boolean;
  }) => Promise<PackageBenchProviderConfig>;
  runBenchmark?: (id: string, options: {
    mode?: "full" | "quick";
    datasetDir?: string;
    outputDir?: string;
    limit?: number;
    seed?: number;
    adapterMode?: string;
    runtimeProfile?: BenchRuntimeProfile | null;
    systemProvider?: PackageBenchProviderConfig | null;
    judgeProvider?: PackageBenchProviderConfig | null;
    internalProvider?: PackageBenchProviderConfig | null;
    remnicConfig?: Record<string, unknown>;
    benchmarkOptions?: Record<string, unknown>;
    amaBenchJudgeProtocol?: "default" | "recommended";
    amaBenchCrossJudge?: unknown;
    amaBenchCrossJudgeProvider?: PackageBenchProviderConfig | null;
    memCorrectJudge?: unknown;
    drainTimeoutMs?: number;
    noJudgeCache?: boolean;
    judgeCacheDir?: string;
    pairedAnswerReplayCache?: import("@remnic/bench").PairedAnswerReplayCache;
    system: {
      destroy(): Promise<void>;
    };
    ingestionAdapter?: unknown;
    onTaskComplete?: (task: { taskId: string; scores: Record<string, number>; latencyMs: number; tokens: { input: number; output: number } }, completedCount: number, totalCount?: number) => void;
  }) => Promise<{
    meta: { benchmark: string; mode: string };
    config: {
      runtimeProfile?: BenchRuntimeProfile | null;
      systemProvider?: PackageBenchProviderConfig | null;
      judgeProvider?: PackageBenchProviderConfig | null;
      internalProvider?: PackageBenchProviderConfig | null;
      adapterMode: string;
      remnicConfig: Record<string, unknown>;
      benchmarkOptions?: Record<string, unknown>;
    };
    results: { tasks: Array<unknown>; aggregates: Record<string, { mean: number }> };
    cost: { meanQueryLatencyMs: number };
  }>;
  runCustomBenchmarkFile?: (filePath: string, options: {
    mode?: "full" | "quick";
    outputDir?: string;
    limit?: number;
    seed?: number;
    adapterMode?: string;
    runtimeProfile?: BenchRuntimeProfile | null;
    systemProvider?: {
      provider: string;
      model: string;
      baseUrl?: string;
      apiKey?: string;
      disableThinking?: boolean;
      reasoningEffort?: "low" | "medium" | "high" | "xhigh";
    } | null;
    judgeProvider?: {
      provider: string;
      model: string;
      baseUrl?: string;
      apiKey?: string;
      disableThinking?: boolean;
      reasoningEffort?: "low" | "medium" | "high" | "xhigh";
    } | null;
    internalProvider?: {
      provider: string;
      model: string;
      baseUrl?: string;
      apiKey?: string;
      disableThinking?: boolean;
      reasoningEffort?: "low" | "medium" | "high" | "xhigh";
    } | null;
    remnicConfig?: Record<string, unknown>;
    system: {
      destroy(): Promise<void>;
    };
  }) => Promise<{
    meta: { benchmark: string; mode: string };
    config: {
      runtimeProfile?: BenchRuntimeProfile | null;
      systemProvider?: {
        provider: string;
        model: string;
        baseUrl?: string;
      } | null;
      judgeProvider?: {
        provider: string;
        model: string;
        baseUrl?: string;
        apiKey?: string;
        disableThinking?: boolean;
        reasoningEffort?: "low" | "medium" | "high" | "xhigh";
      } | null;
      internalProvider?: {
        provider: string;
        model: string;
        baseUrl?: string;
        apiKey?: string;
        disableThinking?: boolean;
        reasoningEffort?: "low" | "medium" | "high" | "xhigh";
      } | null;
      adapterMode: string;
      remnicConfig: Record<string, unknown>;
    };
    results: { tasks: Array<unknown>; aggregates: Record<string, { mean: number }> };
    cost: { meanQueryLatencyMs: number };
  }>;
  writeBenchmarkResult?: (result: {
    meta: { benchmark: string; mode: string };
    config: {
      runtimeProfile?: BenchRuntimeProfile | null;
      systemProvider?: {
        provider: string;
        model: string;
        baseUrl?: string;
      } | null;
      judgeProvider?: {
        provider: string;
        model: string;
        baseUrl?: string;
        apiKey?: string;
        disableThinking?: boolean;
        reasoningEffort?: "low" | "medium" | "high" | "xhigh";
      } | null;
      internalProvider?: {
        provider: string;
        model: string;
        baseUrl?: string;
        apiKey?: string;
        disableThinking?: boolean;
        reasoningEffort?: "low" | "medium" | "high" | "xhigh";
      } | null;
      adapterMode: string;
      remnicConfig: Record<string, unknown>;
    };
    results: { tasks: Array<unknown>; aggregates: Record<string, { mean: number }> };
    cost: { meanQueryLatencyMs: number };
  }, outputDir: string) => Promise<string>;
  redactBenchmarkResultSecrets?: <T>(result: T) => T;
  createProviderBackedAmaBenchRecommendedJudge?: (
    config: PackageBenchProviderConfig,
  ) => unknown;
  writeBenchmarkReproManifest?: (resultsDir: string, options?: {
    resultPaths?: string[];
    selectedBenchmarks?: string[];
    runtimeProfiles?: string[];
    selectedWorkItems?: Array<{
      benchmark: string;
      runtimeProfile: string;
    }>;
    mode?: "full" | "quick";
    limit?: number;
    seed?: number;
    datasetDirs?: Record<string, string | undefined>;
    command?: {
      cwd?: string;
      argv?: string[];
      env?: NodeJS.ProcessEnv;
      envKeys?: string[];
    };
    configFiles?: Array<{ label: string; path?: string }>;
    qmd?: {
      configDir?: string;
      cacheDir?: string;
      collections?: string[];
    };
  }) => Promise<string>;
  getRemnicVersion?: () => Promise<string>;
  createLightweightAdapter?: (options?: {
    configOverrides?: Record<string, unknown>;
    preserveRuntimeDefaults?: boolean;
    responder?: unknown;
    judge?: unknown;
    replayExtractionMode?: "await" | "background" | "skip";
  }) => Promise<{ destroy(): Promise<void> }>;
  createRemnicAdapter?: (options?: {
    configOverrides?: Record<string, unknown>;
    preserveRuntimeDefaults?: boolean;
    responder?: unknown;
    judge?: unknown;
    replayExtractionMode?: "await" | "background" | "skip";
  }) => Promise<{ destroy(): Promise<void> }>;
  createMcpMemoryAdapter?: (options: {
    transport:
      | { type: "stdio"; command: string; args?: string[] }
      | { type: "http"; url: string; bearerToken?: string };
    tools?: McpMemoryToolMapping;
    timeoutMs?: number;
  }) => Promise<{ destroy(): Promise<void> }>;
  createMcpDemoMemoryAdapter?: (options?: { timeoutMs?: number }) => Promise<{ destroy(): Promise<void> }>;
  createMcpDemoMemCorrectAdapter?: (options?: { timeoutMs?: number }) => Promise<{ destroy(): Promise<void> }>;
  createMcpMemCorrectAdapter?: (options: {
    transport:
      | { type: "stdio"; command: string; args?: string[] }
      | { type: "http"; url: string; bearerToken?: string };
    tools?: McpMemoryToolMapping;
    timeoutMs?: number;
  }) => Promise<{ destroy(): Promise<void> }>;
  createSyntheticEmailIngestionAdapter?: (options?: {
    system?: unknown;
  }) => unknown;
  loadLongMemEvalS?: (options: {
    mode: "full" | "quick";
    datasetDir?: string;
    limit?: number;
  }) => Promise<{
    source: "dataset" | "smoke" | "missing";
    filename?: string;
    items: unknown[];
    errors: string[];
  }>;
  loadLoCoMo10?: (options: {
    mode: "full" | "quick";
    datasetDir?: string;
    limit?: number;
  }) => Promise<{
    source: "dataset" | "smoke" | "missing";
    filename?: string;
    items: unknown[];
    errors: string[];
  }>;
  loadBeamDatasetPreview?: (options: {
    mode: "full" | "quick";
    datasetDir?: string;
    limit?: number;
  }) => Promise<{
    source: "dataset" | "smoke" | "missing";
    files: string[];
    items: number;
    tasks: number;
    errors: string[];
  }>;
  /**
   * Probe a single local-lab manifest role's endpoint before the benchmark
   * starts (issue #1573 PR2). Returns ok=true on success or ok=false with
   * a reason carrying the endpoint's actual model list on mismatch
   * (rule 51). Wired into the run path so operators get a clear error up
   * front instead of a mid-run failure.
   */
  preflightLocalLabRole?: (input: {
    provider: string;
    baseUrl: string;
    model: string;
    ctx: number;
  }, options?: { fetchImpl?: unknown; timeoutMs?: number }) => Promise<
    | { ok: true; expectedModel: string; discoveredModels: unknown[] }
    | { ok: false; reason: string; expectedModel: string; discoveredModels?: unknown[] }
  >;
  /** Load persisted calibration state. Optional identities and provenance bind
   * subsequent local artifacts to the calibrated pair and source. */
  loadJudgeCalibrationState?: (
    benchmarkId: string,
    calibrationDir: string,
  ) => Promise<
    | {
        kappa: number;
        sampleSize: number;
        threshold: number;
        warning: boolean;
        localJudgeProvider?: string;
        localJudgeModel?: string;
        frontierJudgeProvider?: string;
        frontierJudgeModel?: string;
        sourceResultId?: string;
        answerSetHash?: string;
        orderedQuestionIdsHash?: string;
        sliceQuestionIds?: readonly string[];
        confidenceInterval?: { lower: number; upper: number; level: number };
        bootstrapSamples?: number;
        localJudgeConfigHash?: string;
        frontierJudgeConfigHash?: string;
      }
    | undefined
  >;
};

interface TrainingExportOptions {
  memoryDir: string;
  since?: Date;
  until?: Date;
  minConfidence?: number;
  categories?: string[];
  includeEntities?: boolean;
}

interface TrainingExportRecord {
  instruction: string;
  input: string;
  output: string;
  category?: string;
  confidence?: number;
  sourceIds?: string[];
}

interface TrainingExportAdapter {
  name: string;
  formatRecords(records: TrainingExportRecord[]): string;
  fileExtension: string;
}

interface CoreTrainingExportRuntime {
  convertMemoriesToRecords(
    options: TrainingExportOptions,
  ): Promise<TrainingExportRecord[]>;
  getTrainingExportAdapter(name: string): TrainingExportAdapter | undefined; registerTrainingExportAdapter(adapter: TrainingExportAdapter): void;
  listTrainingExportAdapters(): string[];
  parseStrictCliDate(value: string, flag: string): Date;
}

async function loadTrainingExportCoreRuntime(): Promise<CoreTrainingExportRuntime> {
  return (await import("@remnic/core")) as unknown as CoreTrainingExportRuntime;
}

type BenchRuntimeProfile = "baseline" | "real" | "openclaw-chain" | "local-lab";

interface BenchProviderConfig {
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  retryOptions?: {
    maxAttempts?: number;
    baseBackoffMs?: number;
    timeoutMs?: number;
    max429WaitMs?: number;
  };
  disableThinking?: boolean;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  temperature?: number;
  seed?: number;
  responderContextBudgetChars?: number;
  responderPromptBudgetChars?: number;
}

interface ResolveBenchRuntimeProfileOptions {
  runtimeProfile?: BenchRuntimeProfile;
  remnicConfigPath?: string;
  openclawConfigPath?: string;
  modelSource?: "plugin" | "gateway";
  gatewayAgentId?: string;
  fastGatewayAgentId?: string;
  systemProvider?: string;
  systemModel?: string;
  systemBaseUrl?: string;
  systemApiKey?: string;
  systemCodexReasoningEffort?: "low" | "medium" | "high" | "xhigh";
  systemResponderContextBudgetChars?: number;
  systemResponderPromptBudgetChars?: number;
  judgeProvider?: string;
  judgeModel?: string;
  judgeBaseUrl?: string;
  judgeApiKey?: string;
  judgeCodexReasoningEffort?: "low" | "medium" | "high" | "xhigh";
  internalProvider?: string;
  internalModel?: string;
  internalBaseUrl?: string;
  internalApiKey?: string;
  internalDisableThinking?: boolean;
  internalCodexReasoningEffort?: "low" | "medium" | "high" | "xhigh";
  amaBenchJudgeProtocol?: "default" | "recommended";
  amaBenchCrossJudgeProvider?: string;
  amaBenchCrossJudgeModel?: string;
  amaBenchCrossJudgeBaseUrl?: string;
  amaBenchCrossJudgeApiKey?: string;
  amaBenchCrossJudgeCodexReasoningEffort?: "low" | "medium" | "high" | "xhigh";
  lcmObserveConcurrency?: number;
  requestTimeout?: number;
  drainTimeout?: number;
  max429WaitMs?: number;
  disableThinking?: boolean;
  /**
   * Path to a local-lab manifest JSON file (issue #1573 PR2). Required when
   * `runtimeProfile: "local-lab"`; on other profiles it binds the judge to the
   * normalized manifest config while preserving the selected responder.
   */
  localLabManifestPath?: string;
}

interface ResolvedBenchRuntimeProfile {
  profile: BenchRuntimeProfile;
  remnicConfig: Record<string, unknown>;
  effectiveRemnicConfig: Record<string, unknown>;
  adapterOptions: {
    configOverrides: Record<string, unknown>;
    preserveRuntimeDefaults?: boolean;
    responder?: unknown;
    judge?: unknown;
    drainTimeoutMs?: number;
  };
  systemProvider: BenchProviderConfig | null;
  judgeProvider: BenchProviderConfig | null;
  internalProvider: BenchProviderConfig | null;
  /**
   * Resolved local-lab profile (issue #1573 PR2). Present only when
   * `runtimeProfile: "local-lab"`. Drives sequential phase scheduling +
   * endpoint preflight in the bench runner.
   */
  localLab?: ResolvedLocalLabProfile;
}

interface BenchSummaryResult {
  meta: { benchmark: string; mode: string };
  config: {
    runtimeProfile?: BenchRuntimeProfile | null;
    adapterMode?: string;
    remnicConfig?: Record<string, unknown>;
  };
  results: {
    tasks: Array<unknown>;
    aggregates: Record<string, { mean: number }>;
  };
  cost: { meanQueryLatencyMs: number };
}

type PackageBenchAdapterFactory = NonNullable<
  PackageBenchModule["createLightweightAdapter"] | PackageBenchModule["createRemnicAdapter"]
>;

type PackageBenchAdapterMode = "lightweight" | "direct" | "mcp";

export interface PackageBenchExecutionPlan {
  runtime: ResolvedBenchRuntimeProfile;
  createAdapter: PackageBenchAdapterFactory;
  adapterMode: PackageBenchAdapterMode;
}


export function buildBenchRuntimeProfileRequest(
  parsed: ParsedBenchArgs,
  runtimeProfile: BenchRuntimeProfile,
): ResolveBenchRuntimeProfileOptions {
  return {
    runtimeProfile,
    remnicConfigPath:
      runtimeProfile === "real"
        ? resolveExistingBenchRemnicConfigPath(parsed.remnicConfigPath)
        : undefined,
    openclawConfigPath:
      runtimeProfile === "openclaw-chain"
        ? resolveExistingBenchOpenclawConfigPath(parsed.openclawConfigPath)
        : undefined,
    modelSource: runtimeProfile === "real" ? parsed.modelSource : undefined,
    gatewayAgentId: parsed.gatewayAgentId,
    fastGatewayAgentId: parsed.fastGatewayAgentId,
    systemProvider:
      runtimeProfile === "openclaw-chain"
        ? undefined
        : parsed.systemProvider,
    systemModel:
      runtimeProfile === "openclaw-chain"
        ? undefined
        : parsed.systemModel,
    systemBaseUrl:
      runtimeProfile === "openclaw-chain"
        ? undefined
        : parsed.systemBaseUrl,
    systemApiKey:
      runtimeProfile === "openclaw-chain"
        ? undefined
        : parsed.systemApiKey,
    systemCodexReasoningEffort:
      runtimeProfile === "openclaw-chain"
        ? undefined
        : parsed.systemCodexReasoningEffort,
    systemResponderContextBudgetChars:
      runtimeProfile === "openclaw-chain"
        ? undefined
        : parsed.systemResponderContextBudgetChars,
    systemResponderPromptBudgetChars:
      runtimeProfile === "openclaw-chain"
        ? undefined
        : parsed.systemResponderPromptBudgetChars,
    judgeProvider: parsed.judgeProvider,
    judgeModel: parsed.judgeModel,
    judgeBaseUrl: parsed.judgeBaseUrl,
    judgeApiKey:
      parsed.judgeApiKey ??
      (parsed.judgeProvider === "openai" ? process.env.OPENAI_API_KEY : undefined),
    judgeCodexReasoningEffort: parsed.judgeCodexReasoningEffort,
    internalProvider: parsed.internalProvider,
    internalModel: parsed.internalModel,
    internalBaseUrl: parsed.internalBaseUrl,
    internalApiKey: parsed.internalApiKey,
    internalDisableThinking: parsed.internalDisableThinking,
    internalCodexReasoningEffort: parsed.internalCodexReasoningEffort,
    requestTimeout: parsed.requestTimeout,
    drainTimeout: parsed.drainTimeout,
    max429WaitMs: parsed.max429WaitMs,
    disableThinking: parsed.disableThinking,
    lcmObserveConcurrency: parsed.publishedIngestConcurrency,
    localLabManifestPath: parsed.localLabManifestPath,
  };
}

const BENCH_STDOUT_REDACTED_SECRET = "[REDACTED]";
const BENCH_STDOUT_EXACT_SECRET_KEYS: ReadonlySet<string> = new Set([
  "authorization",
  "password",
  "secret",
  "token",
]);
const BENCH_STDOUT_SECRET_KEY_SUFFIXES: ReadonlySet<string> = new Set([
  "apikey",
  "authtoken",
  "accesstoken",
  "refreshtoken",
  "bearertoken",
  "clientsecret",
  "secretkey",
  "privatekey",
]);

function redactBenchResultForStdout<T>(
  benchModule: PackageBenchModule,
  result: T,
): T {
  return benchModule.redactBenchmarkResultSecrets?.(result) ??
    (redactBenchSecretsFallback(result) as T);
}

function redactBenchSecretsFallback(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactBenchSecretsFallback(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    redacted[key] = isBenchSecretKey(key)
      ? BENCH_STDOUT_REDACTED_SECRET
      : redactBenchSecretsFallback(nestedValue);
  }
  return redacted;
}

function isBenchSecretKey(key: string): boolean {
  const segments = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-z0-9]+/i)
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean);
  if (segments.length === 0) {
    return false;
  }

  const normalized = segments.join("");
  if (
    BENCH_STDOUT_EXACT_SECRET_KEYS.has(normalized) ||
    BENCH_STDOUT_SECRET_KEY_SUFFIXES.has(normalized)
  ) {
    return true;
  }

  const lastSegment = segments.at(-1);
  if (lastSegment && BENCH_STDOUT_EXACT_SECRET_KEYS.has(lastSegment)) {
    return true;
  }

  for (let width = 2; width <= Math.min(3, segments.length); width += 1) {
    const candidate = segments.slice(-width).join("");
    if (BENCH_STDOUT_SECRET_KEY_SUFFIXES.has(candidate)) {
      return true;
    }
  }

  return false;
}

function coerceBenchCategory(
  benchmarkId: string,
  category: string | undefined,
): BenchCatalogEntry["category"] {
  if (
    category === "agentic" ||
    category === "retrieval" ||
    category === "conversational" ||
    category === "ingestion"
  ) {
    return category;
  }

  return (
    BENCHMARK_CATALOG.find((entry) => entry.id === benchmarkId)?.category ??
    "retrieval"
  );
}

async function listBenchmarksFromPackage(): Promise<BenchCatalogEntry[] | undefined> {
  const result = await loadBenchDefinitionsFromPackage();
  if (!result) {
    return undefined;
  }

  return result.map((entry) => ({
    id: entry.id,
    title: entry.title ?? entry.id,
    category: coerceBenchCategory(entry.id, entry.meta?.category),
    summary: entry.meta?.description ?? "",
  }));
}

async function loadBenchDefinitionsFromPackage(): Promise<BenchmarkDefinition[] | undefined> {
  const benchModule = await tryLoadBenchModule();
  if (!benchModule || typeof benchModule.listBenchmarks !== "function") {
    return undefined;
  }
  const result = benchModule.listBenchmarks();
  return Array.isArray(result) ? result : undefined;
}

async function resolveAllBenchmarks(): Promise<string[]> {
  const packageBenchmarks = await loadBenchDefinitionsFromPackage();
  if (packageBenchmarks) {
    return packageBenchmarks
      .filter((entry) => entry.runnerAvailable)
      .map((entry) => entry.id);
  }

  if (!fs.existsSync(EVAL_RUNNER_PATH)) {
    return [];
  }

  return BENCHMARK_CATALOG
    .filter((entry) => entry.category !== "ingestion")
    .map((entry) => entry.id);
}

async function resolveKnownBenchmarkIds(): Promise<Set<string>> {
  const knownIds = new Set(BENCHMARK_IDS);
  const packageBenchmarks = await loadBenchDefinitionsFromPackage();
  if (packageBenchmarks) {
    for (const benchmark of packageBenchmarks) {
      knownIds.add(benchmark.id);
    }
  }
  return knownIds;
}

async function runBenchViaFallback(
  parsed: ParsedBenchArgs,
  benchmarkId: string,
  runtimeProfile: BenchRuntimeProfile,
): Promise<string> {
  if (parsed.taskIdsFile) {
    throw new Error(
      "Fallback benchmark runner does not support hash-pinned LoCoMo task selection. Build/install @remnic/bench to use --task-ids-file.",
    );
  }
  if (runtimeProfile === "real" && parsed.remnicConfigPath) {
    resolveExistingBenchRemnicConfigPath(parsed.remnicConfigPath);
  }
  if (runtimeProfile === "openclaw-chain" && parsed.openclawConfigPath) {
    resolveExistingBenchOpenclawConfigPath(parsed.openclawConfigPath);
  }
  if (runtimeProfile === "real") {
    throw new Error(
      'Fallback benchmark runner does not support --runtime-profile "real". Build/install @remnic/bench to use package-backed runtime profiles.',
    );
  }
  if (runtimeProfile === "openclaw-chain") {
    throw new Error(
      'Fallback benchmark runner does not support --runtime-profile "openclaw-chain". Build/install @remnic/bench to use package-backed runtime profiles.',
    );
  }
  if (runtimeProfile === "local-lab") {
    throw new Error(
      'Fallback benchmark runner does not support --runtime-profile "local-lab". Build/install @remnic/bench to use package-backed runtime profiles with local-lab manifests.',
    );
  }
  const unsupportedOptions = findUnsupportedFallbackBenchOptions(parsed);
  if (unsupportedOptions.length > 0) {
    throw new Error(
      `Fallback benchmark runner does not support provider-backed, gateway, or thinking/timeout flags (${unsupportedOptions.join(", ")}). Build/install @remnic/bench to use those options.`,
    );
  }
  if (!fs.existsSync(EVAL_RUNNER_PATH)) {
    console.error(
      "Benchmark runner not found. Expected eval runner at evals/run.ts or a phase-1 @remnic/bench runtime export.",
    );
    process.exit(1);
  }

  const tsxCandidates = [
    path.join(CLI_REPO_ROOT, "node_modules", ".bin", "tsx"),
    path.join(CLI_REPO_ROOT, "packages", "remnic-cli", "node_modules", ".bin", "tsx"),
  ];
  const tsxCmd = tsxCandidates.find((candidate) => fs.existsSync(candidate)) ?? "tsx";
  const fallbackOutputDir = createFallbackBenchOutputDir(
    parsed.resultsDir ?? resolveBenchOutputDir(),
    benchmarkId,
    process.pid,
  );
  const fallbackArgs = [
    EVAL_RUNNER_PATH,
    ...buildBenchRunnerArgs(parsed, benchmarkId, fallbackOutputDir),
  ];
  childProcess.execFileSync(tsxCmd, fallbackArgs, {
    stdio: "inherit",
    env: process.env,
  });
  return resolveFallbackBenchResultPath(fallbackOutputDir);
}

function resolveBenchOutputDir(): string {
  return path.join(resolveHomeDir(), ".remnic", "bench", "results");
}

const DOWNLOADABLE_BENCHMARK_DATASETS = [
  "ama-bench",
  "memory-arena",
  "amemgym",
  "longmemeval",
  "locomo",
  "beam",
  "personamem",
  "membench",
  "memoryagentbench",
] as const;

const MEMORY_ARENA_WEBSHOP_PRODUCT_SIDECAR_FILENAMES = [
  "webshop-products.jsonl",
  "webshop-products.json",
  "memory-arena-webshop-products.jsonl",
  "memory-arena-webshop-products.json",
] as const;

const MEMORY_AGENT_BENCH_BUNDLE_FILENAMES = [
  "memoryagentbench.json",
  "memoryagentbench.jsonl",
  "MemoryAgentBench.json",
  "MemoryAgentBench.jsonl",
] as const;

const MEMORY_AGENT_BENCH_SPLIT_FILENAMES = [
  "Accurate_Retrieval.json",
  "Accurate_Retrieval.jsonl",
  "accurate_retrieval.json",
  "accurate_retrieval.jsonl",
  "Test_Time_Learning.json",
  "Test_Time_Learning.jsonl",
  "test_time_learning.json",
  "test_time_learning.jsonl",
  "Long_Range_Understanding.json",
  "Long_Range_Understanding.jsonl",
  "long_range_understanding.json",
  "long_range_understanding.jsonl",
  "Conflict_Resolution.json",
  "Conflict_Resolution.jsonl",
  "conflict_resolution.json",
  "conflict_resolution.jsonl",
] as const;

const MEMORY_AGENT_BENCH_ENTITY_MAPPING_CANDIDATES = [
  "entity2id.json",
  path.join("processed_data", "Recsys_Redial", "entity2id.json"),
  path.join("Recsys_Redial", "entity2id.json"),
] as const;

type DownloadedDatasetMarker = {
  anyOf?: string[];
  allOf?: string[];
  ext?: string;
  exclude?: readonly string[];
};

// Required content markers per benchmark. `anyOf` lists the filenames
// a benchmark runner will accept — a dataset directory is considered
// "downloaded" as soon as any one of them is present. `allOf` lists
// required sidecar files. `ext` matches any file in the directory with
// the given extension. The filename sets mirror the dataset loaders
// under packages/bench/src/benchmarks so `datasets status` and
// `resolveBenchDatasetDir` never disagree with the runner about whether
// a dataset is ready.
const DOWNLOADED_DATASET_MARKERS: Record<string, DownloadedDatasetMarker> = {
  "ama-bench": { anyOf: ["open_end_qa_set.jsonl"] },
  longmemeval: {
    // Keep this list in lock-step with `LONG_MEM_EVAL_DATASET_FILENAMES`
    // in packages/bench/src/benchmarks/published/dataset-loader.ts so
    // `datasets status` never disagrees with the runner about what
    // counts as "downloaded".
    anyOf: [
      "longmemeval_s_cleaned.json",
      "longmemeval_s.json",
      "longmemeval.json",
      "longmemeval_oracle.json",
    ],
  },
  amemgym: {
    anyOf: ["amemgym-v1-base.json", "amemgym-tasks.json", "data.json"],
  },
  locomo: { anyOf: ["locomo10.json", "locomo.json"] },
  "memory-arena": {
    ext: ".jsonl",
    exclude: MEMORY_ARENA_WEBSHOP_PRODUCT_SIDECAR_FILENAMES,
  },
  beam: {
    anyOf: [
      "beam_100k.json",
      "beam_500k.json",
      "beam_1m.json",
      "beam_10m.json",
      "100k.json",
      "500k.json",
      "1m.json",
      "10m.json",
      "data/100K-00000-of-00001.parquet",
      "data/500K-00000-of-00001.parquet",
      "data/1M-00000-of-00001.parquet",
      "data/10M-00000-of-00002.parquet",
      "data/10M-00001-of-00002.parquet",
    ],
  },
  personamem: {
    anyOf: [
      "benchmark/text/benchmark.csv",
      "benchmark/benchmark.csv",
      "benchmark.csv",
    ],
  },
  membench: {
    anyOf: [
      "membench.json",
      "membench.jsonl",
      "data.json",
      "FirstAgentDataLowLevel.json",
      "FirstAgentDataHighLevel.json",
      "ThirdAgentDataLowLevel.json",
      "ThirdAgentDataHighLevel.json",
      "FirstAgentDataLowLevel.jsonl",
      "FirstAgentDataHighLevel.jsonl",
      "ThirdAgentDataLowLevel.jsonl",
      "ThirdAgentDataHighLevel.jsonl",
    ],
  },
  memoryagentbench: {
    anyOf: [
      ...MEMORY_AGENT_BENCH_BUNDLE_FILENAMES,
      ...MEMORY_AGENT_BENCH_SPLIT_FILENAMES,
    ],
  },
};

const PERSONAMEM_DATASET_FILE_CANDIDATES = [
  "benchmark/text/benchmark.csv",
  "benchmark/benchmark.csv",
  "benchmark.csv",
] as const;

const PERSONAMEM_COMPLETION_MARKER = path.join(
  "data",
  "chat_history_32k",
  ".download-complete",
);

function resolveRealpathWithinDataset(
  datasetPath: string,
  relativePath: string,
): string | null {
  try {
    const datasetRoot = fs.realpathSync(datasetPath);
    const candidatePath = path.resolve(datasetRoot, relativePath);
    const candidateRealPath = fs.realpathSync(candidatePath);
    const relativeToRoot = path.relative(datasetRoot, candidateRealPath);
    if (
      relativeToRoot.startsWith("..")
      || path.isAbsolute(relativeToRoot)
    ) {
      return null;
    }
    return candidateRealPath;
  } catch {
    return null;
  }
}

function parseCsvRows(raw: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let inQuotes = false;

  const pushRow = () => {
    const values = [...currentRow, currentField];
    const isHeader = rows.length === 0;
    const isBlank = values.every((value) => value.trim().length === 0);
    if (isHeader || !isBlank) {
      rows.push(values);
    }
    currentRow = [];
    currentField = "";
  };

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    const next = raw[index + 1];

    if (char === "\"") {
      if (inQuotes && next === "\"") {
        currentField += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === ",") {
      currentRow.push(currentField);
      currentField = "";
      continue;
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      pushRow();
      continue;
    }

    currentField += char;
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    pushRow();
  }

  return rows;
}

function isPersonaMemDatasetComplete(datasetPath: string): boolean {
  try {
    const completionMarkerPath = path.join(datasetPath, PERSONAMEM_COMPLETION_MARKER);
    if (fs.statSync(completionMarkerPath).isFile()) {
      return true;
    }
  } catch {
    // Fall back to verifying every CSV-linked history file for pre-marker mirrors.
  }

  const datasetFile = PERSONAMEM_DATASET_FILE_CANDIDATES.find((candidate) => {
    try {
      return fs.statSync(path.join(datasetPath, candidate)).isFile();
    } catch {
      return false;
    }
  });
  if (!datasetFile) {
    return false;
  }

  try {
    const rows = parseCsvRows(fs.readFileSync(path.join(datasetPath, datasetFile), "utf8"));
    if (rows.length < 2) {
      return false;
    }
    const [header, ...dataRows] = rows;
    const chatHistoryIndex = header.indexOf("chat_history_32k_link");
    if (chatHistoryIndex < 0) {
      return false;
    }
    const historyPaths = dataRows
      .map((row) => row[chatHistoryIndex]?.trim() ?? "")
      .filter((value) => value.length > 0);
    if (historyPaths.length === 0) {
      return false;
    }
    return historyPaths.every((relativePath) => {
      const resolvedPath = resolveRealpathWithinDataset(datasetPath, relativePath);
      return resolvedPath !== null && fs.statSync(resolvedPath).isFile();
    });
  } catch {
    return false;
  }
}

function hasDatasetFile(datasetPath: string, relativePath: string): boolean {
  try {
    return fs.statSync(path.join(datasetPath, relativePath)).isFile();
  } catch {
    return false;
  }
}

function hasMemoryAgentBenchEntityMapping(datasetPath: string): boolean {
  const absoluteDatasetPath = path.resolve(datasetPath);
  const roots = [absoluteDatasetPath, path.dirname(absoluteDatasetPath)];
  return (
    hasDatasetFile(absoluteDatasetPath, "entity2id.json") ||
    roots.some((root) =>
      MEMORY_AGENT_BENCH_ENTITY_MAPPING_CANDIDATES
        .filter((relativePath) => relativePath !== "entity2id.json")
        .some((relativePath) => hasDatasetFile(root, relativePath)),
    )
  );
}

function memoryAgentBenchDatasetHasRecSysSamples(datasetPath: string): boolean {
  const candidateFilenames = [
    ...MEMORY_AGENT_BENCH_BUNDLE_FILENAMES,
    ...MEMORY_AGENT_BENCH_SPLIT_FILENAMES,
  ];
  return candidateFilenames.some((filename) => {
    const filePath = path.join(datasetPath, filename);
    try {
      if (!fs.statSync(filePath).isFile()) {
        return false;
      }
      const raw = fs.readFileSync(filePath, "utf8");
      return /"source"\s*:\s*"recsys[_-]/i.test(raw);
    } catch {
      return false;
    }
  });
}

function isMemoryAgentBenchDatasetComplete(datasetPath: string): boolean {
  if (hasMemoryAgentBenchEntityMapping(datasetPath)) {
    return true;
  }
  return !memoryAgentBenchDatasetHasRecSysSamples(datasetPath);
}

function isDatasetDownloaded(datasetPath: string, benchmarkId: string): boolean {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(datasetPath);
  } catch {
    return false;
  }
  if (!stats.isDirectory()) {
    return false;
  }
  const marker = DOWNLOADED_DATASET_MARKERS[benchmarkId];
  if (!marker) {
    // Unknown benchmark: fall back to "directory has at least one file".
    try {
      return fs.readdirSync(datasetPath).length > 0;
    } catch {
      return false;
    }
  }
  if (marker.allOf) {
    const hasAllRequiredFiles = marker.allOf.every((name) => {
      try {
        return fs.statSync(path.join(datasetPath, name)).isFile();
      } catch {
        return false;
      }
    });
    if (!hasAllRequiredFiles) {
      return false;
    }
  }
  if (marker.anyOf) {
    const hasMarkerFile = marker.anyOf.some((name) => {
      try {
        return fs.statSync(path.join(datasetPath, name)).isFile();
      } catch {
        return false;
      }
    });
    if (!hasMarkerFile) {
      return false;
    }
    if (benchmarkId === "personamem") {
      return isPersonaMemDatasetComplete(datasetPath);
    }
    if (benchmarkId === "memoryagentbench") {
      return isMemoryAgentBenchDatasetComplete(datasetPath);
    }
    return true;
  }
  if (marker.ext) {
    try {
      return fs.readdirSync(datasetPath).some((name) =>
        name.endsWith(marker.ext!) && !marker.exclude?.includes(name),
      );
    } catch {
      return false;
    }
  }
  return false;
}

async function launchBenchUi(resultsDir: string): Promise<void> {
  const benchUiDir = path.join(CLI_REPO_ROOT, "packages", "bench-ui");
  const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

  if (!fs.existsSync(path.join(benchUiDir, "package.json"))) {
    console.error("ERROR: @remnic/bench-ui is not available in this checkout.");
    process.exit(1);
  }

  console.log(`Launching bench UI with results from ${resultsDir}`);
  console.log("Press Ctrl+C to stop the local server.");

  const child = childProcess.spawn(pnpmCmd, ["exec", "vite", "--host", "127.0.0.1"], {
    cwd: benchUiDir,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      REMNIC_BENCH_RESULTS_DIR: resultsDir,
    },
  });

  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0 || signal === "SIGINT" || signal === "SIGTERM") {
        resolve();
        return;
      }

      reject(new Error(`bench UI exited with code ${code ?? "unknown"}`));
    });
  });
}

// Resolve the dataset root. In a monorepo checkout we keep using
// evals/datasets so local dev state stays stable; in a published CLI
// install CLI_REPO_ROOT points under node_modules (not user-writable
// and missing the repo-only evals/ tree) so we fall back to
// ~/.remnic/bench/datasets.
function resolveRepoDatasetRoot(): string {
  const repoCandidate = path.join(CLI_REPO_ROOT, "evals", "datasets");
  if (isRepoCheckout()) {
    return repoCandidate;
  }
  return path.join(resolveHomeDir(), ".remnic", "bench", "datasets");
}

function listDownloadableBenchmarks(): string[] {
  return [...DOWNLOADABLE_BENCHMARK_DATASETS];
}

// The download script is shipped with the CLI package at
// dist/assets/download-datasets.sh. When running from a monorepo
// checkout the built copy may be absent, so we also accept the
// in-repo source path as a fallback.
function resolveDatasetDownloadScriptPath(): string {
  const bundled = path.join(CLI_MODULE_DIR, "assets", "download-datasets.sh");
  if (fs.existsSync(bundled)) {
    return bundled;
  }
  return path.join(CLI_REPO_ROOT, "evals", "scripts", "download-datasets.sh");
}

function isRepoCheckout(): boolean {
  // Treat the install as a repo checkout only when the monorepo
  // marker files are present next to CLI_REPO_ROOT. In published
  // @remnic/cli installs, CLI_REPO_ROOT points inside node_modules
  // where these files do not exist.
  return (
    fs.existsSync(path.join(CLI_REPO_ROOT, "pnpm-workspace.yaml")) &&
    fs.existsSync(path.join(CLI_REPO_ROOT, "evals", "scripts", "download-datasets.sh"))
  );
}

function runDatasetDownloadScript(
  scriptPath: string,
  benchmarkId: string,
  datasetRoot: string,
  jsonMode: boolean,
): void {
  // In --json mode, redirect the script's stdout to parent stderr so
  // progress logs don't corrupt the JSON payload we emit on stdout.
  const stdio: childProcess.StdioOptions = jsonMode
    ? ["inherit", process.stderr, "inherit"]
    : "inherit";
  // Thread the resolved dataset root through DATASETS_DIR so the
  // script writes to the same location `datasets status` reads from,
  // regardless of where the script file itself lives (repo vs
  // packaged node_modules install).
  const env = { ...process.env, DATASETS_DIR: datasetRoot };
  const options: childProcess.SpawnSyncOptions = {
    cwd: CLI_REPO_ROOT,
    stdio,
    env,
  };
  const args = ["--benchmark", benchmarkId];

  // On Unix we rely on the script's shebang and executable bit — this
  // avoids forcing bash in PATH. On Windows (which doesn't honor POSIX
  // shebangs) we fall back to bash and surface a clear error when it's
  // absent, since the script itself is bash-only.
  if (process.platform !== "win32") {
    childProcess.execFileSync(scriptPath, args, options);
    return;
  }

  const bashProbe = childProcess.spawnSync("bash", ["--version"], { stdio: "ignore" });
  if (bashProbe.error || bashProbe.status !== 0) {
    throw new Error(
      "bench datasets download requires bash on Windows (Git Bash or WSL). Install bash or run this command from a Unix shell.",
    );
  }
  childProcess.execFileSync("bash", [scriptPath, ...args], options);
}

function resolveSelectedDatasetDownloads(parsed: ParsedBenchArgs): string[] {
  const supported = listDownloadableBenchmarks();
  if (parsed.all) {
    return supported;
  }
  if (parsed.benchmarks.length === 0) {
    console.error(
      "ERROR: datasets download requires at least one benchmark id or --all. Usage: remnic bench datasets download <benchmark...> [--all] [--json]",
    );
    process.exit(1);
  }

  const selected = [...new Set(parsed.benchmarks)];
  const unsupported = selected.filter((benchmarkId) => !supported.includes(benchmarkId));
  if (unsupported.length > 0) {
    console.error(
      `ERROR: unsupported downloadable benchmark dataset(s): ${unsupported.join(", ")}. Supported datasets: ${supported.join(", ")}.`,
    );
    process.exit(1);
  }
  return selected;
}

function resolveBenchDatasetDir(
  benchmarkId: string,
  quick: boolean,
  datasetDirOverride?: string,
): string | undefined {
  if (datasetDirOverride) {
    return datasetDirOverride;
  }

  if (quick) {
    return undefined;
  }

  // Match the dataset root that `datasets download` and `datasets
  // status` use so full benchmark runs can consume a dataset that
  // was just downloaded through the packaged CLI without requiring
  // an explicit `--dataset-dir` override. Gate auto-selection on the
  // same per-benchmark content markers as `datasets status` so a
  // partial/interrupted download doesn't silently feed an empty
  // directory into the benchmark loader. `resolveRepoDatasetRoot`
  // already picks the correct layout (evals/datasets in monorepo
  // checkouts, ~/.remnic/bench/datasets in packaged installs), so one
  // lookup covers both install modes.
  const datasetDir = path.join(resolveRepoDatasetRoot(), benchmarkId);
  if (isDatasetDownloaded(datasetDir, benchmarkId)) {
    return datasetDir;
  }

  return undefined;
}

function resolveDownloadedBenchDatasetDir(
  benchmarkId: string,
  quick: boolean,
  datasetDirOverride?: string,
): string | undefined {
  const datasetDir = resolveBenchDatasetDir(
    benchmarkId,
    quick,
    datasetDirOverride,
  );
  if (datasetDir === undefined) {
    return undefined;
  }
  return isDatasetDownloaded(datasetDir, benchmarkId) ? datasetDir : undefined;
}

export const __benchDatasetTestHooks = {
  isDatasetDownloaded,
  resolveBenchDatasetDir,
  resolveDownloadedBenchDatasetDir,
  pairedAnswerReplayCacheForBenchmark,
  orderPairedLoCoMoWorkItemsForTest: orderPairedLoCoMoWorkItems,
  buildPublishedBenchmarkOptionsForTest(
    benchmarkId: string,
    args: {
      publishedTrialLimit?: number;
      publishedTrialConcurrency?: number;
      publishedTaskFilter?: string;
    },
    taskSelector?: PackageBenchTaskSelector,
  ) {
    return buildPublishedBenchmarkOptions(benchmarkId, args, taskSelector);
  },
  loadPinnedLoCoMoTaskSelectorForTest: loadPinnedLoCoMoTaskSelector,
  redactBenchTaskIdsFilePathForTest: redactBenchTaskIdsFilePath,
  validateRunnerManagedPublishedDryRunDatasetForTest,
  validateRunnerManagedPublishedDryRunDatasetWithModuleForTest(
    benchModule: unknown,
    benchmarkId: string,
    mode: "quick" | "full",
    datasetDir: string | undefined,
    limit: number | undefined,
    seed: number | undefined,
    benchmarkOptions: Record<string, unknown> | undefined,
  ) {
    return validateRunnerManagedPublishedDryRunDataset(
      benchModule as PackageBenchModule,
      benchmarkId,
      mode,
      datasetDir,
      limit,
      seed,
      benchmarkOptions,
    );
  },
  validatePinnedLoCoMoPublishedDryRunSelectorWithModuleForTest(
    benchModule: unknown,
    mode: "quick" | "full",
    datasetDir: string | undefined,
    limit: number | undefined,
    seed: number | undefined,
    benchmarkOptions: Record<string, unknown> | undefined,
    taskSelector: PackageBenchTaskSelector | undefined,
  ) {
    return validatePinnedLoCoMoPublishedDryRunSelector(
      benchModule as PackageBenchModule,
      mode,
      datasetDir,
      limit,
      seed,
      benchmarkOptions,
      taskSelector,
    );
  },
  printBenchStatusLineForTest: printBenchStatusLine,
  clearPairedAnswerReplayCacheOnFailureForTest: clearPairedAnswerReplayCacheOnFailure,
};
import {
  printBenchComparisonSummary,
  printBenchPackageSummary,
  printBenchStatusLine,
  printStoredBenchResultDetails,
  printStoredBenchResultSummary,
} from "./bench-output-printer.js";
import { cmdBenchCoding } from "./bench-coding-commands.js";
import { cmdBenchSecurity } from "./bench-security-commands.js";
import { runBenchResearchCommand } from "./bench-research-commands.js";
import { getBenchUsageText } from "./bench-usage.js";

async function compareBenchPackageResults(parsed: ParsedBenchArgs): Promise<void> {
  const refs = parsed.benchmarks;
  if (refs.length !== 2) {
    console.error(
      "ERROR: compare requires exactly two stored result references. Usage: remnic bench compare <baseline> <candidate> [--results-dir <path>] [--threshold <value>] [--json]",
    );
    process.exit(1);
  }

  const resultsDir = parsed.resultsDir ?? resolveBenchOutputDir();
  const {
    resolveBenchmarkResultReference,
    loadBenchmarkResult,
    compareResults,
    getBenchmarkLowerIsBetter,
  } = await loadBenchModule();
  const [baselineRef, candidateRef] = refs;
  const baselineSummary = await resolveBenchmarkResultReference(resultsDir, baselineRef);
  const candidateSummary = await resolveBenchmarkResultReference(resultsDir, candidateRef);

  if (!baselineSummary) {
    console.error(`ERROR: benchmark result not found: ${baselineRef}`);
    process.exit(1);
  }
  if (!candidateSummary) {
    console.error(`ERROR: benchmark result not found: ${candidateRef}`);
    process.exit(1);
  }

  const baseline = await loadBenchmarkResult(baselineSummary.path);
  const candidate = await loadBenchmarkResult(candidateSummary.path);

  if (baseline.meta.benchmark !== candidate.meta.benchmark) {
    console.error(
      `ERROR: benchmark mismatch: ${baseline.meta.benchmark} vs ${candidate.meta.benchmark}. Compare runs from the same benchmark.`,
    );
    process.exit(1);
  }

  const comparison = compareResults(
    baseline,
    candidate,
    parsed.threshold ?? 0.05,
    getBenchmarkLowerIsBetter(candidate.meta.benchmark),
  );

  if (parsed.json) {
    console.log(JSON.stringify({
      benchmark: comparison.benchmark,
      baseline: baselineSummary,
      candidate: candidateSummary,
      comparison,
    }, null, 2));
  } else {
    printBenchComparisonSummary(comparison, baselineSummary, candidateSummary);
  }

  if (comparison.verdict === "regression") {
    process.exit(1);
  }
}

async function showBenchPackageResults(parsed: ParsedBenchArgs): Promise<void> {
  const resultsDir = parsed.resultsDir ?? resolveBenchOutputDir();
  const {
    listBenchmarkResults,
    resolveBenchmarkResultReference,
    loadBenchmarkResult,
  } = await loadBenchModule();

  if (parsed.benchmarks.length === 0) {
    const summaries = await listBenchmarkResults(resultsDir);
    if (parsed.json) {
      console.log(JSON.stringify(summaries, null, 2));
      return;
    }
    if (summaries.length === 0) {
      console.log(`No stored benchmark runs found in ${resultsDir}`);
      return;
    }

    console.log("Stored benchmark runs:");
    for (const summary of summaries) {
      console.log(
        `  ${summary.id.padEnd(24)} ${summary.benchmark.padEnd(16)} ${summary.mode.padEnd(5)} ${summary.timestamp}`,
      );
    }
    return;
  }

  if (parsed.benchmarks.length !== 1) {
    console.error(
      "ERROR: results accepts at most one stored result reference. Usage: remnic bench results [run] [--detail] [--results-dir <path>] [--json]",
    );
    process.exit(1);
  }

  const reference = parsed.benchmarks[0]!;
  const summary = await resolveBenchmarkResultReference(resultsDir, reference);
  if (!summary) {
    console.error(`ERROR: benchmark result not found: ${reference}`);
    process.exit(1);
  }

  const result = await loadBenchmarkResult(summary.path);
  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (parsed.detail) {
    printStoredBenchResultDetails(result, summary);
  } else {
    printStoredBenchResultSummary(result, summary);
  }
}

async function manageBenchBaselines(parsed: ParsedBenchArgs): Promise<void> {
  // This handler already needs @remnic/bench for its core work, so we
  // resolve the default baseline dir from the package too. Inlining the
  // path helper here created a divergence risk with no payoff, since
  // the loader runs on the very next line regardless. (cursor feedback
  // on PR #545)
  const {
    defaultBenchmarkBaselineDir,
    listBenchmarkBaselines,
    resolveBenchmarkResultReference,
    listBenchmarkResults,
    loadBenchmarkResult,
    saveBenchmarkBaseline,
    loadBenchmarkBaseline,
  } = await loadBenchModule();
  const baselineDir = parsed.baselinesDir ?? defaultBenchmarkBaselineDir();

  if (parsed.baselineAction === "list") {
    const baselines = await listBenchmarkBaselines(baselineDir);
    if (parsed.json) {
      console.log(JSON.stringify(baselines, null, 2));
      return;
    }
    if (baselines.length === 0) {
      console.log(`No saved baselines found in ${baselineDir}`);
      return;
    }

    console.log("Saved baselines:");
    for (const baseline of baselines) {
      console.log(
        `  ${baseline.name.padEnd(20)} ${baseline.benchmark.padEnd(16)} ${baseline.mode.padEnd(5)} ${baseline.timestamp}`,
      );
    }
    return;
  }

  if (parsed.baselineAction !== "save") {
    console.error("ERROR: baseline requires a subcommand: save or list.");
    process.exit(1);
  }

  if (parsed.benchmarks.length < 1 || parsed.benchmarks.length > 2) {
    console.error(
      "ERROR: baseline save requires a name and optionally one stored result reference. Usage: remnic bench baseline save <name> [run] [--results-dir <path>] [--baselines-dir <path>] [--json]",
    );
    process.exit(1);
  }

  const [name, explicitReference] = parsed.benchmarks;
  const resultsDir = parsed.resultsDir ?? resolveBenchOutputDir();
  const sourceSummary = explicitReference
    ? await resolveBenchmarkResultReference(resultsDir, explicitReference)
    : (await listBenchmarkResults(resultsDir))[0];

  if (!sourceSummary) {
    console.error(
      explicitReference
        ? `ERROR: benchmark result not found: ${explicitReference}`
        : `ERROR: no stored benchmark runs found in ${resultsDir}`,
    );
    process.exit(1);
  }

  const result = await loadBenchmarkResult(sourceSummary.path);
  let writtenPath: string;
  try {
    writtenPath = await saveBenchmarkBaseline(
      baselineDir,
      name!,
      result,
      { id: sourceSummary.id, path: sourceSummary.path },
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  if (parsed.json) {
    const baseline = await loadBenchmarkBaseline(writtenPath);
    console.log(JSON.stringify({
      name: baseline.name,
      path: writtenPath,
      source: baseline.source,
      benchmark: baseline.result.meta.benchmark,
      timestamp: baseline.savedAt,
    }, null, 2));
    return;
  }

  console.log(`Saved baseline "${name}" to ${writtenPath}`);
  console.log(`  Source run: ${sourceSummary.id}`);
  console.log(`  Benchmark: ${result.meta.benchmark}`);
}

async function exportBenchPackageResult(parsed: ParsedBenchArgs): Promise<void> {
  if (parsed.benchmarks.length !== 1) {
    console.error(
      "ERROR: export requires exactly one stored result reference. Usage: remnic bench export <run> --format <json|csv|html> [--output <path>] [--results-dir <path>]",
    );
    process.exit(1);
  }
  if (!parsed.format) {
    console.error('ERROR: export requires --format json, csv, or html.');
    process.exit(1);
  }

  const resultsDir = parsed.resultsDir ?? resolveBenchOutputDir();
  const {
    resolveBenchmarkResultReference,
    loadBenchmarkResult,
    loadBenchmarkReportCardProvenance,
    renderBenchmarkResultExport,
  } = await loadBenchModule();
  const reference = parsed.benchmarks[0]!;
  const summary = await resolveBenchmarkResultReference(resultsDir, reference);
  if (!summary) {
    console.error(`ERROR: benchmark result not found: ${reference}`);
    process.exit(1);
  }

  const result = await loadBenchmarkResult(summary.path);
  const reportCardProvenance = parsed.format === "html"
    ? await loadBenchmarkReportCardProvenance(path.dirname(summary.path), result.meta.id)
    : undefined;
  const rendered = renderBenchmarkResultExport(result, parsed.format, {
    ...(reportCardProvenance ? { reportCardProvenance } : {}),
  });

  if (parsed.output) {
    fs.mkdirSync(path.dirname(parsed.output), { recursive: true });
    fs.writeFileSync(parsed.output, rendered);
    console.log(`Exported ${summary.id} as ${parsed.format} to ${parsed.output}`);
    return;
  }

  process.stdout.write(rendered);
}

async function manageBenchDatasets(parsed: ParsedBenchArgs): Promise<void> {
  const datasetRoot = resolveRepoDatasetRoot();
  const supported = listDownloadableBenchmarks();

  if (parsed.datasetAction === "status") {
    if (parsed.benchmarks.length > 0 || parsed.all) {
      console.error(
        "ERROR: datasets status does not accept benchmark names or --all. Usage: remnic bench datasets status [--json]",
      );
      process.exit(1);
    }

    const status = supported.map((benchmarkId) => {
      const datasetPath = path.join(datasetRoot, benchmarkId);
      return {
        benchmark: benchmarkId,
        downloaded: isDatasetDownloaded(datasetPath, benchmarkId),
        path: datasetPath,
      };
    });

    if (parsed.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }

    console.log("Downloadable benchmark datasets:");
    for (const entry of status) {
      console.log(
        `  ${entry.benchmark.padEnd(16)} ${entry.downloaded ? "downloaded" : "missing"}  ${entry.path}`,
      );
    }
    console.log("");
    console.log(
      "Only the script-backed published datasets are managed here. Other benchmark fixtures remain repo-managed or manual.",
    );
    return;
  }

  if (parsed.datasetAction !== "download") {
    console.error("ERROR: datasets requires a subcommand: download or status.");
    process.exit(1);
  }

  const scriptPath = resolveDatasetDownloadScriptPath();
  if (!fs.existsSync(scriptPath)) {
    console.error(`ERROR: dataset download script not found: ${scriptPath}`);
    process.exit(1);
  }

  const selected = resolveSelectedDatasetDownloads(parsed);
  const downloaded: Array<{ benchmark: string; path: string }> = [];
  for (const benchmarkId of selected) {
    runDatasetDownloadScript(scriptPath, benchmarkId, datasetRoot, parsed.json === true);
    downloaded.push({
      benchmark: benchmarkId,
      path: path.join(datasetRoot, benchmarkId),
    });
  }

  if (parsed.json) {
    console.log(JSON.stringify(downloaded, null, 2));
    return;
  }

  console.log("Downloaded benchmark datasets:");
  for (const entry of downloaded) {
    console.log(`  ${entry.benchmark}  ${entry.path}`);
  }
}

async function manageBenchRuns(parsed: ParsedBenchArgs): Promise<void> {
  const resultsDir = parsed.resultsDir ?? resolveBenchOutputDir();

  if (parsed.runAction === "list") {
    if (parsed.benchmarks.length > 0 || parsed.all) {
      console.error(
        "ERROR: runs list does not accept benchmark names or --all. Usage: remnic bench runs list [--results-dir <path>] [--json]",
      );
      process.exit(1);
    }
    await showBenchPackageResults({ ...parsed, action: "results", benchmarks: [] });
    return;
  }

  if (parsed.runAction === "show") {
    if (parsed.benchmarks.length !== 1 || parsed.all) {
      console.error(
        "ERROR: runs show requires exactly one stored result reference. Usage: remnic bench runs show <run> [--detail] [--results-dir <path>] [--json]",
      );
      process.exit(1);
    }
    await showBenchPackageResults(parsed);
    return;
  }

  if (parsed.runAction === "delete") {
    if (parsed.benchmarks.length === 0 || parsed.all) {
      console.error(
        "ERROR: runs delete requires at least one stored result reference. Usage: remnic bench runs delete <run...> [--results-dir <path>] [--json]",
      );
      process.exit(1);
    }
    const { deleteBenchmarkResults } = await loadBenchModule();
    const deleted = await deleteBenchmarkResults(resultsDir, parsed.benchmarks);
    if (parsed.json) {
      console.log(JSON.stringify(deleted, null, 2));
    } else {
      if (deleted.deleted.length === 0) {
        console.log("No benchmark runs were deleted.");
      } else {
        console.log("Deleted benchmark runs:");
        for (const summary of deleted.deleted) {
          console.log(`  ${summary.id}  ${summary.path}`);
        }
      }

      if (deleted.missing.length > 0) {
        console.log("Missing benchmark runs:");
        for (const reference of deleted.missing) {
          console.log(`  ${reference}`);
        }
      }
    }

    if (deleted.missing.length > 0) {
      process.exit(1);
    }
    return;
  }

  console.error("ERROR: runs requires a subcommand: list, show, or delete.");
  process.exit(1);
}

async function discoverBenchProviders(parsed: ParsedBenchArgs): Promise<void> {
  if (parsed.benchmarks.length > 0) {
    console.error(
      "ERROR: providers discover does not accept positional arguments. Usage: remnic bench providers discover [--json]",
    );
    process.exit(1);
  }

  const { discoverAllProviders } = await loadBenchModule();
  const discovered = await discoverAllProviders();

  if (parsed.json) {
    console.log(JSON.stringify(discovered, null, 2));
    return;
  }

  if (discovered.length === 0) {
    console.log("No local bench providers were discovered.");
    return;
  }

  console.log("Discovered bench providers:");
  for (const entry of discovered) {
    console.log(`  ${entry.provider}`);
    for (const model of entry.models) {
      const capabilities = model.capabilities.join(", ");
      const details = [
        model.contextLength > 0 ? `context=${model.contextLength}` : undefined,
        model.parameterCount ? `params=${model.parameterCount}` : undefined,
        model.quantization ? `quant=${model.quantization}` : undefined,
        capabilities.length > 0 ? `caps=${capabilities}` : undefined,
      ].filter((value): value is string => Boolean(value));
      console.log(
        `    - ${model.id}${details.length > 0 ? ` (${details.join(", ")})` : ""}`,
      );
    }
  }
}

/**
 * `remnic bench judge-calibrate` — cross-tier judge calibration (issue #1573 PR3).
 *
 * Runs the local judge (resolved from `--local-lab-manifest`) and the frontier
 * judge (resolved from `--judge-provider`/`--judge-model`) over the cached
 * answers for a benchmark, computes Cohen's kappa, prints it, and persists the
 * result so subsequent local artifacts carry the kappa + warning. The actual
 * full-mode run that consumes live endpoints is a separate operator step; this
 * command wires the software end-to-end.
 */
async function calibrateBenchJudges(parsed: ParsedBenchArgs, rawArgs: string[]): Promise<void> {
  const benchmarkId =
    readBenchOptionValue(rawArgs, "--benchmark") ?? parsed.benchmarks[0];
  if (!benchmarkId) {
    console.error(
      "ERROR: judge-calibrate requires a benchmark. Usage: remnic bench judge-calibrate --benchmark <id> [--local-lab-manifest <path>] [--judge-provider <p> --judge-model <m>] [--results-dir <path>] [--json]",
    );
    process.exit(1);
  }
  // Package-aware validation (codex P2 review): use the same resolver the run
  // command uses, so package-registered benchmarks (memoryagentbench, membench,
  // personamem, ...) calibrate instead of being rejected as "unknown" by the
  // static CLI catalog (`BENCHMARK_IDS`).
  const knownBenchmarkIds = await resolveKnownBenchmarkIds();
  if (!knownBenchmarkIds.has(benchmarkId)) {
    console.error(
      `ERROR: unknown benchmark "${benchmarkId}". Known: ${[...knownBenchmarkIds].sort().join(", ")}.`,
    );
    process.exit(1);
  }

  const manifestPath = parsed.localLabManifestPath;
  if (!manifestPath) {
    console.error(
      "ERROR: judge-calibrate requires --local-lab-manifest <path> (the Tier L judge source). Provide a local-lab manifest whose judge role names the local model.",
    );
    process.exit(1);
  }
  if (!parsed.judgeProvider || !parsed.judgeModel) {
    console.error(
      "ERROR: judge-calibrate requires --judge-provider <p> and --judge-model <m> (the Tier F gold-standard judge).",
    );
    process.exit(1);
  }
  if (!parsed.sourceResultId || !parsed.expectedAnswerSetSha256 || !parsed.expectedQuestionIdListSha256) {
    console.error(
      "ERROR: judge-calibrate requires --source-result-id, --expected-answer-set-sha256, and --expected-question-id-list-sha256 so all source drift is rejected before judge calls.",
    );
    process.exit(1);
  }

  const bench = await loadBenchModule();
  const resultsDir = expandTilde(
    parsed.resultsDir ?? path.join(resolveHomeDir(), ".remnic", "bench", "results"),
  );
  const calibrationDir = expandTilde(
    parsed.calibrationDir ?? path.join(resolveHomeDir(), ".remnic", "bench", "calibration"),
  );

  // Build the calibration answers from the most recent stored result for the
  // benchmark. `actual` is the responder's predicted answer; `expected` is the
  // gold. Both judges re-score the same (question, predicted, expected) triple.
  const stored = await bench.listBenchmarkResults(resultsDir);
  // Calibration needs a full run's cached answers — a quick run (mode "quick")
  // is a 1-task sample whose agreement is meaningless (often kappa=1 on a
  // single agreeing pair), so a stale quick result must never be selected as
  // the calibration source (codex P2 review).
  const allForBenchmark = stored.filter((entry) => entry.benchmark === benchmarkId);
  const candidates = allForBenchmark
    .filter((entry) => entry.mode === "full")
    .sort((a, b) => {
      // Descending by timestamp with a 3-way comparator (cursor review: the
      // previous `< b ? 1 : -1` never returned 0, so tied timestamps produced
      // an unstable order that could pick a non-latest run). The id breaks
      // remaining ties deterministically.
      if (a.timestamp !== b.timestamp) {
        return a.timestamp < b.timestamp ? 1 : -1;
      }
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
  // Issue #1877: once a benchmark has a calibration source, keep using that
  // exact stored result. Selecting "whatever is newest" made the same judge
  // pair swing from kappa 0.769 to 0.444 as cached answers changed.
  const pinnedSourceId = parsed.sourceResultId;
  const latest = candidates.find((entry) => entry.id === pinnedSourceId);
  if (!latest) {
    console.error(
      `ERROR: explicitly pinned full calibration source ${pinnedSourceId} for "${benchmarkId}" is not present in ${resultsDir}. Restore that exact stored result.`,
    );
    process.exit(1);
  }
  // Prefer the latest COMPLETE full run — a partial full run (interrupted)
  // would otherwise seed calibration from an incomplete slice even when an
  // older complete full run exists (codex P2 review). `status` lives on the
  // loaded result, not the summary, so load newest-first and keep the first
  // complete one; if every candidate is partial we keep the newest (the only
  // option available to the operator).
  let loaded = await bench.loadBenchmarkResult(latest.path);
  if (loaded.meta.status === "partial") {
    console.error(
      `ERROR: pinned calibration source ${pinnedSourceId} is partial. Restore a complete copy or remove the calibration state intentionally before selecting a new answer set.`,
    );
    process.exit(1);
  }
  // Codex P2 review: a `--limit 1` (or `--trial-limit 1`) full run produces
  // mode === "full" with a single task, yielding a degenerate one-sample κ
  // (often 1.0). Require enough completed tasks for a meaningful calibration.
  // Count UNIQUE task ids — runJudgeCalibration dedupes by questionId, so
  // raw task count can overstate the sample (codex P2 review: a stored result
  // with duplicate taskIds could pass the minimum while producing a smaller κ).
  const uniqueTaskIds = new Set(loaded.results.tasks.map((task) => task.taskId));
  const sourceTaskCount = uniqueTaskIds.size;
  if (sourceTaskCount < bench.MIN_CALIBRATION_SOURCE_TASKS) {
    console.error(
      `ERROR: stored result for "${benchmarkId}" has only ${sourceTaskCount} task(s) — too few for a meaningful calibration (minimum ${bench.MIN_CALIBRATION_SOURCE_TASKS}). Run a full uncapped benchmark first (remnic bench run ${benchmarkId}).`,
    );
    process.exit(1);
  }
  const answers = loaded.results.tasks.map((task) => ({
    questionId: task.taskId,
    question: task.question,
    predicted: task.actual,
    expected: task.expected,
  }));
  const orderedQuestionIdsHash = bench.hashOrderedQuestionIds(
    loaded.results.tasks.map((task) => task.taskId),
  );
  if (orderedQuestionIdsHash !== parsed.expectedQuestionIdListSha256) {
    console.error(
      `ERROR: ordered question-id list changed for ${loaded.meta.id} (expected sha256:${parsed.expectedQuestionIdListSha256}, got sha256:${orderedQuestionIdsHash}); refusing to call judges.`,
    );
    process.exit(1);
  }
  const sourceResultSha256 = createHash("sha256").update(fs.readFileSync(latest.path)).digest("hex");

  // Resolve the two judges. The local judge comes from the manifest's judge
  // role (Tier L); the frontier judge from the --judge-* flags (Tier F gold).
  const expandedManifestPath = expandTilde(manifestPath);
  // Both judges resolve to a `ProviderFactoryConfig` — a discriminated union
  // keyed on a literal `provider`. The local judge's config arrives already
  // typed from the resolved local-lab profile; the frontier judge is assembled
  // from CLI flags whose `provider` is the broad `BuiltInProvider` union, so
  // it is narrowed through the same cast the local judge uses.
  type ProviderFactoryConfig = Parameters<typeof bench.createProviderBackedJudge>[0];
  if (!bench.resolveLocalLabJudgeProviderConfig) {
    console.error(
      "ERROR: installed @remnic/bench version does not export resolveLocalLabJudgeProviderConfig; rebuild or upgrade @remnic/bench before calibrating.",
    );
    process.exit(1);
  }
  const localJudgeConfig = await bench.resolveLocalLabJudgeProviderConfig({
    localLabManifestPath: expandedManifestPath,
    ...(parsed.localJudgeRequestTimeout
      ? { requestTimeout: parsed.localJudgeRequestTimeout }
      : {}),
    max429WaitMs: parsed.max429WaitMs,
    disableThinking: parsed.disableThinking,
  }) as ProviderFactoryConfig;
  const localJudge = bench.createProviderBackedJudge(localJudgeConfig);
  const frontierJudgeConfig = buildCalibrationFrontierJudgeConfig(
    parsed,
  ) as ProviderFactoryConfig;
  const frontierJudge = bench.createProviderBackedJudge(frontierJudgeConfig);

  const localJudgeConfigHash = hashCalibrationProviderConfig(localJudgeConfig);
  const frontierJudgeConfigHash = hashCalibrationProviderConfig(frontierJudgeConfig);

  const result = await bench.runJudgeCalibration({
    benchmarkId,
    localJudge,
    frontierJudge,
    answers,
    expectedAnswerSetHash: parsed.expectedAnswerSetSha256,
    expectedOrderedQuestionIdsHash: parsed.expectedQuestionIdListSha256,
    checkpoint: {
      dir: calibrationDir,
      sourceResultId: loaded.meta.id,
      sourceResultSha256,
      orderedQuestionIdsHash,
      localJudgePromptIdentity: bench.getProviderBackedJudgePromptIdentity(localJudgeConfig),
      frontierJudgePromptIdentity: bench.getProviderBackedJudgePromptIdentity(frontierJudgeConfig),
      localJudgeConfigHash,
      frontierJudgeConfigHash,
    },
  });

  // Bind the persisted kappa to the calibrated judge pair (codex P2 review):
  // without these identities, a later run that swaps the local-lab manifest
  // or the frontier judge would inherit a stale kappa for a different pair.
  const calibrationIdentities = {
    localJudgeProvider: String(localJudgeConfig.provider),
    localJudgeModel: String(localJudgeConfig.model),
    frontierJudgeProvider: parsed.judgeProvider,
    frontierJudgeModel: parsed.judgeModel,
  };
  const statePath = await bench.writeJudgeCalibrationState(
    result,
    calibrationDir,
    calibrationIdentities,
    { sourceResultId: loaded.meta.id, orderedQuestionIdsHash, localJudgeConfigHash, frontierJudgeConfigHash },
  );
  // Read the persisted state straight back. This exercises the load path the
  // artifact builder will use (cursor review + codex P1: loadJudgeCalibration-
  // State was previously dead code — only tests called it). A mismatch here
  // would mean the persisted kappa is not what subsequent local artifacts
  // would carry, which is an operator-visible failure.
  const persisted = await bench.loadJudgeCalibrationState(benchmarkId, calibrationDir);
  if (
    !persisted || persisted.kappa !== result.kappa || persisted.warning !== result.warning ||
    persisted.localJudgeConfigHash !== localJudgeConfigHash ||
    persisted.orderedQuestionIdsHash !== orderedQuestionIdsHash ||
    persisted.frontierJudgeConfigHash !== frontierJudgeConfigHash
  ) {
    console.error(
      `ERROR: calibration state round-trip failed for ${benchmarkId} (wrote kappa ${result.kappa}, read back ${persisted ? persisted.kappa : "nothing"}). Re-run judge-calibrate.`,
    );
    process.exit(1);
  }

  if (parsed.json) {
    console.log(
      JSON.stringify(
        {
          benchmarkId: result.benchmarkId,
          kappa: result.kappa,
          observedAgreement: result.observedAgreement,
          expectedAgreement: result.expectedAgreement,
          sampleSize: result.sampleSize,
          threshold: result.threshold,
          warning: result.warning,
          confidenceInterval: result.confidenceInterval,
          bootstrapSamples: result.bootstrapSamples,
          answerSetHash: result.answerSetHash,
          sourceResultId: loaded.meta.id,
          categories: result.categories,
          orderedQuestionIdsHash,
          sourceResultSha256,
          localJudgeConfigHash,
          frontierJudgeConfigHash,
          execution: result.execution,
          statePath,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`Judge calibration: ${benchmarkId}`);
  console.log(`  Cohen's kappa: ${result.kappa.toFixed(4)} (threshold ${result.threshold})`);
  console.log(`  Sample size:   ${result.sampleSize}`);
  console.log(
    `  ${(result.confidenceInterval.level * 100).toFixed(0)}% bootstrap CI: [${result.confidenceInterval.lower.toFixed(4)}, ${result.confidenceInterval.upper.toFixed(4)}] (${result.bootstrapSamples} paired resamples)`,
  );
  console.log(`  Pinned source: ${loaded.meta.id} (answer set sha256:${result.answerSetHash})`);
  console.log(`  Ordered question ids: sha256:${orderedQuestionIdsHash}`);
  console.log(`  Judge calls: local ${result.execution.localJudgeCalls}, frontier ${result.execution.frontierJudgeCalls}; resumed outputs ${result.execution.resumedJudgeOutputs}`);
  console.log(`  Observed agreement: ${result.observedAgreement.toFixed(4)}`);
  console.log(`  Expected agreement: ${result.expectedAgreement.toFixed(4)}`);
  if (result.warning) {
    console.log(
      `  WARNING: local judge unreliable for ${benchmarkId} (kappa ${result.kappa.toFixed(4)} < ${result.threshold}). Tier L numbers for this benchmark should not be trusted for regression until the judge improves.`,
    );
  } else {
    console.log(`  OK: local judge agrees with frontier above threshold.`);
  }
  console.log(`  Calibration state written + verified (round-trip ok): ${statePath}`);
  console.log(`  Subsequent local artifacts for ${benchmarkId} will carry kappa ${persisted.kappa.toFixed(4)}.`);
}

export function buildCalibrationFrontierJudgeConfig(
  parsed: Pick<ParsedBenchArgs,
    "judgeProvider" | "judgeModel" | "judgeBaseUrl" | "judgeApiKey" |
    "frontierJudgeRequestTimeout" | "max429WaitMs" | "disableThinking"
  >,
): PackageBenchProviderConfig {
  if (!parsed.judgeProvider || !parsed.judgeModel) {
    throw new Error(
      "Calibration frontier judge requires both --judge-provider and --judge-model.",
    );
  }
  return {
    provider: parsed.judgeProvider,
    model: parsed.judgeModel,
    ...(parsed.judgeBaseUrl ? { baseUrl: parsed.judgeBaseUrl } : {}),
    ...(parsed.judgeApiKey ? { apiKey: parsed.judgeApiKey } : {}),
    ...(parsed.frontierJudgeRequestTimeout !== undefined || parsed.max429WaitMs !== undefined
      ? {
          retryOptions: {
            ...(parsed.frontierJudgeRequestTimeout !== undefined
              ? { timeoutMs: parsed.frontierJudgeRequestTimeout }
              : {}),
            ...(parsed.max429WaitMs !== undefined
              ? { max429WaitMs: parsed.max429WaitMs }
              : {}),
          },
        }
      : {}),
    ...(parsed.disableThinking ? { disableThinking: true } : {}),
  };
}

async function publishBenchPackageResults(parsed: ParsedBenchArgs): Promise<void> {
  if (parsed.benchmarks.length > 0) {
    console.error(
      "ERROR: publish does not accept positional result references. Usage: remnic bench publish --target remnic-ai [--results-dir <path>] [--output <path>] [--json]",
    );
    process.exit(1);
  }

  if (parsed.target !== "remnic-ai") {
    console.error('ERROR: publish requires --target remnic-ai.');
    process.exit(1);
  }

  const resultsDir = parsed.resultsDir ?? resolveBenchOutputDir();
  const {
    buildBenchmarkPublishFeed,
    defaultBenchmarkPublishPath,
    writeBenchmarkPublishFeed,
  } = await loadBenchModule();
  const feed = await buildBenchmarkPublishFeed(resultsDir, parsed.target);
  if (feed.benchmarks.length === 0) {
    console.error(
      `ERROR: no publishable benchmark results found in ${resultsDir}. remnic-ai requires stored full runs for published benchmarks.`,
    );
    process.exit(1);
  }
  const outputPath = parsed.output ?? defaultBenchmarkPublishPath(parsed.target);
  const writtenPath = await writeBenchmarkPublishFeed(feed, outputPath);

  if (parsed.json) {
    console.log(JSON.stringify({
      target: parsed.target,
      outputPath: writtenPath,
      benchmarkCount: feed.benchmarks.length,
      feed,
    }, null, 2));
    return;
  }

  console.log(
    `Published ${feed.benchmarks.length} benchmark entries for ${parsed.target} to ${writtenPath}`,
  );
}

/**
 * `remnic bench published --name <benchmark> --dataset <path>
 *    --model <id> --limit <n> --trial-limit <n> --seed <n> --out <dir> [--dry-run]
 *    [--provider openai|anthropic|ollama|litellm|codex-cli] [--base-url <url>]`
 *
 * Issue #566 PR 4/7. Thin wrapper that routes the user's flags into the
 * existing `runBenchViaPackage` machinery. The wrapper accepts every public
 * benchmark runner, enforces the `--name` + `--dataset` invariants at the
 * boundary, and — in `--dry-run` — validates the dataset path without calling
 * any LLM.
 *
 * Validation is upstream in `parseBenchArgs`, per CLAUDE.md rules 14
 * (validate CLI flag args) and 51 (reject invalid input with listed
 * options). `--model` / `--limit` / `--seed` without a value throw
 * instead of silently defaulting.
 */
async function runBenchPublished(parsed: ParsedBenchArgs): Promise<void> {
  if (!parsed.publishedName) {
    console.error(
      `ERROR: \`bench published\` requires --name ${PUBLISHED_BENCHMARK_NAMES.join("|")}.`,
    );
    process.exit(1);
  }
  if (!parsed.datasetDir) {
    console.error(
      "ERROR: `bench published` requires --dataset <path> (or --dataset-dir <path>) pointing at the dataset directory.",
    );
    process.exit(1);
  }
  if (!parsed.systemModel) {
    console.error(
      "ERROR: `bench published` requires --model <id> (or --system-model <id>).",
    );
    process.exit(1);
  }
  if (parsed.benchmarks.length > 0) {
    console.error(
      "ERROR: `bench published` does not accept positional benchmark arguments; use --name instead.",
    );
    process.exit(1);
  }
  const taskSelector = loadPinnedLoCoMoTaskSelector(parsed);

  // Dry-run: validate config and load the dataset, but never touch the
  // model. Useful for pre-flight checking a long run. Prints a single
  // summary line per benchmark.
  if (parsed.publishedDryRun) {
    const loaded = await tryLoadBenchModule();
    if (!loaded) {
      console.error(
        "ERROR: @remnic/bench package is not installed. Run `npm install @remnic/bench`.",
      );
      process.exit(1);
    }
    assertBenchModuleFreshForDevelopment();
    const benchModule = loaded as unknown as PackageBenchModule;
    const benchmarkId = parsed.publishedName;
    const mode = parsed.quick ? "quick" : "full";
    // Codex P2 review on PR #603: keep dry-run's effective limit in
    // sync with the real run so preflight item counts match what will
    // actually execute. Previously `limit: parsed.publishedLimit`
    // alone meant `--quick` without `--limit` dry-ran the full smoke
    // sample while the real run loaded only one item.
    const effectiveLimit =
      parsed.publishedLimit ?? (parsed.quick ? 1 : undefined);
    const benchmarkOptions = buildPublishedBenchmarkOptions(
      benchmarkId,
      parsed,
      taskSelector,
    );
    let itemCount: number | undefined;
    // Codex P2 review on PR #603: when the loader returns
    // `source: "missing"` (full mode and the dataset file is absent or
    // unreadable), dry-run must fail loudly. Previously the script
    // logged the line and exited 0, so CI/users could not trust
    // `--dry-run` as a preflight gate — the real run would later crash
    // with the same missing dataset.
    let loadResult:
      | {
          source: string;
          filename?: string;
          items: unknown[];
          errors: unknown[];
        }
      | undefined;
    if (benchmarkId === "longmemeval" && benchModule.loadLongMemEvalS) {
      loadResult = await benchModule.loadLongMemEvalS({
        mode,
        datasetDir: parsed.datasetDir,
        limit: effectiveLimit,
      });
      itemCount = loadResult.items.length;
      console.log(
        `[dry-run] longmemeval: source=${loadResult.source} filename=${loadResult.filename ?? "<smoke>"} items=${itemCount} errors=${loadResult.errors.length}`,
      );
    } else if (benchmarkId === "locomo" && benchModule.loadLoCoMo10) {
      loadResult = await benchModule.loadLoCoMo10({
        mode,
        datasetDir: parsed.datasetDir,
        limit: effectiveLimit,
      });
      itemCount = loadResult.items.length;
      console.log(
        `[dry-run] locomo: source=${loadResult.source} filename=${loadResult.filename ?? "<smoke>"} items=${itemCount} errors=${loadResult.errors.length}`,
      );
    } else if (benchmarkId === "beam" && benchModule.loadBeamDatasetPreview) {
      const preview = await benchModule.loadBeamDatasetPreview({
        mode,
        datasetDir: parsed.datasetDir,
        limit: effectiveLimit,
      });
      loadResult = {
        source: preview.source,
        filename: preview.files.join(",") || undefined,
        items: [],
        errors: preview.errors,
      };
      itemCount = preview.items;
      console.log(
        `[dry-run] beam: source=${preview.source} files=${preview.files.length} items=${preview.items} tasks=${preview.tasks} errors=${preview.errors.length}`,
      );
    } else {
      const definition = benchModule.getBenchmark?.(benchmarkId);
      if (!definition?.runnerAvailable) {
        console.error(
          `ERROR: installed @remnic/bench version does not export a runner for "${benchmarkId}".`,
        );
        process.exit(1);
      }
      try {
        await validateRunnerManagedPublishedDryRunDataset(
          benchModule,
          benchmarkId,
          mode,
          parsed.datasetDir,
          effectiveLimit,
          parsed.publishedSeed,
          benchmarkOptions,
        );
      } catch (error) {
        console.error(
          `ERROR: [dry-run] ${benchmarkId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
      loadResult = {
        source: "dataset",
        filename: parsed.datasetDir,
        items: [],
        errors: [],
      };
      console.log(
        `[dry-run] ${benchmarkId}: source=${loadResult.source} datasetDir=${parsed.datasetDir} items=<runner-managed> errors=0`,
      );
    }
    if (loadResult && loadResult.source === "missing") {
      console.error(
        `ERROR: [dry-run] ${benchmarkId}: dataset missing or unreadable under ${parsed.datasetDir}. Provide a valid --dataset path before running without --dry-run.`,
      );
      process.exit(1);
    }
    if (benchmarkId === "locomo") {
      try {
        await validatePinnedLoCoMoPublishedDryRunSelector(
          benchModule,
          mode,
          parsed.datasetDir,
          effectiveLimit,
          parsed.publishedSeed,
          benchmarkOptions,
          taskSelector,
        );
      } catch (error) {
        console.error(
          `ERROR: [dry-run] ${benchmarkId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    }
    return;
  }

  const benchmarkId = parsed.publishedName;
  const runtimeProfiles = orderPairedLoCoMoWorkItems(
    resolveBenchRunProfiles(parsed).map((runtimeProfile) => ({
      benchmarkId,
      runtimeProfile,
    })),
  ).map((item) => item.runtimeProfile);
  // Collect artifact paths written by each runtime profile so the
  // --out promotion step copies the exact file just produced rather
  // than scanning the whole results directory (Cursor Medium + Codex
  // P1 on PR #603: the previous newest-mtime scan could silently
  // publish unrelated or older artifacts under the new canonical
  // filename).
  const writtenPaths: string[] = [];
  const pairedAnswerReplayCache =
    benchmarkId === "locomo"
      && runtimeProfiles.includes("baseline")
      && runtimeProfiles.includes("real")
      ? new Map<string, import("@remnic/bench").PairedAnswerReplayEntry>()
      : undefined;
  for (const runtimeProfile of runtimeProfiles) {
    // Forward `--limit` + `--seed` through the existing package
    // runner. `--out` is handled below in the artifact write step.
    const result = await runBenchViaPackage(
      parsed,
      benchmarkId,
      runtimeProfile,
      undefined,
      taskSelector,
      pairedAnswerReplayCache,
    );
    if (!result.ok) {
      console.error(
        `ERROR: unable to run ${benchmarkId} via @remnic/bench. Update the @remnic/bench install to a version that exports a runner for this benchmark.`,
      );
      process.exit(1);
    }
    if (result.writtenPath) {
      writtenPaths.push(result.writtenPath);
    }
  }
  await writeBenchReproManifestForPackageRun({
    parsed,
    benchmarkIds: [benchmarkId],
    runtimeProfiles,
    workItems: runtimeProfiles.map((runtimeProfile) => ({ benchmarkId, runtimeProfile })),
    resultPaths: writtenPaths,
  });

  // When `--out` is supplied, copy the result artifact we just wrote
  // into the directory under a canonical leaderboard filename. We
  // keep the primary result file under `~/.remnic/bench/results/`
  // (set by `resolveBenchOutputDir`) and only publish a flatter copy
  // to the user-specified directory so the dev environment stays in
  // sync.
  if (parsed.publishedOut) {
    const { promoteArtifactsToPublished } = await loadPublishedPromotionHelpers();
    await promoteArtifactsToPublished({
      benchmarkId,
      artifactPaths: writtenPaths,
      publishedOutDir: parsed.publishedOut,
      model: parsed.systemModel,
    });
  }
}

const DRY_RUN_DATASET_VALIDATED_CODE = "REMNIC_BENCH_DRY_RUN_DATASET_VALIDATED";

type DryRunDatasetValidatedError = Error & {
  code: typeof DRY_RUN_DATASET_VALIDATED_CODE;
};

function createDryRunDatasetValidatedError(benchmarkId: string): DryRunDatasetValidatedError {
  const error = new Error(
    benchmarkId + " dataset validated; dry-run stopped before benchmark execution.",
  ) as DryRunDatasetValidatedError;
  error.name = "DryRunDatasetValidated";
  error.code = DRY_RUN_DATASET_VALIDATED_CODE;
  return error;
}

function isDryRunDatasetValidatedError(
  error: unknown,
): error is DryRunDatasetValidatedError {
  return (
    error instanceof Error
    && (error as { code?: unknown }).code === DRY_RUN_DATASET_VALIDATED_CODE
  );
}

function createDryRunDatasetValidationAdapter(
  benchmarkId: string,
): BenchMemoryAdapter {
  const abort = async (): Promise<never> => {
    throw createDryRunDatasetValidatedError(benchmarkId);
  };

  return {
    store: abort,
    recall: abort,
    search: abort,
    reset: abort,
    getStats: abort,
    drain: abort,
    destroy: async () => {},
  };
}

function buildPublishedBenchmarkOptions(
  benchmarkId: string,
  args: {
    publishedTrialLimit?: number;
    publishedTrialConcurrency?: number;
    publishedTaskFilter?: string;
    memcorrectAdapter?: "remnic" | "prompt-only";
  },
  taskSelector?: PackageBenchTaskSelector,
): Record<string, unknown> | undefined {
  const trialLimitOptions =
    args.publishedTrialLimit !== undefined
      ? { trialLimit: args.publishedTrialLimit }
      : undefined;
  const trialConcurrencyOptions =
    args.publishedTrialConcurrency !== undefined
      ? { trialConcurrency: args.publishedTrialConcurrency }
      : undefined;
  if (benchmarkId === "locomo") {
    return {
      ...(trialLimitOptions ?? {}),
      ...(trialConcurrencyOptions ?? {}),
      replayExtractionMode: "skip",
      ...(taskSelector ? { taskSelector } : {}),
    };
  }
  if (benchmarkId === "ama-bench") {
    return trialConcurrencyOptions;
  }
  if (benchmarkId === "memoryagentbench") {
    return trialLimitOptions;
  }
  if (benchmarkId === "beam" && args.publishedTaskFilter !== undefined) {
    return { taskFilter: args.publishedTaskFilter };
  }
  if (benchmarkId === "memcorrect-v1" && args.memcorrectAdapter !== undefined) {
    return { adapter: args.memcorrectAdapter };
  }
  return undefined;
}

function loadPinnedLoCoMoTaskSelector(
  parsed: Pick<ParsedBenchArgs, "taskIdsFile" | "expectedTaskIdListSha256">,
): PackageBenchTaskSelector | undefined {
  if (!parsed.taskIdsFile) return undefined;
  if (!parsed.expectedTaskIdListSha256) {
    throw new Error(
      "--task-ids-file requires --expected-task-id-list-sha256.",
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(fs.readFileSync(parsed.taskIdsFile, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read --task-ids-file ${parsed.taskIdsFile}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(decoded) || decoded.length === 0) {
    throw new Error("--task-ids-file JSON must be a non-empty array of strings.");
  }
  if (decoded.some((taskId) => typeof taskId !== "string" || taskId.length === 0)) {
    throw new Error("--task-ids-file JSON must contain only non-empty strings.");
  }
  const taskIds = decoded as string[];
  if (new Set(taskIds).size !== taskIds.length) {
    throw new Error("--task-ids-file must not contain duplicate task IDs.");
  }

  return {
    kind: "explicit-task-ids",
    taskIds,
    expectedSelectedTaskIdsSha256: parsed.expectedTaskIdListSha256,
  };
}

function redactBenchTaskIdsFilePath(argv: readonly string[]): string[] {
  const redacted = [...argv];
  for (let index = 0; index < redacted.length; index += 1) {
    if (redacted[index] === "--task-ids-file" && index + 1 < redacted.length) {
      redacted[index + 1] = "<task-ids-file>";
      index += 1;
    }
  }
  return redacted;
}

async function validateRunnerManagedPublishedDryRunDataset(
  benchModule: PackageBenchModule,
  benchmarkId: string,
  mode: "quick" | "full",
  datasetDir: string | undefined,
  limit: number | undefined,
  seed: number | undefined,
  benchmarkOptions: Record<string, unknown> | undefined,
): Promise<void> {
  if (!benchModule.runBenchmark) {
    throw new Error(
      "installed @remnic/bench version does not export runBenchmark.",
    );
  }

  try {
    await benchModule.runBenchmark(benchmarkId, {
      mode,
      datasetDir,
      limit,
      seed,
      adapterMode: "dry-run",
      runtimeProfile: null,
      systemProvider: null,
      judgeProvider: null,
      internalProvider: null,
      remnicConfig: {},
      ...(benchmarkOptions ? { benchmarkOptions } : {}),
      system: createDryRunDatasetValidationAdapter(benchmarkId),
      onTaskComplete: () => {
        throw createDryRunDatasetValidatedError(benchmarkId);
      },
    });
  } catch (error) {
    if (isDryRunDatasetValidatedError(error)) {
      return;
    }
    throw error;
  }
}

async function validatePinnedLoCoMoPublishedDryRunSelector(
  benchModule: PackageBenchModule,
  mode: "quick" | "full",
  datasetDir: string | undefined,
  limit: number | undefined,
  seed: number | undefined,
  benchmarkOptions: Record<string, unknown> | undefined,
  taskSelector: PackageBenchTaskSelector | undefined,
): Promise<void> {
  if (taskSelector === undefined) {
    return;
  }
  await validateRunnerManagedPublishedDryRunDataset(
    benchModule,
    "locomo",
    mode,
    datasetDir,
    limit,
    seed,
    benchmarkOptions,
  );
}

async function validateRunnerManagedPublishedDryRunDatasetForTest(
  benchmarkId: string,
  mode: "quick" | "full",
  datasetDir: string | undefined,
  limit?: number,
  benchmarkOptions?: Record<string, unknown>,
): Promise<void> {
  const benchModule = (await tryLoadBenchModule()) as
    | PackageBenchModule
    | undefined;
  if (!benchModule) {
    throw new Error("@remnic/bench package is not installed.");
  }
  await validateRunnerManagedPublishedDryRunDataset(
    benchModule,
    benchmarkId,
    mode,
    datasetDir,
    limit,
    undefined,
    benchmarkOptions,
  );
}

async function loadPublishedPromotionHelpers() {
  const benchModule = (await loadBenchModule()) as unknown as PackageBenchModule;
  return {
    async promoteArtifactsToPublished(args: {
      benchmarkId: string;
      artifactPaths: string[];
      publishedOutDir: string;
      model: string;
    }) {
      const { mkdirSync, readFileSync, writeFileSync } = await import(
        "node:fs"
      );
      const path = await import("node:path");
      mkdirSync(args.publishedOutDir, { recursive: true });
      if (args.artifactPaths.length === 0) {
        console.warn(
          `[bench published] No artifacts produced for ${args.benchmarkId}; nothing to promote.`,
        );
        return;
      }
      for (const artifactPath of args.artifactPaths) {
        const raw = readFileSync(artifactPath, "utf8");
        // Cursor Low on PR #603: `JSON.parse(null JSON literal)`
        // returns `null`, which the old `as` cast hid. Validate the
        // shape before dereferencing `.meta` to avoid a TypeError
        // crashing the promotion step for a corrupted or empty
        // artifact.
        const parsedUnknown: unknown = JSON.parse(raw);
        const parsedObj =
          parsedUnknown !== null &&
          typeof parsedUnknown === "object" &&
          !Array.isArray(parsedUnknown)
            ? (parsedUnknown as {
                meta?: { gitSha?: string };
                config?: { runtimeProfile?: string | null };
              })
            : {};
        const gitShaShort = (parsedObj.meta?.gitSha ?? "unknown").slice(0, 7);
        const today = new Date().toISOString().slice(0, 10);
        const modelSlug = args.model.replace(/[^a-zA-Z0-9_.-]/g, "-");
        // Codex P2 on PR #603: include the runtime profile in the
        // published filename so multi-profile (e.g. --matrix) runs do
        // not silently overwrite one another. The profile lives in
        // `result.config.runtimeProfile` and is "baseline", "real",
        // or "openclaw-chain" in practice.
        const rawProfile = parsedObj.config?.runtimeProfile;
        const profileSlug =
          typeof rawProfile === "string" && rawProfile.length > 0
            ? `-${rawProfile.replace(/[^a-zA-Z0-9_.-]/g, "-")}`
            : "";
        const target = path.join(
          args.publishedOutDir,
          `${today}-${args.benchmarkId}-${modelSlug}${profileSlug}-${gitShaShort}.json`,
        );
        writeFileSync(target, raw, "utf8");
        console.log(
          `[bench published] Promoted ${path.basename(artifactPath)} → ${target}`,
        );
      }
      // Reference the bench module so the import isn't tree-shaken if
      // a future refactor wants to call into it from here.
      void benchModule;
    },
  };
}

/**
 * Local-lab responder preflight gate (issue #1573 PR2, cursor review rounds 5-7).
 * Probes ONLY the responder (first phase) endpoint before the benchmark starts
 * so the operator gets a clear model-mismatch / endpoint-down error up front
 * (rule 51: the failure reason carries the endpoint's actual model list) instead
 * of a mid-run failure. The judge is intentionally NOT probed here: in the
 * documented single-GPU swap flow the judge endpoint is not running at startup
 * (the operator starts it after the responder phase), so probing it now would
 * block the sequential run. The judge preflight belongs at the hand-off
 * transition, which PR3 calibration wires via runSequentialPhases.
 *
 * Shared by runBenchViaPackage and runCustomBenchViaPackage so both run paths
 * get the same up-front validation (cursor review round 7: custom runs were
 * missing the gate).
 */
async function preflightLocalLabEndpointsIfNeeded(
  benchModule: PackageBenchModule,
  plan: PackageBenchExecutionPlan,
): Promise<void> {
  if (
    plan.runtime.profile !== "local-lab" ||
    !plan.runtime.localLab ||
    !benchModule.preflightLocalLabRole
  ) {
    return;
  }
  const localLab = plan.runtime.localLab;
  const preflightRole = benchModule.preflightLocalLabRole;

  // 1. Preflight responder.
  const responder = localLab.responder;
  const responderResult = await preflightRole({
    provider: responder.provider,
    baseUrl: responder.baseUrl,
    model: responder.model,
    ctx: responder.ctx,
  });
  if (!responderResult.ok) {
    throw new Error(
      `local-lab responder endpoint preflight failed: ${responderResult.reason}`,
    );
  }

  // 2. Judge endpoint check. When both roles share an endpoint (the common
  //    Ollama hot-swap case), preflight the judge model too and proceed.
  //    When they are on different endpoints, the published harness cannot
  //    yet run sequential phases (answer-all-then-judge-all) — it executes
  //    recall→answer→judge per trial, which requires both models to be
  //    co-resident. Fail fast with an actionable message instead of silently
  //    failing mid-benchmark after the first trial (codex P1 review, #1573 PR2).
  //    Full sequential phase execution is PR3 calibration scope.
  const judge = localLab.judge;
  const stripSlash = (url: string) => (url.endsWith("/") ? url.slice(0, -1) : url);
  const sameEndpoint =
    stripSlash(responder.baseUrl) === stripSlash(judge.baseUrl);
  if (!sameEndpoint) {
    throw new Error(
      "local-lab multi-endpoint sequential phase execution is not yet wired into the benchmark runner " +
        "(PR3 calibration scope). The published harness runs recall→answer→judge per trial, which requires " +
        "both models to be co-resident. Use a single-endpoint profile (both responder and judge models on one " +
        "Ollama instance) or wait for PR3's runSequentialPhases integration.",
    );
  }
  const judgeResult = await preflightRole({
    provider: judge.provider,
    baseUrl: judge.baseUrl,
    model: judge.model,
    ctx: judge.ctx,
  });
  if (!judgeResult.ok) {
    throw new Error(
      `local-lab judge endpoint preflight failed: ${judgeResult.reason}`,
    );
  }
}

function pairedAnswerReplayCacheForBenchmark(
  benchmarkId: string,
  pairedAnswerReplayCache?: import("@remnic/bench").PairedAnswerReplayCache,
): import("@remnic/bench").PairedAnswerReplayCache | undefined {
  return benchmarkId === "locomo" ? pairedAnswerReplayCache : undefined;
}

function clearPairedAnswerReplayCacheOnFailure(
  runtimeProfile: BenchRuntimeProfile,
  benchmarkId: string,
  pairedAnswerReplayCache?: import("@remnic/bench").PairedAnswerReplayCache,
): void {
  if (runtimeProfile !== "baseline" || benchmarkId !== "locomo") return;
  pairedAnswerReplayCache?.clear();
}

function orderPairedLoCoMoWorkItems<
  T extends { benchmarkId: string; runtimeProfile: BenchRuntimeProfile },
>(workItems: readonly T[]): T[] {
  const baselineIndex = workItems.findIndex(
    (item) => item.benchmarkId === "locomo" && item.runtimeProfile === "baseline",
  );
  const realIndex = workItems.findIndex(
    (item) => item.benchmarkId === "locomo" && item.runtimeProfile === "real",
  );
  if (baselineIndex < 0 || realIndex < 0 || baselineIndex < realIndex) {
    return [...workItems];
  }
  const ordered = [...workItems];
  const [baseline] = ordered.splice(baselineIndex, 1);
  ordered.splice(realIndex, 0, baseline!);
  return ordered;
}

async function runBenchViaPackage(
  parsed: ParsedBenchArgs,
  benchmarkId: string,
  runtimeProfile: BenchRuntimeProfile,
  benchStatusPath?: string,
  taskSelector?: PackageBenchTaskSelector,
  pairedAnswerReplayCache?: import("@remnic/bench").PairedAnswerReplayCache,
): Promise<{ ok: boolean; writtenPath?: string }> {
  const loaded = await tryLoadBenchModule();
  if (!loaded) return { ok: false };
  assertBenchModuleFreshForDevelopment();
  const benchModule = loaded as unknown as PackageBenchModule;

  const definition = benchModule.getBenchmark?.(benchmarkId);
  if (!definition?.runnerAvailable || !benchModule.runBenchmark || !benchModule.writeBenchmarkResult) {
    return { ok: false };
  }

  const plans = await buildPackageBenchExecutionPlans(
    benchModule,
    parsed,
    [runtimeProfile],
  );
  if (!plans) {
    return { ok: false };
  }
  const [plan] = plans;
  if (!plan) {
    return { ok: false };
  }

  const judgeCalibration = await preparePersistedJudgeCalibrationAttachment(
    benchModule,
    benchmarkId,
    plan.runtime.judgeProvider,
    parsed,
  );

  // local-lab endpoint preflight gate (issue #1573 PR2, review rounds 5-11).
  // Shared with runCustomBenchViaPackage via preflightLocalLabEndpointsIfNeeded.
  await preflightLocalLabEndpointsIfNeeded(benchModule, plan);

  const outputDir = parsed.resultsDir ?? resolveBenchOutputDir();
  const datasetDir = resolveBenchDatasetDir(
    benchmarkId,
    parsed.quick,
    parsed.datasetDir,
  );

  const benchStartTime = Date.now();
  const partialTasks: import("@remnic/bench").TaskResult[] = [];
  let system: Awaited<ReturnType<PackageBenchExecutionPlan["createAdapter"]>> | undefined;
  const previousCodexDiagnosticsDir =
    process.env[CODEX_CLI_BENCH_DIAGNOSTICS_DIR_ENV];
  const previousCodexDiagnosticsMode =
    process.env[CODEX_CLI_BENCH_DIAGNOSTICS_MODE_ENV];
  if (!previousCodexDiagnosticsDir) {
    process.env[CODEX_CLI_BENCH_DIAGNOSTICS_DIR_ENV] = path.join(
      outputDir,
      "codex-cli-diagnostics",
    );
  }
  if (!previousCodexDiagnosticsMode) {
    process.env[CODEX_CLI_BENCH_DIAGNOSTICS_MODE_ENV] = "metadata";
  }

  // `publishedLimit` (from `bench published --limit N`) takes
  // precedence over the implicit quick-mode limit of 1.
  const effectiveLimit =
    parsed.publishedLimit ?? (parsed.quick ? 1 : undefined);
  // Forward `--seed` through to the runner so the determinism contract
  // advertised by `bench published --seed N` is actually honored.
  // Cursor + Codex review on PR #603: without this, `publishedSeed` was
  // parsed but dropped, and the harness recorded `ctx.options.seed ?? 0`
  // instead of the user-specified seed, breaking reproducibility.
  const effectiveSeed = parsed.publishedSeed;
  let benchmarkOptions = buildPublishedBenchmarkOptions(
    benchmarkId,
    parsed,
    taskSelector,
  );

  try {
    const amaBenchProtocol = buildAmaBenchProtocolOptions(
      benchModule,
      parsed,
      benchmarkId,
      plan.runtime,
    );
    system = benchmarkId === "memcorrect-v1" && parsed.adapter === "mcp"
      ? await createPackageMcpMemCorrectAdapter(benchModule, parsed)
      : await plan.createAdapter({
      ...plan.runtime.adapterOptions,
      ...(benchmarkId === "locomo"
        ? { replayExtractionMode: "skip" as const }
        : {}),
      ...(amaBenchProtocol.primaryJudge
        ? { judge: amaBenchProtocol.primaryJudge }
        : {}),
      });
    if (benchmarkId === "memcorrect-v1" && parsed.adapter === "mcp") {
      benchmarkOptions = { ...(benchmarkOptions ?? {}), adapter: system };
    }
    const locomoPairedAnswerReplayCache = pairedAnswerReplayCacheForBenchmark(
      benchmarkId,
      pairedAnswerReplayCache,
    );
    const result = await benchModule.runBenchmark(benchmarkId, {
      mode: parsed.quick ? "quick" : "full",
      datasetDir,
      outputDir,
      limit: effectiveLimit,
      seed: effectiveSeed,
      adapterMode: plan.adapterMode,
      runtimeProfile: plan.runtime.profile,
      systemProvider: plan.runtime.systemProvider,
      judgeProvider: plan.runtime.judgeProvider,
      internalProvider: plan.runtime.internalProvider,
      remnicConfig: plan.runtime.effectiveRemnicConfig,
      drainTimeoutMs: plan.runtime.adapterOptions.drainTimeoutMs,
      // Issue #1573 PR1: judge-result cache controls from the CLI flags.
      ...(parsed.noJudgeCache ? { noJudgeCache: true } : {}),
      ...(parsed.judgeCacheDir ? { judgeCacheDir: parsed.judgeCacheDir } : {}),
      ...(locomoPairedAnswerReplayCache ? { pairedAnswerReplayCache: locomoPairedAnswerReplayCache } : {}),
      ...(benchmarkOptions ? { benchmarkOptions } : {}),
      ...(amaBenchProtocol.judgeProtocol
        ? { amaBenchJudgeProtocol: amaBenchProtocol.judgeProtocol }
        : {}),
      ...(amaBenchProtocol.crossJudge
        ? { amaBenchCrossJudge: amaBenchProtocol.crossJudge }
        : {}),
      ...(amaBenchProtocol.crossJudgeProvider
        ? { amaBenchCrossJudgeProvider: amaBenchProtocol.crossJudgeProvider }
        : {}),
      ...(plan.runtime.adapterOptions.judge
        ? { memCorrectJudge: plan.runtime.adapterOptions.judge }
        : {}),
      system,
      onTaskComplete: (task, completed, total) => {
        partialTasks.push(task as import("@remnic/bench").TaskResult);
        if (benchStatusPath) {
          updateBenchStatusTaskProgress(
            benchStatusPath,
            completed,
            total ?? undefined,
          ).catch(() => {});
        }
        if (completed % 50 === 0 || completed === total) {
          const elapsed = Math.round((Date.now() - benchStartTime) / 1000);
          const remaining = total && elapsed > 0 ? Math.round((total - completed) / (completed / elapsed)) : "?";
          printBenchStatusLine(
            parsed.json,
            `  [${benchmarkId}] ${completed}/${total ?? "?"} tasks (${elapsed}s elapsed, ~${remaining}s remaining)`,
          );
        }
      },
    });
    result.config.remnicConfig = plan.runtime.remnicConfig;
    result.config.internalProvider = plan.runtime.internalProvider;
    // Issue #1573 PR3 (cursor + codex High/P1 review): load the persisted
    // judge-calibration state for this benchmark so the stored local artifact
    // carries the kappa + warning after `remnic bench judge-calibrate`. Absent
    // calibration (file missing) is the common case — the result is written
    // unchanged, preserving backwards compatibility.
    attachPreparedJudgeCalibration(result, judgeCalibration);
    const writtenPath = await benchModule.writeBenchmarkResult(result, outputDir);
    if (parsed.json) {
      console.log(JSON.stringify(redactBenchResultForStdout(benchModule, result), null, 2));
    } else {
      printBenchPackageSummary(result as never, writtenPath);
    }
    return { ok: true, writtenPath };
  } catch (err) {
    clearPairedAnswerReplayCacheOnFailure(
      runtimeProfile,
      benchmarkId,
      pairedAnswerReplayCache,
    );
    if (partialTasks.length > 0) {
      const remnicVersion = await benchModule.getRemnicVersion?.() ?? "unknown";
      const partialResult = buildPartialBenchmarkResult(
        benchmarkId,
        definition,
        partialTasks,
        plan,
        benchmarkOptions,
        remnicVersion,
        err instanceof Error ? err.message : String(err),
        parsed.quick ? "quick" : "full",
      );
      // Attach persisted calibration to partial results too — the kappa
      // reflects judge reliability, independent of whether the run finished.
      attachPreparedJudgeCalibration(partialResult, judgeCalibration);
      try {
        const partialPath = await benchModule.writeBenchmarkResult(partialResult, outputDir);
        console.error(`  Partial results (${partialTasks.length} tasks) written to ${partialPath}`);
      } catch (writeErr) {
        console.error(`  Failed to write partial results: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
      }
    }
    throw err;
  } finally {
    try {
      await system?.destroy();
    } finally {
      restoreOptionalEnv(
        CODEX_CLI_BENCH_DIAGNOSTICS_DIR_ENV,
        previousCodexDiagnosticsDir,
      );
      restoreOptionalEnv(
        CODEX_CLI_BENCH_DIAGNOSTICS_MODE_ENV,
        previousCodexDiagnosticsMode,
      );
    }
  }
}
/**
 * Prepare a previously persisted judge-calibration state before the benchmark
 * starts, then attach it to the result before writing (issue #1573 PR3). The
 * calibration dir mirrors the one `calibrateBenchJudges` writes to
 * (`~/.remnic/bench/calibration`). When a
 * calibration file exists for the benchmark, its `{ kappa, sampleSize,
 * threshold, warning }` lands in `result.config.benchmarkOptions.judgeCalibration`
 * — the same `benchmarkOptions` envelope that already carries
 * `leaderboardArtifacts`, so the persisted kappa travels with every stored
 * local artifact and is visible to the publish/feed/leaderboard readers.
 *
 * Absent calibration is the common case (operator has not run
 * `judge-calibrate` yet): an unpinned result is returned unchanged. Explicit
 * binding pins make a valid, matching calibration mandatory, so missing or
 * corrupt state cannot silently produce an unbound artifact. Eligible local
 * runs validate state, pins, and the resolved judge configuration before any
 * endpoint or model work, so a stale calibration cannot discard a completed
 * result.
 *
 * Judge binding: attachment requires both persisted configuration hashes to be
 * explicitly pinned by the run, and the run's provider/model must match the
 * calibrated local judge. Legacy state without hashes fails closed and must be
 * regenerated. Only the artifact subset and hashes are stashed — provider
 * identities remain state-file bookkeeping.
 */
type PreparedJudgeCalibrationAttachment = Record<string, unknown>;

/**
 * Validate eligible calibration state before endpoint, adapter, or model work.
 * Unrelated judges ignore unpinned state; eligible runs fail closed on drift.
 */
export async function preparePersistedJudgeCalibrationAttachment(
  benchModule: PackageBenchModule,
  benchmarkId: string,
  runJudgeProvider: PackageBenchProviderConfig | null | undefined,
  calibrationBinding: Pick<ParsedBenchArgs,
    "calibrationDir" | "calibrationLocalConfigSha256" | "calibrationFrontierConfigSha256" |
    "sourceResultId" | "expectedAnswerSetSha256" | "expectedQuestionIdListSha256" | "amaBenchJudgeProtocol"
  >,
): Promise<PreparedJudgeCalibrationAttachment | undefined> {
  const hasLocalPin = Boolean(calibrationBinding.calibrationLocalConfigSha256);
  const hasFrontierPin = Boolean(calibrationBinding.calibrationFrontierConfigSha256);
  const hasAnyPin = hasLocalPin || hasFrontierPin;
  const hasBothPins = hasLocalPin && hasFrontierPin;
  const hasAnyProvenancePin = validateCalibrationProvenancePinSet(calibrationBinding, hasBothPins);
  const hasAnyBindingPin = hasAnyPin || hasAnyProvenancePin;
  if (
    benchmarkId === "ama-bench" &&
    calibrationBinding.amaBenchJudgeProtocol === "recommended"
  ) {
    if (hasAnyBindingPin) {
      throw new Error(
        "AMA-Bench recommended-protocol runs cannot attach default-protocol judge calibration; remove both calibration pins or calibrate the recommended prompt contract separately.",
      );
    }
    return undefined;
  }
  if (hasAnyPin && !hasBothPins) {
    throw new Error(
      "--calibration-local-config-sha256 and --calibration-frontier-config-sha256 must be supplied together.",
    );
  }
  const calibrationDir = expandTilde(
    calibrationBinding.calibrationDir ??
      path.join(resolveHomeDir(), ".remnic", "bench", "calibration"),
  );
  const state = await benchModule.loadJudgeCalibrationState?.(benchmarkId, calibrationDir);
  if (!state) {
    if (hasAnyBindingPin) {
      throw new Error(
        `Calibration binding pins were supplied for ${benchmarkId}, but no valid calibration state could be loaded from ${calibrationDir}; rerun judge-calibrate or remove both pins.`,
      );
    }
    return undefined;
  }

  if (state.localJudgeProvider !== undefined && state.localJudgeModel !== undefined) {
    const matchesLocal =
      runJudgeProvider?.provider === state.localJudgeProvider &&
      runJudgeProvider.model === state.localJudgeModel;
    // The persisted kappa measures the calibrated local judge's agreement
    // with the frontier judge. Frontier and unrelated runs are not attachment
    // candidates, so their normal execution must not require local-run pins.
    if (!matchesLocal) {
      if (hasAnyBindingPin) {
        throw new Error(
          `Calibration binding pins for ${benchmarkId} target the calibrated local judge ` +
            `${state.localJudgeProvider}/${state.localJudgeModel}, but the run judge is ` +
            `${runJudgeProvider?.provider ?? "unset"}/${runJudgeProvider?.model ?? "unset"}; refusing to ignore explicit pins.`,
        );
      }
      return undefined;
    }
  }

  if (!state.localJudgeConfigHash || !state.frontierJudgeConfigHash) {
    throw new Error(
      `Calibration state for ${benchmarkId} is missing bound judge configuration hashes; recalibrate before attaching it.`,
    );
  }

  const resolvedRunJudgeConfigHash = hashCalibrationProviderConfig(runJudgeProvider);
  const hasCompleteLocalIdentity =
    state.localJudgeProvider !== undefined && state.localJudgeModel !== undefined;
  if (
    !hasCompleteLocalIdentity &&
    resolvedRunJudgeConfigHash !== state.localJudgeConfigHash
  ) {
    // Older state may have configuration hashes but no complete provider/model
    // identity. In that case the resolved local-config hash is the only safe
    // eligibility signal: unrelated unpinned runs ignore the state, while
    // explicit pins must never be silently discarded.
    if (hasAnyBindingPin) {
      throw new Error(
        `Calibration binding pins for ${benchmarkId} do not match the resolved run judge configuration; refusing to ignore explicit pins.`,
      );
    }
    return undefined;
  }
  if (
    !calibrationBinding.calibrationLocalConfigSha256 ||
    !calibrationBinding.calibrationFrontierConfigSha256
  ) {
    throw new Error(
      `Calibration state exists for ${benchmarkId}; --calibration-local-config-sha256 and --calibration-frontier-config-sha256 are required to attach it.`,
    );
  }
  if (
    calibrationBinding.calibrationLocalConfigSha256 !== state.localJudgeConfigHash ||
    calibrationBinding.calibrationFrontierConfigSha256 !== state.frontierJudgeConfigHash
  ) {
    throw new Error(`Calibration configuration hash mismatch for ${benchmarkId}; refusing to attach stale kappa.`);
  }

  assertCalibrationProvenanceMatches(calibrationBinding, state, benchmarkId);

  if (resolvedRunJudgeConfigHash !== state.localJudgeConfigHash) {
    throw new Error(
      `Resolved run judge configuration hash mismatch for ${benchmarkId}; ` +
        `expected sha256:${state.localJudgeConfigHash}, got sha256:${resolvedRunJudgeConfigHash}. ` +
        "Refusing to attach stale kappa before benchmark dispatch.",
    );
  }

  return {
    kappa: state.kappa,
    sampleSize: state.sampleSize,
    threshold: state.threshold,
    warning: state.warning,
    ...(state.confidenceInterval ? { confidenceInterval: state.confidenceInterval } : {}),
    ...(state.bootstrapSamples ? { bootstrapSamples: state.bootstrapSamples } : {}),
    ...(state.answerSetHash ? { answerSetHash: state.answerSetHash } : {}),
    ...(state.sourceResultId ? { sourceResultId: state.sourceResultId } : {}),
    ...(state.sliceQuestionIds ? { sliceQuestionIds: state.sliceQuestionIds } : {}),
    localJudgeConfigHash: state.localJudgeConfigHash,
    frontierJudgeConfigHash: state.frontierJudgeConfigHash,
  };
}

export function attachPreparedJudgeCalibration(
  result: { config: { benchmarkOptions?: Record<string, unknown> } },
  judgeCalibration: PreparedJudgeCalibrationAttachment | undefined,
): void {
  if (!judgeCalibration) return;
  result.config.benchmarkOptions = {
    ...(result.config.benchmarkOptions ?? {}),
    judgeCalibration,
  };
}

export function hashCalibrationProviderConfig(config: unknown): string {
  const canonicalize = (value: unknown, key = ""): unknown => {
    if (typeof value === "string" && /(?:api.?key|authorization|token|secret)/i.test(key)) {
      return { secretSha256: createHash("sha256").update(value).digest("hex") };
    }
    if (Array.isArray(value)) return value.map((item) => canonicalize(item));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((childKey) => [
        childKey,
        canonicalize((value as Record<string, unknown>)[childKey], childKey),
      ]));
    }
    return value;
  };
  return createHash("sha256").update(JSON.stringify(canonicalize(config))).digest("hex");
}

function restoreOptionalEnv(key: string, previousValue: string | undefined): void {
  if (previousValue === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = previousValue;
}

function buildAmaBenchProtocolOptions(
  benchModule: PackageBenchModule,
  parsed: ParsedBenchArgs,
  benchmarkId: string,
  runtime: ResolvedBenchRuntimeProfile,
): {
  judgeProtocol?: "default" | "recommended";
  primaryJudge?: unknown;
  crossJudge?: unknown;
  crossJudgeProvider?: PackageBenchProviderConfig | null;
} {
  if (benchmarkId !== "ama-bench") {
    return {};
  }

  const judgeProtocol = parsed.amaBenchJudgeProtocol;
  const primaryJudge = judgeProtocol === "recommended"
    ? createAmaBenchRecommendedJudge(
        benchModule,
        runtime.judgeProvider,
        "--ama-bench-judge-protocol recommended requires --judge-provider and --judge-model.",
      )
    : undefined;

  const crossJudgeProvider = resolveAmaBenchCrossJudgeProvider(parsed, runtime.judgeProvider);
  const crossJudge = crossJudgeProvider
    ? createAmaBenchRecommendedJudge(
        benchModule,
        crossJudgeProvider,
        "--ama-bench-cross-judge-model requires @remnic/bench to expose the AMA-Bench recommended judge.",
      )
    : undefined;

  return {
    judgeProtocol,
    primaryJudge,
    crossJudge,
    crossJudgeProvider,
  };
}

function createAmaBenchRecommendedJudge(
  benchModule: PackageBenchModule,
  provider: PackageBenchProviderConfig | null | undefined,
  missingMessage: string,
): unknown {
  if (!provider) {
    throw new Error(missingMessage);
  }
  if (!benchModule.createProviderBackedAmaBenchRecommendedJudge) {
    throw new Error(
      "Installed @remnic/bench runtime does not expose createProviderBackedAmaBenchRecommendedJudge().",
    );
  }
  return benchModule.createProviderBackedAmaBenchRecommendedJudge(provider);
}

function resolveAmaBenchCrossJudgeProvider(
  parsed: ParsedBenchArgs,
  primaryJudgeProvider: PackageBenchProviderConfig | null,
): PackageBenchProviderConfig | null {
  if (!parsed.amaBenchCrossJudgeModel) {
    return null;
  }

  const provider = parsed.amaBenchCrossJudgeProvider ?? primaryJudgeProvider?.provider;
  if (!provider) {
    throw new Error(
      "--ama-bench-cross-judge-model requires --ama-bench-cross-judge-provider " +
        "or an existing --judge-provider.",
    );
  }
  const canInheritPrimaryTransport =
    parsed.amaBenchCrossJudgeProvider === undefined ||
    parsed.amaBenchCrossJudgeProvider === primaryJudgeProvider?.provider;
  const inheritedBaseUrl = primaryJudgeProvider?.baseUrl;
  const inheritedApiKey = canInheritPrimaryTransport
    ? primaryJudgeProvider?.apiKey
    : undefined;

  return {
    provider,
    model: parsed.amaBenchCrossJudgeModel,
    ...(parsed.amaBenchCrossJudgeBaseUrl ?? inheritedBaseUrl
      ? { baseUrl: parsed.amaBenchCrossJudgeBaseUrl ?? inheritedBaseUrl }
      : {}),
    ...(parsed.amaBenchCrossJudgeApiKey ?? inheritedApiKey
      ? { apiKey: parsed.amaBenchCrossJudgeApiKey ?? inheritedApiKey }
      : {}),
    ...(canInheritPrimaryTransport && primaryJudgeProvider?.retryOptions
      ? { retryOptions: primaryJudgeProvider.retryOptions }
      : {}),
    ...(canInheritPrimaryTransport && primaryJudgeProvider?.disableThinking
      ? { disableThinking: primaryJudgeProvider.disableThinking }
      : {}),
    ...(parsed.amaBenchCrossJudgeCodexReasoningEffort
      ? { reasoningEffort: parsed.amaBenchCrossJudgeCodexReasoningEffort }
      : canInheritPrimaryTransport && primaryJudgeProvider?.reasoningEffort
        ? { reasoningEffort: primaryJudgeProvider.reasoningEffort }
        : {}),
  };
}

function buildPartialBenchmarkResult(
  benchmarkId: string,
  definition: { tier?: string; meta?: { category?: string; version?: string } } | undefined,
  tasks: Array<{ taskId: string; scores: Record<string, number>; latencyMs: number; tokens: { input: number; output: number } }>,
  plan: PackageBenchExecutionPlan,
  benchmarkOptions: Record<string, unknown> | undefined,
  remnicVersion: string,
  failureReason: string,
  mode: "full" | "quick",
) {
  const totalLatencyMs = tasks.reduce((sum, t) => sum + t.latencyMs, 0);
  const totalInput = tasks.reduce((sum, t) => sum + t.tokens.input, 0);
  const totalOutput = tasks.reduce((sum, t) => sum + t.tokens.output, 0);
  return {
    meta: {
      id: "partial",
      benchmark: benchmarkId,
      benchmarkTier: (definition?.tier ?? "remnic") as "published" | "remnic" | "custom",
      version: definition?.meta?.version ?? "0.0.0",
      remnicVersion,
      gitSha: "unknown",
      timestamp: new Date().toISOString(),
      mode,
      runCount: 1,
      seeds: [0],
      status: "partial" as const,
      failureReason,
    },
    config: {
      systemProvider: plan.runtime.systemProvider ?? null,
      judgeProvider: plan.runtime.judgeProvider ?? null,
      internalProvider: plan.runtime.internalProvider ?? null,
      adapterMode: plan.adapterMode,
      remnicConfig: plan.runtime.remnicConfig ?? {},
      ...(benchmarkOptions ? { benchmarkOptions } : {}),
    },
    cost: {
      totalTokens: totalInput + totalOutput,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      estimatedCostUsd: 0,
      totalLatencyMs,
      meanQueryLatencyMs: tasks.length > 0 ? totalLatencyMs / tasks.length : 0,
    },
    results: { tasks: tasks as never[], aggregates: {} },
    environment: {
      os: process.platform,
      nodeVersion: process.version,
      hardware: process.arch,
    },
  };
}

async function runCustomBenchViaPackage(parsed: ParsedBenchArgs): Promise<boolean> {
  const runtimeProfiles = resolveBenchRunProfiles(parsed);
  const loaded = await tryLoadBenchModule();
  if (!loaded) return false;
  assertBenchModuleFreshForDevelopment();
  const benchModule = loaded as unknown as PackageBenchModule;

  if (!benchModule.runCustomBenchmarkFile || !benchModule.writeBenchmarkResult) {
    return false;
  }

  const plans = await buildPackageBenchExecutionPlans(
    benchModule,
    parsed,
    runtimeProfiles,
  );
  if (!plans) {
    return false;
  }

  const outputDir = parsed.resultsDir ?? resolveBenchOutputDir();
  const effectiveLimit = parsed.publishedLimit ?? (parsed.quick ? 1 : undefined);
  const writtenPaths: string[] = [];
  const customBenchmarkIds: string[] = [];
  for (const plan of plans) {
    await preflightLocalLabEndpointsIfNeeded(benchModule, plan);
    const system = await plan.createAdapter(plan.runtime.adapterOptions);

    try {
      const result = await benchModule.runCustomBenchmarkFile(parsed.custom!, {
        mode: parsed.quick ? "quick" : "full",
        outputDir,
        ...(effectiveLimit !== undefined ? { limit: effectiveLimit } : {}),
        ...(parsed.publishedSeed !== undefined ? { seed: parsed.publishedSeed } : {}),
        adapterMode: plan.adapterMode,
        runtimeProfile: plan.runtime.profile,
        systemProvider: plan.runtime.systemProvider,
        judgeProvider: plan.runtime.judgeProvider,
        internalProvider: plan.runtime.internalProvider,
        remnicConfig: plan.runtime.effectiveRemnicConfig,
        system,
        ...(parsed.noJudgeCache ? { noJudgeCache: true } : {}),
        ...(parsed.judgeCacheDir ? { judgeCacheDir: parsed.judgeCacheDir } : {}),
      });
      result.config.remnicConfig = plan.runtime.remnicConfig;
      result.config.internalProvider = plan.runtime.internalProvider;
      customBenchmarkIds.push(result.meta.benchmark);
      const writtenPath = await benchModule.writeBenchmarkResult(result, outputDir);
      writtenPaths.push(writtenPath);
      if (parsed.json) {
        console.log(JSON.stringify(redactBenchResultForStdout(benchModule, result), null, 2));
      } else {
        printBenchPackageSummary(result as never, writtenPath);
      }
    } finally {
      await system.destroy();
    }
  }

  await writeBenchReproManifestForPackageRun({
    parsed,
    benchmarkIds: [...new Set(customBenchmarkIds)],
    runtimeProfiles,
    workItems: plans.map((plan, index) => ({
      benchmarkId: customBenchmarkIds[index] ?? "custom",
      runtimeProfile: plan.runtime.profile,
    })),
    resultPaths: writtenPaths,
  });

  return true;
}

const BENCH_REPRO_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "LITELLM_API_KEY",
  "OLLAMA_API_KEY",
  "OPENAI_API_KEY",
  "QMD_CONFIG_DIR",
  "REMNIC_BENCH_DATASET_ROOT",
  "REMNIC_BENCH_IDS",
  "REMNIC_BENCH_LIMIT",
  "REMNIC_BENCH_MODE",
  "REMNIC_BENCH_MCP_BEARER_TOKEN",
  "REMNIC_BENCH_PHASE_TIMEOUT_MS",
  "REMNIC_BENCH_CODEX_CLI_EXECUTABLE",
  "REMNIC_BENCH_CODEX_CLI_TRANSPORT",
  "REMNIC_BENCH_REQUEST_TIMEOUT_MS",
  "XDG_CACHE_HOME",
] as const;
const CODEX_CLI_BENCH_DIAGNOSTICS_DIR_ENV =
  "REMNIC_BENCH_CODEX_CLI_DIAGNOSTICS_DIR";
const CODEX_CLI_BENCH_DIAGNOSTICS_MODE_ENV =
  "REMNIC_BENCH_CODEX_CLI_DIAGNOSTICS_MODE";

function resolveBenchReproEnvKeys(): string[] {
  return BENCH_REPRO_ENV_KEYS.filter((key) => process.env[key] !== undefined);
}

function resolveBenchReproDatasetDirs(
  parsed: ParsedBenchArgs,
  benchmarkIds: string[],
): Record<string, string | undefined> {
  return Object.fromEntries(
    benchmarkIds.map((benchmarkId) => [
      benchmarkId,
      resolveBenchReproDatasetDir(
        resolveBenchDatasetDir(benchmarkId, parsed.quick, parsed.datasetDir),
      ),
    ]),
  );
}

function resolveBenchReproDatasetDir(
  datasetDir: string | undefined,
): string | undefined {
  if (!datasetDir) {
    return undefined;
  }
  try {
    return fs.realpathSync(datasetDir);
  } catch {
    return datasetDir;
  }
}

async function writeBenchReproManifestForPackageRun(args: {
  parsed: ParsedBenchArgs;
  benchmarkIds: string[];
  runtimeProfiles: BenchRuntimeProfile[];
  workItems?: Array<{
    benchmarkId: string;
    runtimeProfile: BenchRuntimeProfile;
  }>;
  resultPaths: string[];
}): Promise<void> {
  if (args.resultPaths.length === 0) {
    return;
  }
  const loaded = await tryLoadBenchModule();
  const benchModule = loaded as unknown as PackageBenchModule | undefined;
  if (!benchModule?.writeBenchmarkReproManifest) {
    return;
  }

  const resultsDir = args.parsed.resultsDir ?? resolveBenchOutputDir();
  const effectiveLimit =
    args.parsed.publishedLimit ?? (args.parsed.quick ? 1 : undefined);
  try {
    const manifestPath = await benchModule.writeBenchmarkReproManifest(resultsDir, {
      resultPaths: args.resultPaths,
      selectedBenchmarks: args.benchmarkIds,
      runtimeProfiles: args.runtimeProfiles,
      selectedWorkItems: args.workItems?.map((item) => ({
        benchmark: item.benchmarkId,
        runtimeProfile: item.runtimeProfile,
      })),
      mode: args.parsed.quick ? "quick" : "full",
      ...(effectiveLimit !== undefined ? { limit: effectiveLimit } : {}),
      ...(args.parsed.publishedSeed !== undefined ? { seed: args.parsed.publishedSeed } : {}),
      datasetDirs: resolveBenchReproDatasetDirs(args.parsed, args.benchmarkIds),
      command: {
        cwd: process.cwd(),
        argv: redactBenchTaskIdsFilePath(process.argv.slice(2)),
        env: process.env,
        envKeys: resolveBenchReproEnvKeys(),
      },
      configFiles: [
        { label: "remnic", path: args.parsed.remnicConfigPath },
        { label: "openclaw", path: args.parsed.openclawConfigPath },
      ],
      qmd: {
        ...(process.env.QMD_CONFIG_DIR ? { configDir: process.env.QMD_CONFIG_DIR } : {}),
        ...(process.env.XDG_CACHE_HOME ? { cacheDir: process.env.XDG_CACHE_HOME } : {}),
      },
    });
    if (!args.parsed.json) {
      console.log(`Reproducibility manifest: ${manifestPath}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`WARNING: failed to write reproducibility manifest: ${message}`);
  }
}

// ── Config helpers ───────────────────────────────────────────────────────────

function loadStandaloneConvergeCommandConfig(): PluginConfig {
  const configPath = resolveConfigPath();
  const raw = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  return parseConfig(resolveRemnicConfigRecord(raw));
}

function parseConvergePluginConfig(value: unknown): PluginConfig | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (Object.keys(value as Record<string, unknown>).length === 0) return undefined;
  // Present and non-empty config is authoritative. Parse strictly — any invalid value
  // (unknown key, bad policy, malformed/nested structure) MUST surface as an error,
  // never silently default to newest-wins, which could auto-resolve conflicts.
  return parseConfig(resolveRemnicConfigRecord(value));
}

export function loadConvergeCommandConfig(): PluginConfig {
  if (readCompatEnv("REMNIC_CONFIG_PATH", "ENGRAM_CONFIG_PATH")) {
    return loadStandaloneConvergeCommandConfig();
  }

  const openclawConfig = readOpenclawConfig(resolveOpenclawConfigPath());
  const pluginEntry = resolveRemnicPluginEntry(openclawConfig);
  const pluginConfig = parseConvergePluginConfig(pluginEntry?.["config"]);
  if (pluginConfig) return pluginConfig;
  return loadStandaloneConvergeCommandConfig();
}


function resolveExistingBenchRemnicConfigPath(cliPath?: string): string | undefined {
  const configPath = resolveConfigPath(cliPath);
  if (fs.existsSync(configPath)) {
    return configPath;
  }
  if (cliPath) {
    throw new Error(`Remnic config file not found: ${configPath}`);
  }
  return undefined;
}

function resolveExistingBenchOpenclawConfigPath(cliPath?: string): string {
  const configPath = resolveOpenclawConfigPath(cliPath);
  if (fs.existsSync(configPath)) {
    return configPath;
  }
  if (cliPath) {
    throw new Error(`OpenClaw config file not found: ${configPath}`);
  }
  throw new Error(
    `openclaw-chain runtime profile requires an OpenClaw config file. Not found at ${configPath}`,
  );
}

function resolveBenchRunProfiles(
  parsed: ParsedBenchArgs,
): BenchRuntimeProfile[] {
  return parsed.matrixProfiles ?? [parsed.runtimeProfile ?? "baseline"];
}

function resolvePackageBenchAdapterMode(
  parsed: ParsedBenchArgs,
  quick: boolean,
  runtimeProfile: BenchRuntimeProfile,
): PackageBenchAdapterMode {
  if (parsed.adapter === "mcp") return "mcp";
  return quick && runtimeProfile === "baseline" ? "lightweight" : "direct";
}

function resolvePackageBenchAdapterFactory(
  benchModule: PackageBenchModule,
  parsed: ParsedBenchArgs,
  quick: boolean,
  runtimeProfile: BenchRuntimeProfile,
): PackageBenchAdapterFactory | undefined {
  if (parsed.adapter === "mcp") {
    if (parsed.mcpDemo) {
      if (!benchModule.createMcpDemoMemoryAdapter) return undefined;
      return async () => benchModule.createMcpDemoMemoryAdapter!({
        ...(parsed.requestTimeout ? { timeoutMs: parsed.requestTimeout } : {}),
      });
    }
    if (!benchModule.createMcpMemoryAdapter) return undefined;
    return async () => benchModule.createMcpMemoryAdapter!({
      ...buildPackageMcpAdapterOptions(parsed),
    });
  }
  return resolvePackageBenchAdapterMode(parsed, quick, runtimeProfile) === "lightweight"
    ? benchModule.createLightweightAdapter
    : benchModule.createRemnicAdapter;
}

function buildPackageMcpAdapterOptions(parsed: ParsedBenchArgs): {
  transport:
    | { type: "stdio"; command: string; args?: string[] }
    | { type: "http"; url: string; bearerToken?: string };
  tools?: McpMemoryToolMapping;
  timeoutMs?: number;
} {
  const transport = parsed.mcpCommand
    ? { type: "stdio" as const, command: parsed.mcpCommand, args: parsed.mcpArgs }
    : {
        type: "http" as const,
        url: parsed.mcpUrl!,
        bearerToken: process.env.REMNIC_BENCH_MCP_BEARER_TOKEN,
      };
  return {
    transport,
    ...(parsed.mcpToolMap ? { tools: parsed.mcpToolMap } : {}),
    ...(parsed.requestTimeout ? { timeoutMs: parsed.requestTimeout } : {}),
  };
}

async function createPackageMcpMemCorrectAdapter(
  benchModule: PackageBenchModule,
  parsed: ParsedBenchArgs,
): Promise<{ destroy(): Promise<void> }> {
  if (parsed.mcpDemo) {
    if (!benchModule.createMcpDemoMemCorrectAdapter) {
      throw new Error(
        "Installed @remnic/bench does not export createMcpDemoMemCorrectAdapter().",
      );
    }
    return benchModule.createMcpDemoMemCorrectAdapter({
      ...(parsed.requestTimeout ? { timeoutMs: parsed.requestTimeout } : {}),
    });
  }
  if (!benchModule.createMcpMemCorrectAdapter) {
    throw new Error(
      "Installed @remnic/bench does not export createMcpMemCorrectAdapter().",
    );
  }
  return benchModule.createMcpMemCorrectAdapter(
    buildPackageMcpAdapterOptions(parsed),
  );
}

export async function buildPackageBenchExecutionPlans(
  benchModule: PackageBenchModule,
  parsed: ParsedBenchArgs,
  runtimeProfiles: BenchRuntimeProfile[],
): Promise<PackageBenchExecutionPlan[] | false> {
  const plans: PackageBenchExecutionPlan[] = [];

  for (const runtimeProfile of runtimeProfiles) {
    const runtime = await resolvePackageBenchRuntime(
      benchModule,
      parsed,
      runtimeProfile,
    );
    const createAdapter = resolvePackageBenchAdapterFactory(
      benchModule,
      parsed,
      parsed.quick,
      runtime.profile,
    );

    if (!createAdapter) {
      return false;
    }

    plans.push({
      runtime,
      createAdapter,
      adapterMode: resolvePackageBenchAdapterMode(parsed, parsed.quick, runtime.profile),
    });
  }

  return plans;
}

async function resolvePackageBenchRuntime(
  benchModule: PackageBenchModule,
  parsed: ParsedBenchArgs,
  runtimeProfile: BenchRuntimeProfile,
): Promise<ResolvedBenchRuntimeProfile> {
  if (!benchModule.resolveBenchRuntimeProfile) {
    throw new Error(
      "Installed @remnic/bench runtime does not expose resolveBenchRuntimeProfile().",
    );
  }

  return benchModule.resolveBenchRuntimeProfile(
    buildBenchRuntimeProfileRequest(parsed, runtimeProfile),
  );
}

function normalizeMemoryDirPath(memoryDir: string): string {
  return path.resolve(expandTilde(memoryDir));
}

export function resolveMemoryDir(): string {
  // Priority: env var > config file > auto-detect
  const configMemoryDir = (() => {
    // Env var takes top priority (deployment override)
    const envMemoryDir = readCompatEnv("REMNIC_MEMORY_DIR", "ENGRAM_MEMORY_DIR");
    if (envMemoryDir) return normalizeMemoryDirPath(envMemoryDir);
    // Then config file
    const configPath = resolveConfigPath();
    const raw = fs.existsSync(configPath)
      ? JSON.parse(fs.readFileSync(configPath, "utf8"))
      : {};
    const remnicCfg = resolveRemnicConfigRecord(raw);
    if (typeof remnicCfg.memoryDir === "string" && remnicCfg.memoryDir.length > 0) {
      return normalizeMemoryDirPath(remnicCfg.memoryDir);
    }
    // Auto-detect: prefer standalone path if it exists, fall back to OpenClaw
    const home = resolveHomeDir();
    const standalonePath = path.join(home, ".remnic", "memory");
    const legacyStandalonePath = path.join(home, ".engram", "memory");
    const openclawPath = path.join(resolveOpenclawStateDir(), "workspace", "memory", "local");
    if (fs.existsSync(standalonePath)) return standalonePath;
    if (fs.existsSync(legacyStandalonePath)) return legacyStandalonePath;
    return openclawPath;
  })();

  // Check active space — only if manifest exists (don't bootstrap just to resolve)
  const manifestPath = getManifestPath();
  if (fs.existsSync(manifestPath)) {
    try {
      const active = getActiveSpace();
      if (active?.memoryDir) {
        const activeMemoryDir = normalizeMemoryDirPath(active.memoryDir);
        if (!fs.existsSync(activeMemoryDir)) {
          // Recreate missing directory instead of silently falling back
          fs.mkdirSync(activeMemoryDir, { recursive: true });
        }
        return activeMemoryDir;
      }
      // No active space with memoryDir — fall through to config
    } catch (err: unknown) {
      // getActiveSpace() throws "Active space ... not found" when the activeSpaceId
      // references a space that was deleted — this is recoverable, fall through.
      // Any other error (corrupted JSON, permission denied) is fatal.
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("not found")) {
        console.error(`Error: failed to resolve active space from ${manifestPath}: ${msg}`);
        process.exit(1);
      }
      // Active space not found — fall through to config-based dir
    }
  }

  return configMemoryDir;
}

/**
 * Like resolveFlag, but rejects the next token if it looks like another flag
 * (starts with "-"). Prevents `--config --yes` from treating --yes as the
 * config path. Use this variant only for flags that require a value argument.
 */
function resolveFlagStrict(args: string[], flag: string): string | undefined {
  let value: string | undefined;
  for (let idx = 0; idx < args.length; idx++) {
    if (args[idx] !== flag) continue;

    if (idx + 1 >= args.length) {
      throw new Error(
        `${flag} requires a value. Provide it as \`${flag} <value>\`, not as a bare flag.`,
      );
    }
    const next = args[idx + 1];
    if (next.startsWith("-")) {
      throw new Error(
        `${flag} requires a value. Provide it as \`${flag} <value>\`, not as a bare flag.`,
      );
    }

    value ??= next;
    idx++;
  }
  return value;
}
// ── OpenClaw config helpers ───────────────────────────────────────────────────

/**
 * The canonical plugin id used in plugins.entries and plugins.slots.memory.
 * Must match the `id` field in openclaw.plugin.json (and the shim for legacy).
 * PR #405 renames the plugin from "openclaw-engram" → "openclaw-remnic"; this
 * constant reflects the post-rename id so that `remnic openclaw install`
 * configures the new package (@remnic/plugin-openclaw) by default.
 * If you are still running the legacy "openclaw-engram" package, the slot will
 * not match until you upgrade — use `remnic doctor` to diagnose.
 */
const REMNIC_OPENCLAW_LEGACY_PLUGIN_ID = "openclaw-engram";

function resolveOpenclawStateDir(): string {
  const configuredStateDir = process.env.OPENCLAW_STATE_DIR?.trim();
  return configuredStateDir
    ? path.resolve(expandTilde(configuredStateDir))
    : path.join(resolveHomeDir(), ".openclaw");
}

// Primary env var takes precedence; legacy env var is checked as fallback.
// This matches the priority convention in readCompatEnv() (primary > legacy > default).
const DEFAULT_OPENCLAW_CONFIG_PATHS_FOR_DOCTOR = [
  process.env.OPENCLAW_CONFIG_PATH,
  process.env.OPENCLAW_ENGRAM_CONFIG_PATH,
  path.join(resolveOpenclawStateDir(), "openclaw.json"),
].filter(Boolean) as string[];

function resolveOpenclawConfigPath(cliPath?: string): string {
  if (cliPath) return path.resolve(expandTilde(cliPath));

  // Env-var paths are always honoured regardless of whether the file exists yet
  // (a first-time install needs to create the file at the configured location).
  // Only fall through to existence-probing when no env var is set.
  // Apply expandTilde so values like ~/openclaw.json work correctly.
  const envPath =
    process.env.OPENCLAW_CONFIG_PATH || process.env.OPENCLAW_ENGRAM_CONFIG_PATH;
  if (envPath) return path.resolve(expandTilde(envPath));

  // No env var: return the first existing default path, or the canonical default.
  for (const candidate of DEFAULT_OPENCLAW_CONFIG_PATHS_FOR_DOCTOR) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(resolveOpenclawStateDir(), "openclaw.json");
}

function readOpenclawConfig(configPath: string): Record<string, unknown> {
  if (!fs.existsSync(configPath)) return {};
  const raw = fs.readFileSync(configPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `OpenClaw config at ${configPath} contains invalid JSON — refusing to overwrite.\n` +
      `Fix the file manually, then re-run.\nParse error: ${(err as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `OpenClaw config at ${configPath} is not a JSON object (got ${Array.isArray(parsed) ? "array" : typeof parsed}) — refusing to overwrite.`,
    );
  }
  return parsed as Record<string, unknown>;
}

function parseOpenclawPluginState(
  existingConfig: Record<string, unknown>,
  configPath: string,
): {
  plugins: Record<string, unknown>;
  entries: Record<string, unknown>;
  slots: Record<string, unknown>;
} {
  const rawPlugins = existingConfig.plugins;
  if (rawPlugins !== undefined && (typeof rawPlugins !== "object" || rawPlugins === null || Array.isArray(rawPlugins))) {
    throw new Error(
      `OpenClaw config at ${configPath} has an invalid plugins field (expected an object, got ${Array.isArray(rawPlugins) ? "array" : typeof rawPlugins}). ` +
      `Fix the file manually and re-run.`,
    );
  }
  const plugins = (rawPlugins ?? {}) as Record<string, unknown>;

  const rawEntries = plugins.entries;
  if (rawEntries !== undefined && (typeof rawEntries !== "object" || rawEntries === null || Array.isArray(rawEntries))) {
    throw new Error(
      `OpenClaw config at ${configPath} has an invalid plugins.entries field (expected an object, got ${Array.isArray(rawEntries) ? "array" : typeof rawEntries}). ` +
      `Fix the file manually and re-run.`,
    );
  }
  const entries = (rawEntries ?? {}) as Record<string, unknown>;

  const rawSlots = plugins.slots;
  if (rawSlots !== undefined && (typeof rawSlots !== "object" || rawSlots === null || Array.isArray(rawSlots))) {
    throw new Error(
      `OpenClaw config at ${configPath} has an invalid plugins.slots field (expected an object, got ${Array.isArray(rawSlots) ? "array" : typeof rawSlots}). ` +
      `Fix the file manually and re-run.`,
    );
  }
  const slots = (rawSlots ?? {}) as Record<string, unknown>;

  return { plugins, entries, slots };
}

function readOpenclawHooksPolicy(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function buildRemnicOpenclawHooksPolicy(
  legacyHooks: unknown,
  existingHooks: unknown,
): Record<string, unknown> {
  return {
    ...readOpenclawHooksPolicy(legacyHooks),
    ...readOpenclawHooksPolicy(existingHooks),
    allowConversationAccess: true,
  };
}

function resolveOpenclawInstallMemoryDir(args: {
  requestedMemoryDir?: string;
  existingNewEntryConfig: Record<string, unknown>;
  legacyConfigToMerge: Record<string, unknown>;
  migrateLegacy: boolean;
  fallbackMemoryDir: string;
}): string {
  const existingMemoryDir: string | undefined =
    (typeof args.existingNewEntryConfig.memoryDir === "string" ? args.existingNewEntryConfig.memoryDir : undefined) ||
    (args.migrateLegacy && typeof args.legacyConfigToMerge.memoryDir === "string"
      ? args.legacyConfigToMerge.memoryDir
      : undefined);

  if (args.requestedMemoryDir) {
    return path.resolve(expandTilde(args.requestedMemoryDir));
  }
  if (existingMemoryDir) {
    return path.resolve(expandTilde(existingMemoryDir));
  }
  return args.fallbackMemoryDir;
}

function resolveCurrentOpenclawMemoryDir(
  entries: Record<string, unknown>,
  slots: Record<string, unknown>,
  fallbackMemoryDir: string,
): string {
  const slotValue =
    slots.memory === REMNIC_OPENCLAW_PLUGIN_ID ||
    slots.memory === REMNIC_OPENCLAW_LEGACY_PLUGIN_ID
      ? slots.memory
      : undefined;
  const candidateIds = [
    slotValue,
    REMNIC_OPENCLAW_PLUGIN_ID,
    REMNIC_OPENCLAW_LEGACY_PLUGIN_ID,
  ].filter((value, index, all): value is string => !!value && all.indexOf(value) === index);

  for (const candidateId of candidateIds) {
    const entry = entries[candidateId];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const config = (entry as Record<string, unknown>).config;
    if (!config || typeof config !== "object" || Array.isArray(config)) continue;
    const memoryDir = (config as Record<string, unknown>).memoryDir;
    if (typeof memoryDir === "string" && memoryDir.trim().length > 0) {
      return path.resolve(expandTilde(memoryDir));
    }
  }

  return fallbackMemoryDir;
}

function resolveOpenclawPluginDir(cliPath?: string): string {
  if (cliPath) return path.resolve(expandTilde(cliPath));
  return resolveOpenclawManagedPluginDir();
}

function resolveOpenclawManagedPluginDir(): string {
  return path.join(resolveOpenclawStateDir(), "extensions", REMNIC_OPENCLAW_PLUGIN_ID);
}

function resolveOpenclawLegacyPluginDir(cliPath?: string): string {
  if (cliPath) return path.resolve(expandTilde(cliPath));
  return path.join(resolveOpenclawStateDir(), "extensions", REMNIC_OPENCLAW_LEGACY_PLUGIN_ID);
}

function formatOpenclawUpgradeStamp(now = new Date()): string {
  const yyyy = now.getFullYear().toString();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

function backupPathIfPresent(sourcePath: string, backupPath: string): boolean {
  if (!fs.existsSync(sourcePath)) return false;
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.cpSync(sourcePath, backupPath, { recursive: true });
  return true;
}


function restartOpenclawGateway(): void {
  if (process.platform !== "darwin") {
    throw new Error(
      `Automatic gateway restart is only implemented for macOS launchctl. ` +
      `Restart OpenClaw manually for platform ${process.platform}.`,
    );
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid === undefined) {
    throw new Error("Cannot determine the current macOS user id for launchctl restart.");
  }
  childProcess.execFileSync("launchctl", ["kickstart", "-k", `gui/${uid}/${OPENCLAW_GATEWAY_LABEL}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}
// ── Commands ─────────────────────────────────────────────────────────────────

function cmdInit(): void {
  const configPath = path.join(process.cwd(), "remnic.config.json");
  if (fs.existsSync(configPath)) {
    console.log(`Config already exists: ${configPath}`);
    return;
  }

  const template: Record<string, unknown> = {
    remnic: {
      openaiApiKey: "${OPENAI_API_KEY}",
      memoryDir: path.join(process.cwd(), ".remnic", "memory"),
      memoryOsPreset: "balanced",
    },
    server: {
      host: "127.0.0.1",
      port: 4318,
      authToken: "${REMNIC_AUTH_TOKEN}",
    },
  };

  fs.writeFileSync(configPath, JSON.stringify(template, null, 2) + "\n");
  console.log(`Created ${configPath}`);
  console.log("\nSet these environment variables:");
  console.log("  export OPENAI_API_KEY=sk-...");
  console.log("  export REMNIC_AUTH_TOKEN=$(openssl rand -hex 32)");
  console.log("  # ENGRAM_AUTH_TOKEN is still accepted during v1.x");
  console.log("\nThen start the server:");
  console.log("  npx --package @remnic/server remnic-server");
}

/**
 * Resolve a bearer token for the local status/health probe (issue #2006).
 * Precedence mirrors the daemon: operator token first (env
 * `REMNIC_AUTH_TOKEN` / `ENGRAM_AUTH_TOKEN`, then config `server.authToken`
 * via `resolveOperatorToken()`), then any connector token from the
 * local token store — the access server accepts connector tokens for
 * health. Returns `undefined` for open daemons so the probe stays
 * unauthenticated exactly as before.
 */
function resolveStatusProbeToken(): string | undefined {
  const operatorToken = resolveOperatorToken(resolveConfigPath());
  if (operatorToken) return operatorToken;
  try {
    // Connector tokens authorize health EXCEPT chatgpt-minted ones, which
    // the access server pins to /mcp only (tokenPathPolicy). Skip those so
    // a ChatGPT entry at the head of the store doesn't produce a misleading
    // 401 when an ordinary connector token would authenticate health.
    const usable = listTokens().find(
      (t) => t.connector !== "chatgpt" && typeof t.token === "string" && t.token.length > 0,
    );
    if (usable) return usable.token;
  } catch {
    // Token store missing/unreadable — fall through to the open probe.
  }
}

export const __statusHealthTestHooks = { resolveStatusProbeToken };

async function cmdStatus(json: boolean): Promise<void> {
  // Remote mode (issue #2448): a configured REMNIC_DAEMON_URL / server.url
  // origin is the target. No local service-manager probe, no PID file —
  // "running" means the remote health endpoint answered.
  const remote = resolveRemoteDaemon(resolveConfigPath());
  if (remote) {
    if (json) {
      const probe = await probeDaemonHealth(remote.baseUrl, remote.token);
      console.log(
        JSON.stringify({
          running: probe.ok,
          pid: null,
          pidFile: null,
          logFile: null,
          remote: remote.baseUrl,
        }),
      );
      return;
    }
    console.log(`Remnic server: remote (${remote.baseUrl})`);
    await printHealthCheck(remote.baseUrl, remote.token);
    return;
  }

  const { running, pid } = isServiceRunning();
  if (json) {
    console.log(JSON.stringify({ running, pid: pid ?? null, pidFile: PID_FILE, logFile: LOG_FILE }));
    return;
  }
  if (!running) {
    console.log("Remnic server: stopped");
    return;
  }
  console.log(`Remnic server: running${pid ? ` (pid ${pid})` : ""}`);
  await printHealthCheck(resolveDaemonBaseUrl(resolveConfigPath()), resolveStatusProbeToken());
}
// ── OAuth operator commands ─────────────────────────────────────────────────
//
// `remnic oauth <pending|approve|deny>` lets the operator manage pending
// authorization requests served by `@remnic/server`'s OAuth 2.1 facade
// (issue #1963 / ChatGPT developer-mode MCP). The daemon exposes three
// bearer-protected endpoints (operator token is the same `server.authToken`
// the rest of the access server accepts); this CLI is the only path the
// human operator uses to approve or deny the requests those endpoints
// represent.
//
// Reuses the same patterns as `cmdStatus` (host/port via
// `resolveConfigPath` + the `server.port` default, bearer token from
// `server.authToken` with the `REMNIC_AUTH_TOKEN` / `ENGRAM_AUTH_TOKEN`
// env fallback already used by the offline token resolver) and the
// `--format json|text` flag pattern from `cmdProcedural`.

/** Shape of one entry in `GET /oauth/pending`. Mirrors the server response. */
interface OAuthPendingEntry {
  ref: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  resource: string | null;
  createdAt: string;
  expiresAt: string;
}

/** Result of a `POST /oauth/pending/<ref>/{approve,deny}` decision. */
interface OAuthDecisionResponse {
  ref: string;
  status: "approved" | "denied";
  redirect?: string;
}


/**
 * Hit one of the operator OAuth endpoints. Centralises the auth header,
 * the timeout, and the user-facing error mapping (401 → "operator token
 * rejected"; connection refused → "is remnic-server running?"). The
 * `JSON.parse` body is the result; status 204 / 200 with no body returns
 * `null`. Throws on transport / status errors so the caller can
 * translate the message into a CLI exit code.
 */
async function oauthFetch(
  method: "GET" | "POST",
  path: string,
  token: string,
  body: unknown | undefined,
): Promise<unknown> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5_000);
  try {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: "application/json",
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    const init: RequestInit = {
      method,
      signal: controller.signal,
      headers,
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const response = await fetch(`${resolveDaemonBaseUrl(resolveConfigPath())}${path}`, init);
    if (response.status === 401) {
      throw new Error(
        "operator token rejected by remnic-server (HTTP 401). Update `server.authToken` or `REMNIC_AUTH_TOKEN` to match the running daemon.",
      );
    }
    if (response.status === 404) {
      throw new Error("unknown or expired ref");
    }
    if (response.status === 409) {
      let description = "request conflicts with current state";
      try {
        const payload: unknown = await response.json();
        if (
          payload &&
          typeof payload === "object" &&
          "error_description" in payload
        ) {
          const candidate = (payload as Record<string, unknown>).error_description;
          if (typeof candidate === "string" && candidate.length > 0) {
            description = candidate;
          }
        }
      } catch {
        // Body wasn't JSON; keep the default description.
      }
      throw new Error(description);
    }
    if (!response.ok) {
      throw new Error(`remnic-server returned HTTP ${response.status} ${response.statusText}`);
    }
    const text = await response.text();
    if (text.length === 0) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("remnic-server returned a non-JSON response");
    }
  } catch (err) {
    if (err instanceof Error) {
      const msg = err.message;
      if (
        msg.includes("ECONNREFUSED") ||
        msg.includes("ECONNRESET") ||
        msg.includes("fetch failed") ||
        msg.includes("aborted") ||
        msg.includes("ENOTFOUND")
      ) {
        throw new Error(
          `cannot reach remnic-server at ${resolveDaemonBaseUrl(resolveConfigPath())} — is remnic-server running? Start it with \`remnic daemon start\` (or point REMNIC_DAEMON_URL at a remote daemon).`,
        );
      }
      throw err;
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Render the pending list as a human-readable table. One line per entry:
 *   ref <id>  client=<id>  redirect=<uri>  expires=<iso>
 * Empty arrays produce the "No pending OAuth authorizations." line; the
 * caller decides whether to add a trailing newline.
 */
function oauthFormatPendingText(pending: readonly OAuthPendingEntry[]): string {
  if (pending.length === 0) {
    return "No pending OAuth authorizations.";
  }
  const lines: string[] = [`Pending OAuth authorizations (${pending.length}):`];
  for (const txn of pending) {
    const scopes = txn.scopes.length === 0 ? "(none)" : txn.scopes.join(" ");
    const resource = txn.resource === null || txn.resource.length === 0 ? "(none)" : txn.resource;
    lines.push(
      `  ref=${txn.ref}  client=${txn.clientId}  redirect=${txn.redirectUri}`,
      `      scopes=${scopes}  resource=${resource}  expires=${txn.expiresAt}`,
    );
  }
  return lines.join("\n");
}

/**
 * Prompt the operator on a TTY. Returns true on `y` / `yes` (case
 * insensitive), false on `n` / `no` / empty / EOF. Non-TTY callers MUST
 * use `--yes` (or a similar explicit flag) — the `cmdOAuth` approve
 * branch enforces that at the dispatch site.
 */
async function oauthPromptYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }
  process.stdout.write(`${question} [y/N] `);
  return new Promise<boolean>((resolve) => {
    let buffer = "";
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      buffer += text;
      if (text.includes("\n")) {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        const answer = buffer.trim().toLowerCase();
        resolve(answer === "y" || answer === "yes");
      }
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

/** Print the full request details + warning before approval. */
function oauthPrintApprovalDetails(txn: OAuthPendingEntry): void {
  const scopeList = txn.scopes.length === 0 ? "(none)" : txn.scopes.join(" ");
  const resource = txn.resource === null || txn.resource === undefined
    ? "(none)"
    : txn.resource;
  console.log("Pending OAuth authorization request:");
  console.log(`  ref:         ${txn.ref}`);
  console.log(`  client:      ${txn.clientId}`);
  console.log(`  redirect:    ${txn.redirectUri}`);
  console.log(`  scopes:      ${scopeList}`);
  console.log(`  resource:    ${resource}`);
  console.log(`  created:     ${txn.createdAt}`);
  console.log(`  expires:     ${txn.expiresAt}`);
  console.log(
    "WARNING: approval grants the requesting application an MCP access token tied to this Remnic instance.",
  );
}

const OAUTH_USAGE = `Usage: remnic oauth <pending|approve|deny> [options]

Manage pending OAuth authorizations (ChatGPT MCP).

Subcommands:
  remnic oauth pending [--format json|text]            List pending authorization requests
  remnic oauth approve <ref> [--yes]                   Approve a pending request
  remnic oauth deny <ref>                              Deny a pending request

Options:
  --format <name>   Output format for \`pending\`: "text" (default) or "json"
  --yes             Required for \`approve\` when stdin is not a TTY

Server endpoints (operator bearer auth):
  GET  /oauth/pending
  POST /oauth/pending/<ref>/approve
  POST /oauth/pending/<ref>/deny`;

/**
 * Resolve the operator token or exit. Called AFTER input validation in
 * each subcommand branch — invalid input must be reported regardless of
 * env/config state (rule: validate inputs first, deterministically).
 */
function oauthRequireOperatorToken(): string {
  const token = resolveOperatorToken(resolveConfigPath());
  if (!token) {
    console.error(
      "remnic oauth: no operator token configured. Set `server.authToken` in remnic.config.json or export REMNIC_AUTH_TOKEN.",
    );
    process.exit(1);
  }
  return token;
}

/**
 * Strict argument validation for `remnic oauth` subcommands (rule: reject
 * invalid CLI input explicitly; never silently ignore it). Walks the args
 * once, rejects unknown options, and enforces the positional arity.
 * Returns the positional args in order.
 */
function oauthValidateArgs(
  args: string[],
  spec: { flags: Record<string, "value" | "boolean">; maxPositionals: number; usage: string },
): string[] {
  const positionals: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg !== undefined && arg.startsWith("-")) {
      if (seen.has(arg)) {
        console.error(`Duplicate option "${arg}". ${spec.usage}`);
        process.exit(1);
      }
      seen.add(arg);
      const kind = spec.flags[arg];
      if (kind === undefined) {
        console.error(`Unknown option "${arg}". ${spec.usage}`);
        process.exit(1);
      }
      if (kind === "value") {
        const next = args[i + 1];
        if (next === undefined || next.startsWith("-")) {
          console.error(`${arg} requires a value. ${spec.usage}`);
          process.exit(1);
        }
        i++; // skip the flag's value slot
      }
      continue;
    }
    if (arg !== undefined) positionals.push(arg);
  }
  if (positionals.length > spec.maxPositionals) {
    console.error(`Unexpected argument "${positionals[spec.maxPositionals]}". ${spec.usage}`);
    process.exit(1);
  }
  return positionals;
}

async function cmdOAuth(rest: string[]): Promise<void> {
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") {
    console.log(OAUTH_USAGE);
    return;
  }
  const subcommand = rest[0];
  const subRest = rest.slice(1);

  switch (subcommand) {
    case "pending": {
      oauthValidateArgs(subRest, {
        flags: { "--format": "value" },
        maxPositionals: 0,
        usage: "Usage: remnic oauth pending [--format json|text]",
      });
      const formatRaw = resolveFlag(subRest, "--format");
      const formatPresent = hasFlag(subRest, "--format");
      const format = (() => {
        if (!formatPresent || formatRaw === undefined || formatRaw === null) return "text";
        const normalized = String(formatRaw).trim().toLowerCase();
        if (normalized !== "text" && normalized !== "json") {
          console.error(`Invalid --format "${formatRaw}". Allowed: text, json.`);
          process.exit(1);
        }
        return normalized;
      })();
      const token = oauthRequireOperatorToken();
      try {
        const payload = (await oauthFetch("GET", "/oauth/pending", token, undefined)) as
          | { pending?: OAuthPendingEntry[] }
          | null;
        const pending = Array.isArray(payload?.pending) ? payload.pending : [];
        if (format === "json") {
          process.stdout.write(JSON.stringify(payload ?? { pending: [] }, null, 2) + "\n");
          return;
        }
        console.log(oauthFormatPendingText(pending));
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      return;
    }

    case "approve": {
      const positionals = oauthValidateArgs(subRest, {
        flags: { "--yes": "boolean", "-y": "boolean" },
        maxPositionals: 1,
        usage: "Usage: remnic oauth approve <ref> [--yes]",
      });
      const ref = positionals[0];
      if (!ref) {
        console.error("Usage: remnic oauth approve <ref> [--yes]");
        process.exit(1);
      }
      const yes = hasFlag(subRest, "--yes") || hasFlag(subRest, "-y");
      const token = oauthRequireOperatorToken();
      try {
        const payload = (await oauthFetch("GET", "/oauth/pending", token, undefined)) as
          | { pending?: OAuthPendingEntry[] }
          | null;
        const pending = Array.isArray(payload?.pending) ? payload.pending : [];
        const txn = pending.find((entry) => entry.ref === ref);
        if (!txn) {
          console.error(
            `remnic oauth approve: no pending authorization with ref "${ref}". Run \`remnic oauth pending\` to see active requests.`,
          );
          process.exit(1);
        }
        oauthPrintApprovalDetails(txn);
        let confirmed = yes;
        if (!confirmed) {
          if (!process.stdin.isTTY) {
            console.error(
              "remnic oauth approve: refusing to send the approval without an explicit --yes flag (stdin is not a TTY). Re-run with --yes to confirm.",
            );
            process.exit(1);
          }
          confirmed = await oauthPromptYesNo("Approve this request?");
          if (!confirmed) {
            console.log("Approval cancelled.");
            return;
          }
        }
        const result = (await oauthFetch(
          "POST",
          `/oauth/pending/${encodeURIComponent(ref)}/approve`,
          token,
          {},
        )) as OAuthDecisionResponse | null;
        const status = result?.status ?? "approved";
        const redirect = result?.redirect;
        console.log(`Approved ref=${ref} (status: ${status}).`);
        if (typeof redirect === "string" && redirect.length > 0) {
          console.log(`Client redirect: ${redirect}`);
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      return;
    }

    case "deny": {
      const positionals = oauthValidateArgs(subRest, {
        flags: {},
        maxPositionals: 1,
        usage: "Usage: remnic oauth deny <ref>",
      });
      const ref = positionals[0];
      if (!ref) {
        console.error("Usage: remnic oauth deny <ref>");
        process.exit(1);
      }
      const token = oauthRequireOperatorToken();
      try {
        const result = (await oauthFetch(
          "POST",
          `/oauth/pending/${encodeURIComponent(ref)}/deny`,
          token,
          {},
        )) as OAuthDecisionResponse | null;
        const status = result?.status ?? "denied";
        console.log(`Denied ref=${ref} (status: ${status}).`);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      return;
    }

    default: {
      console.error(
        `Unknown oauth subcommand "${String(subcommand)}". Run \`remnic oauth --help\` for usage.`,
      );
      process.exit(1);
    }
  }
}

export interface QueryRenderableResult {
  content?: string;
  preview?: string;
  context?: string;
  id?: string;
  memoryId?: string;
  path?: string;
  file?: string;
  source?: string;
  score?: number;
}

function queryResultText(memory: QueryRenderableResult): string {
  return (
    memory.content?.trim()
    || memory.preview?.trim()
    || memory.context?.trim()
    || "(no preview available)"
  );
}

export function renderQueryTextLines(result: {
  results?: QueryRenderableResult[];
  context?: string;
}): string[] {
  const results = Array.isArray(result.results) ? result.results : [];
  if (results.length === 0) return ["No results."];

  return results.map((memory) => {
    return `- ${queryResultText(memory)}`;
  });
}

export interface QueryExplainFallbackResultSummary {
  index: number;
  text: string;
  id?: string;
  source?: string;
  score?: number;
}

function firstNonEmptyString(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

export function summarizeQueryExplainFallbackResults(result: {
  results?: QueryRenderableResult[];
}): QueryExplainFallbackResultSummary[] {
  const results = Array.isArray(result.results) ? result.results : [];
  return results.map((memory, index) => {
    const summary: QueryExplainFallbackResultSummary = {
      index: index + 1,
      text: queryResultText(memory),
    };
    const id = firstNonEmptyString(memory.id, memory.memoryId);
    if (id) summary.id = id;
    const source = firstNonEmptyString(memory.source, memory.path, memory.file);
    if (source) summary.source = source;
    if (typeof memory.score === "number" && Number.isFinite(memory.score)) {
      summary.score = memory.score;
    }
    return summary;
  });
}

export function buildQueryRecallRequest(queryText: string): {
  query: string;
  mode: "auto";
  sessionKey: string;
} {
  return {
    query: queryText,
    mode: "auto",
    sessionKey: `remnic-cli:query:${process.pid}`,
  };
}

async function cmdQuery(queryText: string, json: boolean, explain: boolean): Promise<void> {
  if (!queryText) {
    console.error("Usage: remnic query <text>");
    process.exit(1);
  }

  // Remote mode (issue #2448): route the recall through the configured
  // origin instead of booting a local orchestrator.
  const remote = resolveRemoteDaemon(resolveConfigPath());
  if (remote) {
    const started = Date.now();
    const result = await remoteRecall(remote, buildQueryRecallRequest(queryText));
    if (explain) {
      printMinimalQueryExplain(queryText, result, Date.now() - started, json);
      return;
    }
    printQueryResult(result, json);
    return;
  }

  initLogger();
  const configPath = resolveConfigPath();
  const raw = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  const remnicCfg = resolveRemnicConfigRecord(raw);
  const config = parseConfig(remnicCfg);
  const orchestrator = new Orchestrator(config);
  await orchestrator.initialize();
  const service = new EngramAccessService(orchestrator);
  const recallRequest = buildQueryRecallRequest(queryText);

  try {
    if (explain) {
      // `query --explain` is a core-install feature; if @remnic/bench is
      // installed we use its full tier-breakdown explainer, otherwise we
      // fall back to a minimal "run the recall and show timing" path so
      // the flag keeps working without forcing users to install an
      // optional package. (Codex feedback on PR #545)
      const bench = await tryLoadBenchModule();
      if (bench?.runExplain) {
        const result = await bench.runExplain(service, queryText);
        if (json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Query: ${result.query}`);
          console.log(`Tiers used: ${result.tiersUsed.join(" → ")}`);
          console.log(`Total duration: ${result.totalDurationMs}ms`);
          for (const t of result.tierResults) {
            console.log(`  ${t.tier}: ${t.latencyMs}ms (${t.resultsCount} results)`);
          }
        }
        return;
      }

      const explainStart = Date.now();
      const recallResult = await service.recall(recallRequest);
      printMinimalQueryExplain(queryText, recallResult, Date.now() - explainStart, json);
      return;
    }

    printQueryResult(await service.recall(recallRequest), json);
  } finally {
    // One-shot CLI calls should not wait for or orphan deferred QMD
    // maintenance; the daemon/gateway process performs full warmup instead.
    orchestrator.abortDeferredInit();
    await orchestrator.destroy();
  }
}

function printQueryResult(result: RemoteRecallResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  for (const line of renderQueryTextLines(result)) {
    console.log(line);
  }
}

/**
 * Minimal `query --explain` fallback used when @remnic/bench is absent —
 * locally and for remote daemons (the bench explainer needs an in-process
 * access service). recall() returns `{ count, results, memoryIds, ... }`
 * (see EngramAccessRecallResponse); prefer the numeric count and fall
 * back to results.length (a prior version read `.memories`, which doesn't
 * exist — Codex feedback on PR #545).
 */
function printMinimalQueryExplain(
  queryText: string,
  result: RemoteRecallResult,
  totalDurationMs: number,
  json: boolean,
): void {
  const resultsCount =
    typeof result.count === "number"
      ? result.count
      : Array.isArray(result.results)
        ? result.results.length
        : 0;
  const minimalExplain = {
    query: queryText,
    totalDurationMs,
    resultsCount,
    results: summarizeQueryExplainFallbackResults(result),
    note: "Install @remnic/bench for a full tier-level explain breakdown.",
  };
  if (json) {
    console.log(JSON.stringify(minimalExplain, null, 2));
    return;
  }
  console.log(`Query: ${minimalExplain.query}`);
  console.log(`Total duration: ${minimalExplain.totalDurationMs}ms`);
  console.log(`Results: ${minimalExplain.resultsCount}`);
  for (const resultLine of minimalExplain.results) {
    const suffix = resultLine.source ? ` (${resultLine.source})` : "";
    console.log(`  ${resultLine.index}. ${resultLine.text}${suffix}`);
  }
  console.log(`Note: ${minimalExplain.note}`);
}

// ── Action confidence ──────────────────────────────────────────────────────

function parseActionConfidenceRest(rest: string[]): {
  input: ActionConfidenceInput;
  json: boolean;
} {
  const valueFlags = new Set([
    "--action",
    "--confidence",
    "--risk",
    "--context",
    "--rule",
    "--current-scope",
    "--memory-scope",
  ]);
  const booleanFlags = new Set(["--json", "--stale", "--corrected", "--unsafe"]);
  const options: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    if (booleanFlags.has(token)) {
      options[token.slice(2)] = true;
      continue;
    }
    if (!valueFlags.has(token)) {
      throw new Error(
        `Unknown flag ${JSON.stringify(token)}. Supported flags: --action, --confidence, --risk, --context, --rule, --current-scope, --memory-scope, --stale, --corrected, --unsafe, --json.`,
      );
    }
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`${token} requires a value.`);
    }
    options[token.slice(2)] = next;
    i++;
  }

  const intendedAction =
    typeof options.action === "string"
      ? options.action
      : positional.length > 0
        ? positional.join(" ")
        : undefined;

  const input = buildActionConfidenceInputFromOptions({
    action: intendedAction,
    confidence: options.confidence,
    risk: options.risk,
    context: options.context,
    rule: options.rule,
    currentScope: options["current-scope"],
    memoryScope: options["memory-scope"],
    stale: options.stale,
    corrected: options.corrected,
    unsafe: options.unsafe,
  });
  return { input, json: options.json === true };
}

async function cmdActionConfidence(rest: string[]): Promise<void> {
  let parsed: ReturnType<typeof parseActionConfidenceRest>;
  try {
    parsed = parseActionConfidenceRest(rest);
  } catch (err) {
    console.error(`action-confidence: ${(err as Error).message}`);
    process.exit(1);
  }
  const result = evaluateActionConfidence(parsed.input);
  console.log(parsed.json ? JSON.stringify(result, null, 2) : renderActionConfidenceText(result));
}

// ── Recall X-ray (issue #570) ──────────────────────────────────────────────

/**
 * Extract the `parseXrayCliOptions` option bag from CLI `rest` tokens.
 *
 * Splits `rest` into positional query tokens and `--flag value` pairs.
 * Validates that every value-taking flag (`--format`, `--budget`,
 * `--namespace`, `--out`) has a following value — CLAUDE.md rule 14
 * forbids silently defaulting when the flag is bare.
 *
 * Exported for test coverage.  Returns the `{rawQuery, options}` pair
 * that `parseXrayCliOptions` expects; downstream validation (format /
 * budget enum checks, empty-query rejection) is delegated to
 * `parseXrayCliOptions` itself so this function stays a thin tokenizer.
 */
export function extractXrayRawArgs(rest: string[]): {
  rawQuery: string;
  options: Record<string, unknown>;
} {
  const VALUE_FLAGS = new Set(["--format", "--budget", "--namespace", "--out"]);
  const positional: string[] = [];
  const options: Record<string, unknown> = {};

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token.startsWith("--")) {
      if (!VALUE_FLAGS.has(token)) {
        throw new Error(
          `Unknown flag ${JSON.stringify(token)}. Supported flags: --format, --budget, --namespace, --out.`,
        );
      }
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(
          `${token} requires a value. Provide it as \`${token} <value>\`, not as a bare flag.`,
        );
      }
      // Strip leading "--" from flag to produce the camelCase key
      // parseXrayCliOptions expects (`format`, `budget`, `namespace`,
      // `out`).
      const key = token.slice(2);
      options[key] = next;
      i++;
      continue;
    }
    positional.push(token);
  }

  return { rawQuery: positional.join(" "), options };
}

/**
 * Thin dependency-injected runner for `remnic xray`.  Parses flags,
 * invokes the caller-provided recall function, renders the snapshot via
 * the shared `renderXray` formatter, and emits the result to stdout or a
 * file.  Extracted from `cmdXray` so tests can exercise the full flow
 * with a stubbed recall function (CLAUDE.md rule 33 — test mocks must
 * match production signatures).
 */
export async function runXrayCommand(
  rest: string[],
  io: {
    recallXray: (request: {
      query: string;
      namespace?: string;
      budget?: number;
    }) => Promise<{
      snapshotFound: boolean;
      snapshot?: import("@remnic/core").RecallXraySnapshot;
    }>;
    writeFile: (filePath: string, data: string) => Promise<void>;
    stdout: (line: string) => void;
  },
): Promise<void> {
  const { rawQuery, options } = extractXrayRawArgs(rest);
  // `parseXrayCliOptions` throws listed-options errors for empty query,
  // unknown --format, malformed --budget (CLAUDE.md rules 14, 51).
  const parsed = parseXrayCliOptions(rawQuery, options);
  const response = await io.recallXray({
    query: parsed.query,
    ...(parsed.namespace ? { namespace: parsed.namespace } : {}),
    ...(parsed.budget !== undefined ? { budget: parsed.budget } : {}),
  });
  const snapshot = response.snapshotFound ? response.snapshot ?? null : null;
  const rendered = renderXray(snapshot, parsed.format);
  if (parsed.outPath) {
    await io.writeFile(expandTildePath(parsed.outPath), rendered);
  } else {
    io.stdout(rendered);
  }
}

/**
 * `remnic xray <query>` handler.  Validates CLI arguments *before*
 * booting the orchestrator so invalid invocations (empty query,
 * unknown --format, bare --budget, etc.) fail fast with the intended
 * CLI validation error rather than an unrelated initialization error,
 * and without paying the config-load / QMD-probe / deferred-ready
 * startup cost (Codex P2 on PR #643 — CLAUDE.md rules 14 + 51 require
 * explicit, fail-fast validation).
 *
 * After the arg bag is validated, bootstraps the orchestrator the
 * same way `cmdQuery` does and delegates to `runXrayCommand` for the
 * recall + render + emit flow.  Delegation keeps the production
 * handler's post-orchestrator path covered by `runXrayCommand`'s
 * existing unit tests (Cursor Medium on PR #643 — avoid duplicated
 * code paths that only one surface exercises).
 */
async function cmdXray(rest: string[]): Promise<void> {
  // Parse and validate flags FIRST — `parseXrayCliOptions` throws
  // listed-options errors for bad input.  Keep this before any IO so
  // a bad invocation surfaces the right error without touching disk.
  // `runXrayCommand` re-runs the same validators below; re-parsing is
  // cheap (pure + no IO) and avoids a second "validated flags" shape
  // that would drift from the raw-argv contract tests already cover.
  const { rawQuery, options } = extractXrayRawArgs(rest);
  parseXrayCliOptions(rawQuery, options);

  // Remote mode (issue #2448): the X-ray endpoint lives on the remote
  // daemon; no local orchestrator boot.
  const remote = resolveRemoteDaemon(resolveConfigPath());
  if (remote) {
    await runXrayCommand(rest, xrayCliIo((request) => remoteRecallXray(remote, request)));
    return;
  }

  initLogger();
  const configPath = resolveConfigPath();
  const raw = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  const remnicCfg = resolveRemnicConfigRecord(raw);
  const config = parseConfig(remnicCfg);
  const orchestrator = new Orchestrator(config);
  await orchestrator.initialize();
  await orchestrator.deferredReady;
  const service = new EngramAccessService(orchestrator);

  try {
    await runXrayCommand(rest, xrayCliIo((request) => service.recallXray(request)));
  } finally {
    // Xray is diagnostic, so it waits for deferred startup sync before recall;
    // abort remains a no-op guard if startup behavior changes later.
    orchestrator.abortDeferredInit();
  }
}

function xrayCliIo(
  recallXray: Parameters<typeof runXrayCommand>[1]["recallXray"],
): Parameters<typeof runXrayCommand>[1] {
  return {
    recallXray,
    writeFile: (filePath, data) => fsWriteFile(filePath, data, "utf8"),
    stdout: (line) => console.log(line),
  };
}

export async function runWhoKnowsCommand(
  rest: string[],
  io: {
    whoKnows: (request: { topic: string; limit?: number; namespace?: string }) => Promise<WhoKnowsResult>;
    stdout: (line: string) => void;
  },
): Promise<void> {
  const { topic, options } = extractWhoKnowsRawArgs(rest);
  const parsed = parseWhoKnowsCliOptions(topic, options);
  const result = await io.whoKnows({
    topic: parsed.topic,
    limit: parsed.limit,
    ...(parsed.namespace ? { namespace: parsed.namespace } : {}),
  });
  io.stdout(renderWhoKnows(result, parsed.json));
}

/** Boot a local orchestrator + access service for one command, then tear down. */
async function withLocalService<T>(fn: (service: EngramAccessService, orchestrator: Orchestrator) => Promise<T>): Promise<T> {
  initLogger();
  const configPath = resolveConfigPath();
  const raw = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
  const orchestrator = new Orchestrator(parseConfig(resolveRemnicConfigRecord(raw)));
  await orchestrator.initialize();
  await orchestrator.deferredReady;
  const service = new EngramAccessService(orchestrator);
  try {
    return await fn(service, orchestrator);
  } finally {
    orchestrator.abortDeferredInit();
    await orchestrator.destroy();
  }
}

async function cmdWhoKnows(rest: string[]): Promise<void> {
  const { topic, options } = extractWhoKnowsRawArgs(rest);
  parseWhoKnowsCliOptions(topic, options); // validate topic/--limit before any IO
  if (resolveRemoteDaemon(resolveConfigPath())) {
    throw new Error("who-knows: remote daemon mode is not supported yet; run with a local config");
  }
  await withLocalService((service) => runWhoKnowsCommand(rest, {
    whoKnows: (request) => service.whoKnows(request),
    stdout: (line) => console.log(line),
  }));
}

async function cmdPromotionCandidates(rest: string[]): Promise<void> {
  if (resolveRemoteDaemon(resolveConfigPath())) throw new Error("promotion-candidates: remote daemon mode is not supported yet; run with a local config");
  await withLocalService((service) => runPromotionCandidatesCommand(rest, {
    promotionCandidates: (request) => service.promotionCandidates(request),
    stdout: (line) => console.log(line),
  }));
}

async function cmdVersions(rest: string[]): Promise<void> {
  initLogger();
  const configPath = resolveConfigPath();
  const raw = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  const remnicCfg = resolveRemnicConfigRecord(raw);
  const config = parseConfig(remnicCfg);

  if (!config.versioningEnabled) {
    console.error("Page versioning is disabled (versioningEnabled = false).");
    process.exit(1);
  }

  const versioningConfig = {
    enabled: config.versioningEnabled,
    maxVersionsPerPage: config.versioningMaxPerPage,
    sidecarDir: config.versioningSidecarDir,
  };

  const memDir = resolveMemoryDir();

  const action = rest[0] ?? "help";
  const json = rest.includes("--json");

  switch (action) {
    case "list": {
      const pagePath = rest[1];
      if (!pagePath) {
        console.error("Usage: remnic versions list <page-path>");
        process.exit(1);
      }
      const absPath = path.resolve(pagePath);
      const history = await listVersions(absPath, versioningConfig, memDir);
      if (json) {
        console.log(JSON.stringify(history, null, 2));
      } else {
        if (history.versions.length === 0) {
          console.log(`No versions found for ${pagePath}`);
        } else {
          console.log(`Versions for ${pagePath} (current: v${history.currentVersion}):\n`);
          for (const v of history.versions) {
            const note = v.note ? ` — ${v.note}` : "";
            console.log(`  v${v.versionId}  ${v.timestamp}  ${v.trigger}  ${v.sizeBytes} bytes${note}`);
          }
        }
      }
      break;
    }

    case "show": {
      const pagePath = rest[1];
      const versionId = rest[2];
      if (!pagePath || !versionId) {
        console.error("Usage: remnic versions show <page-path> <version-id>");
        process.exit(1);
      }
      const absPath = path.resolve(pagePath);
      try {
        const content = await getVersion(absPath, versionId, versioningConfig, memDir);
        console.log(content);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      break;
    }

    case "diff": {
      const pagePath = rest[1];
      const v1 = rest[2];
      const v2 = rest[3];
      if (!pagePath || !v1 || !v2) {
        console.error("Usage: remnic versions diff <page-path> <v1> <v2>");
        process.exit(1);
      }
      const absPath = path.resolve(pagePath);
      try {
        const diffOutput = await diffVersions(absPath, v1, v2, versioningConfig, memDir);
        console.log(diffOutput);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      break;
    }

    case "revert": {
      const pagePath = rest[1];
      const versionId = rest[2];
      if (!pagePath || !versionId) {
        console.error("Usage: remnic versions revert <page-path> <version-id>");
        process.exit(1);
      }
      const absPath = path.resolve(pagePath);
      try {
        const version = await revertToVersion(absPath, versionId, versioningConfig, undefined, memDir);
        if (json) {
          console.log(JSON.stringify(version, null, 2));
        } else {
          console.log(`Reverted ${pagePath} to version ${versionId}.`);
          console.log(`Created snapshot v${version.versionId} of previous content.`);
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      break;
    }

    default:
      console.log(`
remnic versions — Page-level versioning

Usage:
  remnic versions list <page-path>              List all versions of a page
  remnic versions show <page-path> <id>         Print content of a specific version
  remnic versions diff <page-path> <v1> <v2>    Show diff between two versions
  remnic versions revert <page-path> <id>       Revert page to a specific version

Options:
  --json    Output in JSON format
`);
      break;
  }
}

// ---------------------------------------------------------------------------
// enrich command (issue #365)
// ---------------------------------------------------------------------------

async function cmdEnrich(rest: string[]): Promise<void> {
  initLogger();
  const configPath = resolveConfigPath();
  const raw = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  const remnicCfg = resolveRemnicConfigRecord(raw);
  const config = parseConfig(remnicCfg);

  const subcommand = rest[0];

  // Sub-commands that don't need an entity name
  if (subcommand === "audit") {
    const memoryDir = expandTilde(config.memoryDir);
    const auditDir = path.join(memoryDir, "enrichment");
    const sinceFlag = resolveFlag(rest.slice(1), "--since");
    const entries = await readAuditLog(auditDir, sinceFlag ?? undefined);
    if (entries.length === 0) {
      console.log("No enrichment audit entries found.");
      return;
    }
    for (const entry of entries) {
      const status = entry.accepted ? "ACCEPTED" : "REJECTED";
      const url = entry.sourceUrl ? ` (${entry.sourceUrl})` : "";
      console.log(
        `[${entry.timestamp}] ${status} ${entry.entityName} via ${entry.provider}: ${entry.candidateText}${url}`,
      );
    }
    return;
  }

  if (subcommand === "providers") {
    const pipelineConfig = defaultEnrichmentPipelineConfig();
    pipelineConfig.enabled = config.enrichmentEnabled;
    pipelineConfig.maxCandidatesPerEntity = config.enrichmentMaxCandidatesPerEntity;
    pipelineConfig.autoEnrichOnCreate = config.enrichmentAutoOnCreate;
    // Populate the provider config list so listEnabled() can match registered providers
    pipelineConfig.providers = [
      { id: "web-search", enabled: true, costTier: "cheap" },
    ];

    // Wire the real search backend so isAvailable() reflects actual state
    const orchestrator = new Orchestrator(config);
    await orchestrator.initialize();
    await orchestrator.deferredReady;
    const searchBackend = orchestrator.qmd;
    const searchFn = searchBackend.isAvailable()
      ? async (query: string): Promise<string[]> => {
          const results = await searchBackend.search(query, undefined, 10);
          return results.map((r) => r.snippet);
        }
      : undefined;

    const registry = new EnrichmentProviderRegistry();
    registry.register(new WebSearchProvider({ searchFn }));

    const allEnabled = registry.listEnabled(pipelineConfig);
    console.log(`Pipeline enabled: ${pipelineConfig.enabled}`);
    console.log(`Auto-enrich on create: ${pipelineConfig.autoEnrichOnCreate}`);
    console.log(`Max candidates per entity: ${pipelineConfig.maxCandidatesPerEntity}`);
    console.log(`\nRegistered providers:`);

    const webSearch = registry.get("web-search");
    if (webSearch) {
      const available = await webSearch.isAvailable();
      console.log(`  - web-search (${webSearch.costTier}) — ${available ? "available" : "unavailable (no searchFn configured)"}`);
    }
    if (allEnabled.length === 0) {
      console.log("\n  No providers are currently enabled in config.");
    }
    return;
  }

  if (!config.enrichmentEnabled) {
    console.error("Enrichment pipeline is disabled (enrichmentEnabled = false).");
    process.exit(1);
  }

  const dryRun = rest.includes("--dry-run");
  const all = rest.includes("--all");

  if (!all && (!subcommand || subcommand.startsWith("--"))) {
    console.error("Usage: remnic enrich <entity-name> | --all | --dry-run | audit | providers");
    process.exit(1);
  }

  const orchestrator = new Orchestrator(config);
  await orchestrator.initialize();
  await orchestrator.deferredReady;
  const storage = await orchestrator.getStorage(config.defaultNamespace);

  // Gather entities to enrich
  const entityFiles = await storage.readAllEntityFiles();
  let targets = entityFiles;
  if (!all && subcommand && !subcommand.startsWith("--")) {
    const match = entityFiles.find(
      (e) => e.name.toLowerCase() === subcommand.toLowerCase(),
    );
    if (!match) {
      console.error(`Entity not found: ${subcommand}`);
      process.exit(1);
    }
    targets = [match];
  }

  if (targets.length === 0) {
    console.log("No entities to enrich.");
    return;
  }

  // Build pipeline config and registry
  const pipelineConfig = defaultEnrichmentPipelineConfig();
  pipelineConfig.enabled = true;
  pipelineConfig.maxCandidatesPerEntity = config.enrichmentMaxCandidatesPerEntity;
  pipelineConfig.providers = [
    { id: "web-search", enabled: true, costTier: "cheap" },
  ];
  pipelineConfig.importanceThresholds = {
    critical: ["web-search"],
    high: ["web-search"],
    normal: ["web-search"],
    low: [],
  };

  // Wire the real search backend into the web-search provider (issue #425 P1)
  const searchBackend = orchestrator.qmd;
  const searchFn = searchBackend.isAvailable()
    ? async (query: string): Promise<string[]> => {
        const results = await searchBackend.search(query, undefined, 10);
        return results.map((r) => r.snippet);
      }
    : undefined;

  const registry = new EnrichmentProviderRegistry();
  registry.register(new WebSearchProvider({ searchFn }));

  // Map entity files to enrichment inputs
  const inputs = targets.map((ef) => ({
    name: ef.name,
    type: ef.type,
    knownFacts: ef.facts,
    importanceLevel: "normal" as const,
  }));

  if (dryRun) {
    console.log(`Dry run: would enrich ${inputs.length} entity(ies):`);
    for (const input of inputs) {
      const providers = registry.getForImportance(input.importanceLevel, pipelineConfig);
      console.log(`  - ${input.name} (${input.type}) — ${providers.length} provider(s)`);
    }
    return;
  }

  console.log(`Enriching ${inputs.length} entity(ies)...`);
  const noopLog = { info() {}, warn() {}, error() {}, debug() {} };
  const results = await runEnrichmentPipeline(inputs, registry, pipelineConfig, noopLog);

  if (results.length === 0) {
    console.log("No enrichment results (no providers matched).");
    return;
  }

  // Persist accepted candidates to storage (issue #425 P1).
  // Gotcha #43: direct-write paths must trigger reindex.
  const memoryDir = expandTilde(config.memoryDir);
  const auditDir = path.join(memoryDir, "enrichment");
  let totalPersisted = 0;
  for (const result of results) {
    for (const candidate of result.acceptedCandidates) {
      // Split persistence and audit into separate try-catch blocks so an
      // audit-write failure after a successful memory write is logged as a
      // warning instead of masking the successful persist (PR #425 review).
      let persisted = false;
      try {
        // Sealed-envelope write (issue #1989 PR4) — see enrichment-persist.ts.
        await persistEnrichmentCandidate(storage, result.entityName, candidate);
        persisted = true;
        totalPersisted++;
      } catch (err) {
        console.error(
          `  Failed to persist candidate for ${result.entityName}: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Audit rejected-due-to-error candidate
        try {
          await appendAuditEntry(auditDir, {
            timestamp: new Date().toISOString(),
            entityName: result.entityName,
            provider: result.provider,
            candidateText: candidate.text,
            sourceUrl: candidate.sourceUrl,
            accepted: false,
            reason: `persist failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        } catch {
          // Audit write failure is non-fatal
        }
      }

      // Write audit entry for accepted candidate — separate from persist
      // so audit failures don't mask a successful memory write.
      if (persisted) {
        try {
          await appendAuditEntry(auditDir, {
            timestamp: new Date().toISOString(),
            entityName: result.entityName,
            provider: result.provider,
            candidateText: candidate.text,
            sourceUrl: candidate.sourceUrl,
            accepted: true,
          });
        } catch (auditErr) {
          console.warn(
            `  Warning: audit write failed for ${result.entityName} (memory was persisted): ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`,
          );
        }
      }
    }
  }

  // Trigger reindex after direct writes (gotcha #43)
  if (totalPersisted > 0 && searchBackend.isAvailable()) {
    try {
      await searchBackend.update();
    } catch {
      // Reindex failure is non-fatal for CLI
    }
  }

  for (const result of results) {
    console.log(
      `  ${result.entityName} via ${result.provider}: ${result.candidatesAccepted} accepted, ${result.candidatesRejected} rejected (${result.elapsed}ms)`,
    );
  }
  if (totalPersisted > 0) {
    console.log(`\n  ${totalPersisted} candidate(s) persisted to memory store.`);
  }
}


async function cmdExtensions(action: string, rest: string[]): Promise<void> {
  initLogger();
  const configPath = resolveConfigPath();
  const raw = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  const remnicCfg = resolveRemnicConfigRecord(raw);
  const config = parseConfig(remnicCfg);

  const root = resolveExtensionsRoot(config);
  const noopLog = { warn: () => {}, debug: () => {} };
  const warnLog = {
    warn: (msg: string) => console.warn(msg),
    debug: () => {},
  };

  switch (action) {
    case "list": {
      const extensions = await discoverMemoryExtensions(root, noopLog);
      if (extensions.length === 0) {
        console.log("No memory extensions found.");
        console.log(`  Scanned: ${root}`);
        return;
      }
      console.log(`Memory extensions (${extensions.length}):`);
      for (const ext of extensions) {
        const schemaInfo = ext.schema?.version ? ` v${ext.schema.version}` : "";
        const types = ext.schema?.memoryTypes?.join(", ") ?? "any";
        console.log(`  ${ext.name}${schemaInfo}  (types: ${types})`);
      }
      console.log(`\nRoot: ${root}`);
      break;
    }

    case "show": {
      const name = rest[0];
      if (!name) {
        console.error("Usage: remnic extensions show <name>");
        process.exitCode = 1;
        return;
      }
      const extensions = await discoverMemoryExtensions(root, noopLog);
      const ext = extensions.find((e) => e.name === name);
      if (!ext) {
        console.error(`Extension "${name}" not found in ${root}`);
        process.exitCode = 1;
        return;
      }
      console.log(ext.instructions);
      break;
    }

    case "validate": {
      const extensions = await discoverMemoryExtensions(root, warnLog);
      // Re-scan to detect skipped entries
      let entries: string[] = [];
      try {
        entries = fs.readdirSync(root);
      } catch {
        console.log(`Extensions root does not exist: ${root}`);
        process.exitCode = 0;
        return;
      }
      const validNames = new Set(extensions.map((e) => e.name));
      let errors = 0;
      for (const entry of entries) {
        const entryPath = path.join(root, entry);
        try {
          if (!fs.statSync(entryPath).isDirectory()) continue;
        } catch {
          continue;
        }
        if (!validNames.has(entry)) {
          errors++;
        }
      }
      console.log(`Validated: ${extensions.length} valid, ${errors} skipped`);
      if (errors > 0) {
        process.exitCode = 1;
      }
      break;
    }

    case "reload": {
      // No-op stub reserved for future caching
      console.log("Extension cache reloaded (no-op: caching not yet implemented).");
      break;
    }

    default:
      console.log(`Usage: remnic extensions <list|show|validate|reload>

  list                 List discovered extensions
  show <name>          Print instructions.md content
  validate             Validate all extensions, exit non-zero on errors
  reload               Reserved for future caching (no-op)
`);
      break;
  }
}

async function cmdBriefing(rest: string[]): Promise<void> {
  initLogger();
  const configPath = resolveConfigPath();
  const raw = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  const remnicCfg = resolveRemnicConfigRecord(raw);
  const config = parseConfig(remnicCfg);

  if (!config.briefing.enabled) {
    console.error("Briefing is disabled in config (briefing.enabled = false).");
    process.exit(1);
  }

  const sinceFlag = resolveFlag(rest, "--since");
  const focusFlag = resolveFlag(rest, "--focus");
  const formatFlag = resolveFlag(rest, "--format");
  const save = rest.includes("--save") || config.briefing.saveByDefault;

  if (hasFlag(rest, "--since") && sinceFlag === undefined) {
    console.error("Missing value for --since. Accepted: yesterday, today, NNh, NNd, NNw.");
    process.exit(1);
  }

  if (hasFlag(rest, "--format") && formatFlag === undefined) {
    console.error("Missing value for --format. Accepted: markdown, json.");
    process.exit(1);
  }

  // Guard --focus the same way: if the flag is present but has no trailing
  // value (or the next token is another flag like `--save`), reject it rather
  // than silently consuming the next flag as the focus filter.
  if (hasFlag(rest, "--focus") && (focusFlag === undefined || focusFlag.startsWith("--"))) {
    console.error(
      "Missing value for --focus. Expected: project:<id>, topic:<name>, or person:<id>.",
    );
    process.exit(1);
  }

  const token = sinceFlag ?? config.briefing.defaultWindow;
  const window = parseBriefingWindow(token);
  if (!window) {
    console.error(
      `Invalid --since value: ${token}. Accepted: yesterday, today, NNh, NNd, NNw.`,
    );
    process.exit(1);
  }

  // Validate --focus: only treat undefined / empty strings as "no filter".
  // Anything else that parses to null (e.g. "project:", "topic:") is malformed
  // and must be rejected so a templating miss never silently broadens the
  // briefing from a targeted view to all memories. Mirrors the access-service
  // rejection in packages/remnic-core/src/access-service.ts.
  const rawFocus = typeof focusFlag === "string" ? focusFlag.trim() : "";
  const focus = rawFocus.length > 0 ? parseBriefingFocus(rawFocus) : null;
  if (rawFocus.length > 0 && !focus) {
    console.error(
      `Invalid --focus value: expected project:<id>, topic:<name>, or person:<id>, got: ${focusFlag}`,
    );
    process.exit(1);
  }
  // Honor the global --json flag: treat it as shorthand for --format json.
  // If both --json and --format are supplied and they conflict, fail fast.
  const jsonFlag = rest.includes("--json");
  if (jsonFlag && formatFlag !== undefined && formatFlag !== "json") {
    console.error(
      `Conflicting flags: --json and --format ${formatFlag}. Use one or the other.`,
    );
    process.exit(1);
  }
  const effectiveFormatFlag = jsonFlag ? "json" : formatFlag;
  const formatError = validateBriefingFormat(effectiveFormatFlag);
  if (formatError) {
    console.error(formatError);
    process.exit(1);
  }
  const format: "markdown" | "json" =
    effectiveFormatFlag === "json" ? "json" : effectiveFormatFlag === "markdown" ? "markdown" : config.briefing.defaultFormat;

  const orchestrator = new Orchestrator(config);
  await orchestrator.initialize();
  const storage = await orchestrator.getStorage(config.defaultNamespace);

  const calendarSource = config.briefing.calendarSource
    ? new FileCalendarSource(config.briefing.calendarSource)
    : undefined;

  const result = await buildBriefing({
    storage,
    window,
    focus,
    namespace: config.defaultNamespace,
    calendarSource,
    maxFollowups: config.briefing.maxFollowups,
    allowLlm: config.briefing.llmFollowups,
    openaiApiKey: config.openaiApiKey,
    openaiBaseUrl: config.openaiBaseUrl,
    model: config.model,
    // Without a direct OpenAI key, route follow-ups through the configured
    // LLM chain (gateway model source or local LLM) — mirrors the access
    // service so CLI and server briefings behave identically.
    followupGenerator: config.openaiApiKey
      ? undefined
      : orchestrator.briefingChainFollowupGenerator,
  });

  const payload = format === "json" ? JSON.stringify(result.json, null, 2) : result.markdown;
  console.log(payload);

  if (save) {
    try {
      const saveDir = resolveBriefingSaveDir(config.briefing.saveDir);
      fs.mkdirSync(saveDir, { recursive: true });
      // Use the window's end time (not wall-clock) so the filename is stable
      // regardless of when the command runs — a briefing covering --since 3d
      // gets the same name whether run just before or after UTC midnight.
      const filename = briefingFilename(new Date(result.window.to), format);
      const filePath = path.join(saveDir, filename);
      fs.writeFileSync(filePath, payload + (payload.endsWith("\n") ? "" : "\n"));
      console.error(`Saved briefing: ${filePath}`);
    } catch (err) {
      console.error(`Failed to save briefing: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }
}

async function cmdDoctor(): Promise<void> {
  const checks: Array<{ name: string; ok: boolean; warn?: boolean; detail: string; remediation?: string }> = [];

  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.slice(1).split(".")[0], 10);
  checks.push({
    name: "Node.js version",
    ok: nodeMajor >= 22,
    detail: `${nodeVersion} (requires >= 22.12.0)`,
  });

  const configPath = resolveConfigPath();
  const configExists = fs.existsSync(configPath);
  checks.push({ name: "Config file", ok: configExists, detail: configPath });
  let standaloneConfig: ReturnType<typeof parseConfig> | undefined;
  let standaloneConfigError: string | undefined;
  let standaloneOpenaiApiKeyExplicitlyFalse = false;
  let configuredNs: ConfiguredNamespace = { invalid: false };
  if (configExists) {
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const remnicCfg = resolveRemnicConfigRecord(raw);
      standaloneOpenaiApiKeyExplicitlyFalse = isOpenaiApiKeyDisabled(remnicCfg.openaiApiKey);
      configuredNs = readConfiguredNamespace(remnicCfg);
      standaloneConfig = parseConfig(remnicCfg);
    } catch (err) {
      standaloneConfigError = err instanceof Error ? err.message : String(err);
    }
  }

  let memoryDir: string;
  try {
    memoryDir = resolveMemoryDir();
  } catch {
    // Doctor must keep running when the config it is diagnosing is malformed.
    memoryDir = parseConfig({}).memoryDir;
  }
  try {
    fs.mkdirSync(memoryDir, { recursive: true });
    checks.push({ name: "Memory directory", ok: true, detail: memoryDir });
  } catch {
    checks.push({ name: "Memory directory", ok: false, detail: `cannot create ${memoryDir}` });
  }

  // Dead-lettered writes rejected by the namespace ACL (issue #1888). A
  // non-zero count means a client namespace is misconfigured and writes are
  // being parked instead of stored — surface it so it doesn't go unnoticed.
  try {
    const quarantined = await new WriteQuarantineStore(memoryDir).count();
    checks.push({
      name: "Quarantined writes",
      ok: quarantined === 0,
      warn: quarantined > 0,
      detail: quarantined === 0 ? "none" : `${quarantined} parked`,
      remediation:
        quarantined > 0
          ? "Inspect with `remnic quarantine list`, then fix the client's namespace config so writes are stored instead of parked."
          : undefined,
    });
  } catch {
    // Keep doctor non-failing, but surface that the quarantine store could not
    // be read rather than dropping the check silently. Detail stays generic —
    // the raw error can carry absolute paths/internal context meant for logs.
    checks.push({
      name: "Quarantined writes",
      ok: false,
      warn: true,
      detail: "unable to inspect quarantine store",
    });
  }

  // Config-time namespace-policy lint (issue #1888 improvement 3): see doctor-namespace-lint.ts.
  const nsPolicyCheck = buildNamespacePolicyCheck({
    invalid: configuredNs.invalid,
    configuredNamespace: configuredNs.configuredNamespace,
    config: standaloneConfig,
  });
  if (nsPolicyCheck) checks.push(nsPolicyCheck);

  // ── OpenClaw config checks ──────────────────────────────────────────────────
  const openclawConfigPath = resolveOpenclawConfigPath();
  const openclawConfigExists = fs.existsSync(openclawConfigPath);
  let openclawConfig: Record<string, unknown> = {};
  let openclawConfigValid = false;
  let openclawPluginModeConfigured = false;
  let activeOpenclawModelSource: string | undefined;
  let activeOpenclawEntryConfig: Record<string, unknown> | null = null;

  if (openclawConfigExists) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(openclawConfigPath, "utf-8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        openclawConfig = parsed as Record<string, unknown>;
        openclawConfigValid = true;
      } else {
        // Valid JSON but not an object (e.g. null, array, string) — treat as invalid
        openclawConfigValid = false;
      }
    } catch {
      openclawConfigValid = false;
    }
  }

  checks.push({
    name: "OpenClaw config file",
    ok: openclawConfigExists && openclawConfigValid,
    warn: openclawConfigExists && !openclawConfigValid,
    detail: openclawConfigExists
      ? openclawConfigValid
        ? openclawConfigPath
        : `${openclawConfigPath} (invalid JSON)`
      : `${openclawConfigPath} (not found)`,
    remediation: openclawConfigExists && !openclawConfigValid
      ? "Fix the JSON syntax in your OpenClaw config file."
      : !openclawConfigExists
      ? "Run `remnic openclaw install` to create the OpenClaw config with the Remnic entry."
      : undefined,
  });

  if (openclawConfigValid) {
    const rawPlugins = openclawConfig.plugins;
    const pluginsIsObject =
      rawPlugins && typeof rawPlugins === "object" && !Array.isArray(rawPlugins);
    if (!pluginsIsObject && rawPlugins !== undefined) {
      checks.push({
        name: "OpenClaw plugins",
        ok: false,
        detail: `plugins is ${typeof rawPlugins}, expected object`,
        remediation: "Run `remnic openclaw install` to recreate the plugins section.",
      });
    }
    const plugins = pluginsIsObject
      ? rawPlugins as Record<string, unknown>
      : {} as Record<string, unknown>;
    const entries =
      plugins.entries &&
      typeof plugins.entries === "object" &&
      !Array.isArray(plugins.entries)
        ? plugins.entries as Record<string, unknown>
        : null;
    const slots =
      plugins.slots &&
      typeof plugins.slots === "object" &&
      !Array.isArray(plugins.slots)
        ? plugins.slots as Record<string, unknown>
        : null;

    const entriesIsArray = Array.isArray(plugins.entries);
    checks.push({
      name: "OpenClaw plugins.entries",
      ok: !!entries,
      detail: entries ? "present" : entriesIsArray ? "invalid (array)" : "missing",
      remediation: !entries
        ? "Run `remnic openclaw install` to add the Remnic plugin entry."
        : undefined,
    });

    if (entries) {
      const isValidEntry = (v: unknown): boolean =>
        typeof v === "object" && v !== null && !Array.isArray(v);
      const hasNew = REMNIC_OPENCLAW_PLUGIN_ID in entries && isValidEntry(entries[REMNIC_OPENCLAW_PLUGIN_ID]);
      const hasLegacy = REMNIC_OPENCLAW_LEGACY_PLUGIN_ID in entries && isValidEntry(entries[REMNIC_OPENCLAW_LEGACY_PLUGIN_ID]);
      const keyExistsButMalformed =
        (REMNIC_OPENCLAW_PLUGIN_ID in entries && !hasNew) ||
        (REMNIC_OPENCLAW_LEGACY_PLUGIN_ID in entries && !hasLegacy);
      checks.push({
        name: "OpenClaw plugin entry",
        ok: hasNew,
        warn: (!hasNew && hasLegacy) || keyExistsButMalformed,
        detail: hasNew
          ? `${REMNIC_OPENCLAW_PLUGIN_ID} entry found`
          : hasLegacy
          ? `only legacy ${REMNIC_OPENCLAW_LEGACY_PLUGIN_ID} entry found (upgrade recommended)`
          : keyExistsButMalformed
          ? "entry key exists but value is not a valid object"
          : "no Remnic entry found",
        remediation: keyExistsButMalformed
          ? "Run `remnic openclaw install` to recreate the Remnic plugin entry with correct structure."
          : !hasNew && hasLegacy
          ? `Run \`remnic openclaw install\` to migrate from the legacy ${REMNIC_OPENCLAW_LEGACY_PLUGIN_ID} to ${REMNIC_OPENCLAW_PLUGIN_ID}.`
          : !hasNew
          ? "Run `remnic openclaw install` to add the Remnic plugin entry."
          : undefined,
      });

      const slotValue = slots?.memory as string | undefined;
      const validEntryIds = Object.keys(entries);
      const slotMissing = !slotValue;
      const slotMismatch = !slotMissing && !validEntryIds.includes(slotValue);

      // Slot is healthy if it references any present entry id.
      // Legacy REMNIC_OPENCLAW_LEGACY_PLUGIN_ID is functional; REMNIC_OPENCLAW_PLUGIN_ID is preferred.
      const slotMatchesEntry = !slotMissing && !slotMismatch;
      const slotIsLegacy = slotMatchesEntry && slotValue === REMNIC_OPENCLAW_LEGACY_PLUGIN_ID;
      const slotIsPreferred = slotMatchesEntry && slotValue === REMNIC_OPENCLAW_PLUGIN_ID;
      checks.push({
        name: "OpenClaw plugins.slots.memory",
        ok: slotMatchesEntry,
        warn: slotMatchesEntry && !slotIsPreferred,
        detail: slotMissing
          ? "(unset)"
          : slotMismatch
          ? `"${slotValue}" (not found in entries: ${validEntryIds.join(", ")})`
          : `"${slotValue}"`,
        remediation: slotMissing
          ? `Run \`remnic openclaw install\` to set plugins.slots.memory = "${REMNIC_OPENCLAW_PLUGIN_ID}". Without this, hooks never fire.`
          : slotMismatch
          ? `plugins.slots.memory = "${slotValue}" but no matching entry exists. Run \`remnic openclaw install\` to fix.`
          : slotIsLegacy
          ? `Slot is set to the legacy id "${REMNIC_OPENCLAW_LEGACY_PLUGIN_ID}". Run \`remnic openclaw install\` to migrate to "${REMNIC_OPENCLAW_PLUGIN_ID}" (optional — hooks fire with either id while the legacy entry is present).`
          : slotMatchesEntry && !slotIsPreferred && !slotIsLegacy
          ? `plugins.slots.memory = "${slotValue}" points to another plugin. Run \`remnic openclaw install\` to set it to "${REMNIC_OPENCLAW_PLUGIN_ID}".`
          : undefined,
      });

      // Check memoryDir for the slot-selected (active) entry — the slot determines
      // which plugin OpenClaw loads, so checking the wrong entry misdiagnoses the
      // configuration. Fall back to the canonical id when the slot is unset or
      // points to a non-OpenClaw entry.
      const activeSlotEntry = slotValue ? entries[slotValue] : undefined;
      const entryToCheck = (
        activeSlotEntry ??
        entries[REMNIC_OPENCLAW_PLUGIN_ID] ??
        entries[REMNIC_OPENCLAW_LEGACY_PLUGIN_ID]
      ) as Record<string, unknown> | undefined;
      const entryConfig = entryToCheck?.config && typeof entryToCheck.config === "object"
        ? entryToCheck.config as Record<string, unknown>
        : null;
      if (
        slotMatchesEntry &&
        (slotValue === REMNIC_OPENCLAW_PLUGIN_ID || slotValue === REMNIC_OPENCLAW_LEGACY_PLUGIN_ID)
      ) {
        openclawPluginModeConfigured = true;
        activeOpenclawEntryConfig = entryConfig;
        activeOpenclawModelSource =
          typeof entryConfig?.modelSource === "string" ? entryConfig.modelSource : undefined;
      }
      const rawMemoryDir = entryConfig?.memoryDir;
      const configuredMemoryDir = typeof rawMemoryDir === "string" ? rawMemoryDir : undefined;
      if (configuredMemoryDir) {
        const resolvedMemDir = path.resolve(expandTilde(configuredMemoryDir));
        let memDirOk = false;
        let memDirDetail = `${resolvedMemDir} (not found)`;
        let memDirRemediation: string | undefined = `Run \`remnic openclaw install --memory-dir "${resolvedMemDir}"\` to create the directory.`;
        if (fs.existsSync(resolvedMemDir)) {
          try {
            const stat = fs.statSync(resolvedMemDir);
            if (stat.isDirectory()) {
              memDirOk = true;
              memDirDetail = resolvedMemDir;
              memDirRemediation = undefined;
            } else {
              memDirDetail = `${resolvedMemDir} (exists but is not a directory)`;
              memDirRemediation = `Remove the file at ${resolvedMemDir} and run \`remnic openclaw install --memory-dir "${resolvedMemDir}"\` to create it as a directory.`;
            }
          } catch {
            memDirDetail = `${resolvedMemDir} (cannot stat)`;
          }
        }
        checks.push({
          name: "OpenClaw memoryDir",
          ok: memDirOk,
          warn: !memDirOk,
          detail: memDirDetail,
          remediation: memDirRemediation,
        });
      }
    }
  }

  const standaloneHasApiKey = standaloneConfig
    ? !!standaloneConfig.openaiApiKey
    : !!process.env.OPENAI_API_KEY;
  const activeOpenclawOpenaiApiKey = activeOpenclawEntryConfig?.openaiApiKey;
  const activeOpenclawOpenaiApiKeyExplicitlyFalse =
    isOpenaiApiKeyDisabled(activeOpenclawOpenaiApiKey);
  const hasExplicitOpenclawOpenaiApiKey =
    typeof activeOpenclawOpenaiApiKey === "string" && activeOpenclawOpenaiApiKey.trim().length > 0;
  let activeOpenclawConfigHasApiKey = false;
  let activeOpenclawOpenaiApiKeyError: string | undefined;
  if (hasExplicitOpenclawOpenaiApiKey) {
    try {
      activeOpenclawConfigHasApiKey = resolveEnvVars(activeOpenclawOpenaiApiKey).trim().length > 0;
    } catch (err) {
      activeOpenclawOpenaiApiKeyError = err instanceof Error ? err.message : String(err);
    }
  }
  const openclawHasApiKey = activeOpenclawOpenaiApiKeyExplicitlyFalse
    ? false
    : hasExplicitOpenclawOpenaiApiKey
      ? activeOpenclawConfigHasApiKey
      : !!process.env.OPENAI_API_KEY;
  const diagnosingOpenclawPluginMode = openclawPluginModeConfigured;
  const hasApiKey = diagnosingOpenclawPluginMode ? openclawHasApiKey : standaloneHasApiKey;
  const openclawKeyErrorBlocksOk = diagnosingOpenclawPluginMode && !!activeOpenclawOpenaiApiKeyError;
  const standaloneConfigErrorBlocksOk = !diagnosingOpenclawPluginMode && !!standaloneConfigError;
  const localLlmConfigured = standaloneConfig?.localLlmEnabled === true;
  const activeOpenclawLocalLlmConfigured =
    activeOpenclawEntryConfig?.localLlmEnabled === true || activeOpenclawEntryConfig?.localLlmEnabled === "true";
  const openaiKeyOptionalForOpenclaw =
    openclawPluginModeConfigured &&
    (activeOpenclawModelSource === "gateway" || activeOpenclawLocalLlmConfigured);
  const openaiKeyOptionalForStandalone =
    !diagnosingOpenclawPluginMode &&
    (standaloneConfig?.modelSource === "gateway" || localLlmConfigured);
  checks.push({
    name: "OPENAI_API_KEY",
    ok:
      !openclawKeyErrorBlocksOk &&
      !standaloneConfigErrorBlocksOk &&
      (hasApiKey || openaiKeyOptionalForOpenclaw || openaiKeyOptionalForStandalone),
    warn:
      openclawKeyErrorBlocksOk ||
      standaloneConfigErrorBlocksOk ||
      (!hasApiKey && !openaiKeyOptionalForOpenclaw && !openaiKeyOptionalForStandalone),
    detail: standaloneConfigErrorBlocksOk
      ? "config parse failed"
      : openclawKeyErrorBlocksOk
      ? "OpenClaw openaiApiKey placeholder failed"
      : hasApiKey
      ? "configured"
      : !diagnosingOpenclawPluginMode && standaloneOpenaiApiKeyExplicitlyFalse && localLlmConfigured
      ? "disabled by config (local LLM enabled)"
      : !diagnosingOpenclawPluginMode && standaloneOpenaiApiKeyExplicitlyFalse && standaloneConfig?.modelSource === "gateway"
      ? "disabled by config (gateway modelSource)"
      : activeOpenclawOpenaiApiKeyExplicitlyFalse
      ? "disabled by OpenClaw config"
      : openaiKeyOptionalForOpenclaw
      ? activeOpenclawModelSource === "gateway"
        ? "not set (not required for OpenClaw gateway modelSource)"
        : "not set (not required for OpenClaw local LLM)"
      : openaiKeyOptionalForStandalone
      ? "not set (standalone local/gateway model path configured)"
      : "not set (required for direct OpenAI-backed extraction)",
  });

  // Remote mode (issue #2448): probe the configured origin instead of the
  // local service manager. Nothing is spawned locally.
  const remoteDaemon = resolveRemoteDaemon(configPath);
  if (remoteDaemon) {
    const probe = await probeDaemonHealth(remoteDaemon.baseUrl, remoteDaemon.token);
    const detail = probe.ok
      ? `remote ${remoteDaemon.baseUrl} (reachable)`
      : `remote ${remoteDaemon.baseUrl} (unreachable${probe.status ? `, HTTP ${probe.status}` : probe.error ? `, ${probe.error}` : ""})`;
    checks.push({
      name: "Server daemon",
      ok: probe.ok,
      warn: !probe.ok,
      detail,
      remediation: probe.ok ? undefined : "Check REMNIC_DAEMON_URL / server.url and the remote server's availability.",
    });
  } else {
    const svcState = isServiceRunning();
    const standaloneServiceInstalled = isStandaloneServiceInstalled();
    const daemonOptionalForOpenclaw = openclawPluginModeConfigured && !standaloneServiceInstalled;
    checks.push({
      name: "Server daemon",
      ok: svcState.running || daemonOptionalForOpenclaw,
      warn: !svcState.running,
      detail: svcState.running
        ? `running${svcState.pid ? ` (pid ${svcState.pid})` : ""}`
        : daemonOptionalForOpenclaw
        ? "stopped (not required for OpenClaw plugin mode)"
        : "stopped",
      remediation: !svcState.running && standaloneServiceInstalled
        ? "Run `remnic daemon start`, or `remnic daemon uninstall` if you only use the OpenClaw plugin."
        : undefined,
    });
  }

  if (isMacOS()) {
    const launchdInspection = selectLaunchdInspection(openclawPluginModeConfigured);
    checks.push({
      name: "Standalone launchd plist",
      ok: launchdInspection.ok,
      warn: launchdInspection.warn,
      detail: launchdInspection.detail,
      remediation: launchdInspection.remediation,
    });
  }

  // ── Coding-agent context (issue #569) ──────────────────────────────────
  // Acceptance criterion: `remnic doctor` inside a git repo prints the
  // detected projectId, branch, and effective namespace. We invoke the
  // pure GitContextResolver against process.cwd(); when the cwd is not a
  // git repo the check is informational only (no failure).
  try {
    const core = (await import("@remnic/core")) as unknown as {
      resolveGitContext?: (cwd: string) => Promise<null | {
        projectId: string;
        branch: string | null;
        rootPath: string;
        defaultBranch: string | null;
      }>;
      describeCodingScope?: (
        ctx: unknown,
        config: { projectScope: boolean; branchScope: boolean; globalFallback: boolean },
        defaultNamespace?: string,
      ) => {
        scope: "none" | "project" | "branch";
        effectiveNamespace: string | null;
        readFallbacks: string[];
      };
    };
    if (typeof core.resolveGitContext === "function") {
      const gitCtx = await core.resolveGitContext(process.cwd());
      if (gitCtx) {
        const parts = [
          `project=${gitCtx.projectId}`,
          `branch=${gitCtx.branch ?? "(detached)"}`,
          `root=${gitCtx.rootPath}`,
          `defaultBranch=${gitCtx.defaultBranch ?? "(unknown)"}`,
        ];
        // Compute effective namespace using the same resolver the orchestrator
        // uses, with the operator's ACTUAL configured codingMode values so
        // that the reported effectiveNamespace matches what recall + writes
        // will use at runtime. Falls back to the ship defaults
        // (projectScope on, branchScope off) only when no codingMode is
        // configured in openclaw.plugin.json.
        const pluginRemnic =
          typeof openclawConfig.remnic === "object" && openclawConfig.remnic !== null
            ? (openclawConfig.remnic as Record<string, unknown>)
            : (openclawConfig as Record<string, unknown>);
        const pluginCodingMode =
          typeof pluginRemnic.codingMode === "object" && pluginRemnic.codingMode !== null
            ? (pluginRemnic.codingMode as Record<string, unknown>)
            : {};
        const projectScopeCfg =
          typeof pluginCodingMode.projectScope === "boolean"
            ? pluginCodingMode.projectScope
            : true;
        const branchScopeCfg =
          typeof pluginCodingMode.branchScope === "boolean"
            ? pluginCodingMode.branchScope
            : false;
        const globalFallbackCfg =
          typeof pluginCodingMode.globalFallback === "boolean"
            ? pluginCodingMode.globalFallback
            : true;
        const defaultNamespaceCfg =
          typeof pluginRemnic.defaultNamespace === "string" && pluginRemnic.defaultNamespace.length > 0
            ? pluginRemnic.defaultNamespace
            : "default";
        let effective = `project-…`;
        if (typeof core.describeCodingScope === "function") {
          const desc = core.describeCodingScope(gitCtx, {
            projectScope: projectScopeCfg,
            branchScope: branchScopeCfg,
            globalFallback: globalFallbackCfg,
          }, defaultNamespaceCfg as string);
          effective = desc.effectiveNamespace ?? "(no overlay)";
        }
        parts.push(`projectScope=${projectScopeCfg}`);
        parts.push(`branchScope=${branchScopeCfg}`);
        checks.push({
          name: "Coding-agent context",
          ok: true,
          detail: `${parts.join(", ")}, effectiveNamespace=${effective}`,
        });
      } else {
        checks.push({
          name: "Coding-agent context",
          ok: true,
          warn: true,
          detail: "cwd is not inside a git repo (project/branch scoping will not apply)",
        });
      }
    }
  } catch {
    // Never fail doctor for detection errors.
  }

  // ── Structural-context provider (issue #1548 Track A PR 5) ────────────────
  // Renders the configured provider mode plus a live probe so operators see
  // "configured / probed / last error code" — a degraded/absent provider is
  // never silent (rule 34). Pure config read when no config file is present.
  try {
    const core = (await import("@remnic/core")) as unknown as {
      probeStructuralProviderForDoctor?: (config: unknown) => Promise<{
        active: boolean;
        mode: string;
        command?: string;
        providerId?: string;
        probed?: { available: boolean; detail?: string };
      }>;
      renderStructuralProviderStatusLine?: (status: unknown) => string;
    };
    if (typeof core.probeStructuralProviderForDoctor === "function") {
      const status = standaloneConfig
        ? await core.probeStructuralProviderForDoctor(standaloneConfig)
        : { active: false, mode: "none" };
      const fullLine = typeof core.renderStructuralProviderStatusLine === "function"
        ? core.renderStructuralProviderStatusLine(status)
        : `structural-context provider: ${status.mode}`;
      // Strip the redundant "structural-context provider: " prefix — the check
      // name already carries it.
      const detail = fullLine.replace(/^structural-context provider: /, "");
      const probeUnavailable = status.active === true &&
        status.probed !== undefined && status.probed.available === false;
      checks.push({
        name: "Structural-context provider",
        ok: true,
        warn: probeUnavailable ? true : undefined,
        detail,
        remediation: probeUnavailable
          ? "review-context falls back to file-path-only boosting; check the configured binary path or provider install"
          : undefined,
      });
    }
  } catch {
    // Never fail doctor for provider detection errors.
  }

  for (const check of checks) {
    const icon = check.ok
      ? check.warn ? "⚠" : "✓"
      : check.warn ? "⚠" : "✗";
    console.log(`  ${icon} ${check.name}: ${check.detail}`);
    if ((!check.ok || check.warn) && check.remediation) {
      console.log(`      → ${check.remediation}`);
    }
  }
}

function cmdConfig(): void {
  const configPath = resolveConfigPath();
  if (!fs.existsSync(configPath)) {
    console.log("No config file found. Run `remnic init` to create one.");
    return;
  }
  console.log(`Config: ${configPath}`);
  const rawConfig = fs.readFileSync(configPath, "utf8");
  const redacted = rawConfig.replace(
    /("(?:openaiApiKey|localLlmApiKey|authToken|apiKey|remoteSearchApiKey|meilisearchApiKey|opikApiKey)"\s*:\s*")([^"]*)(")/g,
    '$1[REDACTED]$3',
  );
  console.log(redacted);
}

async function cmdMigrate(json: boolean, rollback: boolean): Promise<void> {
  if (rollback) {
    const result = await rollbackFromEngramMigration({ quiet: json });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.restored.length === 0 && result.removed.length === 0) {
      console.log("No migration rollback state found.");
      return;
    }
    console.log("Rollback complete.");
    if (result.restored.length > 0) {
      console.log(`  Restored: ${result.restored.length}`);
    }
    if (result.removed.length > 0) {
      console.log(`  Removed: ${result.removed.length}`);
    }
    return;
  }

  const result = await migrateFromEngram({ quiet: json });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.status === "fresh-install") {
    console.log("No Engram install found. Nothing to migrate.");
    return;
  }
  if (result.status === "already-migrated") {
    console.log("Migration already completed.");
    return;
  }
  console.log("Migration complete.");
  console.log(`  Copied: ${result.copied.length}`);
  console.log(`  Tokens rewritten: ${result.tokensRegenerated}`);
  console.log(`  Services updated: ${result.servicesReinstalled.length}`);
  console.log(`  Rollback: ${result.rollbackCommand}`);
}

// ── M4 commands ──────────────────────────────────────────────────────────────

function cmdOnboard(dirPath: string, json: boolean): void {
  const directory = path.resolve(dirPath || process.cwd());
  const result = onboard({ directory });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Shape: ${result.shape}`);
  console.log(`Languages: ${result.languages.map((l) => `${l.language} (${(l.confidence * 100).toFixed(0)}%)`).join(", ")}`);
  console.log(`Docs: ${result.docs.length} file(s)`);
  console.log(result.docs.map((s) => `  ${s.kind} (${s.size} bytes)`).join("\n"));
  console.log(`Plan: ${result.plan.priorityFiles.length} priority, ${result.plan.estimatedFiles} total files`);
  console.log(`\nSuggested namespace: ${result.plan.suggestedNamespace}`);
  console.log(`Total files: ${result.totalFiles}`);
  console.log(`Duration: ${result.durationMs}ms`);
}

async function cmdCurate(targetPath: string, json: boolean): Promise<void> {
  const memoryDir = resolveMemoryDir();
  const result = await curate({
    targetPath: path.resolve(targetPath),
    memoryDir,
    source: "curation",
    checkDuplicates: true,
    checkContradictions: true,
  });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Files: ${result.filesProcessed} processed, ${result.filesSkipped} skipped`);
  console.log(`Statements: ${result.statements.length}`);
  if (result.duplicates.length > 0) console.log(`Duplicates: ${result.duplicates.length}`);
  if (result.contradictions.length > 0) console.log(`Contradictions: ${result.contradictions.length}`);
  console.log(`Written: ${result.written.length}`);
  console.log(`Duration: ${result.durationMs}ms`);
}

async function cmdReview(action: string, rest: string[]): Promise<void> {
  const memoryDir = resolveMemoryDir();
  if (action === "list") {
    const result = listReviewItems({ memoryDir });
    if (result.items.length === 0) {
      console.log("No items pending review.");
      return;
    }
    for (const item of result.items) {
      console.log(`[${item.reviewReason}] ${item.id} ${item.content.slice(0, 80)}${item.content.length > 80 ? "..." : ""}`);
      console.log(`  Confidence: ${item.confidence} | Category: ${item.category}`);
      console.log(`  Source: ${item.source} | Created: ${item.created}`);
    }
    return;
  }

  if (action === "approve" || action === "dismiss" || action === "flag") {
    const id = rest[0];
    if (!id) {
      console.error("Usage: remnic review <approve|dismiss|flag> <id>");
      process.exit(1);
    }
    const storage = new StorageManager(memoryDir);
    // Issue #1579 review threads Oblq_ / ObnTy: the standalone CLI storage
    // must mirror the orchestrator's tombstone config, otherwise
    // revokeTombstone() returns null (enabled defaults to false) and the
    // approved content is blocked again on the next write. Parse the same
    // config the daemon uses and apply it before revoking.
    //
    // Issue #1579 thread Ocial: parseConfig in an ISOLATED catch. parseConfig
    // error strings can embed raw config values (including API keys — CodeQL
    // js/clear-text-logging), so a failure must NOT propagate to the CLI
    // top-level handler which prints err.message. Mirror the wearables
    // command's constant-message pattern. With no usable config, tombstones
    // stay at their safe default (enabled=false) and the approval still
    // clears blockedBy on disk; only the revocation is skipped, which the
    // doctor/rebuild path recovers.
    const configPath = resolveConfigPath();
    let tombstonesConfig: {
      enabled: boolean;
      semanticMatch: boolean;
      semanticThreshold: number;
      namespace: string;
    } | null = null;
    try {
      const rawCfg = fs.existsSync(configPath)
        ? JSON.parse(fs.readFileSync(configPath, "utf8"))
        : {};
      const remnicCfg = resolveRemnicConfigRecord(rawCfg);
      const config = parseConfig(remnicCfg);
      tombstonesConfig = {
        enabled: config.tombstonesEnabled,
        semanticMatch: config.tombstonesSemanticMatch,
        semanticThreshold: config.tombstonesSemanticThreshold,
        namespace: config.defaultNamespace,
      };
    } catch {
      console.error(
        "review: failed to load the Remnic config — run `remnic doctor` and check the config file for errors",
      );
    }
    if (tombstonesConfig) {
      storage.setTombstonesConfig(tombstonesConfig);
    }
    const result = performReview(memoryDir, id, action as ReviewAction, {
      onApproveBlockedMemory: (tombstoneId) => {
        // Fire-and-forget for long-running callers; the CLI also awaits
        // result.clearedTombstoneId below so the revocation lands before exit.
        void storage.revokeTombstone(tombstoneId, "user_correction").catch(() => undefined);
      },
    });
    // Issue #1579: await the revocation so it lands before the CLI exits.
    // The fire-and-forget hook covers long-running callers; this await covers
    // the short-lived CLI process (without it the revocation could be lost).
    // Issue #1579: await the revocation so it lands before the CLI exits, and
    // re-register the now-active fact's contentHash in the dedup index (thread
    // ObnTy). writeMemory skipped registration while the fact was tombstone-
    // blocked (rule 44); without this, the next extraction of the same content
    // would create a second active fact.
    if (result.clearedTombstoneId) {
      try {
        await storage.revokeTombstone(result.clearedTombstoneId, "user_correction");
      } catch {
        /* best-effort — approval already succeeded */
      }
      try {
        await storage.restoreFactHashAfterApproval(id);
      } catch {
        /* best-effort — approval + revocation already succeeded */
      }
    }
    console.log(result.message);
  } else {
    console.log("Usage: remnic review <list|approve|dismiss|flag> [id]");
    process.exit(1);
  }
}

export function resolveSyncSourceDir(rest: string[]): string {
  // Extract --source before positional args so that rest args can override it
  const sourceIdx = rest.indexOf("--source");
  if (sourceIdx < 0) return ".";
  const value = rest[sourceIdx + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(
      "--source requires a value. Provide it as `--source <dir>`, not as a bare flag.",
    );
  }
  return value;
}

async function cmdSync(action: string, rest: string[], json: boolean): Promise<void> {
  const sourceDir = resolveSyncSourceDir(rest);
  const memoryDir = resolveMemoryDir();

  if (action === "run") {
    const result = syncChanges({ sourceDir, memoryDir });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Scanned: ${result.scanned}`);
      console.log(`Added: ${result.added.length}`);
      console.log(`Modified: ${result.changed.filter((c) => c.type === "modified").length}`);
      console.log(`Deleted: ${result.deleted.length}`);
      console.log(`Unchanged: ${result.unchanged}`);
      console.log(`Duration: ${result.durationMs}ms`);
    }
  } else if (action === "watch") {
    const { stop } = watchForChanges(
      { sourceDir, memoryDir },
      (changes) => {
        console.log(`Changed: ${changes.length} file(s)`);
        for (const c of changes) {
          console.log(`  [${c.type}] ${c.relativePath}`);
        }
      },
    );
    console.log("Watching... (Ctrl+C to stop)");
    process.on("SIGINT", () => {
      stop();
      console.log("Stopped watching.");
    });
    await new Promise(() => {});
  } else {
    console.log("Usage: remnic sync <run|watch> [--source <dir>]");
    process.exit(1);
  }
}

function localOfflineSourceId(memoryDir: string): string {
  const host = os.hostname() || "unknown-host";
  const dirHash = createHash("sha256").update(path.resolve(memoryDir)).digest("hex").slice(0, 16);
  return `remnic-local:${host}:${dirHash}`;
}

function normalizeOfflineRemoteUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error(`invalid --remote-url: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("--remote-url must use http:// or https://");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

export function resolveOptionalOfflineRemoteUrl(args: string[]): string | undefined {
  const raw =
    resolveRequiredValueFlag(args, "--remote-url") ??
    resolveRequiredValueFlag(args, "--remote") ??
    process.env.REMNIC_OFFLINE_REMOTE_URL ??
    process.env.ENGRAM_OFFLINE_REMOTE_URL;
  if (!raw || raw.trim().length === 0) return undefined;
  return normalizeOfflineRemoteUrl(raw);
}

function resolveOfflineRemoteUrl(args: string[]): string {
  const parsed = resolveOptionalOfflineRemoteUrl(args);
  if (!parsed) {
    throw new Error(
      "offline mode requires --remote-url <url> or REMNIC_OFFLINE_REMOTE_URL",
    );
  }
  return parsed;
}

function resolveOfflineToken(args: string[]): string {
  const token =
    resolveRequiredValueFlag(args, "--token") ??
    process.env.REMNIC_OFFLINE_TOKEN ??
    process.env.REMNIC_AUTH_TOKEN ??
    process.env.ENGRAM_AUTH_TOKEN;
  if (!token || token.trim().length === 0) {
    throw new Error(
      "offline mode requires --token <token>, REMNIC_OFFLINE_TOKEN, or REMNIC_AUTH_TOKEN",
    );
  }
  return token.trim();
}

function offlineEndpoint(
  remoteUrl: string,
  pathname: string,
  params: Record<string, string | undefined> = {},
): string {
  const url = new URL(remoteUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  const endpointPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  url.pathname = `${basePath}${endpointPath}`;
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value.length > 0) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

export const OFFLINE_SYNC_REQUEST_TIMEOUT_DEFAULT_MS = 15 * 60_000;
export const OFFLINE_SYNC_SNAPSHOT_BASE_POST_PREFERRED_MAX_BODY_BYTES = 16 * 1024 * 1024;

export function parseOfflineSyncRequestTimeoutMs(
  raw: string | undefined,
  fallback = OFFLINE_SYNC_REQUEST_TIMEOUT_DEFAULT_MS,
): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1_000) {
    throw new Error("REMNIC_OFFLINE_REQUEST_TIMEOUT_MS must be an integer >= 1000");
  }
  return parsed;
}

export function formatOfflineRequestForError(url: string, init: RequestInit = {}): string {
  const method = (init.method ?? "GET").toString().toUpperCase();
  try {
    const parsed = new URL(url);
    return `${method} ${parsed.pathname}${parsed.search}`;
  } catch {
    return `${method} ${url}`;
  }
}

function offlineRequestTimeoutMs(): number {
  return parseOfflineSyncRequestTimeoutMs(
    process.env.REMNIC_OFFLINE_REQUEST_TIMEOUT_MS ??
      process.env.ENGRAM_OFFLINE_REQUEST_TIMEOUT_MS,
  );
}

function offlineSnapshotPostTimeoutMs(): number {
  return parseOfflineSyncRequestTimeoutMs(
    process.env.REMNIC_OFFLINE_SNAPSHOT_POST_TIMEOUT_MS ??
      process.env.ENGRAM_OFFLINE_SNAPSHOT_POST_TIMEOUT_MS,
    Math.min(offlineRequestTimeoutMs(), 60_000),
  );
}

function offlineFetchHeaders(
  token: string,
  initHeaders: RequestInit["headers"] | undefined,
  defaultContentType?: string,
): Headers {
  const headers = new Headers(initHeaders);
  headers.set("authorization", `Bearer ${token}`);
  if (defaultContentType && !headers.has("content-type")) {
    headers.set("content-type", defaultContentType);
  }
  return headers;
}

async function fetchOfflineWithResponse<T>(
  url: string,
  token: string,
  init: RequestInit = {},
  options: { defaultContentType?: string } = {},
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const timeoutMs = offlineRequestTimeoutMs();
  const controller = new AbortController();
  const upstreamSignal = init.signal;
  const requestContext = formatOfflineRequestForError(url, init);
  let didTimeout = false;
  const timeout = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);
  const abortFromUpstream = () => controller.abort(upstreamSignal?.reason);
  if (upstreamSignal) {
    if (upstreamSignal.aborted) controller.abort(upstreamSignal.reason);
    else upstreamSignal.addEventListener("abort", abortFromUpstream, { once: true });
  }
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: offlineFetchHeaders(token, init.headers, options.defaultContentType),
    });
  } catch (error) {
    clearTimeout(timeout);
    upstreamSignal?.removeEventListener("abort", abortFromUpstream);
    if (didTimeout) {
      throw new Error(`offline sync request timed out after ${timeoutMs}ms: ${requestContext}`);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`offline sync request failed before response: ${requestContext} - ${message}`);
  }
  try {
    return await consume(response);
  } catch (error) {
    if (didTimeout) {
      throw new Error(`offline sync request timed out after ${timeoutMs}ms: ${requestContext}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    upstreamSignal?.removeEventListener("abort", abortFromUpstream);
  }
}

async function throwOfflineResponseError(
  response: Response,
  url: string,
  init: RequestInit,
  label = "offline sync request",
): Promise<never> {
  let detail = "";
  try {
    detail = await response.text();
  } catch {
    detail = "";
  }
  throw new Error(
    `${label} failed: ${formatOfflineRequestForError(url, init)} returned ${response.status} ${response.statusText}${detail ? ` - ${detail.slice(0, 500)}` : ""}`,
  );
}

async function fetchOfflineJson<T>(
  url: string,
  token: string,
  init: RequestInit = {},
): Promise<T> {
  return fetchOfflineWithResponse(
    url,
    token,
    init,
    { defaultContentType: init.body !== undefined ? "application/json" : undefined },
    async (response) => {
      if (!response.ok) {
        await throwOfflineResponseError(response, url, init);
      }
      return await response.json() as T;
    },
  );
}

interface OfflineSnapshotStreamHeader {
  namespace?: string;
  format: OfflineSyncSnapshot["format"];
  schemaVersion: OfflineSyncSnapshot["schemaVersion"];
  createdAt: string;
  sourceId: string;
  includeTranscripts: boolean;
}

async function parseOfflineSnapshotStreamResponse(
  response: Response,
): Promise<OfflineSyncSnapshot & { namespace?: string }> {
  if (!response.body) {
    throw new Error("offline sync snapshot stream response omitted body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let header: OfflineSnapshotStreamHeader | null = null;
  const files: OfflineSyncFileRecord[] = [];
  const handleLine = (line: string): void => {
    if (line.trim().length === 0) return;
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed.type === "snapshot") {
      if (header) throw new Error("offline sync snapshot stream repeated header");
      header = {
        ...(typeof parsed.namespace === "string" && parsed.namespace.length > 0 ? { namespace: parsed.namespace } : {}),
        format: parsed.format as OfflineSyncSnapshot["format"],
        schemaVersion: parsed.schemaVersion as OfflineSyncSnapshot["schemaVersion"],
        createdAt: parsed.createdAt as string,
        sourceId: parsed.sourceId as string,
        includeTranscripts: parsed.includeTranscripts as boolean,
      };
      return;
    }
    if (parsed.type === "file") {
      if (!header) throw new Error("offline sync snapshot stream file arrived before header");
      files.push(parsed.file as OfflineSyncFileRecord);
      return;
    }
    throw new Error("offline sync snapshot stream contained unknown event");
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      handleLine(line);
    }
  }
  buffered += decoder.decode();
  handleLine(buffered);
  const finalHeader = header as OfflineSnapshotStreamHeader | null;
  if (!finalHeader) throw new Error("offline sync snapshot stream omitted header");
  const snapshot = normalizeOfflineSyncSnapshot({
    format: finalHeader.format,
    schemaVersion: finalHeader.schemaVersion,
    createdAt: finalHeader.createdAt,
    sourceId: finalHeader.sourceId,
    includeTranscripts: finalHeader.includeTranscripts,
    files,
  });
  return {
    ...(finalHeader.namespace ? { namespace: finalHeader.namespace } : {}),
    ...snapshot,
  };
}

async function fetchOfflineSnapshotStream(args: {
  remoteUrl: string;
  token: string;
  namespace?: string;
  includeTranscripts: boolean;
}): Promise<OfflineSyncSnapshot & { namespace?: string }> {
  const url = offlineEndpoint(args.remoteUrl, "/remnic/v1/offline-sync/snapshot-stream", {
    namespace: args.namespace,
    include_transcripts: args.includeTranscripts ? "true" : "false",
    content: "false",
  });
  return fetchOfflineWithResponse(
    url,
    args.token,
    {},
    {},
    async (response) => {
      if (!response.ok) {
        await throwOfflineResponseError(response, url, {}, "offline sync snapshot-stream request");
      }
      return parseOfflineSnapshotStreamResponse(response);
    },
  );
}

export async function fetchOfflineSnapshot(args: {
  remoteUrl: string;
  token: string;
  namespace?: string;
  includeTranscripts: boolean;
  includeContent?: boolean;
  baseFiles?: readonly OfflineSyncFileState[];
  baseCapturedAt?: Date;
}): Promise<OfflineSyncSnapshot & { namespace?: string }> {
  let tryStreamSnapshot = false;
  if (args.includeContent === false && args.baseFiles && args.baseFiles.length > 0) {
    if (args.baseFiles.length > OFFLINE_SYNC_SNAPSHOT_BASE_POST_MAX_FILES) {
      tryStreamSnapshot = true;
    } else {
      const postBody = offlineSnapshotBasePostBody({
        namespace: args.namespace,
        includeTranscripts: args.includeTranscripts,
        baseFiles: args.baseFiles,
        baseCapturedAt: args.baseCapturedAt,
      });
      const postRequest = offlineSnapshotBasePostRequest(postBody);
      if (postRequest) {
        const postRequestUsesGzip =
          new Headers(postRequest.headers).get("content-encoding")?.toLowerCase() === "gzip";
        const postAbort = new AbortController();
        const postTimeout = setTimeout(() => postAbort.abort(), offlineSnapshotPostTimeoutMs());
        try {
          return await fetchOfflineJson(
            offlineEndpoint(args.remoteUrl, "/remnic/v1/offline-sync/snapshot"),
            args.token,
            {
              method: "POST",
              signal: postAbort.signal,
              ...postRequest,
            },
          );
        } catch (error) {
          if (!isOfflineSnapshotPostFallbackError(error, { compressed: postRequestUsesGzip })) throw error;
          tryStreamSnapshot = true;
        } finally {
          clearTimeout(postTimeout);
        }
      } else {
        tryStreamSnapshot = true;
      }
    }
  }
  if (tryStreamSnapshot) {
    try {
      return await fetchOfflineSnapshotStream({
        remoteUrl: args.remoteUrl,
        token: args.token,
        namespace: args.namespace,
        includeTranscripts: args.includeTranscripts,
      });
    } catch (error) {
      if (!isOfflineSnapshotStreamFallbackError(error)) throw error;
    }
  }
  return fetchOfflineJson(
    offlineEndpoint(args.remoteUrl, "/remnic/v1/offline-sync/snapshot", {
      namespace: args.namespace,
      include_transcripts: args.includeTranscripts ? "true" : "false",
      content: args.includeContent === false ? "false" : "true",
    }),
    args.token,
  );
}

export function offlineSnapshotBasePostBody(args: {
  namespace?: string;
  includeTranscripts: boolean;
  baseFiles: readonly OfflineSyncFileState[];
  baseCapturedAt?: Date;
}): string {
  return JSON.stringify({
    namespace: args.namespace,
    includeTranscripts: args.includeTranscripts,
    includeContent: false,
    baseFiles: args.baseFiles,
    ...(args.baseCapturedAt ? { baseCapturedAt: args.baseCapturedAt.toISOString() } : {}),
  });
}

export function offlineSnapshotBasePostBodyFits(body: string): boolean {
  const bytes = Buffer.byteLength(body, "utf-8");
  return bytes <= OFFLINE_SYNC_SNAPSHOT_BASE_MAX_BODY_BYTES &&
    bytes <= OFFLINE_SYNC_SNAPSHOT_BASE_POST_PREFERRED_MAX_BODY_BYTES;
}

export const OFFLINE_SYNC_SNAPSHOT_BASE_POST_MAX_FILES = 50_000;

export function offlineSnapshotBasePostRequest(body: string): Pick<RequestInit, "body" | "headers"> | null {
  const bytes = Buffer.byteLength(body, "utf-8");
  if (bytes > OFFLINE_SYNC_SNAPSHOT_BASE_MAX_BODY_BYTES) return null;
  if (bytes <= OFFLINE_SYNC_SNAPSHOT_BASE_POST_PREFERRED_MAX_BODY_BYTES) {
    return { body };
  }
  const compressed = gzipSync(body);
  if (compressed.byteLength > OFFLINE_SYNC_SNAPSHOT_BASE_POST_PREFERRED_MAX_BODY_BYTES) {
    return null;
  }
  return {
    body: compressed,
    headers: {
      "content-encoding": "gzip",
    },
  };
}

export function isOfflineSnapshotPostFallbackError(
  error: unknown,
  options: { compressed?: boolean } = {},
): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/offline-sync\/snapshot\b.* returned (404|405|413)\b/.test(message)) return true;
  if (
    /^offline sync request timed out after \d+ms: POST .*\/offline-sync\/snapshot\b/.test(message) ||
    /^offline sync request failed before response: POST .*\/offline-sync\/snapshot\b/.test(message) ||
    /^(This operation was aborted|The operation was aborted|AbortError)/i.test(message)
  ) {
    return true;
  }
  if (!options.compressed) return false;
  return /offline-sync\/snapshot\b.* returned (400|415)\b/.test(message) &&
    /\b(unsupported_content_encoding|invalid_gzip_body|invalid_json)\b/.test(message);
}

function isOfflineSnapshotStreamFallbackError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /offline-sync\/snapshot-stream\b.* returned (404|405)\b/.test(message);
}

async function fetchOfflineFiles(args: {
  remoteUrl: string;
  token: string;
  namespace?: string;
  includeTranscripts: boolean;
  paths: readonly string[];
}): Promise<OfflineSyncSnapshot & { namespace?: string }> {
  return fetchOfflineJson(
    offlineEndpoint(args.remoteUrl, "/remnic/v1/offline-sync/files"),
    args.token,
    {
      method: "POST",
      body: JSON.stringify({
        namespace: args.namespace,
        includeTranscripts: args.includeTranscripts,
        paths: args.paths,
      }),
    },
  );
}

interface OfflineFileContentChunk {
  path: string;
  sha256?: string;
  bytes: number;
  mtimeMs: number;
  offset: number;
  chunkBytes: number;
  content: Buffer;
}

const APPEND_TOLERANT_RUNTIME_STATE_FILES = new Set([
  "memory-lifecycle-ledger.jsonl",
  "recall_impressions.jsonl",
]);

function isAppendTolerantOfflineRuntimeFile(relPath: string): boolean {
  if (!shouldPreferIncomingOfflineRuntimeFile(relPath)) return false;
  const parts = relPath.split("/");
  const basename = parts[parts.length - 1] ?? "";
  return APPEND_TOLERANT_RUNTIME_STATE_FILES.has(basename);
}

function offlineFileContentChunkMatchesExpected(options: {
  chunk: OfflineFileContentChunk;
  expected: OfflineSyncFileState;
  offset: number;
}): boolean {
  const { chunk, expected, offset } = options;
  if (chunk.path !== expected.path) return false;
  if (chunk.offset !== offset) return false;
  if (chunk.chunkBytes !== chunk.content.length) return false;
  if (offset + chunk.chunkBytes > expected.bytes) return false;
  if (
    chunk.bytes === expected.bytes &&
    chunk.mtimeMs === expected.mtimeMs &&
    (chunk.sha256 === undefined || chunk.sha256 === expected.sha256)
  ) {
    return true;
  }
  if (!isAppendTolerantOfflineRuntimeFile(expected.path)) return false;
  if (chunk.bytes < expected.bytes) return false;
  return true;
}

const OFFLINE_SYNC_DIRECT_DEFAULT_MIN_BYTES = 16 * 1024 * 1024;
const OFFLINE_SYNC_FILES_CONTENT_MAX_BATCH_BYTES = 8 * 1024 * 1024;
export const OFFLINE_SYNC_APPLY_MAX_REQUEST_BYTES = Math.floor(OFFLINE_SYNC_APPLY_MAX_BODY_BYTES / 2);
const OFFLINE_SYNC_DIRECT_PUSH_INLINE_MARGIN_BYTES = 256 * 1024;
const OFFLINE_SYNC_INLINE_CONTENT_MAX_BYTES = Math.max(
  1,
  Math.floor((OFFLINE_SYNC_APPLY_MAX_REQUEST_BYTES - OFFLINE_SYNC_DIRECT_PUSH_INLINE_MARGIN_BYTES) * 3 / 4),
);
export const OFFLINE_SYNC_DIRECT_PUSH_MIN_BYTES = Math.min(
  OFFLINE_SYNC_DIRECT_DEFAULT_MIN_BYTES,
  OFFLINE_SYNC_INLINE_CONTENT_MAX_BYTES,
);
export const OFFLINE_SYNC_DIRECT_HYDRATE_MIN_BYTES = OFFLINE_SYNC_DIRECT_PUSH_MIN_BYTES;
export const OFFLINE_SYNC_CHANGESET_RETRY_MAX = 1_024;
export const OFFLINE_SYNC_CONTENT_MISSING_RETRY_MAX = 3;
export const OFFLINE_SYNC_CONTENT_MISSING_RETRY_DELAY_MS = 250;

class OfflineRemoteFileChangedError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`remote file changed while fetching offline content: ${path}`);
    this.name = "OfflineRemoteFileChangedError";
    this.path = path;
  }
}

function isOfflineRemoteFileChangedError(error: unknown): error is OfflineRemoteFileChangedError {
  return error instanceof OfflineRemoteFileChangedError ||
    (error instanceof Error && error.message.startsWith("remote file changed while fetching offline content: "));
}

function isOfflineHydrateChecksumMismatch(error: unknown, relPath: string): boolean {
  return error instanceof Error &&
    error.message === `offline sync upload checksum mismatch for ${relPath}`;
}

function isOfflineLocalFileChangedError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("local file changed while pushing offline content: ");
}

function offlineChangesetFileChangedPath(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const prefix = "offline sync file changed while building changeset: ";
  if (!error.message.startsWith(prefix)) return null;
  const relPath = error.message.slice(prefix.length).trim();
  return relPath.length > 0 ? relPath : null;
}

function parseOfflineHeaderNumber(headers: Headers, name: string): number {
  const raw = headers.get(name);
  if (raw === null) throw new Error(`offline file content response omitted ${name}`);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`offline file content response had invalid ${name}: ${raw}`);
  }
  return parsed;
}

async function fetchOfflineFileContentChunk(args: {
  remoteUrl: string;
  token: string;
  namespace?: string;
  includeTranscripts: boolean;
  path: string;
  offset: number;
  length: number;
}): Promise<OfflineFileContentChunk> {
  const url = offlineEndpoint(args.remoteUrl, "/remnic/v1/offline-sync/file-content");
  const init: RequestInit = {
    method: "POST",
    body: JSON.stringify({
      namespace: args.namespace,
      includeTranscripts: args.includeTranscripts,
      path: args.path,
      offset: args.offset,
      length: args.length,
    }),
  };
  return fetchOfflineWithResponse(
    url,
    args.token,
    init,
    { defaultContentType: "application/json" },
    async (response) => {
      if (!response.ok) {
        await throwOfflineResponseError(response, url, init, "offline sync file-content request");
      }
      const encodedPath = response.headers.get("x-remnic-file-path");
      const relPath = encodedPath ? decodeURIComponent(encodedPath) : args.path;
      const content = Buffer.from(await response.arrayBuffer());
      const chunkBytes = parseOfflineHeaderNumber(response.headers, "x-remnic-chunk-bytes");
      const sha256 = response.headers.get("x-remnic-file-sha256") ?? undefined;
      if (content.length !== chunkBytes) {
        throw new Error(`offline file content response length mismatch for ${relPath}`);
      }
      return {
        path: relPath,
        ...(sha256 ? { sha256 } : {}),
        bytes: parseOfflineHeaderNumber(response.headers, "x-remnic-file-bytes"),
        mtimeMs: parseOfflineHeaderNumber(response.headers, "x-remnic-file-mtime-ms"),
        offset: parseOfflineHeaderNumber(response.headers, "x-remnic-chunk-offset"),
        chunkBytes,
        content,
      };
    },
  );
}

async function postOfflineFileContentChunk(args: {
  remoteUrl: string;
  token: string;
  namespace?: string;
  includeTranscripts: boolean;
  sourceId: string;
  file: OfflineSyncFileState;
  baseSha256?: string;
  offset: number;
  content: Buffer;
}): Promise<OfflineSyncApplyFileContentChunkResult & { namespace?: string }> {
  const url = offlineEndpoint(args.remoteUrl, "/remnic/v1/offline-sync/apply-file-content", {
    namespace: args.namespace,
  });
  const init: RequestInit = {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-remnic-include-transcripts": args.includeTranscripts ? "true" : "false",
      "x-remnic-source-id": encodeURIComponent(args.sourceId),
      "x-remnic-file-path": encodeURIComponent(args.file.path),
      "x-remnic-file-sha256": args.file.sha256,
      "x-remnic-file-bytes": String(args.file.bytes),
      "x-remnic-file-mtime-ms": String(args.file.mtimeMs),
      "x-remnic-chunk-offset": String(args.offset),
      ...(args.baseSha256 ? { "x-remnic-base-sha256": args.baseSha256 } : {}),
    },
    body: new Blob([new Uint8Array(args.content)]),
  };
  return fetchOfflineWithResponse(
    url,
    args.token,
    init,
    {},
    async (response) => {
      if (!response.ok) {
        await throwOfflineResponseError(response, url, init, "offline sync apply-file-content request");
      }
      return await response.json() as OfflineSyncApplyFileContentChunkResult & { namespace?: string };
    },
  );
}

function resolvedOfflineSnapshotNamespace(
  snapshot: { namespace?: string },
  requestedNamespace?: string,
): string | undefined {
  const resolved = typeof snapshot.namespace === "string" && snapshot.namespace.trim().length > 0
    ? snapshot.namespace.trim()
    : undefined;
  return resolved ?? requestedNamespace;
}

function uniqueOfflineStatePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const filePath of paths) {
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    out.push(filePath);
  }
  return out;
}

function offlineStatePathsForNamespace(options: {
  memoryDir: string;
  remoteUrl: string;
  requestedNamespace?: string;
  resolvedNamespace?: string;
  explicitStatePath?: string;
}): string[] {
  if (options.explicitStatePath) return [options.explicitStatePath];
  const primaryNamespace = options.resolvedNamespace ?? options.requestedNamespace;
  const paths = [
    defaultOfflineSyncStatePath(options.memoryDir, options.remoteUrl, primaryNamespace),
  ];
  if (options.requestedNamespace !== primaryNamespace) {
    paths.push(defaultOfflineSyncStatePath(options.memoryDir, options.remoteUrl, options.requestedNamespace));
  }
  return uniqueOfflineStatePaths(paths);
}

async function readFirstOfflineSyncState(
  paths: readonly string[],
): Promise<{ statePath: string; state: OfflineSyncState } | null> {
  for (const statePath of paths) {
    const state = await readOfflineSyncState(statePath);
    if (state) return { statePath, state };
  }
  return null;
}

function offlineFileStateMap(
  files: readonly OfflineSyncFileState[],
): Map<string, OfflineSyncFileState> {
  return new Map(files.map((file) => [file.path, file]));
}

export function offlineSnapshotContentFilesForApply(options: {
  snapshot: OfflineSyncSnapshot;
  baseFiles: readonly OfflineSyncFileState[];
  currentFiles?: readonly OfflineSyncFileState[];
  conflictContentMaxBytes?: number;
  deferredPaths?: readonly string[];
}): OfflineSyncFileState[] {
  const base = offlineFileStateMap(options.baseFiles);
  const current = options.currentFiles ? offlineFileStateMap(options.currentFiles) : null;
  const conflictContentMaxBytes = options.conflictContentMaxBytes ?? Number.POSITIVE_INFINITY;
  const deferredPaths = new Set(options.deferredPaths ?? []);
  const files: OfflineSyncFileState[] = [];
  for (const incoming of options.snapshot.files) {
    if (deferredPaths.has(incoming.path)) continue;
    const baseEntry = base.get(incoming.path);
    const currentEntry = current?.get(incoming.path);
    if (currentEntry?.sha256 === incoming.sha256) continue;
    if (currentEntry && baseEntry && incoming.sha256 === baseEntry.sha256) continue;
    if (shouldPreferIncomingOfflineRuntimeFile(incoming.path)) {
      files.push(incoming);
      continue;
    }
    if (!currentEntry && baseEntry && incoming.sha256 === baseEntry.sha256) continue;
    if (!currentEntry && !baseEntry) {
      files.push(incoming);
      continue;
    }
    if (baseEntry && currentEntry && currentEntry.sha256 === baseEntry.sha256) {
      files.push(incoming);
      continue;
    }
    if (incoming.bytes > conflictContentMaxBytes) continue;
    files.push(incoming);
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export function shouldDirectHydrateOfflineFile(options: {
  incoming: OfflineSyncFileState;
  base?: OfflineSyncFileState;
  current?: OfflineSyncFileState;
}): boolean {
  if (options.incoming.bytes < OFFLINE_SYNC_DIRECT_HYDRATE_MIN_BYTES) return false;
  if (options.current?.sha256 === options.incoming.sha256) return false;
  if (shouldPreferIncomingOfflineRuntimeFile(options.incoming.path)) return true;
  if (options.current && options.base && options.current.sha256 === options.base.sha256) {
    return true;
  }
  return !options.current && !options.base;
}

export function offlinePartialHydrationForPaths(options: {
  files: readonly OfflineSyncFileState[];
  hydratedPaths: Iterable<string>;
  deferredPaths: Iterable<string>;
}): {
  hydratedFiles: OfflineSyncFileState[];
  remoteDeferredPaths: string[];
} {
  const hydratedPaths = new Set(options.hydratedPaths);
  return {
    hydratedFiles: options.files.filter((file) => hydratedPaths.has(file.path)),
    remoteDeferredPaths: [...options.deferredPaths],
  };
}

function offlineDirectPushFiles(options: {
  currentFiles: readonly OfflineSyncFileState[];
  baseFiles: readonly OfflineSyncFileState[];
}): OfflineSyncFileState[] {
  const base = offlineFileStateMap(options.baseFiles);
  return options.currentFiles
    .filter((current) => {
      if (current.bytes < OFFLINE_SYNC_DIRECT_PUSH_MIN_BYTES) return false;
      if (shouldPreferIncomingOfflineRuntimeFile(current.path)) return false;
      return current.sha256 !== base.get(current.path)?.sha256;
    })
    .sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path));
}

export const OFFLINE_SYNC_FILE_CONTENT_UPLOAD_CHUNK_BYTES =
  OFFLINE_SYNC_FILE_CONTENT_TRANSFER_CHUNK_BYTES;

type OfflineFileChunkReader = (
  target: OfflineSyncFileTarget & { chunkSize: number },
) => AsyncIterable<Buffer>;

export async function pushOfflineFileContent(args: {
  remoteUrl: string;
  token: string;
  namespace?: string;
  includeTranscripts: boolean;
  memoryDir: string;
  sourceId: string;
  file: OfflineSyncFileState;
  baseSha256?: string;
  readFile?: Parameters<typeof readOfflineSyncFileContentChunk>[0]["readFile"];
  readFileChunks?: OfflineFileChunkReader;
}): Promise<OfflineSyncApplyFileContentChunkResult & { namespace?: string }> {
  if (args.readFileChunks) {
    return pushOfflineFileContentFromChunkReader(args as typeof args & {
      readFileChunks: OfflineFileChunkReader;
    });
  }
  let offset = 0;
  let finalResult: (OfflineSyncApplyFileContentChunkResult & { namespace?: string }) | null = null;
  let remoteSatisfiedResult: (OfflineSyncApplyFileContentChunkResult & { namespace?: string }) | null = null;
  const hash = createHash("sha256");
  let bytes = 0;
  while (offset < args.file.bytes || (args.file.bytes === 0 && offset === 0)) {
    const chunk = await readOfflineSyncFileContentChunk({
      root: args.memoryDir,
      path: args.file.path,
      offset,
      length: Math.min(
        OFFLINE_SYNC_FILE_CONTENT_UPLOAD_CHUNK_BYTES,
        Math.max(1, args.file.bytes - offset),
      ),
      includeTranscripts: args.includeTranscripts,
      readFile: args.readFile,
    });
    if (
      chunk.path !== args.file.path ||
      (chunk.sha256 !== undefined && chunk.sha256 !== args.file.sha256) ||
      chunk.bytes !== args.file.bytes ||
      chunk.mtimeMs !== args.file.mtimeMs ||
      chunk.offset !== offset
    ) {
      throw new Error(`local file changed while pushing offline content: ${args.file.path}`);
    }
    if (chunk.chunkBytes === 0 && args.file.bytes > 0) {
      throw new Error(`local offline content chunk was empty before EOF: ${args.file.path}`);
    }
    hash.update(chunk.content);
    bytes += chunk.chunkBytes;
    if (!remoteSatisfiedResult) {
      finalResult = await postOfflineFileContentChunk({
        remoteUrl: args.remoteUrl,
        token: args.token,
        namespace: args.namespace,
        includeTranscripts: args.includeTranscripts,
        sourceId: args.sourceId,
        file: args.file,
        baseSha256: args.baseSha256,
        offset,
        content: chunk.content,
      });
      if (finalResult.conflict) {
        return finalResult;
      }
      if (finalResult.done && finalResult.skipped) {
        remoteSatisfiedResult = finalResult;
      }
    }
    offset += chunk.chunkBytes;
    if (args.file.bytes === 0) break;
  }
  if (hash.digest("hex") !== args.file.sha256 || bytes !== args.file.bytes) {
    throw new Error(`local file changed while pushing offline content: ${args.file.path}`);
  }
  if (remoteSatisfiedResult) {
    return remoteSatisfiedResult;
  }
  if (!finalResult?.done) {
    throw new Error(`offline sync large-file push did not finish for ${args.file.path}`);
  }
  return finalResult;
}

export async function pushOfflineFileContentFromChunkReader(args: {
  remoteUrl: string;
  token: string;
  namespace?: string;
  includeTranscripts: boolean;
  memoryDir: string;
  sourceId: string;
  file: OfflineSyncFileState;
  baseSha256?: string;
  readFileChunks: OfflineFileChunkReader;
}): Promise<OfflineSyncApplyFileContentChunkResult & { namespace?: string }> {
  const filePath = resolveOfflineDirectHydrationPath(args.memoryDir, args.file.path);
  const stat = fs.statSync(filePath);
  if (stat.mtimeMs !== args.file.mtimeMs) {
    throw new Error(`local file changed while pushing offline content: ${args.file.path}`);
  }
  const hash = createHash("sha256");
  const chunks = args.readFileChunks({
    root: path.resolve(args.memoryDir),
    path: args.file.path,
    filePath,
    chunkSize: OFFLINE_SYNC_FILE_CONTENT_UPLOAD_CHUNK_BYTES,
  });
  let offset = 0;
  let pending: Buffer | null = null;
  let finalResult: (OfflineSyncApplyFileContentChunkResult & { namespace?: string }) | null = null;
  let remoteSatisfiedResult: (OfflineSyncApplyFileContentChunkResult & { namespace?: string }) | null = null;

  for await (const rawChunk of chunks) {
    const chunk = Buffer.from(rawChunk);
    if (chunk.length === 0) continue;
    if (chunk.length > OFFLINE_SYNC_FILE_CONTENT_MAX_CHUNK_BYTES) {
      throw new Error(`local offline content chunk exceeds max size: ${args.file.path}`);
    }
    if (pending) {
      hash.update(pending);
      if (!remoteSatisfiedResult) {
        finalResult = await postOfflineFileContentChunk({
          remoteUrl: args.remoteUrl,
          token: args.token,
          namespace: args.namespace,
          includeTranscripts: args.includeTranscripts,
          sourceId: args.sourceId,
          file: args.file,
          baseSha256: args.baseSha256,
          offset,
          content: pending,
        });
        if (finalResult.conflict) {
          return finalResult;
        }
        if (finalResult.done && finalResult.skipped) {
          remoteSatisfiedResult = finalResult;
        }
      }
      offset += pending.length;
    }
    pending = chunk;
  }

  if (pending) hash.update(pending);
  const finalBytes = offset + (pending?.length ?? 0);
  const digest = hash.digest("hex");
  if (digest !== args.file.sha256 || finalBytes !== args.file.bytes) {
    throw new Error(`local file changed while pushing offline content: ${args.file.path}`);
  }

  if (remoteSatisfiedResult) {
    return remoteSatisfiedResult;
  }

  if (pending) {
    finalResult = await postOfflineFileContentChunk({
      remoteUrl: args.remoteUrl,
      token: args.token,
      namespace: args.namespace,
      includeTranscripts: args.includeTranscripts,
      sourceId: args.sourceId,
      file: args.file,
      baseSha256: args.baseSha256,
      offset,
      content: pending,
    });
    if (finalResult.conflict) {
      return finalResult;
    }
    if (finalResult.done && finalResult.skipped) {
      return finalResult;
    }
  } else if (args.file.bytes === 0) {
    finalResult = await postOfflineFileContentChunk({
      remoteUrl: args.remoteUrl,
      token: args.token,
      namespace: args.namespace,
      includeTranscripts: args.includeTranscripts,
      sourceId: args.sourceId,
      file: args.file,
      baseSha256: args.baseSha256,
      offset: 0,
      content: Buffer.alloc(0),
    });
  }
  if (!finalResult?.done) {
    throw new Error(`offline sync large-file push did not finish for ${args.file.path}`);
  }
  return finalResult;
}

async function fetchOfflineFileContent(args: {
  remoteUrl: string;
  token: string;
  namespace?: string;
  includeTranscripts: boolean;
  expected: OfflineSyncFileState;
}): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const hash = createHash("sha256");
  let offset = 0;
  while (offset < args.expected.bytes) {
    const chunk = await fetchOfflineFileContentChunk({
      remoteUrl: args.remoteUrl,
      token: args.token,
      namespace: args.namespace,
      includeTranscripts: args.includeTranscripts,
      path: args.expected.path,
      offset,
      length: Math.min(
        OFFLINE_SYNC_FILE_CONTENT_MAX_CHUNK_BYTES,
        args.expected.bytes - offset,
      ),
    });
    if (!offlineFileContentChunkMatchesExpected({ chunk, expected: args.expected, offset })) {
      throw new OfflineRemoteFileChangedError(args.expected.path);
    }
    if (chunk.chunkBytes === 0) {
      throw new Error(`remote offline content chunk was empty before EOF: ${args.expected.path}`);
    }
    chunks.push(chunk.content);
    hash.update(chunk.content);
    offset += chunk.chunkBytes;
  }
  const content = Buffer.concat(chunks, offset);
  const digest = hash.digest("hex");
  if (digest !== args.expected.sha256 || content.length !== args.expected.bytes) {
    if (isAppendTolerantOfflineRuntimeFile(args.expected.path)) {
      throw new OfflineRemoteFileChangedError(args.expected.path);
    }
    throw new Error(`remote offline content checksum mismatch for ${args.expected.path}`);
  }
  return content;
}

async function hydrateOfflineFileContent(args: {
  remoteUrl: string;
  token: string;
  namespace?: string;
  includeTranscripts: boolean;
  memoryDir: string;
  sourceId: string;
  expected: OfflineSyncFileState;
  baseSha256?: string;
  readFile: NonNullable<Parameters<typeof applyOfflineSyncFileContentChunk>[0]["readFile"]>;
  readFileDigest?: Parameters<typeof applyOfflineSyncFileContentChunk>[0]["readFileDigest"];
  writeFile: NonNullable<Parameters<typeof applyOfflineSyncFileContentChunk>[0]["writeFile"]>;
  writeStagingFile: NonNullable<Parameters<typeof applyOfflineSyncFileContentChunk>[0]["writeStagingFile"]>;
  writeFileChunks: NonNullable<Parameters<typeof applyOfflineSyncFileContentChunk>[0]["writeFileChunks"]>;
}): Promise<OfflineSyncApplyFileContentChunkResult> {
  let offset = 0;
  let finalResult: OfflineSyncApplyFileContentChunkResult | null = null;
  while (offset < args.expected.bytes || (args.expected.bytes === 0 && offset === 0)) {
    const chunk = await fetchOfflineFileContentChunk({
      remoteUrl: args.remoteUrl,
      token: args.token,
      namespace: args.namespace,
      includeTranscripts: args.includeTranscripts,
      path: args.expected.path,
      offset,
      length: Math.min(
        OFFLINE_SYNC_FILE_CONTENT_MAX_CHUNK_BYTES,
        Math.max(1, args.expected.bytes - offset),
      ),
    });
    if (!offlineFileContentChunkMatchesExpected({ chunk, expected: args.expected, offset })) {
      throw new OfflineRemoteFileChangedError(args.expected.path);
    }
    if (chunk.chunkBytes === 0 && args.expected.bytes > 0) {
      throw new Error(`remote offline content chunk was empty before EOF: ${args.expected.path}`);
    }
    try {
      finalResult = await applyOfflineSyncFileContentChunk({
        root: args.memoryDir,
        sourceId: args.sourceId,
        path: args.expected.path,
        sha256: args.expected.sha256,
        bytes: args.expected.bytes,
        mtimeMs: args.expected.mtimeMs,
        offset,
        content: chunk.content,
        ...(args.baseSha256 ? { baseSha256: args.baseSha256 } : {}),
        includeTranscripts: args.includeTranscripts,
        readFile: args.readFile,
        readFileDigest: args.readFileDigest,
        writeFile: args.writeFile,
        writeStagingFile: args.writeStagingFile,
        writeFileChunks: args.writeFileChunks,
      });
    } catch (error) {
      if (
        isAppendTolerantOfflineRuntimeFile(args.expected.path) &&
        isOfflineHydrateChecksumMismatch(error, args.expected.path)
      ) {
        throw new OfflineRemoteFileChangedError(args.expected.path);
      }
      throw error;
    }
    if (finalResult.conflict) {
      return finalResult;
    }
    if (finalResult.done && finalResult.skipped) {
      return finalResult;
    }
    offset += chunk.chunkBytes;
    if (args.expected.bytes === 0) break;
  }
  if (!finalResult?.done) {
    throw new Error(`offline sync large-file hydrate did not finish for ${args.expected.path}`);
  }
  return finalResult;
}

export async function directHydrateLargeOfflineFiles(args: {
  remoteUrl: string;
  token: string;
  namespace?: string;
  includeTranscripts: boolean;
  snapshot: OfflineSyncSnapshot & { namespace?: string };
  baseFiles: readonly OfflineSyncFileState[];
  currentFiles: readonly OfflineSyncFileState[];
  memoryDir: string;
  writeFile?: (target: OfflineSyncFileWriteTarget) => Promise<void>;
  readFile?: Parameters<typeof applyOfflineSyncFileContentChunk>[0]["readFile"];
  readFileDigest?: Parameters<typeof applyOfflineSyncFileContentChunk>[0]["readFileDigest"];
  writeStagingFile?: Parameters<typeof applyOfflineSyncFileContentChunk>[0]["writeStagingFile"];
  writeFileChunks?: Parameters<typeof applyOfflineSyncFileContentChunk>[0]["writeFileChunks"];
  hydrationProgress?: {
    hydratedPaths: Set<string>;
    deferredPaths: Set<string>;
  };
}): Promise<{ hydratedPaths: Set<string>; deferredPaths: Set<string> }> {
  if (!args.readFile || !args.writeFile || !args.writeStagingFile || !args.writeFileChunks) {
    return { hydratedPaths: new Set(), deferredPaths: new Set() };
  }
  const snapshot = normalizeOfflineSyncSnapshot(args.snapshot);
  const base = offlineFileStateMap(args.baseFiles);
  const current = offlineFileStateMap(args.currentFiles);
  const hydratedPaths = args.hydrationProgress?.hydratedPaths ?? new Set<string>();
  const deferredPaths = args.hydrationProgress?.deferredPaths ?? new Set<string>();
  const candidates = snapshot.files
    .filter((incoming) =>
      shouldDirectHydrateOfflineFile({
        incoming,
        base: base.get(incoming.path),
        current: current.get(incoming.path),
      }))
    .sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path));
  for (const incoming of candidates) {
    let result: OfflineSyncApplyFileContentChunkResult;
    try {
      result = await hydrateOfflineFileContent({
        remoteUrl: args.remoteUrl,
        token: args.token,
        namespace: args.namespace,
        includeTranscripts: args.includeTranscripts,
        memoryDir: args.memoryDir,
        sourceId: "remote",
        expected: incoming,
        baseSha256: base.get(incoming.path)?.sha256,
        readFile: args.readFile,
        readFileDigest: args.readFileDigest,
        writeFile: args.writeFile,
        writeStagingFile: args.writeStagingFile,
        writeFileChunks: args.writeFileChunks,
      });
    } catch (error) {
      if (!isOfflineRemoteFileChangedError(error)) throw error;
      deferredPaths.add(incoming.path);
      continue;
    }
    if (result.conflict) {
      deferredPaths.add(result.conflict.path);
      continue;
    }
    if (result.applied || result.skipped) {
      hydratedPaths.add(incoming.path);
    }
  }
  return { hydratedPaths, deferredPaths };
}

export function chunkOfflineFileContentBatches(
  files: readonly OfflineSyncFileState[],
): OfflineSyncFileState[][] {
  const chunks: OfflineSyncFileState[][] = [];
  let current: OfflineSyncFileState[] = [];
  let currentPathBytes = 256;
  let currentContentBytes = 0;
  for (const file of files) {
    const pathCost = Buffer.byteLength(JSON.stringify(file.path), "utf-8") + 1;
    if (
      current.length > 0 &&
      (
        current.length >= 1000 ||
        currentPathBytes + pathCost > 96_000 ||
        currentContentBytes + file.bytes > OFFLINE_SYNC_FILES_CONTENT_MAX_BATCH_BYTES
      )
    ) {
      chunks.push(current);
      current = [];
      currentPathBytes = 256;
      currentContentBytes = 0;
    }
    current.push(file);
    currentPathBytes += pathCost;
    currentContentBytes += file.bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function isOfflineFilesUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /offline sync request failed: .* returned 404\b/.test(message);
}

class OfflineMissingContentError extends Error {
  readonly missing: readonly OfflineSyncFileState[];

  constructor(missing: readonly OfflineSyncFileState[]) {
    const preview = missing.slice(0, 8).map((file) => file.path).join(", ");
    const suffix = missing.length > 8 ? `, ... +${missing.length - 8} more` : "";
    super(
      `remote offline content response omitted ${missing.length} changed file${missing.length === 1 ? "" : "s"}: ${preview}${suffix}; retry sync`,
    );
    this.name = "OfflineMissingContentError";
    this.missing = missing;
  }
}

function isMissingOfflineContentError(error: unknown): boolean {
  if (error instanceof OfflineMissingContentError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /^missing decoded content for /.test(message);
}

function formatMissingOfflineContentError(missing: readonly OfflineSyncFileState[]): Error {
  return new OfflineMissingContentError(missing);
}

export function isOfflineMissingContentDeferrablePath(relPath: string): boolean {
  const parts = relPath.split("/");
  return parts[0] === "profiling" || (parts[0] === "namespaces" && parts[2] === "profiling");
}

function deferMissingOfflineContent(
  missing: readonly OfflineSyncFileState[],
  deferredPaths: Set<string> | undefined,
): OfflineSyncFileState[] {
  if (!deferredPaths) return [...missing];
  const stillMissing: OfflineSyncFileState[] = [];
  for (const file of missing) {
    if (isOfflineMissingContentDeferrablePath(file.path)) {
      deferredPaths.add(file.path);
    } else {
      stillMissing.push(file);
    }
  }
  return stillMissing;
}

function formatMissingDecodedContentError(missing: readonly OfflineSyncFileState[]): Error {
  const preview = missing.slice(0, 8).map((file) => file.path).join(", ");
  const suffix = missing.length > 8 ? `, ... +${missing.length - 8} more` : "";
  return new Error(
    `remote offline content response omitted ${missing.length} changed file${missing.length === 1 ? "" : "s"}: ${preview}${suffix}; retry sync`,
  );
}

async function waitForMissingOfflineContentRetry(delayMs: number): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function hydrateOfflineSnapshotContent(args: {
  remoteUrl: string;
  token: string;
  namespace?: string;
  includeTranscripts: boolean;
  snapshot: OfflineSyncSnapshot & { namespace?: string };
  baseFiles: readonly OfflineSyncFileState[];
  currentFiles?: readonly OfflineSyncFileState[];
  deferredPaths?: readonly string[];
  missingContentDeferredPaths?: Set<string>;
  fetchFiles?: typeof fetchOfflineFiles;
  missingContentRetryMax?: number;
  missingContentRetryDelayMs?: number;
}): Promise<OfflineSyncSnapshot & { namespace?: string }> {
  const snapshot = normalizeOfflineSyncSnapshot(args.snapshot);
  const neededFiles = offlineSnapshotContentFilesForApply({
    snapshot,
    baseFiles: args.baseFiles,
    currentFiles: args.currentFiles,
    conflictContentMaxBytes: OFFLINE_SYNC_FILES_CONTENT_MAX_BATCH_BYTES,
    deferredPaths: args.deferredPaths,
  });
  if (neededFiles.length === 0) return { ...args.snapshot, files: snapshot.files };

  const expectedByPath = new Map(snapshot.files.map((file) => [file.path, file]));
  const contentByPath = new Map<string, string>();
  const updatedByPath = new Map<string, OfflineSyncFileState & { contentBase64: string }>();
  const fetchFiles = args.fetchFiles ?? fetchOfflineFiles;
  const retryMax = args.missingContentRetryMax ?? OFFLINE_SYNC_CONTENT_MISSING_RETRY_MAX;
  const retryDelayMs = args.missingContentRetryDelayMs ?? OFFLINE_SYNC_CONTENT_MISSING_RETRY_DELAY_MS;
  if (!Number.isInteger(retryMax) || retryMax < 0) {
    throw new Error("offline sync missing content retry max must be an integer >= 0");
  }
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0) {
    throw new Error("offline sync missing content retry delay must be an integer >= 0");
  }
  try {
    let pendingFiles = neededFiles;
    for (let attempt = 0; ; attempt += 1) {
      for (const batch of chunkOfflineFileContentBatches(pendingFiles)) {
        const partial = await fetchFiles({
          remoteUrl: args.remoteUrl,
          token: args.token,
          namespace: args.namespace,
          includeTranscripts: args.includeTranscripts,
          paths: batch.map((file) => file.path),
        });
        for (const file of partial.files) {
          const expected = expectedByPath.get(file.path);
          if (!expected) continue;
          if (typeof file.contentBase64 !== "string") {
            throw new Error(`remote offline content response omitted contentBase64 for ${file.path}`);
          }
          if (file.sha256 !== expected.sha256 || file.bytes !== expected.bytes || file.mtimeMs !== expected.mtimeMs) {
            updatedByPath.set(file.path, file as OfflineSyncFileState & { contentBase64: string });
          }
          contentByPath.set(file.path, file.contentBase64);
        }
      }
      const missing = pendingFiles.filter((file) => !contentByPath.has(file.path));
      if (missing.length === 0) break;
      if (attempt >= retryMax) {
        const stillMissing = deferMissingOfflineContent(missing, args.missingContentDeferredPaths);
        if (stillMissing.length > 0) throw formatMissingOfflineContentError(stillMissing);
        break;
      }
      pendingFiles = missing;
      await waitForMissingOfflineContentRetry(retryDelayMs);
    }
  } catch (error) {
    if (!isOfflineFilesUnsupportedError(error)) throw error;
    return fetchOfflineSnapshot({
      remoteUrl: args.remoteUrl,
      token: args.token,
      namespace: args.namespace,
      includeTranscripts: args.includeTranscripts,
      includeContent: true,
    });
  }

  const missing = neededFiles
    .map((file) => file.path)
    .filter((relPath) => !contentByPath.has(relPath) && !args.missingContentDeferredPaths?.has(relPath));
  if (missing.length > 0) {
    throw formatMissingDecodedContentError(
      neededFiles.filter((file) => missing.includes(file.path)),
    );
  }

  return {
    ...args.snapshot,
    files: snapshot.files.map((file) => {
      const updated = updatedByPath.get(file.path);
      if (updated) return updated;
      const contentBase64 = contentByPath.get(file.path);
      return contentBase64 === undefined ? file : { ...file, contentBase64 };
    }),
  };
}

export function chunkOfflineChangesetApplyBatches(
  changeset: Awaited<ReturnType<typeof buildOfflineSyncChangeset>>,
  namespace?: string,
  maxRequestBytes = OFFLINE_SYNC_APPLY_MAX_REQUEST_BYTES,
): Array<Awaited<ReturnType<typeof buildOfflineSyncChangeset>>> {
  if (!Number.isInteger(maxRequestBytes) || maxRequestBytes < 1) {
    throw new Error("offline sync apply max request bytes must be a positive integer");
  }
  const chunks: Array<Awaited<ReturnType<typeof buildOfflineSyncChangeset>>> = [];
  let current: Awaited<ReturnType<typeof buildOfflineSyncChangeset>>["changes"] = [];
  const requestBytesFor = (changes: typeof current) => Buffer.byteLength(JSON.stringify({
    namespace,
    changeset: {
      ...changeset,
      changes,
    },
  }), "utf-8");
  for (const change of changeset.changes) {
    const withChange = [...current, change];
    if (current.length > 0 && requestBytesFor(withChange) > maxRequestBytes) {
      chunks.push({ ...changeset, changes: current });
      current = [];
    }
    const singleBytes = requestBytesFor([...current, change]);
    if (singleBytes > maxRequestBytes) {
      throw new Error(
        `offline sync change for ${change.path} exceeds the apply request size budget; retry after direct-push threshold is lowered`,
      );
    }
    current.push(change);
  }
  if (current.length > 0) {
    chunks.push({ ...changeset, changes: current });
  }
  return chunks;
}

async function postOfflineChangesBatch(args: {
  remoteUrl: string;
  token: string;
  namespace?: string;
  changeset: Awaited<ReturnType<typeof buildOfflineSyncChangeset>>;
}): Promise<{
  namespace: string;
  appliedUpserts: number;
  appliedDeletes: number;
  skipped: number;
  conflicts: Array<{ path: string; reason: string; conflictPath?: string }>;
}> {
  return fetchOfflineJson(
    offlineEndpoint(args.remoteUrl, "/remnic/v1/offline-sync/apply"),
    args.token,
    {
      method: "POST",
      body: JSON.stringify({
        namespace: args.namespace,
        changeset: args.changeset,
        returnCurrentFiles: false,
      }),
    },
  );
}

async function pushOfflineChanges(args: {
  remoteUrl: string;
  token: string;
  namespace?: string;
  changeset: Awaited<ReturnType<typeof buildOfflineSyncChangeset>>;
  onBatchApplied?: (batch: {
    changeset: Awaited<ReturnType<typeof buildOfflineSyncChangeset>>;
    result: Awaited<ReturnType<typeof postOfflineChangesBatch>>;
  }) => void;
}): Promise<{
  namespace: string;
  appliedUpserts: number;
  appliedDeletes: number;
  skipped: number;
  conflicts: Array<{ path: string; reason: string; conflictPath?: string }>;
}> {
  let namespace = args.namespace ?? "";
  let appliedUpserts = 0;
  let appliedDeletes = 0;
  let skipped = 0;
  const conflicts: Array<{ path: string; reason: string; conflictPath?: string }> = [];
  for (const changeset of chunkOfflineChangesetApplyBatches(args.changeset, args.namespace)) {
    const result = await postOfflineChangesBatch({
      ...args,
      changeset,
    });
    namespace = result.namespace || namespace;
    appliedUpserts += result.appliedUpserts;
    appliedDeletes += result.appliedDeletes;
    skipped += result.skipped;
    conflicts.push(...result.conflicts);
    args.onBatchApplied?.({ changeset, result });
  }
  return {
    namespace,
    appliedUpserts,
    appliedDeletes,
    skipped,
    conflicts,
  };
}

function parseOfflineIntervalMs(args: string[]): number {
  const raw = resolveRequiredValueFlag(args, "--interval-ms");
  if (raw === undefined) return 60_000;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1000) {
    throw new Error("--interval-ms must be an integer >= 1000");
  }
  return parsed;
}

function waitForOfflineInterval(
  ms: number,
  setCancel: (cancel: (() => void) | null) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      setCancel(null);
      resolve();
    }, ms);
    setCancel(() => {
      clearTimeout(timer);
      setCancel(null);
      resolve();
    });
  });
}

export function formatOfflineLargeFilePushFailureMessage(
  failures: readonly { path: string; error: string }[],
): string {
  const paths = failures
    .slice(0, 5)
    .map((failure) => `${failure.path}: ${failure.error}`)
    .join("; ");
  const suffix = failures.length > 5 ? `; +${failures.length - 5} more` : "";
  return `offline sync large-file push failed for ${failures.length} file${failures.length === 1 ? "" : "s"}: ${paths}${suffix}`;
}

class OfflineLargeFilePushError extends Error {
  readonly failures: readonly { path: string; error: string }[];

  constructor(failures: readonly { path: string; error: string }[]) {
    super(formatOfflineLargeFilePushFailureMessage(failures));
    this.name = "OfflineLargeFilePushError";
    this.failures = failures;
  }
}

type OfflineSyncPullResult = Awaited<ReturnType<typeof applyOfflineSyncSnapshot>>;
type OfflineSyncRunResult = {
  statePath: string;
  namespace?: string;
  prepared: boolean;
  pushed: Awaited<ReturnType<typeof pushOfflineChanges>> | null;
  pull: OfflineSyncPullResult | null;
  pullError?: string;
  partial: boolean;
  pendingSummary: ReturnType<typeof summarizeOfflineSyncChangeset>;
  remoteFileCount: number | null;
  largeFilePushFailures: readonly { path: string; error: string }[];
  deferred: {
    localChangedDuringPush: string[];
    remoteChangedDuringHydrate: string[];
    total: number;
  };
};

export function advanceOfflineBaseFilesForSuccessfulPush(options: {
  baseFiles: readonly OfflineSyncFileState[];
  currentFiles: readonly OfflineSyncFileState[];
  directPushedPaths?: readonly string[];
  hydratedFiles?: readonly OfflineSyncFileState[];
  changeset: Awaited<ReturnType<typeof buildOfflineSyncChangeset>>;
  conflicts?: readonly { path: string }[];
}): OfflineSyncFileState[] {
  const next = offlineFileStateMap(options.baseFiles);
  const current = offlineFileStateMap(options.currentFiles);
  const conflictPaths = new Set((options.conflicts ?? []).map((conflict) => conflict.path));
  for (const relPath of options.directPushedPaths ?? []) {
    if (conflictPaths.has(relPath)) continue;
    const file = current.get(relPath);
    if (file) next.set(relPath, file);
  }
  for (const change of options.changeset.changes) {
    if (conflictPaths.has(change.path)) continue;
    if (change.type === "delete") {
      next.delete(change.path);
    } else {
      next.set(change.path, {
        path: change.file.path,
        sha256: change.file.sha256,
        bytes: change.file.bytes,
        mtimeMs: change.file.mtimeMs,
      });
    }
  }
  for (const file of options.hydratedFiles ?? []) {
    if (conflictPaths.has(file.path)) continue;
    next.set(file.path, {
      path: file.path,
      sha256: file.sha256,
      bytes: file.bytes,
      mtimeMs: file.mtimeMs,
    });
  }
  return [...next.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export async function runOfflineSyncOnce(options: {
  memoryDir: string;
  remoteUrl: string;
  token: string;
  namespace?: string;
  includeTranscripts: boolean;
  statePath: string;
  statePathExplicit: boolean;
  /** Operator excludes (#1786): merged --exclude flags + offlineSyncExcludes config, pre-compiled. */
  userExcludeRegexps?: readonly RegExp[];
  /** Large files permanently skipped by the watch 3-strikes policy (#1786). */
  skipLargeFilePaths?: ReadonlySet<string>;
  /** Preserve the configured secure-store write policy when loading the key. */
  secureStoreEncryptOnWrite?: boolean;
} & { impressionsRotateBytes: number; impressionsRotateKeep: number }): Promise<OfflineSyncRunResult> {
  fs.mkdirSync(options.memoryDir, { recursive: true });
  let activeStatePath = options.statePath;
  let priorState = await readOfflineSyncState(activeStatePath);
  let syncNamespace = options.namespace ?? priorState?.namespace;
  let namespaceProbe: Awaited<ReturnType<typeof fetchOfflineSnapshot>> | null = null;
  if (syncNamespace === undefined) {
    namespaceProbe = await fetchOfflineSnapshot({
      remoteUrl: options.remoteUrl,
      token: options.token,
      namespace: options.namespace,
      includeTranscripts: options.includeTranscripts,
      includeContent: false,
    });
    syncNamespace = resolvedOfflineSnapshotNamespace(namespaceProbe, options.namespace);
  }
  if (!priorState && !options.statePathExplicit && syncNamespace !== undefined) {
    const resolvedState = await readFirstOfflineSyncState(offlineStatePathsForNamespace({
      memoryDir: options.memoryDir,
      remoteUrl: options.remoteUrl,
      requestedNamespace: options.namespace,
      resolvedNamespace: syncNamespace,
    }));
    if (resolvedState) {
      activeStatePath = resolvedState.statePath;
      priorState = resolvedState.state;
    }
  }
  if (priorState) {
    assertOfflineStateMatches({
      state: priorState,
      remoteUrl: options.remoteUrl,
      namespace: syncNamespace,
      includeTranscripts: options.includeTranscripts,
      statePath: activeStatePath,
    });
  }
  const baseFiles = priorState?.baseFiles ?? [];
  const baseCapturedAt = priorState ? new Date(priorState.lastSyncedAt) : undefined;
  const offlineStorage = await createConfiguredOfflineStorage(
    options.memoryDir,
    options.secureStoreEncryptOnWrite,
  );
  const storageIo = await createOfflineStorageIo(options.memoryDir, offlineStorage);
  const syncBaseFiles = await filterOfflineSyncBaseFiles(options.memoryDir, baseFiles, storageIo.excludeFile);
  const localSourceId = localOfflineSourceId(options.memoryDir);
  await drainOfflineSyncImpressions(options.memoryDir, options);
  await drainPendingLifecycleForOfflineSync(
    options.memoryDir,
    async (ledgerPath) =>
      (await createOfflineStorageForPath(
        options.memoryDir,
        ledgerPath,
        offlineStorage,
        options.secureStoreEncryptOnWrite ?? true,
      )).drainPendingMemoryLifecycleEventsForSyncAt(ledgerPath),
  );
  const currentSnapshotForPush = await buildOfflineSyncSnapshotFromBase({
    root: options.memoryDir,
    sourceId: localSourceId,
    baseFiles: syncBaseFiles,
    baseCapturedAt,
    includeContent: false,
    includeTranscripts: options.includeTranscripts,
    readFile: storageIo.readFile,
    readFileDigest: storageIo.readFileDigest,
    excludeFile: storageIo.excludeFile,
    userExcludeRegexps: options.userExcludeRegexps,
  });
  const pendingSummary = summarizeOfflineSyncPendingFiles({
    baseFiles: syncBaseFiles,
    currentFiles: currentSnapshotForPush.files,
    includeTranscripts: options.includeTranscripts,
    userExcludeRegexps: options.userExcludeRegexps,
  });
  const baseByPath = offlineFileStateMap(syncBaseFiles);
  let directPushAppliedUpserts = 0;
  let directPushSkipped = 0;
  let directPushNamespace: string | undefined;
  const directPushConflicts: Array<{ path: string; reason: string; conflictPath?: string }> = [];
  const directPushedPaths = new Set<string>();
  const directPushDeferredPaths = new Set<string>();
  const directPushFailures: Array<{ path: string; error: string }> = [];
  for (const file of offlineDirectPushFiles({
    currentFiles: currentSnapshotForPush.files,
    baseFiles: syncBaseFiles,
  })) {
    if (options.skipLargeFilePaths?.has(file.path)) {
      // 3-strikes policy (#1786): the watch loop already logged a single
      // warning when this path was retired; stay silent on later passes.
      continue;
    }
    let result: OfflineSyncApplyFileContentChunkResult & { namespace?: string };
    try {
      result = await pushOfflineFileContent({
        remoteUrl: options.remoteUrl,
        token: options.token,
        namespace: syncNamespace,
        includeTranscripts: options.includeTranscripts,
        memoryDir: options.memoryDir,
        sourceId: localSourceId,
        file,
        baseSha256: baseByPath.get(file.path)?.sha256,
        readFile: storageIo.readFile,
        readFileChunks: storageIo.readFileChunks,
      });
    } catch (error) {
      if (isOfflineLocalFileChangedError(error)) {
        directPushDeferredPaths.add(file.path);
        continue;
      }
      directPushFailures.push({
        path: file.path,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    directPushNamespace = result.namespace ?? directPushNamespace;
    directPushedPaths.add(file.path);
    if (result.conflict) {
      directPushConflicts.push({
        path: result.conflict.path,
        reason: result.conflict.reason,
        ...(result.conflict.conflictPath ? { conflictPath: result.conflict.conflictPath } : {}),
      });
    } else {
      if (result.applied) directPushAppliedUpserts += 1;
      if (result.skipped) directPushSkipped += 1;
    }
  }
  let changeset: Awaited<ReturnType<typeof buildOfflineSyncChangeset>> = {
    format: "remnic.offline-sync.changeset.v1",
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    sourceId: localSourceId,
    includeTranscripts: options.includeTranscripts,
    changes: [],
  };
  let pushed: Awaited<ReturnType<typeof pushOfflineChanges>> | null = null;
  const buildPushedSummary = (
    pushedInline: Awaited<ReturnType<typeof pushOfflineChanges>> | null,
  ): Awaited<ReturnType<typeof pushOfflineChanges>> | null => (
    directPushedPaths.size > 0 || pushedInline
      ? {
          namespace: pushedInline?.namespace ?? directPushNamespace ?? syncNamespace ?? "",
          appliedUpserts: (pushedInline?.appliedUpserts ?? 0) + directPushAppliedUpserts,
          appliedDeletes: pushedInline?.appliedDeletes ?? 0,
          skipped: (pushedInline?.skipped ?? 0) + directPushSkipped,
          conflicts: [...directPushConflicts, ...(pushedInline?.conflicts ?? [])],
        }
      : null
  );
  const mergeInlinePushSummary = (
    prior: Awaited<ReturnType<typeof pushOfflineChanges>> | null,
    result: Awaited<ReturnType<typeof postOfflineChangesBatch>>,
  ): Awaited<ReturnType<typeof pushOfflineChanges>> => ({
    namespace: result.namespace || prior?.namespace || syncNamespace || "",
    appliedUpserts: (prior?.appliedUpserts ?? 0) + result.appliedUpserts,
    appliedDeletes: (prior?.appliedDeletes ?? 0) + result.appliedDeletes,
    skipped: (prior?.skipped ?? 0) + result.skipped,
    conflicts: [...(prior?.conflicts ?? []), ...result.conflicts],
  });
  pushed = buildPushedSummary(null);
  const stateWritePathsFor = (resolvedNamespace: string | undefined): string[] => offlineStatePathsForNamespace({
    memoryDir: options.memoryDir,
    remoteUrl: options.remoteUrl,
    requestedNamespace: options.namespace,
    resolvedNamespace,
    explicitStatePath: options.statePathExplicit ? activeStatePath : undefined,
  });
  const writePartialPushState = async (
    error: unknown,
    partial?: {
      hydratedFiles?: readonly OfflineSyncFileState[];
      remoteDeferredPaths?: readonly string[];
      resolvedNamespace?: string;
      remoteFileCount?: number | null;
    },
    checkpointChangeset = changeset,
  ): Promise<OfflineSyncRunResult> => {
    const resolvedNamespace = partial?.resolvedNamespace ??
      resolvedOfflineSnapshotNamespace({ namespace: pushed?.namespace ?? "" }, syncNamespace);
    const stateWritePaths = stateWritePathsFor(resolvedNamespace);
    const nextBaseFiles = advanceOfflineBaseFilesForSuccessfulPush({
      baseFiles: syncBaseFiles,
      currentFiles: currentSnapshotForPush.files,
      directPushedPaths: [...directPushedPaths],
      hydratedFiles: partial?.hydratedFiles,
      changeset: checkpointChangeset,
      conflicts: pushed?.conflicts ?? directPushConflicts,
    });
    const state: OfflineSyncState = {
      version: 1,
      remoteId: options.remoteUrl,
      ...(resolvedNamespace ? { namespace: resolvedNamespace } : {}),
      includeTranscripts: options.includeTranscripts,
      // Partial checkpoints do not recapture conflicted/deferred paths, so keep
      // the original capture time for safe fast-base reuse on the next run.
      lastSyncedAt: priorState?.lastSyncedAt ?? new Date().toISOString(),
      baseFiles: nextBaseFiles,
    };
    for (const statePath of stateWritePaths) {
      await writeOfflineSyncState(statePath, state);
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      statePath: stateWritePaths[0] ?? activeStatePath,
      namespace: resolvedNamespace,
      prepared: priorState === null,
      pushed,
      pull: null,
      pullError: message,
      partial: true,
      pendingSummary,
      remoteFileCount: partial?.remoteFileCount ?? null,
      largeFilePushFailures: [...directPushFailures],
      deferred: {
        localChangedDuringPush: [...directPushDeferredPaths].sort(),
        remoteChangedDuringHydrate: [...(partial?.remoteDeferredPaths ?? [])].sort(),
        total: directPushDeferredPaths.size + (partial?.remoteDeferredPaths?.length ?? 0),
      },
    };
  };
  if (directPushFailures.length > 0) {
    const error = new OfflineLargeFilePushError(directPushFailures);
    if (pushed) return writePartialPushState(error);
    throw error;
  }
  let currentSnapshotForChangeset = directPushedPaths.size > 0
    ? await buildOfflineSyncSnapshotFromBase({
        root: options.memoryDir,
        sourceId: localSourceId,
        baseFiles: syncBaseFiles,
        baseCapturedAt,
        includeContent: false,
        includeTranscripts: options.includeTranscripts,
        readFile: storageIo.readFile,
        readFileDigest: storageIo.readFileDigest,
        excludeFile: storageIo.excludeFile,
        userExcludeRegexps: options.userExcludeRegexps,
      })
    : currentSnapshotForPush;
  let changesetRetryCount = 0;
  for (;;) {
    try {
      changeset = await buildOfflineSyncChangesetFromSnapshot({
        root: options.memoryDir,
        sourceId: localSourceId,
        currentFiles: currentSnapshotForChangeset.files,
        baseFiles: syncBaseFiles,
        // 3-strikes skipped large files must be excluded here too — the
        // direct-push loop skips them, but without this line the changeset
        // path would still try to upsert them inline (Cursor review, PR
        // #1793, High severity).
        excludePaths: [
          ...directPushedPaths,
          ...directPushDeferredPaths,
          ...(options.skipLargeFilePaths ?? []),
        ],
        includeTranscripts: options.includeTranscripts,
        readFile: storageIo.readFile,
        userExcludeRegexps: options.userExcludeRegexps,
      });
      break;
    } catch (error) {
      const changedPath = offlineChangesetFileChangedPath(error);
      if (!changedPath) {
        if (pushed) return writePartialPushState(error);
        throw error;
      }
      if (directPushDeferredPaths.has(changedPath)) {
        const stalledError = new Error(`offline sync changeset retry stalled on already-deferred path: ${changedPath}`);
        if (pushed) return writePartialPushState(stalledError);
        throw stalledError;
      }
      if (changesetRetryCount >= OFFLINE_SYNC_CHANGESET_RETRY_MAX) {
        const retryError = new Error(
          `offline sync changeset retry limit exceeded after ${OFFLINE_SYNC_CHANGESET_RETRY_MAX} volatile files; last changed path: ${changedPath}`,
        );
        if (pushed) return writePartialPushState(retryError);
        throw retryError;
      }
      changesetRetryCount += 1;
      directPushDeferredPaths.add(changedPath);
      currentSnapshotForChangeset = await buildOfflineSyncSnapshotFromBase({
        root: options.memoryDir,
        sourceId: localSourceId,
        baseFiles: syncBaseFiles,
        baseCapturedAt,
        includeContent: false,
        includeTranscripts: options.includeTranscripts,
        readFile: storageIo.readFile,
        readFileDigest: storageIo.readFileDigest,
        excludeFile: storageIo.excludeFile,
        userExcludeRegexps: options.userExcludeRegexps,
      });
    }
  }
  const inlineAppliedChanges: typeof changeset.changes = [];
  let pushedInlineProgress: Awaited<ReturnType<typeof pushOfflineChanges>> | null = null;
  let pushedInline: Awaited<ReturnType<typeof pushOfflineChanges>> | null = null;
  try {
    pushedInline = changeset.changes.length > 0
      ? await pushOfflineChanges({
          remoteUrl: options.remoteUrl,
          token: options.token,
          namespace: syncNamespace,
          changeset,
          onBatchApplied: (batch) => {
            inlineAppliedChanges.push(...batch.changeset.changes);
            pushedInlineProgress = mergeInlinePushSummary(pushedInlineProgress, batch.result);
            pushed = buildPushedSummary(pushedInlineProgress);
          },
        })
      : null;
  } catch (error) {
    if (pushed || inlineAppliedChanges.length > 0) {
      return writePartialPushState(error, undefined, {
        ...changeset,
        changes: inlineAppliedChanges,
      });
    }
    throw error;
  }
  pushed = buildPushedSummary(pushedInline);
  let remoteSnapshotMetadata: Awaited<ReturnType<typeof fetchOfflineSnapshot>>;
  try {
    remoteSnapshotMetadata = await fetchOfflineSnapshot({
      remoteUrl: options.remoteUrl,
      token: options.token,
      namespace: syncNamespace,
      includeTranscripts: options.includeTranscripts,
      includeContent: false,
      baseFiles: syncBaseFiles,
      baseCapturedAt,
    });
  } catch (error) {
    if (pushed) return writePartialPushState(error);
    throw error;
  }
  let currentSnapshot: typeof currentSnapshotForPush;
  try {
    currentSnapshot = await buildOfflineSyncSnapshotFromBase({
      root: options.memoryDir,
      sourceId: localSourceId,
      baseFiles: syncBaseFiles,
      baseCapturedAt,
      includeContent: false,
      includeTranscripts: options.includeTranscripts,
      readFile: storageIo.readFile,
      readFileDigest: storageIo.readFileDigest,
      excludeFile: storageIo.excludeFile,
    });
  } catch (error) {
    if (pushed) return writePartialPushState(error);
    throw error;
  }
  let directHydration: Awaited<ReturnType<typeof directHydrateLargeOfflineFiles>>;
  const directHydrationProgress = {
    hydratedPaths: new Set<string>(),
    deferredPaths: new Set<string>(),
  };
  try {
    directHydration = await directHydrateLargeOfflineFiles({
      remoteUrl: options.remoteUrl,
      token: options.token,
      namespace: syncNamespace,
      includeTranscripts: options.includeTranscripts,
      snapshot: remoteSnapshotMetadata,
      baseFiles: syncBaseFiles,
      currentFiles: currentSnapshot.files,
      memoryDir: options.memoryDir,
      readFile: storageIo.readFile,
      readFileDigest: storageIo.readFileDigest,
      writeFile: storageIo.writeFile,
      writeStagingFile: storageIo.writeStagingFile,
      writeFileChunks: storageIo.writeFileChunks,
      hydrationProgress: directHydrationProgress,
  });
  } catch (error) {
    const partial = offlinePartialHydrationForPaths({
      files: remoteSnapshotMetadata.files,
      hydratedPaths: directHydrationProgress.hydratedPaths,
      deferredPaths: directHydrationProgress.deferredPaths,
    });
    if (pushed || partial.hydratedFiles.length > 0) {
      return writePartialPushState(error, {
        ...partial,
        resolvedNamespace: resolvedOfflineSnapshotNamespace(remoteSnapshotMetadata, syncNamespace),
        remoteFileCount: remoteSnapshotMetadata.files.length,
      });
    }
    throw error;
  }
  const directHydratedPaths = directHydration.hydratedPaths;
  const remoteDeferredPaths = directHydration.deferredPaths;
  const partialHydration = offlinePartialHydrationForPaths({
    files: remoteSnapshotMetadata.files,
    hydratedPaths: directHydratedPaths,
    deferredPaths: remoteDeferredPaths,
  });
  const partialHydrationWithContext = {
    ...partialHydration,
    resolvedNamespace: resolvedOfflineSnapshotNamespace(remoteSnapshotMetadata, syncNamespace),
    remoteFileCount: remoteSnapshotMetadata.files.length,
  };
  // Apply-side local view (#1793 review, High): must see node-local state
  // (state/lcm.sqlite etc.) or incoming upserts misclassify as
  // local_deleted_remote_modified. Never reuse the push-filtered snapshot
  // for apply.
  const buildCurrentSnapshotForApply = async (): Promise<typeof currentSnapshot> => buildOfflineSyncSnapshotFromBase({
    root: options.memoryDir,
    sourceId: localSourceId,
    baseFiles,
    baseCapturedAt,
    includeContent: false,
    includeTranscripts: options.includeTranscripts,
    readFile: storageIo.readFile,
    readFileDigest: storageIo.readFileDigest,
    excludeNodeLocalState: false,
  });
  const applyCurrentSnapshot = await buildCurrentSnapshotForApply();
  let remoteSnapshot: Awaited<ReturnType<typeof hydrateOfflineSnapshotContent>>;
  try {
    remoteSnapshot = await hydrateOfflineSnapshotContent({
      remoteUrl: options.remoteUrl,
      token: options.token,
      namespace: syncNamespace,
      includeTranscripts: options.includeTranscripts,
      snapshot: remoteSnapshotMetadata,
      baseFiles: syncBaseFiles,
      currentFiles: applyCurrentSnapshot.files,
      deferredPaths: [...remoteDeferredPaths],
      missingContentDeferredPaths: remoteDeferredPaths,
    });
  } catch (error) {
    if (pushed || partialHydration.hydratedFiles.length > 0) {
      return writePartialPushState(error, partialHydrationWithContext);
    }
    throw error;
  }
  const resolvedNamespace = resolvedOfflineSnapshotNamespace(remoteSnapshot, syncNamespace);
  let pull: OfflineSyncPullResult;
  try {
    const latestApplySnapshot = await buildCurrentSnapshotForApply();
    pull = await applyOfflineSyncSnapshot({
      root: options.memoryDir,
      snapshot: remoteSnapshot,
      baseFiles: syncBaseFiles,
      currentFiles: latestApplySnapshot.files,
      deferredPaths: [...remoteDeferredPaths],
      allowMissingConflictContent: true,
      readFile: storageIo.readFile,
      readFileDigest: storageIo.readFileDigest,
      writeFile: storageIo.writeFile,
      deleteFile: storageIo.deleteFile,
      recordDeletionRevision: storageIo.recordDeletionRevision,
    });
  } catch (error) {
    if (!isMissingOfflineContentError(error)) {
      if (pushed || partialHydration.hydratedFiles.length > 0) {
        return writePartialPushState(error, {
          ...partialHydrationWithContext,
          resolvedNamespace,
        });
      }
      throw error;
    }
    let retrySnapshot: Awaited<ReturnType<typeof hydrateOfflineSnapshotContent>>;
    try {
      retrySnapshot = await hydrateOfflineSnapshotContent({
        remoteUrl: options.remoteUrl,
        token: options.token,
        namespace: syncNamespace,
        includeTranscripts: options.includeTranscripts,
        snapshot: remoteSnapshotMetadata,
        baseFiles: syncBaseFiles,
        currentFiles: applyCurrentSnapshot.files,
        deferredPaths: [...remoteDeferredPaths],
        missingContentDeferredPaths: remoteDeferredPaths,
      });
    } catch (retryError) {
      if (pushed || partialHydration.hydratedFiles.length > 0) {
        return writePartialPushState(retryError, {
          ...partialHydrationWithContext,
          resolvedNamespace,
        });
      }
      throw retryError;
    }
    try {
      const latestRetryApplySnapshot = await buildCurrentSnapshotForApply();
      pull = await applyOfflineSyncSnapshot({
        root: options.memoryDir,
        snapshot: retrySnapshot,
        baseFiles: syncBaseFiles,
        currentFiles: latestRetryApplySnapshot.files,
        deferredPaths: [...remoteDeferredPaths],
        allowMissingConflictContent: true,
        readFile: storageIo.readFile,
        readFileDigest: storageIo.readFileDigest,
        writeFile: storageIo.writeFile,
        deleteFile: storageIo.deleteFile,
        recordDeletionRevision: storageIo.recordDeletionRevision,
      });
    } catch (retryApplyError) {
      if (pushed || partialHydration.hydratedFiles.length > 0) {
        return writePartialPushState(retryApplyError, {
          ...partialHydrationWithContext,
          resolvedNamespace,
        });
      }
      throw retryApplyError;
    }
  }
  const state = offlineSyncStateFromSnapshot({
    remoteId: options.remoteUrl,
    namespace: resolvedNamespace,
    snapshot: remoteSnapshot,
    baseFiles: pull.nextBaseFiles,
  });
  const stateWritePaths = stateWritePathsFor(resolvedNamespace);
  for (const statePath of stateWritePaths) {
    await writeOfflineSyncState(statePath, state);
  }
  return {
    statePath: stateWritePaths[0] ?? activeStatePath,
    namespace: resolvedNamespace,
    prepared: priorState === null,
    pushed,
    pull,
    partial: false,
    pendingSummary,
    remoteFileCount: remoteSnapshot.files.length,
    largeFilePushFailures: [...directPushFailures],
    deferred: {
      localChangedDuringPush: [...directPushDeferredPaths].sort(),
      remoteChangedDuringHydrate: [...remoteDeferredPaths].sort(),
      total: directPushDeferredPaths.size + remoteDeferredPaths.size,
    },
  };
}

function sumOfflineFileBytes(files: readonly OfflineSyncFileState[]): number {
  return files.reduce((total, file) => total + file.bytes, 0);
}

function offlineStateJsonSummary(state: OfflineSyncState | null): Record<string, unknown> | null {
  if (!state) return null;
  return {
    remoteId: state.remoteId,
    namespace: state.namespace ?? null,
    includeTranscripts: state.includeTranscripts,
    lastSyncedAt: state.lastSyncedAt,
    baseFileCount: state.baseFiles.length,
    baseBytes: sumOfflineFileBytes(state.baseFiles),
  };
}

function offlinePullJsonSummary(
  pull: Awaited<ReturnType<typeof applyOfflineSyncSnapshot>>,
): Record<string, unknown> {
  return {
    upserted: pull.upserted,
    deleted: pull.deleted,
    skipped: pull.skipped,
    pendingLocal: pull.pendingLocal,
    conflicts: pull.conflicts,
    nextBaseFileCount: pull.nextBaseFiles.length,
    nextBaseBytes: sumOfflineFileBytes(pull.nextBaseFiles),
  };
}

function offlineSyncResultJsonSummary(
  result: Awaited<ReturnType<typeof runOfflineSyncOnce>>,
): Record<string, unknown> {
  return {
    statePath: result.statePath,
    namespace: result.namespace ?? null,
    prepared: result.prepared,
    partial: result.partial,
    pushed: result.pushed,
    pull: result.pull ? offlinePullJsonSummary(result.pull) : null,
    pullError: result.pullError ?? null,
    pendingSummary: result.pendingSummary,
    remoteFileCount: result.remoteFileCount,
    deferred: result.deferred,
  };
}

function assertOfflineStateMatches(options: {
  state: OfflineSyncState;
  remoteUrl: string;
  namespace?: string;
  includeTranscripts: boolean;
  statePath: string;
}): void {
  if (options.state.remoteId !== options.remoteUrl) {
    throw new Error(
      `offline state ${options.statePath} belongs to ${options.state.remoteId}; run prepare with a fresh state file before syncing ${options.remoteUrl}`,
    );
  }
  if ((options.state.namespace ?? undefined) !== (options.namespace ?? undefined)) {
    throw new Error(
      `offline state ${options.statePath} belongs to namespace ${options.state.namespace ?? "(default)"}; run prepare with a fresh state file before syncing namespace ${options.namespace ?? "(default)"}`,
    );
  }
  if (options.state.includeTranscripts !== options.includeTranscripts) {
    throw new Error(
      `offline state ${options.statePath} was prepared with transcripts ${options.state.includeTranscripts ? "included" : "excluded"}; run prepare with a fresh state file before syncing with transcripts ${options.includeTranscripts ? "included" : "excluded"}`,
    );
  }
}

/**
 * Number of consecutive large-file push failures after which the watch loop
 * permanently skips a path for the process lifetime (#1786). Prevents a
 * single unpushable file (e.g. a live SQLite DB) from putting the watcher
 * into an endless retry loop that hammers the receiving daemon.
 */
export const OFFLINE_LARGE_FILE_SKIP_AFTER_FAILURES = 3;

/**
 * Pure helper for the watch 3-strikes policy (#1786): given the previous
 * per-path consecutive-failure counts and this run's failures, return the
 * updated counts plus paths that just crossed the skip threshold. Counters
 * reset for any path that did not fail this run.
 */
export function advanceOfflineLargeFileFailureCounts(options: {
  counts: ReadonlyMap<string, number>;
  failures: readonly { path: string }[];
  threshold?: number;
}): { counts: Map<string, number>; newlySkipped: string[] } {
  const threshold = options.threshold ?? OFFLINE_LARGE_FILE_SKIP_AFTER_FAILURES;
  const next = new Map<string, number>();
  const newlySkipped: string[] = [];
  for (const failure of options.failures) {
    const count = (options.counts.get(failure.path) ?? 0) + 1;
    next.set(failure.path, count);
    if (count >= threshold) newlySkipped.push(failure.path);
  }
  return { counts: next, newlySkipped };
}

/**
 * Merge repeatable `--exclude <glob>` flags with the `offlineSyncExcludes`
 * config key (#1786) and compile them. Both sources are additive to the
 * built-in node-local state excludes applied inside offline-sync.ts.
 * Invalid globs throw with a per-entry message instead of being ignored.
 */
function resolveOfflineSyncUserExcludes(
  rest: string[],
  config: ReturnType<typeof parseConfig>,
): RegExp[] {
  const globs: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] !== "--exclude") continue;
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--") || value.trim().length === 0) {
      throw new Error("--exclude requires a glob argument");
    }
    globs.push(value.trim());
    i += 1;
  }
  const configured = config.offlineSyncExcludes;
  if (configured !== undefined && configured !== null) {
    if (!Array.isArray(configured)) {
      throw new Error("offlineSyncExcludes config must be an array of non-empty glob strings");
    }
    for (const entry of configured) {
      if (typeof entry !== "string" || entry.trim().length === 0) {
        throw new Error("offlineSyncExcludes config must contain only non-empty glob strings");
      }
      globs.push(entry.trim());
    }
  }
  return compileOfflineSyncExcludeGlobs(globs);
}

async function cmdOffline(action: string, rest: string[], json: boolean): Promise<void> {
  if (action === "help" || action === "--help" || action === "-h" || rest.includes("--help") || rest.includes("-h")) {
    console.log(`Usage: remnic offline <prepare|sync|status|watch> [options]

Options:
  --remote-url <url>       Remote Remnic server URL, e.g. http://home:4242 (--remote alias accepted)
  --token <token>          Bearer token for the remote server
  --namespace <name>       Namespace to sync
  --memory-dir <dir>       Local memory dir (defaults to resolved memoryDir)
  --state <path>           Override offline sync state file
  --no-transcripts         Exclude transcripts/ from the offline cache
  --interval-ms <ms>       Watch interval (default 60000)
  --exclude <glob>         Extra push-side exclude (repeatable; additive to the
                           built-in node-local state excludes and to the
                           offlineSyncExcludes config key)
  --json                   JSON output

Environment fallbacks:
  REMNIC_OFFLINE_REMOTE_URL, REMNIC_OFFLINE_TOKEN, REMNIC_AUTH_TOKEN`);
    return;
  }

  const memoryDir = path.resolve(expandTilde(resolveRequiredValueFlag(rest, "--memory-dir") ?? resolveMemoryDir()));
  const namespace = resolveRequiredValueFlag(rest, "--namespace");
  const includeTranscripts = !hasFlag(rest, "--no-transcripts");
  const stateOverride = resolveRequiredValueFlag(rest, "--state");
  const statePathExplicit = stateOverride !== undefined;
  const configPath = resolveConfigPath();
  let config: ReturnType<typeof parseConfig>;
  try {
    const rawConfig = fs.existsSync(configPath)
      ? JSON.parse(fs.readFileSync(configPath, "utf8"))
      : {};
    config = parseConfigQuietly(pickOfflineConfigRecord(rawConfig));
  } catch {
    throw new Error(
      "offline sync: failed to load the Remnic config — run `remnic doctor` and check the config file for errors",
    );
  }
  const userExcludeRegexps = resolveOfflineSyncUserExcludes(rest, config);
  const impressionRotation = resolveOfflineImpressionRotation(configPath);
  const needsRemote = action === "prepare" || action === "sync" || action === "watch";
  const remoteUrl = needsRemote
    ? resolveOfflineRemoteUrl(rest)
    : resolveOptionalOfflineRemoteUrl(rest);
  const token = needsRemote ? resolveOfflineToken(rest) : undefined;
  const statePath = statePathExplicit
    ? path.resolve(expandTilde(stateOverride))
    : remoteUrl !== undefined
      ? defaultOfflineSyncStatePath(memoryDir, remoteUrl, namespace)
      : undefined;

  if (action === "prepare") {
    if (!remoteUrl || !token || !statePath) throw new Error("offline prepare requires remote URL and token");
    fs.mkdirSync(memoryDir, { recursive: true });
    const remoteSnapshot = await fetchOfflineSnapshot({
      remoteUrl,
      token,
      namespace,
      includeTranscripts,
    });
    const resolvedNamespace = resolvedOfflineSnapshotNamespace(remoteSnapshot, namespace);
    const stateWritePaths = offlineStatePathsForNamespace({
      memoryDir,
      remoteUrl,
      requestedNamespace: namespace,
      resolvedNamespace,
      explicitStatePath: statePathExplicit ? statePath : undefined,
    });
    const activeStatePath = stateWritePaths[0] ?? statePath;
    const existingState = await readFirstOfflineSyncState(stateWritePaths);
    if (existingState) {
      assertOfflineStateMatches({
        state: existingState.state,
        remoteUrl,
        namespace: resolvedNamespace,
        includeTranscripts,
        statePath: existingState.statePath,
      });
    }
    const storageIo = await createOfflineStorageIo(
      memoryDir,
      await createConfiguredOfflineStorage(memoryDir, config.secureStoreEncryptOnWrite),
    );
    const pull = await applyOfflineSyncSnapshot({
      root: memoryDir,
      snapshot: remoteSnapshot,
      baseFiles: existingState?.state.baseFiles ?? [],
      readFile: storageIo.readFile,
      readFileDigest: storageIo.readFileDigest,
      writeFile: storageIo.writeFile,
      deleteFile: storageIo.deleteFile,
      recordDeletionRevision: storageIo.recordDeletionRevision,
    });
    const state = offlineSyncStateFromSnapshot({
      remoteId: remoteUrl,
      namespace: resolvedNamespace,
      snapshot: remoteSnapshot,
      baseFiles: pull.nextBaseFiles,
    });
    for (const pathToWrite of stateWritePaths) {
      await writeOfflineSyncState(pathToWrite, state);
    }
    if (json) {
      console.log(JSON.stringify({
        statePath: activeStatePath,
        namespace: resolvedNamespace,
        remoteFiles: remoteSnapshot.files.length,
        pull: offlinePullJsonSummary(pull),
      }, null, 2));
    } else {
      console.log(`Offline cache prepared: ${memoryDir}`);
      console.log(`Namespace: ${resolvedNamespace ?? "(default)"}`);
      console.log(`Remote files: ${remoteSnapshot.files.length}`);
      console.log(`Pulled: ${pull.upserted} upserted, ${pull.deleted} deleted, ${pull.conflicts.length} conflicts`);
      console.log(`State: ${activeStatePath}`);
    }
    return;
  }

  if (action === "sync") {
    if (!remoteUrl || !token || !statePath) throw new Error("offline sync requires remote URL and token");
    const result = await runOfflineSyncOnce({
      memoryDir,
      remoteUrl,
      token,
      namespace,
      includeTranscripts,
      statePath,
      statePathExplicit,
      userExcludeRegexps,
      secureStoreEncryptOnWrite: config.secureStoreEncryptOnWrite,
      ...impressionRotation,
    });
    if (json) {
      console.log(JSON.stringify(offlineSyncResultJsonSummary(result), null, 2));
    } else {
      console.log(`Offline sync complete${result.prepared ? " (initialized state)" : ""}.`);
      console.log(`Pushed: ${result.pushed ? `${result.pushed.appliedUpserts} upserts, ${result.pushed.appliedDeletes} deletes, ${result.pushed.conflicts.length} conflicts` : "nothing pending"}`);
      if (result.pull) {
        console.log(`Pulled: ${result.pull.upserted} upserts, ${result.pull.deleted} deletes, ${result.pull.conflicts.length} conflicts`);
      } else {
        console.log(`Pulled: deferred (${result.pullError ?? "pull unavailable"})`);
      }
      console.log(`Pending local before push: ${result.pendingSummary.total}`);
      if (result.deferred.total > 0) {
        console.log(`Deferred volatile files: ${result.deferred.total}`);
      }
      console.log(`Namespace: ${result.namespace ?? "(default)"}`);
      console.log(`State: ${result.statePath}`);
    }
    return;
  }

  if (action === "status") {
    fs.mkdirSync(memoryDir, { recursive: true });
    const state = statePath ? await readOfflineSyncState(statePath) : null;
    if (state && remoteUrl && statePath) {
      assertOfflineStateMatches({
        state,
        remoteUrl,
        namespace: namespace ?? state.namespace,
        includeTranscripts,
        statePath,
      });
    }
    const configuredStorage = await createConfiguredOfflineStorage(memoryDir, config.secureStoreEncryptOnWrite);
    const storageIo = await createOfflineStorageIo(memoryDir, configuredStorage);
    // Fold durable pending impression/lifecycle spills before summarizing so
    // `status` reports the same pending set a following `sync` would push
    // (#2033). runOfflineSyncOnce drains these queues before every snapshot; a
    // status that skipped them would undercount. A deferred/failed drain aborts
    // here for the same reason sync aborts — an accurate count beats a silent
    // undercount.
    await drainOfflineSyncImpressions(memoryDir, impressionRotation);
    await drainPendingLifecycleForOfflineSync(
      memoryDir,
      async (ledgerPath) =>
        (await createOfflineStorageForPath(
          memoryDir,
          ledgerPath,
          configuredStorage,
          config.secureStoreEncryptOnWrite ?? true,
        )).drainPendingMemoryLifecycleEventsForSyncAt(ledgerPath),
    );
    const summary = await summarizeOfflineSyncPendingChanges({
      root: memoryDir,
      sourceId: localOfflineSourceId(memoryDir),
      baseFiles: state?.baseFiles ?? [],
      baseCapturedAt: state ? new Date(state.lastSyncedAt) : undefined,
      includeTranscripts,
      readFile: storageIo.readFile,
      readFileDigest: storageIo.readFileDigest,
      userExcludeRegexps,
    });
    if (json) {
      console.log(JSON.stringify({
        statePath: statePath ?? null,
        state: offlineStateJsonSummary(state),
        pending: summary,
      }, null, 2));
    } else {
      console.log(`Offline state: ${state ? "ready" : "not prepared"}`);
      console.log(`State: ${statePath ?? "(not selected; pass --state or --remote-url to inspect a prepared remote state)"}`);
      if (state) console.log(`Last synced: ${state.lastSyncedAt}`);
      console.log(`Pending local changes: ${summary.total} (${summary.upserts} upserts, ${summary.deletes} deletes)`);
    }
    return;
  }

  if (action === "watch") {
    if (!remoteUrl || !token || !statePath) throw new Error("offline watch requires remote URL and token");
    const intervalMs = parseOfflineIntervalMs(rest);
    console.log(`Watching offline sync every ${intervalMs}ms. Press Ctrl+C to stop.`);
    let stopped = false;
    let cancelSleep: (() => void) | null = null;
    process.once("SIGINT", () => {
      stopped = true;
      cancelSleep?.();
      console.log("Stopping offline sync watcher.");
    });
    let largeFileFailureCounts = new Map<string, number>();
    const skippedLargeFiles = new Set<string>();
    while (!stopped) {
      try {
        const result = await runOfflineSyncOnce({
          memoryDir,
          remoteUrl,
          token,
          namespace,
          includeTranscripts,
          statePath,
          statePathExplicit,
          userExcludeRegexps,
          secureStoreEncryptOnWrite: config.secureStoreEncryptOnWrite,
          ...impressionRotation,
          skipLargeFilePaths: skippedLargeFiles,
        });
        const advanced = advanceOfflineLargeFileFailureCounts({
          counts: largeFileFailureCounts,
          failures: result.largeFilePushFailures,
        });
        largeFileFailureCounts = advanced.counts;
        for (const path of advanced.newlySkipped) {
          if (skippedLargeFiles.has(path)) continue;
          skippedLargeFiles.add(path);
          console.warn(
            `offline sync: permanently skipping ${path} after ${OFFLINE_LARGE_FILE_SKIP_AFTER_FAILURES} failed large-file pushes for this watcher process (see issue #1786; use --exclude or offlineSyncExcludes to silence permanently)`,
          );
        }
        const pulled = result.pull ? result.pull.upserted + result.pull.deleted : 0;
        const conflicts = (result.pushed?.conflicts.length ?? 0) + (result.pull?.conflicts.length ?? 0);
        console.log(
          `[${new Date().toISOString()}] sync ${result.partial ? "partial" : "ok"}: pushed=${result.pushed ? result.pushed.appliedUpserts + result.pushed.appliedDeletes : 0}, pulled=${pulled}, conflicts=${conflicts}, deferred=${result.deferred.total}${result.pullError ? `, pullError=${result.pullError}` : ""}`,
        );
      } catch (error) {
        if (error instanceof OfflineLargeFilePushError) {
          const advanced = advanceOfflineLargeFileFailureCounts({
            counts: largeFileFailureCounts,
            failures: error.failures,
          });
          largeFileFailureCounts = advanced.counts;
          for (const path of advanced.newlySkipped) {
            if (skippedLargeFiles.has(path)) continue;
            skippedLargeFiles.add(path);
            console.warn(
              `offline sync: permanently skipping ${path} after ${OFFLINE_LARGE_FILE_SKIP_AFTER_FAILURES} failed large-file pushes for this watcher process (see issue #1786; use --exclude or offlineSyncExcludes to silence permanently)`,
            );
          }
        }
        console.log(`[${new Date().toISOString()}] sync waiting: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (stopped) break;
      await waitForOfflineInterval(intervalMs, (cancel) => {
        cancelSleep = cancel;
      });
    }
    return;
  }

  console.log("Usage: remnic offline <prepare|sync|status|watch> [--remote-url <url>] [--token <token>]");
  process.exit(1);
}

function cmdDedup(json: boolean): void {
  const memoryDir = resolveMemoryDir();
  const result = findDuplicates({ memoryDir });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Scanned: ${result.scanned} memories`);
  console.log(`Found ${result.duplicates.length} duplicate pairs`);
  for (const dup of result.duplicates) {
    console.log(`  [${dup.action}] ${dup.left.content.slice(0, 60)}...`);
    console.log(`    vs: ${dup.right.content.slice(0, 60)}...`);
    console.log(`    Similarity: ${(dup.similarity * 100).toFixed(2)}%`);
  }
  console.log(`Duration: ${result.durationMs}ms`);
}

function readInstalledConnectorConfig(configPath: string | undefined, fallback: Record<string, unknown>): Record<string, unknown> {
  if (!configPath) return fallback;
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallback;
    const { token: _token, ...config } = parsed as Record<string, unknown>;
    return config;
  } catch {
    return fallback;
  }
}

function snapshotConnectorTokenEntry(connectorId: string): TokenEntry | null {
  const entry = listTokens().find((candidate) => candidate.connector === connectorId);
  return entry ? { ...entry } : null;
}

// ── M5 connectors command ────────────────────────────────────────────────────

/** `remnic quarantine list|replay` (#1888): surface ACL-rejected, dead-lettered writes; `list` is read-only, `replay` boots the access layer and re-submits each parked payload into `--namespace` with `suppressQuarantine` set (a still-unwritable target is recorded as a failure and left parked, never duplicated). */
async function cmdQuarantine(action: string, rest: string[], json: boolean): Promise<void> {
  if (action !== "list" && action !== "replay") {
    process.stderr.write(`quarantine: unknown action "${action}". Use: list|replay [--namespace <ns>] [--principal <p>] [--json].\n`);
    process.exitCode = 2;
    return;
  }
  const format: QuarantineFormat = json ? "json" : "text";
  if (action === "list") {
    const extra = rest.filter((a) => !a.startsWith("--"));
    if (extra.length > 0) {
      process.stderr.write(`quarantine list: unexpected argument(s): ${extra.join(", ")}. Use: list [--json].\n`);
      process.exitCode = 2;
      return;
    }
    try {
      // resolveMemoryDir() can throw on invalid config JSON, and list() surfaces an unreadable/symlink-invalid store: fail cleanly (exit 2, generic detail) rather than leak a raw stack.
      const store = new WriteQuarantineStore(resolveMemoryDir());
      console.log(renderQuarantineList(await store.list(), format));
    } catch {
      process.stderr.write("quarantine list: unable to inspect quarantine store\n");
      process.exitCode = 2;
    }
    return;
  }
  await runQuarantineReplay(rest, format, resolveConfigPath);
}

async function cmdConnectors(action: string, rest: string[], json: boolean): Promise<void> {
  const rawNonFlagArgs = rest.filter((a) => !a.startsWith("--"));
  const resolveConfigStrippedNonFlagArgs = (): string[] => {
    // Connector actions that resolve a connector id/name must strip split-form
    // `--config key=value` values before filtering for positionals; otherwise
    // `installExtension=false` can be mistaken for the connector name. Keep
    // this out of the marketplace path because marketplace uses
    // `--config <path>` with file-path semantics.
    let strippedRest: string[];
    try {
      strippedRest = stripConfigArgv(rest);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    return strippedRest.filter((a) => !a.startsWith("--"));
  };
  const resolveConnectorId = (usage: string): string => {
    const connectorId = resolveConfigStrippedNonFlagArgs()[0];
    if (!connectorId) {
      console.error(usage);
      process.exit(1);
    }
    return connectorId;
  };

  if (action === "list") {
    const { installed, available } = listConnectors();
    if (json) {
      console.log(JSON.stringify({ installed, available }, null, 2));
    } else {
      console.log("Available connectors:");
      for (const c of available) {
        const icon = c.installed ? "✓" : "○";
        console.log(`  ${icon} ${c.id.padEnd(22)} ${c.name} v${c.version} — ${c.description}`);
      }
    }
  } else if (action === "install") {
    const connectorId = resolveConnectorId("Usage: remnic connectors install <id>");
    let connectorConfig: Record<string, unknown>;
    try {
      connectorConfig = parseConnectorConfig(rest);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    const preInstallTokenEntry = snapshotConnectorTokenEntry(connectorId);
    const result = installConnector({
      connectorId,
      config: connectorConfig,
      force: rest.includes("--force"),
    });
    if (result.status === "error") {
      console.error(result.message);
      process.exit(1);
    }
    console.log(result.message);
    if (result.configPath) console.log(`  Config: ${result.configPath}`);
    if (result.status === "already_installed") console.log("Use --force to reinstall.");
    if (result.status === "config_required") console.log("Set config with --config <key>=<value>");
    const effectiveConnectorConfig = readInstalledConnectorConfig(result.configPath, connectorConfig);

    // Publish memory extension if the connector has a publisher and the
    // install was successful (not error/already_installed/config_required).
    const shouldPublishExtension = coerceInstallExtension(effectiveConnectorConfig.installExtension) ?? true;
    if (result.status === "installed" && shouldPublishExtension) {
      const pub = publisherForConnector(connectorId);
      if (pub) {
        try {
          const available = await pub.isHostAvailable();
          if (available) {
            const memoryDir = resolveMemoryDir();
            // Finding 2 (PR #423): pass the connector's namespace into
            // the publish context so publishers use the actual namespace
            // instead of falling back to "default".
            const connectorNamespace =
              typeof effectiveConnectorConfig.namespace === "string" && effectiveConnectorConfig.namespace.length > 0
                ? effectiveConnectorConfig.namespace
                : undefined;
            const connectorDaemonUrl =
              typeof effectiveConnectorConfig.remnicDaemonUrl === "string" && effectiveConnectorConfig.remnicDaemonUrl.trim().length > 0
                ? effectiveConnectorConfig.remnicDaemonUrl.trim()
                : undefined;
            const pubResult = await pub.publish({
              config: { memoryDir, namespace: connectorNamespace, daemonUrl: connectorDaemonUrl },
              skillsRoot: path.join(memoryDir, "skills"),
              rollbackTokenEntry: preInstallTokenEntry,
              log: { info: console.log, warn: console.warn, error: console.error },
            });
            if (pubResult.filesWritten.length > 0) {
              console.log(`  Published memory extension to ${pubResult.extensionRoot}`);
            }
          }
        } catch (err) {
          // Per CLAUDE.md #13: external service calls must not crash the
          // primary install flow. Surface a user-facing note instead.
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`  Warning: memory extension publish failed: ${msg}`);
        }
      }
    } else if (result.status === "installed" && !shouldPublishExtension) {
      console.log("  Memory extension publish skipped via installExtension=false");
    }
  } else if (action === "remove") {
    const connectorId = resolveConnectorId("Usage: remnic connectors remove <id>");
    const connectorBeforeRemoval = listConnectors().installed.find(
      (connector) => connector.connectorId === connectorId,
    );
    const savedInstallExtension = connectorBeforeRemoval
      ? coerceInstallExtension(connectorBeforeRemoval.config.installExtension)
      : undefined;
    const result = removeConnector(connectorId);
    if (result.status === "error") {
      console.error(result.message);
      process.exit(1);
    }
    console.log(result.message);
    if (result.status === "removed" && connectorId !== "codex-cli") {
      if (savedInstallExtension === false) {
        console.log("  Memory extension removal skipped via installExtension=false");
      } else {
        const pub = publisherForConnector(connectorId);
        if (pub) {
          try {
            await pub.unpublish();
            console.log("  Removed memory extension");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`  Warning: memory extension removal failed: ${msg}`);
          }
        }
      }
    } else if (result.status === "skipped" && result.reason === "config-parse-failed") {
      // A malformed codex-cli.json means we could not verify or complete removal.
      // This is not a benign no-op — the connector may still be partially installed.
      // Exit non-zero so automation does not treat a failed removal as success.
      console.error(
        `Error: removal skipped because the connector config could not be parsed. ` +
          `Fix or delete the config file at ${result.configPath} manually and retry.`,
      );
      process.exit(1);
    }
  } else if (action === "doctor") {
    const connectorId = resolveConnectorId("Usage: remnic connectors doctor <id>");
    const result = await doctorConnector(connectorId);

    // Append memory extension publisher health only for the requested
    // connector's host, not all registered publishers. This prevents
    // unrelated hosts from polluting the health status.
    const publisherChecks: Array<{ name: string; ok: boolean; detail: string }> = [];
    const targetHostId = hostIdForConnector(connectorId);
    const factory = PUBLISHERS[targetHostId];

    // Finding 1 (PR #423): skip the extension directory existence check when
    // the user explicitly opted out via installExtension=false.
    const connectorInstance = listConnectors().installed.find(
      (c) => c.connectorId === connectorId,
    );
    const savedInstallExt = connectorInstance
      ? coerceInstallExtension(connectorInstance.config.installExtension)
      : undefined;
    const extensionOptedOut = savedInstallExt === false;

    if (factory) {
      if (extensionOptedOut) {
        publisherChecks.push({
          name: `Publisher: ${targetHostId}`,
          ok: true,
          detail: "skipped (installExtension=false)",
        });
      } else {
        try {
          const pub = factory();
          const available = await pub.isHostAvailable();
          const extRoot = available ? await pub.resolveExtensionRoot() : "(host not installed)";
          const extensionExists = available && extRoot
            ? fs.existsSync(extRoot)
            : false;
          publisherChecks.push({
            name: `Publisher: ${targetHostId}`,
            ok: !available || extensionExists,
            detail: !available
              ? "host not installed (skip)"
              : extensionExists
              ? `extension at ${extRoot}`
              : `extension missing at ${extRoot} — run \`remnic connectors install ${connectorId}\``,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          publisherChecks.push({
            name: `Publisher: ${targetHostId}`,
            ok: false,
            detail: `error: ${msg}`,
          });
        }
      }
    }

    const allChecks = [...result.checks, ...publisherChecks];
    const healthy = allChecks.every((c) => c.ok);

    if (json) {
      console.log(JSON.stringify({ ...result, checks: allChecks, healthy }, null, 2));
    } else {
      for (const check of allChecks) {
        const icon = check.ok ? "✓" : "✗";
        console.log(`  ${icon} ${check.name}: ${check.detail}`);
      }
      console.log(healthy ? "\nConnector healthy" : "\nConnector has issues");
    }
  } else if (action === "marketplace") {
    const subAction = rawNonFlagArgs[0];
    // Use the original `rest` (not strippedRest) because marketplace uses
    // `--config <path>` for a file path, not `--config key=value` pairs.
    // `stripConfigArgv` would silently remove that flag, breaking config
    // overrides for marketplace subcommands.
    // Strip only the subAction token so downstream positional parsing picks
    // up the real argument (e.g. the install source or validate path).
    let subActionRemoved = false;
    const marketplaceRest = rest.filter((a) => {
      if (!subActionRemoved && a === subAction) {
        subActionRemoved = true;
        return false;
      }
      return true;
    });
    await cmdConnectorsMarketplace(subAction, marketplaceRest, json);
  } else if (action === "status") {
    // `remnic connectors status` — live-connector status (defaults to JSON).
    // Reads persisted ConnectorState files from the memory dir rather than
    // booting an orchestrator; no network calls needed.
    //
    // Dynamic imports are used for the live-connector symbols so that the
    // standalone `remnic` binary resolves them from the installed
    // `@remnic/core` at runtime rather than requiring a static tsc path
    // that traverses the workspace boundary (same pattern as cli.ts which
    // uses `await import("./connectors/live/state-store.js")`).
    const {
      listConnectorStates: listLiveConnectorStates,
      GOOGLE_DRIVE_CONNECTOR_ID: GDRIVE_ID,
      NOTION_CONNECTOR_ID: NOTION_ID,
      parseConnectorsStatusOptions: parseStatusOpts,
      renderConnectorsList: renderLiveList,
    } = await import("@remnic/core" as string);

    let formatFlag: string | undefined;
    try {
      formatFlag = resolveFlagStrict(rest, "--format");
    } catch (err) {
      process.stderr.write(
        `connectors status: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 2;
      return;
    }
    let parsed: { format: string };
    try {
      parsed = parseStatusOpts({ format: formatFlag });
    } catch (err) {
      process.stderr.write(
        `connectors status: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 2;
      return;
    }
    const memoryDir = resolveMemoryDir();
    const states = await listLiveConnectorStates(memoryDir);
    const stateMap = new Map(states.map((s: { id: string }) => [s.id, s]));
    // Reflect the parsed config's enabled flags (same source `connectors run`
    // uses) instead of hardcoding true, so disabled connectors report
    // enabled:false in status/list output (issue #2062).
    let connectorsCfg: PluginConfig["connectors"];
    const configPath = resolveConfigPath();
    try {
      const raw = fs.existsSync(configPath)
        ? JSON.parse(fs.readFileSync(configPath, "utf8"))
        : {};
      // parseConfigQuietly (not parseConfig): this branch installs no logger,
      // so parseConfig's coercion warnings would print raw config values
      // (e.g. secrets) via console.warn (#2033).
      connectorsCfg = parseConfigQuietly(raw).connectors;
    } catch {
      // Report the path, never the caught error message: parse/validation
      // errors can echo raw config values (e.g. secrets) into CLI output.
      process.stderr.write(
        `connectors status: failed to read config at ${configPath}\n`,
      );
      process.exitCode = 2;
      return;
    }
    const rows = [
      {
        id: GDRIVE_ID as string,
        displayName: "Google Drive",
        enabled: connectorsCfg.googleDrive.enabled,
        state: stateMap.get(GDRIVE_ID as string) ?? null,
      },
      {
        id: NOTION_ID as string,
        displayName: "Notion",
        enabled: connectorsCfg.notion.enabled,
        state: stateMap.get(NOTION_ID as string) ?? null,
      },
    ];
    console.log(renderLiveList(rows, parsed.format));
  } else if (action === "run") {
    // `remnic connectors run <name>` — manually trigger one incremental sync
    // pass for the named live connector.  Boots a lightweight orchestrator
    // so the ingest pipeline is available for persisting fetched docs.
    //
    // Dynamic imports are used for the live-connector and connectors-cli
    // symbols (same reasoning as the `status` branch above).
    const {
      GOOGLE_DRIVE_CONNECTOR_ID: GDRIVE_ID,
      NOTION_CONNECTOR_ID: NOTION_ID,
      createGoogleDriveConnector: makeGDriveConnector,
      validateGoogleDriveConfig: validateGDriveCfg,
      createNotionConnector: makeNotionConnector,
      validateNotionConfig: validateNotionCfg,
      readConnectorState: readLiveConnectorState,
      writeConnectorState: writeLiveConnectorState,
      parseConnectorsListOptions: parseListOpts,
      parseConnectorsRunName: parseRunName,
      renderConnectorsRunResult: renderRunResult,
      runConnectorPollOnce: pollOnce,
    } = await import("@remnic/core" as string);

    const rawName = resolveConfigStrippedNonFlagArgs()[0];
    let connectorName: string;
    try {
      connectorName = parseRunName(rawName);
    } catch (err) {
      process.stderr.write(
        `connectors run: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 2;
      return;
    }
    let formatFlag: string | undefined;
    try {
      formatFlag = resolveFlagStrict(rest, "--format");
    } catch (err) {
      process.stderr.write(
        `connectors run: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 2;
      return;
    }
    let format: string;
    try {
      format = parseListOpts({ format: formatFlag }).format;
    } catch (err) {
      process.stderr.write(
        `connectors run: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 2;
      return;
    }

    initLogger();
    const configPath = resolveConfigPath();
    const raw = fs.existsSync(configPath)
      ? JSON.parse(fs.readFileSync(configPath, "utf8"))
      : {};
    const remnicCfg = resolveRemnicConfigRecord(raw);
    const config = parseConfig(remnicCfg);
    const orchestrator = new Orchestrator(config);
    try {
    await orchestrator.initialize();
    await orchestrator.deferredReady;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg = (config as any).connectors;

    const sharedIngestFn = async (docs: Array<{ title?: string; content: string }>) => {
      const fetchedAt = new Date().toISOString();
      const turns = docs.map((doc) => ({
        role: "assistant" as const,
        content: doc.title ? `# ${doc.title}\n\n${doc.content}` : doc.content,
        timestamp: fetchedAt,
      }));
      await orchestrator.ingestBulkImportBatch(turns);
    };

    const makeWriteCursorFn =
      (id: string) =>
      async (state: {
        cursor: unknown;
        lastSyncStatus: string;
        lastSyncError?: string;
        totalDocsImported: number;
      }) => {
        await writeLiveConnectorState(config.memoryDir, id, {
          id,
          cursor: state.cursor,
          lastSyncAt: new Date().toISOString(),
          lastSyncStatus: state.lastSyncStatus,
          ...(state.lastSyncError !== undefined
            ? { lastSyncError: state.lastSyncError }
            : {}),
          totalDocsImported: state.totalDocsImported,
        });
      };

    let runResult: { docsImported: number; error?: string; stateWriteError?: string };
    if (connectorName === (GDRIVE_ID as string)) {
      if (!cfg?.googleDrive?.enabled) {
        process.stderr.write(
          `connectors run: connector "${connectorName}" is disabled. Set connectors.googleDrive.enabled=true in config.\n`,
        );
        process.exitCode = 1;
        return;
      }
      let validatedCfg;
      try {
        validatedCfg = validateGDriveCfg(cfg.googleDrive);
      } catch (err) {
        process.stderr.write(
          `connectors run: invalid config for "${connectorName}": ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
        return;
      }
      const connector = makeGDriveConnector();
      const state = await readLiveConnectorState(config.memoryDir, connectorName);
      runResult = await pollOnce({
        connectorId: connectorName,
        priorState: state,
        syncFn: (cursor: unknown) =>
          connector.syncIncremental({
            cursor,
            config: validatedCfg as unknown as Record<string, unknown>,
          }),
        ingestFn: sharedIngestFn,
        writeCursorFn: makeWriteCursorFn(connectorName),
      });
    } else if (connectorName === (NOTION_ID as string)) {
      if (!cfg?.notion?.enabled) {
        process.stderr.write(
          `connectors run: connector "${connectorName}" is disabled. Set connectors.notion.enabled=true in config.\n`,
        );
        process.exitCode = 1;
        return;
      }
      let validatedCfg;
      try {
        validatedCfg = validateNotionCfg(cfg.notion);
      } catch (err) {
        process.stderr.write(
          `connectors run: invalid config for "${connectorName}": ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
        return;
      }
      const connector = makeNotionConnector();
      const state = await readLiveConnectorState(config.memoryDir, connectorName);
      runResult = await pollOnce({
        connectorId: connectorName,
        priorState: state,
        syncFn: (cursor: unknown) =>
          connector.syncIncremental({
            cursor,
            config: validatedCfg as unknown as Record<string, unknown>,
          }),
        ingestFn: sharedIngestFn,
        writeCursorFn: makeWriteCursorFn(connectorName),
      });
    } else {
      process.stderr.write(
        `connectors run: unknown connector "${connectorName}". Known connectors: ${GDRIVE_ID as string}, ${NOTION_ID as string}.\n`,
      );
      process.exitCode = 1;
      return;
    }

    const output = renderRunResult(connectorName, runResult, format);
    if (runResult.error !== undefined || runResult.stateWriteError !== undefined) {
      process.stderr.write(output + "\n");
      process.exitCode = 1;
    } else {
      console.log(output);
    }
    } finally {
      await orchestrator.destroy();
    }
  } else {
    console.log("Usage: remnic connectors <list|install|remove|doctor|marketplace|status|run> [id]");
    process.exit(1);
  }
}

// ── Marketplace subcommand (connectors marketplace) ────────��────────────────

async function cmdConnectorsMarketplace(
  subAction: string | undefined,
  rest: string[],
  json: boolean,
): Promise<void> {
  let configPath: string;
  try {
    configPath = resolveConfigPath(resolveFlagStrict(rest, "--config"));
  } catch (err) {
    console.error(`connectors marketplace: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const rawConfig = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  // Unwrap the plugin-scoped config block (remnic or engram wrapper) so
  // parseConfig receives the correct inner object — same pattern used by
  // other CLI entrypoints (resolveMemoryDir, cmdBriefing, etc.).
  const pluginConfig = resolveRemnicConfigRecord(rawConfig);
  const config = parseConfig(pluginConfig);

  if (subAction === "generate") {
    let outputDir: string;
    try {
      outputDir = resolveFlagStrict(rest, "--output") ?? process.cwd();
    } catch (err) {
      console.error(`connectors marketplace generate: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    const manifest = generateMarketplaceManifest();
    await writeMarketplaceManifest(outputDir, manifest);
    const outPath = path.join(outputDir, "marketplace.json");
    if (json) {
      console.log(JSON.stringify({ status: "generated", path: outPath }, null, 2));
    } else {
      console.log(`Generated marketplace.json at ${outPath}`);
    }
  } else if (subAction === "validate") {
    const targetPath = rest.filter((a) => !a.startsWith("--"))[0]
      ?? path.join(process.cwd(), "marketplace.json");
    const resolved = path.resolve(targetPath);

    if (!fs.existsSync(resolved)) {
      console.error(`File not found: ${resolved}`);
      process.exit(1);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
    } catch {
      console.error(`Invalid JSON in ${resolved}`);
      process.exit(1);
    }

    const validation = checkMarketplaceManifest(parsed);
    if (json) {
      console.log(JSON.stringify(validation, null, 2));
    }
    if (validation.valid) {
      if (!json) console.log(`Valid marketplace manifest: ${resolved}`);
      // exit 0
    } else {
      if (!json) {
        console.error(`Invalid marketplace manifest: ${resolved}`);
        for (const err of validation.errors) {
          console.error(`  - ${err}`);
        }
      }
      process.exit(1);
    }
  } else if (subAction === "install") {
    const source = rest.filter((a) => !a.startsWith("--"))[0];
    if (!source) {
      console.error("Usage: remnic connectors marketplace install <source> [--type github|git|local|url]");
      process.exit(1);
    }

    // CLAUDE.md gotcha #14 & #51: reject --type without a value instead of
    // silently defaulting to "github".
    const validTypes = new Set(["github", "git", "local", "url"]);
    let typeFlag: string;
    try {
      typeFlag = resolveFlagStrict(rest, "--type") ?? "github";
    } catch {
      console.error(`--type requires a value. Must be one of: ${[...validTypes].join(", ")}`);
      process.exit(1);
    }
    if (!validTypes.has(typeFlag)) {
      console.error(`Invalid --type: "${typeFlag}". Must be one of: ${[...validTypes].join(", ")}`);
      process.exit(1);
    }

    const result = await installFromMarketplace(
      source,
      typeFlag as MarketplaceInstallType,
      config,
    );

    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(result.message);
      if (result.pluginsFound.length > 0) {
        console.log(`  Plugins: ${result.pluginsFound.join(", ")}`);
      }
    }

    if (!result.ok) process.exit(1);
  } else {
    console.log(`Usage: remnic connectors marketplace <generate|validate|install> [args]

  generate [--output <dir>]            Generate marketplace.json
  validate [path]                      Validate a marketplace.json file
  install <source> [--type <type>]     Install from marketplace source
                                       Types: github, git, local, url (default: github)`);
    process.exit(1);
  }
}

// ── M6 space command ──────────────────────────────────────────────────────────

async function cmdSpace(action: string, rest: string[], json: boolean): Promise<void> {
  const nonFlagArgs = rest.filter((a) => !a.startsWith("--"));

  if (action === "list") {
    const spaces = listSpaces();
    if (json) {
      console.log(JSON.stringify(spaces, null, 2));
    } else {
      const active = getActiveSpace();
      for (const s of spaces) {
        const icon = s.id === active.id ? "●" : "○";
        console.log(`  ${icon} ${s.name} (${s.kind}) — ${s.memoryDir}`);
      }
    }
  } else if (action === "switch") {
    const spaceId = nonFlagArgs[0];
    if (!spaceId) {
      console.error("Usage: remnic space switch <id>");
      process.exit(1);
    }
    const result = switchSpace(spaceId);
    console.log(result.message);
  } else if (action === "create") {
    // Extract --parent <id> before computing positional args
    const parentIdx = rest.indexOf("--parent");
    const parentSpaceId = parentIdx >= 0 && rest[parentIdx + 1] ? rest[parentIdx + 1] : undefined;
    // Build positional args excluding --parent and its value
    const positionals: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--parent") { i++; continue; } // skip --parent and its value
      if (rest[i].startsWith("--")) continue;
      positionals.push(rest[i]);
    }
    const name = positionals[0];
    const rawKind = positionals[1] ?? "project";
    const validKinds = ["personal", "project", "team"] as const;
    if (!validKinds.includes(rawKind as typeof validKinds[number])) {
      console.error(`Invalid kind "${rawKind}". Must be one of: ${validKinds.join(", ")}`);
      process.exit(1);
    }
    const kind = rawKind as "personal" | "project" | "team";
    if (!name) {
      console.error("Usage: remnic space create <name> [personal|project|team] [--parent <id>]");
      process.exit(1);
    }
    const space = createSpace({ name, kind, parentSpaceId });
    if (json) {
      console.log(JSON.stringify(space, null, 2));
    } else {
      console.log(`Created space "${space.name}" (${space.id})`);
      console.log(`  Kind: ${space.kind}`);
      console.log(`  Dir: ${space.memoryDir}`);
    }
  } else if (action === "delete") {
    const spaceId = nonFlagArgs[0];
    if (!spaceId) {
      console.error("Usage: remnic space delete <id>");
      process.exit(1);
    }
    deleteSpace(spaceId);
    console.log(`Deleted space "${spaceId}"`);
  } else if (action === "push") {
    const sourceId = nonFlagArgs[0];
    const targetId = nonFlagArgs[1];
    if (!sourceId || !targetId) {
      console.error("Usage: remnic space push <source> <target>");
      process.exit(1);
    }
    const result = await pushToSpace(sourceId, targetId, { force: rest.includes("--force") });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Pushed ${result.memoriesPushed} memories`);
      if (result.conflicts.length > 0) console.log(`Conflicts: ${result.conflicts.length}`);
      console.log(`Duration: ${result.durationMs}ms`);
    }
  } else if (action === "pull") {
    const sourceId = nonFlagArgs[0];
    const targetId = nonFlagArgs[1];
    if (!sourceId || !targetId) {
      console.error("Usage: remnic space pull <source> <target>");
      process.exit(1);
    }
    const result = await pullFromSpace(sourceId, targetId, { force: rest.includes("--force") });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Pulled ${result.memoriesPulled} memories`);
      if (result.conflicts.length > 0) console.log(`Conflicts: ${result.conflicts.length}`);
      console.log(`Duration: ${result.durationMs}ms`);
    }
  } else if (action === "share") {
    const spaceId = nonFlagArgs[0];
    const members = nonFlagArgs.slice(1);
    if (!spaceId || members.length === 0) {
      console.error("Usage: remnic space share <id> <member1> [member2 ...]");
      process.exit(1);
    }
    const result = shareSpace(spaceId, members);
    console.log(result.message);
  } else if (action === "promote") {
    const sourceId = nonFlagArgs[0];
    const targetId = nonFlagArgs[1];
    if (!sourceId || !targetId) {
      console.error("Usage: remnic space promote <source> <target>");
      process.exit(1);
    }
    const result = await promoteSpace(sourceId, targetId, {
      force: rest.includes("--force"),
      forceOverwrite: rest.includes("--force-overwrite"),
      allowUserSubject: rest.includes("--allow-user-subject"),
    });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Promoted ${result.memoriesPromoted} memories`);
      if (result.subjectWarnings && result.subjectWarnings.length > 0) console.log(`Subject-guard warnings: ${result.subjectWarnings.length} (see --json)`);
      if (result.conflicts.length > 0) console.log(`Conflicts: ${result.conflicts.length}`);
      console.log(`Duration: ${result.durationMs}ms`);
    }
  } else if (action === "audit") {
    const entries = getAuditLog();
    if (json) {
      console.log(JSON.stringify(entries, null, 2));
    } else {
      if (entries.length === 0) {
        console.log("No audit entries.");
      } else {
        for (const e of entries.slice(-50)) {
          console.log(`[${e.timestamp}] ${e.action} ${e.details}`);
        }
      }
    }
  } else {
    console.log("Usage: remnic space <list|switch|create|delete|push|pull|share|promote|audit>");
    process.exit(1);
  }
}

// ── Benchmark commands ─────────────────────────────────────────────────────────

async function cmdLegacyBenchmark(action: string, rest: string[], json: boolean): Promise<void> {
  initLogger();
  const configPath = resolveConfigPath();
  const raw = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  const remnicCfg = resolveRemnicConfigRecord(raw);
  const config = parseConfig(remnicCfg);
  const orchestrator = new Orchestrator(config);
  const service = new EngramAccessService(orchestrator);

  const { runBenchSuite, loadBaseline, checkRegression } = await loadBenchModule();

  const benchConfig: BenchConfig = {
    queries: rest.filter((a) => !a.startsWith("--")).length > 0
      ? rest.filter((a) => !a.startsWith("--"))
      : undefined,
    explain: rest.includes("--explain"),
    baselinePath: rest.find((a) => a.startsWith("--baseline="))?.slice("--baseline=".length),
    reportPath: rest.find((a) => a.startsWith("--report="))?.slice("--report=".length),
  };

  if (action === "run") {
    const suite = await runBenchSuite(service, benchConfig);
    if (json) {
      console.log(JSON.stringify(suite, null, 2));
    } else {
      console.log(`Benchmark suite completed in ${suite.totalDurationMs}ms`);
      for (const r of suite.results) {
        const tiers = r.tiersUsed.join(" → ");
        console.log(`  ${r.query}: ${r.latencyMs}ms (${r.resultsCount} results) [${tiers}]`);
      }
      if (suite.regressions.length > 0) {
        console.log("\nRegressions:");
        for (const reg of suite.regressions) {
          const icon = reg.passed ? "✓" : "✗";
          console.log(`  ${icon} ${reg.metric}: ${reg.currentValue}ms (baseline: ${reg.baselineValue}ms, tolerance: ${reg.tolerance}%)`);
        }
      }
    }
  } else if (action === "check") {
    const baselinePath = benchConfig.baselinePath;
    const baseline = loadBaseline(baselinePath);
    if (!baseline) {
      console.log("No baseline found. Run `remnic benchmark run` first.");
      return;
    }
    const suite = await runBenchSuite(service, benchConfig);
    const metrics: Record<string, number> = {};
    for (const r of suite.results) {
      metrics[r.query] = r.latencyMs;
    }
    const tolerance = benchConfig.regressionTolerance ?? 10;
    const result = checkRegression(metrics, baseline, tolerance);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      if (result.passed) {
        console.log("No regressions detected.");
      } else {
        console.log("Regressions detected:");
        for (const reg of result.regressions) {
          if (!reg.passed) {
            console.log(`  ✗ ${reg.metric}: ${reg.currentValue}ms vs ${reg.baselineValue}ms baseline (+${(((reg.currentValue - reg.baselineValue) / reg.baselineValue) * 100).toFixed(1)}%)`);
          }
        }
      }
    }
    if (!result.passed) {
      process.exit(1);
    }
  } else if (action === "report") {
    const reportPath = benchConfig.reportPath;
    const suite = await runBenchSuite(service, { ...benchConfig, reportPath });
    printBenchStatusLine(json, `Report saved to ${reportPath ?? "benchmarks/report.json"}`);
    if (json) {
      console.log(JSON.stringify(suite.report, null, 2));
    }
  } else {
    console.log("Usage: remnic benchmark <run|check|report> [queries...] [--explain] [--baseline=<path>] [--report=<path>]");
    process.exit(1);
  }
}

async function cmdBench(rest: string[]): Promise<void> {
  if (rest[0] === "coding") return cmdBenchCoding(rest.slice(1));
  if (rest[0] === "security") return cmdBenchSecurity(rest.slice(1));
  // Procedural ablation (#567): ad-hoc harness, not a catalogue entry.
  if (rest[0] === "procedural-ablation") {
    await cmdBenchProceduralAblation(rest.slice(1));
    return;
  }

  const benchAction = parseBenchActionArgs(rest);
  let parsed: ParsedBenchArgs;
  try {
    parsed = parseBenchArgs(rest);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  if (parsed.action === "help") {
    console.log(getBenchUsageText());
    return;
  }

  if (parsed.action === "check" || parsed.action === "report") {
    await cmdLegacyBenchmark(parsed.action, benchAction.args, parsed.json);
    return;
  }

  if (parsed.action === "compare") {
    await compareBenchPackageResults(parsed);
    return;
  }
  if (parsed.action === "attribute" || parsed.action === "drift-gen") {
    await runBenchResearchCommand(parsed);
    return;
  }

  if (parsed.action === "results") {
    await showBenchPackageResults(parsed);
    return;
  }

  if (parsed.action === "baseline") {
    await manageBenchBaselines(parsed);
    return;
  }

  if (parsed.action === "export") {
    await exportBenchPackageResult(parsed);
    return;
  }

  if (parsed.action === "judge-calibrate") {
    await calibrateBenchJudges(parsed, benchAction.args);
    return;
  }

  if (parsed.action === "datasets") {
    await manageBenchDatasets(parsed);
    return;
  }

  if (parsed.action === "runs") {
    await manageBenchRuns(parsed);
    return;
  }

  if (parsed.action === "publish") {
    await publishBenchPackageResults(parsed);
    return;
  }

  if (parsed.action === "published") {
    await runBenchPublished(parsed);
    return;
  }

  if (parsed.action === "ui") {
    await launchBenchUi(parsed.resultsDir ?? resolveBenchOutputDir());
    return;
  }

  if (parsed.action === "providers") {
    await discoverBenchProviders(parsed);
    return;
  }

  if (parsed.action === "list") {
    const catalog = await listBenchmarksFromPackage() ?? BENCHMARK_CATALOG;
    if (parsed.json) {
      console.log(JSON.stringify(catalog, null, 2));
      return;
    }

    console.log("Published benchmarks:");
    for (const entry of catalog) {
      console.log(`  ${entry.id.padEnd(14)} ${entry.category.padEnd(14)} ${entry.summary}`);
    }
    return;
  }

  if (parsed.custom) {
    if (parsed.all || parsed.benchmarks.length > 0) {
      console.error("ERROR: --custom cannot be combined with benchmark names or --all.");
      process.exit(1);
    }

    const handledByPackage = await runCustomBenchViaPackage(parsed);
    if (!handledByPackage) {
      console.error(
        "Benchmark runner not found. Expected a phase-1 @remnic/bench runtime export for custom benchmarks.",
      );
      process.exit(1);
    }
    return;
  }

  let selectedBenchmarks = parsed.all
    ? await resolveAllBenchmarks()
    : parsed.benchmarks;
  if (selectedBenchmarks.length === 0) {
    console.error(
      parsed.all
        ? "ERROR: no runnable benchmarks are available for --all in this install. Use 'remnic bench list' to inspect the catalog."
        : "ERROR: specify benchmark name(s) or --all. Use 'remnic bench list' to see available.",
    );
    process.exit(1);
  }

  const taskSelector = loadPinnedLoCoMoTaskSelector(parsed);
  const runtimeProfiles = resolveBenchRunProfiles(parsed);
  let selectedWorkItems = createBenchWorkItems(selectedBenchmarks, runtimeProfiles);

  // Validate benchmark IDs before resume/retry-failed filtering so unknown
  // names are caught early instead of being silently dropped by the filter.
  const knownBenchmarkIds = await resolveKnownBenchmarkIds();
  const unknown = selectedBenchmarks.filter((benchmarkId) => !knownBenchmarkIds.has(benchmarkId));
  if (unknown.length > 0) {
    console.error(`ERROR: unknown benchmark(s): ${unknown.join(", ")}. Use 'remnic bench list' to see available.`);
    process.exit(1);
  }

  // --resume / --retry-failed: filter against previous run status
  if (parsed.resume || parsed.retryFailed) {
    const resultsDir = parsed.resultsDir ?? resolveBenchOutputDir();
    const latestStatusPath = await findLatestBenchStatusFile(resultsDir);
    if (!latestStatusPath) {
      console.error(
        parsed.resume
          ? "ERROR: --resume requires a previous bench-status file. Run a benchmark first."
          : "ERROR: --retry-failed requires a previous bench-status file. Run a benchmark first.",
      );
      process.exit(1);
    }
    const prevStatus = await readBenchStatus(latestStatusPath);
    if (!prevStatus) {
      console.error("ERROR: could not parse previous bench-status file.");
      process.exit(1);
    }

    const completeCount = prevStatus.benchmarks.filter((b) => b.status === "complete").length;
    const failedCount = prevStatus.benchmarks.filter((b) => b.status === "failed").length;
    printBenchStatusLine(parsed.json, `Resuming from: ${path.basename(latestStatusPath)}`);
    printBenchStatusLine(parsed.json, `  Previous run: ${prevStatus.startedAt}`);
    printBenchStatusLine(parsed.json, `  Benchmarks: ${prevStatus.benchmarks.length} total, ${completeCount} complete, ${failedCount} failed`);

    const before = selectedBenchmarks.length;

    if (parsed.resume) {
      selectedWorkItems = filterBenchWorkItemsForPreviousStatus(
        selectedWorkItems,
        prevStatus.benchmarks,
        "resume",
      );
      selectedBenchmarks = [...new Set(selectedWorkItems.map((item) => item.benchmarkId))];
      printBenchStatusLine(parsed.json, `  Resuming: ${selectedBenchmarks.length} of ${before} benchmarks to re-run`);
    } else {
      selectedWorkItems = filterBenchWorkItemsForPreviousStatus(
        selectedWorkItems,
        prevStatus.benchmarks,
        "retry-failed",
      );
      selectedBenchmarks = [...new Set(selectedWorkItems.map((item) => item.benchmarkId))];
      printBenchStatusLine(parsed.json, `  Retrying: ${selectedBenchmarks.length} of ${before} selected benchmarks had failures`);
    }

    if (selectedWorkItems.length === 0) {
      if (parsed.retryFailed) {
        printBenchStatusLine(parsed.json, "Nothing to re-run — no selected benchmarks had failures.");
      } else {
        printBenchStatusLine(
          parsed.json,
          "Nothing to re-run — all selected benchmarks completed successfully in the previous run.",
        );
      }
      process.exit(0);
    }
  }

  const failures = new Set<string>();
  const benchStatusPath = createBenchStatusPath(
    parsed.resultsDir ?? resolveBenchOutputDir(),
    process.pid,
  );
  // When running a matrix (multiple profiles), create profile-specific status
  // entries so that a failed profile doesn't get overwritten by a later success.
  const statusEntryIds = [...new Set(
    selectedWorkItems.map(({ benchmarkId, runtimeProfile }) =>
      runtimeProfiles.length > 1 ? `${benchmarkId} [${runtimeProfile}]` : benchmarkId,
    ),
  )];
  try { await initBenchStatus(benchStatusPath, statusEntryIds, process.pid); } catch { /* non-fatal */ }
  const writtenPaths: string[] = [];
  const pairedAnswerReplayCache =
    selectedWorkItems.some(
      (item) => item.benchmarkId === "locomo" && item.runtimeProfile === "baseline",
    )
    && selectedWorkItems.some(
      (item) => item.benchmarkId === "locomo" && item.runtimeProfile === "real",
    )
      ? new Map<string, import("@remnic/bench").PairedAnswerReplayEntry>()
      : undefined;
  try {
    for (const { benchmarkId, runtimeProfile } of orderPairedLoCoMoWorkItems(selectedWorkItems)) {
      const statusId = runtimeProfiles.length > 1
        ? `${benchmarkId} [${runtimeProfile}]`
        : benchmarkId;
        try { await updateBenchmarkStarted(benchStatusPath, statusId); } catch { /* non-fatal */ }
        try {
          const handledByPackage = await runBenchViaPackage(
            parsed,
            benchmarkId,
            runtimeProfile,
            benchStatusPath,
            taskSelector,
            pairedAnswerReplayCache,
          );
          if (handledByPackage.ok) {
            if (handledByPackage.writtenPath) {
              writtenPaths.push(handledByPackage.writtenPath);
            }
            try { await updateBenchmarkCompleted(benchStatusPath, statusId, handledByPackage.writtenPath ?? ""); } catch { /* non-fatal */ }
          } else {
            const fallbackResultPath = await runBenchViaFallback(parsed, benchmarkId, runtimeProfile);
            writtenPaths.push(fallbackResultPath);
            try { await updateBenchmarkCompleted(benchStatusPath, statusId, fallbackResultPath); } catch { /* non-fatal */ }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`  [ERROR] benchmark "${benchmarkId}" failed: ${message}`);
          failures.add(benchmarkId);
          try { await updateBenchmarkFailed(benchStatusPath, statusId, message); } catch { /* non-fatal */ }
        }
    }
  } finally {
    try { await finalizeBenchStatus(benchStatusPath); } catch { /* non-fatal */ }
  }
  await writeBenchReproManifestForPackageRun({
    parsed,
    benchmarkIds: selectedBenchmarks,
    runtimeProfiles: deriveRuntimeProfilesFromBenchWorkItems(selectedWorkItems),
    workItems: selectedWorkItems,
    resultPaths: writtenPaths,
  });
  if (failures.size > 0) {
    console.error(`\nFailed benchmarks: ${[...failures].join(", ")}`);
    process.exitCode = 1;
  }
}

/**
 * `remnic bench procedural-ablation --fixture <path> --out <path>` (issue
 * #567 PR 1/5). Runs the procedural recall ablation harness and writes a
 * JSON artifact containing onScore / offScore / lift / CI.
 */
async function cmdBenchProceduralAblation(rest: string[]): Promise<void> {
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(`remnic bench procedural-ablation — Procedural recall ablation harness (issue #567)

Usage:
  remnic bench procedural-ablation --out <path> [--fixture <path>] [--seed <n>]

Options:
  --fixture <path>   JSON fixture file; either a top-level array of scenarios
                     or { "scenarios": [...] }. Each scenario requires
                     id, prompt, procedurePreamble, procedureSteps,
                     procedureTags, expectMatch. When omitted, the built-in
                     procedural-recall fixture is used.
  --out <path>       Path to write the ablation artifact JSON.
  --seed <n>         Integer seed for the bootstrap RNG. Defaults to a fixed
                     seed so CI bounds are reproducible across runs.
`);
    return;
  }

  let fixturePathRaw: string | undefined;
  let outPathRaw: string | undefined;
  let seedRaw: string | undefined;
  try {
    fixturePathRaw = resolveRequiredValueFlag(rest, "--fixture");
    outPathRaw =
      resolveRequiredValueFlag(rest, "--out") ??
      resolveRequiredValueFlag(rest, "--output");
    seedRaw = resolveRequiredValueFlag(rest, "--seed");
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (!outPathRaw) {
    console.error(
      "--out <path> is required. Run `remnic bench procedural-ablation --help`.",
    );
    process.exit(1);
  }

  let seed: number | undefined;
  if (seedRaw !== undefined) {
    const parsedSeed = Number(seedRaw);
    if (!Number.isFinite(parsedSeed) || !Number.isInteger(parsedSeed)) {
      console.error(`--seed must be an integer (got "${seedRaw}").`);
      process.exit(1);
    }
    seed = parsedSeed;
  }

  let fixturePath: string | null;
  if (fixturePathRaw === undefined) {
    fixturePath = null;
  } else if (fixturePathRaw.trim() === "") {
    console.error(
      "--fixture requires a non-empty path. Omit the flag to use the built-in fixture.",
    );
    process.exit(1);
  } else {
    fixturePath = path.resolve(expandTilde(fixturePathRaw));
  }
  const outPath = path.resolve(expandTilde(outPathRaw));

  const benchModule = await loadBenchModule();
  const runner = (
    benchModule as unknown as {
      runProceduralAblationCli?: (args: {
        fixturePath: string | null;
        outPath: string;
        seed?: number;
      }) => Promise<{
        onScore: number;
        offScore: number;
        lift: number;
        fixture: { scenarioCount: number };
      }>;
    }
  ).runProceduralAblationCli;
  if (typeof runner !== "function") {
    console.error(
      "The installed @remnic/bench build does not expose runProceduralAblationCli. Upgrade to a build that includes issue #567 PR 1.",
    );
    process.exit(1);
  }

  const artifact = await runner({ fixturePath, outPath, seed });
  console.log(
    `procedural-ablation complete: scenarios=${artifact.fixture.scenarioCount} onScore=${artifact.onScore.toFixed(
      4,
    )} offScore=${artifact.offScore.toFixed(4)} lift=${artifact.lift.toFixed(
      4,
    )}`,
  );
  console.log(`wrote ${outPath}`);
}

// ── Daemon management ────────────────────────────────────────────────────────
const LOGS_DIR = path.join(PID_DIR, "logs");
const LAUNCHD_PLIST_PATHS = launchdPlistPaths(resolveHomeDir());
const [LAUNCHD_PLIST_PATH] = LAUNCHD_PLIST_PATHS;
const SYSTEMD_UNIT_PATHS = systemdUnitPaths(resolveHomeDir());
const [SYSTEMD_UNIT_PATH] = SYSTEMD_UNIT_PATHS;
function readPid(): number | undefined {
  return readVerifiedDaemonPid({
    pidFiles: [PID_FILE, LEGACY_PID_FILE],
    expectedServerBin: resolveServerBin(),
  });
}

function inferPort(): number {
  try {
    const configPath = resolveConfigPath();
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return raw.server?.port ?? 4318;
  } catch {
    return 4318;
  }
}

function resolveNodePath(): string {
  return process.execPath;
}

function isMacOS(): boolean {
  return process.platform === "darwin";
}

function isLinux(): boolean {
  return process.platform === "linux";
}

function renderTemplate(templateContent: string, vars: Record<string, string>): string {
  let result = templateContent;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

function isStandaloneServiceInstalled(): boolean {
  if (isMacOS()) return anyFileExists(LAUNCHD_PLIST_PATHS);
  if (isLinux()) return anyFileExists(SYSTEMD_UNIT_PATHS);
  return false;
}

function commandFailureDetail(error: unknown): string {
  if (error && typeof error === "object") {
    const maybe = error as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
    const stderr = maybe.stderr ? String(maybe.stderr).trim() : "";
    if (stderr) return stderr;
    const stdout = maybe.stdout ? String(maybe.stdout).trim() : "";
    if (stdout) return stdout;
    if (maybe.message) return maybe.message;
  }
  return String(error);
}

function failDaemonInstall(command: string, error: unknown): never {
  console.error(`Error: daemon install failed while running ${command}.`);
  console.error(`  ${commandFailureDetail(error)}`);
  process.exit(1);
}

function isLaunchdLabelLoaded(label: string): boolean {
  return firstSuccessfulResult([label], (candidate) => {
    childProcess.execSync(`launchctl list ${candidate} 2>/dev/null`, { stdio: "pipe" });
    return true;
  }) === true;
}

function isLaunchdServiceLoaded(): boolean {
  return firstSuccessfulResult(LAUNCHD_LABEL_CANDIDATES, (label) => {
    childProcess.execSync(`launchctl list ${label} 2>/dev/null`, { stdio: "pipe" });
    return true;
  }) === true;
}

function isSystemdServiceActive(): boolean {
  return firstSuccessfulResult(SYSTEMD_SERVICE_CANDIDATES, (serviceName) => {
    const out = childProcess.execSync(`systemctl --user is-active ${serviceName} 2>/dev/null`, {
      encoding: "utf8",
    }).trim();
    return out === "active" ? true : undefined;
  }) === true;
}

function selectLaunchdInspection(openclawPluginModeConfigured: boolean): {
  ok: boolean;
  warn?: boolean;
  detail: string;
  remediation?: string;
} {
  const canonical = inspectLaunchdPlist(LAUNCHD_PLIST_PATH);
  if (canonical.installed) return canonical;

  for (const plistPath of LAUNCHD_PLIST_PATHS.slice(1)) {
    const legacy = inspectLaunchdPlist(plistPath);
    if (!legacy.installed) continue;

    const label = path.basename(plistPath, ".plist");
    return legacy.ok
      ? {
          ...legacy,
          warn: true,
          detail: `${legacy.detail} (legacy ${label}; reinstall recommended)`,
          remediation: "Run `remnic daemon install` to migrate the launchd service to ai.remnic.daemon.",
        }
      : legacy;
  }

  return {
    ok: true,
    warn: !openclawPluginModeConfigured,
    detail: openclawPluginModeConfigured
      ? "not installed (OpenClaw plugin mode does not require standalone launchd)"
      : `${LAUNCHD_PLIST_PATH} (not installed)`,
    remediation: openclawPluginModeConfigured
      ? undefined
      : "Run `remnic daemon install` to install the standalone launchd service.",
  };
}

function daemonInstall(): void {
  const home = resolveHomeDir();
  const nodePath = resolveNodePath();
  const serverBinDetails = resolveServerBinDetails();
  const serverBin = serverBinDetails.path;

  // Service templates use plain `node` — TypeScript source won't work
  if (!serverBinDetails.exists) {
    console.error("Error: @remnic/server could not be found.");
    console.error("  Install @remnic/server beside @remnic/cli, or build it from the workspace first.");
    console.error(`  Expected: ${serverBin}`);
    process.exit(1);
  }
  if (!serverBinDetails.loadableByNode) {
    console.error("Error: @remnic/server has not been built. Run 'pnpm run build --filter=@remnic/server' first.");
    console.error(`  Found:    ${serverBin} (not loadable by launchd/systemd node)`);
    process.exit(1);
  }

  const vars = { HOME: home, NODE_PATH: nodePath, REMNIC_SERVER_BIN: serverBin };

  fs.mkdirSync(LOGS_DIR, { recursive: true });

  if (isMacOS()) {
    const templatePath = path.resolve(import.meta.dirname, "../templates/launchd/ai.remnic.daemon.plist");
    const template = fs.readFileSync(templatePath, "utf8");
    const plist = renderTemplate(template, vars);
    fs.mkdirSync(path.dirname(LAUNCHD_PLIST_PATH), { recursive: true });
    fs.writeFileSync(LAUNCHD_PLIST_PATH, plist);
    try {
      launchdLoadPlist(LAUNCHD_PLIST_PATH);
    } catch (err) {
      if (!isLaunchdLabelLoaded(LAUNCHD_LABEL)) {
        failDaemonInstall(`launchctl load -w ${LAUNCHD_PLIST_PATH}`, err);
      }
    }
    if (!isLaunchdLabelLoaded(LAUNCHD_LABEL)) {
      failDaemonInstall(`launchctl list ${LAUNCHD_LABEL}`, new Error("service was not loaded after install"));
    }
    console.log(`Installed launchd service: ${LAUNCHD_PLIST_PATH}`);
    console.log(`  Label: ${LAUNCHD_LABEL}`);
    console.log(`  RunAtLoad: true, KeepAlive: true`);
    console.log(`  Logs: ${LOGS_DIR}/daemon.log`);
  } else if (isLinux()) {
    const templatePath = path.resolve(import.meta.dirname, "../templates/systemd/remnic.service");
    const template = fs.readFileSync(templatePath, "utf8");
    const unit = renderTemplate(template, vars);
    fs.mkdirSync(path.dirname(SYSTEMD_UNIT_PATH), { recursive: true });
    fs.writeFileSync(SYSTEMD_UNIT_PATH, unit);
    try {

      childProcess.execSync("systemctl --user daemon-reload", { stdio: "pipe" });
    } catch (err) {
      failDaemonInstall("systemctl --user daemon-reload", err);
    }
    try {
      childProcess.execSync(`systemctl --user enable ${SYSTEMD_SERVICE}`, { stdio: "pipe" });
    } catch (err) {
      failDaemonInstall(`systemctl --user enable ${SYSTEMD_SERVICE}`, err);
    }
    try {
      childProcess.execSync(`systemctl --user start ${SYSTEMD_SERVICE}`, { stdio: "pipe" });
    } catch (err) {
      failDaemonInstall(`systemctl --user start ${SYSTEMD_SERVICE}`, err);
    }
    if (!isSystemdServiceActive()) {
      failDaemonInstall(`systemctl --user is-active ${SYSTEMD_SERVICE}`, new Error("service is not active after install"));
    }
    console.log(`Installed systemd user service: ${SYSTEMD_UNIT_PATH}`);
    console.log(`  Restart: on-failure, WantedBy: default.target`);
    console.log(`  Logs: ${LOGS_DIR}/daemon.log`);
  } else {
    console.error(`Unsupported platform: ${process.platform}. Use 'remnic daemon start' for manual mode.`);
    process.exit(1);
  }
}

function daemonUninstall(): void {
  if (isMacOS()) {
    let removed = false;
    for (const plistPath of LAUNCHD_PLIST_PATHS) {
      try {
        launchdUnloadPlist(plistPath);
      } catch {
        // May not be loaded
      }
      try {
        fs.unlinkSync(plistPath);
        removed = true;
        console.log(`Removed launchd service: ${plistPath}`);
      } catch {
        // keep going
      }
    }
    if (!removed) {
      console.log("Launchd plist not found — nothing to remove.");
    }
  } else if (isLinux()) {
    for (const serviceName of SYSTEMD_SERVICE_CANDIDATES) {
      try {
        childProcess.execSync(`systemctl --user stop ${serviceName}`, { stdio: "pipe" });
        childProcess.execSync(`systemctl --user disable ${serviceName}`, { stdio: "pipe" });
      } catch {
        // May not be active
      }
    }
    let removed = false;
    for (const unitPath of SYSTEMD_UNIT_PATHS) {
      try {
        fs.unlinkSync(unitPath);
        removed = true;
        console.log(`Removed systemd service: ${unitPath}`);
      } catch {
        // keep going
      }
    }
    if (removed) {
      try {
        childProcess.execSync("systemctl --user daemon-reload", { stdio: "pipe" });
      } catch {
        // Keep uninstall best-effort when user systemd is unavailable.
      }
    } else {
      console.log("Systemd unit not found — nothing to remove.");
    }
  } else {
    console.error(`Unsupported platform: ${process.platform}.`);
    process.exit(1);
  }
  // Also stop any manually-started daemon
  daemonStop();
}

function isServiceRunning(): { running: boolean; pid?: number } {
  // Check PID file first (manual `daemon start`)
  const pidFromFile = readPid();
  if (pidFromFile) {
    try {
      process.kill(pidFromFile, 0);
      return { running: true, pid: pidFromFile };
    } catch {
      // stale pid file
    }
  }
  // Check service manager (launchd/systemd from `daemon install`)
  if (isMacOS()) {
    const status = firstSuccessfulResult(LAUNCHD_LABEL_CANDIDATES, (label) => {
      const out = childProcess.execSync(`launchctl list ${label} 2>/dev/null`, { encoding: "utf8" });
      const pidMatch = out.match(/"PID"\s*=\s*(\d+)/);
      if (pidMatch) return { running: true, pid: parseInt(pidMatch[1], 10) };
      return out.includes('"PID"') ? { running: true } : undefined;
    });
    if (status) return status;
  } else if (isLinux()) {
    const status = firstSuccessfulResult(SYSTEMD_SERVICE_CANDIDATES, (serviceName) => {
      const out = childProcess.execSync(`systemctl --user is-active ${serviceName} 2>/dev/null`, {
        encoding: "utf8",
      }).trim();
      if (out !== "active") return undefined;
      try {
        const pidOut = childProcess.execSync(
          `systemctl --user show ${serviceName} --property=MainPID --value`,
          { encoding: "utf8" },
        ).trim();
        const spid = parseInt(pidOut, 10);
        if (spid > 0) return { running: true, pid: spid };
      } catch {
        // Keep the service running result even if MainPID lookup fails.
      }
      return { running: true };
    });
    if (status) return status;
  }
  return { running: false };
}

async function daemonStatus(): Promise<void> {
  const hostedOnly = resolveHostedOnlyDaemonRefusal(resolveConfigPath());
  if (hostedOnly) {
    // Hosted-only mode (issue #2712): report the remote origin, not a
    // leftover local PID on 4318. `daemon stop|uninstall` remain the
    // cleanup path for such a leftover.
    const probe = await probeDaemonHealth(
      hostedOnly.remoteUrl,
      resolveOperatorToken(resolveConfigPath()),
    );
    const remoteState = probe.ok
      ? "reachable"
      : `unreachable${probe.status ? ` (HTTP ${probe.status})` : probe.error ? ` (${probe.error})` : ""}`;
    console.log(`Remnic daemon status:`);
    console.log(`  Mode:      hosted-only (remote origin ${hostedOnly.remoteUrl})`);
    console.log(`  Remote:    ${remoteState}`);
    console.log(`  Local:     disabled — \`daemon start|install\` refuse while the remote origin is set`);
    return;
  }
  const { running, pid } = isServiceRunning();
  const port = inferPort();
  const serviceInstalled = isMacOS()
    ? anyFileExists(LAUNCHD_PLIST_PATHS)
    : isLinux()
      ? anyFileExists(SYSTEMD_UNIT_PATHS)
      : false;

  console.log(`Remnic daemon status:`);
  console.log(`  Running:   ${running ? `yes${pid ? ` (pid ${pid})` : ""}` : "no"}`);
  console.log(`  Port:      ${port}`);
  console.log(`  Service:   ${serviceInstalled ? "installed" : "not installed"}`);
  console.log(`  Platform:  ${process.platform}`);
  console.log(`  PID file:  ${fs.existsSync(PID_FILE) ? PID_FILE : LEGACY_PID_FILE}`);
  console.log(`  Log file:  ${fs.existsSync(LOG_FILE) ? LOG_FILE : LEGACY_LOG_FILE}`);

  // Memory extensions status (#382)
  try {
    const configPath = resolveConfigPath();
    const raw = fs.existsSync(configPath)
      ? JSON.parse(fs.readFileSync(configPath, "utf8"))
      : {};
    const remnicCfg = resolveRemnicConfigRecord(raw);
    const config = parseConfig(remnicCfg);
    const extRoot = resolveExtensionsRoot(config);
    const noopLog = { warn: () => {}, debug: () => {} };
    const exts = await discoverMemoryExtensions(extRoot, noopLog);
    if (exts.length > 0) {
      const names = exts.map((e) => e.name).join(", ");
      console.log(`  Memory extensions: ${exts.length} active (${names})`);
    } else {
      console.log(`  Memory extensions: none`);
    }
  } catch {
    console.log(`  Memory extensions: unknown (config error)`);
  }
}

/**
 * Hosted-only mode (issue #2712): with a non-loopback REMNIC_DAEMON_URL /
 * server.url, the local daemon lifecycle refuses instead of spawning a
 * remnic-server next to the hosted one. Stop and uninstall stay allowed —
 * they are the cleanup path for a leftover local daemon.
 */
function refuseLocalDaemonIfHostedOnly(action: DaemonAction): void {
  const refusal = resolveHostedOnlyDaemonRefusal(resolveConfigPath());
  if (refusal) {
    console.error(hostedOnlyDaemonRefusalMessage(refusal.remoteUrl, action));
    process.exit(1);
  }
}

function daemonStart(): void {
  const svc = isServiceRunning();
  if (svc.running) {
    console.log(`Already running${svc.pid ? ` (pid ${svc.pid})` : " (via service manager)"}`);
    return;
  }

  // Try service manager first (for daemons installed via `remnic daemon install`)
  if (isMacOS() && anyFileExists(LAUNCHD_PLIST_PATHS)) {
    const label = firstSuccessfulCandidate(LAUNCHD_LABEL_CANDIDATES, (candidate) => {
      childProcess.execSync(`launchctl start ${candidate} 2>/dev/null`, { stdio: "pipe" });
    });
    if (label) {
      console.log(`Started remnic daemon via launchd (${label})`);
      return;
    }
  } else if (isLinux() && anyFileExists(SYSTEMD_UNIT_PATHS)) {
    const serviceName = firstSuccessfulCandidate(SYSTEMD_SERVICE_CANDIDATES, (candidate) => {
      childProcess.execSync(`systemctl --user start ${candidate}`, { stdio: "pipe" });
    });
    if (serviceName) {
      console.log(`Started remnic daemon via systemd (${serviceName})`);
      return;
    }
  }

  fs.mkdirSync(PID_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const logStream = fs.openSync(LOG_FILE, "a");

  const serverBin = resolveServerBin();
  const isSource = serverBin.endsWith(".ts");

  let cmd: string;
  let args: string[];
  if (isSource) {
    // Dev mode: use npx tsx
    cmd = "npx";
    args = ["tsx", serverBin];
  } else {
    // Production: use node directly
    cmd = process.execPath;
    args = [serverBin];
  }

  const child = childProcess.spawn(cmd, args, {
    detached: true,
    stdio: ["ignore", logStream, logStream],
    env: {
      ...process.env,
      REMNIC_DAEMON: "1",
      ENGRAM_DAEMON: process.env.ENGRAM_DAEMON ?? "1",
    },
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  console.log(`Started remnic server (pid ${child.pid})`);
  console.log(`  Log: ${LOG_FILE}`);
}

function daemonStop(): void {
  // Try service manager first (for daemons started via `remnic daemon install`)
  if (isMacOS() && anyFileExists(LAUNCHD_PLIST_PATHS)) {
    const label = firstSuccessfulCandidate(LAUNCHD_LABEL_CANDIDATES, (candidate) => {
      childProcess.execSync(`launchctl stop ${candidate} 2>/dev/null`, { stdio: "pipe" });
    });
    if (label) {
      console.log(`Stopped remnic daemon via launchd (${label})`);
      return;
    }
  } else if (isLinux() && anyFileExists(SYSTEMD_UNIT_PATHS)) {
    const serviceName = firstSuccessfulCandidate(SYSTEMD_SERVICE_CANDIDATES, (candidate) => {
      childProcess.execSync(`systemctl --user stop ${candidate}`, { stdio: "pipe" });
    });
    if (serviceName) {
      console.log(`Stopped remnic daemon via systemd (${serviceName})`);
      return;
    }
  }

  // Fall back to PID file (for daemons started via `remnic daemon start`)
  const pid = readPid();
  if (!pid) {
    console.log("Not running");
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    console.log(`Stopped remnic server (pid ${pid})`);
  } catch {
    console.log("Process not found (cleaning up PID file)");
  }
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    // ignore
  }
  try {
    fs.unlinkSync(LEGACY_PID_FILE);
  } catch {
    // ignore
  }
}

function daemonRestart(): void {
  daemonStop();
  setTimeout(() => daemonStart(), 1000);
}

// ── Token management ────────────────────────────────────────────────────────

function cmdTokenGenerate(rest: string[]): void {
  // Parse scoped-capability flags (issue #1837) FIRST so their values are
  // never mistaken for the connector positional. resolveFlagStrict rejects a
  // bare flag or one whose value is another --flag, matching the repo's
  // "value flags must have a real value" convention (rule 14).
  const opsRaw = resolveFlagStrict(rest, "--ops");
  const namespacesRaw = resolveFlagStrict(rest, "--namespaces");

  // Connector id is the first positional that is NOT a value flag and NOT the
  // value consumed by one. Parsing the flags first (above) means `token
  // generate --ops recall monitor` resolves connector=monitor, not the --ops
  // value "recall" — the prior `rest.find(a => !a.startsWith("-"))` grabbed
  // the first non-flag token, which was the --ops value (issue #1850 finding
  // 5). Skipping each value flag AND its following token leaves only real
  // positionals; a bare flag (e.g. --json) starts with "-" so it is never
  // picked as the connector either.
  let connector: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    // --ops and --namespaces each consume the following token as their value;
    // skip both so that value is never mistaken for the connector.
    if (tok === "--ops" || tok === "--namespaces") {
      i++;
      continue;
    }
    if (!tok.startsWith("-")) {
      connector = tok;
      break;
    }
  }
  if (!connector) {
    console.error("Usage: remnic token generate <connector-id> [--ops <comma-list>] [--namespaces <comma-list>]");
    console.error("  e.g.: remnic token generate claude-code");
    console.error("        remnic token generate monitor --ops status,health --namespaces default");
    process.exit(1);
  }

  const rawCaps: Record<string, string[]> = {};
  if (opsRaw !== undefined) {
    rawCaps.ops = opsRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  }
  if (namespacesRaw !== undefined) {
    rawCaps.namespaces = namespacesRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  }

  // validateCapabilitiesForMint ALWAYS returns a versioned record — even for
  // a no-flag mint it yields { version: 1 } (explicit unrestricted), never an
  // omitted field, so a new token is distinguishable from a legacy entry.
  let capabilities;
  try {
    capabilities = validateCapabilitiesForMint(
      Object.keys(rawCaps).length > 0 ? rawCaps : undefined,
      OPERATION_NAMES,
    );
  } catch (error) {
    console.error(
      `Invalid token capabilities: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error("  Run with --ops <comma-list> and/or --namespaces <comma-list> using valid values.");
    process.exit(1);
  }

  const entry = generateToken(connector, undefined, capabilities);
  console.log(`Generated token for ${connector}:`);
  console.log(`  Token:   ${entry.token}`);
  console.log(`  Created: ${entry.createdAt}`);
  if (capabilities.ops !== undefined) {
    console.log(`  Ops:     ${capabilities.ops.length > 0 ? capabilities.ops.join(", ") : "(deny all)"}`);
  }
  if (capabilities.namespaces !== undefined) {
    console.log(`  Ns:      ${capabilities.namespaces.length > 0 ? capabilities.namespaces.join(", ") : "(deny all)"}`);
  }
  console.log(`\nUse this token as the Bearer token when connecting from ${connector}.`);
}

function cmdTokenList(json: boolean): void {
  const tokens = listTokens();
  if (json) {
    console.log(JSON.stringify(tokens, null, 2));
    return;
  }
  if (tokens.length === 0) {
    console.log("No tokens. Generate one with: remnic token generate <connector-id>");
    return;
  }
  console.log("Connector tokens:");
  for (const t of tokens) {
    // Show only first 20 chars of token for security
    const masked = t.token.slice(0, 20) + "…";
    console.log(`  ${t.connector.padEnd(16)} ${masked}  (created ${t.createdAt})`);
  }
}

function cmdTokenRevoke(connector: string): void {
  if (!connector) {
    console.error("Usage: remnic token revoke <connector-id>");
    process.exit(1);
  }
  if (revokeToken(connector)) {
    console.log(`Revoked token for ${connector}`);
  } else {
    console.log(`No token found for ${connector}`);
  }
}

// ── OpenClaw install command ──────────────────────────────────────────────────

interface OpenclawInstallOptions {
  yes: boolean;
  dryRun: boolean;
  memoryDir?: string;
  configPath?: string;
}

interface OpenclawUpgradeOptions extends OpenclawInstallOptions {
  pluginDir?: string;
  version?: string;
  restartGateway: boolean;
  legacyPluginDirForBackup?: string;
}

async function promptYesNo(question: string, defaultYes = true): Promise<boolean> {
  // In non-interactive environments, default to yes
  if (!process.stdin.isTTY) return defaultYes;
  process.stdout.write(question + " ");
  return new Promise((resolve) => {
    let buf = "";
    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.removeListener("close", onEnd);
      process.stdin.pause();
    };
    const onEnd = () => {
      cleanup();
      resolve(defaultYes);
    };
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        cleanup();
        const answer = buf.slice(0, nl).trim().toLowerCase();
        if (answer === "" || answer === "y" || answer === "yes") {
          resolve(defaultYes || answer !== "");
        } else if (answer === "n" || answer === "no") {
          resolve(false);
        } else {
          resolve(defaultYes);
        }
      }
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.on("close", onEnd);
  });
}

// ── Binary lifecycle CLI ─────────────────────────────────────────────────────

async function cmdBinary(rest: string[]): Promise<void> {
  initLogger();
  const configPath = resolveConfigPath();
  const raw = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  const remnicCfg = resolveRemnicConfigRecord(raw);
  const config = parseConfig(remnicCfg);
  const memoryDir = resolveMemoryDir();

  // Build the BinaryLifecycleConfig from PluginConfig values.
  const blConfig: BinaryLifecycleConfig = {
    enabled: config.binaryLifecycleEnabled,
    gracePeriodDays: config.binaryLifecycleGracePeriodDays,
    maxBinarySizeBytes: DEFAULT_MAX_BINARY_SIZE_BYTES,
    scanPatterns: DEFAULT_SCAN_PATTERNS,
    backend: {
      type: config.binaryLifecycleBackendType,
      basePath: config.binaryLifecycleBackendPath
        ? expandTilde(config.binaryLifecycleBackendPath)
        : undefined,
    },
  };

  const action = rest[0] ?? "help";

  switch (action) {
    case "scan": {
      const manifest = await readManifest(memoryDir);
      // Inline import to avoid pulling scanner into every CLI load
      const { scanForBinaries } = await import("@remnic/core");
      const found = await scanForBinaries(memoryDir, blConfig, manifest);
      if (found.length === 0) {
        console.log("No untracked binary files found.");
      } else {
        console.log(`Found ${found.length} untracked binary file(s):`);
        for (const p of found) {
          console.log(`  ${p}`);
        }
      }
      break;
    }

    case "status": {
      const manifest = await readManifest(memoryDir);
      const counts = {
        total: manifest.assets.length,
        pending: manifest.assets.filter((a) => a.status === "pending").length,
        mirrored: manifest.assets.filter((a) => a.status === "mirrored").length,
        redirected: manifest.assets.filter((a) => a.status === "redirected").length,
        cleaned: manifest.assets.filter((a) => a.status === "cleaned").length,
        error: manifest.assets.filter((a) => a.status === "error").length,
      };
      const totalBytes = manifest.assets.reduce((sum, a) => sum + a.sizeBytes, 0);
      console.log(`Binary lifecycle manifest (${memoryDir}):`);
      console.log(`  Total assets:  ${counts.total}`);
      console.log(`  Pending:       ${counts.pending}`);
      console.log(`  Mirrored:      ${counts.mirrored}`);
      console.log(`  Redirected:    ${counts.redirected}`);
      console.log(`  Cleaned:       ${counts.cleaned}`);
      console.log(`  Errors:        ${counts.error}`);
      console.log(`  Total size:    ${(totalBytes / 1024).toFixed(1)} KB`);
      if (manifest.lastScanAt) {
        console.log(`  Last scan:     ${manifest.lastScanAt}`);
      }
      break;
    }

    case "run": {
      const dryRun = rest.includes("--dry-run");
      const backend = createBackend(blConfig.backend);
      const log = {
        info: (msg: string) => console.log(msg),
        warn: (msg: string) => console.warn(msg),
        error: (msg: string) => console.error(msg),
      };
      const result = await runBinaryLifecyclePipeline(
        memoryDir,
        blConfig,
        backend,
        log,
        { dryRun },
      );
      console.log(
        `\nPipeline complete${dryRun ? " (dry-run)" : ""}:` +
          ` scanned=${result.scanned}, mirrored=${result.mirrored},` +
          ` redirected=${result.redirected}, cleaned=${result.cleaned}`,
      );
      if (result.errors.length > 0) {
        console.error(`Errors (${result.errors.length}):`);
        for (const e of result.errors) console.error(`  ${e}`);
      }
      break;
    }

    case "clean": {
      const force = rest.includes("--force");
      if (!force) {
        console.error("Use --force to confirm cleanup of local binary copies.");
        process.exit(1);
      }
      const backend = createBackend(blConfig.backend);
      const log = {
        info: (msg: string) => console.log(msg),
        warn: (msg: string) => console.warn(msg),
        error: (msg: string) => console.error(msg),
      };
      const result = await runBinaryLifecyclePipeline(
        memoryDir,
        blConfig,
        backend,
        log,
        { forceClean: true },
      );
      console.log(
        `\nClean complete: cleaned=${result.cleaned}`,
      );
      if (result.errors.length > 0) {
        console.error(`Errors (${result.errors.length}):`);
        for (const e of result.errors) console.error(`  ${e}`);
      }
      break;
    }

    default:
      console.log(`Usage: remnic binary <scan|status|run|clean>

  scan               Scan for untracked binary files
  status             Show binary lifecycle manifest summary
  run [--dry-run]    Run full binary lifecycle pipeline
  clean --force      Force-clean local copies past grace period`);
      break;
  }
}

async function cmdOpenclawInstall(opts: OpenclawInstallOptions): Promise<void> {
  const configPath = resolveOpenclawConfigPath(opts.configPath);
  const fallbackMemoryDir = path.join(resolveOpenclawStateDir(), "workspace", "memory", "local");

  console.log(`OpenClaw config: ${configPath}`);

  const existingConfig = readOpenclawConfig(configPath);
  const { plugins, entries, slots } = parseOpenclawPluginState(existingConfig, configPath);

  // Check for legacy entry. REMNIC_OPENCLAW_PLUGIN_ID is the canonical (post-#405) id.
  // REMNIC_OPENCLAW_LEGACY_PLUGIN_ID is the pre-#405 id retained for rollback/migration.
  const hasLegacy = REMNIC_OPENCLAW_LEGACY_PLUGIN_ID in entries;
  const hasNew = REMNIC_OPENCLAW_PLUGIN_ID in entries;
  const currentSlot = slots.memory as string | undefined;

  let migrateLegacy = false;
  if (hasLegacy && !opts.yes) {
    migrateLegacy = await promptYesNo(
      `Found legacy '${REMNIC_OPENCLAW_LEGACY_PLUGIN_ID}' entry. Migrate to '${REMNIC_OPENCLAW_PLUGIN_ID}'? [Y/n]`,
      true,
    );
  } else if (hasLegacy) {
    migrateLegacy = true;
  }

  // Build the new config.
  // When migrating (migrateLegacy=true): merge legacy config values so operators
  // don't lose settings like custom models, then let the existing new-entry config
  // and the explicit memoryDir take precedence.
  // When NOT migrating: only carry forward the existing openclaw-remnic config (if any).
  const legacyEntry = entries[REMNIC_OPENCLAW_LEGACY_PLUGIN_ID] as Record<string, unknown> | undefined;
  const existingNewEntry = entries[REMNIC_OPENCLAW_PLUGIN_ID] as Record<string, unknown> | undefined;

  const legacyConfigToMerge =
    migrateLegacy && legacyEntry?.config && typeof legacyEntry.config === "object"
      ? (legacyEntry.config as Record<string, unknown>)
      : {};

  const existingNewEntryConfig =
    existingNewEntry?.config && typeof existingNewEntry.config === "object"
      ? (existingNewEntry.config as Record<string, unknown>)
      : {};
  const defaultModelSource = !hasNew && !migrateLegacy ? "gateway" : "plugin";

  // Determine the final memoryDir. Operator-provided --memory-dir always wins.
  // On reinstall (no --memory-dir flag), preserve the currently configured value
  // so running `remnic openclaw install` as a repair doesn't silently relocate
  // the memory namespace. Fall back to the default only when no prior value exists.
  const memoryDir = resolveOpenclawInstallMemoryDir({
    requestedMemoryDir: opts.memoryDir,
    existingNewEntryConfig,
    legacyConfigToMerge,
    migrateLegacy,
    fallbackMemoryDir,
  });

  console.log(`Memory dir:      ${memoryDir}`);

  // Preserve top-level entry fields (e.g. hooks, enabled) during both
  // reinstalls and migration:
  // - Spread legacy entry first so any legacy policy fields are carried over
  //   when migrating (migrateLegacy=true), but exclude legacy's config since
  //   that is merged separately with the explicit memoryDir taking precedence.
  // - Spread the existing new entry on top so its policy takes precedence.
  // - Finally, overwrite config with the merged result.
  const legacyNonConfigFields: Record<string, unknown> = {};
  if (migrateLegacy && legacyEntry && typeof legacyEntry === "object" && !Array.isArray(legacyEntry)) {
    for (const [k, v] of Object.entries(legacyEntry)) {
      if (k !== "config") legacyNonConfigFields[k] = v;
    }
  }
  // Guard: only spread existingNewEntry if it's a plain object — a scalar/array
  // value would cause character-index keys to be silently merged in.
  const existingNewEntryFields =
    existingNewEntry && typeof existingNewEntry === "object" && !Array.isArray(existingNewEntry)
      ? existingNewEntry
      : {};
  const newEntry: Record<string, unknown> = {
    ...legacyNonConfigFields,
    ...existingNewEntryFields,
    hooks: buildRemnicOpenclawHooksPolicy(
      legacyNonConfigFields.hooks,
      existingNewEntryFields.hooks,
    ),
    config: {
      modelSource: defaultModelSource,
      ...legacyConfigToMerge,
      ...existingNewEntryConfig,
      memoryDir,
    },
  };

  const updatedEntries: Record<string, unknown> = { ...entries };
  // Write the entry under the canonical plugin id. The slot below must match this id.
  updatedEntries[REMNIC_OPENCLAW_PLUGIN_ID] = newEntry;

  // Keep legacy entry if migrating so rollback is possible — operator can remove
  // the legacy entry after verifying that hooks fire under the new id.

  // Update the memory slot to the canonical plugin id, UNLESS the operator
  // declined migration AND the slot is already actively pointing at the legacy
  // entry — in that case leave it alone so their working hooks keep firing
  // while they evaluate the new entry.
  // All other cases (unset, mismatched, already pointing at the new id, no
  // legacy entry at all) should be updated so the install results in a
  // working configuration rather than an incomplete one.
  const slotIsActiveLegacy =
    hasLegacy && !migrateLegacy && currentSlot === REMNIC_OPENCLAW_LEGACY_PLUGIN_ID;
  const updatedSlots = slotIsActiveLegacy
    ? { ...slots }
    : { ...slots, memory: REMNIC_OPENCLAW_PLUGIN_ID };

  const updatedConfig: Record<string, unknown> = {
    ...existingConfig,
    plugins: {
      ...plugins,
      entries: updatedEntries,
      slots: updatedSlots,
    },
  };

  // What will change
  const changes: string[] = [];
  if (!hasNew) changes.push(`+ Added plugins.entries["${REMNIC_OPENCLAW_PLUGIN_ID}"]`);
  else changes.push(`~ Updated plugins.entries["${REMNIC_OPENCLAW_PLUGIN_ID}"].config.memoryDir`);
  changes.push(`~ Set plugins.entries["${REMNIC_OPENCLAW_PLUGIN_ID}"].hooks.allowConversationAccess = true`);
  if (!slotIsActiveLegacy && currentSlot !== REMNIC_OPENCLAW_PLUGIN_ID) {
    changes.push(`~ Set plugins.slots.memory = "${REMNIC_OPENCLAW_PLUGIN_ID}" (was: ${currentSlot ?? "(unset)"})`);
  } else if (slotIsActiveLegacy) {
    changes.push(`  Slot left as "${REMNIC_OPENCLAW_LEGACY_PLUGIN_ID}" — re-run with --yes to activate the new entry`);
  }
  if (!fs.existsSync(memoryDir)) changes.push(`+ Will create memory directory: ${memoryDir}`);
  if (hasLegacy && migrateLegacy) {
    changes.push(`~ Legacy '${REMNIC_OPENCLAW_LEGACY_PLUGIN_ID}' entry retained (safe to remove after verifying hooks fire)`);
  }

  if (opts.dryRun) {
    console.log("\n--- DRY RUN — no changes written ---");
    for (const c of changes) console.log("  " + c);
    // Print a structural summary without dumping full config values —
    // config objects can contain API keys and other credentials.
    const dryRunPlugins = updatedConfig.plugins as Record<string, unknown>;
    const dryRunEntries = dryRunPlugins.entries as Record<string, unknown> | undefined;
    const entrySummary = dryRunEntries
      ? Object.keys(dryRunEntries).map((k) => {
          const cfg = (dryRunEntries[k] as Record<string, unknown>)?.config as Record<string, unknown> | undefined;
          const hooks = (dryRunEntries[k] as Record<string, unknown>)?.hooks as Record<string, unknown> | undefined;
          return `  ${k}: { hooks: { allowConversationAccess: ${hooks?.allowConversationAccess ?? "(unset)"} }, config: { memoryDir: ${cfg?.memoryDir ?? "(unset)"}, ... } }`;
        }).join("\n")
      : "  (none)";
    console.log("\nResulting plugins.entries:");
    console.log(entrySummary);
    console.log(`\nResulting plugins.slots.memory: ${(dryRunPlugins.slots as Record<string, unknown>)?.memory ?? "(unset)"}`);
    return;
  }

  // Create memory dir — fail fast if the path exists but is a file
  if (fs.existsSync(memoryDir)) {
    const st = fs.statSync(memoryDir);
    if (!st.isDirectory()) {
      throw new Error(
        `Cannot use ${memoryDir} as the memory directory — a file already exists at that path.\n` +
        `Remove it first and re-run, or choose a different path with --memory-dir.`,
      );
    }
    // Directory already exists, nothing to do.
  } else {
    fs.mkdirSync(memoryDir, { recursive: true });
    console.log(`Created memory directory: ${memoryDir}`);
  }

  // Write config
  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  atomicWriteFileSync(configPath, JSON.stringify(updatedConfig, null, 2) + "\n");

  console.log("\nDone! Summary of changes:");
  for (const c of changes) console.log("  " + c);

  if (hasLegacy && migrateLegacy) {
    console.log(
      `\nNote: The legacy '${REMNIC_OPENCLAW_LEGACY_PLUGIN_ID}' entry has been kept alongside '${REMNIC_OPENCLAW_PLUGIN_ID}'.`,
    );
    console.log(
      "Once you verify that [remnic] gateway_start fired appears in your gateway log,",
    );
    console.log(`you can safely remove the '${REMNIC_OPENCLAW_LEGACY_PLUGIN_ID}' entry from openclaw.json.`);
  }

  console.log("\nNext steps:");
  console.log("  1. Restart the OpenClaw gateway:");
  console.log("       launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway");
  console.log("  2. Start a conversation — check your gateway log for:");
  console.log("       [remnic] gateway_start fired — Remnic memory plugin is active");
  console.log("  3. Run `remnic doctor` to verify the full configuration.");
}

async function cmdOpenclawUpgrade(opts: OpenclawUpgradeOptions): Promise<void> {
  const configPath = resolveOpenclawConfigPath(opts.configPath);
  const pluginDir = resolveOpenclawPluginDir(opts.pluginDir);
  const managedTargetDir = resolveOpenclawManagedPluginDir();
  const legacyPluginDirForBackup = opts.legacyPluginDirForBackup
    ? resolveOpenclawLegacyPluginDir(opts.legacyPluginDirForBackup)
    : undefined;
  const fallbackMemoryDir = path.join(resolveOpenclawStateDir(), "workspace", "memory", "local");
  const packageSpec = buildOpenclawManagedUpgradePackageSpec(opts.version);
  const configExistedBefore = fs.existsSync(configPath);

  const existingConfig = readOpenclawConfig(configPath);
  const { entries, slots } = parseOpenclawPluginState(existingConfig, configPath);
  const preservedMemoryDir = opts.memoryDir
    ? path.resolve(expandTilde(opts.memoryDir))
    : resolveCurrentOpenclawMemoryDir(entries, slots, fallbackMemoryDir);

  console.log(`OpenClaw config: ${configPath}`);
  console.log(`Plugin dir:      ${pluginDir}`);
  if (legacyPluginDirForBackup) {
    console.log(`Legacy dir:      ${legacyPluginDirForBackup}`);
  }
  console.log(`Memory dir:      ${preservedMemoryDir}`);
  console.log(`Package spec:    ${packageSpec}`);
  console.log(`Backup root:     ${path.join(resolveOpenclawStateDir(), "backups")}`);

  const plannedActions = [
    `backup openclaw.json and the existing ${REMNIC_OPENCLAW_PLUGIN_ID} extension`,
    ...(legacyPluginDirForBackup
      ? [`backup the existing ${REMNIC_OPENCLAW_LEGACY_PLUGIN_ID} extension without modifying it`]
      : []),
    `install ${packageSpec} through OpenClaw's managed plugin project`,
    `remove the old unmanaged extension and verify OpenClaw can load the managed plugin`,
    `re-run remnic openclaw install with the preserved memory dir`,
    opts.restartGateway
      ? "restart the OpenClaw gateway with launchctl kickstart"
      : "leave gateway restart to the operator (--no-restart)",
  ];

  if (opts.dryRun) {
    console.log("\n--- DRY RUN — no changes written ---");
    for (const action of plannedActions) {
      console.log(`  - ${action}`);
    }
    return;
  }

  if (!opts.yes) {
    const shouldContinue = await promptYesNo(
      `Proceed with published npm upgrade from ${packageSpec}? This will create backups first. [Y/n]`,
      true
    );
    if (!shouldContinue) {
      console.log("Upgrade cancelled.");
      return;
    }
  }

  const {
    assertDirectoryPathOrMissing,
    describeErrorWithCause,
    installPublishedOpenclawPlugin,
    PublishedOpenclawPluginInstallError,
  } = await loadOpenclawManagedUpgradeModule(packageSpec);
  assertDirectoryPathOrMissing(pluginDir, "OpenClaw plugin dir");
  assertDirectoryPathOrMissing(managedTargetDir, "Managed OpenClaw plugin dir");
  if (legacyPluginDirForBackup) {
    assertDirectoryPathOrMissing(legacyPluginDirForBackup, "Legacy OpenClaw plugin dir");
  }

  const backupDir = createOpenclawUpgradeBackupDir();
  const configBackupPath = path.join(backupDir, "openclaw.json");
  const pluginBackupDir = path.join(backupDir, "extensions", REMNIC_OPENCLAW_PLUGIN_ID);
  const legacyPluginBackupDir = legacyPluginDirForBackup
    ? path.join(backupDir, "extensions", REMNIC_OPENCLAW_LEGACY_PLUGIN_ID)
    : undefined;

  const backupNotes: string[] = [];
  if (backupPathIfPresent(configPath, configBackupPath)) {
    backupNotes.push(`+ Backed up config to ${configBackupPath}`);
  } else {
    backupNotes.push(`  No existing OpenClaw config found at ${configPath}; install step will create it`);
  }
  if (backupPathIfPresent(pluginDir, pluginBackupDir)) {
    backupNotes.push(`+ Backed up plugin dir to ${pluginBackupDir}`);
  } else {
    backupNotes.push(`  No existing plugin dir found at ${pluginDir}; a fresh install will be staged`);
  }
  if (legacyPluginDirForBackup && legacyPluginBackupDir) {
    if (backupPathIfPresent(legacyPluginDirForBackup, legacyPluginBackupDir)) {
      backupNotes.push(`+ Backed up legacy plugin dir to ${legacyPluginBackupDir}`);
    } else {
      backupNotes.push(`  No existing legacy plugin dir found at ${legacyPluginDirForBackup}; nothing to preserve`);
    }
  }
  const runOpenclawCommand: OpenclawCommandRunner = (args, { timeoutMs }) =>
    childProcess.execFileSync("openclaw", [...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_CONFIG_PATH: configPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });


  let installResult: ReturnType<typeof installPublishedOpenclawPlugin> | undefined;
  try {
    installResult = installPublishedOpenclawPlugin(
      packageSpec,
      pluginDir,
      managedTargetDir,
      runOpenclawCommand
    );
    await cmdOpenclawInstall({
      yes: true,
      dryRun: false,
      memoryDir: preservedMemoryDir,
      configPath,
    });
  } catch (installError) {
    const failurePhase = installResult ? "reconfiguring the installed plugin" : "installing the published plugin";
    const installErrorText = describeErrorWithCause(installError);
    const publishedInstallError =
      installError instanceof PublishedOpenclawPluginInstallError ? installError : undefined;
    const rollbackDir = publishedInstallError ? publishedInstallError.rollbackDir : installResult?.rollbackDir;
    const managedRollbackDir = publishedInstallError
      ? publishedInstallError.managedRollbackDir
      : installResult?.managedRollbackDir;
    const managedRollbackTargetDir =
      publishedInstallError?.managedRollbackTargetDir ??
      installResult?.managedRollbackTargetDir ??
      managedTargetDir;
    const requiresHostManagedRestore =
      publishedInstallError?.requiresHostManagedRestore ?? installResult?.requiresHostManagedRestore ?? false;
    const managedRollbackSharesPluginDir =
      managedRollbackDir && path.resolve(managedRollbackTargetDir) === path.resolve(pluginDir);
    const pluginRollbackDir = managedRollbackSharesPluginDir
      ? requiresHostManagedRestore
        ? rollbackDir
        : (rollbackDir ?? managedRollbackDir)
      : rollbackDir;
    const shouldRestorePlugin = Boolean(
      (installResult && !requiresHostManagedRestore) || pluginRollbackDir || publishedInstallError?.shouldRestoreBackup
    );
    const shouldRestoreConfig = Boolean(installResult || publishedInstallError?.shouldRestoreConfig);
    const shouldRollback = shouldRestorePlugin || shouldRestoreConfig || Boolean(managedRollbackDir);

    if (!shouldRollback) {
      throw new Error(`OpenClaw upgrade failed while ${failurePhase}. ` + `Original failure: ${installErrorText}.`, {
        cause: installError,
      });
    }

    const rollbackErrors: unknown[] = [];
    let pendingConfigRestoreError: unknown;
    let usedLocalManagedRestore = Boolean(publishedInstallError?.managedRestoreNote);
    const rollbackNotes: string[] = publishedInstallError?.managedRestoreNote
      ? [publishedInstallError.managedRestoreNote]
      : [];
    if (installResult && shouldRestoreConfig) {
      try {
        const configRestoreNote = restoreOpenclawConfigWithRetry({
          configBackupPath,
          configPath,
          pluginDir,
          removeConfigIfUnbacked: !configExistedBefore,
        });
        if (configRestoreNote) rollbackNotes.push(configRestoreNote);
      } catch (error) {
        pendingConfigRestoreError = error;
      }
    }
    if (installResult) {
      try {
        const managedRestoreNote = installResult.rollbackManagedInstall();
        if (managedRestoreNote) {
          usedLocalManagedRestore = true;
          rollbackNotes.push(managedRestoreNote);
        }
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    const finalRestoresConfig = shouldRestoreConfig && !usedLocalManagedRestore;
    try {
      rollbackNotes.push(
        ...rollbackOpenclawUpgrade({
          configBackupPath: finalRestoresConfig ? configBackupPath : undefined,
          configPath,
          pluginBackupDir: shouldRestorePlugin ? pluginBackupDir : undefined,
          pluginDir,
          rollbackDir: pluginRollbackDir,
          removeConfigIfUnbacked: finalRestoresConfig && !configExistedBefore,
        }),
      );
      if (finalRestoresConfig) pendingConfigRestoreError = undefined;
    } catch (error) {
      rollbackErrors.push(error);
    }
    if (pendingConfigRestoreError) rollbackErrors.push(pendingConfigRestoreError);
    if (
      managedRollbackDir &&
      path.resolve(managedRollbackTargetDir) !== path.resolve(pluginDir) &&
      !requiresHostManagedRestore
    ) {
      try {
        rollbackNotes.push(
          ...rollbackOpenclawUpgrade({
            configPath,
            pluginDir: managedRollbackTargetDir,
            rollbackDir: managedRollbackDir,
          })
        );
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    if (rollbackErrors.length > 0) {
      const rollbackError =
        rollbackErrors.length > 1
          ? new AggregateError(rollbackErrors, "One or more managed, file, or config rollback steps failed.")
          : rollbackErrors[0];
      throw createOpenclawUpgradeRollbackFailure({
        failurePhase,
        installError,
        rollbackError,
      });
    }
    throw new Error(
      `OpenClaw upgrade failed while ${failurePhase}. ` +
        `Original failure: ${installErrorText}. ` +
        `${rollbackNotes.join("; ")}.`,
      { cause: installError }
    );
  }
  const rollbackCleanupWarning = cleanupRollbackDirectoryBestEffort(installResult?.rollbackDir);
  const managedRollbackCleanupWarning = cleanupRollbackDirectoryBestEffort(installResult?.managedRollbackDir);

  console.log("\nUpgrade backups:");
  for (const note of backupNotes) console.log(`  ${note}`);
  console.log(
    `\nInstalled published plugin through OpenClaw from ${packageSpec}` +
      `${installResult?.version ? ` (version ${installResult?.version})` : ""}.`
  );
  if (rollbackCleanupWarning) {
    console.warn(rollbackCleanupWarning);
  }
  if (managedRollbackCleanupWarning) {
    console.warn(managedRollbackCleanupWarning);
  }

  if (opts.restartGateway) {
    const restartResult = runBestEffortGatewayRestart(restartOpenclawGateway, OPENCLAW_GATEWAY_LABEL);
    console.log(restartResult.message);
  } else {
    console.log("\nGateway restart skipped (--no-restart).");
    console.log("Run this manually when you're ready:");
    console.log(`  launchctl kickstart -k gui/$(id -u)/${OPENCLAW_GATEWAY_LABEL}`);
  }
}

async function cmdOpenclawMigrateEngram(opts: OpenclawUpgradeOptions): Promise<void> {
  console.log(
    `Migrating legacy ${REMNIC_OPENCLAW_LEGACY_PLUGIN_ID} installs to ${REMNIC_OPENCLAW_PLUGIN_ID}.`,
  );
  console.log(
    "The legacy config entry and extension directory are preserved for rollback and custom patch reference.",
  );
  await cmdOpenclawUpgrade({
    ...opts,
    legacyPluginDirForBackup: opts.legacyPluginDirForBackup ?? resolveOpenclawLegacyPluginDir(),
  });
  console.log("\nMigration notes:");
  console.log(`  - plugins.entries["${REMNIC_OPENCLAW_PLUGIN_ID}"] is the canonical entry.`);
  console.log(`  - plugins.entries["${REMNIC_OPENCLAW_LEGACY_PLUGIN_ID}"] is retained temporarily for rollback.`);
  console.log("  - Re-apply any local source patches to the new package only after verifying the published build.");
}

function createOpenclawUpgradeBackupDir(): string {
  const backupsRoot = path.join(resolveOpenclawStateDir(), "backups");
  fs.mkdirSync(backupsRoot, { recursive: true });
  return fs.mkdtempSync(path.join(backupsRoot, `remnic-openclaw-upgrade-${formatOpenclawUpgradeStamp()}-`));
}

// ── Taxonomy commands (#366) ─────────────────────────────────────────────────

async function cmdTaxonomy(rest: string[]): Promise<void> {
  initLogger();
  const configPath = resolveConfigPath();
  const raw = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  const remnicCfg = resolveRemnicConfigRecord(raw);
  const config = parseConfig(remnicCfg);

  if (!config.taxonomyEnabled) {
    console.error(
      "Taxonomy is disabled in config (taxonomyEnabled = false). Enable it to use taxonomy commands.",
    );
    process.exit(1);
  }

  const subCommand = rest[0];

  switch (subCommand) {
    case "show": {
      const taxonomy = await loadTaxonomy(config.memoryDir);
      const json = rest.includes("--json");
      if (json) {
        console.log(JSON.stringify(taxonomy, null, 2));
      } else {
        console.log(`Taxonomy v${taxonomy.version} — ${taxonomy.categories.length} categories\n`);
        const idWidth = Math.max(4, ...taxonomy.categories.map((c) => c.id.length));
        const nameWidth = Math.max(6, ...taxonomy.categories.map((c) => c.name.length));
        const header = `${"ID".padEnd(idWidth)}  ${"Name".padEnd(nameWidth)}  ${"Pri".padStart(3)}  Memory Categories`;
        console.log(header);
        console.log("-".repeat(header.length + 10));
        const sorted = [...taxonomy.categories].sort((a, b) => a.priority - b.priority);
        for (const cat of sorted) {
          const line = `${cat.id.padEnd(idWidth)}  ${cat.name.padEnd(nameWidth)}  ${String(cat.priority).padStart(3)}  ${cat.memoryCategories.join(", ")}`;
          console.log(line);
        }
      }
      break;
    }

    case "resolver": {
      const taxonomy = await loadTaxonomy(config.memoryDir);
      const doc = generateResolverDocument(taxonomy);
      console.log(doc);

      if (config.taxonomyAutoGenResolver) {
        const resolverPath = path.join(config.memoryDir, ".taxonomy", "RESOLVER.md");
        fs.mkdirSync(path.dirname(resolverPath), { recursive: true });
        fs.writeFileSync(resolverPath, doc);
        console.error(`Written: ${resolverPath}`);
      }
      break;
    }

    case "add": {
      const id = rest[1];
      const name = rest[2];
      if (!id || !name) {
        console.error("Usage: remnic taxonomy add <id> <name>");
        process.exit(1);
      }
      try {
        validateSlug(id);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      const taxonomy = await loadTaxonomy(config.memoryDir);
      if (taxonomy.categories.some((c) => c.id === id)) {
        console.error(`Category "${id}" already exists.`);
        process.exit(1);
      }

      const descriptionFlag = resolveFlag(rest, "--description");
      const priorityFlag = resolveFlag(rest, "--priority");
      const memoryCategoriesFlag = resolveFlag(rest, "--memory-categories");

      const newCat: TaxonomyCategory = {
        id,
        name,
        description: descriptionFlag ?? `Custom category: ${name}`,
        filingRules: [`Content belonging to ${name}`],
        priority: priorityFlag ? Number(priorityFlag) : 100,
        memoryCategories: memoryCategoriesFlag ? memoryCategoriesFlag.split(",").map((s) => s.trim()) : [],
      };

      taxonomy.categories.push(newCat);
      try {
        validateTaxonomy(taxonomy);
      } catch (err) {
        console.error(`Invalid taxonomy: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      await saveTaxonomy(config.memoryDir, taxonomy);
      console.log(`Added category "${id}" (${name}).`);

      if (config.taxonomyAutoGenResolver) {
        const doc = generateResolverDocument(taxonomy);
        const resolverPath = path.join(config.memoryDir, ".taxonomy", "RESOLVER.md");
        fs.writeFileSync(resolverPath, doc);
        console.error(`Regenerated: ${resolverPath}`);
      }
      break;
    }

    case "remove": {
      const id = rest[1];
      if (!id) {
        console.error("Usage: remnic taxonomy remove <id>");
        process.exit(1);
      }

      const taxonomy = await loadTaxonomy(config.memoryDir);
      const idx = taxonomy.categories.findIndex((c) => c.id === id);
      if (idx === -1) {
        console.error(`Category "${id}" not found.`);
        process.exit(1);
      }

      // Prevent removing a default category that has memoryCategories mapped
      const target = taxonomy.categories[idx]!;
      const isDefault = DEFAULT_TAXONOMY.categories.some((c) => c.id === id);
      if (isDefault && target.memoryCategories.length > 0) {
        console.error(
          `Cannot remove default category "${id}" that maps MemoryCategory values: ${target.memoryCategories.join(", ")}. ` +
          `Reassign them first.`,
        );
        process.exit(1);
      }

      taxonomy.categories.splice(idx, 1);
      await saveTaxonomy(config.memoryDir, taxonomy);
      console.log(`Removed category "${id}".`);

      if (config.taxonomyAutoGenResolver) {
        const doc = generateResolverDocument(taxonomy);
        const resolverPath = path.join(config.memoryDir, ".taxonomy", "RESOLVER.md");
        fs.writeFileSync(resolverPath, doc);
        console.error(`Regenerated: ${resolverPath}`);
      }
      break;
    }

    case "resolve": {
      const resolveArgs = rest.slice(1);
      let parsedResolveArgs: ReturnType<typeof parseTaxonomyResolveArgs>;
      try {
        parsedResolveArgs = parseTaxonomyResolveArgs(resolveArgs);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      const textParts = parsedResolveArgs.textParts;
      const text = textParts.join(" ");
      if (!text) {
        console.error("Usage: remnic taxonomy resolve <text>");
        process.exit(1);
      }

      const categoryFlag = parsedResolveArgs.values["--category"] as MemoryCategory | undefined;
      const memoryCategory: MemoryCategory = categoryFlag ?? "fact";
      const taxonomy = await loadTaxonomy(config.memoryDir);
      const decision = resolveCategory(text, memoryCategory, taxonomy);
      const json = parsedResolveArgs.booleans.has("--json");

      if (json) {
        console.log(JSON.stringify(decision, null, 2));
      } else {
        console.log(`Category:   ${decision.categoryId}`);
        console.log(`Confidence: ${decision.confidence.toFixed(2)}`);
        console.log(`Reason:     ${decision.reason}`);
        if (decision.alternatives.length > 0) {
          console.log(`\nAlternatives:`);
          for (const alt of decision.alternatives.slice(0, 3)) {
            console.log(`  - ${alt.categoryId}: ${alt.reason}`);
          }
        }
      }
      break;
    }

    default:
      console.log(`
remnic taxonomy — MECE knowledge directory

Usage:
  remnic taxonomy show [--json]                     Show current taxonomy
  remnic taxonomy resolver                          Print/regenerate RESOLVER.md
  remnic taxonomy add <id> <name> [options]         Add a custom category
    --description <text>                              Category description
    --priority <number>                               Priority (lower wins, default 100)
    --memory-categories <list>                        Comma-separated MemoryCategory values
  remnic taxonomy remove <id>                       Remove a custom category
  remnic taxonomy resolve <text> [--category <cat>] Test: resolve text to a category
    --json                                            JSON output
`);
      break;
  }
}

// ── Training export ──────────────────────────────────────────────────────────

/**
 * Allowed values for `--format`. Derived dynamically from the registry so
 * any adapter registered via side-effect import (e.g. `@remnic/export-weclone`)
 * is auto-discovered without a hard-coded switch.
 *
 * CLAUDE.md #51: invalid formats must throw an error listing valid options,
 * not silently default. CLAUDE.md #52: the validator is the registry, so
 * there is no chance of an allow-list drifting from the handler map.
 */

interface ParsedTrainingExportArgs {
  format: string;
  output: string;
  memoryDir: string;
  since?: string;
  until?: string;
  minConfidence?: number;
  categories?: string[];
  includeEntities: boolean;
  synthesize: boolean;
  maxPairsPerRecord?: number;
  privacySweep: boolean;
  /**
   * Whether the user explicitly chose the privacy-sweep value on the
   * command line (via `--privacy-sweep` or `--no-privacy-sweep`). When
   * true, runtime code treats a mismatch with the adapter as a hard
   * error (don't silently skip something the user asked for). When
   * false, it means we're using the default, so we can downgrade to a
   * warning if the adapter doesn't support sweep.
   */
  privacySweepExplicit: boolean;
  dryRun: boolean;
}

/**
 * Resolve a value-taking flag, rejecting the "flag present but missing
 * value" case (e.g. `--memory-dir --since 2026-01-01`). CLAUDE.md #14
 * requires that `--foo` without an argument throws rather than silently
 * defaulting — critical here because `training:export` emits shareable
 * data and a wrongly-broadened filter would leak memories the user
 * intended to exclude (Codex review follow-up to PR #509).
 *
 * Returns `undefined` only when the flag is absent; throws when the flag
 * is present but its value is missing or shaped like another flag.
 */
function resolveRequiredValueFlag(
  args: string[],
  flag: string,
): string | undefined {
  if (!hasFlag(args, flag)) return undefined;
  const value = resolveFlagStrict(args, flag);
  if (value === undefined) {
    throw new Error(
      `${flag} requires a value. Provide it as \`${flag} <value>\`, not as a bare flag.`,
    );
  }
  return value;
}

/**
 * Parse `remnic capsule fork` argv into its required parts.
 *
 * Exported for testability (Codex P2 #751).
 *
 * Returns `{ sourceArchive, targetRoot, forkId }` on success.
 * Returns `{ error: string }` when a required argument is missing or when a
 * flag value is used as a positional (the classic `--target /path` with
 * omitted `<source-archive>` would treat `/path` as the archive when using a
 * naïve `filter((a) => !a.startsWith("--"))` approach — this parser skips
 * value-taking flag pairs so that cannot happen).
 *
 * Does NOT call `process.exit` — callers handle the error shape.
 */
export function parseCapsuleForkArgs(
  args: string[],
): { sourceArchive: string; targetRoot: string; forkId: string } | { error: string } {
  // Extract flag values first.
  const targetRoot = resolveRequiredValueFlag(args, "--target");
  const forkId = resolveRequiredValueFlag(args, "--fork-id");

  if (!targetRoot) {
    return { error: "capsule fork requires --target <dir>" };
  }
  if (!forkId) {
    return { error: "capsule fork requires --fork-id <id>" };
  }

  // Walk argv skipping value-taking flag pairs so their values are not
  // included as positionals. Each known value-taking flag (`--target`,
  // `--fork-id`) consumes the next token unless the value is inline
  // (`--flag=value`). Unknown flags are treated as bare (no value
  // consumption) — defensive against future flag additions.
  const VALUE_TAKING_FLAGS = new Set(["--target", "--fork-id"]);
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok.startsWith("--")) {
      if (!tok.includes("=") && VALUE_TAKING_FLAGS.has(tok)) {
        i += 1; // skip the value token that belongs to this flag
      }
      continue;
    }
    positionals.push(tok);
  }

  const sourceArchive = positionals[0];
  if (!sourceArchive) {
    return {
      error:
        "capsule fork requires a source archive path.\n" +
        "Usage: remnic capsule fork <source-archive> --target <root> --fork-id <id>",
    };
  }

  return { sourceArchive, targetRoot, forkId };
}

/**
 * Parse training:export CLI flags. Rejects unknown values and missing
 * flag values instead of silently defaulting, per CLAUDE.md #14/#51.
 *
 * Exported for testability.
 */
export function parseTrainingExportArgs(
  rest: string[],
  defaultMemoryDir: string,
): ParsedTrainingExportArgs {
  const format = resolveRequiredValueFlag(rest, "--format");
  if (!format) {
    throw new Error(
      "--format <name> is required. Run `remnic training:export --help` for the list of registered adapters.",
    );
  }

  // Parse --dry-run first so we can relax the --output requirement when the
  // user only wants statistics (Cursor review on PR #509: the help text and
  // the earlier error message both documented --dry-run as the
  // --output-optional escape hatch, but the old ordering unconditionally
  // required --output and made that combination impossible).
  const dryRun = hasFlag(rest, "--dry-run");

  // Accept --out as a short alias for --output (issue #459 spec uses both).
  const outputRaw =
    resolveRequiredValueFlag(rest, "--output") ??
    resolveRequiredValueFlag(rest, "--out");
  if (!outputRaw && !dryRun) {
    throw new Error(
      "--output <path> (or --out <path>) is required for training:export. " +
        "Use --dry-run to print statistics without writing a file.",
    );
  }
  // In dry-run mode, `runTrainingExport` never touches the filesystem, so
  // the output field is unused — we still populate it with a sentinel path
  // so the parsed-args contract has no optional field and downstream code
  // doesn't need to re-check dryRun before reading `output`.
  const output = outputRaw ? expandTilde(outputRaw) : "";

  // Expand ~ in BOTH the --memory-dir flag AND the default resolved dir
  // (CLAUDE.md #17: Node.js `fs` does not expand ~; apply it to every path
  // input consistently, not just the explicit flag). `resolveMemoryDir`
  // can surface a tilde-prefixed path from config or env — validating that
  // without expansion would reject otherwise-valid memory stores.
  const memoryDirFlag = resolveRequiredValueFlag(rest, "--memory-dir");
  const memoryDir = expandTilde(memoryDirFlag ?? defaultMemoryDir);

  const since = resolveRequiredValueFlag(rest, "--since");
  const until = resolveRequiredValueFlag(rest, "--until");

  const minConfidenceRaw = resolveRequiredValueFlag(rest, "--min-confidence");
  let minConfidence: number | undefined;
  if (minConfidenceRaw !== undefined) {
    const n = Number(minConfidenceRaw);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      throw new Error(
        `Invalid --min-confidence value "${minConfidenceRaw}": expected a number in [0, 1].`,
      );
    }
    minConfidence = n;
  }

  const categoriesRaw = resolveRequiredValueFlag(rest, "--categories");
  const categories = categoriesRaw
    ? categoriesRaw
        .split(",")
        .map((c) => c.trim())
        .filter((c) => c.length > 0)
    : undefined;

  const maxPairsRaw = resolveRequiredValueFlag(rest, "--max-pairs-per-record");
  let maxPairsPerRecord: number | undefined;
  if (maxPairsRaw !== undefined) {
    const n = Number(maxPairsRaw);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(
        `Invalid --max-pairs-per-record value "${maxPairsRaw}": expected a positive integer.`,
      );
    }
    maxPairsPerRecord = n;
  }

  const includeEntities = hasFlag(rest, "--include-entities");
  // `--synthesize` is off by default: it is a WeClone-specific enhancement that
  // turns Remnic's flat records into conversational Q/A pairs. Users of other
  // formats (or raw Alpaca) can opt out.
  const synthesize = hasFlag(rest, "--synthesize");
  // `--privacy-sweep` is on by default for WeClone and any other adapter
  // that will be shared as a training dataset. Off switch:
  // `--no-privacy-sweep`. We also track whether the choice was explicit
  // so runtime code can distinguish "user asked for this" (hard error
  // on mismatch) from "default, we can fall back with a warning".
  const privacySweepOff = hasFlag(rest, "--no-privacy-sweep");
  const privacySweepOn = hasFlag(rest, "--privacy-sweep");
  const privacySweepExplicit = privacySweepOff || privacySweepOn;
  const privacySweep = !privacySweepOff;

  return {
    format,
    output,
    memoryDir,
    since,
    until,
    minConfidence,
    categories,
    includeEntities,
    synthesize,
    maxPairsPerRecord,
    privacySweep,
    privacySweepExplicit,
    dryRun,
  };
}

/**
 * Run the full training-export pipeline end-to-end:
 *   memoryDir → convertMemoriesToRecords → (optional synthesize) →
 *   (optional PII sweep) → adapter.formatRecords → file
 *
 * Exported for integration tests so a harness can drive the full pipeline
 * without spawning a subprocess.
 */
export async function runTrainingExport(
  args: ParsedTrainingExportArgs,
  stdout: { write: (s: string) => void } = process.stdout,
): Promise<{
  recordsRead: number;
  recordsWritten: number;
  redactedCount: number;
  outputPath: string | null;
}> {
  const {
    convertMemoriesToRecords,
    getTrainingExportAdapter,
    listTrainingExportAdapters,
    parseStrictCliDate, registerTrainingExportAdapter,
  } = await loadTrainingExportCoreRuntime();

  // Resolve the adapter from the registry first. If the user picks a
  // non-weclone format (registered elsewhere), we never touch the
  // optional @remnic/export-weclone package. If the format isn't
  // registered yet, we lazily load weclone to register its adapter and
  // try again — that keeps weclone a true à-la-carte install while
  // still supporting `--format weclone` out of the box.
  // (Codex feedback on PR #545.)
  type WecloneExportModule = Awaited<ReturnType<typeof loadWecloneExportModule>>;
  type WecloneTrainingRecords = Parameters<WecloneExportModule["synthesizeTrainingPairs"]>[0];
  type WeclonePrivacyRecords = Parameters<WecloneExportModule["sweepPii"]>[0];
  let wecloneExport: WecloneExportModule | undefined;
  const ensureWeclone = async (): Promise<WecloneExportModule> => {
    if (!wecloneExport) {
      wecloneExport = await loadWecloneExportModule();
    }
    return wecloneExport;
  };

  let adapter = getTrainingExportAdapter(args.format);
  if (!adapter && args.format === "weclone") {
    // The format is specifically weclone and the adapter hasn't been
    // registered in this process yet. Only load the optional package
    // in this case — a typo or genuinely unsupported format should
    // surface the normal "unknown format" error below, not a weclone
    // install hint. (Codex feedback on PR #545.)
    const mod = await ensureWeclone();
    mod.ensureWecloneExportAdapterRegistered({ getTrainingExportAdapter, registerTrainingExportAdapter });
    adapter = getTrainingExportAdapter(args.format);
  }
  if (!adapter) {
    const registered = listTrainingExportAdapters();
    const validList =
      registered.length > 0
        ? `Valid formats: [${registered.join(", ")}]`
        : "No adapters are currently registered.";
    throw new Error(
      `Unknown training-export format "${args.format}". ${validList}`,
    );
  }

  if (!fs.existsSync(args.memoryDir)) {
    throw new Error(
      `--memory-dir "${args.memoryDir}" does not exist. Provide the path to an existing memory directory.`,
    );
  }
  if (!fs.statSync(args.memoryDir).isDirectory()) {
    throw new Error(
      `--memory-dir "${args.memoryDir}" is not a directory. Provide the path to a memory directory, not a file.`,
    );
  }

  // Parse date filters with the shared strict validator so behavior matches
  // the core CLI (rejects Feb 31, non-ISO strings, etc.).
  let since: Date | undefined;
  if (args.since) since = parseStrictCliDate(args.since, "--since");
  let until: Date | undefined;
  if (args.until) until = parseStrictCliDate(args.until, "--until");

  const convertOptions: TrainingExportOptions = {
    memoryDir: args.memoryDir,
    since,
    until,
    minConfidence: args.minConfidence,
    categories: args.categories,
    includeEntities: args.includeEntities,
  };

  let records: TrainingExportRecord[] = await convertMemoriesToRecords(convertOptions);
  const recordsRead = records.length;

  // synthesize and privacy-sweep currently live in @remnic/export-weclone
  // and produce weclone-shaped output. When the selected adapter isn't
  // the weclone one, we cannot run them — but we must NOT silently
  // skip privacy-sweep, because it's a security guard that defaults on
  // and a quiet no-op would let PII leak through plugin/custom formats.
  // Hard-fail with a clear remediation path instead, so users either
  // pick --format weclone or explicitly opt out with --no-privacy-sweep.
  // (Codex P2+P1 feedback on PR #545.)
  const adapterIsWeclone = adapter.name === "weclone";
  if (args.synthesize) {
    if (!adapterIsWeclone) {
      throw new Error(
        `--synthesize is only supported by --format weclone. Got --format ${adapter.name}. ` +
          `Either rerun with --format weclone or drop --synthesize.`,
      );
    }
    const mod = await ensureWeclone();
    records = mod.synthesizeTrainingPairs(records as unknown as WecloneTrainingRecords, {
      maxPairsPerRecord: args.maxPairsPerRecord,
    }) as unknown as TrainingExportRecord[];
  }

  let redactedCount = 0;
  if (args.privacySweep) {
    if (adapterIsWeclone) {
      const mod = await ensureWeclone();
      const swept = mod.sweepPii(records as unknown as WeclonePrivacyRecords);
      records = swept.cleanRecords as unknown as TrainingExportRecord[];
      redactedCount = swept.redactedCount;
    } else {
      // privacy-sweep defaults ON because training-export data is
      // shareable. The sweep itself is weclone-specific today, so on a
      // non-weclone adapter we refuse to export rather than silently
      // skip redaction (Codex P1 would have us fail; a warn-and-export
      // pattern would still leak PII). The error message makes the
      // opt-out path obvious so the "default breaks my plugin format"
      // complaint (Cursor Medium) is a one-flag fix, not a mystery.
      const explicitness = args.privacySweepExplicit
        ? "was requested"
        : "defaults on for training exports";
      throw new Error(
        `--privacy-sweep ${explicitness}, but --format "${adapter.name}" has no PII sweep implementation. ` +
          `To proceed safely, either:\n` +
          `  1. Rerun with --format weclone (which supports PII redaction), OR\n` +
          `  2. Pass --no-privacy-sweep to export ${adapter.name} records as-is (only do this after confirming they are safe to share).`,
      );
    }
  }

  if (args.dryRun) {
    stdout.write(`Training export dry run\n`);
    stdout.write(`Format: ${adapter.name}\n`);
    stdout.write(`Records read: ${recordsRead}\n`);
    stdout.write(`Records to write: ${records.length}\n`);
    if (args.privacySweep) {
      stdout.write(`Redacted records: ${redactedCount}\n`);
    }
    const cats = new Map<string, number>();
    for (const r of records) {
      const c = r.category ?? "unknown";
      cats.set(c, (cats.get(c) ?? 0) + 1);
    }
    const sortedCats = [...cats.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    for (const [cat, count] of sortedCats) {
      stdout.write(`  ${cat}: ${count}\n`);
    }
    return {
      recordsRead,
      recordsWritten: 0,
      redactedCount,
      outputPath: null,
    };
  }

  // Defensive: the CLI parser requires --output when --dry-run is absent,
  // but programmatic callers construct ParsedTrainingExportArgs directly.
  // Fail loudly rather than write to an empty-string path that the shell
  // might resolve to cwd in surprising ways.
  if (!args.output) {
    throw new Error(
      "runTrainingExport: `output` is required when dryRun is false. " +
        "Pass dryRun: true to skip file I/O.",
    );
  }

  const formatted = adapter.formatRecords(records);

  // Ensure parent directory exists before writing. Use atomic rename to
  // avoid partial-write corruption (CLAUDE.md #54: never delete before
  // successful write).
  const outDir = path.dirname(args.output);
  fs.mkdirSync(outDir, { recursive: true });
  const tmpPath = `${args.output}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, formatted, "utf-8");
  fs.renameSync(tmpPath, args.output);

  stdout.write(
    `Exported ${records.length} records to ${args.output} (${adapter.name} format)\n`,
  );
  if (args.privacySweep && redactedCount > 0) {
    stdout.write(`Privacy sweep redacted PII in ${redactedCount} record(s).\n`);
  }
  return {
    recordsRead,
    recordsWritten: records.length,
    redactedCount,
    outputPath: args.output,
  };
}

// ── CLI entry ────────────────────────────────────────────────────────────────

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv;
  if (command !== "migrate") {
    await migrateFromEngram();
  }

  switch (command as CommandName) {
    case "init":
      cmdInit();
      break;

    case "migrate": {
      const json = rest.includes("--json");
      const rollback = rest.includes("--rollback");
      await cmdMigrate(json, rollback);
      break;
    }

    case "status": {
      const json = rest.includes("--json");
      await cmdStatus(json);
      break;
    }

    case "query": {
      const json = rest.includes("--json");
      const explain = rest.includes("--explain");
      const queryText = rest.filter((a) => !a.startsWith("--")).join(" ");
      await cmdQuery(queryText, json, explain);
      break;
    }
    case "recall":
      await runRecallNavigateCommand(rest);
      break;

    case "action-confidence":
      await cmdActionConfidence(rest);
      break;

    case "xray":
      await cmdXray(rest);
      break;
    case "who-knows":
      await cmdWhoKnows(rest); // `remnic who-knows "<topic>"` — expertise ranking (#2057).
      break;
    case "promotion-candidates":
      await cmdPromotionCandidates(rest); // `remnic promotion-candidates` — #2372 candidate surfacing.
      break;
    case "security":
      await cmdSecurity(rest);
      break;
    case "doctor":
      await cmdDoctor();
      break;

    case "config":
      cmdConfig();
      break;

    case "daemon": {
      const action = rest[0] as DaemonAction;
      if (action === "start" || action === "install" || action === "restart") {
        refuseLocalDaemonIfHostedOnly(action);
      }
      switch (action) {
        case "start":
          daemonStart();
          break;
        case "stop":
          daemonStop();
          break;
        case "restart":
          daemonRestart();
          break;
        case "install":
          daemonInstall();
          break;
        case "uninstall":
          daemonUninstall();
          break;
        case "status":
          await daemonStatus();
          break;
        default:
          console.log("Usage: remnic daemon <start|stop|restart|install|uninstall|status>");
          process.exit(1);
      }
      break;
    }

    case "token": {
      const action = rest[0] as TokenAction;
      const json = rest.includes("--json");
      switch (action) {
        case "generate":
          cmdTokenGenerate(rest.slice(1));
          break;
        case "list":
          cmdTokenList(json);
          break;
        case "revoke":
          cmdTokenRevoke(rest[1]);
          break;
        default:
          console.log("Usage: remnic token <generate|list|revoke> [connector-id] [--json]");
          process.exit(1);
      }
      break;
    }

    case "tree": {
      const subAction = rest[0];
      const json = rest.includes("--json");
      const outputDir = resolveFlag(rest, "--output") ?? path.join(process.cwd(), ".remnic", "context-tree");
      const categoriesFlag = resolveFlag(rest, "--categories");
      const categories = categoriesFlag ? categoriesFlag.split(",") : undefined;
      const maxPerCategoryRaw = resolveFlag(rest, "--max-per-category");
      let maxPerCategory: number | undefined;
      if (maxPerCategoryRaw !== undefined) {
        maxPerCategory = parseInt(maxPerCategoryRaw, 10);
        if (!Number.isFinite(maxPerCategory) || maxPerCategory < 1) {
          console.error(`Invalid --max-per-category: ${maxPerCategoryRaw}`);
          process.exit(1);
        }
      }

      if (subAction === "generate") {
        const result = await generateContextTree({
          memoryDir: resolveMemoryDir(),
          outputDir,
          categories,
          maxPerCategory,
          includeEntities: !rest.includes("--no-entities"),
          includeQuestions: !rest.includes("--no-questions"),
        });
        if (json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Context tree generated at ${result.outputDir}`);
          console.log(`  Nodes: ${result.nodesGenerated} generated, ${result.nodesSkipped} skipped`);
          for (const [cat, count] of Object.entries(result.categories)) {
            console.log(`  ${cat}: ${count}`);
          }
          console.log(`  Duration: ${result.durationMs}ms`);
        }
      } else if (subAction === "watch") {
        const memoryDir = resolveMemoryDir();
        console.log(`Watching ${memoryDir} for changes…`);
        console.log(`Output: ${outputDir}`);
        console.log("Press Ctrl+C to stop.\n");

        // Initial generation
        const initial = await generateContextTree({
          memoryDir,
          outputDir,
          categories,
          maxPerCategory,
          includeEntities: !rest.includes("--no-entities"),
          includeQuestions: !rest.includes("--no-questions"),
        });
        console.log(`Initial: ${initial.nodesGenerated} nodes (${initial.durationMs}ms)`);

        // Debounced watcher
        let debounceTimer: ReturnType<typeof setTimeout> | null = null;
        const rebuild = () => {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(async () => {
            const t0 = Date.now();
            try {
              const result = await generateContextTree({
                memoryDir,
                outputDir,
                categories,
                maxPerCategory,
                includeEntities: !rest.includes("--no-entities"),
                includeQuestions: !rest.includes("--no-questions"),
              });
              console.log(`[${new Date().toISOString()}] Rebuilt: ${result.nodesGenerated} nodes (${Date.now() - t0}ms)`);
            } catch (err) {
              console.error(`[${new Date().toISOString()}] Rebuild failed:`, err instanceof Error ? err.message : err);
            }
          }, 500);
        };

        fs.watch(memoryDir, { recursive: true }, (_event, filename) => {
          if (filename && filename.startsWith(".")) return;
          rebuild();
        });

        // Keep process alive
        await new Promise(() => {});
      } else if (subAction === "validate") {
        const treeDir = outputDir;
        if (!fs.existsSync(treeDir)) {
          console.error(`Context tree not found at ${treeDir}. Run 'remnic tree generate' first.`);
          process.exit(1);
        }
        const indexPath = path.join(treeDir, "INDEX.md");
        if (!fs.existsSync(indexPath)) {
          console.error(`INDEX.md missing in ${treeDir}. Tree may be corrupt — regenerate.`);
          process.exit(1);
        }
        console.log(`Context tree at ${treeDir} is valid.`);
      } else {
        console.log(`Usage: remnic tree <generate|watch|validate>
  generate                Generate context tree from memory
  watch                   Watch memory dir and regenerate on changes
  validate                Check that context tree exists and is valid

Options:
  --output <dir>          Output directory (default: .remnic/context-tree)
  --categories <list>     Comma-separated categories to include
  --max-per-category <n>  Max nodes per category
  --no-entities           Exclude entity nodes
  --no-questions          Exclude question nodes
  --json                  JSON output (generate only)`);
      }
      break;
    }

    case "onboard": {
      const dir = rest[0] ?? ".";
      const json = rest.includes("--json");
      cmdOnboard(dir, json);
      break;
    }

    case "curate": {
      const targetPath = rest[0];
      const json = rest.includes("--json");
      if (!targetPath) {
        console.error("Usage: remnic curate <path>");
        process.exit(1);
      }
      await cmdCurate(targetPath, json);
      break;
    }

    case "review": {
      const action = rest[0] ?? "list";
      await cmdReview(action, rest.slice(1));
      break;
    }

    case "sync": {
      const action = rest[0] ?? "run";
      const json = rest.includes("--json");
      await cmdSync(action, rest.slice(1), json);
      break;
    }

    case "offline": {
      const action = rest[0] ?? "help";
      const json = rest.includes("--json");
      await cmdOffline(action, rest.slice(1), json);
      break;
    }
    case "converge": {
      const action = rest[0] ?? "plan";
      const json = rest.includes("--json");
      const args = rest.slice(1);
      if (
        action === "help"
        || action === "--help"
        || action === "-h"
        || args.includes("--help")
        || args.includes("-h")
      ) {
        await cmdConverge(action, args, json);
        break;
      }
      const config = loadConvergeCommandConfig();
      await cmdConverge(action, args, json, config);
      break;
    }

    case "oauth": {
      // `remnic oauth <pending|approve|deny> [...]` — operator-side
      // management of pending ChatGPT-MCP authorization requests. All
      // network and rendering logic lives in cmdOAuth; the dispatcher
      // just routes the slice.
      await cmdOAuth(rest);
      break;
    }

    case "dedup": {
      const json = rest.includes("--json");
      cmdDedup(json);
      break;
    }

    case "connectors": {
      const action = rest[0] ?? "list";
      const json = rest.includes("--json");
      await cmdConnectors(action, rest.slice(1), json);
      break;
    }

    case "quarantine": {
      const action = rest[0] ?? "list";
      const json = rest.includes("--json");
      await cmdQuarantine(action, rest.slice(1), json);
      break;
    }

    case "space": {
      const action = rest[0] ?? "list";
      const json = rest.includes("--json");
      await cmdSpace(action, rest.slice(1), json);
      break;
    }

    case "bench": {
      await cmdBench(rest);
      break;
    }

    case "benchmark": {
      await cmdBench(rest);
      break;
    }

    case "briefing": {
      await cmdBriefing(rest);
      break;
    }

    case "versions": {
      await cmdVersions(rest);
      break;
    }

    case "binary": {
      await cmdBinary(rest);
      break;
    }

    case "taxonomy": {
      await cmdTaxonomy(rest);
      break;
    }

    case "enrich": {
      await cmdEnrich(rest);
      break;
    }

    case "procedural": {
      await runProceduralBinaryCommand(rest);
      break;
    }

    case "drift": {
      await runDriftBinaryCommand(rest);
      break;
    }

    case "extensions": {
      const action = rest[0] ?? "help";
      await cmdExtensions(action, rest.slice(1));
      break;
    }

    case "training:export": {
      if (rest.includes("--help") || rest.includes("-h")) {
        console.log(`
remnic training:export — Export Remnic memories as fine-tuning datasets (issue #459)

Usage:
  remnic training:export --format <name> --output <path> [options]

Required:
  --format <name>              Registered adapter name (e.g. weclone)
  --output <path> | --out      Path to write the dataset file

Filters:
  --memory-dir <path>          Memory directory (defaults to resolved memoryDir)
  --since <YYYY-MM-DD[T...]>   Only include memories created at or after this date
  --until <YYYY-MM-DD[T...]>   Only include memories created before this date (exclusive)
  --min-confidence <0..1>      Inclusive lower bound on memory confidence
  --categories <list>          Comma-separated category filter (fact,preference,...)
  --include-entities           Also read from entities/ (off by default)

Adapter options:
  --synthesize                 Generate conversational Q/A pairs (WeClone-optimised)
  --max-pairs-per-record <n>   When --synthesize, max pairs emitted per memory
  --no-privacy-sweep           Skip the final PII redaction pass (default: on)

Other:
  --dry-run                    Print statistics only; do not write the file
`);
        break;
      }
      let parsed: ParsedTrainingExportArgs;
      try {
        parsed = parseTrainingExportArgs(rest, resolveMemoryDir());
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      try {
        await runTrainingExport(parsed);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      break;
    }

    case "wearables": {
      // Wearable transcript sources (Limitless / Bee / Omi). All parsing,
      // validation, and rendering live in @remnic/core's shared runner —
      // commands/wearables.ts boots the one-shot orchestrator.
      await runWearablesBinaryCommand(rest);
      break;
    }

    case "meetings": {
      await runMeetingsBinaryCommand(rest);
      break;
    }
    case "timeline": {
      await runTimelineBinaryCommand(rest);
      break;
    }
    case "location":
      await runLocationBinaryCommand(rest);
      break;
    case "okf":
      await runOkfBinaryCommand(rest);
      break;
    case "export":
      await runExportOkfBinaryCommand(rest);
      break;
    case "standup":
      await runStandupBinaryCommand(rest);
      break;
    case "journal":
      await runJournalBinaryCommand(rest);
      break;
    case "journal-vault":
      await runJournalVaultBinaryCommand(rest);
      break;
    case "activity-privacy":
      await runActivityPrivacyBinaryCommand(rest);
      break;
    case "activity-export":
      await runActivityExportBinaryCommand(rest);
      break;
    case "vault-publish":
      await runVaultPublishBinaryCommand(rest);
      break;
    case "codegraph":
      await runCodegraphBinaryCommand(rest);
      break;

    case "external-wiki": {
      await runExternalWikiBinaryCommand(rest);
      break;
    }

    case "import": {
      if (rest.includes("--help") || rest.includes("-h") || rest.length === 0) {
        console.log(IMPORT_USAGE);
        break;
      }

      // Lazy orchestrator factory: only invoked when the run actually needs
      // to write memories. `--dry-run`, `--help`, and install-hint failures
      // all short-circuit BEFORE touching the memory store, keeping
      // responsiveness high for the common "preview what would be imported"
      // path (Cursor review on PR #583).
      let orchestratorSingleton: Orchestrator | undefined;
      const targetFactory = async () => {
        if (!orchestratorSingleton) {
          const configPath = resolveConfigPath();
          const raw = fs.existsSync(configPath)
            ? JSON.parse(fs.readFileSync(configPath, "utf8"))
            : {};
          const remnicCfg = resolveRemnicConfigRecord(raw);
          const config = parseConfig(remnicCfg);
          orchestratorSingleton = new Orchestrator(config);
          await orchestratorSingleton.initialize();
          await orchestratorSingleton.deferredReady;
        }
        return orchestratorSingleton;
      };
      const dispose = async () => {
        if (!orchestratorSingleton) return;
        const maybeShutdown = (
          orchestratorSingleton as unknown as { shutdown?: () => Promise<void> }
        ).shutdown;
        if (typeof maybeShutdown === "function") {
          try {
            await maybeShutdown.call(orchestratorSingleton);
          } catch {
            // Best effort — orchestrator shutdown errors must not mask
            // import results on short-lived CLI runs.
          }
        }
      };
      await cmdImport(rest, targetFactory, dispose);
      break;
    }

    case "import-lossless-claw": {
      // SQLite→SQLite migration of a lossless-claw LCM database into
      // Remnic's LCM mode. Distinct from `remnic import` because the data
      // model is structurally different (turns + summary DAG, not facts)
      // and the destination is the LCM SQLite store, not the orchestrator.
      const exitCode = await cmdImportLosslessClaw(rest, {
        resolveMemoryDir,
        stdout: (line) => console.log(line),
        stderr: (line) => console.error(line),
      });
      if (exitCode !== 0) process.exit(exitCode);
      break;
    }

    case "capture": {
      // `remnic capture audio <sub>` forwards to the optional
      // @remnic/capture-audio CLI (loaded via computed-specifier dynamic
      // import; clean install hint when absent — issue #1897).
      const exitCode = await cmdCapture(rest, {
        stdout: (line) => console.log(line),
        stderr: (line) => console.error(line),
      });
      if (exitCode !== 0) process.exit(exitCode);
      break;
    }

    case "capsule": {
      // `remnic capsule fork <source-archive> --target <root> --fork-id <id>`
      // Issue #676 PR 4/6: formalise fork semantics — lineage breadcrumb +
      // parent-capsule linkage.
      const subAction = rest[0] ?? "help";
      const capsuleArgs = rest.slice(1);

      if (subAction === "fork") {
        if (capsuleArgs.includes("--help") || capsuleArgs.includes("-h")) {
          console.log(`Usage: remnic capsule fork <source-archive> --target <root> --fork-id <id>

Fork a capsule archive into a memory root. Records are imported under
forks/<source-capsule-id>/ and a lineage breadcrumb is written to
forks/<fork-id>/lineage.json.

Arguments:
  <source-archive>         Path to a .capsule.json.gz archive

Options:
  --target <dir>           Target memory root (required)
  --fork-id <id>           Unique fork identifier (required)
  --help / -h              Show this help`);
          break;
        }

        // Delegate to the exported parser so the positional/flag separation
        // logic is independently testable (Codex P2 #751).
        const forkParsed = parseCapsuleForkArgs(capsuleArgs);
        if ("error" in forkParsed) {
          console.error(`ERROR: ${forkParsed.error}`);
          process.exit(1);
        }
        const { sourceArchive, targetRoot, forkId } = forkParsed;

        try {
          const result = await forkCapsule({
            sourceArchive: expandTilde(sourceArchive),
            targetRoot: expandTilde(targetRoot),
            forkId,
          });
          const { lineage, lineagePath, importResult } = result;
          console.log(`Fork complete.`);
          console.log(`  Fork ID        : ${lineage.forkId}`);
          console.log(`  Parent capsule : ${lineage.parent.capsuleId} @ ${lineage.parent.version}`);
          console.log(`  Fork root      : ${lineage.parent.forkRoot}`);
          console.log(`  Imported       : ${importResult.imported.length} records`);
          console.log(`  Skipped        : ${importResult.skipped.length} records`);
          console.log(`  Lineage        : ${lineagePath}`);
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
      } else if (subAction === "lineage") {
        // `remnic capsule lineage --root <dir> --fork-id <id>`
        // Read and print the lineage breadcrumb for a fork.
        const forkId = resolveRequiredValueFlag(capsuleArgs, "--fork-id");
        const root = resolveRequiredValueFlag(capsuleArgs, "--memory-dir") ??
          resolveRequiredValueFlag(capsuleArgs, "--root");

        if (!forkId) {
          console.error("ERROR: capsule lineage requires --fork-id <id>");
          process.exit(1);
        }
        if (!root) {
          console.error("ERROR: capsule lineage requires --root <dir> or --memory-dir <dir>");
          process.exit(1);
        }

        try {
          const lineage = await readForkLineage(expandTilde(root), forkId);
          if (!lineage) {
            console.error(`No lineage breadcrumb found for fork "${forkId}" in ${root}`);
            process.exit(1);
          }
          console.log(JSON.stringify(lineage, null, 2));
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
      } else {
        console.log(`Usage: remnic capsule <subcommand> [options]

Subcommands:
  fork <archive> --target <dir> --fork-id <id>
      Fork a capsule archive into a memory root.

  lineage --fork-id <id> --root <dir>
      Print the lineage breadcrumb for a fork.

Run 'remnic capsule <subcommand> --help' for subcommand details.`);
      }
      break;
    }

    case "openclaw": {
      const subAction = rest[0] ?? "help";
      const args = rest.slice(1);
      if (subAction === "install") {
        const yes = args.includes("--yes") || args.includes("-y") || args.includes("--force");
        const dryRun = args.includes("--dry-run");
        const memoryDir = resolveRequiredValueFlag(args, "--memory-dir");
        const configOverride = resolveRequiredValueFlag(args, "--config");
        await cmdOpenclawInstall({ yes, dryRun, memoryDir, configPath: configOverride });
      } else if (subAction === "upgrade" || subAction === "migrate-engram") {
        const yes = args.includes("--yes") || args.includes("-y") || args.includes("--force");
        const dryRun = args.includes("--dry-run");
        const memoryDir = resolveRequiredValueFlag(args, "--memory-dir");
        const configOverride = resolveRequiredValueFlag(args, "--config");
        const version = resolveRequiredValueFlag(args, "--version");
        const pluginDir = resolveRequiredValueFlag(args, "--plugin-dir");
        const legacyPluginDir = resolveRequiredValueFlag(args, "--legacy-plugin-dir");
        const restartGateway = !args.includes("--no-restart");
        const opts = {
          yes,
          dryRun,
          memoryDir,
          configPath: configOverride,
          pluginDir,
          version,
          restartGateway,
          legacyPluginDirForBackup: legacyPluginDir,
        };
        if (subAction === "migrate-engram") {
          await cmdOpenclawMigrateEngram(opts);
        } else {
          await cmdOpenclawUpgrade(opts);
        }
      } else {
        console.log(`Usage: remnic openclaw <install|upgrade|migrate-engram>

  install    Configure OpenClaw to use Remnic as the memory plugin.
  upgrade    Backup the current setup, refresh the published npm package, and re-apply the config.
  migrate-engram
             Migrate a legacy @joshuaswarren/openclaw-engram install to
             @remnic/plugin-openclaw while backing up the legacy extension.

             Sets plugins.entries["${REMNIC_OPENCLAW_PLUGIN_ID}"] and plugins.slots.memory
             in $OPENCLAW_STATE_DIR/openclaw.json, ~/.openclaw/openclaw.json, or $OPENCLAW_CONFIG_PATH.

Options:
  --yes / -y / --force    Skip interactive prompts, assume Y
  --dry-run               Print resulting config diff without writing
  --memory-dir <path>     Override the OpenClaw state-root memory dir
  --config <path>         Override OpenClaw config path
  --version <tag>         Upgrade @remnic/plugin-openclaw from a specific npm tag/version
  --plugin-dir <path>     Override the OpenClaw state-root extension dir
  --legacy-plugin-dir <path>
                          Override legacy extension dir backed up by migrate-engram
  --no-restart            Skip the final launchctl kickstart after upgrade`);
      }
      break;
    }

    default:
      console.log(`
remnic — Remnic memory CLI

Usage:
  remnic init                  Create config file
  remnic migrate [--rollback] [--json]  Run or undo first-run Engram migration
  remnic status [--json]       Show server status
  remnic query <text> [--json] [--explain] Query memories (use --explain for tier breakdown)
  remnic xray <query> [--format text|markdown|json] [--budget <chars>] [--namespace <ns>] [--out <path>]
    Run a recall with X-ray capture and print the unified snapshot
    (tier + audit + MMR + filters). Part of #570. Text output by default.
  remnic who-knows <topic> [--limit N] [--json] [--namespace <ns>]  Rank entities by topic expertise
  remnic wearables <status|check|sync|transcript|search|memories|speakers|corrections>
    Wearable transcript sources (Limitless / Bee / Omi): pull + clean +
    store day transcripts, trust-gated memory creation, speaker labels,
    and per-user corrections. Run "remnic wearables help" for details.
    Connectors install à la carte: npm install @remnic/connector-limitless
  remnic meetings <list|show|build>
    Retrospective meetings: list, show, or build a day's meetings.
    Run "remnic meetings help" for details.
  remnic location <status|check|sync|backfill|day>
    Location day sync from registered providers (e.g. Reitti, issue #2047).
    Run "remnic location help" for details.
  remnic okf <lint|sweep> [--json]
    OKF v0.1 conformance: lint reports missing frontmatter/type findings,
    sweep backfills missing type values (okf.sweepEnabled).
  remnic export okf --out <dir>
    Write a portable OKF v0.1 knowledge bundle (plaintext interchange).
  remnic standup [--date YYYY-MM-DD]
    Deterministic yesterday/today/blockers brief plus an activity grid.
  remnic external-wiki search <query...> [--wiki-id <id>] [--limit <1-20>] [--max-chars-per-hit <100-8000>] [--json]
  remnic doctor                Run diagnostics
  remnic config                Show current config
  remnic openclaw install      Configure OpenClaw to use Remnic memory (sets slot + entry)
  remnic openclaw upgrade      Safe OpenClaw npm upgrade with backups and gateway restart
  remnic openclaw migrate-engram
    Migrate legacy @joshuaswarren/openclaw-engram installs with legacy extension backup
    Run "remnic openclaw migrate-engram" for the full option list.
  remnic daemon <start|stop|restart|install|uninstall|status>  Manage background server
  remnic token <generate|list|revoke> [connector-id]  Manage auth tokens
  remnic tree <generate|watch|validate>  Generate context tree
  remnic onboard [dir] [--json]     Onboard project directory
  remnic curate <path> [--json]  Curate files into memory
  remnic review <list|approve|dismiss|flag> [id]  Review inbox
  remnic sync <run|watch> [--source <dir>] Diff-aware sync
  remnic offline <prepare|sync|status|watch> Remote/offline memory sync
  remnic oauth <pending|approve|deny> Manage pending OAuth authorizations (ChatGPT MCP)
  remnic dedup [--json]             Find duplicate memories
  remnic connectors <list|install|remove|doctor|marketplace> [id]  Manage connectors
    marketplace generate    Generate marketplace.json for Codex
    marketplace validate    Validate a marketplace.json file
    marketplace install     Install from a marketplace source
  remnic quarantine <list|replay> [--namespace <ns>] [--principal <p>] [--json]  Inspect/replay ACL-rejected writes
  remnic extensions <list|show|validate|reload>  Manage memory extensions
  remnic space <list|switch|create|delete|push|pull|share|promote|audit>  Manage spaces
    create accepts --parent <id> to set parent-child relationship
  remnic bench <list|run|published|datasets|runs|compare|results|baseline|export|publish|ui|providers|judge-calibrate|attribute|drift-gen|coding|security> [benchmark...] [--quick] [--all] [--dataset-dir <path>] [--results-dir <path>] [--baselines-dir <path>] [--threshold <value>] [--detail] [--format <json|csv|html>] [--output <path>] [--target remnic-ai] [--json]
    benchmark is kept as a compatibility alias. check/report remain under that alias.
  remnic benchmark <list|run|datasets|runs|compare|results|baseline|export|publish|ui|providers|check|report|attribute|drift-gen|coding|security> [queries...] [--explain] [--baseline=<path>] [--report=<path>]
  remnic briefing [--since <window>] [--focus <filter>] [--save] [--format markdown|json]
    Daily context briefing. Windows: yesterday, today, NNh, NNd, NNw.
    Focus: person:<name>, project:<name>, topic:<name>.
  remnic versions <list|show|diff|revert> <page-path> [id] [--json]
    Page-level versioning: list, show, diff, or revert page snapshots.
  remnic binary scan               Scan for untracked binary files
  remnic binary status             Show binary lifecycle manifest summary
  remnic binary run [--dry-run]    Run full binary lifecycle pipeline
  remnic binary clean --force      Force-clean binaries past grace period
  remnic taxonomy <show|resolver|add|remove|resolve>  MECE knowledge directory
    show [--json]                     Show current taxonomy
    resolver                          Print/regenerate RESOLVER.md
    add <id> <name> [--priority N]    Add custom category
    remove <id>                       Remove custom category
    resolve <text> [--category <cat>] Test resolver on sample text
  remnic enrich <entity-name>    Manually enrich a specific entity
  remnic enrich --all            Enrich all entities
  remnic enrich --dry-run        Preview what would be enriched
  remnic enrich audit            Show recent enrichment audit log
  remnic enrich providers        List registered providers and their status
  remnic procedural stats [--format json|text] [--memory-dir <path>]
    Print procedural memory stats (counts + recency + config). Mirrors
    GET /engram/v1/procedural/stats and remnic.procedural_stats MCP tool
    (issue #567).
  remnic procedural maintain [--apply] [--format json|text] [--memory-dir <path>]
    Run procedure library-health maintenance (issue #2370): shadow report of
    merge / repair-flag / retire proposals from outcome telemetry; --apply
    executes them (requires procedural.maintenance.enabled). Mirrors the
    remnic.procedure_library_maintenance MCP tool.
  remnic drift scan [--apply] [--namespace <ns>] [--format json|text] [--memory-dir <path>]
    Run preference drift detection (issue #2371): classify aging preference
    memories as corroborated / stale / drifted from recent evidence; --apply
    stamps lastCorroborated / driftState and opens a review item per drifted
    preference (requires driftDetection.enabled). Mirrors the
    remnic.preference_drift_scan MCP tool.
  remnic training:export --format <name> --output <path> [options]
    Export memories as a fine-tuning dataset (issue #459). Run
    'remnic training:export --help' for the full option list.
  remnic import --adapter <name> --file <path> [--dry-run] [--batch-size <n>]
    Import memory from ChatGPT/Claude/Gemini/Mem0 exports (issue #568).
    Run 'remnic import --help' for the full adapter list.
  remnic import-lossless-claw --src <path> [--dry-run] [--session-filter <id>]
    Migrate a lossless-claw LCM database into Remnic's LCM mode. Run
    'remnic import-lossless-claw --help' for full usage.
  remnic capsule fork <archive> --target <dir> --fork-id <id>
    Fork a capsule archive into a memory root. Records land under
    forks/<source-capsule-id>/ and a lineage breadcrumb is written to
    forks/<fork-id>/lineage.json (issue #676 PR 4/6).
  remnic capsule lineage --fork-id <id> --root <dir>
    Print the fork lineage breadcrumb for a given fork id.

Options:
  --json    Output in JSON format
  --help    Show this help
`);
      break;
  }
}

function waitForStreamDrain(stream: NodeJS.WriteStream): Promise<void> {
  if (!stream.writableNeedDrain) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    stream.once("drain", resolve);
  });
}

function activeNonStdioHandleCount(): number {
  const getActiveHandles = (process as unknown as {
    _getActiveHandles?: () => unknown[];
  })._getActiveHandles;
  const handles = getActiveHandles?.call(process) ?? [];
  return handles.filter((handle) => {
    const fd = (handle as { fd?: unknown })?.fd;
    return fd !== 0 && fd !== 1 && fd !== 2;
  }).length;
}

async function armCliSuccessExitWatchdog(): Promise<void> {
  const exitCode = process.exitCode ?? 0;
  process.exitCode = exitCode;

  await Promise.race([
    Promise.allSettled([
      waitForStreamDrain(process.stdout),
      waitForStreamDrain(process.stderr),
    ]),
    new Promise((resolve) => setTimeout(resolve, CLI_OUTPUT_FLUSH_GRACE_MS)),
  ]);

  const watchdog = setTimeout(() => {
    if (activeNonStdioHandleCount() > 0) {
      try {
        process.stderr.write(
          `Warning: remnic CLI forced a clean exit after ${CLI_SUCCESS_EXIT_GRACE_MS}ms because a handle remained open.\n`,
        );
      } catch {
        // Ignore write failures during forced shutdown.
      }
    }
    process.exit(exitCode);
  }, CLI_SUCCESS_EXIT_GRACE_MS);
  watchdog.unref?.();
}

// Auto-run when executed directly (covers: remnic and legacy engram entrypoints,
// or invoked via wrappers that set REMNIC_CLI_BIN / ENGRAM_CLI_BIN)
const argv1 = process.argv[1] ?? "";
const argv1Base = argv1.replace(/\\/g, "/");
if (
  argv1Base.endsWith("remnic.ts") ||
  argv1Base.endsWith("remnic.js") ||
  argv1Base.endsWith("engram.ts") ||
  argv1Base.endsWith("engram.js") ||
  argv1Base.endsWith("/remnic") ||
  argv1Base.endsWith("/engram") ||
  argv1Base.includes("packages/remnic-cli/src/index.") ||
  process.env.REMNIC_CLI_BIN === "1" ||
  process.env.ENGRAM_CLI_BIN === "1"
) {
  main()
    .then(() => armCliSuccessExitWatchdog())
    .catch((err) => {
      process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
