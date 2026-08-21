import type { SearchBackend, SearchExecutionOptions } from "../search/port.js";
import type { ConversationChunk } from "./chunker.js";
import { failOpenFaissHealth, type FaissConversationIndexAdapter } from "./faiss-adapter.js";
import {
  rebuildConversationChunksFailOpen,
  upsertConversationChunksFailOpen,
} from "./indexer.js";
import { searchConversationIndex, searchConversationIndexFaissFailOpen, type ConversationSearchResult } from "./search.js";

type CollectionState = "missing" | "unknown" | "present" | "skipped";

export interface ConversationQmdRuntime extends SearchBackend {
  isAvailable(): boolean;
  probe(): Promise<boolean>;
  ensureCollection(baseDir: string): Promise<CollectionState>;
  update(execution?: SearchExecutionOptions): Promise<void>;
  updateCollection(collection: string, execution?: SearchExecutionOptions): Promise<void>;
  embed(): Promise<void>;
  debugStatus(): string;
}

export interface ConversationIndexBackendHealth {
  backend: "qmd" | "faiss";
  status: "ok" | "degraded" | "disabled";
  message?: string;
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
}

export interface ConversationIndexBackendInspection {
  backend: "qmd" | "faiss";
  status: "ok" | "degraded" | "disabled";
  available: boolean;
  indexPath: string;
  supportsIncrementalUpdate: boolean;
  message?: string;
  metadata: {
    chunkCount: number | null;
    qmdAvailable?: boolean;
    debugStatus?: string;
    hasIndex?: boolean;
    hasMetadata?: boolean;
    hasManifest?: boolean;
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
}

export interface ConversationIndexBackendInitResult {
  enabled: boolean;
  logLevel: "info" | "warn" | "debug";
  message: string;
}

export interface ConversationIndexBackend {
  readonly kind: "qmd" | "faiss";
  initialize(): Promise<ConversationIndexBackendInitResult>;
  search(query: string, maxResults: number): Promise<ConversationSearchResult[]>;
  update(
    chunks: ConversationChunk[],
    options: { embed: boolean; retentionCutoffMs?: number },
  ): Promise<{ embedded: boolean }>;
  rebuild(chunks: ConversationChunk[], options: { embed: boolean }): Promise<{ embedded: boolean; rebuilt: boolean }>;
  health(): Promise<ConversationIndexBackendHealth>;
  inspect(): Promise<ConversationIndexBackendInspection>;
}

export function createConversationIndexBackend(options: {
  enabled: boolean;
  backend: "qmd" | "faiss";
  getQmd?: () => ConversationQmdRuntime | undefined;
  getFaiss?: () => FaissConversationIndexAdapter | undefined;
  qmd?: ConversationQmdRuntime;
  faiss?: FaissConversationIndexAdapter;
  collectionDir: string;
}): ConversationIndexBackend | undefined {
  if (!options.enabled) return undefined;
  const getQmd = options.getQmd ?? (() => options.qmd);
  const getFaiss = options.getFaiss ?? (() => options.faiss);
  if (options.backend === "faiss") {
    return createFaissBackend(getFaiss);
  }
  return createQmdBackend(getQmd, options.collectionDir);
}

function createQmdBackend(
  getQmd: () => ConversationQmdRuntime | undefined,
  collectionDir: string,
): ConversationIndexBackend {
  return {
    kind: "qmd",
    async initialize() {
      const qmd = getQmd();
      if (!qmd) {
        return {
          enabled: true,
          logLevel: "warn",
          message: "Conversation index QMD: not available search backend disabled or unsupported",
        };
      }

      const available = await qmd.probe();
      if (!available) {
        return {
          enabled: true,
          logLevel: "warn",
          message: `Conversation index QMD: not available ${qmd.debugStatus()}`,
        };
      }

      const collectionState = await qmd.ensureCollection(collectionDir);
      if (collectionState === "missing") {
        return {
          enabled: false,
          logLevel: "warn",
          message: "Conversation index collection missing; disabling conversation semantic recall for this runtime",
        };
      }
      if (collectionState === "unknown") {
        return {
          enabled: true,
          logLevel: "warn",
          message: "Conversation index collection check unavailable; keeping conversation semantic recall enabled for fail-open behavior",
        };
      }
      if (collectionState === "skipped") {
        return {
          enabled: true,
          logLevel: "debug",
          message: "Conversation index collection check skipped in daemon-only mode",
        };
      }

      return {
        enabled: true,
        logLevel: "info",
        message: `Conversation index QMD: available ${qmd.debugStatus()}`,
      };
    },
    async search(query: string, maxResults: number) {
      const qmd = getQmd();
      if (!qmd || !qmd.isAvailable()) return [];
      return searchConversationIndex(qmd, query, maxResults);
    },
    async update(_chunks: ConversationChunk[], options: { embed: boolean; retentionCutoffMs?: number }) {
      const qmd = getQmd();
      if (!qmd || !qmd.isAvailable()) return { embedded: false };
      await qmd.update();
      if (options.embed) {
        await qmd.embed();
        return { embedded: true };
      }
      return { embedded: false };
    },
    async rebuild(_chunks: ConversationChunk[], options: { embed: boolean }) {
      const qmd = getQmd();
      if (!qmd || !qmd.isAvailable()) return { embedded: false, rebuilt: false };
      await qmd.update();
      if (options.embed) {
        await qmd.embed();
        return { embedded: true, rebuilt: true };
      }
      return { embedded: false, rebuilt: true };
    },
    async health() {
      const qmd = getQmd();
      let qmdAvailable = !!qmd?.isAvailable();
      if (!qmdAvailable && qmd) {
        try {
          qmdAvailable = await qmd.probe();
        } catch {
          qmdAvailable = false;
        }
      }

      return {
        backend: "qmd",
        status: qmdAvailable ? "ok" : "degraded",
        qmdAvailable,
      };
    },
    async inspect() {
      const qmd = getQmd();
      let qmdAvailable = !!qmd?.isAvailable();
      if (!qmdAvailable && qmd) {
        try {
          qmdAvailable = await qmd.probe();
        } catch {
          qmdAvailable = false;
        }
      }

      return {
        backend: "qmd",
        status: qmdAvailable ? "ok" : "degraded",
        available: qmdAvailable,
        indexPath: collectionDir,
        supportsIncrementalUpdate: true,
        message: qmd ? undefined : "Conversation index QMD runtime unavailable",
        metadata: {
          chunkCount: null,
          qmdAvailable,
          debugStatus: qmd?.debugStatus(),
        },
      };
    },
  };
}

function createFaissBackend(
  getFaiss: () => FaissConversationIndexAdapter | undefined,
): ConversationIndexBackend {
  return {
    kind: "faiss",
    async initialize() {
      const health = await failOpenFaissHealth(getFaiss());
      return health.status === "ok"
        ? {
            enabled: true,
            logLevel: "info",
            message: `Conversation index FAISS: available (status=${health.status})`,
          }
        : {
            enabled: true,
            logLevel: "warn",
            message: `Conversation index FAISS: degraded (${health.message ?? health.status})`,
          };
    },
    async search(query: string, maxResults: number) {
      return searchConversationIndexFaissFailOpen(getFaiss(), query, maxResults);
    },
    async update(chunks: ConversationChunk[], options: { embed: boolean; retentionCutoffMs?: number }) {
      await upsertConversationChunksFailOpen(getFaiss(), chunks, {
        retentionCutoffMs: options.retentionCutoffMs,
      });
      return { embedded: false };
    },
    async rebuild(chunks: ConversationChunk[], _options: { embed: boolean }) {
      const result = await rebuildConversationChunksFailOpen(getFaiss(), chunks);
      return {
        embedded: false,
        rebuilt: result.skipped !== true && result.rebuilt === chunks.length,
      };
    },
    async health() {
      const faiss = await failOpenFaissHealth(getFaiss());
      return {
        backend: "faiss",
        status: faiss.status === "ok" ? "ok" : "degraded",
        message: faiss.message,
        faiss,
      };
    },
    async inspect() {
      const adapter = getFaiss();
      if (!adapter) {
        return {
          backend: "faiss",
          status: "degraded",
          available: false,
          indexPath: "",
          supportsIncrementalUpdate: true,
          message: "Conversation index FAISS runtime unavailable",
          metadata: {
            chunkCount: 0,
            hasIndex: false,
            hasMetadata: false,
            hasManifest: false,
          },
        };
      }

      try {
        const inspection = await adapter.inspect();
        return {
          backend: "faiss",
          status: inspection.status === "ok" ? "ok" : "degraded",
          available: inspection.status === "ok",
          indexPath: inspection.indexPath,
          supportsIncrementalUpdate: true,
          message: inspection.message,
          metadata: {
            chunkCount: inspection.metadata.chunkCount,
            hasIndex: inspection.metadata.hasIndex,
            hasMetadata: inspection.metadata.hasMetadata,
            hasManifest: inspection.metadata.hasManifest,
            manifest: inspection.manifest,
          },
        };
      } catch (err) {
        const fallback = await failOpenFaissHealth(adapter);
        return {
          backend: "faiss",
          status: "degraded",
          available: false,
          indexPath: fallback.indexPath,
          supportsIncrementalUpdate: true,
          message: fallback.message ?? String(err),
          metadata: {
            chunkCount: fallback.manifest?.chunkCount ?? 0,
            hasIndex: false,
            hasMetadata: false,
            hasManifest: !!fallback.manifest,
            manifest: fallback.manifest,
          },
        };
      }
    },
  };
}
