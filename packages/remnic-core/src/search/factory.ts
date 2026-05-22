import type { PluginConfig } from "../types.js";
import type { SearchBackend } from "./port.js";
import path from "node:path";
import { NoopSearchBackend } from "./noop-backend.js";
import { RemoteSearchBackend } from "./remote-backend.js";
import { LanceDbBackend } from "./lancedb-backend.js";
import { MeilisearchBackend } from "./meilisearch-backend.js";
import { OramaBackend } from "./orama-backend.js";
import { EmbedHelper } from "./embed-helper.js";
import { QmdClient, type QmdClientOptions } from "../qmd.js";
import { log } from "../logger.js";
import { FaissConversationIndexAdapter } from "../conversation-index/faiss-adapter.js";
import {
  createConversationIndexBackend,
  type ConversationIndexBackend,
  type ConversationQmdRuntime,
} from "../conversation-index/backend.js";

/**
 * Resolve non-QMD backends from config.
 * Returns a SearchBackend for "noop" or "remote", or undefined to signal "use QMD".
 */
function resolveNonQmdBackend(config: PluginConfig): SearchBackend | undefined {
  const backend = config.searchBackend ?? "qmd";
  const collection = config.qmdCollection;

  if (backend === "noop") {
    return new NoopSearchBackend();
  }

  if (backend === "remote") {
    const baseUrl = config.remoteSearchBaseUrl || "http://localhost:8181";
    if (!config.remoteSearchBaseUrl) {
      log.warn("searchBackend is 'remote' but remoteSearchBaseUrl is not configured; using default http://localhost:8181");
    }
    return new RemoteSearchBackend({
      baseUrl,
      apiKey: config.remoteSearchApiKey,
      timeoutMs: config.remoteSearchTimeoutMs,
    });
  }

  if (backend === "lancedb") {
    const embedHelper = new EmbedHelper(config);
    return new LanceDbBackend({
      dbPath: config.lanceDbPath!,
      collection,
      embedHelper,
      memoryDir: config.memoryDir,
      embeddingDimension: config.lanceEmbeddingDimension!,
    });
  }

  if (backend === "meilisearch") {
    return new MeilisearchBackend({
      host: config.meilisearchHost!,
      apiKey: config.meilisearchApiKey,
      collection,
      timeoutMs: config.meilisearchTimeoutMs,
      autoIndex: config.meilisearchAutoIndex,
      memoryDir: config.memoryDir,
    });
  }

  if (backend === "orama") {
    const embedHelper = new EmbedHelper(config);
    return new OramaBackend({
      dbPath: config.oramaDbPath!,
      collection,
      embedHelper,
      memoryDir: config.memoryDir,
      embeddingDimension: config.oramaEmbeddingDimension!,
    });
  }

  return undefined;
}

/** Shared QMD options derived from plugin config. */
function qmdOptions(config: PluginConfig): QmdClientOptions {
  return {
    slowLog: {
      enabled: config.slowLogEnabled,
      thresholdMs: config.slowLogThresholdMs,
    },
    updateTimeoutMs: config.qmdUpdateTimeoutMs,
    updateMinIntervalMs: config.qmdUpdateMinIntervalMs,
    qmdPath: config.qmdPath,
    daemonUrl: config.qmdDaemonEnabled ? config.qmdDaemonUrl : undefined,
    daemonRecheckIntervalMs: config.qmdDaemonRecheckIntervalMs,
    qmdSupportedVersion: config.qmdSupportedVersion,
    qmdAutoUpgradeEnabled: config.qmdAutoUpgradeEnabled,
    qmdAutoUpgradeCheckIntervalMs: config.qmdAutoUpgradeCheckIntervalMs,
    qmdChunkStrategy: config.qmdChunkStrategy,
    qmdCandidateLimit: config.qmdCandidateLimit,
    qmdQueryRerankEnabled: config.qmdQueryRerankEnabled,
    qmdIndexName: config.qmdIndexName,
    qmdForceCpu: config.qmdForceCpu,
    qmdGpuBackend: config.qmdGpuBackend,
    qmdEmbedParallelism: config.qmdEmbedParallelism,
    qmdEmbedModel: config.qmdEmbedModel,
    qmdRerankModel: config.qmdRerankModel,
    qmdGenerateModel: config.qmdGenerateModel,
  };
}

/**
 * Create a SearchBackend from plugin config.
 *
 * - "noop" → NoopSearchBackend
 * - "remote" → RemoteSearchBackend (HTTP REST)
 * - "qmd" (default) → QmdClient if qmdEnabled, else NoopSearchBackend
 */
export function createSearchBackend(config: PluginConfig): SearchBackend {
  const nonQmd = resolveNonQmdBackend(config);
  if (nonQmd) return nonQmd;

  // Default: QMD — fall back to noop if qmdEnabled is false
  if (!config.qmdEnabled) {
    return new NoopSearchBackend();
  }

  return new QmdClient(config.qmdCollection, config.qmdMaxResults, qmdOptions(config));
}

/**
 * Create a SearchBackend for conversation index use.
 * Returns undefined if conversation index is not enabled or not using qmd backend.
 */
export function createConversationSearchBackend(config: PluginConfig): SearchBackend | undefined {
  if (!config.conversationIndexEnabled || config.conversationIndexBackend !== "qmd") {
    return undefined;
  }

  // Conversation index is QMD-only — do not use lancedb/meilisearch/orama even if
  // searchBackend is set to one of those. Only respect "noop" to allow disabling.
  const backend = config.searchBackend ?? "qmd";
  if (backend === "noop") return undefined;

  // QMD — respect qmdEnabled to avoid spawning the binary
  if (!config.qmdEnabled) return undefined;

  return new QmdClient(
    config.conversationIndexQmdCollection,
    Math.max(6, config.conversationRecallTopK),
    qmdOptions(config),
  );
}

export interface ConversationIndexRuntime {
  qmd?: ConversationQmdRuntime;
  faiss?: FaissConversationIndexAdapter;
  backend?: ConversationIndexBackend;
}

export function createConversationIndexRuntime(
  config: PluginConfig,
  overrides?: {
    getQmd?: () => ConversationQmdRuntime | undefined;
    getFaiss?: () => FaissConversationIndexAdapter | undefined;
  },
): ConversationIndexRuntime {
  const qmd = createConversationSearchBackend(config) as ConversationQmdRuntime | undefined;
  let faiss: FaissConversationIndexAdapter | undefined;
  if (config.conversationIndexEnabled && config.conversationIndexBackend === "faiss") {
    try {
      faiss = new FaissConversationIndexAdapter({
          memoryDir: config.memoryDir,
          scriptPath: config.conversationIndexFaissScriptPath,
          pythonBin: config.conversationIndexFaissPythonBin,
          modelId: config.conversationIndexFaissModelId,
          indexDir: config.conversationIndexFaissIndexDir,
          upsertTimeoutMs: config.conversationIndexFaissUpsertTimeoutMs,
          searchTimeoutMs: config.conversationIndexFaissSearchTimeoutMs,
          healthTimeoutMs: config.conversationIndexFaissHealthTimeoutMs,
          maxBatchSize: config.conversationIndexFaissMaxBatchSize,
          maxSearchK: config.conversationIndexFaissMaxSearchK,
      });
    } catch (err) {
      log.warn(`Conversation index FAISS adapter disabled: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const backend = createConversationIndexBackend({
    enabled: config.conversationIndexEnabled,
    backend: config.conversationIndexBackend,
    getQmd: () => overrides?.getQmd?.() ?? qmd,
    getFaiss: () => overrides?.getFaiss?.() ?? faiss,
    collectionDir: path.join(config.memoryDir, "conversation-index"),
  });

  return { qmd, faiss, backend };
}
