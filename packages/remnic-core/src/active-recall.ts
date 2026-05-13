import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { collapseWhitespace, truncateCodePointSafe } from "./whitespace.js";
import type {
  ActiveRecallChatType,
  ActiveRecallModelFallbackPolicy,
  ActiveRecallPromptStyle,
  ActiveRecallQueryMode,
  ActiveRecallThinking,
} from "./types.js";

export interface ActiveRecallTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ActiveRecallInput {
  sessionKey: string;
  agentId: string;
  chatType: ActiveRecallChatType;
  recentTurns: ActiveRecallTurn[];
  currentMessage: string;
}

export interface ActiveRecallConfig {
  enabled: boolean;
  agents: string[] | null;
  allowedChatTypes: ActiveRecallChatType[];
  queryMode: ActiveRecallQueryMode;
  promptStyle: ActiveRecallPromptStyle;
  customInstruction: string | null;
  promptAppend: string | null;
  maxSummaryChars: number;
  recentUserTurns: number;
  recentAssistantTurns: number;
  recentUserChars: number;
  recentAssistantChars: number;
  thinking: ActiveRecallThinking;
  timeoutMs: number;
  cacheTtlMs: number;
  persistTranscripts: boolean;
  transcriptDir: string;
  entityGraphDepth: number;
  includeCausalTrajectories: boolean;
  includeDaySummary: boolean;
  attachRecallExplain: boolean;
  modelOverride: string | null;
  modelFallbackPolicy: ActiveRecallModelFallbackPolicy;
}

export interface ActiveRecallResult {
  summary: string | null;
  citations: Array<{ memoryId: string; relevance: number }>;
  latencyMs: number;
  cacheHit: boolean;
  modelUsed: string;
  transcriptPath: string | null;
}

export interface ActiveRecallDependencies {
  recall(query: string, sessionKey: string): Promise<string | null>;
  getLastRecallSnapshot?(sessionKey: string): { memoryIds?: string[] } | null;
  walkEntityGraph?(params: {
    sessionKey: string;
    query: string;
    depth: number;
  }): Promise<string[]>;
  loadCausalTrajectories?(params: {
    sessionKey: string;
    query: string;
  }): Promise<string[]>;
  loadDaySummary?(sessionKey: string): Promise<string | null>;
  explainLastRecall?(sessionKey: string): Promise<string | null>;
  generateSummary?(params: {
    prompt: string;
    sessionKey: string;
    agentId: string;
    model: string;
    timeoutMs: number;
    thinking: ActiveRecallThinking;
    fallbackPolicy: ActiveRecallModelFallbackPolicy;
  }): Promise<{ text: string | null; modelUsed?: string; cacheHit?: boolean }>;
  now?: () => number;
}

interface CachedRecallResult {
  expiresAt: number;
  value: ActiveRecallResult;
}

interface ActiveRecallTurnWithIndex {
  index: number;
  role: ActiveRecallTurn["role"];
  content: string;
}

const ACTIVE_RECALL_CACHE_MAX_ENTRIES = 256;

const NONE_SET = new Set([
  "",
  "none",
  "no_reply",
  "nothing useful",
  "no relevant memory",
  "timeout",
  "[]",
  "{}",
  "null",
  "n/a",
]);

const STYLE_INSTRUCTIONS: Record<ActiveRecallPromptStyle, string> = {
  balanced: "Summarize the most relevant memory context in a compact, neutral way.",
  strict: "Only include memory that is directly supported by the retrieved context.",
  contextual: "Prefer concise context that helps the next reply stay grounded in recent work.",
  "recall-heavy": "Bias toward richer recall coverage when multiple retrieved items reinforce each other.",
  "precision-heavy": "Bias toward precision. Omit anything uncertain or weakly supported.",
  "preference-only": "Only surface user preference or operating-style memory when present.",
};

function cloneRecallResult(value: ActiveRecallResult): ActiveRecallResult {
  return {
    ...value,
    citations: [...value.citations],
  };
}

function buildCacheKey(input: ActiveRecallInput, config: ActiveRecallConfig, queryBundle: string): string {
  return JSON.stringify({
    sessionKey: input.sessionKey,
    agentId: input.agentId,
    queryMode: config.queryMode,
    promptStyle: config.promptStyle,
    customInstruction: config.customInstruction,
    promptAppend: config.promptAppend,
    maxSummaryChars: config.maxSummaryChars,
    entityGraphDepth: config.entityGraphDepth,
    includeCausalTrajectories: config.includeCausalTrajectories,
    includeDaySummary: config.includeDaySummary,
    attachRecallExplain: config.attachRecallExplain,
    modelOverride: config.modelOverride,
    modelFallbackPolicy: config.modelFallbackPolicy,
    thinking: config.thinking,
    queryBundle,
  });
}

function pruneExpiredCache(
  cache: Map<string, CachedRecallResult>,
  currentTime: number,
): void {
  for (const [key, entry] of cache.entries()) {
    if (entry.expiresAt <= currentTime) {
      cache.delete(key);
    }
  }
}

function enforceCacheLimit(cache: Map<string, CachedRecallResult>): void {
  while (cache.size > ACTIVE_RECALL_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (typeof oldestKey !== "string") {
      break;
    }
    cache.delete(oldestKey);
  }
}

function cropTurns(
  turns: ActiveRecallTurn[],
  role: "user" | "assistant",
  maxTurns: number,
  maxChars: number,
): ActiveRecallTurnWithIndex[] {
  if (maxTurns <= 0) {
    return [];
  }

  const selected: ActiveRecallTurnWithIndex[] = [];
  for (let index = turns.length - 1; index >= 0 && selected.length < maxTurns; index -= 1) {
    const turn = turns[index];
    if (turn?.role === role) {
      selected.push({
        index,
        role: turn.role,
        content: collapseWhitespace(truncateCodePointSafe(turn.content, maxChars)),
      });
    }
  }

  return selected.reverse();
}

function mergeChronologicalTurns(
  userTurns: ActiveRecallTurnWithIndex[],
  assistantTurns: ActiveRecallTurnWithIndex[],
): ActiveRecallTurnWithIndex[] {
  return [...userTurns, ...assistantTurns]
    .sort((left, right) => left.index - right.index)
    .filter((value) => value.content.length > 0);
}

export function buildActiveRecallQueryBundle(
  input: ActiveRecallInput,
  config: ActiveRecallConfig,
): string {
  if (config.queryMode === "message") {
    return collapseWhitespace(input.currentMessage);
  }

  const userTurns = cropTurns(
    input.recentTurns,
    "user",
    config.recentUserTurns,
    config.recentUserChars,
  );
  const assistantTurns = cropTurns(
    input.recentTurns,
    "assistant",
    config.recentAssistantTurns,
    config.recentAssistantChars,
  );
  const mergedTurns = mergeChronologicalTurns(userTurns, assistantTurns);

  const parts = [
    ...mergedTurns.map((turn) => `${turn.role}: ${turn.content}`),
  ];

  if (config.queryMode === "full") {
    return [...parts, `current: ${collapseWhitespace(input.currentMessage)}`]
      .filter((value) => value.trim().length > 0)
      .join("\n");
  }

  return [`current: ${collapseWhitespace(input.currentMessage)}`, ...parts]
    .filter((value) => value.trim().length > 0)
    .join("\n");
}

export function normalizeActiveRecallSummary(value: string | null, maxChars: number): string | null {
  if (value == null) return null;
  const compact = collapseWhitespace(value);
  if (NONE_SET.has(compact.toLowerCase())) return null;
  return truncateCodePointSafe(compact, maxChars);
}

function sanitizeTranscriptPathSegment(value: string): string {
  const normalized = collapseWhitespace(value);
  return encodeURIComponent(normalized.length > 0 ? normalized : "unknown").replaceAll(
    ".",
    "%2E",
  );
}

export function buildActiveRecallPrompt(params: {
  config: ActiveRecallConfig;
  queryBundle: string;
  recallContext: string | null;
  graphContext: string[];
  causalContext: string[];
  daySummary: string | null;
  recallExplain: string | null;
}): string {
  const sections = [
    params.config.customInstruction?.trim() || STYLE_INSTRUCTIONS[params.config.promptStyle],
    `Query bundle:\n${params.queryBundle}`,
    params.recallContext ? `Retrieved memory:\n${params.recallContext}` : null,
    params.graphContext.length > 0 ? `Entity graph:\n${params.graphContext.join("\n")}` : null,
    params.causalContext.length > 0 ? `Causal trajectories:\n${params.causalContext.join("\n")}` : null,
    params.daySummary ? `Day summary:\n${params.daySummary}` : null,
    params.recallExplain ? `Recall explain:\n${params.recallExplain}` : null,
    params.config.promptAppend?.trim() || null,
    "Return either NONE or a compact summary grounded only in the supplied context.",
  ];
  return sections.filter((value): value is string => !!value && value.trim().length > 0).join("\n\n");
}

async function appendActiveRecallTranscript(
  transcriptRoot: string,
  input: ActiveRecallInput,
  config: ActiveRecallConfig,
  result: ActiveRecallResult,
  queryBundle: string,
): Promise<string> {
  const date = new Date().toISOString().slice(0, 10);
  const filePath = path.join(
    transcriptRoot,
    "agents",
    sanitizeTranscriptPathSegment(input.agentId),
    date,
    `${sanitizeTranscriptPathSegment(input.sessionKey)}.jsonl`,
  );
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(
    filePath,
    `${JSON.stringify({
      ts: new Date().toISOString(),
      sessionKey: input.sessionKey,
      agentId: input.agentId,
      queryMode: config.queryMode,
      promptStyle: config.promptStyle,
      queryBundle,
      summary: result.summary,
      citations: result.citations,
      latencyMs: result.latencyMs,
      cacheHit: result.cacheHit,
      modelUsed: result.modelUsed,
    })}\n`,
    "utf8",
  );
  return filePath;
}

export function createActiveRecallEngine(
  deps: ActiveRecallDependencies,
  config: ActiveRecallConfig,
) {
  const cache = new Map<string, CachedRecallResult>();
  const now = deps.now ?? (() => Date.now());

  return {
    async run(input: ActiveRecallInput): Promise<ActiveRecallResult> {
      if (!config.enabled) {
        return {
          summary: null,
          citations: [],
          latencyMs: 0,
          cacheHit: false,
          modelUsed: config.modelOverride ?? "disabled",
          transcriptPath: null,
        };
      }
      if (config.agents && !config.agents.includes(input.agentId)) {
        return {
          summary: null,
          citations: [],
          latencyMs: 0,
          cacheHit: false,
          modelUsed: config.modelOverride ?? "filtered",
          transcriptPath: null,
        };
      }
      if (!config.allowedChatTypes.includes(input.chatType)) {
        return {
          summary: null,
          citations: [],
          latencyMs: 0,
          cacheHit: false,
          modelUsed: config.modelOverride ?? "filtered",
          transcriptPath: null,
        };
      }

      const queryBundle = buildActiveRecallQueryBundle(input, config);
      const cacheKey = buildCacheKey(input, config, queryBundle);
      const currentTime = now();
      const cacheEnabled = config.cacheTtlMs > 0;
      if (cacheEnabled) {
        pruneExpiredCache(cache, currentTime);
      }
      const cached = cache.get(cacheKey);
      if (cacheEnabled && cached) {
        return {
          ...cloneRecallResult(cached.value),
          latencyMs: Math.max(0, now() - currentTime),
          cacheHit: true,
        };
      }

      const start = currentTime;
      const recallContext = await deps.recall(queryBundle, input.sessionKey);
      const graphContext =
        config.entityGraphDepth > 0 && deps.walkEntityGraph
          ? await deps.walkEntityGraph({
              sessionKey: input.sessionKey,
              query: queryBundle,
              depth: config.entityGraphDepth,
            })
          : [];
      const causalContext =
        config.includeCausalTrajectories && deps.loadCausalTrajectories
          ? await deps.loadCausalTrajectories({
              sessionKey: input.sessionKey,
              query: queryBundle,
            })
          : [];
      const daySummary =
        config.includeDaySummary && deps.loadDaySummary
          ? await deps.loadDaySummary(input.sessionKey)
          : null;
      const recallExplain =
        config.attachRecallExplain && deps.explainLastRecall
          ? await deps.explainLastRecall(input.sessionKey)
          : null;
      const prompt = buildActiveRecallPrompt({
        config,
        queryBundle,
        recallContext,
        graphContext,
        causalContext,
        daySummary,
        recallExplain,
      });

      const generated = deps.generateSummary
        ? await deps.generateSummary({
            prompt,
            sessionKey: input.sessionKey,
            agentId: input.agentId,
            model: config.modelOverride ?? "gpt-5.2",
            timeoutMs: config.timeoutMs,
            thinking: config.thinking,
            fallbackPolicy: config.modelFallbackPolicy,
          })
        : {
            text: recallContext,
            modelUsed: config.modelOverride ?? "gpt-5.2",
            cacheHit: false,
          };
      const summary = normalizeActiveRecallSummary(
        generated.text,
        config.maxSummaryChars,
      );
      const snapshot = deps.getLastRecallSnapshot?.(input.sessionKey);
      const citations = (snapshot?.memoryIds ?? []).map((memoryId, index) => ({
        memoryId,
        relevance: Number((1 / (index + 1)).toFixed(3)),
      }));
      const result: ActiveRecallResult = {
        summary,
        citations,
        latencyMs: Math.max(0, now() - start),
        cacheHit: generated.cacheHit === true,
        modelUsed: generated.modelUsed ?? config.modelOverride ?? "gpt-5.2",
        transcriptPath: null,
      };
      if (config.persistTranscripts) {
        result.transcriptPath = await appendActiveRecallTranscript(
          config.transcriptDir,
          input,
          config,
          result,
          queryBundle,
        );
      }

      if (cacheEnabled) {
        const completedAt = now();
        cache.set(cacheKey, {
          expiresAt: completedAt + config.cacheTtlMs,
          value: cloneRecallResult(result),
        });
        enforceCacheLimit(cache);
      }
      return result;
    },
  };
}
