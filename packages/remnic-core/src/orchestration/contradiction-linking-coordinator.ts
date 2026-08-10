/**
 * Contradiction-linking coordinator — extracted from the orchestrator (issue #1526).
 *
 * Owns the write-path semantic-analysis subsystem: contradiction detection
 * (QMD similarity search + LLM verification), deferred contradiction
 * auto-resolve (#1645 — retires superseded memories only after the new write's
 * tombstone status is known), and memory link suggestion. The orchestrator
 * constructs one instance and keeps thin delegating methods so existing call
 * sites (writeMemory fact-write branches) continue to work.
 *
 * Config, storage, search, namespace resolution, and the extraction engine are
 * accessed through getter callbacks (not captured at construction) so that
 * post-construction reassignment of the orchestrator's live fields is honored.
 * This mirrors the RecallRerankCoordinator / ConversationIndexCoordinator
 * accessor pattern.
 */

import type {
  MemoryFile,
  MemoryLink,
  PluginConfig,
  QmdSearchResult,
} from "../types.js";
import { coerceBool } from "../connectors/coerce.js";
// StorageManager type comes from the package barrel (type-only) so this
// module does not add a direct storage.ts import (ratchet #1533).
import type { StorageManager } from "../index.js";
import type { ExtractionEngine } from "../extraction.js";
import { log } from "../logger.js";
import { resolveIndexingCapabilities } from "../capabilities.js";
import { deindexMemoryAsync } from "../temporal-index.js";
import {
  inferLocalizationMemoryStatus,
  localizeUpdateCandidates,
  mergeMemorySnapshots,
} from "./update-localization.js";
import { propagateInvalidation } from "./dependency-propagation.js";

/** Result type of {@link ContradictionLinkingCoordinator.checkForContradiction}. */
export interface ContradictionResult {
  supersededId: string;
  confidence: number;
  reason: string;
  supersededPath: string;
  supersededCreated: string;
  supersededTags: string[];
}

/** Outcome of the post-write contradiction retirement attempt. */
export type ContradictionResolveOutcome =
  | "not_attempted"
  | "blocked"
  | "resolved"
  | "lost_race"
  | "supersede_failed"
  | "supersedes_clear_failed";

/**
 * Subset of {@link ContradictionResult} used by
 * {@link ContradictionLinkingCoordinator.applyDeferredContradictionResolve}.
 * The deferred resolve runs AFTER writeMemory and only needs the supersede
 * target fields (not confidence, which the caller already consumed).
 */
export interface ContradictionResolveTarget {
  supersededId: string;
  reason: string;
  supersededPath: string;
  supersededCreated: string;
  supersededTags: string[];
}

/**
 * Coordinator for the contradiction-detection + memory-linking subsystem.
 *
 * The three methods mirror the orchestrator's former private methods
 * `checkForContradiction`, `applyDeferredContradictionResolve`, and
 * `suggestLinksForMemory` byte-for-byte in logic.
 */
export class ContradictionLinkingCoordinator {
  private readonly getConfig: () => PluginConfig;
  private readonly isSearchAvailable: () => boolean;
  private readonly searchAcrossNamespaces: (options: {
    query: string;
    namespaces?: string[];
    maxResults?: number;
    mode?: "search" | "hybrid" | "bm25" | "vector";
  }) => Promise<QmdSearchResult[]>;
  private readonly extractMemoryIdsFromResults: (
    results: QmdSearchResult[],
  ) => string[];
  private readonly namespaceFromPath: (p: string) => string;
  private readonly storageForNamespace: (
    namespace: string,
  ) => Promise<StorageManager>;
  private readonly getExtraction: () => ExtractionEngine;

  constructor(options: {
    getConfig: () => PluginConfig;
    isSearchAvailable: () => boolean;
    searchAcrossNamespaces: (options: {
      query: string;
      namespaces?: string[];
      maxResults?: number;
      mode?: "search" | "hybrid" | "bm25" | "vector";
    }) => Promise<QmdSearchResult[]>;
    extractMemoryIdsFromResults: (results: QmdSearchResult[]) => string[];
    namespaceFromPath: (p: string) => string;
    storageForNamespace: (namespace: string) => Promise<StorageManager>;
    getExtraction: () => ExtractionEngine;
  }) {
    this.getConfig = options.getConfig;
    this.isSearchAvailable = options.isSearchAvailable;
    this.searchAcrossNamespaces = options.searchAcrossNamespaces;
    this.extractMemoryIdsFromResults = options.extractMemoryIdsFromResults;
    this.namespaceFromPath = options.namespaceFromPath;
    this.storageForNamespace = options.storageForNamespace;
    this.getExtraction = options.getExtraction;
  }

  /**
   * Check if a new memory contradicts an existing one.
   * Uses QMD to find similar memories, then LLM to verify contradiction.
   */
  async checkForContradiction(
    content: string,
    category: string,
    namespaceScope: string,
    anchor?: {
      entityRef?: string;
      structuredAttributes?: Record<string, string>;
      attributes?: Record<string, string>;
      storageSnapshot?: MemoryFile[];
    },
  ): Promise<ContradictionResult | null> {
    const config = this.getConfig();
    const localization = config.contradictionLocalization;
    const anchorEnabled = coerceBool(localization?.anchorEnabled) ?? true;
    if (!anchorEnabled) {
      if (!this.isSearchAvailable()) return null;
      const results = await this.searchAcrossNamespaces({
        query: content,
        namespaces: [namespaceScope],
        maxResults: 5,
        mode: "search",
      });
      for (const result of results) {
        if (result.score < config.contradictionSimilarityThreshold) continue;
        const memoryId = this.extractMemoryIdsFromResults([result])[0];
        if (!memoryId) continue;
        const resultNamespace = this.namespaceFromPath(result.path);
        if (resultNamespace !== namespaceScope) continue;
        const resultStorage = await this.storageForNamespace(resultNamespace);
        const existingMemory = await resultStorage.getMemoryById(memoryId);
        if (!existingMemory) continue;
        if (inferLocalizationMemoryStatus(existingMemory, resultStorage.dir) !== "active") continue;
        const verification = await this.getExtraction().verifyContradiction(
          { content, category },
          {
            id: existingMemory.frontmatter.id,
            content: existingMemory.content,
            category: existingMemory.frontmatter.category,
            created: existingMemory.frontmatter.created,
          },
        );
        if (!verification) continue;
        if (
          verification.isContradiction &&
          verification.confidence >= config.contradictionMinConfidence
        ) {
          if (verification.whichIsNewer === "first") {
            log.info(
              `detected contradiction (confidence: ${verification.confidence}): ${existingMemory.frontmatter.id} vs new memory — existing is newer, incoming fact is stale`,
            );
            continue;
          }
          log.info(
            `detected contradiction (confidence: ${verification.confidence}): ${existingMemory.frontmatter.id} vs new memory${config.contradictionAutoResolve ? " (auto-resolved)" : " (queued for manual review)"}`,
          );
          return {
            supersededId: existingMemory.frontmatter.id,
            confidence: verification.confidence,
            reason: verification.reasoning,
            supersededPath: existingMemory.path,
            supersededCreated: existingMemory.frontmatter.created,
            supersededTags: existingMemory.frontmatter.tags ?? [],
          };
        }
      }
      return null;
    }

    const localizationOptions = localization ?? {
      anchorEnabled: true,
      anchorCandidates: 5,
      searchCandidates: 5,
      maxCandidates: 8,
    };
    const resultStorage = await this.storageForNamespace(namespaceScope);
    let anchorSnapshot = anchor?.storageSnapshot;
    const anchorLimit = localizationOptions.anchorCandidates;
    if (
      !anchorSnapshot &&
      Number.isInteger(anchorLimit) &&
      anchorLimit > 0 &&
      typeof anchor?.entityRef === "string" &&
      anchor?.entityRef.trim().length > 0
    ) {
      const [hot, cold] = await Promise.all([
        resultStorage.readAllMemories(),
        typeof resultStorage.readAllColdMemories === "function"
          ? resultStorage.readAllColdMemories()
          : Promise.resolve([]),
      ]);
      anchorSnapshot = mergeMemorySnapshots(hot, cold, resultStorage.dir);
    }
    const anchorMemoryById = anchorSnapshot
      ? new Map(anchorSnapshot.map((memory) => [memory.frontmatter.id, memory]))
      : undefined;
    const candidates = await localizeUpdateCandidates(
      {
        storage: anchorSnapshot
          ? {
              dir: resultStorage.dir,
              readAllMemories: async () => anchorSnapshot ?? [],
              readAllColdMemories: async () => [],
            }
          : resultStorage,
        qmdSearch: async (query, limit) => {
          if (!this.isSearchAvailable()) {
            log.warn("[contradiction-linking] QMD unavailable; continuing with anchor candidates");
            return [];
          }
          const results = await this.searchAcrossNamespaces({
            query,
            namespaces: [namespaceScope],
            maxResults: limit,
            mode: "search",
          });
          const hits = [];
          for (const result of results) {
            if (result.score < config.contradictionSimilarityThreshold) continue;
            const memoryId = this.extractMemoryIdsFromResults([result])[0];
            if (!memoryId) continue;
            if (this.namespaceFromPath(result.path) !== namespaceScope) continue;
            const existingMemory =
              anchorMemoryById?.get(memoryId) ?? (await resultStorage.getMemoryById(memoryId));
            if (
              !existingMemory ||
              inferLocalizationMemoryStatus(existingMemory, resultStorage.dir) !== "active"
            ) continue;
            hits.push({
              id: memoryId,
              content: existingMemory.content,
              category: existingMemory.frontmatter.category,
              score: result.score,
            });
          }
          return hits;
        },
      },
      {
        entityRef: anchor?.entityRef,
        category,
        attributes: anchor?.structuredAttributes ?? anchor?.attributes,
      },
      content,
      localizationOptions,
    );

    for (const candidate of candidates) {
      const existingMemory =
        anchorMemoryById?.get(candidate.id) ?? (await resultStorage.getMemoryById(candidate.id));
      if (
        !existingMemory ||
        inferLocalizationMemoryStatus(existingMemory, resultStorage.dir) !== "active"
      ) continue;
      const verification = await this.getExtraction().verifyContradiction(
        { content, category },
        {
          id: existingMemory.frontmatter.id,
          content: existingMemory.content,
          category: existingMemory.frontmatter.category,
          created: existingMemory.frontmatter.created,
        },
      );
      if (!verification) continue;
      if (
        verification.isContradiction &&
        verification.confidence >= config.contradictionMinConfidence
      ) {
        if (verification.whichIsNewer === "first") {
          log.info(
            `detected contradiction (confidence: ${verification.confidence}): ${existingMemory.frontmatter.id} vs new memory — existing is newer, incoming fact is stale`,
          );
          continue;
        }
        log.info(
          `detected contradiction (confidence: ${verification.confidence}): ${existingMemory.frontmatter.id} vs new memory${config.contradictionAutoResolve ? " (auto-resolved)" : " (queued for manual review)"}`,
        );
        return {
          supersededId: existingMemory.frontmatter.id,
          confidence: verification.confidence,
          reason: verification.reasoning,
          supersededPath: existingMemory.path,
          supersededCreated: existingMemory.frontmatter.created,
          supersededTags: existingMemory.frontmatter.tags ?? [],
        };
      }
    }
    return null;
  }
  /**
   * #1645: Complete the deferred contradiction auto-resolve after writeMemory
   * returns and the new write's tombstone status is known. Retires the old
   * memory + deindexes it ONLY when the new write is genuinely active (not
   * tombstone-blocked / pending_review). A blocked write must not retire the
   * only active copy — deferring here closes the "contradictionAutoResolve
   * supersedes before tombstone status is known" defect class.
   */
  async applyDeferredContradictionResolve(
    contradiction: ContradictionResolveTarget | null | undefined,
    storage: StorageManager,
    newMemoryId: string,
    postWriteGuard: boolean,
  ): Promise<ContradictionResolveOutcome> {
    const config = this.getConfig();
    // #1645 yG2: clear the pre-write `supersedes` link from a blocked row so
    // it doesn't claim to supersede a still-active memory (best-effort).
    if (postWriteGuard && contradiction && config.contradictionAutoResolve) {
      try {
        const blockedRow = await storage.getMemoryById(newMemoryId);
        if (blockedRow?.frontmatter?.supersedes) {
          await storage.writeMemoryFrontmatter(blockedRow, { supersedes: undefined });
        }
      } catch (err) {
        log.warn(
          `contradiction auto-resolve supersedes clear failed for blocked ${newMemoryId}: ${err}`,
        );
      }
    }
    if (
      !contradiction ||
      !config.contradictionAutoResolve ||
      postWriteGuard
    ) {
      return postWriteGuard ? "blocked" : "not_attempted";
    }

    // Capture links before the primary supersession. The propagation hook is
    // orchestration-owned, so its own supersessions cannot recurse.
    let oldMemory: MemoryFile | null = null;
    if (coerceBool(config.dependencyPropagation?.enabled) === true) {
      try {
        const [hot, cold] = await Promise.all([
          typeof storage.readAllMemories === "function"
            ? storage.readAllMemories()
            : storage.getMemoryById(contradiction.supersededId).then((memory) =>
                memory ? [memory] : [],
              ),
          typeof storage.readAllColdMemories === "function"
            ? storage.readAllColdMemories()
            : Promise.resolve([]),
        ]);
        oldMemory = mergeMemorySnapshots(hot, cold, storage.dir).find(
          (memory) => memory.frontmatter.id === contradiction.supersededId,
        ) ?? null;
      } catch (err) {
        log.warn(`contradiction propagation snapshot failed for ${contradiction.supersededId}: ${err}`);
      }
    }
    try {
      const superseded = await storage.supersedeMemory(
        contradiction.supersededId,
        newMemoryId,
        contradiction.reason,
      );
      if (!superseded) {
        let mergedSnapshot: MemoryFile[];
        try {
          const [hot, cold] = await Promise.all([
            typeof storage.readAllMemories === "function"
              ? storage.readAllMemories()
              : Promise.all([
                  storage.getMemoryById(contradiction.supersededId),
                  storage.getMemoryById(newMemoryId),
                ]).then((memories) =>
                  memories.filter((memory): memory is MemoryFile => memory !== null),
                ),
            typeof storage.readAllColdMemories === "function"
              ? storage.readAllColdMemories()
              : Promise.resolve([]),
          ]);
          mergedSnapshot = mergeMemorySnapshots(hot, cold, storage.dir);
        } catch (err) {
          log.warn(
            `contradiction auto-resolve race check failed for ${contradiction.supersededId}: ${err}`,
          );
          return "supersede_failed";
        }
        const target = mergedSnapshot.find(
          (memory) => memory.frontmatter.id === contradiction.supersededId,
        );
        if (!target) return "supersede_failed";
        if (inferLocalizationMemoryStatus(target, storage.dir) === "active") {
          return "supersede_failed";
        }
        const losingMemory = mergedSnapshot.find(
          (memory) =>
            memory.frontmatter.id === newMemoryId &&
            inferLocalizationMemoryStatus(memory, storage.dir) === "active",
        );
        if (!losingMemory) return "supersede_failed";
        try {
          if (losingMemory.frontmatter.supersedes === contradiction.supersededId) {
            const cleared = await storage.writeMemoryFrontmatter(losingMemory, {
              supersedes: undefined,
            });
            if (cleared === false) return "supersedes_clear_failed";
          }
        } catch (err) {
          log.warn(
            `contradiction auto-resolve losing supersedes clear failed for ${newMemoryId}: ${err}`,
          );
          return "supersedes_clear_failed";
        }
        return "lost_race";
      }
      if (oldMemory) {
        try {
          await propagateInvalidation(
            {
              storage,
              extraction: this.getExtraction(),
              config,
            },
            {
              oldMemory,
              replacementId: newMemoryId,
              replacementContent: (await storage.getMemoryById(newMemoryId))?.content ?? null,
              cause: "contradiction",
              namespaceScope: this.namespaceFromPath(storage.dir),
            },
          );
        } catch (err) {
          log.warn(`contradiction dependency propagation failed for ${contradiction.supersededId}: ${err}`);
        }
      }

      if (
        resolveIndexingCapabilities(config).queryAwareIndexing &&
        contradiction.supersededPath
      ) {
        try {
          await deindexMemoryAsync(
            config.memoryDir,
            contradiction.supersededPath,
            contradiction.supersededCreated,
            contradiction.supersededTags,
          );
        } catch (err) {
          log.warn(
            `contradiction auto-resolve deindex failed for ${contradiction.supersededId}: ${err}`,
          );
        }
      }
      return "resolved";
    } catch (err) {
      log.warn(
        `contradiction auto-resolve supersede failed for ${contradiction.supersededId}: ${err}`,
      );
      return "supersede_failed";
    }
  }

  // ---------------------------------------------------------------------------
  // Memory Linking (Phase 3A)
  // ---------------------------------------------------------------------------

  /**
   * Suggest links for a new memory based on similar existing memories.
   */
  async suggestLinksForMemory(
    content: string,
    category: string,
    namespaceScope: string,
  ): Promise<MemoryLink[]> {
    if (!this.isSearchAvailable()) return [];

    // Search for related memories
    const results = await this.searchAcrossNamespaces({
      query: content,
      namespaces: [namespaceScope],
      maxResults: 5,
      mode: "search",
    });
    if (results.length === 0) return [];

    // Get full memory details for candidates
    const candidates: Array<{ id: string; content: string; category: string }> =
      [];
    for (const result of results) {
      const memoryId = this.extractMemoryIdsFromResults([result])[0];
      if (!memoryId) continue;

      const resultNamespace = this.namespaceFromPath(result.path);
      if (resultNamespace !== namespaceScope) continue;
      const resultStorage = await this.storageForNamespace(resultNamespace);
      const memory = await resultStorage.getMemoryById(memoryId);
      if (
        memory &&
        memory.frontmatter.status !== "superseded" &&
        memory.frontmatter.status !== "forgotten"
      ) {
        candidates.push({
          id: memory.frontmatter.id,
          content: memory.content,
          category: memory.frontmatter.category,
        });
      }
    }

    if (candidates.length === 0) return [];

    // Ask LLM for link suggestions
    const extraction = this.getExtraction();
    const suggestions = await extraction.suggestLinks(
      { content, category },
      candidates,
    );

    if (!suggestions || suggestions.links.length === 0) return [];

    // Convert to MemoryLink format
    return suggestions.links.map((link) => ({
      targetId: link.targetId,
      linkType: link.linkType,
      strength: link.strength,
      reason: link.reason || undefined,
    }));
  }
}
