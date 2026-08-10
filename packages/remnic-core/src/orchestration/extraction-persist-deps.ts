import type { ContradictionResolveOutcome } from "./contradiction-linking-coordinator.js";
import type { GraphConstructionCapabilitySet } from "../capabilities.js";
import type { SemanticDedupHit } from "../dedup/semantic.js";
import type { EmbeddingFallback } from "../embedding-fallback.js";
import type { FaithfulnessGateCounters } from "../extraction-faithfulness.js";
import type { ExtractionEngine } from "../extraction.js";
import type { JudgeVerdict } from "../extraction-judge.js";
import type { StorageManager } from "../index.js";
import type { LocalLlmClient } from "../local-llm.js";
import type { NamespaceStorageRouter } from "../namespaces/storage.js";
import type { RouteRule, RoutingEngineOptions } from "../routing/engine.js";
import type { SearchBackend } from "../search/port.js";
import type { ThreadingManager } from "../threading.js";
import type { MemoryFile, MemoryLink, PluginConfig } from "../types.js";

export interface ExtractionPersistDeps {
  config: PluginConfig;
  getStorageRouter: () => NamespaceStorageRouter;
  getThreading: () => ThreadingManager;
  getExtraction: () => ExtractionEngine;
  getLocalLlm: () => LocalLlmClient;
  getQmd: () => SearchBackend;
  getJudgeVerdictCache: () => Map<string, JudgeVerdict>;
  getJudgeDeferCounts: () => Map<string, number>;
  getFaithfulnessCounters: () => FaithfulnessGateCounters;
  getEmbeddingFallback: () => EmbeddingFallback;
  setLastPersistExtractionDeferredCount: (value: number) => void;
  setLastPersistExtractionPendingReviewIds: (ids: string[]) => void;
  addContentHashDedup: (targetStorage: StorageManager, content: string) => Promise<void>;
  hasContentHashDedup: (targetStorage: StorageManager, content: string) => Promise<boolean>;
  backfillTemporalBoundsOnDedupHit: (
    targetStorage: StorageManager,
    dedupContent: string,
    bounds: {
      invalidAt?: string;
      validFrom?: string;
      observedAt?: string;
      eventTimeSource?: "extracted" | "assumed";
    },
    entityRef?: string,
    sourceConnector?: string
  ) => Promise<void>;
  saveContentHashIndexes: () => Promise<void>;
  artifactTypeForCategory: (
    category: string
  ) => "decision" | "constraint" | "todo" | "definition" | "commitment" | "correction" | "fact";
  loadRoutingRules: () => Promise<RouteRule[]>;
  routeEngineOptions: () => RoutingEngineOptions;
  semanticDedupLookup: (content: string, limit: number, targetStorage: StorageManager) => Promise<SemanticDedupHit[]>;
  checkForContradiction: (
    content: string,
    category: string,
    namespaceScope: string,
    anchor?: {
      entityRef?: string;
      structuredAttributes?: Record<string, string>;
      storageSnapshot?: MemoryFile[];
    }
  ) => Promise<{
    supersededId: string;
    confidence: number;
    reason: string;
    supersededPath: string;
    supersededCreated: string;
    supersededTags: string[];
  } | null>;
  applyDeferredContradictionResolve: (
    contradiction:
      | {
          supersededId: string;
          reason: string;
          supersededPath: string;
          supersededCreated: string;
          supersededTags: string[];
        }
      | null
      | undefined,
    storage: StorageManager,
    newMemoryId: string,
    postWriteGuard: boolean
  ) => Promise<ContradictionResolveOutcome>;
  suggestLinksForMemory: (content: string, category: string, namespaceScope: string) => Promise<MemoryLink[]>;
  storageDirNamespace: (storageDir: string) => string;
  indexPersistedMemory: (storage: StorageManager, memoryId: string) => Promise<void>;
  buildGraphEdge: (
    storage: StorageManager,
    memoryRelPath: string,
    entityRef: string | undefined,
    memoryId: string,
    factContent: string,
    allMemsForGraph: MemoryFile[] | null | undefined,
    memoryPathById: Map<string, string>,
    threadIdForEdge: string | undefined,
    threadEpisodeIdsForGraph: string[] | undefined,
    fallbackCausalPredecessor: string | undefined,
    graphCaps?: GraphConstructionCapabilitySet
  ) => Promise<void>;
  updateTemporalTagIndexes: (storage: StorageManager, persistedIds: string[]) => Promise<void>;
}
