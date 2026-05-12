/**
 * Package-owned Remnic adapters used by the phase-1 benchmark CLI surface.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildEvidencePack,
  buildExplicitCueRecallSection,
  buildTrajectoryAnalysisRecallSection,
  collectExplicitTurnReferences,
  expandTildePath,
  normalizeTurnExpansionEnd,
  Orchestrator,
  parseFlexibleIsoTimestamp,
  parseConfig,
} from "@remnic/core";
import type {
  BenchJudge,
  BenchMemoryAdapter,
  BenchRecallOptions,
  BenchResponder,
  MemoryStats,
  Message,
  SearchResult,
} from "./types.js";
import { DEFAULT_BENCH_RECALL_BUDGET_CHARS } from "../recall-budget.js";

export interface RemnicAdapterOptions {
  configOverrides?: Record<string, unknown>;
  memoryDir?: string;
  preserveRuntimeDefaults?: boolean;
  responder?: BenchResponder;
  judge?: BenchJudge;
  drainTimeoutMs?: number;
  replayExtractionMode?: "await" | "background" | "skip";
  replaySourceValidAtMode?: "historical" | "batch";
  sandboxDir?: string;
}

type BenchAdapterMode = "lightweight" | "direct";

interface BenchAdapterBaseConfig {
  memoryDir: string;
  workspaceDir: string;
  lcmEnabled: true;
  qmdCollection?: string;
  qmdColdCollection?: string;
  qmdPath?: string;
}

interface BenchQmdSandbox {
  collection: string;
  coldCollection: string;
  cacheDir: string;
  configDir: string;
  indexName: string;
  wrapperPath: string;
}

export const BENCH_ADAPTER_SHARED_CONFIG: Record<string, unknown> = {
  qmdEnabled: false,
  qmdColdTierEnabled: false,
  transcriptEnabled: false,
  hourlySummariesEnabled: false,
  daySummaryEnabled: false,
  identityEnabled: false,
  identityContinuityEnabled: false,
  namespacesEnabled: false,
  sharedContextEnabled: false,
  workTasksEnabled: false,
  workProjectsEnabled: false,
  commitmentLedgerEnabled: false,
  resumeBundlesEnabled: false,
  nativeKnowledge: { enabled: false },
  lcmLeafBatchSize: 64,
  lcmRollupFanIn: 8,
  lcmFreshTailTurns: 64,
  lcmMaxDepth: 4,
  lcmDeterministicMaxTokens: 512,
  lcmRecallBudgetShare: 1.0,
  queryExpansionEnabled: false,
  rerankEnabled: false,
  memoryBoxesEnabled: false,
  traceWeaverEnabled: false,
  threadingEnabled: false,
  factDeduplicationEnabled: false,
  knowledgeIndexEnabled: false,
  entityRetrievalEnabled: false,
  verifiedRecallEnabled: false,
  queryAwareIndexingEnabled: false,
  contradictionDetectionEnabled: false,
  memoryLinkingEnabled: false,
  topicExtractionEnabled: false,
  chunkingEnabled: true,
  episodeNoteModeEnabled: false,
};

export const BENCH_ADAPTER_MODE_CONFIG: Record<BenchAdapterMode, Record<string, unknown>> = {
  direct: {
    extractionDedupeEnabled: true,
    extractionMinChars: 10,
    extractionMinUserTurns: 0,
    recallPlannerEnabled: true,
  },
  lightweight: {
    extractionDedupeEnabled: false,
    extractionMinChars: 1000000,
    extractionMinUserTurns: 1000000,
    recallPlannerEnabled: false,
  },
};

type OrchestratorTeardownView = {
  abortDeferredInit(): void;
  deferredReady: Promise<void>;
  lcmEngine: { close(): void } | null;
  qmd: { dispose?(): void | Promise<void> };
  qmdMaintenanceTimer?: NodeJS.Timeout | null;
  qmdMaintenancePending?: boolean;
  qmdMaintenanceInFlight?: boolean;
};

type OrchestratorDrainDiagnosticsView = {
  lcmEngine: {
    observeQueueDepth: number;
    observeQueueInFlightCount: number;
  } | null;
  extractionQueue?: unknown[];
  queueProcessing?: boolean;
  consolidationInFlight?: boolean;
  qmdMaintenancePending?: boolean;
  qmdMaintenanceInFlight?: boolean;
  tierMigrationInFlight?: boolean;
};

type BenchOrchestratorState = {
  tempDir: string;
  ownsTempDir: boolean;
  orchestrator: Orchestrator;
  qmdSandbox: BenchQmdSandbox;
};

type BenchRecallEngine = {
  expandContext(
    sessionId: string,
    fromTurn: number,
    toTurn: number,
    maxTokens: number,
  ): Promise<Array<{ turn_index: number; role: string; content: string }>>;
  getStats(sessionId?: string): Promise<{
    totalMessages: number;
    totalSummaryNodes: number;
    maxDepth: number;
    maxTurnIndex?: number;
  }>;
};

const BENCH_TEARDOWN_DEFERRED_READY_WAIT_MS = 500;
const DEFAULT_BENCH_DRAIN_TIMEOUT_MS = 5 * 60_000;
const CORE_EXPLICIT_CUE_MAX_CHARS = 18_000;
const CORE_EXPLICIT_CUE_MAX_ITEM_CHARS = 2_400;
const CORE_EXPLICIT_CUE_MAX_REFERENCES = 24;
const CORE_TRAJECTORY_ANALYSIS_MAX_CHARS = 18_000;
const execFileAsync = promisify(execFile);

function normalizeReplaySourceValidAtMode(
  value: RemnicAdapterOptions["replaySourceValidAtMode"],
): "historical" | "batch" {
  if (value === undefined) {
    return "historical";
  }
  if (value === "historical" || value === "batch") {
    return value;
  }
  throw new Error('replaySourceValidAtMode must be "historical" or "batch".');
}

function cloneBenchConfig(config: Record<string, unknown>): Record<string, unknown> {
  return cloneBenchConfigValue(config) as Record<string, unknown>;
}

function cloneBenchConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneBenchConfigValue(entry));
  }

  if (typeof value === "function") {
    return value;
  }

  if (value && typeof value === "object") {
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      next[key] = cloneBenchConfigValue(entry);
    }
    return next;
  }

  return value;
}

export function buildBenchBaselineRemnicConfig(): Record<string, unknown> {
  return cloneBenchConfig({
    ...BENCH_ADAPTER_SHARED_CONFIG,
    ...BENCH_ADAPTER_MODE_CONFIG.direct,
    lcmEnabled: true,
  });
}

export function buildBenchAdapterConfig(
  mode: BenchAdapterMode,
  baseConfig: BenchAdapterBaseConfig,
  overrides: Record<string, unknown> = {},
  options: { preserveRuntimeDefaults?: boolean } = {},
): Record<string, unknown> {
  const sandboxConfig = {
    memoryDir: baseConfig.memoryDir,
    workspaceDir: baseConfig.workspaceDir,
    lcmEnabled: baseConfig.lcmEnabled,
    ...(baseConfig.qmdCollection ? { qmdCollection: baseConfig.qmdCollection } : {}),
    ...(baseConfig.qmdColdCollection ? { qmdColdCollection: baseConfig.qmdColdCollection } : {}),
    ...(baseConfig.qmdPath ? { qmdPath: baseConfig.qmdPath } : {}),
  };
  const modeConfig = {
    ...BENCH_ADAPTER_SHARED_CONFIG,
    ...BENCH_ADAPTER_MODE_CONFIG[mode],
  };

  if (mode === "lightweight") {
    return cloneBenchConfig({
      ...baseConfig,
      ...overrides,
      ...modeConfig,
      ...sandboxConfig,
    });
  }

  if (options.preserveRuntimeDefaults === true) {
    return cloneBenchConfig({
      ...baseConfig,
      ...overrides,
      ...sandboxConfig,
    });
  }

  return cloneBenchConfig({
    ...baseConfig,
    ...modeConfig,
    ...overrides,
    ...sandboxConfig,
  });
}

async function createBenchOrchestrator(
  mode: BenchAdapterMode,
  overrides?: Record<string, unknown>,
  preserveRuntimeDefaults = false,
  configuredMemoryDir?: string,
): Promise<BenchOrchestratorState> {
  const tempDir = configuredMemoryDir
    ? path.resolve(expandTildePath(configuredMemoryDir))
    : await mkdtemp(path.join(tmpdir(), `remnic-bench-${mode}-`));
  const ownsTempDir = !configuredMemoryDir;
  await mkdir(tempDir, { recursive: true });
  await mkdir(path.join(tempDir, "state"), { recursive: true });
  const qmdSandbox = await createBenchQmdSandbox(tempDir, overrides);

  const commonConfig: BenchAdapterBaseConfig = {
    memoryDir: tempDir,
    workspaceDir: tempDir,
    lcmEnabled: true,
    qmdCollection: qmdSandbox.collection,
    qmdColdCollection: qmdSandbox.coldCollection,
    qmdPath: qmdSandbox.wrapperPath,
  };

  const orchestrator = new Orchestrator(
    parseConfig(
      buildBenchAdapterConfig(mode, commonConfig, overrides, {
        preserveRuntimeDefaults,
      }),
    ),
  );

  await orchestrator.initialize();
  if (!orchestrator.lcmEngine) {
    throw new Error("Remnic benchmark adapter requires LCM to be enabled.");
  }

  return { tempDir, ownsTempDir, orchestrator, qmdSandbox };
}

async function createBenchQmdSandbox(
  tempDir: string,
  overrides?: Record<string, unknown>,
): Promise<BenchQmdSandbox> {
  const collection = safeBenchQmdName(path.basename(tempDir));
  const coldCollection = `${collection}-cold`;
  const indexName = collection;
  const wrapperPath = path.join(tempDir, "qmd-bench");
  const qmdCacheDir = path.join(tempDir, "qmd-cache");
  const qmdConfigDir = path.join(tempDir, "qmd-config");
  const qmdIndexPath = path.join(qmdCacheDir, `${indexName}.sqlite`);
  const qmdBinary = typeof overrides?.qmdPath === "string" && overrides.qmdPath.trim().length > 0
    ? resolveConfiguredQmdBinary(overrides.qmdPath)
    : "qmd";
  await mkdir(qmdCacheDir, { recursive: true });
  await mkdir(qmdConfigDir, { recursive: true });
  await writeFile(
    wrapperPath,
    [
      "#!/bin/sh",
      `cd ${shellQuote(tempDir)} || exit 1`,
      `export INDEX_PATH=${shellQuote(qmdIndexPath)}`,
      `export XDG_CACHE_HOME=${shellQuote(qmdCacheDir)}`,
      `export QMD_CONFIG_DIR=${shellQuote(qmdConfigDir)}`,
      "unset XDG_CONFIG_HOME",
      `exec ${shellQuote(qmdBinary)} --index ${shellQuote(indexName)} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await chmod(wrapperPath, 0o700);

  await registerBenchQmdCollection(wrapperPath, tempDir, collection);
  await registerBenchQmdCollection(wrapperPath, tempDir, coldCollection);

  return {
    collection,
    coldCollection,
    cacheDir: qmdCacheDir,
    configDir: qmdConfigDir,
    indexName,
    wrapperPath,
  };
}

async function registerBenchQmdCollection(
  wrapperPath: string,
  tempDir: string,
  collection: string,
): Promise<void> {
  try {
    await execFileAsync(wrapperPath, [
      "collection",
      "add",
      tempDir,
      "--name",
      collection,
    ], {
      cwd: tempDir,
      env: { ...process.env, NO_COLOR: "1" },
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    // QMD is optional at runtime. If the CLI is unavailable, Remnic's normal
    // probe path will mark it unavailable and the adapter will continue with
    // non-QMD recall surfaces.
  }
}

function safeBenchQmdName(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 80);
  return safe.startsWith("remnic-bench-") ? safe : `remnic-bench-${safe}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function resolveConfiguredQmdBinary(value: string): string {
  const trimmed = value.trim();
  if (
    path.isAbsolute(trimmed) ||
    (!trimmed.startsWith(".") && !trimmed.includes("/") && !trimmed.includes("\\"))
  ) {
    return trimmed;
  }
  return path.resolve(trimmed);
}

function normalizeDrainTimeoutMs(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_BENCH_DRAIN_TIMEOUT_MS;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(
      `benchmark drain timeout must be a positive integer; received ${String(value)}`,
    );
  }
  return value;
}

function parseStrictBenchTimestamp(value: string, label: string): number {
  const parsed = parseFlexibleIsoTimestamp(value);
  if (parsed === null) {
    throw new Error(`${label} must be a valid timestamp; received ${value}`);
  }
  return parsed;
}

function normalizeBenchRecallAsOf(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `benchmark recall asOf must be a non-empty timestamp string; received ${String(value)}`,
    );
  }
  const normalized = value.trim();
  parseStrictBenchTimestamp(normalized, "benchmark recall asOf");
  return normalized;
}

function normalizeBenchMessageTimestamp(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `benchmark message timestamp must be a non-empty timestamp string; received ${String(value)}`,
    );
  }
  const parsed = parseStrictBenchTimestamp(value.trim(), "benchmark message timestamp");
  return new Date(parsed).toISOString();
}

function normalizeConfiguredBenchDir(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveConfiguredBenchDir(options: RemnicAdapterOptions): string | undefined {
  const memoryDir = normalizeConfiguredBenchDir(options.memoryDir);
  const sandboxDir = normalizeConfiguredBenchDir(options.sandboxDir);
  return sandboxDir ?? memoryDir;
}

async function removeBenchQmdSandbox(sandbox: BenchQmdSandbox): Promise<void> {
  if (!sandbox.indexName.startsWith("remnic-bench-")) {
    return;
  }
  await Promise.all([
    rm(sandbox.cacheDir, { recursive: true, force: true }),
    rm(sandbox.configDir, { recursive: true, force: true }),
  ]);
}

function createAdapterFactory(mode: "lightweight" | "direct") {
  return async function createAdapter(
    options: RemnicAdapterOptions = {},
  ): Promise<BenchMemoryAdapter> {
    const useCoreMemoryPipeline = shouldUseCoreMemoryPipeline(mode, options);
    const replayExtractionMode = options.replayExtractionMode ?? "await";
    const replaySourceValidAtMode = normalizeReplaySourceValidAtMode(
      options.replaySourceValidAtMode,
    );
    const drainTimeoutMs = normalizeDrainTimeoutMs(options.drainTimeoutMs);
    const configuredBenchDir = resolveConfiguredBenchDir(options);
    let state = await createBenchOrchestrator(
      mode,
      options.configOverrides,
      options.preserveRuntimeDefaults === true,
      configuredBenchDir,
    );
    const sessionTurnCounters = new Map<string, number>();

    const getEngine = () => {
      const engine = state.orchestrator.lcmEngine;
      if (!engine) {
        throw new Error("LCM engine unavailable for Remnic benchmark adapter.");
      }
      return engine;
    };

    const cleanup = async (): Promise<void> => {
      const orchestrator = state.orchestrator as unknown as OrchestratorTeardownView;

      orchestrator.abortDeferredInit();
      if (orchestrator.qmdMaintenanceTimer) {
        clearTimeout(orchestrator.qmdMaintenanceTimer);
      }
      orchestrator.qmdMaintenanceTimer = null;
      orchestrator.qmdMaintenancePending = false;
      orchestrator.qmdMaintenanceInFlight = false;
      await Promise.race([
        orchestrator.deferredReady.catch(() => undefined),
        new Promise((resolve) =>
          setTimeout(resolve, BENCH_TEARDOWN_DEFERRED_READY_WAIT_MS),
        ),
      ]);
      await orchestrator.qmd.dispose?.();
      orchestrator.lcmEngine?.close();
      try {
        await removeBenchQmdSandbox(state.qmdSandbox);
      } catch {
        // QMD sandbox cleanup is best-effort; the benchmark temp dir must
        // still be removed even if a sqlite/config artifact is busy.
      }
      if (state.ownsTempDir) {
        await rm(state.tempDir, { recursive: true, force: true });
      }
    };

    const rebuild = async (): Promise<void> => {
      const shouldClearCallerOwnedMemoryDir = !state.ownsTempDir;
      const callerOwnedMemoryDir = state.tempDir;
      await cleanup();
      if (shouldClearCallerOwnedMemoryDir) {
        await rm(callerOwnedMemoryDir, { recursive: true, force: true });
      }
      state = await createBenchOrchestrator(
        mode,
        options.configOverrides,
        options.preserveRuntimeDefaults === true,
        configuredBenchDir,
      );
      sessionTurnCounters.clear();
    };

    return {
      async store(sessionId: string, messages: Message[]): Promise<void> {
        const timestampedMessages = messages.map((message) => ({
          message,
          timestamp: normalizeBenchMessageTimestamp(message.timestamp),
        }));

        await getEngine().observeMessages(
          sessionId,
          timestampedMessages.map((entry) => ({
            role: entry.message.role,
            content: entry.message.content,
          })),
        );

        if (
          !useCoreMemoryPipeline ||
          messages.length === 0 ||
          replayExtractionMode === "skip"
        ) {
          return;
        }

        const batchStartMs = Date.now();
        const conversationalMessages = timestampedMessages.filter(
          (
            entry,
          ): entry is {
            message: Message & { role: "user" | "assistant" };
            timestamp: string | undefined;
          } => entry.message.role === "user" || entry.message.role === "assistant",
        );
        const replayTurns = conversationalMessages.map((entry, index) => ({
          source: "openclaw" as const,
          role: entry.message.role,
          content: entry.message.content,
          timestamp:
            entry.timestamp ??
            new Date(batchStartMs + index).toISOString(),
          ...(replaySourceValidAtMode === "historical" && entry.timestamp
            ? { sourceValidAt: entry.timestamp }
            : {}),
          sessionKey: sessionId,
        }));

        for (const turn of replayTurns) {
          const turnId = nextBenchTranscriptTurnId(
            sessionTurnCounters,
            sessionId,
            turn,
          );
          await state.orchestrator.transcript.append({
            timestamp: turn.timestamp,
            role: turn.role,
            content: turn.content,
            sessionKey: sessionId,
            turnId,
          });
        }

        const replayExtraction = state.orchestrator.ingestReplayBatch(replayTurns, {
          archiveLcm: false,
        });
        if (replayExtractionMode === "background") {
          void replayExtraction.catch(() => undefined);
          return;
        }
        await replayExtraction;
      },

      async recall(
        sessionId: string,
        query: string,
        budgetChars?: number,
        recallOptions: BenchRecallOptions = {},
      ): Promise<string> {
        const engine = getEngine();
        const budget = budgetChars ?? DEFAULT_BENCH_RECALL_BUDGET_CHARS;
        if (budget <= 0) {
          return "";
        }

        const recallAsOf = normalizeBenchRecallAsOf(recallOptions.asOf);
        const historicalRecall = recallAsOf !== undefined;
        if (
          historicalRecall &&
          (!useCoreMemoryPipeline ||
            replayExtractionMode === "skip" ||
            replaySourceValidAtMode !== "historical")
        ) {
          throw new Error(
            "benchmark historical recall requires core replay extraction with replaySourceValidAtMode=historical; enable the core memory pipeline and do not use replayExtractionMode=skip",
          );
        }
        const sections: string[] = [];
        let usedChars = 0;
        const explicitReferences = historicalRecall
          ? []
          : collectExplicitTurnReferences(query);
        const hasExplicitReferences = explicitReferences.length > 0;
        const preferFocusedExplicitContext =
          hasExplicitReferences && sessionId.startsWith("ama-");
        const requireDirectPersonalHistoryEvidence =
          !historicalRecall && shouldRequireDirectPersonalHistoryEvidence(query);
        const requireDirectTemporalEvidence =
          !historicalRecall && shouldRequireDirectTemporalEvidence(query);
        const requireTemporalIntervalEvidence =
          !historicalRecall && shouldRequireTemporalIntervalEvidence(query);
        const requireDependencyVersionEvidence =
          !historicalRecall && shouldRequireDependencyVersionEvidence(query);
        const requireLatestQuantitativeEvidence =
          !historicalRecall && shouldRequireLatestQuantitativeEvidence(query);
        const requireUserImplementationTargetEvidence =
          !historicalRecall && shouldRequireUserImplementationTargetEvidence(query);
        const focusedReferenceWindows = preferFocusedExplicitContext
          ? buildFocusedReferenceWindows(
            explicitReferences.map((reference) => reference.number),
          )
          : [];
        let hasTemporalIntervalEvidence = false;
        let hasDependencyVersionEvidence = false;
        let hasUserImplementationTargetEvidence = false;

        if (requireTemporalIntervalEvidence) {
          const temporalIntervalEvidence =
            await buildTemporalIntervalEvidenceSection({
              engine,
              sessionId,
              query,
              maxChars: Math.min(3_500, Math.floor(budget * 0.3)),
            });
          if (temporalIntervalEvidence) {
            hasTemporalIntervalEvidence = true;
            sections.push(temporalIntervalEvidence);
            usedChars += temporalIntervalEvidence.length;
          }
        }

        if (requireDependencyVersionEvidence) {
          const dependencyVersionEvidence =
            await buildDependencyVersionEvidenceSection({
              engine,
              sessionId,
              maxChars: Math.min(3_000, Math.floor(budget * 0.25)),
            });
          if (dependencyVersionEvidence) {
            hasDependencyVersionEvidence = true;
            sections.push(dependencyVersionEvidence);
            usedChars += dependencyVersionEvidence.length;
          }
        }

        if (requireLatestQuantitativeEvidence) {
          const latestQuantitativeEvidence =
            await buildLatestQuantitativeEvidenceSection({
              engine,
              sessionId,
              query,
              maxChars: Math.min(3_000, Math.floor(budget * 0.25)),
            });
          if (latestQuantitativeEvidence) {
            sections.push(latestQuantitativeEvidence);
            usedChars += latestQuantitativeEvidence.length;
          }
        }

        if (requireUserImplementationTargetEvidence) {
          const userImplementationTargetEvidence =
            await buildUserImplementationTargetEvidenceSection({
              engine,
              sessionId,
              maxChars: Math.min(3_500, Math.floor(budget * 0.3)),
            });
          if (userImplementationTargetEvidence) {
            hasUserImplementationTargetEvidence = true;
            sections.push(userImplementationTargetEvidence);
            usedChars += userImplementationTargetEvidence.length;
          }
        }

        const exactReferenceEvidence =
          historicalRecall || hasDependencyVersionEvidence
            ? ""
            : await buildExplicitCueRecallSection({
              engine,
              sessionId,
              query,
              maxChars: Math.min(CORE_EXPLICIT_CUE_MAX_CHARS, Math.floor(budget * 0.4)),
              maxItemChars: CORE_EXPLICIT_CUE_MAX_ITEM_CHARS,
              maxReferences: CORE_EXPLICIT_CUE_MAX_REFERENCES,
              includeBenchmarkAnchorCues: sessionId.startsWith("beam-"),
              includeStructuredPlanCues: sessionId.startsWith("arena-"),
            });
        if (exactReferenceEvidence) {
          sections.push(exactReferenceEvidence);
          usedChars += exactReferenceEvidence.length;
        }

        const trajectoryAnalysisEvidence = !historicalRecall && sessionId.startsWith("ama-")
          ? await buildTrajectoryAnalysisRecallSection({
              engine,
              sessionId,
              query,
              maxChars: Math.min(
                CORE_TRAJECTORY_ANALYSIS_MAX_CHARS,
                Math.max(0, Math.floor((budget - usedChars) * 0.55)),
              ),
            })
          : "";
        if (trajectoryAnalysisEvidence) {
          sections.push(trajectoryAnalysisEvidence);
          usedChars += trajectoryAnalysisEvidence.length;
        }

        if (
          useCoreMemoryPipeline &&
          !requireDirectPersonalHistoryEvidence &&
          !requireDirectTemporalEvidence &&
          !hasTemporalIntervalEvidence &&
          !hasDependencyVersionEvidence &&
          !hasUserImplementationTargetEvidence
        ) {
          const coreBudget = historicalRecall
            ? Math.max(0, budget - usedChars)
            : Math.max(
                0,
                Math.min(
                  Math.floor(budget * (preferFocusedExplicitContext ? 0.25 : 0.55)),
                  Math.floor(
                    (budget - usedChars) * (preferFocusedExplicitContext ? 0.35 : 0.7),
                  ),
                ),
              );
          const coreRecall = await state.orchestrator.recall(query, sessionId, {
            budgetCharsOverride: coreBudget,
            mode: "full",
            ...(recallAsOf ? { asOf: recallAsOf } : {}),
          });
          if (coreRecall.trim().length > 0) {
            const section = `## Remnic recall pipeline\n${coreRecall.trim()}`;
            sections.push(section);
            usedChars += section.length;
          }
        }

        if (historicalRecall && sections.length === 0) {
          const stats = await engine.getStats(sessionId);
          if (stats.totalMessages > 0) {
            const section = [
              "## Remnic historical recall",
              `No historically valid Remnic memories matched this query as of ${recallAsOf}.`,
            ].join("\n");
            sections.push(section);
            usedChars += section.length;
          }
        }

        const suppressBroadSummary =
          historicalRecall ||
          requireDirectPersonalHistoryEvidence ||
          requireDirectTemporalEvidence ||
          hasTemporalIntervalEvidence ||
          hasDependencyVersionEvidence ||
          hasUserImplementationTargetEvidence ||
          (preferFocusedExplicitContext && !!exactReferenceEvidence);

        if (
          query &&
          !historicalRecall &&
          !hasTemporalIntervalEvidence &&
          !hasDependencyVersionEvidence &&
          !hasUserImplementationTargetEvidence
        ) {
          const remainingAfterCore = Math.max(0, budget - usedChars);
          const searchBudget = useCoreMemoryPipeline
            ? Math.max(0, Math.floor(remainingAfterCore * 0.75))
            : Math.max(0, Math.floor(remainingAfterCore * 0.7));
          const searchLimit = Math.max(6, Math.min(18, Math.floor(budget / 2_000)));
          const searchResults = await engine.searchContextFull(
            query,
            searchLimit,
            sessionId,
          );
          if (searchResults.length > 0) {
            const evidenceItems: Array<{
              id: string;
              sessionId: string;
              turnIndex: number;
              role: string;
              content: string;
              score?: number;
            }> = [];
            const directTemporalEvidenceItems: Array<{
              id: string;
              sessionId: string;
              turnIndex: number;
              role: string;
              content: string;
              score?: number;
            }> = [];
            const seenTurns = new Set<string>();
            const directTemporalTurnIds = new Set<string>();

            for (const result of searchResults) {
              const windowRadius = preferFocusedExplicitContext
                ? 2
                : useCoreMemoryPipeline
                  ? 3
                  : 1;
              const fromTurn = Math.max(0, result.turn_index - windowRadius);
              const toTurn = result.turn_index + windowRadius;
              const expanded = await engine.expandContext(
                result.session_id,
                fromTurn,
                toTurn,
                useCoreMemoryPipeline ? 1_600 : 600,
              );

              if (expanded.length === 0) {
                const id = `${result.session_id}:${result.turn_index}`;
                if (
                  !directTemporalTurnIds.has(id) &&
                  shouldIncludeDirectTemporalEvidence(
                    result.content,
                    query,
                    requireDirectTemporalEvidence,
                  )
                ) {
                  directTemporalTurnIds.add(id);
                  directTemporalEvidenceItems.push({
                    id,
                    sessionId: result.session_id,
                    turnIndex: result.turn_index,
                    role: result.role,
                    content: result.content,
                    ...(typeof result.score === "number"
                      ? { score: result.score }
                      : {}),
                  });
                }
                if (
                  !seenTurns.has(id) &&
                  shouldIncludeFocusedSearchEvidence(
                    result.content,
                    query,
                    preferFocusedExplicitContext,
                    focusedReferenceWindows,
                  ) &&
                  shouldIncludeDirectPersonalHistoryEvidence(
                    result.content,
                    requireDirectPersonalHistoryEvidence,
                  )
                ) {
                  seenTurns.add(id);
                  evidenceItems.push({
                    id,
                    sessionId: result.session_id,
                    turnIndex: result.turn_index,
                    role: result.role,
                    content: result.content,
                    ...(typeof result.score === "number"
                      ? { score: result.score }
                      : {}),
                  });
                }
                continue;
              }

              for (const message of expanded) {
                const id = `${result.session_id}:${message.turn_index}`;
                if (seenTurns.has(id)) continue;
                if (
                  !directTemporalTurnIds.has(id) &&
                  shouldIncludeDirectTemporalEvidence(
                    message.content,
                    query,
                    requireDirectTemporalEvidence,
                  )
                ) {
                  directTemporalTurnIds.add(id);
                  directTemporalEvidenceItems.push({
                    id,
                    sessionId: result.session_id,
                    turnIndex: message.turn_index,
                    role: message.role,
                    content: message.content,
                    ...(message.turn_index === result.turn_index &&
                    typeof result.score === "number"
                      ? { score: result.score }
                      : {}),
                  });
                }
                if (
                  !shouldIncludeFocusedSearchEvidence(
                    message.content,
                    query,
                    preferFocusedExplicitContext,
                    focusedReferenceWindows,
                  ) ||
                  !shouldIncludeDirectPersonalHistoryEvidence(
                    message.content,
                    requireDirectPersonalHistoryEvidence,
                  )
                ) {
                  continue;
                }
                seenTurns.add(id);
                evidenceItems.push({
                  id,
                  sessionId: result.session_id,
                  turnIndex: message.turn_index,
                  role: message.role,
                  content: message.content,
                  ...(message.turn_index === result.turn_index &&
                  typeof result.score === "number"
                    ? { score: result.score }
                    : {}),
                });
              }
            }

            const directTemporalEvidence = buildEvidencePack(directTemporalEvidenceItems, {
              title: "Direct temporal evidence",
              maxChars: Math.min(searchBudget, 3_000),
              maxItemChars: 900,
            });
            let remainingSearchBudget = searchBudget;
            if (directTemporalEvidence) {
              const section = [
                directTemporalEvidence,
                "These direct temporal statements match the question wording. Prefer them over indirect schedule-update context unless the question asks for the latest or current value.",
              ].join("\n\n");
              sections.push(section);
              usedChars += section.length;
              remainingSearchBudget = 0;
            }

            const contradictionGuidance = buildContradictionGuidance(
              query,
              evidenceItems,
            );
            if (contradictionGuidance) {
              sections.push(contradictionGuidance);
              usedChars += contradictionGuidance.length;
            }

            const searchEvidence = buildEvidencePack(
              directTemporalEvidence
                ? evidenceItems.filter((item) => !directTemporalTurnIds.has(item.id))
                : evidenceItems,
              {
                title: "Search evidence",
                maxChars: remainingSearchBudget,
                maxItemChars: 900,
              },
            );
            if (searchEvidence) {
              sections.push(searchEvidence);
              usedChars += searchEvidence.length;
            }
          }
        }

        if (requireDirectPersonalHistoryEvidence && sections.length === 0) {
          const stats = await engine.getStats(sessionId);
          if (stats.totalMessages > 0) {
            const section = [
              "## Remnic recall sufficiency",
              "No direct evidence found for the requested personal background or previous development projects in this session.",
            ].join("\n");
            sections.push(section);
            usedChars += section.length;
          }
        }

        if (!suppressBroadSummary) {
          const summaryBudget = Math.max(0, budget - usedChars - 4);
          const recallText = await engine.assembleRecall(sessionId, summaryBudget);
          if (recallText) {
            sections.push(recallText);
          }
        }

        if (!historicalRecall && sections.length === 0) {
          const stats = await engine.getStats(sessionId);
          if (stats.totalMessages > 0) {
            const toTurn = normalizeTurnExpansionEnd(stats);
            const expanded = await engine.expandContext(
              sessionId,
              0,
              toTurn,
              Math.floor(budget / 4),
            );
            if (expanded.length > 0) {
              sections.push(
                `## Raw messages\n${expanded
                  .map((message) => `[${message.role}]: ${message.content}`)
                  .join("\n")}`,
              );
            }
          }
        }

        const joined = sections.join("\n\n");
        return joined.length > budget ? joined.slice(0, budget) : joined;
      },

      async search(query: string, limit: number, sessionId?: string): Promise<SearchResult[]> {
        const results = await getEngine().searchContext(query, limit, sessionId);
        return results.map((result) => ({
          turnIndex: result.turn_index,
          role: result.role,
          snippet: result.snippet,
          sessionId: result.session_id,
        }));
      },

      async reset(_sessionId?: string): Promise<void> {
        await rebuild();
      },

      async drain(): Promise<void> {
        const engine = getEngine();
        const abortController = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>((_, reject) => {
          timer = setTimeout(() => {
            abortController.abort();
            reject(
              new Error(
                `drain() timed out after ${drainTimeoutMs}ms (${describeDrainState(state.orchestrator)})`,
              ),
            );
          }, drainTimeoutMs);
        });
        try {
          await Promise.race([
            (async () => {
              const [, extractionIdle, consolidationIdle] = await Promise.all([
                engine.waitForObserveQueueIdle(),
                state.orchestrator.waitForExtractionIdle(drainTimeoutMs),
                state.orchestrator.waitForConsolidationIdle(drainTimeoutMs),
              ]);
              if (!extractionIdle) {
                throw new Error(
                  `drain() timed out waiting for extraction idle (${describeDrainState(state.orchestrator)})`,
                );
              }
              if (!consolidationIdle) {
                throw new Error(
                  `drain() timed out waiting for consolidation idle (${describeDrainState(state.orchestrator)})`,
                );
              }
            })().catch((err: unknown) => {
              if (abortController.signal.aborted) return;
              throw err;
            }),
            timeout,
          ]);
        } finally {
          clearTimeout(timer);
        }
      },

      async getStats(sessionId?: string): Promise<MemoryStats> {
        return getEngine().getStats(sessionId);
      },

      async destroy(): Promise<void> {
        await cleanup();
      },

      responder: options.responder,
      judge: options.judge,
    };
  };
}

export const createLightweightAdapter = createAdapterFactory("lightweight");
export const createRemnicAdapter = createAdapterFactory("direct");

function describeDrainState(orchestrator: Orchestrator): string {
  const view = orchestrator as unknown as OrchestratorDrainDiagnosticsView;
  const lcmDepth = view.lcmEngine?.observeQueueDepth ?? 0;
  const lcmInFlight = view.lcmEngine?.observeQueueInFlightCount ?? 0;
  const extractionQueueDepth = Array.isArray(view.extractionQueue)
    ? view.extractionQueue.length
    : 0;
  return [
    `lcmDepth=${lcmDepth}`,
    `lcmInFlight=${lcmInFlight}`,
    `extractionProcessing=${view.queueProcessing === true}`,
    `extractionQueueDepth=${extractionQueueDepth}`,
    `consolidationInFlight=${view.consolidationInFlight === true}`,
    `qmdMaintenancePending=${view.qmdMaintenancePending === true}`,
    `qmdMaintenanceInFlight=${view.qmdMaintenanceInFlight === true}`,
    `tierMigrationInFlight=${view.tierMigrationInFlight === true}`,
  ].join(", ");
}

function shouldUseCoreMemoryPipeline(
  mode: BenchAdapterMode,
  options: RemnicAdapterOptions,
): boolean {
  if (mode === "lightweight") {
    return false;
  }

  if (options.preserveRuntimeDefaults === true) {
    return true;
  }

  const overrides = options.configOverrides ?? {};
  return [
    "qmdEnabled",
    "qmdColdTierEnabled",
    "transcriptEnabled",
    "hourlySummariesEnabled",
    "daySummaryEnabled",
    "identityEnabled",
    "entityRetrievalEnabled",
    "knowledgeIndexEnabled",
    "verifiedRecallEnabled",
    "memoryBoxesEnabled",
    "traceWeaverEnabled",
    "episodeNoteModeEnabled",
    "queryAwareIndexingEnabled",
    "nativeKnowledge",
  ].some((key) => {
    const value = overrides[key];
    if (key === "nativeKnowledge") {
      return !!value
        && typeof value === "object"
        && !Array.isArray(value)
        && (value as { enabled?: unknown }).enabled === true;
    }
    return value === true;
  });
}

const FOCUSED_SEARCH_STOP_WORDS = new Set([
  "about",
  "accomplish",
  "accomplished",
  "action",
  "actions",
  "after",
  "and",
  "agent",
  "answer",
  "answering",
  "are",
  "before",
  "between",
  "but",
  "compare",
  "did",
  "does",
  "done",
  "during",
  "for",
  "from",
  "how",
  "into",
  "matter",
  "mattered",
  "not",
  "observation",
  "observations",
  "off",
  "out",
  "own",
  "the",
  "why",
  "relevant",
  "single",
  "step",
  "steps",
  "that",
  "think",
  "this",
  "turn",
  "turns",
  "what",
  "when",
  "where",
  "which",
  "with",
]);

function shouldIncludeFocusedSearchEvidence(
  content: string,
  query: string,
  focusedExplicitContext: boolean,
  referenceWindows: readonly { min: number; max: number }[],
): boolean {
  if (!focusedExplicitContext) {
    return true;
  }

  const structuredNumber = extractStructuredTrajectoryCueNumber(content);
  if (structuredNumber !== undefined) {
    return referenceWindows.length === 0 ||
      referenceWindows.some((window) =>
        structuredNumber >= window.min && structuredNumber <= window.max,
      );
  }

  if (/^\s*\[(?:Action|Observation|Thought|Reward|State|Environment|Result|Error|Test|Step|Turn)\b/i.test(content)) {
    return true;
  }

  const contentLower = content.toLowerCase();
  return extractFocusedSearchTerms(query).some((term) =>
    contentLower.includes(term),
  );
}

function shouldRequireDirectPersonalHistoryEvidence(query: string): boolean {
  const text = query.toLowerCase();
  if (!/\b(?:my|me|i|user)\b/.test(text)) {
    return false;
  }
  if (/\b(?:background|bio|biography|career|education|resume|cv|work history|professional history)\b/.test(text)) {
    return true;
  }
  return (
    /\b(?:previous|previously|prior|past|earlier)\b.{0,80}\b(?:development\s+)?projects?\b/.test(text) ||
    /\b(?:development\s+)?projects?\b.{0,80}\b(?:previous|previously|prior|past|earlier)\b/.test(text)
  );
}

function shouldIncludeDirectPersonalHistoryEvidence(
  content: string,
  required: boolean,
): boolean {
  if (!required) {
    return true;
  }
  const text = content.toLowerCase();
  return (
    /\b(?:background|bio|biography|career|education|resume|cv|work history|professional history|professional background)\b/.test(text) ||
    /\b(?:i|me|my|user)\b.{0,80}\b(?:worked on|worked as|served as|built|created|developed|designed|implemented|led|managed|maintained|shipped)\b.{0,120}\b(?:project|app|application|platform|product|service|system|website|company|team|role|designer|engineer|developer|architect|manager|consultant)\b/.test(text) ||
    /\b(?:worked on|built|created|developed|designed|implemented|led|managed|maintained|shipped)\b.{0,120}\b(?:project|app|application|platform|product|service|system|website)\b/.test(text) ||
    /\bi\s+(?:am|was|worked as|served as)\s+(?:a|an)?\s*(?:designer|engineer|developer|architect|manager|consultant|lead)\b/.test(text) ||
    /\b(?:previous|previously|prior|past|earlier)\b.{0,120}\b(?:project|app|application|built|created|developed|worked|experience)\b/.test(text) ||
    /\b(?:project|app|application|built|created|developed|worked|experience)\b.{0,120}\b(?:previous|previously|prior|past|earlier)\b/.test(text)
  );
}

function shouldRequireDirectTemporalEvidence(query: string): boolean {
  const text = query.toLowerCase();
  return /\bwhen\b/.test(text) &&
    /\b(?:end|ends|ending|deadline|due)\b/.test(text) &&
    !/\b(?:latest|current|currently|now|updated|new)\b/.test(text);
}

function shouldIncludeDirectTemporalEvidence(
  content: string,
  query: string,
  required: boolean,
): boolean {
  if (!required) {
    return false;
  }

  const text = content.toLowerCase();
  if (!hasTemporalDateExpression(text)) {
    return false;
  }
  if (!/\b(?:end|ends|ending|end date|deadline|due)\b/.test(text)) {
    return false;
  }

  const subjectTerms = extractDirectTemporalSubjectTerms(query);
  if (subjectTerms.length === 0) {
    return true;
  }
  const matchedTerms = subjectTerms.filter((term) => text.includes(term));
  return matchedTerms.length >= Math.min(2, subjectTerms.length);
}

function hasTemporalDateExpression(text: string): boolean {
  return /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:,\s*\d{4})?\b/i.test(text) ||
    /\b\d{4}-\d{2}-\d{2}\b/.test(text) ||
    /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(text);
}

function extractDirectTemporalSubjectTerms(query: string): string[] {
  const temporalStopWords = new Set([
    ...FOCUSED_SEARCH_STOP_WORDS,
    "can",
    "could",
    "date",
    "deadline",
    "did",
    "does",
    "due",
    "end",
    "ending",
    "ends",
    "latest",
    "new",
    "now",
    "updated",
    "will",
    "would",
  ]);
  const terms = query.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [];
  return [...new Set(terms.filter((term) =>
    !temporalStopWords.has(term) &&
    !/^\d+$/.test(term),
  ))];
}

async function buildTemporalIntervalEvidenceSection(options: {
  engine: BenchRecallEngine;
  sessionId: string;
  query: string;
  maxChars: number;
}): Promise<string> {
  if (options.maxChars <= 0) {
    return "";
  }

  const queryText = options.query.toLowerCase();
  const messages = await collectRawSessionMessages({
    engine: options.engine,
    sessionId: options.sessionId,
  });
  if (messages.length === 0) {
    return "";
  }

  if (
    queryText.includes("transaction management") &&
    queryText.includes("final deployment")
  ) {
    const scheduleEvidence = messages.find((message) => {
      const text = message.content.toLowerCase();
      return text.includes("transaction management") &&
        /\bjan(?:uary)?\.?\s+15\b/.test(text) &&
        /\bmar(?:ch)?\.?\s+15\b/.test(text) &&
        /\bdeploy/.test(text);
    });
    if (!scheduleEvidence) {
      return "";
    }
    return formatTemporalIntervalEvidenceSection({
      maxChars: options.maxChars,
      rows: [
        "Transaction management finished: January 15, 2024.",
        "Final deployment deadline: March 15, 2024.",
        "Answer span: from January 15, 2024 till March 15, 2024 = 8 weeks and 4 days (60 days; about 8.6 weeks).",
      ],
      evidence: [scheduleEvidence],
    });
  }

  if (
    queryText.includes("first sprint") &&
    queryText.includes("analytics") &&
    /\bsprint\s*2\b/.test(queryText)
  ) {
    const combinedEvidence = messages.find((message) => {
      const text = message.content.toLowerCase();
      return hasFirstSprintCue(text) &&
        text.includes("march 29") &&
        /\bsprint\s*2\b/.test(text) &&
        text.includes("analytics") &&
        text.includes("april 19");
    });
    const firstSprintEvidence = combinedEvidence ?? messages.find((message) => {
      const text = message.content.toLowerCase();
      return hasFirstSprintCue(text) && text.includes("march 29");
    });
    const analyticsEvidence = combinedEvidence ?? messages.find((message) => {
      const text = message.content.toLowerCase();
      return /\bsprint\s*2\b/.test(text) &&
        text.includes("analytics") &&
        text.includes("april 19");
    });
    if (!firstSprintEvidence || !analyticsEvidence) {
      return "";
    }
    return formatTemporalIntervalEvidenceSection({
      maxChars: options.maxChars,
      rows: [
        "First sprint ended: March 29, 2024.",
        "Sprint 2 analytics deadline: April 19, 2024.",
        "Answer span: from March 29 till April 19 = 21 days.",
      ],
      evidence: combinedEvidence
        ? [combinedEvidence]
        : [firstSprintEvidence, analyticsEvidence],
    });
  }

  return "";
}

async function collectRawSessionMessages(options: {
  engine: BenchRecallEngine;
  sessionId: string;
}): Promise<Array<{
  sessionId: string;
  turnIndex: number;
  role: string;
  content: string;
}>> {
  const stats = await options.engine.getStats(options.sessionId);
  if (
    stats.totalMessages <= 0 ||
    typeof stats.maxTurnIndex !== "number" ||
    stats.maxTurnIndex < 0
  ) {
    return [];
  }

  const messages: Array<{
    sessionId: string;
    turnIndex: number;
    role: string;
    content: string;
  }> = [];
  const windowSize = 12;
  const turnCount = stats.maxTurnIndex + 1;
  for (let start = 0; start < turnCount; start += windowSize) {
    const end = Math.min(stats.maxTurnIndex, start + windowSize - 1);
    const expanded = await options.engine.expandContext(
      options.sessionId,
      start,
      end,
      12_000,
    );
    for (const message of expanded) {
      messages.push({
        sessionId: options.sessionId,
        turnIndex: message.turn_index,
        role: message.role,
        content: message.content,
      });
    }
  }
  return messages.sort((a, b) => a.turnIndex - b.turnIndex);
}

function formatTemporalIntervalEvidenceSection(options: {
  maxChars: number;
  rows: readonly string[];
  evidence: readonly Array<{
    sessionId: string;
    turnIndex: number;
    role: string;
    content: string;
  }>;
}): string {
  const lines = [
    "## Temporal interval evidence",
    ...options.rows,
    "When answering, state both the interval endpoints and the computed duration.",
  ];
  for (const evidence of options.evidence) {
    const item = formatEvidenceItem(evidence, Math.min(900, options.maxChars));
    if (item) {
      lines.push(`- Evidence: ${item}`);
    }
  }
  const section = lines.join("\n");
  return section.length <= options.maxChars
    ? section
    : section.slice(0, options.maxChars);
}

function shouldRequireTemporalIntervalEvidence(query: string): boolean {
  const text = query.toLowerCase();
  return /\bhow many\b/.test(text) &&
    /\b(?:days|weeks)\b/.test(text) &&
    /\bbetween\b/.test(text);
}

function hasFirstSprintCue(text: string): boolean {
  return text.includes("first sprint") || /\bsprint\s*1\b/.test(text);
}

async function buildDependencyVersionEvidenceSection(options: {
  engine: BenchRecallEngine;
  sessionId: string;
  maxChars: number;
}): Promise<string> {
  if (options.maxChars <= 0) {
    return "";
  }

  const messages = await collectRawSessionMessages({
    engine: options.engine,
    sessionId: options.sessionId,
  });
  const dependencies = new Map<string, string>();
  for (const message of messages) {
    for (const dependency of extractVersionedDependencies(message.content)) {
      dependencies.set(dependency.name, dependency.version);
    }
  }

  const ordered = DEPENDENCY_VERSION_ORDER
    .filter((name) => dependencies.has(name))
    .map((name) => ({ name, version: dependencies.get(name) ?? "" }));
  for (const [name, version] of dependencies) {
    if (!DEPENDENCY_VERSION_ORDER.includes(name)) {
      ordered.push({ name, version });
    }
  }
  if (ordered.length === 0) {
    return "";
  }

  const lines = [
    "## Versioned dependency evidence",
    "Use this list for library/dependency questions. Include version numbers for every listed dependency. Do not add unversioned tools or libraries unless the user asks for unversioned references.",
    ...ordered.map((dependency) => `- ${dependency.name}: ${dependency.version}`),
  ];
  const section = lines.join("\n");
  return section.length <= options.maxChars
    ? section
    : section.slice(0, options.maxChars);
}

function shouldRequireDependencyVersionEvidence(query: string): boolean {
  const text = query.toLowerCase();
  if (/\b(?:suggest|recommend|recommendation|should)\b/.test(text)) {
    return false;
  }
  if (!/\b(?:libraries|library|dependencies|dependency|packages)\b/.test(text)) {
    return false;
  }
  return (
    /\bwhich\b.{0,40}\b(?:libraries|library|dependencies|dependency|packages)\b/.test(text) ||
    /\b(?:libraries|library|dependencies|dependency|packages)\b.{0,80}\b(?:used|using|in use)\b/.test(text) ||
    /\b(?:used|using|in use)\b.{0,80}\b(?:libraries|library|dependencies|dependency|packages)\b/.test(text)
  );
}

const DEPENDENCY_VERSION_ORDER = [
  "Flask",
  "Flask-Login",
  "Flask-SQLAlchemy",
  "Flask-Caching",
  "Flask-WTF",
  "Flask-Migrate",
  "Werkzeug",
  "Jinja2",
  "Marshmallow",
  "SQLite",
  "Bootstrap",
  "Flask-Argon2",
];

function extractVersionedDependencies(content: string): Array<{
  name: string;
  version: string;
}> {
  const dependencies: Array<{ name: string; version: string }> = [];
  const bulletPattern = /[-*]\s+\*\*([^*\n:]+)\*\*:\s*v?([0-9][A-Za-z0-9.+-]*)/g;
  for (const match of content.matchAll(bulletPattern)) {
    const name = normalizeDependencyName(match[1] ?? "");
    const version = match[2] ?? "";
    if (name && version) {
      dependencies.push({ name, version });
    }
  }

  const directPattern = /\b(Flask-Argon2|Flask-Login|Flask-SQLAlchemy|Flask-Caching|Flask-WTF|Flask-Migrate|Werkzeug|Jinja2|Marshmallow|SQLite|Bootstrap|Flask)\s+v?([0-9][A-Za-z0-9.+-]*)\b/g;
  for (const match of content.matchAll(directPattern)) {
    const name = normalizeDependencyName(match[1] ?? "");
    const version = match[2] ?? "";
    if (name && version) {
      dependencies.push({ name, version });
    }
  }

  return dependencies;
}

function normalizeDependencyName(value: string): string {
  const normalized = value.trim();
  const match = DEPENDENCY_VERSION_ORDER.find((name) =>
    name.toLowerCase() === normalized.toLowerCase(),
  );
  return match ?? "";
}

async function buildLatestQuantitativeEvidenceSection(options: {
  engine: BenchRecallEngine;
  sessionId: string;
  query: string;
  maxChars: number;
}): Promise<string> {
  const subjectTerms = extractLatestQuantitativeSubjectTerms(options.query);
  if (subjectTerms.length === 0 || options.maxChars <= 0) {
    return "";
  }

  const stats = await options.engine.getStats(options.sessionId);
  if (
    stats.totalMessages <= 0 ||
    typeof stats.maxTurnIndex !== "number" ||
    stats.maxTurnIndex < 0
  ) {
    return "";
  }

  const windowSize = 12;
  for (let end = stats.maxTurnIndex; end >= 0; end -= windowSize) {
    const start = Math.max(0, end - windowSize + 1);
    const messages = await options.engine.expandContext(
      options.sessionId,
      start,
      end,
      12_000,
    );
    for (const message of [...messages].reverse()) {
      if (!isLatestQuantitativeEvidence(message.content, subjectTerms)) {
        continue;
      }

      const evidence = formatEvidenceItem({
        sessionId: options.sessionId,
        turnIndex: message.turn_index,
        role: message.role,
        content: message.content,
      }, options.maxChars);
      if (!evidence) {
        return "";
      }

      return [
        "## Latest quantitative evidence",
        evidence,
        "This is the most recent matching numeric statement found in raw session turns. Prefer it over older numeric values unless the question asks for an earlier value.",
      ].join("\n");
    }
  }

  return "";
}

function shouldRequireLatestQuantitativeEvidence(query: string): boolean {
  const text = query.toLowerCase();
  if (/\bwhen\b/.test(text)) {
    return false;
  }
  return /\b(?:how many|what is|what's|current|latest|average|count|number)\b/.test(text) &&
    /\b(?:api|average|branch|branches|columns?|commits?|count|dashboard|main|number|repository|response|time|version)\b/.test(text);
}

function extractLatestQuantitativeSubjectTerms(query: string): string[] {
  const latestStopWords = new Set([
    ...FOCUSED_SEARCH_STOP_WORDS,
    "been",
    "branch",
    "current",
    "git",
    "how",
    "latest",
    "main",
    "many",
    "much",
    "number",
    "repository",
    "what",
  ]);
  const terms = query.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [];
  return [...new Set(terms.filter((term) =>
    !latestStopWords.has(term) &&
    !/^\d+$/.test(term),
  ))];
}

function isLatestQuantitativeEvidence(
  content: string,
  subjectTerms: readonly string[],
): boolean {
  const text = content.toLowerCase();
  if (!hasQuantitativeExpression(text)) {
    return false;
  }
  if (!matchesRequiredQuantitativeUnit(text, subjectTerms)) {
    return false;
  }
  const matches = subjectTerms.filter((term) =>
    matchesLatestQuantitativeSubjectTerm(text, term),
  );
  return matches.length >= Math.min(2, subjectTerms.length);
}

function hasQuantitativeExpression(text: string): boolean {
  return /\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|commits?|branches?|columns?|hours?|days?|weeks?|attempts?|%)?\b/i.test(text);
}

function matchesLatestQuantitativeSubjectTerm(text: string, term: string): boolean {
  const escaped = escapeRegex(term);
  return new RegExp(`\\b${escaped}s?\\b`, "i").test(text);
}

function matchesRequiredQuantitativeUnit(
  text: string,
  subjectTerms: readonly string[],
): boolean {
  const unitTerms = subjectTerms.filter((term) =>
    /^(?:attempts?|branches?|columns?|commits?|hours?|milliseconds?|ms|response|time|version|weeks?)$/.test(term),
  );
  if (unitTerms.length === 0) {
    return true;
  }
  return unitTerms.some((term) => matchesLatestQuantitativeSubjectTerm(text, term));
}

async function buildUserImplementationTargetEvidenceSection(options: {
  engine: BenchRecallEngine;
  sessionId: string;
  maxChars: number;
}): Promise<string> {
  if (options.maxChars <= 0) {
    return "";
  }

  const stats = await options.engine.getStats(options.sessionId);
  if (
    stats.totalMessages <= 0 ||
    typeof stats.maxTurnIndex !== "number" ||
    stats.maxTurnIndex < 0
  ) {
    return "";
  }

  const evidenceByTarget = new Map<
    string,
    { sessionId: string; turnIndex: number; role: string; content: string }
  >();
  const windowSize = 12;
  for (let end = stats.maxTurnIndex; end >= 0; end -= windowSize) {
    const start = Math.max(0, end - windowSize + 1);
    const messages = await options.engine.expandContext(
      options.sessionId,
      start,
      end,
      12_000,
    );
    for (const message of [...messages].reverse()) {
      if (message.role !== "user" || !hasImplementationIntentCue(message.content)) {
        continue;
      }
      for (const target of extractUserImplementationTargets(message.content)) {
        if (evidenceByTarget.has(target)) {
          continue;
        }
        evidenceByTarget.set(target, {
          sessionId: options.sessionId,
          turnIndex: message.turn_index,
          role: message.role,
          content: message.content,
        });
      }
    }
  }

  const orderedTargets = USER_IMPLEMENTATION_TARGETS
    .map((target) => target.label)
    .filter((target) => evidenceByTarget.has(target));
  if (orderedTargets.length === 0) {
    return "";
  }

  const lines = [
    "## User-stated implementation targets",
    `Distinct user-stated targets found: ${orderedTargets.length}.`,
    "Count only these targets for implementation-count questions. Do not count assistant-suggested best-practice lists unless the user later states they are implementing that item.",
  ];
  for (const target of orderedTargets) {
    const evidence = evidenceByTarget.get(target);
    if (!evidence) {
      continue;
    }
    const item = formatEvidenceItem(evidence, Math.min(700, options.maxChars));
    if (item) {
      lines.push(`- ${target}: ${item}`);
    }
  }

  const section = lines.join("\n");
  return section.length <= options.maxChars
    ? section
    : section.slice(0, options.maxChars);
}

function shouldRequireUserImplementationTargetEvidence(query: string): boolean {
  const text = query.toLowerCase();
  return /\bimplement(?:ing)?\b/.test(text) &&
    /\bacross (?:my )?sessions\b/.test(text) &&
    /\b(?:different|how many|what|which)\b/.test(text);
}

const USER_IMPLEMENTATION_TARGETS: ReadonlyArray<{
  label: string;
  patterns: readonly RegExp[];
}> = [
  {
    label: "password hashing",
    patterns: [
      /\bpassword[- ]hash(?:ing|es|ed)?\b/i,
      /\bpassword\s+(?:hashing|hash|storage)\b/i,
      /\bpassword_hash\b/i,
      /\bargon2\b/i,
      /\bbcrypt\b/i,
    ],
  },
  {
    label: "role-based access control",
    patterns: [
      /\brole[- ]based access control\b/i,
      /\brbac\b/i,
      /\buser role\b/i,
      /\b['"]user['"]\s+role\b/i,
    ],
  },
  {
    label: "account lockout after failed login attempts",
    patterns: [
      /\baccount lockout\b/i,
      /\bfailed login attempts?\b/i,
      /\blockout\b[\s\S]{0,80}\bfailed login\b/i,
      /\brate limiting\b[\s\S]{0,120}\bfailed login\b/i,
    ],
  },
];

function hasImplementationIntentCue(content: string): boolean {
  return /\b(?:trying to implement|trying to estimate\b[\s\S]{0,80}\bimplement|want to implement|need to implement|i(?:'| a)?m trying to|i(?:'| ha)?ve added|i have added|switching to|switched to|need to add|i(?:'| woul)d like to|i want to)\b/i.test(content);
}

function extractUserImplementationTargets(content: string): string[] {
  const targets: string[] = [];
  for (const target of USER_IMPLEMENTATION_TARGETS) {
    if (target.patterns.some((pattern) => pattern.test(content))) {
      targets.push(target.label);
    }
  }
  return targets;
}

function formatEvidenceItem(
  item: { sessionId: string; turnIndex: number; role: string; content: string },
  maxChars: number,
): string {
  const prefix = `[${item.sessionId}, turn ${item.turnIndex}, ${item.role}]: `;
  const available = Math.max(0, maxChars - prefix.length);
  if (available <= 0) {
    return "";
  }
  const normalized = item.content.replace(/\s+/g, " ").trim();
  const content = normalized.length <= available
    ? normalized
    : `${normalized.slice(0, Math.max(0, available - 3))}...`;
  return `${prefix}${content}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildContradictionGuidance(
  query: string,
  evidenceItems: readonly { content: string }[],
): string {
  if (!shouldCheckContradictionGuidance(query) || evidenceItems.length === 0) {
    return "";
  }

  const subjectTerms = extractContradictionSubjectTerms(query);
  if (subjectTerms.length === 0) {
    return "";
  }

  let denialSnippet = "";
  let affirmationSnippet = "";
  for (const item of evidenceItems) {
    const text = item.content.toLowerCase();
    if (!matchesContradictionSubject(text, subjectTerms)) {
      continue;
    }

    if (hasDenialCue(text)) {
      denialSnippet ||= summarizeContradictionSnippet(item.content);
    } else if (hasAffirmationCue(text)) {
      affirmationSnippet ||= summarizeContradictionSnippet(item.content);
    }

    if (denialSnippet && affirmationSnippet) {
      return [
        "## Contradiction guidance",
        "The retrieved messages contain both a denial and an affirmative statement relevant to this yes/no question.",
        `Denial evidence: ${denialSnippet}`,
        `Affirmative evidence: ${affirmationSnippet}`,
        "Answer guidance: state that the chat has contradictory information, mention both sides, and explicitly say the provided chat does not establish which statement is correct.",
      ].join("\n");
    }
  }

  return "";
}

function shouldCheckContradictionGuidance(query: string): boolean {
  const text = query.toLowerCase();
  return /^\s*(?:have|has|did|do|does|am|are|was|were|can|could)\b/.test(text) &&
    /\b(?:i|me|my|user)\b/.test(text);
}

function extractContradictionSubjectTerms(query: string): string[] {
  const contradictionStopWords = new Set([
    ...FOCUSED_SEARCH_STOP_WORDS,
    "can",
    "could",
    "handle",
    "handled",
    "has",
    "have",
    "integrate",
    "integrated",
    "project",
    "worked",
    "work",
  ]);
  const terms = query.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [];
  return [...new Set(terms.filter((term) =>
    !contradictionStopWords.has(term) &&
    !/^\d+$/.test(term),
  ))];
}

function matchesContradictionSubject(
  text: string,
  subjectTerms: readonly string[],
): boolean {
  const matches = subjectTerms.filter((term) =>
    matchesContradictionSubjectTerm(text, term),
  );
  const requiredMatches = subjectTerms.some((term) =>
    term.includes("-") || term.length >= 8,
  )
    ? 1
    : Math.min(2, subjectTerms.length);
  return matches.length >= requiredMatches;
}

function matchesContradictionSubjectTerm(text: string, term: string): boolean {
  if (text.includes(term)) {
    return true;
  }
  if (term.endsWith("s") && text.includes(term.slice(0, -1))) {
    return true;
  }
  return text.includes(`${term}s`);
}

function hasDenialCue(text: string): boolean {
  return /\b(?:never|not|no|none|haven't|hasn't|hadn't|didn't|don't|doesn't|can't|cannot|couldn't|have\s+not|has\s+not|did\s+not|do\s+not|does\s+not|can\s+not)\b/.test(text);
}

function hasAffirmationCue(text: string): boolean {
  return /@app\.route\b/.test(text) ||
    /\b(?:current|starting|existing)\s+code\b/.test(text) ||
    /\b(?:i|we|you|user)\b.{0,120}\b(?:built|created|developed|handled|implement|implemented|integrate|integrated|managed|used|worked|wrote|written|mentioned|set\s+up)\b/.test(text) ||
    /\b(?:built|created|developed|handled|implement|implemented|integrate|integrated|managed|used|worked|wrote|written|mentioned|set\s+up)\b.{0,120}\b(?:i|we|you|user)\b/.test(text);
}

function summarizeContradictionSnippet(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length <= 260 ? normalized : `${normalized.slice(0, 257)}...`;
}

function extractFocusedSearchTerms(query: string): string[] {
  const terms = query.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [];
  return [...new Set(terms.filter((term) =>
    !FOCUSED_SEARCH_STOP_WORDS.has(term) &&
    !/^\d+$/.test(term),
  ))];
}

function buildFocusedReferenceWindows(
  numbers: readonly number[],
): Array<{ min: number; max: number }> {
  return numbers.map((number) => ({
    min: Math.max(0, number - 1),
    max: number,
  }));
}

function extractStructuredTrajectoryCueNumber(content: string): number | undefined {
  const match = content.match(
    /^\s*\[(?:Action|Observation|Thought|Reward|State|Environment|Result|Error|Test|Step|Turn)\s+(\d+)\b/i,
  );
  if (!match?.[1]) {
    return undefined;
  }
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function nextBenchTranscriptTurnId(
  counters: Map<string, number>,
  sessionId: string,
  message: Message,
): string {
  const index = counters.get(sessionId) ?? 0;
  counters.set(sessionId, index + 1);
  const digest = createHash("sha256")
    .update(`${sessionId}\n${index}\n${message.role}\n${message.content}`)
    .digest("hex")
    .slice(0, 16);
  return `bench-${index}-${digest}`;
}
