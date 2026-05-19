/**
 * @remnic/cli
 *
 * Command-line interface for Remnic memory.
 *
 * Commands:
 *   init              Create remnic.config.json in the current directory
 *   status            Show server/daemon status
 *   query <text>      Query memories
 *   xray <query>      Recall with X-ray capture; renders tier + filters + scores
 *   doctor            Run diagnostics
 *   config            Show current config
 *   daemon start      Start background server
 *   daemon stop       Stop background server
 *   daemon restart    Restart background server
 *   daemon install    Install as system service (launchd/systemd)
 *   daemon uninstall  Remove system service
 *   daemon status     Show daemon status
 *   token generate    Generate auth token for a connector
 *   token list        List all auth tokens
 *   token revoke      Revoke auth token for a connector
 *   bench list        List published benchmark packs
 *   bench run         Run published benchmark packs
 *   bench publish     Generate the Remnic.ai benchmark feed
 *   bench ui          Launch the local benchmark overview UI
 *   tree              Generate context tree
 *   onboard [dir]     Onboard project directory
 *   curate <path>     Curate files into memory
 *   review            Review inbox management
 *   sync              Diff-aware sync
 *   dedup             Find duplicate memories
 *   connectors        Manage host adapters
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as childProcess from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  parseConfig,
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
  computeProcedureStats,
  formatProcedureStatsText,
  parseXrayCliOptions,
  renderXray,
  buildActionConfidenceInputFromOptions,
  evaluateActionConfidence,
  renderActionConfidenceText,
  expandTildePath,
  // capsule fork — issue #676 PR 4/6
  forkCapsule,
  readForkLineage,
} from "@remnic/core";
// @remnic/export-weclone is an optional install surface (training:export
// only uses it). Load lazily so the CLI works without it — see
// optional-weclone-export.ts for the install-hint behaviour.
import { loadWecloneExportModule } from "./optional-weclone-export.js";
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
  cleanupRollbackDirectoryBestEffort,
  createOpenclawUpgradeRollbackFailure,
  runBestEffortGatewayRestart,
  rollbackOpenclawUpgrade,
  swapDirectoryWithRollback,
} from "./openclaw-upgrade-swap.js";
import { expandTilde, resolveHomeDir } from "./path-utils.js";
import {
  inspectLaunchdPlist,
  launchdLoadPlist,
  launchdUnloadPlist,
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
import { cmdImportLosslessClaw } from "./import-lossless-claw-cmd.js";

export { parseConnectorConfig, stripConfigArgv };
export {
  type BenchAction,
  type ParsedBenchArgs,
  parseBenchArgs,
} from "./bench-args.js";

type PiPublisherModule = {
  PiMemoryExtensionPublisher: new () => MemoryExtensionPublisher;
};

class LazyPiMemoryExtensionPublisher implements MemoryExtensionPublisher {
  readonly hostId = "pi";
  private delegate: Promise<MemoryExtensionPublisher> | undefined;

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
      .then((mod) => new mod.PiMemoryExtensionPublisher())
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
registerPublisher("pi", () => new LazyPiMemoryExtensionPublisher());

// ── Types ────────────────────────────────────────────────────────────────────

type CommandName =
  | "init"
  | "migrate"
  | "status"
  | "query"
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
  | "space"
  | "bench"
  | "benchmark"
  | "briefing"
  | "versions"
  | "binary"
  | "taxonomy"
  | "enrich"
  | "procedural"
  | "openclaw"
  | "extensions"
  | "training:export"
  | "import"
  | "import-lossless-claw"
  | "action-confidence"
  | "xray"
  | "capsule";

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

function readCompatEnv(primary: string, legacy: string): string | undefined {
  return process.env[primary] ?? process.env[legacy];
}

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
const CLI_SUCCESS_EXIT_GRACE_MS = 2_000;
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
  disableThinking?: boolean;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
};

type PackageBenchModule = {
  getBenchmark?: (id: string) => {
    runnerAvailable?: boolean;
    meta?: { category?: string };
  } | undefined;
  resolveBenchRuntimeProfile?: (
    options: ResolveBenchRuntimeProfileOptions,
  ) => Promise<ResolvedBenchRuntimeProfile>;
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
    drainTimeoutMs?: number;
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
  getTrainingExportAdapter(name: string): TrainingExportAdapter | undefined;
  listTrainingExportAdapters(): string[];
  parseStrictCliDate(value: string, flag: string): Date;
}

async function loadTrainingExportCoreRuntime(): Promise<CoreTrainingExportRuntime> {
  return (await import("@remnic/core")) as unknown as CoreTrainingExportRuntime;
}

type BenchRuntimeProfile = "baseline" | "real" | "openclaw-chain";

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

type PackageBenchAdapterMode = "lightweight" | "direct";

export interface PackageBenchExecutionPlan {
  runtime: ResolvedBenchRuntimeProfile;
  createAdapter: PackageBenchAdapterFactory;
  adapterMode: PackageBenchAdapterMode;
}

export function getBenchUsageText(): string {
  return `Usage: remnic bench <list|run|published|datasets|runs|compare|results|baseline|export|publish|ui|providers> [options] [benchmark...]
       remnic benchmark <list|run|published|datasets|runs|compare|results|baseline|export|publish|ui|providers|check|report> [options] [benchmark...]

Commands:
  list                     List published benchmark packs
  run [benchmark...]       Run one or more benchmark packs
  published --name <benchmark> --dataset <path> --model <id>
                           Run a published benchmark with leaderboard-friendly flags
                           (see issue #566 slice 4). Accepts --limit, --seed,
                           --trial-limit, --trial-concurrency,
                           --ingest-concurrency, --out, --dry-run,
                           --provider, --base-url.
  datasets download [benchmark...]
                           Download local datasets for supported published benchmarks
  datasets status          Show local dataset availability for supported benchmarks
  runs list                List stored benchmark runs
  runs show <run>          Show one stored benchmark run
  runs delete <run...>     Delete one or more stored benchmark runs
  compare <base> <cand>    Compare two stored benchmark runs by id or file path
  results [run]            List stored runs or inspect a stored run
  baseline save <name> [run]
                           Save a stored run as a named baseline
  baseline list            List saved baselines
  export <run> --format <json|csv|html>
                           Export one stored run as JSON, aggregate-metrics CSV, or static HTML
  publish --target remnic-ai
                           Generate the Remnic.ai benchmark feed from stored runs
  ui                       Launch the local benchmark overview UI
  providers discover       Auto-detect available local provider backends
  check                    Legacy latency regression gate (compatibility)
  report                   Legacy latency report generator (compatibility)
  procedural-ablation --out <path> [--fixture <path>]
                           Run the procedural recall ablation harness (issue #567)

Options:
  --quick                  Run a lightweight quick pass (maps to --lightweight --limit 1)
  --all                    Run every published benchmark
  --runtime-profile <baseline|real|openclaw-chain>
                           Choose the benchmark runtime profile
  --matrix <profiles>      Run a benchmark across a comma-separated profile matrix
  --dataset-dir <path>     Override the benchmark dataset directory for full runs
  --remnic-config <path>   Load runtime settings from a Remnic config file
  --openclaw-config <path> Load runtime settings from an OpenClaw config file
  --model-source <plugin|gateway>
                           Override whether Remnic uses plugin or gateway model routing
  --gateway-agent-id <id>  OpenClaw agent persona id for gateway model routing
  --fast-gateway-agent-id <id>
                           OpenClaw fast-tier agent persona id for gateway model routing
  --system-provider <openai|anthropic|ollama|litellm|local-llm|codex-cli>
                           Use a direct provider-backed answering path
  --system-model <model>   Model name for the direct answering provider
  --system-base-url <url>  Base URL for the direct answering provider
  --system-codex-reasoning-effort <low|medium|high|xhigh>
                           Codex CLI reasoning effort for the direct answerer
  --system-responder-context-budget-chars <n>
                           Compact recalled memory context before sending it to the direct answerer
  --system-responder-prompt-budget-chars <n>
                           Compact repeated benchmark prompt instructions before sending them to the direct answerer
  --judge-provider <openai|anthropic|ollama|litellm|local-llm|codex-cli>
                           Use a direct provider-backed judge
  --judge-model <model>    Model name for the judge provider
  --judge-base-url <url>   Base URL for the judge provider
  --judge-codex-reasoning-effort <low|medium|high|xhigh>
                           Codex CLI reasoning effort for the judge
  --internal-provider <openai|anthropic|ollama|litellm|local-llm|codex-cli>
                           Provider for Remnic's internal extraction/summarization LLM
  --internal-model <model> Model name for Remnic's internal LLM provider
  --internal-base-url <url>
                           Base URL for Remnic's internal LLM provider
  --internal-api-key <key> API key for Remnic's internal LLM provider
  --internal-disable-thinking
                           Suppress thinking for Remnic's internal LLM when supported
  --internal-codex-reasoning-effort <low|medium|high|xhigh>
                           Codex CLI reasoning effort for Remnic's internal LLM
  --ama-bench-judge-protocol <default|recommended>
                           For ama-bench, use the recommended binary LLM-judge protocol
  --ama-bench-cross-judge-model <model>
                           For ama-bench, add a second recommended-protocol judge for agreement checks
  --ama-bench-cross-judge-provider <provider>
                           Provider for the ama-bench cross judge (defaults to --judge-provider)
  --ama-bench-cross-judge-codex-reasoning-effort <low|medium|high|xhigh>
                           Codex CLI reasoning effort for the ama-bench cross judge
  --ama-bench-cross-judge-base-url <url>
                           Base URL for the ama-bench cross judge (defaults to --judge-base-url)
  --custom <path>          Run a YAML-defined custom benchmark file
  --results-dir <path>     Override the stored benchmark results directory
  --baselines-dir <path>   Override the named baseline directory
  --request-timeout <ms>   Provider request timeout in milliseconds
  --drain-timeout <ms>     Memory drain timeout in milliseconds (defaults to --request-timeout when unset)
  --threshold <value>      Regression threshold for compare (default: 0.05)
  --trial-limit <n>        Cap scored LoCoMo or MemoryAgentBench QA trials for staged published runs
  --task-filter <pattern>  BEAM diagnostic filter; match task id, ability, or question text
  --detail                 Include per-task details for bench results
  --format <json|csv|html> Output format for bench export
  --output <path>          Write bench export output to a file
  --target <name>          Publish target for bench publish (remnic-ai)
  --json                   Output JSON for \`list\`

Examples:
  remnic bench list
  remnic bench run --quick longmemeval --runtime-profile baseline
  remnic bench datasets status
  remnic bench datasets download longmemeval
  remnic bench datasets download --all
  remnic bench runs list
  remnic bench runs show candidate-run --detail
  remnic bench runs delete candidate-run
  remnic bench run --quick longmemeval
  remnic bench run longmemeval --dataset-dir ~/datasets/longmemeval
  remnic bench run longmemeval --runtime-profile real --remnic-config ~/.config/remnic/config.json
  remnic bench run longmemeval --runtime-profile real --system-provider openai --system-model gpt-5.4-mini
  remnic bench run longmemeval --quick --system-provider codex-cli --system-model gpt-5.5 --judge-provider codex-cli --judge-model gpt-5.5
  remnic bench run ama-bench --runtime-profile real --system-provider ollama --system-model gemma4:31b-cloud --judge-provider ollama --judge-model qwen3:32b --ama-bench-judge-protocol recommended
  remnic bench run longmemeval --runtime-profile openclaw-chain --openclaw-config ~/.openclaw/openclaw.json --gateway-agent-id memory-primary
  remnic bench run longmemeval --matrix baseline,real,openclaw-chain
  remnic bench compare base-run candidate-run
  remnic bench results
  remnic bench results candidate-run --detail
  remnic bench baseline save main candidate-run
  remnic bench baseline list
  remnic bench export candidate-run --format csv --output ./candidate.csv
  remnic bench export candidate-run --format html --output ./report.html
  remnic bench publish --target remnic-ai
  remnic bench providers discover
  remnic bench run --custom ./my-bench.yaml
  remnic bench procedural-ablation --out ./artifacts/procedural-ablation.json
  remnic benchmark run --quick longmemeval`;
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
    judgeApiKey: parsed.judgeApiKey,
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
  buildPublishedBenchmarkOptionsForTest(
    benchmarkId: string,
    args: {
      publishedTrialLimit?: number;
      publishedTrialConcurrency?: number;
      publishedTaskFilter?: string;
    },
  ) {
    return buildPublishedBenchmarkOptions(benchmarkId, args);
  },
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
};

function printBenchPackageSummary(
  result: BenchSummaryResult,
  outputPath: string,
  outputLabel = "Results saved",
): void {
  console.log(`Benchmark: ${result.meta.benchmark}`);
  console.log(`Mode: ${result.meta.mode}`);
  if (result.config.runtimeProfile) {
    console.log(`Runtime profile: ${result.config.runtimeProfile}`);
  }
  console.log(`Tasks: ${result.results.tasks.length}`);
  console.log(`Mean query latency: ${result.cost.meanQueryLatencyMs.toFixed(1)}ms`);
  for (const [metric, aggregate] of Object.entries(result.results.aggregates).sort()) {
    console.log(`  ${metric.padEnd(20)} ${aggregate.mean.toFixed(4)}`);
  }
  console.log(`${outputLabel}: ${outputPath}`);
}

function printStoredBenchResultSummary(
  result: BenchmarkResult,
  summary: { id: string; path: string },
): void {
  printBenchPackageSummary(result, summary.path, "Stored result");
  console.log(`Run id: ${summary.id}`);
}

function printStoredBenchResultDetails(
  result: BenchmarkResult,
  summary: { id: string; path: string },
): void {
  printStoredBenchResultSummary(result, summary);
  if (result.results.tasks.length === 0) {
    console.log("Tasks: none");
    return;
  }

  console.log("Task breakdown:");
  for (const task of result.results.tasks) {
    const scores = Object.entries(task.scores)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([metric, value]) => `${metric}=${value.toFixed(4)}`)
      .join(", ");
    console.log(
      `  ${task.taskId}: ${task.latencyMs.toFixed(1)}ms` +
      `${scores.length > 0 ? ` [${scores}]` : ""}`,
    );
  }
}

function printBenchComparisonSummary(
  comparison: ComparisonResult,
  baseline: { id: string; path: string },
  candidate: { id: string; path: string },
): void {
  console.log(`Benchmark: ${comparison.benchmark}`);
  console.log(`Baseline: ${baseline.id} (${baseline.path})`);
  console.log(`Candidate: ${candidate.id} (${candidate.path})`);
  console.log(`Verdict: ${comparison.verdict}`);

  const metrics = Object.entries(comparison.metricDeltas).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (metrics.length === 0) {
    console.log("No overlapping metrics were found between the two results.");
    return;
  }

  console.log("Metrics:");
  for (const [metric, delta] of metrics) {
    const percent = Number.isFinite(delta.percentChange)
      ? `${(delta.percentChange * 100).toFixed(2)}%`
      : delta.percentChange > 0
        ? "+Infinity%"
        : "-Infinity%";
    const direction = delta.delta >= 0 ? "+" : "";
    console.log(
      `  ${metric.padEnd(18)} ${delta.baseline.toFixed(4)} -> ${delta.candidate.toFixed(4)} (${direction}${delta.delta.toFixed(4)}, ${percent}, d=${delta.effectSize.cohensD.toFixed(3)} ${delta.effectSize.interpretation})`,
    );
    if (delta.ciOnDelta) {
      console.log(
        `    CI95 delta: [${delta.ciOnDelta.lower.toFixed(4)}, ${delta.ciOnDelta.upper.toFixed(4)}]`,
      );
    }
  }
}

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
    renderBenchmarkResultExport,
  } = await loadBenchModule();
  const reference = parsed.benchmarks[0]!;
  const summary = await resolveBenchmarkResultReference(resultsDir, reference);
  if (!summary) {
    console.error(`ERROR: benchmark result not found: ${reference}`);
    process.exit(1);
  }

  const result = await loadBenchmarkResult(summary.path);
  const rendered = renderBenchmarkResultExport(result, parsed.format);

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
    return;
  }

  const runtimeProfiles = resolveBenchRunProfiles(parsed);
  const benchmarkId = parsed.publishedName;
  // Collect artifact paths written by each runtime profile so the
  // --out promotion step copies the exact file just produced rather
  // than scanning the whole results directory (Cursor Medium + Codex
  // P1 on PR #603: the previous newest-mtime scan could silently
  // publish unrelated or older artifacts under the new canonical
  // filename).
  const writtenPaths: string[] = [];
  for (const runtimeProfile of runtimeProfiles) {
    // Forward `--limit` + `--seed` through the existing package
    // runner. `--out` is handled below in the artifact write step.
    const result = await runBenchViaPackage(
      parsed,
      benchmarkId,
      runtimeProfile,
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
  },
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
  return undefined;
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

async function runBenchViaPackage(
  parsed: ParsedBenchArgs,
  benchmarkId: string,
  runtimeProfile: BenchRuntimeProfile,
  benchStatusPath?: string,
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
  const benchmarkOptions = buildPublishedBenchmarkOptions(benchmarkId, parsed);

  try {
    const amaBenchProtocol = buildAmaBenchProtocolOptions(
      benchModule,
      parsed,
      benchmarkId,
      plan.runtime,
    );
    system = await plan.createAdapter({
      ...plan.runtime.adapterOptions,
      ...(benchmarkId === "locomo"
        ? { replayExtractionMode: "skip" as const }
        : {}),
      ...(amaBenchProtocol.primaryJudge
        ? { judge: amaBenchProtocol.primaryJudge }
        : {}),
    });
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
          console.log(
            `  [${benchmarkId}] ${completed}/${total ?? "?"} tasks (${elapsed}s elapsed, ~${remaining}s remaining)`,
          );
        }
      },
    });
    result.config.remnicConfig = plan.runtime.remnicConfig;
    result.config.internalProvider = plan.runtime.internalProvider;
    const writtenPath = await benchModule.writeBenchmarkResult(result, outputDir);
    if (parsed.json) {
      console.log(JSON.stringify(redactBenchResultForStdout(benchModule, result), null, 2));
    } else {
      printBenchPackageSummary(result, writtenPath);
    }
    return { ok: true, writtenPath };
  } catch (err) {
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
      });
      result.config.remnicConfig = plan.runtime.remnicConfig;
      result.config.internalProvider = plan.runtime.internalProvider;
      customBenchmarkIds.push(result.meta.benchmark);
      const writtenPath = await benchModule.writeBenchmarkResult(result, outputDir);
      writtenPaths.push(writtenPath);
      if (parsed.json) {
        console.log(JSON.stringify(redactBenchResultForStdout(benchModule, result), null, 2));
      } else {
        printBenchPackageSummary(result, writtenPath);
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
        argv: process.argv.slice(2),
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

export function resolveConfigPath(cliPath?: string): string {
  if (cliPath) return path.resolve(expandTilde(cliPath));
  const envPath = readCompatEnv("REMNIC_CONFIG_PATH", "ENGRAM_CONFIG_PATH");
  if (envPath) return path.resolve(expandTilde(envPath));

  const candidates = [
    path.join(process.cwd(), "remnic.config.json"),
    path.join(process.cwd(), "engram.config.json"),
    path.join(resolveHomeDir(), ".config", "remnic", "config.json"),
    path.join(resolveHomeDir(), ".config", "engram", "config.json"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(resolveHomeDir(), ".config", "remnic", "config.json");
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
  quick: boolean,
  runtimeProfile: BenchRuntimeProfile,
): PackageBenchAdapterMode {
  return quick && runtimeProfile === "baseline" ? "lightweight" : "direct";
}

function resolvePackageBenchAdapterFactory(
  benchModule: PackageBenchModule,
  quick: boolean,
  runtimeProfile: BenchRuntimeProfile,
): PackageBenchAdapterFactory | undefined {
  return resolvePackageBenchAdapterMode(quick, runtimeProfile) === "lightweight"
    ? benchModule.createLightweightAdapter
    : benchModule.createRemnicAdapter;
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
      parsed.quick,
      runtime.profile,
    );

    if (!createAdapter) {
      return false;
    }

    plans.push({
      runtime,
      createAdapter,
      adapterMode: resolvePackageBenchAdapterMode(parsed.quick, runtime.profile),
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
    const remnicCfg = raw.remnic ?? raw.engram ?? raw;
    if (typeof remnicCfg.memoryDir === "string" && remnicCfg.memoryDir.length > 0) {
      return normalizeMemoryDirPath(remnicCfg.memoryDir);
    }
    // Auto-detect: prefer standalone path if it exists, fall back to OpenClaw
    const home = resolveHomeDir();
    const standalonePath = path.join(home, ".remnic", "memory");
    const legacyStandalonePath = path.join(home, ".engram", "memory");
    const openclawPath = path.join(home, ".openclaw", "workspace", "memory", "local");
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
const REMNIC_OPENCLAW_PLUGIN_ID = "openclaw-remnic";
const REMNIC_OPENCLAW_LEGACY_PLUGIN_ID = "openclaw-engram";

// Primary env var takes precedence; legacy env var is checked as fallback.
// This matches the priority convention in readCompatEnv() (primary > legacy > default).
const DEFAULT_OPENCLAW_CONFIG_PATHS_FOR_DOCTOR = [
  process.env.OPENCLAW_CONFIG_PATH,
  process.env.OPENCLAW_ENGRAM_CONFIG_PATH,
  path.join(resolveHomeDir(), ".openclaw", "openclaw.json"),
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
  return path.join(resolveHomeDir(), ".openclaw", "openclaw.json");
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
  return path.join(resolveHomeDir(), ".openclaw", "extensions", REMNIC_OPENCLAW_PLUGIN_ID);
}

function resolveOpenclawLegacyPluginDir(cliPath?: string): string {
  if (cliPath) return path.resolve(expandTilde(cliPath));
  return path.join(resolveHomeDir(), ".openclaw", "extensions", REMNIC_OPENCLAW_LEGACY_PLUGIN_ID);
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

function assertDirectoryPathOrMissing(targetPath: string, label: string): void {
  if (!fs.existsSync(targetPath)) return;
  const stat = fs.statSync(targetPath);
  if (!stat.isDirectory()) {
    throw new Error(`${label} must be a directory when it already exists: ${targetPath}`);
  }
}

function describeErrorWithCause(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof Error) || !("cause" in error)) return message;

  const cause = error.cause;
  if (cause === undefined || cause === null) return message;

  const causeText = cause instanceof Error ? cause.message : String(cause);
  if (!causeText || causeText === message) return message;
  return `${message} Cause: ${causeText}`;
}

class PublishedOpenclawPluginInstallError extends Error {
  readonly rollbackDir?: string;
  readonly shouldRestoreBackup: boolean;

  constructor(
    message: string,
    options: ErrorOptions & {
      rollbackDir?: string;
      shouldRestoreBackup?: boolean;
    } = {},
  ) {
    super(message, options);
    this.name = "PublishedOpenclawPluginInstallError";
    this.rollbackDir = options.rollbackDir;
    this.shouldRestoreBackup = options.shouldRestoreBackup ?? false;
  }
}

function installPublishedOpenclawPlugin(
  spec: string,
  pluginDir: string,
): { rollbackDir?: string; version?: string } {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-openclaw-upgrade-"));
  const stagedDir = `${pluginDir}.next-${process.pid}-${Date.now()}`;
  const rollbackDir = `${pluginDir}.rollback-${process.pid}-${Date.now()}`;
  let swapRollbackDir: string | undefined;
  let shouldRestoreBackup = false;

  try {
    const packOutput = childProcess.execFileSync("npm", ["pack", spec], {
      cwd: tempRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tarballName = packOutput
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    if (!tarballName) {
      throw new Error(`npm pack ${spec} did not return a tarball name`);
    }

    const unpackDir = path.join(tempRoot, "unpacked");
    fs.mkdirSync(unpackDir, { recursive: true });
    childProcess.execFileSync("tar", ["-xzf", path.join(tempRoot, tarballName), "-C", unpackDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const packagedDir = path.join(unpackDir, "package");
    if (!fs.existsSync(packagedDir)) {
      throw new Error(`npm pack ${spec} did not contain a package/ directory`);
    }

    fs.rmSync(stagedDir, { recursive: true, force: true });
    fs.cpSync(packagedDir, stagedDir, { recursive: true });
    childProcess.execFileSync("npm", ["install", "--omit=dev"], {
      cwd: stagedDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    assertDirectoryPathOrMissing(pluginDir, "OpenClaw plugin dir");
    const swapResult = (() => {
      try {
        return swapDirectoryWithRollback(stagedDir, pluginDir, rollbackDir);
      } catch (swapError) {
        shouldRestoreBackup = swapError instanceof AggregateError;
        throw swapError;
      }
    })();
    swapRollbackDir = swapResult.rollbackDir;

    const installedPackageJsonPath = path.join(pluginDir, "package.json");
    const installedPackage = fs.existsSync(installedPackageJsonPath)
      ? JSON.parse(fs.readFileSync(installedPackageJsonPath, "utf8")) as Record<string, unknown>
      : {};
    return {
      rollbackDir: swapRollbackDir,
      version: typeof installedPackage.version === "string" ? installedPackage.version : undefined,
    };
  } catch (error) {
    throw new PublishedOpenclawPluginInstallError(
      `Failed to install published OpenClaw plugin from ${spec}.`,
      {
        cause: error,
        rollbackDir: swapRollbackDir,
        shouldRestoreBackup,
      },
    );
  } finally {
    fs.rmSync(stagedDir, { recursive: true, force: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
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

async function cmdStatus(json: boolean): Promise<void> {
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

  const port = inferPort();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/engram/v1/health`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      console.log(`Health: server responded with ${response.status} ${response.statusText}`);
    } else {
      const health = await response.json();
      console.log(`Health: ${health.status ?? "ok"}`);
    }
  } catch {
    console.log("Health: unable to reach server");
  } finally {
    clearTimeout(timeoutId);
  }
}

interface QueryRenderableResult {
  content?: string;
  preview?: string;
  context?: string;
}

export function renderQueryTextLines(result: {
  results?: QueryRenderableResult[];
  context?: string;
}): string[] {
  const results = Array.isArray(result.results) ? result.results : [];
  if (results.length === 0) return ["No results."];

  return results.map((memory) => {
    const text =
      memory.content?.trim()
      || memory.preview?.trim()
      || memory.context?.trim()
      || "(no preview available)";
    return `- ${text}`;
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

  initLogger();
  const configPath = resolveConfigPath();
  const raw = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  const remnicCfg = raw.remnic ?? raw.engram ?? raw;
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
      const totalDurationMs = Date.now() - explainStart;
      // recall() returns { count, results, memoryIds, ... } (see
      // EngramAccessRecallResponse). A prior version of this fallback
      // read .memories, which doesn't exist, so resultsCount was always
      // 0 and users saw misleading explain output. (Codex feedback on
      // PR #545.) Prefer the numeric count and fall back to
      // results.length for robustness across future schema tweaks.
      const resultsCount =
        typeof recallResult.count === "number"
          ? recallResult.count
          : Array.isArray(recallResult.results)
            ? recallResult.results.length
            : 0;
      const minimalExplain = {
        query: queryText,
        totalDurationMs,
        resultsCount,
        note: "Install @remnic/bench for a full tier-level explain breakdown.",
      };
      if (json) {
        console.log(JSON.stringify(minimalExplain, null, 2));
      } else {
        console.log(`Query: ${minimalExplain.query}`);
        console.log(`Total duration: ${minimalExplain.totalDurationMs}ms`);
        console.log(`Results: ${minimalExplain.resultsCount}`);
        console.log(`Note: ${minimalExplain.note}`);
      }
      return;
    }

    const result = await service.recall(recallRequest);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      for (const line of renderQueryTextLines(result)) {
        console.log(line);
      }
    }
  } finally {
    // One-shot CLI calls should not wait for or orphan deferred QMD
    // maintenance; the daemon/gateway process performs full warmup instead.
    orchestrator.abortDeferredInit();
  }
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

  initLogger();
  const configPath = resolveConfigPath();
  const raw = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  const remnicCfg = raw.remnic ?? raw.engram ?? raw;
  const config = parseConfig(remnicCfg);
  const orchestrator = new Orchestrator(config);
  await orchestrator.initialize();
  await orchestrator.deferredReady;
  const service = new EngramAccessService(orchestrator);

  try {
    await runXrayCommand(rest, {
      recallXray: (request) => service.recallXray(request),
      writeFile: async (filePath, data) => {
        const { writeFile: fsWriteFile } = await import("node:fs/promises");
        await fsWriteFile(filePath, data, "utf8");
      },
      stdout: (line) => console.log(line),
    });
  } finally {
    // Xray is diagnostic, so it waits for deferred startup sync before recall;
    // abort remains a no-op guard if startup behavior changes later.
    orchestrator.abortDeferredInit();
  }
}

// ── Page-level versioning (issue #371) ─────────────────────────────────────

async function cmdVersions(rest: string[]): Promise<void> {
  initLogger();
  const configPath = resolveConfigPath();
  const raw = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  const remnicCfg = raw.remnic ?? raw.engram ?? raw;
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
  const remnicCfg = raw.remnic ?? raw.engram ?? raw;
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
        await storage.writeMemory(candidate.category, candidate.text, {
          confidence: candidate.confidence,
          tags: [...(candidate.tags ?? []), "enrichment", candidate.source],
          entityRef: result.entityName,
          source: `enrichment:${candidate.source}`,
        });
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

/**
 * `remnic procedural <subcommand>` (issue #567 PR 5/5). Currently supports:
 *
 *   remnic procedural stats [--format json|text] [--memory-dir <path>]
 *
 * Read-only — surfaces the same report as the HTTP
 * `/engram/v1/procedural/stats` endpoint and the `remnic.procedural_stats`
 * MCP tool so operators can quickly see procedural memory health.
 */
async function cmdProcedural(rest: string[]): Promise<void> {
  initLogger();
  const subcommand = rest[0];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    console.log(`remnic procedural — Procedural memory operations (issue #567)

Usage:
  remnic procedural stats [--format json|text] [--memory-dir <path>]

Subcommands:
  stats                Print counts by status + recent activity + active config.

Shared with:
  GET /engram/v1/procedural/stats
  MCP remnic.procedural_stats (alias engram.procedural_stats)`);
    return;
  }

  if (subcommand !== "stats") {
    console.error(
      `Unknown procedural subcommand "${subcommand}". Run \`remnic procedural --help\` for usage.`,
    );
    process.exit(1);
  }

  const args = rest.slice(1);
  // CLAUDE.md rules 14 + 51: --format must have a value if the flag is
  // present. Previously `resolveFlag` returned `undefined` for `--format`
  // with no value and we silently defaulted to "text", which hides
  // operator typos (cursor review on #611).
  const formatPresent = hasFlag(args, "--format");
  const formatRaw = resolveFlag(args, "--format");
  if (formatPresent && (formatRaw === undefined || formatRaw === null)) {
    console.error(
      "--format requires a value. Use `--format json` or `--format text`.",
    );
    process.exit(1);
  }
  const format = (() => {
    if (!formatPresent || formatRaw === undefined || formatRaw === null) {
      return "text";
    }
    const normalized = String(formatRaw).trim().toLowerCase();
    if (normalized !== "text" && normalized !== "json") {
      console.error(
        `Invalid --format "${formatRaw}". Allowed: text, json.`,
      );
      process.exit(1);
    }
    return normalized;
  })();

  const memoryDirPresent = hasFlag(args, "--memory-dir");
  const memoryDirOverride = resolveFlag(args, "--memory-dir");
  if (
    memoryDirPresent &&
    (memoryDirOverride === undefined || memoryDirOverride === null)
  ) {
    console.error(
      "--memory-dir requires a path. Omit the flag to use the resolved default.",
    );
    process.exit(1);
  }
  const configPath = resolveConfigPath();
  const raw = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  const remnicCfg = raw.remnic ?? raw.engram ?? raw;
  const config = parseConfig(remnicCfg);

  const memoryDir = expandTilde(
    typeof memoryDirOverride === "string" && memoryDirOverride.length > 0
      ? memoryDirOverride
      : config.memoryDir ?? resolveMemoryDir(),
  );

  const storage = new StorageManager(memoryDir);
  const report = await computeProcedureStats({ storage, config });
  if (format === "json") {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }
  process.stdout.write(formatProcedureStatsText(report));
}

async function cmdExtensions(action: string, rest: string[]): Promise<void> {
  initLogger();
  const configPath = resolveConfigPath();
  const raw = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  const remnicCfg = raw.remnic ?? raw.engram ?? raw;
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
  const remnicCfg = raw.remnic ?? raw.engram ?? raw;
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

  const memoryDir = resolveMemoryDir();
  try {
    fs.mkdirSync(memoryDir, { recursive: true });
    checks.push({ name: "Memory directory", ok: true, detail: memoryDir });
  } catch {
    checks.push({ name: "Memory directory", ok: false, detail: `cannot create ${memoryDir}` });
  }

  // ── OpenClaw config checks ──────────────────────────────────────────────────
  const openclawConfigPath = resolveOpenclawConfigPath();
  const openclawConfigExists = fs.existsSync(openclawConfigPath);
  let openclawConfig: Record<string, unknown> = {};
  let openclawConfigValid = false;
  let openclawPluginModeConfigured = false;
  let activeOpenclawModelSource: string | undefined;

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

  const hasApiKey = !!process.env.OPENAI_API_KEY;
  const openaiKeyOptionalForGateway =
    openclawPluginModeConfigured && activeOpenclawModelSource === "gateway";
  checks.push({
    name: "OPENAI_API_KEY",
    ok: hasApiKey || openaiKeyOptionalForGateway,
    warn: !hasApiKey,
    detail: hasApiKey
      ? "set"
      : openaiKeyOptionalForGateway
      ? "not set (not required for OpenClaw gateway modelSource)"
      : "not set (required for direct OpenAI-backed extraction)",
  });

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

function cmdReview(action: string, rest: string[]): void {
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
    const result = performReview(memoryDir, id, action as ReviewAction);
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
    const rows = [
      {
        id: GDRIVE_ID as string,
        displayName: "Google Drive",
        enabled: true,
        state: stateMap.get(GDRIVE_ID as string) ?? null,
      },
      {
        id: NOTION_ID as string,
        displayName: "Notion",
        enabled: true,
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
    const remnicCfg = raw.remnic ?? raw.engram ?? raw;
    const config = parseConfig(remnicCfg);
    const orchestrator = new Orchestrator(config);
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
  const pluginConfig = rawConfig.remnic ?? rawConfig.engram ?? rawConfig;
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
    const result = pushToSpace(sourceId, targetId, { force: rest.includes("--force") });
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
    const result = pullFromSpace(sourceId, targetId, { force: rest.includes("--force") });
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
    const result = promoteSpace(sourceId, targetId, {
      force: rest.includes("--force"),
      forceOverwrite: rest.includes("--force-overwrite"),
    });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Promoted ${result.memoriesPromoted} memories`);
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
  const remnicCfg = raw.remnic ?? raw.engram ?? raw;
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
    console.log(`Report saved to ${reportPath ?? "benchmarks/report.json"}`);
    if (json) {
      console.log(JSON.stringify(suite.report, null, 2));
    }
  } else {
    console.log("Usage: remnic benchmark <run|check|report> [queries...] [--explain] [--baseline=<path>] [--report=<path>]");
    process.exit(1);
  }
}

async function cmdBench(rest: string[]): Promise<void> {
  // Procedural ablation subcommand (issue #567 PR 1/5). Routed before the
  // standard bench dispatcher because `procedural-ablation` is an ad-hoc
  // harness, not a registered benchmark catalogue entry.
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
    console.log(`Resuming from: ${path.basename(latestStatusPath)}`);
    console.log(`  Previous run: ${prevStatus.startedAt}`);
    console.log(`  Benchmarks: ${prevStatus.benchmarks.length} total, ${completeCount} complete, ${failedCount} failed`);

    const before = selectedBenchmarks.length;

    if (parsed.resume) {
      selectedWorkItems = filterBenchWorkItemsForPreviousStatus(
        selectedWorkItems,
        prevStatus.benchmarks,
        "resume",
      );
      selectedBenchmarks = [...new Set(selectedWorkItems.map((item) => item.benchmarkId))];
      console.log(`  Resuming: ${selectedBenchmarks.length} of ${before} benchmarks to re-run`);
    } else {
      selectedWorkItems = filterBenchWorkItemsForPreviousStatus(
        selectedWorkItems,
        prevStatus.benchmarks,
        "retry-failed",
      );
      selectedBenchmarks = [...new Set(selectedWorkItems.map((item) => item.benchmarkId))];
      console.log(`  Retrying: ${selectedBenchmarks.length} of ${before} selected benchmarks had failures`);
    }

    if (selectedWorkItems.length === 0) {
      if (parsed.retryFailed) {
        console.log("Nothing to re-run — no selected benchmarks had failures.");
      } else {
        console.log(
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
  try {
    for (const { benchmarkId, runtimeProfile } of selectedWorkItems) {
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
          );
          if (handledByPackage.ok) {
            if (handledByPackage.writtenPath) {
              writtenPaths.push(handledByPackage.writtenPath);
            }
            try { await updateBenchmarkCompleted(benchStatusPath, statusId, handledByPackage.writtenPath ?? ""); } catch { /* non-fatal */ }
          } else {
            const fallbackResultPath = await runBenchViaFallback(parsed, benchmarkId, runtimeProfile);
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
  for (const file of [PID_FILE, LEGACY_PID_FILE]) {
    try {
      return parseInt(fs.readFileSync(file, "utf8").trim(), 10);
    } catch {
      // Try next candidate
    }
  }
  return undefined;
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
    } catch {
      // May already be loaded
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
      childProcess.execSync(`systemctl --user enable ${SYSTEMD_SERVICE}`, { stdio: "pipe" });
      childProcess.execSync(`systemctl --user start ${SYSTEMD_SERVICE}`, { stdio: "pipe" });
    } catch {
      // May fail if systemd not available
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
    const remnicCfg = raw.remnic ?? raw.engram ?? raw;
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

function cmdTokenGenerate(connector: string): void {
  if (!connector) {
    console.error("Usage: remnic token generate <connector-id>");
    console.error("  e.g.: remnic token generate claude-code");
    process.exit(1);
  }
  const entry = generateToken(connector);
  console.log(`Generated token for ${connector}:`);
  console.log(`  Token:   ${entry.token}`);
  console.log(`  Created: ${entry.createdAt}`);
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
  const remnicCfg = raw.remnic ?? raw.engram ?? raw;
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
  const fallbackMemoryDir = path.join(resolveHomeDir(), ".openclaw", "workspace", "memory", "local");

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
  fs.writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2) + "\n");

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
  const legacyPluginDirForBackup = opts.legacyPluginDirForBackup
    ? resolveOpenclawLegacyPluginDir(opts.legacyPluginDirForBackup)
    : undefined;
  const fallbackMemoryDir = path.join(resolveHomeDir(), ".openclaw", "workspace", "memory", "local");
  const packageSpec = `@remnic/plugin-openclaw@${opts.version ?? "latest"}`;

  const existingConfig = readOpenclawConfig(configPath);
  const { entries, slots } = parseOpenclawPluginState(existingConfig, configPath);
  const preservedMemoryDir = opts.memoryDir
    ? path.resolve(expandTilde(opts.memoryDir))
    : resolveCurrentOpenclawMemoryDir(entries, slots, fallbackMemoryDir);
  const backupDir = path.join(
    resolveHomeDir(),
    ".openclaw",
    "backups",
    `remnic-openclaw-upgrade-${formatOpenclawUpgradeStamp()}`,
  );
  const configBackupPath = path.join(backupDir, "openclaw.json");
  const pluginBackupDir = path.join(backupDir, "extensions", REMNIC_OPENCLAW_PLUGIN_ID);
  const legacyPluginBackupDir = legacyPluginDirForBackup
    ? path.join(backupDir, "extensions", REMNIC_OPENCLAW_LEGACY_PLUGIN_ID)
    : undefined;

  assertDirectoryPathOrMissing(pluginDir, "OpenClaw plugin dir");
  if (legacyPluginDirForBackup) {
    assertDirectoryPathOrMissing(legacyPluginDirForBackup, "Legacy OpenClaw plugin dir");
  }

  console.log(`OpenClaw config: ${configPath}`);
  console.log(`Plugin dir:      ${pluginDir}`);
  if (legacyPluginDirForBackup) {
    console.log(`Legacy dir:      ${legacyPluginDirForBackup}`);
  }
  console.log(`Memory dir:      ${preservedMemoryDir}`);
  console.log(`Package spec:    ${packageSpec}`);
  console.log(`Backup dir:      ${backupDir}`);

  const plannedActions = [
    `backup openclaw.json and the existing ${REMNIC_OPENCLAW_PLUGIN_ID} extension`,
    ...(legacyPluginDirForBackup
      ? [`backup the existing ${REMNIC_OPENCLAW_LEGACY_PLUGIN_ID} extension without modifying it`]
      : []),
    `npm pack ${packageSpec} and stage a clean plugin copy before swap`,
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
      true,
    );
    if (!shouldContinue) {
      console.log("Upgrade cancelled.");
      return;
    }
  }

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

  let installResult: { rollbackDir?: string; version?: string } | undefined;
  try {
    installResult = installPublishedOpenclawPlugin(packageSpec, pluginDir);
    await cmdOpenclawInstall({
      yes: true,
      dryRun: false,
      memoryDir: preservedMemoryDir,
      configPath,
    });
  } catch (installError) {
    const failurePhase = installResult
      ? "reconfiguring the installed plugin"
      : "installing the published plugin";
    const installErrorText = describeErrorWithCause(installError);
    const publishedInstallError = installError instanceof PublishedOpenclawPluginInstallError
      ? installError
      : undefined;
    const rollbackDir = publishedInstallError
      ? publishedInstallError.rollbackDir
      : installResult?.rollbackDir;
    const shouldRestorePlugin =
      Boolean(installResult || rollbackDir || publishedInstallError?.shouldRestoreBackup);
    const shouldRestoreConfig = Boolean(installResult);
    const shouldRollback = shouldRestorePlugin || shouldRestoreConfig;

    if (!shouldRollback) {
      throw new Error(
        `OpenClaw upgrade failed while ${failurePhase}. ` +
        `Original failure: ${installErrorText}.`,
        { cause: installError },
      );
    }

    let rollbackNotes: string[];
    try {
      rollbackNotes = rollbackOpenclawUpgrade({
        configBackupPath: shouldRestoreConfig ? configBackupPath : undefined,
        configPath,
        pluginBackupDir: shouldRestorePlugin ? pluginBackupDir : undefined,
        pluginDir,
        rollbackDir,
      });
    } catch (rollbackError) {
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
      { cause: installError },
    );
  }
  const rollbackCleanupWarning = cleanupRollbackDirectoryBestEffort(
    installResult?.rollbackDir,
  );

  console.log("\nUpgrade backups:");
  for (const note of backupNotes) console.log(`  ${note}`);
  console.log(
    `\nInstalled published plugin from npm pack ${packageSpec}` +
    `${installResult.version ? ` (version ${installResult.version})` : ""}.`,
  );
  if (rollbackCleanupWarning) {
    console.warn(rollbackCleanupWarning);
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

// ── Taxonomy commands (#366) ─────────────────────────────────────────────────

async function cmdTaxonomy(rest: string[]): Promise<void> {
  initLogger();
  const configPath = resolveConfigPath();
  const raw = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  const remnicCfg = raw.remnic ?? raw.engram ?? raw;
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
    parseStrictCliDate,
  } = await loadTrainingExportCoreRuntime();

  // Resolve the adapter from the registry first. If the user picks a
  // non-weclone format (registered elsewhere), we never touch the
  // optional @remnic/export-weclone package. If the format isn't
  // registered yet, we lazily load weclone to register its adapter and
  // try again — that keeps weclone a true à-la-carte install while
  // still supporting `--format weclone` out of the box.
  // (Codex feedback on PR #545.)
  type WecloneExportModule = Awaited<ReturnType<typeof loadWecloneExportModule>>;
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
    mod.ensureWecloneExportAdapterRegistered();
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
    records = mod.synthesizeTrainingPairs(records as unknown as Record<string, unknown>[], {
      maxPairsPerRecord: args.maxPairsPerRecord,
    }) as unknown as TrainingExportRecord[];
  }

  let redactedCount = 0;
  if (args.privacySweep) {
    if (adapterIsWeclone) {
      const mod = await ensureWeclone();
      const swept = mod.sweepPii(records as unknown as Record<string, unknown>[]);
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

    case "action-confidence":
      await cmdActionConfidence(rest);
      break;

    case "xray":
      // `remnic xray "<query>"` — recall with X-ray capture and print
      // the unified snapshot (issue #570 / PR #636 Codex P2).  The
      // plugin-runtime path registers the same surface via
      // `registerCli` in `@remnic/core/cli.ts`; this case wires the
      // standalone `remnic` binary so documented usage actually works.
      await cmdXray(rest);
      break;

    case "doctor":
      await cmdDoctor();
      break;

    case "config":
      cmdConfig();
      break;

    case "daemon": {
      const action = rest[0] as DaemonAction;
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
          cmdTokenGenerate(rest[1]);
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
      cmdReview(action, rest.slice(1));
      break;
    }

    case "sync": {
      const action = rest[0] ?? "run";
      const json = rest.includes("--json");
      await cmdSync(action, rest.slice(1), json);
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
      await cmdProcedural(rest);
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

    case "import": {
      // Infrastructure-only in slice 1 (#568). The optional adapter packages
      // (@remnic/import-chatgpt/claude/gemini/mem0/supermemory) land in
      // follow-up slices and
      // are loaded via computed-specifier dynamic import — running
      // `remnic import --adapter chatgpt` today surfaces a clean install
      // hint rather than MODULE_NOT_FOUND.
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
          const remnicCfg = raw.remnic ?? raw.engram ?? raw;
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
             in ~/.openclaw/openclaw.json (or $OPENCLAW_CONFIG_PATH).

Options:
  --yes / -y / --force    Skip interactive prompts, assume Y
  --dry-run               Print resulting config diff without writing
  --memory-dir <path>     Override default memory dir (~/.openclaw/workspace/memory/local)
  --config <path>         Override OpenClaw config path
  --version <tag>         Upgrade @remnic/plugin-openclaw from a specific npm tag/version
  --plugin-dir <path>     Override OpenClaw extension dir (~/.openclaw/extensions/openclaw-remnic)
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
    (tier + audit + MMR + filters). Part of #570. Defaults to text
    output on stdout.

  remnic doctor                Run diagnostics
  remnic config                Show current config
  remnic openclaw install      Configure OpenClaw to use Remnic memory (sets slot + entry)
  remnic openclaw upgrade      Safe OpenClaw npm upgrade with backups and gateway restart
  remnic openclaw migrate-engram
    Migrate legacy @joshuaswarren/openclaw-engram installs with legacy extension backup
    --yes / -y / --force       Skip prompts
    --dry-run                  Preview changes without writing
    --memory-dir <path>        Custom memory directory
    --config <path>            Custom OpenClaw config path
    --version <tag>            Upgrade @remnic/plugin-openclaw from a specific npm tag/version
    --plugin-dir <path>        Custom OpenClaw extension directory
    --legacy-plugin-dir <path> Custom legacy extension directory for migration backup
    --no-restart               Skip the final launchctl kickstart after upgrade
  remnic daemon <start|stop|restart|install|uninstall|status>  Manage background server
  remnic token <generate|list|revoke> [connector-id]  Manage auth tokens
  remnic tree <generate|watch|validate>  Generate context tree
  remnic onboard [dir] [--json]     Onboard project directory
  remnic curate <path> [--json]  Curate files into memory
  remnic review <list|approve|dismiss|flag> [id]  Review inbox
  remnic sync <run|watch> [--source <dir>] Diff-aware sync
  remnic dedup [--json]             Find duplicate memories
  remnic connectors <list|install|remove|doctor|marketplace> [id]  Manage connectors
    marketplace generate    Generate marketplace.json for Codex
    marketplace validate    Validate a marketplace.json file
    marketplace install     Install from a marketplace source
  remnic extensions <list|show|validate|reload>  Manage memory extensions
  remnic space <list|switch|create|delete|push|pull|share|promote|audit>  Manage spaces
    create accepts --parent <id> to set parent-child relationship
  remnic bench <list|run|datasets|runs|compare|results|baseline|export|publish|ui|providers> [benchmark...] [--quick] [--all] [--dataset-dir <path>] [--results-dir <path>] [--baselines-dir <path>] [--threshold <value>] [--detail] [--format <json|csv|html>] [--output <path>] [--target remnic-ai] [--json]
    benchmark is kept as a compatibility alias. check/report remain under that alias.
  remnic benchmark <list|run|datasets|runs|compare|results|baseline|export|publish|ui|providers|check|report> [queries...] [--explain] [--baseline=<path>] [--report=<path>]
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
    try {
      process.stderr.write(
        `Warning: remnic CLI forced a clean exit after ${CLI_SUCCESS_EXIT_GRACE_MS}ms because a handle remained open.\n`,
      );
    } catch {
      // Ignore write failures during forced shutdown.
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
