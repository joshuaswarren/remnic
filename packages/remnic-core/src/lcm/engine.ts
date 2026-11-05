import type Database from "better-sqlite3";
import { openLcmDatabase, ensureLcmStateDir } from "./schema.js";
import { LcmArchive, type LcmMessage, type LcmStructuredRecallMatch } from "./archive.js";
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
import { nativeBindingRecoveryHint } from "../native-binding-hint.js";
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

function abortOnSignal<T>(abortSignal: AbortSignal | undefined, work: Promise<T>): Promise<T> {
  if (abortSignal === undefined) return work;
  abortSignal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortSignal.reason instanceof Error ? abortSignal.reason : new DOMException("Aborted", "AbortError"));
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => abortSignal.removeEventListener("abort", onAbort));
  });
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

/**
 * Upper bound on leaf batches summarized by one background job. Keeps a single
 * job's archive read and wall time bounded; leftover batches stay durable and
 * the job re-queues itself.
 */
const LCM_SUMMARIZE_MAX_LEAF_BATCHES_PER_JOB = 16;

/** Retry pacing for a failed summary pass: base delay and backoff ceiling. */
const LCM_SUMMARIZE_RETRY_BASE_MS = 500;
const LCM_SUMMARIZE_RETRY_MAX_MS = 30_000;

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
  private readonly summarizeRetryTimers = new Map<string, NodeJS.Timeout>();
  private readonly summarizeRetryAttempts = new Map<string, number>();
  /** Resolved when the session's pending retry timer has fired or been cleared. */
  private readonly summarizeRetryWaiters = new Map<
    string,
    { promise: Promise<void>; resolve: () => void }
  >();
  /** Explicit idle waiters per session; referenced only while nonzero. */
  private readonly summarizeRetryIdleWaiters = new Map<string, number>();
  /** Base backoff delay; tests shrink it to keep the retry loop fast. */
  private summarizeRetryBaseMs = LCM_SUMMARIZE_RETRY_BASE_MS;
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
      worker: async (sessionId) => {
        await this.processSummarizeJob(sessionId);
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
    this.resumeOutstandingSummaries();
    log.info("LCM engine initialized");
  }

  /**
   * Restart resume: sessions whose durable archive still holds complete
   * unsummarized batches get a summary job without any new observe call.
   * Only session references are queued — the content already lives in SQLite.
   */
  private resumeOutstandingSummaries(): void {
    if (!this.archive || !this.observeQueue) return;
    const sessions = this.archive.listSessionsWithUnsummarizedTurns(
      this.config.leafBatchSize,
    );
    if (sessions.length === 0) return;
    for (const sessionId of sessions) this.observeQueue.enqueue(sessionId);
    log.info(`LCM resume scheduled summary jobs: sessions=${sessions.length}`);
  }

  /**
   * Archive observed messages and schedule background summarization.
   *
   * The archive append completes BEFORE this resolves: an accepted observe is
   * already durable in SQLite, so a crash cannot lose it. Only the
   * summarization is background work, and it resumes from the durable archive.
   */
  async observeMessages(
    sessionId: string,
    messages: LcmObserveMessage[],
  ): Promise<void> {
    const normalizedSessionId = normalizeLcmSessionId(sessionId);
    if (!normalizedSessionId) return;
    await this.enqueueObserveMessages(normalizedSessionId, messages);
  }

  /**
   * Durably archive messages, then queue a metadata-only summary job.
   *
   * Rejects when the archive append fails — callers must not treat a failed
   * archive as an accepted observation.
   */
  async enqueueObserveMessages(
    sessionId: string,
    messages: LcmObserveMessage[],
  ): Promise<void> {
    // LCM off is a feature gate (the caller reports "not archived"); a closed
    // engine is a failure — accepting the turn and archiving nothing would
    // acknowledge a turn the archive never stored.
    if (!this.config.enabled) return;
    if (this.closed) throw new Error("LCM engine is closed");
    const normalizedSessionId = normalizeLcmSessionId(sessionId);
    if (!normalizedSessionId) return;
    if (messages.length === 0) return;

    this.reservePendingObserveInit(normalizedSessionId);

    try {
      await this.ensureInitialized();
      if (this.closed) throw new Error("LCM engine is closed");
      if (!this.archive || !this.observeQueue) {
        throw new Error("LCM engine is not initialized");
      }

      const archived = this.archiveObservedMessages(normalizedSessionId, messages);
      this.observeQueue.enqueue(normalizedSessionId);
      log.debug(
        `LCM observe archived: session=${normalizedSessionId}, messages=${archived}, depth=${this.observeQueue.depth}, inFlight=${this.observeQueue.inFlightCount}`,
      );
    } catch (err) {
      log.error(
        `LCM observe archive failed: session=${normalizedSessionId}, error=${err}${nativeBindingRecoveryHint(err)}`,
      );
      throw err;
    } finally {
      this.releasePendingObserveInit(normalizedSessionId);
    }
  }

  /** Append observed messages to the archive; returns the number of rows. */
  private archiveObservedMessages(
    sessionId: string,
    messages: LcmObserveMessage[],
  ): number {
    const currentMax = this.archive!.getMaxTurnIndex(sessionId);
    const { messagePartsEnabled } = this.config;
    const rows = messages.map((m, i) => ({
      turnIndex: currentMax + 1 + i,
      role: m.role,
      content: m.content,
      parts: messagePartsEnabled ? m.parts : undefined,
      rawContent: messagePartsEnabled ? m.rawContent : undefined,
      sourceFormat: messagePartsEnabled ? m.sourceFormat : undefined,
    }));

    this.archive!.appendMessages(sessionId, rows, { messagePartsEnabled });
    return rows.length;
  }

  /**
   * Summarize one session's durable backlog.
   *
   * The pass is capped so a long backlog never holds a job open indefinitely;
   * remaining batches stay durable and the job re-queues itself.
   */
  private async processSummarizeJob(sessionId: string): Promise<void> {
    if (this.closed) return;
    await this.ensureInitialized();
    if (this.closed || !this.archive || !this.summarizer || !this.observeQueue)
      return;

    try {
      await this.summarizer.summarizeIncremental(sessionId, {
        maxLeafBatches: LCM_SUMMARIZE_MAX_LEAF_BATCHES_PER_JOB,
      });
    } catch (err) {
      // The archived turns are durable; a failed pass must not strand them
      // until the next observe or a restart.
      log.error(`LCM incremental summarization failed: session=${sessionId}, error=${err}`);
      this.scheduleSummarizeRetry(sessionId);
      return;
    }

    this.clearSummarizeRetry(sessionId);

    if (this.hasCompleteBatchPending(sessionId)) {
      this.observeQueue.enqueue(sessionId);
    }
  }

  /**
   * Schedule a metadata-only retry for a failed summary pass.
   *
   * The retry keeps trying for as long as the engine is open and complete
   * batches remain — a transient failure must never strand durable work.
   * What is bounded is the RATE, not the ability to retry: one pending timer
   * per session, exponential backoff capped at
   * {@link LCM_SUMMARIZE_RETRY_MAX_MS}, and an unreferenced timer that is
   * cleared when the engine closes.
   */
  private scheduleSummarizeRetry(sessionId: string): void {
    if (this.closed || this.summarizeRetryTimers.has(sessionId)) return;
    const attempt = (this.summarizeRetryAttempts.get(sessionId) ?? 0) + 1;
    this.summarizeRetryAttempts.set(sessionId, attempt);
    const delayMs = Math.min(
      LCM_SUMMARIZE_RETRY_MAX_MS,
      this.summarizeRetryBaseMs * 2 ** Math.min(attempt - 1, 16),
    );
    // The waiter makes the pending retry visible to idle waits, so a direct
    // flush (pre-compaction) serializes with the retry instead of racing it.
    const retry = Promise.withResolvers<void>();
    this.summarizeRetryWaiters.set(sessionId, retry);
    const timer = setTimeout(() => {
      this.summarizeRetryTimers.delete(sessionId);
      this.summarizeRetryWaiters.delete(sessionId);
      if (this.closed) {
        retry.resolve();
        return;
      }
      if (!this.hasCompleteBatchPending(sessionId)) {
        this.summarizeRetryAttempts.delete(sessionId);
        retry.resolve();
        return;
      }
      // Re-queue before releasing the waiter: an idle wait released by the
      // retry must observe the queued job, never run beside it.
      this.observeQueue?.enqueue(sessionId);
      retry.resolve();
    }, delayMs);
    // Pure background: unreferenced, so a one-shot host is never kept alive
    // by a retry loop. An explicit idle waiter (see waitForSessionObserveIdle)
    // references it for the duration of the wait, and close() clears all.
    timer.unref?.();
    this.summarizeRetryTimers.set(sessionId, timer);
  }

  /** True when the session still holds a complete unsummarized batch. */
  private hasCompleteBatchPending(sessionId: string): boolean {
    if (!this.archive) return false;
    return (
      this.archive.countUnsummarizedMessages(sessionId) >=
      this.config.leafBatchSize
    );
  }

  /** Drop a pending retry, its attempt counter, and release idle waiters. */
  private clearSummarizeRetry(sessionId: string): void {
    const timer = this.summarizeRetryTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.summarizeRetryTimers.delete(sessionId);
    }
    const waiter = this.summarizeRetryWaiters.get(sessionId);
    if (waiter) {
      this.summarizeRetryWaiters.delete(sessionId);
      waiter.resolve();
    }
    this.summarizeRetryAttempts.delete(sessionId);
  }

  get observeQueueDepth(): number {
    return this.observeQueue?.depth ?? 0;
  }

  get observeQueueInFlightCount(): number {
    return this.observeQueue?.inFlightCount ?? 0;
  }

  async waitForObserveQueueIdle(abortSignal?: AbortSignal): Promise<void> {
    abortSignal?.throwIfAborted();
    if (!this.config.enabled || this.closed) return;
    await this.ensureInitialized();
    abortSignal?.throwIfAborted();
    if (this.closed) return;
    for (;;) {
      abortSignal?.throwIfAborted();
      await this.waitForPendingObserveInitIdle();
      await this.observeQueue?.whenIdle();
      abortSignal?.throwIfAborted();
      const entry = [...this.summarizeRetryWaiters.entries()][0];
      if (!entry) return;
      await this.awaitSummarizeRetry(entry[0], entry[1], abortSignal);
      // A fired retry may have re-queued a session: wait for the queue again.
    }
  }

  async waitForSessionObserveIdle(sessionId: string, abortSignal?: AbortSignal): Promise<void> {
    abortSignal?.throwIfAborted();
    if (!this.config.enabled || this.closed) return;
    const normalizedSessionId = normalizeLcmSessionId(sessionId);
    if (!normalizedSessionId) return;
    await this.ensureInitialized();
    abortSignal?.throwIfAborted();
    if (this.closed) return;
    // Serialize with pending summary retries: a direct flush (pre-compaction)
    // must not run beside a retry pass for the same session.
    for (;;) {
      await this.waitForPendingObserveInitIdle(normalizedSessionId, abortSignal);
      await this.observeQueue?.whenSessionIdle(normalizedSessionId, abortSignal) ?? Promise.resolve();
      const waiter = this.summarizeRetryWaiters.get(normalizedSessionId);
      if (!waiter) return;
      await this.awaitSummarizeRetry(normalizedSessionId, waiter, abortSignal);
      // The retry fired and may have re-queued the session: wait again.
    }
  }

  /**
   * Park an explicit idle wait on a pending retry. While any wait is parked,
   * the retry timer is referenced so a one-shot host cannot exit under the
   * wait; with no waiters the timer stays unreferenced background work.
   */
  private async awaitSummarizeRetry(
    sessionId: string,
    waiter: { promise: Promise<void>; resolve: () => void },
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const waiters = (this.summarizeRetryIdleWaiters.get(sessionId) ?? 0) + 1;
    this.summarizeRetryIdleWaiters.set(sessionId, waiters);
    this.summarizeRetryTimers.get(sessionId)?.ref?.();
    try {
      await abortOnSignal(abortSignal, waiter.promise);
    } finally {
      const remaining = (this.summarizeRetryIdleWaiters.get(sessionId) ?? 1) - 1;
      if (remaining <= 0) {
        this.summarizeRetryIdleWaiters.delete(sessionId);
        this.summarizeRetryTimers.get(sessionId)?.unref?.();
      } else {
        this.summarizeRetryIdleWaiters.set(sessionId, remaining);
      }
    }
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

  private async waitForPendingObserveInitIdle(sessionId?: string, abortSignal?: AbortSignal): Promise<void> {
    abortSignal?.throwIfAborted();
    if (sessionId) {
      if (!this.pendingObserveInitCounts.has(sessionId)) return;
      await new Promise<void>((resolve, reject) => {
        const finish = (): void => {
          abortSignal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = (): void => {
          const remaining = (this.pendingObserveInitWaiters.get(sessionId) ?? []).filter((waiter) => waiter !== finish);
          if (remaining.length === 0) this.pendingObserveInitWaiters.delete(sessionId);
          else this.pendingObserveInitWaiters.set(sessionId, remaining);
          reject(abortSignal?.reason instanceof Error ? abortSignal.reason : new DOMException("Aborted", "AbortError"));
        };
        const waiters = this.pendingObserveInitWaiters.get(sessionId) ?? [];
        waiters.push(finish);
        this.pendingObserveInitWaiters.set(sessionId, waiters);
        abortSignal?.addEventListener("abort", onAbort, { once: true });
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
  async preCompactionFlush(sessionId: string, abortSignal?: AbortSignal): Promise<void> {
    abortSignal?.throwIfAborted();
    if (!this.config.enabled) return;
    const normalizedSessionId = normalizeLcmSessionId(sessionId);
    if (!normalizedSessionId) return;
    await this.ensureInitialized();
    abortSignal?.throwIfAborted();
    await this.waitForSessionObserveIdle(normalizedSessionId, abortSignal);
    abortSignal?.throwIfAborted();

    try {
      await abortOnSignal(abortSignal, this.summarizer!.summarizeIncremental(normalizedSessionId));
    } catch (err) {
      if (abortSignal?.aborted) throw err;
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

  /**
   * Retrieve raw archived messages for a turn range (inclusive bounds),
   * read-only and unshaped — no token-budget trimming (issue #2331
   * episodic-context). Callers own truncation and cleaning.
   */
  async getTurnRange(
    sessionId: string,
    fromTurn: number,
    toTurn: number,
  ): Promise<LcmMessage[]> {
    if (!this.config.enabled) return [];
    const normalizedSessionId = normalizeLcmSessionId(sessionId);
    if (!normalizedSessionId) return [];
    await this.ensureInitialized();
    return this.archive!.getMessages(normalizedSessionId, fromTurn, toTurn);
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
  async clearSession(sessionId: string, abortSignal?: AbortSignal): Promise<void> {
    if (!this.config.enabled || this.closed) return;
    const normalizedSessionId = normalizeLcmSessionId(sessionId);
    if (!normalizedSessionId) return;
    await this.ensureInitialized();
    if (this.closed || !this.archive || !this.dag) return;
    await this.waitForSessionObserveIdle(normalizedSessionId, abortSignal);
    abortSignal?.throwIfAborted();
    this.dag.deleteSession(normalizedSessionId);
    this.archive.deleteSession(normalizedSessionId);
  }

  /** Clear all LCM archive and summary state without closing the engine. */
  async clearAll(abortSignal?: AbortSignal): Promise<void> {
    if (!this.config.enabled || this.closed) return;
    await this.ensureInitialized();
    if (this.closed || !this.archive || !this.dag) return;
    await this.waitForObserveQueueIdle(abortSignal);
    abortSignal?.throwIfAborted();
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
    for (const timer of this.summarizeRetryTimers.values()) clearTimeout(timer);
    this.summarizeRetryTimers.clear();
    this.summarizeRetryAttempts.clear();
    for (const retry of this.summarizeRetryWaiters.values()) retry.resolve();
    this.summarizeRetryWaiters.clear();
    this.summarizeRetryIdleWaiters.clear();
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
