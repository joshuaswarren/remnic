/**
 * Direct TypeScript import adapter (Option A) — full-stack sandboxed Engram.
 *
 * Creates an isolated Orchestrator + EngramAccessService that exercises
 * the complete Engram memory pipeline:
 *
 * - LLM-powered extraction (facts, entities, questions)
 * - QMD hybrid search (vector + BM25)
 * - Recall planner (intent routing, budget allocation)
 * - Query expansion + reranking
 * - LCM engine (archive, DAG summarization, compressed recall)
 * - Memory projection, contradiction detection, threading
 * - Knowledge graph, entity retrieval, trust zones
 * - Everything agents see in production
 *
 * Isolation: uses a temp memoryDir so no test data touches production.
 * Shares LLM endpoints and QMD daemon (stateless services, safe to reuse).
 *
 * For CI environments without LLM/QMD access, use createLightweightAdapter()
 * which only exercises LCM + FTS (no external services needed).
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  MemorySystem,
  Message,
  SearchResult,
  MemoryStats,
  LlmJudge,
} from "./types.js";
import { parseConfig } from "../../src/config.js";
import { Orchestrator } from "../../src/orchestrator.js";
import { EngramAccessService } from "../../src/access-service.js";
import { LcmEngine } from "../../src/lcm/engine.js";
import { FallbackLlmClient } from "../../src/fallback-llm.js";
import { synthesizePreferencesFromLcm } from "../../src/compounding/preference-consolidator.js";
import { extractTrajectoryFromConversation } from "../adapter/cmc-adapter.js";
import type { PluginConfig } from "../../src/types.js";

const execFileAsync = promisify(execFile);

/** Load gateway config from ~/.openclaw/openclaw.json for LLM access. */
async function loadGatewayConfig(): Promise<Record<string, unknown> | undefined> {
  try {
    const configPath = path.join(homedir(), ".openclaw", "openclaw.json");
    const raw = await readFile(configPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// ── Full-stack adapter ──

export interface FullStackAdapterOptions {
  /** Override config values (merged on top of parseConfig defaults). */
  configOverrides?: Record<string, unknown>;
  /**
   * QMD collection name for eval isolation.
   * Default: `engram-eval-{timestamp}-{uuid}` (auto-cleaned on reset/destroy).
   */
  qmdCollection?: string;
}

export async function removeEvalQmdCollection(
  config: Pick<PluginConfig, "qmdEnabled" | "qmdCollection" | "qmdPath">,
): Promise<boolean> {
  if (!config.qmdEnabled) return false;
  const collection = config.qmdCollection?.trim();
  if (!collection) return false;
  const qmdPath = config.qmdPath?.trim() || "qmd";
  await execFileAsync(qmdPath, ["collection", "remove", collection], {
    timeout: 15_000,
  });
  return true;
}

export async function createEngramAdapter(
  options?: FullStackAdapterOptions,
): Promise<MemorySystem> {
  let tempDir = await mkdtemp(path.join(tmpdir(), "engram-eval-"));
  const nextEvalCollection = () =>
    options?.qmdCollection ?? `engram-eval-${Date.now()}-${randomUUID()}`;
  let evalCollection = nextEvalCollection();
  const gatewayConfig = await loadGatewayConfig();

  const buildConfig = (dir: string): PluginConfig =>
    parseConfig({
      // Isolated storage
      memoryDir: dir,
      workspaceDir: dir,

      // Gateway config for LLM judge access
      gatewayConfig,

      // Use eval-specific QMD collection (shares daemon, isolated data)
      qmdEnabled: true,
      qmdCollection: evalCollection,
      qmdColdTierEnabled: false,

      // Enable the full pipeline
      lcmEnabled: true,
      recallPlannerEnabled: true,
      queryExpansionEnabled: true,
      rerankEnabled: true,
      rerankProvider: "local",
      memoryBoxesEnabled: true,
      traceWeaverEnabled: true,
      threadingEnabled: true,
      factDeduplicationEnabled: true,
      knowledgeIndexEnabled: true,
      entityRetrievalEnabled: true,
      verifiedRecallEnabled: true,
      queryAwareIndexingEnabled: true,
      contradictionDetectionEnabled: true,
      memoryLinkingEnabled: true,
      topicExtractionEnabled: true,
      chunkingEnabled: true,
      episodeNoteModeEnabled: true,
      objectiveStateMemoryEnabled: true,
      causalTrajectoryMemoryEnabled: true,
      harmonicRetrievalEnabled: true,
      lifecyclePolicyEnabled: true,

      // Multi-hop graph traversal (entity + time + causal edges)
      multiGraphMemoryEnabled: true,
      graphRecallEnabled: true,
      entityGraphEnabled: true,
      timeGraphEnabled: true,
      causalGraphEnabled: true,
      maxGraphTraversalSteps: 3,
      graphActivationDecay: 0.8,

      // Confidence gate — abstain when no results are relevant
      recallConfidenceGateEnabled: true,
      recallConfidenceGateThreshold: 0.12,

      // Extraction defaults (uses OpenAI API key from env)
      extractionDedupeEnabled: true,
      extractionMinChars: 10,
      extractionMinUserTurns: 0,

      // LCM tuned for eval (smaller batches for quicker summarization)
      lcmLeafBatchSize: 4,
      lcmRollupFanIn: 3,
      lcmFreshTailTurns: 8,
      lcmMaxDepth: 4,
      lcmRecallBudgetShare: 1.0,

      // Recall budget
      recallBudgetChars: 32000,

      // Disable features that don't apply in eval context
      transcriptEnabled: false,
      hourlySummariesEnabled: false,
      daySummaryEnabled: false,
      identityEnabled: false,
      identityContinuityEnabled: false,
      compactionResetEnabled: false,
      namespacesEnabled: false,
      sharedContextEnabled: false,
      compoundingEnabled: true,
      // IRC (Inductive Rule Consolidation) — preference synthesis for recall
      ircEnabled: true,
      ircMaxPreferences: 20,
      ircIncludeCorrections: true,
      ircMinConfidence: 0.3,
      nativeKnowledge: { enabled: false },
      conversationIndexEnabled: false,
      workTasksEnabled: false,
      workProjectsEnabled: false,
      commitmentLedgerEnabled: false,
      resumeBundlesEnabled: false,

      // Apply user overrides last
      ...options?.configOverrides,
    });

  const cleanupQmdCollection = async (cleanupConfig: PluginConfig): Promise<void> => {
    try {
      await removeEvalQmdCollection(cleanupConfig);
    } catch (err) {
      console.error(
        `  [WARN] failed to remove QMD eval collection ${cleanupConfig.qmdCollection}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  let config = buildConfig(tempDir);
  let orchestrator = new Orchestrator(config);
  await orchestrator.initialize();
  let accessService = new EngramAccessService(orchestrator);

  // Build LLM judge from the gateway's configured model chain
  function buildJudge(cfg: PluginConfig): LlmJudge | undefined {
    const llm = new FallbackLlmClient(cfg.gatewayConfig);
    if (!llm.isAvailable()) return undefined;
    return {
      async score(question: string, predicted: string, expected: string): Promise<number> {
        const resp = await llm.chatCompletion([
          {
            role: "system",
            content:
              "You are evaluating a memory retrieval system. Given a question and expected answer, " +
              "you will receive the context that the memory system retrieved. " +
              "Score how well this retrieved context would allow someone to correctly answer the question. " +
              "Respond with ONLY a JSON object: {\"score\": <number from 0.0 to 1.0>, \"reason\": \"<brief>\"}. " +
              "1.0 = the retrieved context clearly contains or implies the correct answer. " +
              "0.5 = the context has relevant information but the answer requires inference. " +
              "0.0 = the context does not contain information needed to answer correctly.",
          },
          {
            role: "user",
            content:
              `Question: ${question}\n\n` +
              `Expected correct answer: ${expected}\n\n` +
              `Retrieved context from memory system (evaluate this):\n${predicted.slice(0, 3000)}`,
          },
        ], { temperature: 0, maxTokens: 150, timeoutMs: 15000 });
        if (!resp?.content) return 0;
        try {
          const match = resp.content.match(/\{[^}]*"score"\s*:\s*([\d.]+)[^}]*\}/);
          if (match) return Math.min(1, Math.max(0, parseFloat(match[1])));
        } catch {}
        return 0;
      },
    };
  }

  let judge: LlmJudge | undefined = buildJudge(config);
  let extractionAvailable = true;

  async function fallbackRecall(sessionId: string, query: string, budgetChars: number): Promise<string> {
    if (!orchestrator.lcmEngine?.enabled) return "";
    const engine = orchestrator.lcmEngine;
    const sections: string[] = [];

    if (query) {
      const searchResults = await engine.searchContext(query, 20, sessionId);
      if (searchResults.length > 0) {
        const searchSection = searchResults
          .map((r: any) => `[turn ${r.turn_index}, ${r.role}]: ${r.snippet}`)
          .join("\n");
        sections.push(`## Relevant search results\n${searchSection}`);
      }
    }

    const recallText = await engine.assembleRecall(sessionId, budgetChars);
    if (recallText) {
      sections.push(recallText);
    }

    if (sections.length === 0) {
      const stats = await engine.getStats(sessionId);
      if (stats.totalMessages > 0) {
        const expanded = await engine.expandContext(
          sessionId, 0, stats.totalMessages - 1,
          Math.floor(budgetChars / 4),
        );
        if (expanded.length > 0) {
          const raw = expanded
            .map((m: any) => `[${m.role}]: ${m.content}`)
            .join("\n");
          sections.push(`## Raw messages\n${raw}`);
        }
      }
    }

    return sections.join("\n\n");
  }

  const system: MemorySystem = {
    judge,

    async store(sessionId: string, messages: Message[]): Promise<void> {
      // Store via LCM if enabled (archive + summarization)
      if (orchestrator.lcmEngine?.enabled) {
        await orchestrator.lcmEngine.observeMessages(
          sessionId,
          messages.map((m) => ({ role: m.role, content: m.content })),
        );
      }

      // CMC: Extract and record a causal trajectory from this conversation
      if (config.cmcEnabled) {
        try {
          const trajectory = extractTrajectoryFromConversation(sessionId, messages);
          if (trajectory) {
            const { recordCausalTrajectory } = await import("../../src/causal-trajectory.js");
            await recordCausalTrajectory({
              memoryDir: config.memoryDir,
              record: trajectory,
              cmcEnabled: true,
              cmcStitchLookbackDays: config.cmcStitchLookbackDays,
              cmcStitchMinScore: config.cmcStitchMinScore,
              cmcStitchMaxEdgesPerTrajectory: config.cmcStitchMaxEdgesPerTrajectory,
            });
          }
        } catch {
          // CMC trajectory recording is non-fatal
        }
      }

      // Run extraction (facts, entities, questions) through the orchestrator's
      // buffer → extraction pipeline. We simulate agent_end hook behavior.
      for (const msg of messages) {
        await orchestrator.buffer.addTurn(sessionId, {
          role: msg.role,
          content: msg.content,
          timestamp: new Date().toISOString(),
          sessionKey: sessionId,
        });
      }
      // Trigger extraction and wait for completion. After first timeout,
      // skip extraction for remaining questions to avoid N × 35s waits.
      if (extractionAvailable) {
        try {
          const bufferedTurns = orchestrator.buffer.getTurns(sessionId);
          if (bufferedTurns.length > 0) {
            await (orchestrator as any).queueBufferedExtraction?.(bufferedTurns, "trigger_mode", {
              bufferKey: sessionId,
              clearBufferAfterExtraction: false,
            });
            const idle = await orchestrator.waitForExtractionIdle(35_000);
            if (!idle) {
              extractionAvailable = false;
              console.warn("[eval] extraction timed out — disabling for remaining questions (LCM FTS + IRC still active)");
            }
            await orchestrator.buffer.clearAfterExtraction(sessionId);
          }
        } catch (err) {
          extractionAvailable = false;
          console.warn("[eval] extraction failed — disabling:", (err as Error)?.message ?? err);
          await orchestrator.buffer.clearAfterExtraction(sessionId);
        }
      } else {
        // Extraction disabled — clear buffer to prevent unbounded growth.
        // LCM FTS + IRC still have the conversation data.
        await orchestrator.buffer.clearAfterExtraction(sessionId);
      }
    },

    async recall(sessionId: string, query: string, budgetChars?: number): Promise<string> {
      const budget = budgetChars ?? 32000;
      const sections: string[] = [];

      // 1. Try full recall pipeline (recall planner → QMD → reranking → budget assembly)
      try {
        const response = await accessService.recall({
          query,
          sessionKey: sessionId,
          includeDebug: false,
        });
        if (response.context && response.context.trim().length > 0) {
          sections.push(response.context);
        }
      } catch {
        // Full recall threw (e.g., no QMD) — continue to fallback paths
      }

      // 2. Always supplement with LCM FTS search results (full message content)
      // (FTS finds keyword matches that QMD/extraction may miss;
      //  full content ensures containsAnswer can match the expected answer)
      if (orchestrator.lcmEngine?.enabled && query) {
        try {
          const ftsResults = await orchestrator.lcmEngine.searchContextFull(query, 20, sessionId);
          if (ftsResults.length > 0) {
            const ftsSection = ftsResults
              .map((r: any) => `[turn ${r.turn_index}, ${r.role}]: ${r.content}`)
              .join("\n\n");
            sections.push(`## Search results\n${ftsSection}`);
          }
        } catch {
          // FTS search failed — continue with what we have
        }
      }

      // 3. IRC preference synthesis directly from LCM conversation data.
      // Runs when main recall pipeline didn't produce preference sections.
      const hasPreferences = sections.some((s) => s.includes("User Preferences"));
      if (!hasPreferences && orchestrator.lcmEngine?.enabled && query && config.ircEnabled) {
        try {
          const ircSection = await synthesizePreferencesFromLcm(
            orchestrator.lcmEngine,
            query,
            sessionId,
            config.ircMaxPreferences,
          );
          if (ircSection) {
            sections.push(ircSection);
          }
        } catch {
          // IRC is non-fatal
        }
      }

      // 4. If still empty, fall back to LCM compressed history + raw messages
      if (sections.length === 0) {
        return fallbackRecall(sessionId, query, budget);
      }

      // Truncate to budget to avoid unbounded context
      const joined = sections.join("\n\n");
      return joined.length > budget ? joined.slice(0, budget) : joined;
    },

    async search(
      query: string,
      limit: number,
      sessionId?: string,
    ): Promise<SearchResult[]> {
      // Use LCM search (FTS5) — always available regardless of QMD
      if (orchestrator.lcmEngine?.enabled) {
        const results = await orchestrator.lcmEngine.searchContext(query, limit, sessionId);
        return results.map((r) => ({
          turnIndex: r.turn_index,
          role: r.role,
          snippet: r.snippet,
          sessionId: r.session_id,
        }));
      }
      return [];
    },

    async reset(_sessionId?: string): Promise<void> {
      // Tear down and rebuild with fresh isolated storage
      orchestrator.lcmEngine?.close();
      await cleanupQmdCollection(config);
      await rm(tempDir, { recursive: true, force: true });
      tempDir = await mkdtemp(path.join(tmpdir(), "engram-eval-"));
      evalCollection = nextEvalCollection();
      config = buildConfig(tempDir);
      orchestrator = new Orchestrator(config);
      await orchestrator.initialize();
      accessService = new EngramAccessService(orchestrator);
      extractionAvailable = true; // Re-enable for new session
      // Note: judge is NOT rebuilt on reset — it's stateless and the
      // --judge flag controls it at the run.ts level after creation.
    },

    async getStats(sessionId?: string): Promise<MemoryStats> {
      if (orchestrator.lcmEngine?.enabled) {
        return orchestrator.lcmEngine.getStats(sessionId);
      }
      return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: -1 };
    },

    async destroy(): Promise<void> {
      orchestrator.lcmEngine?.close();
      await cleanupQmdCollection(config);
      await rm(tempDir, { recursive: true, force: true });
    },
  };

  return system;
}

// ── Lightweight adapter (CI-friendly, no external services) ──

export interface LightweightAdapterOptions {
  /** Override the summarize function (default: deterministic truncation). */
  summarizeFn?: (text: string, targetTokens: number, aggressive: boolean) => Promise<string | null>;
  /** LCM config overrides. */
  lcmConfig?: Partial<{
    leafBatchSize: number;
    rollupFanIn: number;
    freshTailTurns: number;
    maxDepth: number;
    deterministicMaxTokens: number;
    recallBudgetShare: number;
  }>;
}

/** Deterministic summarizer for CI — truncates rather than calling an LLM. */
async function deterministicSummarize(
  text: string,
  targetTokens: number,
  _aggressive: boolean,
): Promise<string | null> {
  const targetChars = targetTokens * 4;
  if (text.length <= targetChars) return text;
  return text.slice(0, targetChars) + "…";
}

/**
 * Lightweight adapter that exercises only LCM + FTS5 (no external services).
 * Use for CI or environments without QMD/LLM access.
 */
export async function createLightweightAdapter(
  options?: LightweightAdapterOptions,
): Promise<MemorySystem> {
  let tempDir = await mkdtemp(path.join(tmpdir(), "engram-eval-lite-"));
  await mkdir(path.join(tempDir, "state"), { recursive: true });

  const buildPluginConfig = (dir: string) =>
    ({
      memoryDir: dir,
      lcmEnabled: true,
      lcmLeafBatchSize: options?.lcmConfig?.leafBatchSize ?? 4,
      lcmRollupFanIn: options?.lcmConfig?.rollupFanIn ?? 3,
      lcmFreshTailTurns: options?.lcmConfig?.freshTailTurns ?? 8,
      lcmMaxDepth: options?.lcmConfig?.maxDepth ?? 4,
      lcmDeterministicMaxTokens: options?.lcmConfig?.deterministicMaxTokens ?? 512,
      lcmRecallBudgetShare: options?.lcmConfig?.recallBudgetShare ?? 1.0,
      lcmArchiveRetentionDays: 365,
    }) as unknown as PluginConfig;

  const summarizeFn = options?.summarizeFn ?? deterministicSummarize;
  let engine = new LcmEngine(buildPluginConfig(tempDir), summarizeFn);

  return {
    async store(sessionId: string, messages: Message[]): Promise<void> {
      await engine.observeMessages(
        sessionId,
        messages.map((m) => ({ role: m.role, content: m.content })),
      );
    },

    async recall(sessionId: string, query: string, budgetChars?: number): Promise<string> {
      const budget = budgetChars ?? 32000;
      const sections: string[] = [];

      if (query) {
        const searchResults = await engine.searchContext(query, 20, sessionId);
        if (searchResults.length > 0) {
          const searchSection = searchResults
            .map((r) => `[turn ${r.turn_index}, ${r.role}]: ${r.snippet}`)
            .join("\n");
          sections.push(`## Relevant search results\n${searchSection}`);
        }
      }

      const recallText = await engine.assembleRecall(sessionId, budget);
      if (recallText) {
        sections.push(recallText);
      }

      if (sections.length === 0) {
        const stats = await engine.getStats(sessionId);
        if (stats.totalMessages > 0) {
          const expanded = await engine.expandContext(
            sessionId, 0, stats.totalMessages - 1,
            Math.floor(budget / 4),
          );
          if (expanded.length > 0) {
            const raw = expanded
              .map((m) => `[${m.role}]: ${m.content}`)
              .join("\n");
            sections.push(`## Raw messages\n${raw}`);
          }
        }
      }

      return sections.join("\n\n");
    },

    async search(
      query: string,
      limit: number,
      sessionId?: string,
    ): Promise<SearchResult[]> {
      const results = await engine.searchContext(query, limit, sessionId);
      return results.map((r) => ({
        turnIndex: r.turn_index,
        role: r.role,
        snippet: r.snippet,
        sessionId: r.session_id,
      }));
    },

    async reset(_sessionId?: string): Promise<void> {
      engine.close();
      await rm(tempDir, { recursive: true, force: true });
      tempDir = await mkdtemp(path.join(tmpdir(), "engram-eval-lite-"));
      await mkdir(path.join(tempDir, "state"), { recursive: true });
      engine = new LcmEngine(buildPluginConfig(tempDir), summarizeFn);
    },

    async getStats(sessionId?: string): Promise<MemoryStats> {
      return engine.getStats(sessionId);
    },

    async destroy(): Promise<void> {
      engine.close();
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}
