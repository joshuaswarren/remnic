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
  normalizeTurnExpansionEnd,
  Orchestrator,
  parseConfig,
} from "@remnic/core";
import type {
  BenchJudge,
  BenchMemoryAdapter,
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
  lcmLeafBatchSize: 4,
  lcmRollupFanIn: 3,
  lcmFreshTailTurns: 8,
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

const BENCH_TEARDOWN_DEFERRED_READY_WAIT_MS = 500;
const DEFAULT_BENCH_DRAIN_TIMEOUT_MS = 5 * 60_000;
const CORE_EXPLICIT_CUE_MAX_CHARS = 18_000;
const CORE_EXPLICIT_CUE_MAX_ITEM_CHARS = 2_400;
const CORE_EXPLICIT_CUE_MAX_REFERENCES = 24;
const CORE_TRAJECTORY_ANALYSIS_MAX_CHARS = 18_000;
const execFileAsync = promisify(execFile);

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
): Promise<{
  tempDir: string;
  ownsTempDir: boolean;
  orchestrator: Orchestrator;
  qmdSandbox: BenchQmdSandbox;
}> {
  const tempDir = configuredMemoryDir
    ? path.resolve(configuredMemoryDir)
    : await mkdtemp(path.join(tmpdir(), `remnic-bench-${mode}-`));
  const ownsTempDir = !configuredMemoryDir;
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
    const drainTimeoutMs = normalizeDrainTimeoutMs(options.drainTimeoutMs);
    let state = await createBenchOrchestrator(
      mode,
      options.configOverrides,
      options.preserveRuntimeDefaults === true,
      options.memoryDir,
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
        options.memoryDir,
      );
      sessionTurnCounters.clear();
    };

    return {
      async store(sessionId: string, messages: Message[]): Promise<void> {
        await getEngine().observeMessages(
          sessionId,
          messages.map((message) => ({
            role: message.role,
            content: message.content,
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
        const conversationalMessages = messages.filter(
          (message): message is Message & { role: "user" | "assistant" } =>
            message.role === "user" || message.role === "assistant",
        );
        const replayTurns = conversationalMessages.map((message, index) => ({
          source: "openclaw" as const,
          role: message.role,
          content: message.content,
          timestamp: new Date(batchStartMs + index).toISOString(),
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

      async recall(sessionId: string, query: string, budgetChars?: number): Promise<string> {
        const engine = getEngine();
        const budget = budgetChars ?? DEFAULT_BENCH_RECALL_BUDGET_CHARS;
        if (budget <= 0) {
          return "";
        }

        const sections: string[] = [];
        let usedChars = 0;
        const explicitReferences = collectExplicitTurnReferences(query);
        const hasExplicitReferences = explicitReferences.length > 0;
        const preferFocusedExplicitContext =
          hasExplicitReferences && sessionId.startsWith("ama-");
        const focusedReferenceWindows = preferFocusedExplicitContext
          ? buildFocusedReferenceWindows(
            explicitReferences.map((reference) => reference.number),
          )
          : [];

        const exactReferenceEvidence = await buildExplicitCueRecallSection({
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

        const trajectoryAnalysisEvidence = sessionId.startsWith("ama-")
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

        if (useCoreMemoryPipeline) {
          const coreBudget = Math.max(
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
          });
          if (coreRecall.trim().length > 0) {
            const section = `## Remnic recall pipeline\n${coreRecall.trim()}`;
            sections.push(section);
            usedChars += section.length;
          }
        }

        const suppressBroadSummary =
          preferFocusedExplicitContext && !!exactReferenceEvidence;

        if (query) {
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
            const seenTurns = new Set<string>();

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
                  !seenTurns.has(id) &&
                  shouldIncludeFocusedSearchEvidence(
                    result.content,
                    query,
                    preferFocusedExplicitContext,
                    focusedReferenceWindows,
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
                  !shouldIncludeFocusedSearchEvidence(
                    message.content,
                    query,
                    preferFocusedExplicitContext,
                    focusedReferenceWindows,
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

            const searchEvidence = buildEvidencePack(evidenceItems, {
              title: "Search evidence",
              maxChars: searchBudget,
              maxItemChars: 900,
            });
            if (searchEvidence) {
              sections.push(searchEvidence);
              usedChars += searchEvidence.length;
            }
          }
        }

        if (!suppressBroadSummary) {
          const summaryBudget = Math.max(0, budget - usedChars - 4);
          const recallText = await engine.assembleRecall(sessionId, summaryBudget);
          if (recallText) {
            sections.push(recallText);
          }
        }

        if (sections.length === 0) {
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
