/**
 * Package-owned Remnic adapters used by the phase-1 benchmark CLI surface.
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildEvidencePack,
  buildExplicitCueRecallSection,
  collectExplicitTurnReferences,
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
  preserveRuntimeDefaults?: boolean;
  responder?: BenchResponder;
  judge?: BenchJudge;
}

type BenchAdapterMode = "lightweight" | "direct";

interface BenchAdapterBaseConfig {
  memoryDir: string;
  workspaceDir: string;
  lcmEnabled: true;
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

const BENCH_TEARDOWN_DEFERRED_READY_WAIT_MS = 500;
const CORE_EXPLICIT_CUE_MAX_CHARS = 18_000;
const CORE_EXPLICIT_CUE_MAX_ITEM_CHARS = 2_400;
const CORE_EXPLICIT_CUE_MAX_REFERENCES = 24;

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
): Promise<{ tempDir: string; orchestrator: Orchestrator }> {
  const tempDir = await mkdtemp(path.join(tmpdir(), `remnic-bench-${mode}-`));
  await mkdir(path.join(tempDir, "state"), { recursive: true });

  const commonConfig: BenchAdapterBaseConfig = {
    memoryDir: tempDir,
    workspaceDir: tempDir,
    lcmEnabled: true,
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

  return { tempDir, orchestrator };
}

function createAdapterFactory(mode: "lightweight" | "direct") {
  return async function createAdapter(
    options: RemnicAdapterOptions = {},
  ): Promise<BenchMemoryAdapter> {
    const useCoreMemoryPipeline = shouldUseCoreMemoryPipeline(mode, options);
    let state = await createBenchOrchestrator(
      mode,
      options.configOverrides,
      options.preserveRuntimeDefaults === true,
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
      await rm(state.tempDir, { recursive: true, force: true });
    };

    const rebuild = async (): Promise<void> => {
      await cleanup();
      state = await createBenchOrchestrator(
        mode,
        options.configOverrides,
        options.preserveRuntimeDefaults === true,
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

        if (!useCoreMemoryPipeline || messages.length === 0) {
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

        await state.orchestrator.ingestReplayBatch(replayTurns);
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
            const expanded = await engine.expandContext(
              sessionId,
              0,
              stats.totalMessages - 1,
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
        const DRAIN_TIMEOUT_MS = 5 * 60_000;
        const engine = getEngine();
        const abortController = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>((_, reject) => {
          timer = setTimeout(() => {
            abortController.abort();
            reject(new Error("drain() timed out after 5 minutes"));
          }, DRAIN_TIMEOUT_MS);
        });
        try {
          await Promise.race([
            (async () => {
              const [, extractionIdle, consolidationIdle] = await Promise.all([
                engine.waitForObserveQueueIdle(),
                state.orchestrator.waitForExtractionIdle(DRAIN_TIMEOUT_MS),
                state.orchestrator.waitForConsolidationIdle(DRAIN_TIMEOUT_MS),
              ]);
              if (!extractionIdle) {
                throw new Error("drain() timed out waiting for extraction idle");
              }
              if (!consolidationIdle) {
                throw new Error("drain() timed out waiting for consolidation idle");
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
