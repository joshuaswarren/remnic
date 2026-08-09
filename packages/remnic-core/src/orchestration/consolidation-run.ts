/**
 * Consolidation-run coordinator — extracted from the orchestrator
 * (issue #1526, seam 17).
 *
 * Owns the full consolidation maintenance pass:
 *   - `run()` — the main consolidation cycle (LLM merge/invalidate/update
 *     → entity-file merge → commitment cleanup → TTL cleanup → lifecycle
 *     policy → compression guideline learning → tier migration → fact
 *     archival → semantic consolidation → identity consolidation → profile
 *     consolidation → summarization → topic extraction → TMT rebuild)
 *   - `recordScheduledDreamsPhaseRun` — dream-phase ledger recording
 *   - `runFactArchival` / `runSummarization` / `runTopicExtraction` —
 *     thin delegates to LifecyclePolicyCoordinator
 *   - `runCompressionGuidelineLearningPass` — thin delegate to
 *     CompressionGuidelineCoordinator
 *
 * The orchestrator constructs one instance and delegates the consolidation
 * pass to it. Everything that must stay orchestrator-owned (access tracking,
 * embedding index, entity synthesis, tier migration, semantic consolidation,
 * identity consolidation, recall section config, fast LLM) arrives as
 * injectable delegates.
 *
 * Behavior-preserving move from orchestrator.ts. No logic changes — the
 * orchestrator keeps a thin delegating method so existing call sites
 * (runConsolidationNow, maintenance scheduler) and tests continue to work.
 */

import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { log } from "../logger.js";
import { applyCommitmentLedgerLifecycle } from "../commitment-ledger.js";
import { recordDreamsPhaseRun } from "../maintenance/dreams-ledger.js";
import { deindexMemoriesBatchAsync } from "../temporal-index-batch.js";
import { isActiveMemoryStatus } from "../memory-lifecycle-ledger-utils.js";
import { propagateInvalidation } from "./dependency-propagation.js";
import {
  resolveCapabilities,
  resolveConsolidationCapabilities,
  resolveCreationMemoryCapabilities,
  resolveIndexingCapabilities,
  resolveMemoryLifecycleCapabilities,
  resolvePipelineProcessingCapabilities,
  resolvePresentationCapabilities,
  resolveRecallEnhancementCapabilities,
  type MemoryLifecycleCapabilitySet,
} from "../capabilities.js";
import { pruneOrphanCueAnchors } from "../cue-anchors.js";
import type { LifecyclePolicyCoordinator } from "./lifecycle-policy-coordinator.js";
import type { CompressionGuidelineCoordinator } from "./compression-guideline-coordinator.js";
import type { SemanticConsolidationCoordinator } from "./semantic-consolidation-coordinator.js";
import type { EntitySynthesisCoordinator } from "./entity-synthesis-coordinator.js";
import type { RecallSectionCoordinator } from "./recall-section-coordinator.js";
import type { TierMigrationCoordinator } from "./tier-migration-coordinator.js";
import type { StorageManager } from "../index.js";
import type { NamespaceStorageRouter } from "../namespaces/storage.js";
import type { ExtractionEngine } from "../extraction.js";
import type { EmbeddingFallback } from "../embedding-fallback.js";
import type { TmtBuilder } from "../tmt.js";
import type {
  ConsolidationObservation,
  MemoryFile,
  PluginConfig,
  RecallSectionConfig,
} from "../types.js";

/** Dependencies injected by the orchestrator. Stable references or live
 *  accessors — lazy getters for mutable fields tests reassign
 *  post-construction (storage, extraction, storageRouter). */
export interface ConsolidationRunCoordinatorDeps {
  config: PluginConfig;
  getStorage: () => StorageManager;
  getStorageRouter: () => NamespaceStorageRouter;
  getExtraction: () => ExtractionEngine;
  embeddingFallback: EmbeddingFallback;
  tmtBuilder: TmtBuilder;
  consolidationObservers: Set<
    (observation: ConsolidationObservation) => Promise<void> | void
  >;
  getAccessTrackingBuffer: () => Map<
    string,
    { count: number; lastAccessed: string }
  >;

  lifecyclePolicyCoordinator: LifecyclePolicyCoordinator;
  compressionGuidelineCoordinator: CompressionGuidelineCoordinator;
  semanticConsolidationCoordinator: SemanticConsolidationCoordinator;
  entitySynthesisCoordinator: EntitySynthesisCoordinator;
  recallSectionCoordinator: RecallSectionCoordinator;
  tierMigrationCoordinator: TierMigrationCoordinator;

  flushAccessTracking: () => Promise<void>;
  indexPersistedMemory: (storage: StorageManager, memoryId: string) => Promise<void>;
  autoConsolidateIdentity: () => Promise<void>;
  fastChatCompletion: (
    messages: Array<{ role: string; content: string }>,
    options: {
      temperature?: number;
      maxTokens?: number;
      timeoutMs?: number;
      operation?: string;
      priority?: "background" | "recall-critical";
    },
  ) => Promise<{ content: string } | null>;
}

export class ConsolidationRunCoordinator {
  constructor(private readonly deps: ConsolidationRunCoordinatorDeps) {}

  async run(): Promise<{
    memoriesProcessed: number;
    merged: number;
    invalidated: number;
  }> {
    const config = this.deps.config;
    const storage = this.deps.getStorage();
    const lifecycleCaps = resolveMemoryLifecycleCapabilities(config);
    log.info("running consolidation pass");
    let merged = 0;
    let invalidated = 0;
    // Tracks whether any consolidation memory-item action (UPDATE / MERGE /
    // INVALIDATE) durably rewrote memory state. A consolidation pass that only
    // mutates memory items (no profile/entity updates) still changes the default
    // namespace's data, so its catalog `lastWriteAt` must refresh too (NIBOi).
    let memoryItemMutated = false;

    // Flush access tracking buffer first
    if (this.deps.getAccessTrackingBuffer().size > 0) {
      await this.deps.flushAccessTracking();
    }
    if (
      resolveCapabilities(config).harmonicRetrieval &&
      resolveConsolidationCapabilities(config).abstractionAnchors
    ) {
      try {
        const removed = await pruneOrphanCueAnchors({
          memoryDir: storage.dir,
          abstractionNodeStoreDir: config.abstractionNodeStoreDir,
        });
        if (removed > 0) {
          log.info(`harmonic anchor prune removed ${removed} orphan(s)`);
        }
      } catch (error) {
        log.warn(
          `harmonic anchor prune failed open: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    let allMemories = await storage.readAllMemories();
    if (allMemories.length < 5) {
      return { memoriesProcessed: allMemories.length, merged, invalidated };
    }

    const recent = allMemories
      .sort(
        (a, b) =>
          new Date(b.frontmatter.created).getTime() -
          new Date(a.frontmatter.created).getTime(),
      )
      .slice(0, 20);

    const older = allMemories.sort(
      (a, b) =>
        new Date(a.frontmatter.created).getTime() -
        new Date(b.frontmatter.created).getTime(),
    );

    const profile = await storage.readProfile();
    const result = await this.deps.getExtraction().consolidate(recent, older, profile);

    // Build a lookup map from the already-loaded corpus to avoid repeated
    // readAllMemories() scans inside getMemoryById for pre-action deindex reads.
    const memoryLookup = resolveIndexingCapabilities(config).queryAwareIndexing
      ? new Map(allMemories.map((m) => [m.frontmatter.id, m]))
      : null;

    // Collect deindex entries from INVALIDATE/MERGE actions and de-index them in
    // one batch, instead of a full index read-modify-write per memory. The
    // queryAwareIndexing guard is preserved: memoryLookup is null when it is
    // disabled, so toInvalidate/toMergeInvalidate stay null and nothing is
    // collected. The flush runs in `finally` so memories already invalidated on
    // disk are still de-indexed if a later iteration throws; it runs exactly once
    // (normal completion or throw) and any loop error still propagates after it.
    const itemsDeindexBatch: Array<{ path: string; createdAt: string; tags: string[] }> = [];

    try {
      for (const item of result.items) {
        switch (item.action) {
          case "INVALIDATE": {
            // Capture path/frontmatter before invalidation for index cleanup
            const toInvalidate = resolveIndexingCapabilities(config).queryAwareIndexing
              ? (memoryLookup?.get(item.existingId) ?? null)
              : null;
            // Always capture the full pre-delete snapshot for propagation.
            const propagationOld = allMemories.find(
              (memory) => memory.frontmatter.id === item.existingId,
            );
            if (await storage.invalidateMemory(item.existingId)) {
              invalidated += 1;
              memoryItemMutated = true;
              await this.deps.embeddingFallback.removeFromIndex(item.existingId);
              if (propagationOld) {
                try {
                  await propagateInvalidation(
                    {
                      storage,
                      extraction: this.deps.getExtraction(),
                      config,
                    },
                    {
                      oldMemory: propagationOld,
                      replacementId: null,
                      replacementContent: null,
                      cause: "consolidation_invalidate",
                      namespaceScope: config.defaultNamespace,
                    },
                  );
                } catch (propagationErr) {
                  log.warn(
                    `consolidation dependency propagation failed for ${item.existingId}: ${propagationErr}`,
                  );
                }
              }
              if (toInvalidate?.path && toInvalidate.frontmatter?.created) {
                itemsDeindexBatch.push({
                  path: toInvalidate.path,
                  createdAt: toInvalidate.frontmatter.created,
                  tags: toInvalidate.frontmatter.tags ?? [],
                });
              }
            }
            break;
          }
          case "UPDATE":
            if (item.updatedContent) {
              await storage.updateMemory(
                item.existingId,
                item.updatedContent,
                {
                  lineage: [item.existingId],
                },
              );
              memoryItemMutated = true;
              await this.deps.indexPersistedMemory(storage, item.existingId);
              // updateMemory() only changes content/updated/lineage — path, created, and tags
              // are preserved, so the temporal/tag index entry is already correct; no reindex needed.
            }
            break;
          case "MERGE":
            if (item.updatedContent && item.mergeWith) {
              await storage.updateMemory(
                item.existingId,
                item.updatedContent,
                {
                  supersedes: item.mergeWith,
                  lineage: [item.existingId, item.mergeWith],
                },
              );
              memoryItemMutated = true;
              await this.deps.indexPersistedMemory(storage, item.existingId);
              // updateMemory() only changes content/updated/supersedes/lineage — path, created, and tags
              // are preserved, so the temporal/tag index entry for the survivor is already correct.
              // Capture before invalidation for index cleanup
              const toMergeInvalidate = resolveIndexingCapabilities(config).queryAwareIndexing
                ? (memoryLookup?.get(item.mergeWith) ?? null)
                : null;
              // Capture the doomed memory before invalidation, independent of
              // queryAwareIndexing and its optional lookup map.
              const propagationOld = allMemories.find(
                (memory) => memory.frontmatter.id === item.mergeWith,
              );
              if (await storage.invalidateMemory(item.mergeWith)) {
                invalidated += 1;
                merged += 1;
                await this.deps.embeddingFallback.removeFromIndex(item.mergeWith);
                if (propagationOld) {
                  try {
                    await propagateInvalidation(
                      {
                        storage,
                        extraction: this.deps.getExtraction(),
                        config,
                      },
                      {
                        oldMemory: propagationOld,
                        replacementId: item.existingId,
                        replacementContent: item.updatedContent,
                        cause: "consolidation_merge",
                        namespaceScope: config.defaultNamespace,
                      },
                    );
                  } catch (propagationErr) {
                    log.warn(
                      `consolidation dependency propagation failed for ${item.mergeWith}: ${propagationErr}`,
                    );
                  }
                }
                if (
                  toMergeInvalidate?.path &&
                  toMergeInvalidate.frontmatter?.created
                ) {
                  itemsDeindexBatch.push({
                    path: toMergeInvalidate.path,
                    createdAt: toMergeInvalidate.frontmatter.created,
                    tags: toMergeInvalidate.frontmatter.tags ?? [],
                  });
                }
              }
            }
            break;
        }
      }
    } finally {
      await deindexMemoriesBatchAsync(config.memoryDir, itemsDeindexBatch);
    }

    if (result.profileUpdates.length > 0) {
      await storage.appendToProfile(result.profileUpdates);
    }

    for (const entity of result.entityUpdates) {
      const safeFacts = Array.isArray(entity.facts)
        ? entity.facts.filter((f): f is string => typeof f === "string")
        : [];
      await storage.writeEntity(entity.name, entity.type, safeFacts, {
        source: "consolidation",
        structuredSections: Array.isArray(entity.structuredSections)
          ? entity.structuredSections
          : undefined,
      });
    }

    // Catalog write touch accounting (issue #1499 sweep): consolidation persists
    // durable mutations directly to the default-namespace storage, bypassing
    // the extraction write path. We do NOT touch here — later maintenance steps in
    // this same function (entity-file merges, expired-commitment / TTL cleanup,
    // fact archival) can ALSO mutate the namespace on a run with no LLM outputs
    // (NIjwl). So we accumulate every durable mutation into `memoryItemMutated` and
    // record ONE consolidated touch AFTER all mutation-producing steps complete,
    // just before returning (rule #25: touch after the write commits). LLM
    // profile/entity updates and memory-item actions (UPDATE / MERGE / INVALIDATE)
    // count here (NIBOi).
    if (result.profileUpdates.length > 0 || result.entityUpdates.length > 0) {
      memoryItemMutated = true;
    }

    // Merge fragmented entity files
    const entitiesMerged = await storage.mergeFragmentedEntities();
    if (entitiesMerged > 0) {
      memoryItemMutated = true;
      log.info(`merged ${entitiesMerged} fragmented entity files`);
    }

    if (resolvePresentationCapabilities(config).entitySummary) {
      try {
        const synthesized = await this.deps.entitySynthesisCoordinator.processQueue(
          config.defaultNamespace,
          5,
        );
        if (synthesized > 0) {
          // Entity synthesis rewrites entity files — a durable namespace mutation,
          // so record it for the catalog touch even when it is the only change in
          // the pass (codex). Otherwise lastWriteAt goes stale.
          memoryItemMutated = true;
          log.info(`refreshed ${synthesized} entity syntheses`);
        }
      } catch (err) {
        log.debug(`entity synthesis pass failed: ${err}`);
      }
    }

    // Clean expired commitments
    const deletedCommitments = await storage.cleanExpiredCommitments(
      config.commitmentDecayDays,
    );
    if (deletedCommitments.length > 0) {
      memoryItemMutated = true;
      log.info(`cleaned ${deletedCommitments.length} expired commitments`);
      if (resolveIndexingCapabilities(config).queryAwareIndexing) {
        await deindexMemoriesBatchAsync(
          config.memoryDir,
          deletedCommitments.map((m) => ({
            path: m.path,
            createdAt: m.frontmatter.created,
            tags: m.frontmatter.tags ?? [],
          })),
        );
      }
    }

    if (
      resolveCreationMemoryCapabilities(config).creationMemory &&
      resolveCreationMemoryCapabilities(config).commitmentLedger &&
      resolveCreationMemoryCapabilities(config).commitmentLifecycle
    ) {
      try {
        const lifecycle = await applyCommitmentLedgerLifecycle({
          memoryDir: config.memoryDir,
          commitmentLedgerDir: config.commitmentLedgerDir,
          enabled: true,
          decayDays: config.commitmentDecayDays,
        });
        if (
          lifecycle.transitionedToExpired.length > 0 ||
          lifecycle.deletedResolved.length > 0
        ) {
          memoryItemMutated = true;
          log.info(
            `commitment ledger lifecycle: expired ${lifecycle.transitionedToExpired.length}, cleaned ${lifecycle.deletedResolved.length}`,
          );
        }
      } catch (err) {
        log.debug(`commitment ledger lifecycle pass failed: ${err}`);
      }
    }

    // Clean memories past their TTL (speculative memories auto-expire)
    const deletedTTL = await storage.cleanExpiredTTL();
    if (deletedTTL.length > 0) {
      memoryItemMutated = true;
      log.info(`cleaned ${deletedTTL.length} TTL-expired memories`);
      if (resolveIndexingCapabilities(config).queryAwareIndexing) {
        await deindexMemoriesBatchAsync(
          config.memoryDir,
          deletedTTL.map((m) => ({
            path: m.path,
            createdAt: m.frontmatter.created,
            tags: m.frontmatter.tags ?? [],
          })),
        );
      }
    }

    // v8.3 Lifecycle policy pass — deterministic promotion/decay metadata
    if (lifecycleCaps.lifecyclePolicy) {
      try {
        const lightSleepStartedAt = new Date().toISOString();
        const lifecycleCorpus = await storage.readAllMemories();
        // Lifecycle frontmatter writes count as durable mutations for the catalog
        // touch below (codex NR-tS), even when no other consolidation step set
        // memoryItemMutated.
        if ((await this.deps.lifecyclePolicyCoordinator.runLifecyclePolicyPass(lifecycleCorpus, storage)) > 0) {
          memoryItemMutated = true;
        }
        await this.recordScheduledDreamsPhaseRun(
          "lightSleep",
          lifecycleCorpus.length,
          `scheduled lifecycle policy pass assessed ${lifecycleCorpus.length} memories`,
          {
            startedAt: lightSleepStartedAt,
            completedAt: new Date().toISOString(),
          },
        );
      } catch (err) {
        log.warn(`lifecycle policy pass failed (ignored): ${err}`);
      }
    }

    // v8.3 Compression guideline learning pass (default off, fail-open).
    await this.deps.compressionGuidelineCoordinator.runCompressionGuidelineLearningPass();

    try {
      const deepSleepStartedAt = new Date().toISOString();
      // Tier migrations move/rewrite memory files; count them as durable
      // mutations for the catalog touch below (codex NThSW).
      const tierMigration = await this.deps.tierMigrationCoordinator.runCycle(storage, "maintenance");
      if (tierMigration.migrated > 0) memoryItemMutated = true;
      allMemories = await storage.readAllMemories();

      // Fact archival pass (v6.0) — move old, low-importance, rarely-accessed facts to archive/
      if (resolveRecallEnhancementCapabilities(config).factArchival) {
        const archived = await this.deps.lifecyclePolicyCoordinator.runFactArchival(allMemories);
        if (archived > 0) {
          memoryItemMutated = true;
          log.info(`archived ${archived} old low-importance facts`);
        }
      }
      await this.recordScheduledDreamsPhaseRun(
        "deepSleep",
        allMemories.length,
        `scheduled deep-sleep maintenance assessed ${allMemories.length} memories`,
        {
          startedAt: deepSleepStartedAt,
          completedAt: new Date().toISOString(),
        },
      );
    } catch (err) {
      log.warn(`deep-sleep maintenance pass failed (ignored): ${err}`);
      try {
        allMemories = await storage.readAllMemories();
      } catch (readErr) {
        log.warn(`deep-sleep maintenance recovery read failed: ${readErr}`);
        throw err;
      }
    }

    // Semantic consolidation pass — find similar memories, synthesize canonical versions
    if (resolveConsolidationCapabilities(config).semanticConsolidation) {
      try {
        const stateFilePath = path.join(
          config.memoryDir,
          "state",
          "semantic-consolidation-last-run.json",
        );
        let shouldRun = true;
        try {
          const stateRaw = await readFile(stateFilePath, "utf-8");
          const stateData = JSON.parse(stateRaw) as { lastRunAt?: string };
          if (stateData.lastRunAt) {
            const lastRunMs = new Date(stateData.lastRunAt).getTime();
            const intervalMs =
              config.semanticConsolidationIntervalHours * 60 * 60 * 1000;
            if (Date.now() - lastRunMs < intervalMs) {
              shouldRun = false;
              log.debug(
                "[semantic-consolidation] skipping — not enough time since last run",
              );
            }
          }
        } catch {
          // No state file yet — first run
        }

        if (shouldRun) {
          const remStartedAt = new Date().toISOString();
          const semResult = await this.deps.semanticConsolidationCoordinator.runSemanticConsolidation();
          let remItemsProcessed = allMemories.length;
          try {
            allMemories = await storage.readAllMemories();
            remItemsProcessed = allMemories.length;
          } catch (err) {
            log.warn(
              `[semantic-consolidation] post-run telemetry refresh failed (non-fatal): ${err}`,
            );
          }
          await this.recordScheduledDreamsPhaseRun(
            "rem",
            remItemsProcessed,
            `scheduled REM consolidation found ${semResult.clustersFound} clusters`,
            {
              startedAt: remStartedAt,
              completedAt: new Date().toISOString(),
            },
          );
          if (semResult.memoriesArchived > 0) {
            log.info(
              `[semantic-consolidation] archived ${semResult.memoriesArchived} memories during maintenance`,
            );
          }
          // Only persist last-run timestamp if the run succeeded (had no errors or made progress)
          if (semResult.errors === 0 || semResult.memoriesArchived > 0) {
            const stateDir = path.join(config.memoryDir, "state");
            await mkdir(stateDir, { recursive: true });
            await writeFile(
              stateFilePath,
              JSON.stringify({ lastRunAt: new Date().toISOString() }),
              "utf-8",
            );
          }
        }
      } catch (err) {
        log.warn(
          `[semantic-consolidation] maintenance pass failed (non-fatal): ${err}`,
        );
      }
    }

    // Auto-consolidate IDENTITY.md if it's getting large
    if (resolveRecallEnhancementCapabilities(config).identity) {
      await this.deps.autoConsolidateIdentity();
    }

    // Auto-consolidate profile.md if it exceeds max lines
    const profileSection = this.deps.recallSectionCoordinator.getRecallSectionEntry("profile");
    const profileConsolidationTriggerLines =
      typeof profileSection?.consolidateTriggerLines === "number"
        ? Math.max(0, Math.floor(profileSection.consolidateTriggerLines))
        : undefined;
    const profileConsolidationTargetLines =
      typeof profileSection?.consolidateTargetLines === "number"
        ? Math.max(0, Math.floor(profileSection.consolidateTargetLines))
        : 50;
    if (
      await storage.profileNeedsConsolidation(
        profileConsolidationTriggerLines,
      )
    ) {
      log.info("profile.md exceeds max lines — running smart consolidation");
      const currentProfile = await storage.readProfile();
      if (currentProfile) {
        const profileResult = await this.deps.getExtraction().consolidateProfile(
          currentProfile,
          profileConsolidationTargetLines,
        );
        if (profileResult) {
          await storage.writeProfile(profileResult.consolidatedProfile);
          // Profile consolidation rewrites profile.md — a durable namespace
          // mutation; record it for the catalog touch even when it is the only
          // change in the pass (codex). Otherwise lastWriteAt goes stale.
          memoryItemMutated = true;
          log.info(
            `profile.md consolidated: removed ${profileResult.removedCount} items — ${profileResult.summary}`,
          );
        }
      }
    }

    // Memory Summarization (Phase 4A)
    if (resolvePipelineProcessingCapabilities(config).summarization) {
      await this.deps.lifecyclePolicyCoordinator.runSummarization(allMemories);
    }

    // Topic Extraction (Phase 4B)
    if (resolvePipelineProcessingCapabilities(config).topicExtraction) {
      await this.deps.lifecyclePolicyCoordinator.runTopicExtraction(allMemories);
    }

    const meta = await storage.loadMeta();
    meta.lastConsolidationAt = new Date().toISOString();
    await storage.saveMeta(meta);

    // Temporal Memory Tree (v8.2) — rebuild nodes from all memories, fail-open
    if (lifecycleCaps.temporalMemoryTree) {
      try {
        const tmtEntries = allMemories
          .filter(
            (m) =>
              m.frontmatter.status !== "superseded" && m.frontmatter.status !== "archived" &&
              m.frontmatter.status !== "forgotten" && m.frontmatter.status !== "pending_review", // #1576: unfaithful queue items must not feed TMT clusters
          )
          .map((m) => ({
            path: m.path,
            id: m.frontmatter.id,
            created: m.frontmatter.created,
            content: m.content,
          }));
        await this.deps.tmtBuilder.maybeRebuildNodes(
          tmtEntries,
          async (texts, level) => {
            const prompt = `You are a memory archivist. Summarize the following ${level}-level memories into 3\u20135 sentences, preserving key facts, decisions, and preferences.\n\n${texts.map((t, i) => `[${i + 1}] ${t}`).join("\n\n")}`;
            const response = await this.deps.fastChatCompletion(
              [
                {
                  role: "system",
                  content:
                    "Respond with a 3\u20135 sentence narrative summary. No JSON, just plain prose.",
                },
                { role: "user", content: prompt },
              ],
              {
                temperature: 0.3,
                maxTokens: config.tmtSummaryMaxTokens,
                operation: "tmt_summary",
                priority: "background",
              },
            );
            return response?.content?.trim() || texts.slice(0, 3).join(" ");
          },
        );
      } catch (err) {
        log.warn(`tmt: consolidation hook failed (ignored): ${err}`);
      }
    }

    if (this.deps.consolidationObservers.size > 0) {
      const observation: ConsolidationObservation = {
        runAt: new Date().toISOString(),
        recentMemories: recent,
        existingMemories: older.slice(-50),
        profile,
        result,
        merged,
        invalidated,
      };
      for (const observer of this.deps.consolidationObservers) {
        try {
          await observer(observation);
        } catch (err) {
          log.warn(`consolidation observer failed (ignored): ${err}`);
        }
      }
    }

    // Consolidated catalog write touch — belt-and-suspenders for cleanup-only
    // passes that mutate the store via delete-only paths (entity merges, TTL
    // cleanup) without triggering the storage chokepoint's post-write hook.
    // Gated on memoryItemMutated (set by every durable mutation including cleanup-only passes)
    // Best-effort and failure-tolerant.
    if (memoryItemMutated) {
      this.deps.getStorageRouter().recordWrite(config.defaultNamespace, storage.dir);
    }

    log.info("consolidation complete");
    return { memoriesProcessed: allMemories.length, merged, invalidated };
  }

  private async recordScheduledDreamsPhaseRun(
    phase: "lightSleep" | "rem" | "deepSleep",
    itemsProcessed: number,
    notes: string,
    timing: { startedAt?: string; completedAt?: string } = {},
  ): Promise<void> {
    try {
      await recordDreamsPhaseRun({
        memoryDir: this.deps.getStorage().dir,
        phase,
        trigger: "scheduled",
        itemsProcessed,
        notes,
        startedAt: timing.startedAt,
        completedAt: timing.completedAt,
      });
    } catch (error) {
      log.debug(`dreams ledger scheduled ${phase} write failed (non-fatal): ${error}`);
    }
  }

}
