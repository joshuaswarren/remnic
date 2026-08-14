/**
 * Conversation index coordinator — extracted from the orchestrator (issue #1526).
 *
 * Owns the conversation-index subsystem: semantic recall over past
 * conversations, plus the build / update / rebuild / inspect / health
 * lifecycle of the on-disk chunk store and its pluggable search backend
 * (qmd or faiss). Behavior-preserving move from orchestrator.ts — no logic
 * changes; the orchestrator constructs one instance and keeps thin
 * delegating methods so existing call sites and tests that exercise the
 * private API continue to work.
 *
 * The backend and transcript are read through getters (not captured at
 * construction) so that post-construction reassignment of the orchestrator's
 * live fields — exercised by the conversation-index integration tests and by
 * backend swap-in at deferred-init time — is honored. This mirrors the
 * TierMigrationCoordinator accessor pattern.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";

import { resolveIndexingCapabilities, resolveSecurityCapabilities } from "../capabilities.js";
import { renderAuthorityBoundContent } from "../recall-context-composition.js";
import { cleanupConversationChunks } from "../conversation-index/cleanup.js";
import { chunkTranscriptEntries } from "../conversation-index/chunker.js";
import type { ConversationChunk } from "../conversation-index/chunker.js";
import { writeConversationChunks } from "../conversation-index/indexer.js";
import type {
  ConversationIndexBackend,
  ConversationIndexBackendHealth,
  ConversationIndexBackendInspection,
} from "../conversation-index/backend.js";
import type { ConversationSearchResult } from "../conversation-index/search.js";
import type { TranscriptManager } from "../transcript.js";
import type { PluginConfig } from "../types.js";

/**
 * Coordinator for the conversation-index subsystem.
 *
 * Holds the per-session last-update timestamps (previously an orchestrator
 * field) and delegates chunk building / persistence / embedding to the
 * configured backend.
 */
export class ConversationIndexCoordinator {
  private readonly config: PluginConfig;
  private readonly originAuthorityEnabled: boolean;
  private readonly getTranscript: () => TranscriptManager;
  private readonly getBackend: () => ConversationIndexBackend | undefined;
  private readonly indexDir: string;
  private readonly lastUpdateAtMs = new Map<string, number>();

  constructor(options: {
    config: PluginConfig;
    getTranscript: () => TranscriptManager;
    getBackend: () => ConversationIndexBackend | undefined;
    indexDir: string;
  }) {
    this.config = options.config;
    this.originAuthorityEnabled = resolveSecurityCapabilities(this.config).originAuthority;
    this.getTranscript = options.getTranscript;
    this.getBackend = options.getBackend;
    this.indexDir = options.indexDir;
  }

  /** Semantic recall over past-conversation chunks (fail-open: empty on miss). */
  async search(
    retrievalQuery: string,
    topK: number,
  ): Promise<ConversationSearchResult[]> {
    const backend = this.getBackend();
    if (backend) {
      return backend.search(retrievalQuery, topK);
    }
    return [];
  }

  /** Render conversation-recall search hits as a budgeted markdown section. */
  formatRecallSection(
    results: ConversationSearchResult[],
    maxChars: number,
  ): string | null {
    if (!Array.isArray(results) || results.length === 0) return null;
    const lines: string[] = ["## Semantic Recall (Past Conversations)", ""];
    let used = 0;
    for (const r of results) {
      const body = renderAuthorityBoundContent(
        r.snippet.trim(),
        undefined,
        {
          enabled: this.originAuthorityEnabled,
          untrustedOrigins: this.config.untrustedOrigins,
        },
      );
      const chunk =
        `### ${r.path}\n` +
        `Score: ${r.score.toFixed(3)}\n\n` +
        `${body}\n`;
      if (used + chunk.length > maxChars) break;
      lines.push(chunk);
      used += chunk.length;
    }
    return used > 0 ? lines.join("\n") : null;
  }

  /** Recursively count `.md` chunk documents under a directory. */
  async countChunkDocs(dir: string): Promise<number> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      let total = 0;
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          total += await this.countChunkDocs(fullPath);
          continue;
        }
        if (entry.isFile() && entry.name.endsWith(".md")) {
          total += 1;
        }
      }
      return total;
    } catch {
      return 0;
    }
  }

  /** Read recent transcript entries and chunk them for indexing. */
  async buildChunks(
    sessionKey?: string,
    hours: number = 24,
  ): Promise<ConversationChunk[]> {
    const entries = await this.getTranscript().readRecent(hours, sessionKey);
    const effectiveSessionKey = sessionKey ?? "all-sessions";
    return chunkTranscriptEntries(effectiveSessionKey, entries, {
      maxChars: this.config.conversationRecallMaxChars * 2,
      maxTurns: Math.max(10, this.config.hourlySummariesMaxTurnsPerRun),
    });
  }

  async getHealth(): Promise<{
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
    const chunkDocCount = await this.countChunkDocs(this.indexDir);
    const lastUpdateAtMs = Math.max(0, ...this.lastUpdateAtMs.values());
    const lastUpdateAt =
      lastUpdateAtMs > 0 ? new Date(lastUpdateAtMs).toISOString() : null;

    if (!resolveIndexingCapabilities(this.config).conversationIndex) {
      return {
        enabled: false,
        backend: this.config.conversationIndexBackend,
        status: "disabled",
        chunkDocCount,
        lastUpdateAt,
      };
    }
    const backend = this.getBackend();
    const backendHealth: ConversationIndexBackendHealth = backend
      ? await backend.health()
      : {
          backend: this.config.conversationIndexBackend,
          status: "degraded" as const,
        };
    return {
      enabled: true,
      chunkDocCount,
      lastUpdateAt,
      ...backendHealth,
    };
  }

  async inspect(): Promise<
    ConversationIndexBackendInspection & {
      enabled: boolean;
      chunkDocCount: number;
      lastUpdateAt: string | null;
    }
  > {
    const chunkDocCount = await this.countChunkDocs(this.indexDir);
    const lastUpdateAtMs = Math.max(0, ...this.lastUpdateAtMs.values());
    const lastUpdateAt =
      lastUpdateAtMs > 0 ? new Date(lastUpdateAtMs).toISOString() : null;

    if (!resolveIndexingCapabilities(this.config).conversationIndex) {
      return {
        enabled: false,
        backend: this.config.conversationIndexBackend,
        status: "disabled",
        available: false,
        indexPath: this.indexDir,
        supportsIncrementalUpdate: true,
        message: "Conversation index disabled by config",
        metadata: {
          chunkCount: chunkDocCount,
        },
        chunkDocCount,
        lastUpdateAt,
      };
    }

    const backend = this.getBackend();
    const inspection: ConversationIndexBackendInspection = backend
      ? await backend.inspect()
      : {
          backend: this.config.conversationIndexBackend,
          status: "degraded" as const,
          available: false,
          indexPath: this.indexDir,
          supportsIncrementalUpdate: true,
          message: "Conversation index backend unavailable",
          metadata: {
            chunkCount: chunkDocCount,
          },
        };

    return {
      enabled: true,
      chunkDocCount,
      lastUpdateAt,
      ...inspection,
    };
  }

  async update(
    sessionKey: string,
    hours: number = 24,
    opts?: { embed?: boolean; enforceMinInterval?: boolean },
  ): Promise<{
    chunks: number;
    skipped: boolean;
    reason?: string;
    retryAfterMs?: number;
    embedded?: boolean;
  }> {
    if (!resolveIndexingCapabilities(this.config).conversationIndex) {
      return { chunks: 0, skipped: true, reason: "disabled", embedded: false };
    }
    const enforceMinInterval = opts?.enforceMinInterval !== false;
    if (enforceMinInterval) {
      const minIntervalMs = Math.max(
        0,
        this.config.conversationIndexMinUpdateIntervalMs,
      );
      const now = Date.now();
      const last = this.lastUpdateAtMs.get(sessionKey) ?? 0;
      const elapsed = now - last;
      if (minIntervalMs > 0 && elapsed < minIntervalMs) {
        return {
          chunks: 0,
          skipped: true,
          reason: "min_interval",
          retryAfterMs: minIntervalMs - elapsed,
          embedded: false,
        };
      }
    }
    const chunks = await this.buildChunks(sessionKey, hours);
    await writeConversationChunks(this.indexDir, chunks);
    const retentionCutoffMs =
      Number.isFinite(this.config.conversationIndexRetentionDays) &&
      this.config.conversationIndexRetentionDays > 0
        ? Date.now() -
          this.config.conversationIndexRetentionDays * 24 * 60 * 60 * 1000
        : undefined;
    await cleanupConversationChunks(
      this.indexDir,
      this.config.conversationIndexRetentionDays,
    );
    const shouldEmbed =
      opts?.embed ?? this.config.conversationIndexEmbedOnUpdate;
    let embedded = false;

    const backend = this.getBackend();
    if (backend) {
      const result = await backend.update(chunks, {
        embed: shouldEmbed,
        ...(retentionCutoffMs !== undefined ? { retentionCutoffMs } : {}),
      });
      embedded = result.embedded;
    }

    this.lastUpdateAtMs.set(sessionKey, Date.now());
    return { chunks: chunks.length, skipped: false, embedded };
  }

  async rebuild(
    sessionKey?: string,
    hours: number = 24,
    opts?: { embed?: boolean },
  ): Promise<{
    chunks: number;
    skipped: boolean;
    reason?: string;
    embedded?: boolean;
    rebuilt?: boolean;
  }> {
    if (!resolveIndexingCapabilities(this.config).conversationIndex) {
      return {
        chunks: 0,
        skipped: true,
        reason: "disabled",
        embedded: false,
        rebuilt: false,
      };
    }

    const chunks = await this.buildChunks(sessionKey, hours);
    await writeConversationChunks(this.indexDir, chunks);
    await cleanupConversationChunks(
      this.indexDir,
      this.config.conversationIndexRetentionDays,
    );

    const shouldEmbed =
      opts?.embed ?? this.config.conversationIndexEmbedOnUpdate;
    let embedded = false;
    let rebuilt = false;
    const backend = this.getBackend();
    if (backend) {
      const result = await backend.rebuild(chunks, {
        embed: shouldEmbed,
      });
      embedded = result.embedded;
      rebuilt = result.rebuilt;
    }

    const stamp = Date.now();
    if (sessionKey) {
      this.lastUpdateAtMs.set(sessionKey, stamp);
    } else {
      this.lastUpdateAtMs.set("__rebuild__", stamp);
    }
    return { chunks: chunks.length, skipped: false, embedded, rebuilt };
  }
}
