/**
 * Lifecycle-policy coordinator — extracted from the orchestrator
 * (issue #1526, seam 6).
 *
 * Owns the deterministic memory-lifecycle pipeline: heat/decay scoring
 * (`runLifecyclePolicyPass`), fact archival (`runFactArchival`),
 * summarization (`runSummarization`), and topic extraction
 * (`runTopicExtraction`). Also owns the action-outcome prior builder
 * (`buildLifecycleActionPriors` / `actionOutcomePriorDelta`) that feeds
 * the lifecycle transition decider.
 *
 * The orchestrator constructs one instance and delegates the internal
 * entrypoints to it. The public wrapper (`runLifecyclePolicyNow`)
 * remains on the orchestrator as a thin pass-through. Storage is the
 * orchestrator's stable `this.storage` (or a per-namespace override
 * passed via options); the extraction engine, embedding-fallback, and
 * content-hash callbacks arrive as deps so the orchestrator keeps
 * ownership of gateway routing and cross-subsystem persistence.
 *
 * Behavior-preserving move from orchestrator.ts. No logic changes — the
 * orchestrator keeps thin delegating methods so existing call sites
 * and tests that exercise the public API continue to work.
 */

import {
  decideLifecycleTransition,
  resolveLifecycleState,
  type LifecycleSignals,
} from "../lifecycle.js";
import type { LifecycleState } from "../types.js";
import {
  resolveIndexingCapabilities,
  resolveMemoryLifecycleCapabilities,
  resolveCreationMemoryCapabilities,
} from "../capabilities.js";
import { isActiveMemoryStatus } from "../memory-lifecycle-ledger-utils.js";
import { deindexMemoriesBatchAsync } from "../temporal-index-batch.js";
import { extractTopics } from "../topics.js";
import { log } from "../logger.js";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { StorageManager } from "../index.js";
import type { ExtractionEngine } from "../extraction.js";
import type { EmbeddingFallback } from "../embedding-fallback.js";
import type {
  PluginConfig,
  MemoryFile,
  MemoryActionEvent,
  MemorySummary,
} from "../types.js";
import { excludeSupportPassportPrivateMemories } from "../support-passport/card-projection.js";
import { runSeedGraduationPass } from "../lifecycle/seed-graduation.js";
import type { RecallHandleHistoryStore } from "../recall-state.js";

/** Dependencies injected by the orchestrator. All stable references or
 *  live accessors. */
export interface LifecyclePolicyCoordinatorDeps {
  config: PluginConfig;
  /** Live accessor: the orchestrator's storage manager (stable post-ctor). */
  getStorage: () => StorageManager;
  /** The extraction engine — used for summarization. */
  extraction: ExtractionEngine;
  /** The embedding-fallback manager used for index cleanup on archival. */
  embeddingFallback: EmbeddingFallback;
  /** Effective lifecycle thresholds (promote/stale/archive). Delegated to
   *  the orchestrator which owns runtime-policy-values overlay. */
  getEffectiveLifecycleThresholds: () => {
    promoteHeatThreshold: number;
    staleDecayThreshold: number;
    archiveDecayThreshold: number;
  };
  /** Remove a memory's content-hash entry from the storage-scoped index.
   *  Delegated to the orchestrator which owns the per-storage index map. */
  removeContentHashForMemory: (
    targetStorage: StorageManager,
    memory: MemoryFile,
    context: string,
  ) => Promise<void>;
  /** Persist all dirty content-hash indexes to disk. */
  saveContentHashIndexes: () => Promise<void>;
  /** Recall-handle ring used to suppress quoted-back echo during seed graduation. */
  getHandleHistory?: () => RecallHandleHistoryStore;
}

/**
 * Coordinates the memory-lifecycle policy pipeline. Holds no mutable
 * state of its own — all persistence flows through the injected storage
 * managers and callbacks.
 */
export class LifecyclePolicyCoordinator {
  constructor(
    private readonly deps: LifecyclePolicyCoordinatorDeps,
  ) {}

  private get config(): PluginConfig {
    return this.deps.config;
  }

  // -------------------------------------------------------------------------
  // Action-outcome priors (feeds lifecycle transition decisions)
  // -------------------------------------------------------------------------

  actionOutcomePriorDelta(event: MemoryActionEvent): number {
    if (event.outcome === "failed") return -0.3;
    if (event.policyDecision === "deny") return -0.22;
    if (event.policyDecision === "defer") return -0.14;
    if (event.outcome === "skipped") return -0.1;

    if (event.outcome !== "applied") return 0;
    switch (event.action) {
      case "store_episode":
      case "store_note":
      case "update_note":
        return 0.08;
      case "create_artifact":
      case "summarize_node":
      case "link_graph":
        return 0.04;
      case "discard":
        return -0.03;
      default:
        return 0;
    }
  }

  async buildLifecycleActionPriors(
    storage: StorageManager = this.deps.getStorage(),
  ): Promise<Map<string, number>> {
    const events = await storage.readMemoryActionEvents(1200);
    if (events.length === 0) return new Map<string, number>();

    const nowMs = Date.now();
    const windowMs = 14 * 24 * 60 * 60 * 1000;
    const byMemory = new Map<
      string,
      Array<{ weightedDelta: number; weight: number }>
    >();

    for (const event of events) {
      if (
        typeof event.memoryId !== "string" ||
        event.memoryId.trim().length === 0
      )
        continue;
      const ts = Date.parse(event.timestamp);
      if (!Number.isFinite(ts)) continue;
      const ageMs = nowMs - ts;
      if (ageMs < 0 || ageMs > windowMs) continue;

      const delta = this.actionOutcomePriorDelta(event);
      if (delta === 0) continue;

      const recencyWeight = Math.max(0.2, 1 - ageMs / windowMs);
      const list = byMemory.get(event.memoryId) ?? [];
      if (list.length >= 8) list.shift();
      list.push({
        weightedDelta: delta * recencyWeight,
        weight: recencyWeight,
      });
      byMemory.set(event.memoryId, list);
    }

    const out = new Map<string, number>();
    for (const [memoryId, deltas] of byMemory.entries()) {
      if (deltas.length === 0) continue;
      const weightedSum = deltas.reduce(
        (sum, item) => sum + item.weightedDelta,
        0,
      );
      const weightTotal = deltas.reduce((sum, item) => sum + item.weight, 0);
      if (weightTotal <= 0) continue;
      const score = weightedSum / weightTotal;
      out.set(memoryId, Math.max(-0.25, Math.min(0.15, score)));
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Lifecycle policy pass (heat/decay scoring + transition)
  // -------------------------------------------------------------------------

  async runLifecyclePolicyPass(
    allMemories: MemoryFile[],
    storage: StorageManager = this.deps.getStorage(),
  ): Promise<number> {
    const now = new Date();
    const nowIso = now.toISOString();
    const countsByState: Record<LifecycleState, number> = {
      candidate: 0,
      validated: 0,
      active: 0,
      stale: 0,
      archived: 0,
    };
    const transitionCounts: Record<string, number> = {};
    let updatedCount = 0;
    let disputedCount = 0;
    let evaluatedCount = 0;
    const lifecycleCaps = resolveMemoryLifecycleCapabilities(this.config);

    const thresholds = this.deps.getEffectiveLifecycleThresholds();
    const policy = {
      promoteHeatThreshold: thresholds.promoteHeatThreshold,
      staleDecayThreshold: thresholds.staleDecayThreshold,
      archiveDecayThreshold: thresholds.archiveDecayThreshold,
      protectedCategories: this.config.lifecycleProtectedCategories,
    };
    const actionPriors = await this.buildLifecycleActionPriors(storage);

    for (const memory of excludeSupportPassportPrivateMemories(allMemories)) {
      if (
        memory.frontmatter.status === "superseded" ||
        memory.frontmatter.status === "forgotten"
      ) {
        continue;
      }
      evaluatedCount += 1;
      const currentState = resolveLifecycleState(memory.frontmatter);
      const actionPriorScore = actionPriors.get(memory.frontmatter.id);
      const signals: LifecycleSignals | undefined =
        typeof actionPriorScore === "number" &&
        Number.isFinite(actionPriorScore)
          ? { actionPriorScore }
          : undefined;
      const decision = decideLifecycleTransition(memory, policy, now, signals);
      const nextState: LifecycleState =
        memory.frontmatter.status === "archived"
          ? "archived"
          : decision.nextState;

      countsByState[nextState] += 1;
      if (memory.frontmatter.verificationState === "disputed") {
        disputedCount += 1;
      }
      if (nextState !== currentState) {
        const key = `${currentState}->${nextState}`;
        transitionCounts[key] = (transitionCounts[key] ?? 0) + 1;
      }

      const prevHeat = memory.frontmatter.heatScore;
      const prevDecay = memory.frontmatter.decayScore;
      const scoreDelta =
        Math.abs((prevHeat ?? -1) - decision.heatScore) +
        Math.abs((prevDecay ?? -1) - decision.decayScore);
      const shouldPersist =
        memory.frontmatter.lifecycleState !== nextState ||
        memory.frontmatter.heatScore === undefined ||
        memory.frontmatter.decayScore === undefined ||
        memory.frontmatter.lastValidatedAt === undefined ||
        scoreDelta >= 0.01;

      if (!shouldPersist) continue;

      const wrote = await storage.writeMemoryFrontmatter(memory, {
        lifecycleState: nextState,
        heatScore: decision.heatScore,
        decayScore: decision.decayScore,
        lastValidatedAt: nowIso,
      });
      if (wrote) updatedCount += 1;
    }

    const history = this.deps.getHandleHistory?.();
    await runSeedGraduationPass({
      memories: allMemories,
      storage,
      config: this.config.seedGraduation,
      recalledBySession: history ? (sessionKey) => history.recent(sessionKey) : undefined,
    });

    // Report how many memories had frontmatter rewritten so callers can record a
    // catalog write touch for lifecycle-only passes (codex NR-tS).
    if (!lifecycleCaps.lifecycleMetrics) return updatedCount;

    const total = evaluatedCount;
    const metrics = {
      generatedAt: nowIso,
      memoriesEvaluated: total,
      memoriesUpdated: updatedCount,
      countsByLifecycleState: countsByState,
      transitionCounts,
      staleRatio: total > 0 ? countsByState.stale / total : 0,
      disputedRatio: total > 0 ? disputedCount / total : 0,
      policy: {
        promoteHeatThreshold: thresholds.promoteHeatThreshold,
        staleDecayThreshold: thresholds.staleDecayThreshold,
        archiveDecayThreshold: thresholds.archiveDecayThreshold,
        protectedCategories: this.config.lifecycleProtectedCategories,
      },
    };
    const metricsPath = path.join(
      storage.dir,
      "state",
      "lifecycle-metrics.json",
    );
    await mkdir(path.dirname(metricsPath), { recursive: true });
    await writeFile(metricsPath, JSON.stringify(metrics, null, 2), "utf-8");
    return updatedCount;
  }

  // -------------------------------------------------------------------------
  // Fact archival
  // -------------------------------------------------------------------------

  /**
   * Archive old, low-importance, rarely-accessed facts (v6.0).
   * Moves eligible facts from facts/ to archive/YYYY-MM-DD/.
   * Returns the number of archived facts.
   */
  async runFactArchival(
    allMemories: MemoryFile[],
  ): Promise<number> {
    const storage = this.deps.getStorage();
    const now = Date.now();
    const ageCutoffMs = this.config.factArchivalAgeDays * 24 * 60 * 60 * 1000;
    const protectedCategories = new Set(
      this.config.factArchivalProtectedCategories,
    );
    let archivedCount = 0;
    // Collect deindex entries and remove them in one batch rather than a full
    // index read-modify-write per archived fact. Guard is preserved: entries are
    // only collected when queryAwareIndexing is enabled. The flush runs in
    // `finally` so facts already archived on disk are still de-indexed if a later
    // iteration throws; it runs exactly once and any loop error propagates after.
    const deindexBatch: Array<{ path: string; createdAt: string; tags: string[] }> = [];

    try {
      for (const memory of allMemories) {
        const fm = memory.frontmatter;

        // Skip already-archived or superseded
        if (fm.status && fm.status !== "active") continue;

        // Skip protected categories
        if (protectedCategories.has(fm.category)) continue;

        // Skip corrections (always keep)
        if (fm.category === "correction") continue;

        // Check age requirement
        const createdMs = new Date(fm.created).getTime();
        if (now - createdMs < ageCutoffMs) continue;

        // Check importance (only archive low-importance facts)
        const importanceScore = fm.importance?.score ?? 0.5;
        if (importanceScore >= this.config.factArchivalMaxImportance) continue;

        // Check access count
        const accessCount = fm.accessCount ?? 0;
        if (accessCount > this.config.factArchivalMaxAccessCount) continue;

        // All criteria met — archive
        const result = await storage.archiveMemory(memory);
        if (result) {
          // Queue de-indexing immediately after a successful archive, before
          // the secondary content-hash / embedding cleanup can throw. A fact
          // archived on disk must always be de-indexed; the finally-flush then
          // removes every queued fact even if a later step throws.
          if (
            resolveIndexingCapabilities(this.config).queryAwareIndexing &&
            memory.path &&
            memory.frontmatter?.created
          ) {
            deindexBatch.push({
              path: memory.path,
              createdAt: memory.frontmatter.created,
              tags: memory.frontmatter.tags ?? [],
            });
          }
          // Remove from the same storage-scoped content-hash index since it is
          // no longer in hot search.
          await this.deps.removeContentHashForMemory(
            storage,
            memory,
            "fact-archival",
          );
          await this.deps.embeddingFallback.removeFromIndex(memory.frontmatter.id);
          archivedCount++;
        }
      }
    } finally {
      if (deindexBatch.length > 0) {
        await deindexMemoriesBatchAsync(this.config.memoryDir, deindexBatch);
      }
    }

    // Save hash indexes if we removed any entries.
    if (archivedCount > 0) {
      await this.deps.saveContentHashIndexes().catch((err) =>
        log.warn(`content-hash index save failed during archival: ${err}`),
      );
    }

    return archivedCount;
  }

  // -------------------------------------------------------------------------
  // Summarization (Phase 4A)
  // -------------------------------------------------------------------------

  /**
   * Run memory summarization if memory count exceeds threshold (Phase 4A).
   */
  async runSummarization(
    allMemories: MemoryFile[],
  ): Promise<void> {
    const storage = this.deps.getStorage();
    // Only active memories count toward the threshold
    const activeMemories = allMemories.filter(
      (m) => isActiveMemoryStatus(m.frontmatter.status),
    );

    if (activeMemories.length < this.config.summarizationTriggerCount) {
      return;
    }

    log.info(
      `memory count (${activeMemories.length}) exceeds threshold (${this.config.summarizationTriggerCount}) — running summarization`,
    );

    // Sort by creation date, oldest first
    const sorted = activeMemories.sort(
      (a, b) =>
        new Date(a.frontmatter.created).getTime() -
        new Date(b.frontmatter.created).getTime(),
    );

    // Keep recent memories, with explicit zero handling so `slice(-0)` does not
    // accidentally keep every memory out of the summarization candidate set.
    const recentToKeep = Math.max(0, this.config.summarizationRecentToKeep);
    const toSummarize = recentToKeep > 0 ? sorted.slice(0, -recentToKeep) : sorted;

    // Filter candidates for summarization
    const candidates = toSummarize.filter((m) => {
      // Skip if protected by entity reference
      if (m.frontmatter.entityRef) return false;

      // Skip if protected by tag
      const protectedTags = this.config.summarizationProtectedTags;
      if (m.frontmatter.tags.some((t) => protectedTags.includes(t)))
        return false;

      // Skip if importance is above threshold
      const importance = m.frontmatter.importance?.score ?? 0.5;
      if (importance >= this.config.summarizationImportanceThreshold)
        return false;

      return true;
    });

    if (candidates.length < 50) {
      log.debug(
        `only ${candidates.length} candidates for summarization — skipping`,
      );
      return;
    }

    // Summarize in batches of 50
    const batchSize = 50;
    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);
      const batchData = batch.map((m) => ({
        id: m.frontmatter.id,
        content: m.content,
        category: m.frontmatter.category,
        created: m.frontmatter.created,
      }));

      const result = await this.deps.extraction.summarizeMemories(batchData);
      if (!result) continue;

      // Create summary
      const summary: MemorySummary = {
        id: `summary-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        createdAt: new Date().toISOString(),
        timeRangeStart: batch[0].frontmatter.created,
        timeRangeEnd: batch[batch.length - 1].frontmatter.created,
        summaryText: result.summaryText,
        keyFacts: result.keyFacts,
        keyEntities: result.keyEntities,
        sourceEpisodeIds: batch.map((m) => m.frontmatter.id),
      };

      await storage.writeSummary(summary);

      // Archive source memories
      const archived = await storage.archiveMemories(
        batch.map((m) => m.frontmatter.id),
        summary.id,
      );

      // Catalog write touch (issue #1499 sweep): summarization writes a durable
      // summary and then rewrites source-memory archive status, bypassing the
      // extraction write path. Record the touch after both mutations complete so
      // `lastWriteAt` covers the final archived-state write.
      // #1522: catalog touch handled at the storage chokepoint.

      log.info(
        `created summary ${summary.id} from ${batch.length} memories, archived ${archived}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Topic extraction (Phase 4B)
  // -------------------------------------------------------------------------

  /**
   * Run topic extraction on all memories (Phase 4B).
   */
  async runTopicExtraction(
    allMemories: MemoryFile[],
  ): Promise<void> {
    const storage = this.deps.getStorage();
    // Only extract from active memories
    const activeMemories = allMemories.filter(
      (m) => isActiveMemoryStatus(m.frontmatter.status),
    );

    if (activeMemories.length === 0) return;

    const topics = extractTopics(
      activeMemories,
      this.config.topicExtractionTopN,
    );
    await storage.saveTopics(topics);

    log.debug(
      `extracted ${topics.length} topics from ${activeMemories.length} memories`,
    );
  }
}
