import type Database from "better-sqlite3";
import { openLcmDatabase, ensureLcmStateDir } from "./schema.js";
import { LcmArchive, type LcmStructuredRecallMatch } from "./archive.js";
import { LcmDag } from "./dag.js";
import { LcmSummarizer, type SummarizeFn } from "./summarizer.js";
import {
  assembleCompressedHistoryWithTrace,
  type LcmRecallConfig,
  type LcmRecallWithTraceResult,
} from "./recall.js";
import { LcmWorkQueue, type LcmObserveMessage } from "./queue.js";
import type { PluginConfig } from "../types.js";
import { estimateTokenCount } from "../token-estimate.js";
import { log } from "../logger.js";
export interface LcmEngineConfig {
  enabled: boolean;
  leafBatchSize: number;
  rollupFanIn: number;
  freshTailTurns: number;
  maxDepth: number;
  deterministicMaxTokens: number;
  archiveRetentionDays: number;
  recallBudgetShare: number;
  observeConcurrency: number;
  telemetryPrefilterEnabled: boolean;
  messagePartsEnabled: boolean;
  messagePartsRecallMaxResults: number;
}

/** An expanded archive row with stable lineage identity; content may be budget-truncated. */
export interface LcmExpandedMessage {
  id: number;
  session_id: string;
  turn_index: number;
  role: string;
  content: string;
}

function positiveInteger(value: unknown, fallback: number, min = 1): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.floor(value));
}

export function extractLcmConfig(cfg: PluginConfig): LcmEngineConfig {
  return {
    enabled: (cfg as any).lcmEnabled === true,
    leafBatchSize: positiveInteger((cfg as any).lcmLeafBatchSize, 8),
    rollupFanIn: positiveInteger((cfg as any).lcmRollupFanIn, 4, 2),
    freshTailTurns: positiveInteger((cfg as any).lcmFreshTailTurns, 16),
    maxDepth: positiveInteger((cfg as any).lcmMaxDepth, 5),
    deterministicMaxTokens: positiveInteger((cfg as any).lcmDeterministicMaxTokens, 512),
    archiveRetentionDays: positiveInteger((cfg as any).lcmArchiveRetentionDays, 90, 0),
    recallBudgetShare: (cfg as any).lcmRecallBudgetShare ?? 0.15,
    observeConcurrency:
      typeof (cfg as any).lcmObserveConcurrency === "number" &&
        Number.isFinite((cfg as any).lcmObserveConcurrency)
        ? Math.max(1, Math.floor((cfg as any).lcmObserveConcurrency))
        : 1,
    telemetryPrefilterEnabled: (cfg as any).lcmTelemetryPrefilterEnabled !== false,
    messagePartsEnabled: (cfg as any).messagePartsEnabled === true,
    messagePartsRecallMaxResults:
      typeof (cfg as any).messagePartsRecallMaxResults === "number"
        ? Math.max(0, Math.floor((cfg as any).messagePartsRecallMaxResults))
        : 6,
  };
}

function normalizeLcmSessionId(sessionId: string): string {
  return sessionId.trim();
}

function normalizeOptionalLcmSessionId(sessionId?: string): string | undefined {
  if (sessionId === undefined) {
    return undefined;
  }
  const normalized = normalizeLcmSessionId(sessionId);
  return normalized.length > 0 ? normalized : undefined;
}

const EMPTY_LCM_STATS = {
  totalMessages: 0,
  totalSummaryNodes: 0,
  maxDepth: -1,
} as const;

export class LcmEngine {
  private db: Database.Database | null = null;
  private archive: LcmArchive | null = null;
  private dag: LcmDag | null = null;
  private summarizer: LcmSummarizer | null = null;
  private observeQueue: LcmWorkQueue | null = null;
  private closed = false;
  private readonly config: LcmEngineConfig;
  private readonly memoryDir: string;
  private initPromise: Promise<void> | null = null;
  private readonly pendingObserveInitCounts = new Map<string, number>();
  private readonly pendingObserveInitWaiters = new Map<string, Array<() => void>>();
  private readonly pendingObserveInitIdleWaiters: Array<() => void> = [];

  constructor(
    pluginConfig: PluginConfig,
    private readonly summarizeFn: SummarizeFn,
  ) {
    this.config = extractLcmConfig(pluginConfig);
    this.memoryDir = pluginConfig.memoryDir;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** Lazy init — open database on first use. */
  async ensureInitialized(): Promise<void> {
    if (this.closed) return;
    if (this.db) return;
    if (this.initPromise) {
      await this.initPromise;
      return;
    }
    this.initPromise = this.doInit().catch((err) => {
      // Reset so next call retries instead of caching the failure
      this.initPromise = null;
      throw err;
    });
    await this.initPromise;
  }

  private async doInit(): Promise<void> {
    await ensureLcmStateDir(this.memoryDir);
    const db = openLcmDatabase(this.memoryDir);
    const archive = new LcmArchive(db);
    const dag = new LcmDag(db);
    const { telemetryPrefilterEnabled } = this.config;
    const summarizer = new LcmSummarizer(
      archive,
      dag,
      this.summarizeFn,
      {
        leafBatchSize: this.config.leafBatchSize,
        rollupFanIn: this.config.rollupFanIn,
        maxDepth: this.config.maxDepth,
        deterministicMaxTokens: this.config.deterministicMaxTokens,
        telemetryPrefilterEnabled,
      },
    );
    const observeQueue = new LcmWorkQueue({
      concurrency: this.config.observeConcurrency,
      worker: async (sessionId, messages) => {
        await this.processObserveMessages(sessionId, messages);
      },
      hooks: {
        onJobStart: ({ sessionId, depth, inFlight, waitMs }) => {
          log.debug(
            `LCM observe queue start: session=${sessionId}, depth=${depth}, inFlight=${inFlight}, wait=${waitMs}ms`,
          );
        },
        onJobFinish: ({
          sessionId,
          depth,
          inFlight,
          waitMs,
          runMs,
          totalMs,
          error,
        }) => {
          if (error) {
            log.error(
              `LCM observe queue failure: session=${sessionId}, depth=${depth}, inFlight=${inFlight}, wait=${waitMs}ms, run=${runMs}ms, total=${totalMs}ms, error=${error}`,
            );
            return;
          }

          log.debug(
            `LCM observe queue finish: session=${sessionId}, depth=${depth}, inFlight=${inFlight}, wait=${waitMs}ms, run=${runMs}ms, total=${totalMs}ms`,
          );
        },
      },
    });

    if (this.closed) {
      db.close();
      return;
    }

    this.db = db;
    this.archive = archive;
    this.dag = dag;
    this.summarizer = summarizer;
    this.observeQueue = observeQueue;
    log.info("LCM engine initialized");
  }

  /**
   * Enqueue messages from agent_end hook.
   * The queue worker performs the archive append and incremental summarization.
   */
  async observeMessages(
    sessionId: string,
    messages: LcmObserveMessage[],
  ): Promise<void> {
    const normalizedSessionId = normalizeLcmSessionId(sessionId);
    if (!normalizedSessionId) return;
    this.enqueueObserveMessages(normalizedSessionId, messages);
  }

  /** Enqueue an observe job without waiting for worker completion. */
  enqueueObserveMessages(
    sessionId: string,
    messages: LcmObserveMessage[],
  ): void {
    if (!this.config.enabled || this.closed) return;
    const normalizedSessionId = normalizeLcmSessionId(sessionId);
    if (!normalizedSessionId) return;
    if (messages.length === 0) return;

    this.reservePendingObserveInit(normalizedSessionId);

    void this.ensureInitialized()
      .then(() => {
        if (this.closed || !this.observeQueue) return;
        this.observeQueue.enqueue(normalizedSessionId, messages);
        log.debug(
          `LCM observe enqueued: session=${normalizedSessionId}, depth=${this.observeQueue.depth}, inFlight=${this.observeQueue.inFlightCount}`,
        );
      })
      .catch((err) => {
        if (this.closed) return;
        log.error(`LCM observe enqueue initialization error: ${err}`);
      })
      .finally(() => {
        this.releasePendingObserveInit(normalizedSessionId);
      });
  }

  private async processObserveMessages(
    sessionId: string,
    messages: LcmObserveMessage[],
  ): Promise<void> {
    if (this.closed) return;
    await this.ensureInitialized();
    if (this.closed || !this.archive || !this.summarizer) return;

    if (messages.length === 0) return;

    const currentMax = this.archive.getMaxTurnIndex(sessionId);
    const { messagePartsEnabled } = this.config;
    const newMessages = messages.map((m, i) => ({
      turnIndex: currentMax + 1 + i,
      role: m.role,
      content: m.content,
      parts: messagePartsEnabled ? m.parts : undefined,
      rawContent: messagePartsEnabled ? m.rawContent : undefined,
      sourceFormat: messagePartsEnabled ? m.sourceFormat : undefined,
    }));

    this.archive.appendMessages(sessionId, newMessages, {
      messagePartsEnabled,
    });

    // Trigger incremental summarization inside the worker, after append.
    try {
      await this.summarizer.summarizeIncremental(sessionId);
    } catch (err) {
      log.debug(`LCM incremental summarization error: ${err}`);
    }
  }

  get observeQueueDepth(): number {
    return this.observeQueue?.depth ?? 0;
  }

  get observeQueueInFlightCount(): number {
    return this.observeQueue?.inFlightCount ?? 0;
  }

  async waitForObserveQueueIdle(): Promise<void> {
    if (!this.config.enabled || this.closed) return;
    await this.ensureInitialized();
    if (this.closed) return;
    await this.waitForPendingObserveInitIdle();
    await this.observeQueue?.whenIdle();
  }

  async waitForSessionObserveIdle(sessionId: string): Promise<void> {
    if (!this.config.enabled || this.closed) return;
    const normalizedSessionId = normalizeLcmSessionId(sessionId);
    if (!normalizedSessionId) return;
    await this.ensureInitialized();
    if (this.closed) return;
    await this.waitForPendingObserveInitIdle(normalizedSessionId);
    await this.observeQueue?.whenSessionIdle(normalizedSessionId);
  }

  private reservePendingObserveInit(sessionId: string): void {
    const count = this.pendingObserveInitCounts.get(sessionId) ?? 0;
    this.pendingObserveInitCounts.set(sessionId, count + 1);
  }

  private releasePendingObserveInit(sessionId: string): void {
    const count = this.pendingObserveInitCounts.get(sessionId);
    if (!count) return;

    if (count === 1) {
      this.pendingObserveInitCounts.delete(sessionId);
      const waiters = this.pendingObserveInitWaiters.get(sessionId) ?? [];
      this.pendingObserveInitWaiters.delete(sessionId);
      for (const resolve of waiters) resolve();
      if (this.pendingObserveInitCounts.size === 0) {
        const idleWaiters = this.pendingObserveInitIdleWaiters.splice(
          0,
          this.pendingObserveInitIdleWaiters.length,
        );
        for (const resolve of idleWaiters) resolve();
      }
      return;
    }

    this.pendingObserveInitCounts.set(sessionId, count - 1);
  }

  private async waitForPendingObserveInitIdle(sessionId?: string): Promise<void> {
    if (sessionId) {
      if (!this.pendingObserveInitCounts.has(sessionId)) return;
      await new Promise<void>((resolve) => {
        const waiters = this.pendingObserveInitWaiters.get(sessionId) ?? [];
        waiters.push(resolve);
        this.pendingObserveInitWaiters.set(sessionId, waiters);
      });
      return;
    }

    if (this.pendingObserveInitCounts.size === 0) return;
    await new Promise<void>((resolve) => {
      this.pendingObserveInitIdleWaiters.push(resolve);
    });
  }

  /** Build the compressed history recall section for a session. */
  async assembleRecall(
    sessionId: string,
    budgetChars: number,
  ): Promise<string> {
    return (await this.assembleRecallWithTrace(sessionId, budgetChars)).text;
  }

  /** Build compressed recall plus content-free selected-summary receipts. */
  async assembleRecallWithTrace(
    sessionId: string,
    budgetChars: number,
  ): Promise<LcmRecallWithTraceResult> {
    if (!this.config.enabled) return { text: "", selectedSummaries: [] };
    const normalizedSessionId = normalizeLcmSessionId(sessionId);
    if (!normalizedSessionId) return { text: "", selectedSummaries: [] };
    await this.ensureInitialized();

    const effectiveBudget = Math.ceil(
      budgetChars * this.config.recallBudgetShare,
    );
    if (effectiveBudget <= 0) return { text: "", selectedSummaries: [] };

    return assembleCompressedHistoryWithTrace(this.dag!, this.archive!, normalizedSessionId, {
      freshTailTurns: this.config.freshTailTurns,
      budgetChars: effectiveBudget,
    });
  }

  async searchStructuredParts(
    sessionId: string,
    query: string,
    limit = this.config.messagePartsRecallMaxResults,
  ): Promise<LcmStructuredRecallMatch[]> {
    const { messagePartsEnabled } = this.config;
    if (!this.config.enabled || !messagePartsEnabled) return [];
    const normalizedSessionId = normalizeLcmSessionId(sessionId);
    if (!normalizedSessionId) return [];
    await this.ensureInitialized();
    if (!this.archive) return [];
    return this.archive.searchStructuredParts(query, limit, normalizedSessionId);
  }

  formatStructuredRecall(
    matches: LcmStructuredRecallMatch[],
    budgetChars: number,
  ): string {
    if (matches.length === 0 || budgetChars <= 0) return "";
    const lines: string[] = [];
    let used = "## Structured Session Matches\n\n".length;
    for (const match of matches) {
      const label = match.file_path
        ? `${match.kind} ${match.file_path}`
        : match.tool_name
          ? `${match.kind} ${match.tool_name}`
          : match.kind;
      const excerpt = match.content.replace(/\s+/g, " ").slice(0, 220);
      const line = `- turn ${match.turn_index} (${match.role}): ${label} — ${excerpt}`;
      if (used + line.length + 1 > budgetChars) break;
      lines.push(line);
      used += line.length + 1;
    }
    return lines.length > 0 ? `## Structured Session Matches\n\n${lines.join("\n")}` : "";
  }

  /** Flush pending summaries before compaction (called from before_compaction hook). */
  async preCompactionFlush(sessionId: string): Promise<void> {
    if (!this.config.enabled) return;
    const normalizedSessionId = normalizeLcmSessionId(sessionId);
    if (!normalizedSessionId) return;
    await this.ensureInitialized();
    await this.waitForSessionObserveIdle(normalizedSessionId);

    try {
      await this.summarizer!.summarizeIncremental(normalizedSessionId);
    } catch (err) {
      log.debug(`LCM pre-compaction flush error: ${err}`);
    }
  }

  /** Record a compaction event with real token counts (called from after_compaction hook). */
  async recordCompaction(
    sessionId: string,
    tokensBefore: number,
    tokensAfter: number,
  ): Promise<void> {
    if (!this.config.enabled) return;
    const normalizedSessionId = normalizeLcmSessionId(sessionId);
    if (!normalizedSessionId) return;
    await this.ensureInitialized();
    await this.waitForSessionObserveIdle(normalizedSessionId);

    const maxTurn = this.archive!.getMaxTurnIndex(normalizedSessionId);

    this.dag!.recordCompaction(normalizedSessionId, maxTurn, tokensBefore, tokensAfter);
    log.info(
      `LCM compaction recorded: session=${normalizedSessionId}, turn=${maxTurn}, tokens ${tokensBefore}→${tokensAfter}`,
    );
  }

  /** Verify archive coverage after compaction. */
  async verifyPostCompaction(sessionId: string): Promise<void> {
    if (!this.config.enabled) return;
    const normalizedSessionId = normalizeLcmSessionId(sessionId);
    if (!normalizedSessionId) return;
    await this.ensureInitialized();

    const msgCount = this.archive!.getMessageCount(normalizedSessionId);
    const nodeCount = this.dag!.getNodeCount(normalizedSessionId);
    log.debug(
      `LCM post-compaction verify: session=${normalizedSessionId}, messages=${msgCount}, summaryNodes=${nodeCount}`,
    );
  }

  // ── MCP Tool implementations ──

  /** Search across all conversation history via FTS (snippet mode). */
  async searchContext(
    query: string,
    limit: number,
    sessionId?: string,
    sessionPrefix?: string,
  ): Promise<
    Array<{
      turn_index: number;
      role: string;
      snippet: string;
      session_id: string;
    }>
  > {
    if (!this.config.enabled) return [];
    const normalizedSessionId = normalizeOptionalLcmSessionId(sessionId);
    if (sessionId !== undefined && !normalizedSessionId) return [];
    const normalizedSessionPrefix = normalizeOptionalLcmSessionId(sessionPrefix);
    if (sessionPrefix !== undefined && !normalizedSessionPrefix) return [];
    await this.ensureInitialized();
    return this.archive!.search(query, limit, normalizedSessionId, normalizedSessionPrefix);
  }

  /** Search via FTS returning full message content (not snippets). */
  async searchContextFull(
    query: string,
    limit: number,
    sessionId?: string,
    sessionPrefix?: string,
  ): Promise<
    Array<{
      id: number;
      turn_index: number;
      role: string;
      content: string;
      session_id: string;
      score: number;
    }>
  > {
    if (!this.config.enabled) return [];
    const normalizedSessionId = normalizeOptionalLcmSessionId(sessionId);
    if (sessionId !== undefined && !normalizedSessionId) return [];
    const normalizedSessionPrefix = normalizeOptionalLcmSessionId(sessionPrefix);
    if (sessionPrefix !== undefined && !normalizedSessionPrefix) return [];
    await this.ensureInitialized();
    return this.archive!.searchWithContent(
      query,
      limit,
      normalizedSessionId,
      1000,
      normalizedSessionPrefix,
    );
  }

  /** Get a compressed summary of a turn range. */
  async describeContext(
    sessionId: string,
    fromTurn: number,
    toTurn: number,
  ): Promise<{ summary: string; turn_count: number; depth: number } | null> {
    if (!this.config.enabled) return null;
    const normalizedSessionId = normalizeLcmSessionId(sessionId);
    if (!normalizedSessionId) return null;
    await this.ensureInitialized();

    const nodes = this.dag!.getCoveringNodes(normalizedSessionId, fromTurn, toTurn);
    if (nodes.length === 0) {
      // No summary exists — build a description from raw messages
      const messages = this.archive!.getMessages(normalizedSessionId, fromTurn, toTurn);
      if (messages.length === 0) return null;
      const preview = messages
        .slice(0, 5)
        .map((m) => `[${m.role}] ${m.content.slice(0, 100)}`)
        .join("\n");
      return {
        summary: `No summary available for this range. Preview of ${messages.length} messages:\n${preview}`,
        turn_count: messages.length,
        depth: -1,
      };
    }

    // Use the deepest covering node
    const best = nodes[0]; // Already sorted by depth DESC
    return {
      summary: best.summary_text,
      turn_count: best.msg_end - best.msg_start + 1,
      depth: best.depth,
    };
  }

  /** Retrieve raw messages for a turn range (lossless expansion). */
  async expandContext(
    sessionId: string,
    fromTurn: number,
    toTurn: number,
    maxTokens: number,
  ): Promise<LcmExpandedMessage[]> {
    if (!this.config.enabled) return [];
    const normalizedSessionId = normalizeLcmSessionId(sessionId);
    if (!normalizedSessionId) return [];
    await this.ensureInitialized();

    const messages = this.archive!.getMessages(normalizedSessionId, fromTurn, toTurn);
    if (messages.length === 0) return [];

    // Enforce the token budget while keeping the existing first/last shape.
    const tokenBudget = Math.max(0, Math.floor(maxTokens));
    if (tokenBudget === 0) return [];
    const totalTokens = messages.reduce(
      (sum, message) => sum + estimateTokenCount(message.content),
      0,
    );
    if (totalTokens <= tokenBudget) {
      return messages.map((m) => ({
        id: m.id,
        session_id: m.session_id,
        turn_index: m.turn_index,
        role: m.role,
        content: m.content,
      }));
    }

    const result: LcmExpandedMessage[] = [];
    const lastMsg = messages[messages.length - 1];
    const reservedLastTokens = Math.min(
      estimateTokenCount(lastMsg.content),
      Math.max(1, Math.floor(tokenBudget * 0.3)),
    );
    let remainingTokens = tokenBudget - reservedLastTokens;

    for (let i = 0; i < messages.length - 1; i++) {
      if (remainingTokens <= 0) break;
      const content = truncateToTokenBudget(
        messages[i].content,
        remainingTokens,
      );
      if (!content) continue;
      result.push({
        id: messages[i].id,
        session_id: messages[i].session_id,
        turn_index: messages[i].turn_index,
        role: messages[i].role,
        content,
      });
      remainingTokens -= estimateTokenCount(content);
    }

    const lastContent = truncateToTokenBudget(
      lastMsg.content,
      reservedLastTokens + remainingTokens,
    );
    if (lastContent) {
      result.push({
        id: lastMsg.id,
        session_id: lastMsg.session_id,
        turn_index: lastMsg.turn_index,
        role: lastMsg.role,
        content: lastContent,
      });
    }
    return result;
  }


  /** Get statistics about the LCM archive. */
  async getStats(sessionId?: string): Promise<{
    totalMessages: number;
    totalSummaryNodes: number;
    maxDepth: number;
    maxTurnIndex?: number;
  }> {
    if (!this.config.enabled)
      return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: -1 };
    const normalizedSessionId = normalizeOptionalLcmSessionId(sessionId);
    if (sessionId !== undefined && !normalizedSessionId) {
      return { ...EMPTY_LCM_STATS };
    }
    await this.ensureInitialized();

    if (normalizedSessionId) {
      return {
        totalMessages: this.archive!.getMessageCount(normalizedSessionId),
        totalSummaryNodes: this.dag!.getNodeCount(normalizedSessionId),
        maxDepth: this.dag!.getMaxDepth(normalizedSessionId),
        maxTurnIndex: this.archive!.getMaxTurnIndex(normalizedSessionId),
      };
    }

    return {
      totalMessages: this.archive!.getTotalMessageCount(),
      totalSummaryNodes: 0, // Would need a global count query
      maxDepth: -1,
    };
  }

  /** Clear all LCM archive and summary state for one session. */
  async clearSession(sessionId: string): Promise<void> {
    if (!this.config.enabled || this.closed) return;
    const normalizedSessionId = normalizeLcmSessionId(sessionId);
    if (!normalizedSessionId) return;
    await this.ensureInitialized();
    if (this.closed || !this.archive || !this.dag) return;
    await this.waitForSessionObserveIdle(normalizedSessionId);
    this.dag.deleteSession(normalizedSessionId);
    this.archive.deleteSession(normalizedSessionId);
  }

  /** Clear all LCM archive and summary state without closing the engine. */
  async clearAll(): Promise<void> {
    if (!this.config.enabled || this.closed) return;
    await this.ensureInitialized();
    if (this.closed || !this.archive || !this.dag) return;
    await this.waitForObserveQueueIdle();
    this.dag.deleteAll();
    this.archive.deleteAll();
  }

  /** Prune old data beyond retention period. */
  async prune(): Promise<{ messagesPruned: number; nodesPruned: number }> {
    if (!this.config.enabled) return { messagesPruned: 0, nodesPruned: 0 };
    await this.ensureInitialized();

    const messagesPruned = this.archive!.pruneOldMessages(
      this.config.archiveRetentionDays,
    );
    const nodesPruned = this.dag!.pruneOldNodes(
      this.config.archiveRetentionDays,
    );
    return { messagesPruned, nodesPruned };
  }

  /** Close the database connection. */
  close(): void {
    this.closed = true;
    if (this.db) {
      this.db.close();
    }
    this.db = null;
    this.archive = null;
    this.dag = null;
    this.summarizer = null;
    this.observeQueue = null;
    this.initPromise = null;
  }
}
function truncateToTokenBudget(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  if (estimateTokenCount(text) <= maxTokens) return text;
  const codePoints = [...text];
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokenCount(codePoints.slice(0, mid).join("")) <= maxTokens) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return codePoints.slice(0, low).join("");
}
