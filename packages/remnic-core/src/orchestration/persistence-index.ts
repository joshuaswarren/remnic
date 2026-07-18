/**
 * Persistence-index coordinator — extracted from the orchestrator
 * (issue #1526, seam 23).
 *
 * Owns the post-persist bookkeeping that extraction-persist and
 * consolidation delegate back through the orchestrator:
 *   - content-hash dedup index add/has/remove/save
 *   - temporal-bounds backfill on dedup hits (bitemporal, #1578)
 *   - temporal tag index updates and persisted-memory indexing
 *   - graph edge construction for newly persisted memories
 *   - semantic dedup candidate lookup
 *
 * Behavior-preserving move from orchestrator.ts (late-binding deps rule,
 * seams 18–22).
 */

import path from "node:path";
import { type GraphConstructionCapabilitySet, resolveCapabilities, resolveGraphConstructionCapabilities, resolveIndexingCapabilities, resolveMemoryLifecycleCapabilities, resolveNamespaceCapabilities, resolveRecallEnhancementCapabilities } from "../capabilities.js";
import type { SemanticDedupHit } from "../dedup/semantic.js";
import { EmbeddingFallback } from "../embedding-fallback.js";
import { GraphIndex } from "../graph.js";
import { ContentHashIndex, StorageManager } from "../index.js";
import { log } from "../logger.js";
import { isActiveMemoryStatus } from "../memory-lifecycle-ledger-utils.js";
import { stripCitationForTemplate } from "../source-attribution.js";
import { clearIndexesAsync, indexMemoriesBatchAsync, indexesExistAsync } from "../temporal-index.js";
import { normalizeSupersessionKey } from "../temporal-supersession.js";
import type { MemoryFile, MemoryFrontmatter, PluginConfig } from "../types.js";
import {
  resolveRecentThreadMemoryPaths,
} from "../orchestrator.js";

export interface PersistenceIndexDeps {
  readonly config: PluginConfig;
  readonly contentHashIndex: ContentHashIndex | null;
  contentHashIndexForStorage(
    targetStorage: StorageManager,
  ): Promise<ContentHashIndex | null>;
  readonly contentHashIndexesByStorageDir: Map<string, ContentHashIndex>;
  readonly embeddingFallback: EmbeddingFallback;
  graphIndexFor(storage: StorageManager): GraphIndex;
  readAllMemoriesForNamespaces(
    namespaces: string[],
  ): Promise<MemoryFile[]>;
  semanticDedupScopeFor(targetStorage: StorageManager): {
    pathPrefix?: string;
    pathExcludePrefixes?: readonly string[];
  };
}

export class PersistenceIndexCoordinator {
  constructor(
    private readonly deps: PersistenceIndexDeps,
  ) {}

  async hasContentHashDedup(
    targetStorage: StorageManager,
    content: string,
  ): Promise<boolean> {
    const index = await this.deps.contentHashIndexForStorage(targetStorage);
    return index ? index.has(content) : false;
  }

  async addContentHashDedup(
    targetStorage: StorageManager,
    content: string,
  ): Promise<void> {
    const index = await this.deps.contentHashIndexForStorage(targetStorage);
    if (!index) return;
    index.add(content);
  }

  async removeContentHashForMemory(
    targetStorage: StorageManager,
    memory: MemoryFile,
    context: string,
  ): Promise<void> {
    const index = await this.deps.contentHashIndexForStorage(targetStorage);
    if (!index) return;

    if (memory.frontmatter.contentHash) {
      index.removeByHash(memory.frontmatter.contentHash);
      return;
    }

    log.warn(
      `[${context}] removing hash for legacy memory ${memory.frontmatter.id ?? "(unknown)"} via content fallback - no contentHash in frontmatter`,
    );
    index.remove(memory.content);
  }

  /**
   * Issue #1671 — backfill bi-temporal bounds onto an existing promoted/deduped
   * copy that was written BEFORE the source fact carried a resolved
   * `invalid_at`/`observedAt`/`eventTimeSource`.
   *
   * On re-extraction/backfill, a fact may now carry a resolved end bound (e.g.
   * "until June 2025") that the existing copy lacks because it was promoted
   * before bi-temporal wiring existed. Without this backfill, recall keeps
   * surfacing an expired fact even though the source copy now expires correctly.
   *
   * Finds the active fact in `targetStorage` matching `dedupContent`, then
   * patches the temporal frontmatter the existing copy is missing. Best-effort
   * / fail-open — any I/O error is logged and swallowed so the dedup
   * short-circuit is never blocked by a backfill failure.
   *
   * Matching: the stored `frontmatter.contentHash` is compared against
   * `ContentHashIndex.computeHash(dedupContent)` first (the exact hash the
   * content-hash index uses), then falls back to stripping citations and
   * comparing normalized bodies. This handles inline-attribution deployments
   * where the persisted body carries a citation marker the dedup key does not.
   *
   * I/O gate: only triggers when `invalidAt` is present (the end bound that
   * actually changes recall behavior by expiring the fact). `observedAt` and
   * `eventTimeSource` alone don'\''t expire a fact, so backfilling them without
   * an end bound would cause a full readAllMemories scan on every dedup hit
   * under biTemporal for no recall benefit.
   *
   * Only patches fields the existing copy LACKS — never overwrites a bound the
   * copy already carries.
   */
  async backfillTemporalBoundsOnDedupHit(
    targetStorage: StorageManager,
    dedupContent: string,
    bounds: {
      invalidAt?: string;
      // #1707 thread 2 — per-fact start bound (valid_at). Carried so a
      // re-extracted duplicate whose event time yields only a start bound
      // ("since 2024", "yesterday", an absolute date) gets the corrected
      // per-fact anchoring onto the existing copy.
      validFrom?: string;
      observedAt?: string;
      eventTimeSource?: "extracted" | "assumed";
    },
    entityRef?: string,
    sourceConnector?: string,
  ): Promise<void> {
    // I/O gate: scan when there is a recall-relevant bound to backfill —
    // either an end bound (invalidAt, which expires the fact) or a corrected
    // EXTRACTED start bound. A start bound only changes recall when it is
    // extracted (the as-of filter excludes facts whose valid_at is after the
    // as-of instant); an "assumed" validFrom is just the ingestion anchor
    // (resolveFactEventTime sets one for every fact), so scanning on it would
    // run a full readAllMemories on every bi-temporal dedup hit for no benefit
    // (review cursor PRRT_OvHk / codex PRRT_OvHxVH). observedAt and
    // eventTimeSource alone never change recall.
    const hasExtractedStart =
      bounds.validFrom !== undefined && bounds.eventTimeSource === "extracted";
    if (!bounds.invalidAt && !hasExtractedStart) return;
    try {
      const incomingHash = ContentHashIndex.computeHash(dedupContent);
      const normalizedIncoming = ContentHashIndex.normalizeContent(dedupContent);
      // Normalize the entity for same-entity scoping when provided — two
      // entities can share identical fact text, and patching a different
      // entity'\''s fact would corrupt its temporal bounds (cursor review).
      const incomingEntityNorm = entityRef
        ? normalizeSupersessionKey(entityRef)
        : undefined;
      const all = await targetStorage.readAllMemories();
      const existing = all.find((m) => {
        if (m.frontmatter.category !== "fact") return false;
        if ((m.frontmatter.status ?? "active") !== "active") return false;
        // Same-entity guard: reject only when the stored fact carries a
        // DIFFERENT entity (two entities can share identical fact text, so
        // patching the other entity's copy would corrupt its bounds — codex
        // P2 PRRT_OvB4A). Legacy facts written before entity linkage (no
        // entityRef) have no entity to conflict with, so they stay eligible
        // for backfill (cursor PRRT_OvKnV: the guard must NOT silently
        // no-op for older promoted copies that predate entity linkage).
        if (
          incomingEntityNorm &&
          m.frontmatter.entityRef &&
          normalizeSupersessionKey(m.frontmatter.entityRef) !== incomingEntityNorm
        ) {
          return false;
        }
        // Connector identity guard (review f1b89fe9, cursor #1852): exact
        // match on connector identity, including undefined. In the shared
        // namespace, multiple connectors can carry identical-content facts;
        // without this filter .find() selects the first hash/entity match.
        // Operator/no-connector backfill (sourceConnector undefined) may only
        // select a connectorless candidate, never a connector-tagged one;
        // connector-authenticated backfill only selects the same connector.
        const incomingConnector = sourceConnector?.trim() || undefined;
        const candidateConnector =
          m.frontmatter.sourceConnector?.trim() || undefined;
        if (incomingConnector !== candidateConnector) {
          return false;
        }
        // Prefer the stored contentHash (what the hash index actually keys
        // on) — it is computed from contentHashSource (the raw/enriched
        // body before citation), matching the dedupContent the caller passes.
        if (m.frontmatter.contentHash) {
          return m.frontmatter.contentHash === incomingHash;
        }
        // Legacy facts without a stored hash: strip citations then compare
        // normalized bodies so inline-attribution markers don'\''t prevent
        // a match.
        return (
          ContentHashIndex.normalizeContent(
            stripCitationForTemplate(m.content ?? "", this.deps.config.inlineSourceAttributionFormat),
          ) === normalizedIncoming
        );
      });
      if (!existing) return;
      // Build a patch containing ONLY the fields the existing copy lacks.
      const patch: Partial<MemoryFrontmatter> = {};
      const fm = existing.frontmatter;
      if (bounds.invalidAt && (!fm.invalid_at || fm.invalid_at.length === 0)) {
        patch.invalid_at = bounds.invalidAt;
      }
      if (bounds.observedAt && (!fm.observedAt || fm.observedAt.length === 0)) {
        patch.observedAt = bounds.observedAt;
      }
      if (
        bounds.eventTimeSource &&
        (!fm.eventTimeSource || fm.eventTimeSource.length === 0)
      ) {
        patch.eventTimeSource = bounds.eventTimeSource;
      }
      // #1707 thread 2 — per-fact-anchored start bound. A re-extracted
      // duplicate whose event time resolves a real start bound must carry
      // that anchor onto the existing copy so as-of recall uses the corrected
      // valid_at instead of a stale batch-anchored value. Only an EXTRACTED
      // bound corrects; an "assumed" bound is just the ingestion anchor.
      //
      // No-clobber via equality, not provenance inference: exact-content dedup
      // re-extracts the SAME event-time expression, which #1670 per-fact
      // anchoring resolves deterministically to the same validFrom — so for
      // stable content the incoming validFrom EQUALS the copy's valid_at and
      // we skip the redundant write (the only no-clobber that holds without a
      // fragile provenance heuristic — review codex PRRT_Ov7LKC). When they
      // differ (a prior batch/assumed anchor, end-only assumed start, or a
      // non-deterministic re-resolution), the extracted validFrom is the
      // authoritative correction and overwrites. The eventTimeSource upgrade
      // below records that the start is now extracted-anchored.
      if (
        bounds.validFrom &&
        bounds.eventTimeSource === "extracted" &&
        fm.valid_at !== bounds.validFrom
      ) {
        patch.valid_at = bounds.validFrom;
        // Mark the copy extracted-anchored in the SAME patch so its provenance
        // reflects the correction (review cursor PRRT_OvHM / codex PRRT_OvHxVD):
        // without this, a copy upgraded from "assumed" would keep "assumed"
        // provenance while carrying an extracted start. (The earlier
        // eventTimeSource block only fills an EMPTY source.)
        if (fm.eventTimeSource !== "extracted") {
          patch.eventTimeSource = "extracted";
        }
      }
      if (Object.keys(patch).length === 0) return;
      const ok = await targetStorage.writeMemoryFrontmatter(existing, patch);
      if (ok) {
        log.debug(
          `bitemporal-backfill: patched ${Object.keys(patch).join(",")} onto existing fact ${fm.id ?? "(unknown)"} in ${targetStorage.dir}`,
        );
      }
    } catch (err) {
      log.warn(
        `bitemporal-backfill: failed open for ${targetStorage.dir}: ${err}`,
      );
    }
  }

  /**
   * Persist the touched content-hash indexes via the removal-aware, lock-held
   * RECONCILING save (issue #1909 review round 8 thread 3). Both append batches
   * (extraction persist) and removal batches (archival / semantic consolidation)
   * go through the SAME operation so they serialize against each other on the
   * per-file lock: each reconciles `(on-disk \ removed) ∪ additions`, so a
   * removal never resurrects a hash (a plain union would) and never clobbers a
   * concurrent extraction's appended hash (a blind overwrite would). Untouched
   * indexes dirty-short-circuit and are skipped entirely (finding 3).
   */
  async saveContentHashIndexes(): Promise<void> {
    const indexes = new Set<ContentHashIndex>();
    if (this.deps.contentHashIndex) indexes.add(this.deps.contentHashIndex);
    for (const index of this.deps.contentHashIndexesByStorageDir.values()) {
      indexes.add(index);
    }
    for (const index of indexes) {
      await index.saveMergingWithDisk();
    }
  }

  async indexPersistedMemory(
    storage: StorageManager,
    memoryId: string,
  ): Promise<void> {
    if (!resolveMemoryLifecycleCapabilities(this.deps.config).embeddingFallback) return;
    if (!(await this.deps.embeddingFallback.isAvailable())) return;
    const memory = await storage.getMemoryById(memoryId);
    if (!memory) return;
    await this.deps.embeddingFallback.indexFile(
      memoryId,
      memory.content,
      memory.path,
    );
  }

  /**
   * Build a graph edge for a persisted memory (v8.2).
   * Shared helper used by both the chunked and non-chunked write paths to avoid duplication.
   * Fail-open: caller wraps in try/catch.
   */
  async buildGraphEdge(
    storage: StorageManager,
    memoryRelPath: string,
    entityRef: string | undefined,
    memoryId: string,
    factContent: string,
    allMemsForGraph: import("../types.js").MemoryFile[] | null | undefined,
    memoryPathById: Map<string, string>,
    threadIdForEdge: string | undefined,
    threadEpisodeIdsForGraph: string[] | undefined,
    fallbackCausalPredecessor: string | undefined,
    graphCaps: GraphConstructionCapabilitySet = resolveGraphConstructionCapabilities(this.deps.config),
  ): Promise<void> {
    // Entity siblings: other memories sharing the same entityRef
    const entitySiblings: string[] = [];
    if (entityRef) {
      try {
        const allMems = allMemsForGraph ?? [];
        for (const m of allMems) {
          if (m.frontmatter.entityRef === entityRef) {
            const rel = path.relative(storage.dir, m.path);
            if (rel !== memoryRelPath) entitySiblings.push(rel);
          }
        }
      } catch {
        /* fail-open */
      }
    }
    // Recent thread memories for time graph
    const recentInThread: string[] = [];
    if (threadIdForEdge && threadEpisodeIdsForGraph?.length) {
      try {
        recentInThread.push(
          ...resolveRecentThreadMemoryPaths({
            threadEpisodeIds: threadEpisodeIdsForGraph,
            currentMemoryId: memoryId,
            allMemsForGraph,
            pathById: memoryPathById,
            storageDir: storage.dir,
            maxRecent: 3,
          }),
        );
      } catch {
        /* fail-open */
      }
    }
    if (
      recentInThread.length === 0 &&
      graphCaps.graphWriteSessionAdjacency &&
      fallbackCausalPredecessor &&
      fallbackCausalPredecessor !== memoryRelPath
    ) {
      recentInThread.push(fallbackCausalPredecessor);
    }
    const causalPredecessor =
      recentInThread[recentInThread.length - 1] ?? fallbackCausalPredecessor;
    await this.deps.graphIndexFor(storage).onMemoryWritten({
      memoryPath: memoryRelPath,
      entityRef,
      content: factContent,
      created: new Date().toISOString(),
      threadId: threadIdForEdge,
      recentInThread,
      entitySiblings,
      causalPredecessor,
      graphCapsOverride: {
        entityGraph: graphCaps.entityGraph,
        timeGraph: graphCaps.timeGraph,
        causalGraph: graphCaps.causalGraph,
        multiGraphMemory: graphCaps.multiGraphMemory,
      },
    });
  }

  /**
   * Batch-update temporal and tag indexes after extraction (v8.1).
   * Reads each persisted memory's path + frontmatter and adds them to
   * state/index_time.json and state/index_tags.json.
   * Fail-open: any error is logged but does not abort extraction.
   */
  async updateTemporalTagIndexes(
    storage: StorageManager,
    persistedIds: string[],
  ): Promise<void> {
    const caps = resolveCapabilities(this.deps.config); // #1566 Cluster C
    // Build temporal/tag indexes whenever either consumer is enabled:
    // - queryAwareIndexingEnabled: uses indexes for query-aware prefiltering in recall
    // - parallelRetrievalEnabled: temporal agent reads index_time.json for date-range lookup
    // Enabling only parallelRetrievalEnabled without queryAwareIndexingEnabled would silently
    // produce an empty temporal index, leaving the temporal agent with no data to work from.
    if (
      !resolveIndexingCapabilities(this.deps.config).queryAwareIndexing &&
      !caps.parallelRetrieval &&
      !resolveRecallEnhancementCapabilities(this.deps.config).eventOrderRecall
    )
      return;
    // Check for missing indexes BEFORE the early-return so first-time enablement
    // can bootstrap the full corpus even when this extraction turn persisted nothing.
    const needsFullRebuild = !(await indexesExistAsync(this.deps.config.memoryDir));
    if (!needsFullRebuild && persistedIds.length === 0) return;
    try {
      // Read the corpus once to avoid N separate full-corpus scans.
      // On full rebuild with namespaces enabled, span all configured namespaces so
      // memories written to other namespaces before the index existed are also captured.
      const allMemories =
        needsFullRebuild && resolveNamespaceCapabilities(this.deps.config).namespaces
          ? await this.deps.readAllMemoriesForNamespaces(
              Array.from(
                new Set<string>([
                  this.deps.config.defaultNamespace,
                  this.deps.config.sharedNamespace,
                  ...this.deps.config.namespacePolicies.map((p) => p.name),
                ]),
              ),
            )
          : await storage.readAllMemories();

      // Bootstrap: index only active (non-archived, non-superseded) memories.
      // Incremental: index only the newly persisted IDs.
      const pool = needsFullRebuild
        ? allMemories.filter((m) => isActiveMemoryStatus(m.frontmatter.status))
        : (() => {
            const idSet = new Set(persistedIds);
            return allMemories.filter((m) => idSet.has(m.frontmatter.id));
          })();

      const entries: Array<{
        path: string;
        createdAt: string;
        tags: string[];
        validAt?: string;
        observedAt?: string;
        sessionKey?: string;
        validUntil?: string;
        searchText?: string;
      }> = [];
      for (const mem of pool) {
        if (mem.path && mem.frontmatter?.created) {
          entries.push({
            path: mem.path,
            createdAt: mem.frontmatter.created,
            tags: mem.frontmatter.tags ?? [],
            ...(mem.frontmatter.valid_at ? { validAt: mem.frontmatter.valid_at } : {}),
            ...(mem.frontmatter.observedAt ? { observedAt: mem.frontmatter.observedAt } : {}),
            ...(mem.frontmatter.sources?.[0]?.sessionKey
              ? { sessionKey: mem.frontmatter.sources[0].sessionKey }
              : {}),
            ...(mem.frontmatter.invalid_at ? { validUntil: mem.frontmatter.invalid_at } : {}),
            searchText: `${mem.content} ${(mem.frontmatter.tags ?? []).join(" ")} ${mem.frontmatter.entityRef ?? ""}`,
          });
        }
      }
      if (needsFullRebuild) {
        // Always write empty indexes on full rebuild — even when the active pool
        // is empty (e.g. store contains only archived/superseded entries).
        // This marks bootstrap completion so indexesExistAsync() returns true and
        // subsequent extractions skip the full-corpus scan.
        await clearIndexesAsync(this.deps.config.memoryDir);
        if (entries.length > 0) {
          await indexMemoriesBatchAsync(this.deps.config.memoryDir, entries);
        }
        log.info(
          `temporal-index: bootstrapped from ${entries.length} active memories`,
        );
      } else if (entries.length > 0) {
        await indexMemoriesBatchAsync(this.deps.config.memoryDir, entries);
      }
    } catch (err) {
      log.debug(`temporal-index update failed (non-fatal): ${err}`);
    }
  }

  /**
   * Issue #373 — nearest-neighbor lookup for the write-time semantic dedup
   * guard. Returns the top-K embedding hits against the currently indexed
   * memories, or an empty array when the embedding backend is unavailable.
   * Intentionally does NOT throw; `decideSemanticDedup` treats both "empty"
   * and "error" outcomes as fail-open (keep the candidate).
   *
   * PR #399 P1 fix: when namespaces are enabled the lookup must be scoped
   * to the SAME namespace as the fact being written. Otherwise a
   * high-similarity memory from another namespace can suppress a write in
   * the target namespace — cross-tenant data loss. Callers pass the target
   * storage so we can translate its root directory into the correct index
   * path prefix (and, for the legacy default-namespace layout at
   * `memoryDir` root, an exclusion list for `namespaces/*`).
   */
  async semanticDedupLookup(
    content: string,
    limit: number,
    targetStorage: StorageManager,
  ): Promise<SemanticDedupHit[]> {
    // Round 6 fix (Finding 3): backend-unavailable conditions must THROW so
    // that `decideSemanticDedup`'s catch block can return
    // reason="backend_unavailable".  Previously all error/unavailable paths
    // returned [] — causing decideSemanticDedup to always report
    // reason="no_candidates" even when the provider was actually down.
    //
    // Contract after this fix:
    //   • embeddingFallbackEnabled=false  → throw (feature not configured;
    //     caller treats this as backend_unavailable and fails open).
    //   • isAvailable() returns false     → throw (provider is reachable but
    //     reports itself unavailable; distinct from empty index).
    //   • search() throws                 → re-throw (network/provider error).
    //   • search() returns []             → return [] (empty index, not a
    //     backend failure; decideSemanticDedup reports no_candidates).
    if (!resolveMemoryLifecycleCapabilities(this.deps.config).embeddingFallback) {
      throw new Error("semantic dedup: embedding backend not configured");
    }
    if (!(await this.deps.embeddingFallback.isAvailable())) {
      log.debug("semantic dedup: embedding backend unavailable, skipping");
      throw new Error("semantic dedup: embedding backend unavailable");
    }
    // search() may throw — let it propagate so decideSemanticDedup catches it
    // and returns reason="backend_unavailable". Pass throwOnTimeout:true so
    // EmbeddingTimeoutError is re-thrown here (Round 10 fix, Ui1J+Ui1L: the
    // recall-path caller searchEmbeddingFallback does NOT pass this flag,
    // keeping its fail-open [] contract on timeout).
    const scope = this.deps.semanticDedupScopeFor(targetStorage);
    const hits = await this.deps.embeddingFallback.search(content, limit, { ...scope, throwOnTimeout: true });
    if (!Array.isArray(hits) || hits.length === 0) return [];
    // PR #1852 review finding on 7e0eb1a0: attach each neighbor's
    // sourceConnector so decideSemanticDedup can apply the connector-aware
    // skip gate. Reads are bounded by `limit` (default 5) and best-effort:
    // a read failure leaves the connector absent, which the decision
    // function treats as "must not suppress a provenance-bearing write".
    const enriched: SemanticDedupHit[] = await Promise.all(
      hits.map(async (hit) => {
        let sourceConnector: string | undefined;
        try {
          const memory = await targetStorage.getMemoryById(hit.id);
          sourceConnector =
            typeof memory?.frontmatter.sourceConnector === "string"
              ? memory.frontmatter.sourceConnector.trim() || undefined
              : undefined;
        } catch {
          sourceConnector = undefined;
        }
        return {
          id: hit.id,
          score: hit.score,
          path: hit.path,
          ...(sourceConnector !== undefined ? { sourceConnector } : {}),
        };
      }),
    );
    return enriched;
  }
}
