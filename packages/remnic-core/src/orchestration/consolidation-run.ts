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
 * The orchestrator keeps a thin delegating method so existing call sites
 * (runConsolidationNow, maintenance scheduler) and tests continue to work.
 */

import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { log } from "../logger.js";
import { applyCommitmentLedgerLifecycle } from "../commitment-ledger.js";
import { recordDreamsPhaseRun } from "../maintenance/dreams-ledger.js";
import { deindexMemoriesBatchAsync } from "../temporal-index-batch.js";
import { isActiveMemoryStatus } from "../memory-lifecycle-ledger-utils.js";
import type {
  DependencyPropagationDeliveryPort,
  DependencyPropagationPreparationToken,
} from "./dependency-propagation-delivery.js";
import { canonicalize } from "./dependency-propagation-queue-state.js";
import type { PropagationEvent } from "./dependency-propagation.js";
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
import type { NamespaceCatalog } from "../namespaces/catalog.js";
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
  getNamespaceCatalog?: () => NamespaceCatalog;
  getExtraction: () => ExtractionEngine;
  storageDirNamespace: (storageDir: string) => string;
  embeddingFallback: EmbeddingFallback;
  tmtBuilder: TmtBuilder;
  consolidationObservers: Set<
    (observation: ConsolidationObservation) => Promise<void> | void
  >;
  getDependencyPropagationDelivery: () => DependencyPropagationDeliveryPort;
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

const MAX_HARMONIC_NAMESPACE_STORES = 50;
const HARMONIC_CATALOG_CURSOR_FILE = "harmonic-catalog-cursor.json";

type HarmonicStore = {
  memoryDir: string;
  abstractionNodeStoreDir?: string;
};

type PendingDependencyPropagation = {
  delivery: DependencyPropagationDeliveryPort;
  event: PropagationEvent;
  preparation: DependencyPropagationPreparationToken | null;
};

async function prepareDependencyPropagation(
  getDelivery: () => DependencyPropagationDeliveryPort,
  event: PropagationEvent,
  enabled: boolean,
): Promise<PendingDependencyPropagation | null> {
  if (!enabled) return null;
  let delivery: DependencyPropagationDeliveryPort;
  try {
    delivery = getDelivery();
  } catch (error) {
    log.warn(`consolidation dependency propagation getter failed: ${error}`);
    return null;
  }
  let preparation: DependencyPropagationPreparationToken | null = null;
  try {
    preparation = await delivery.prepare(event);
  } catch (error) {
    log.warn(`consolidation dependency propagation preparation failed: ${error}`);
  }
  return { delivery, event, preparation };
}

function clonePropagationMemory(memory: MemoryFile): MemoryFile {
  return structuredClone(memory);
}

function sameMemorySnapshot(a: MemoryFile, b: MemoryFile): boolean {
  return (
    a.content === b.content &&
    JSON.stringify(canonicalize(a.frontmatter)) === JSON.stringify(canonicalize(b.frontmatter))
  );
}

async function prepareCurrentDependencyPropagation(
  storage: StorageManager,
  getDelivery: () => DependencyPropagationDeliveryPort,
  sourceId: string,
  buildEvent: (source: MemoryFile) => PropagationEvent,
  enabled: boolean,
): Promise<{ source: MemoryFile; pending: PendingDependencyPropagation | null } | null> {
  const loaded = await storage.getMemoryById(sourceId);
  if (!loaded) return null;
  let source = clonePropagationMemory(loaded);
  let pending = await prepareDependencyPropagation(getDelivery, buildEvent(source), enabled);
  if (!pending) return { source, pending: null };
  let latest: MemoryFile | null;
  try {
    latest = await storage.getMemoryById(sourceId);
  } catch (error) {
    await cancelDependencyPropagation(pending);
    throw error;
  }
  if (!latest) {
    await cancelDependencyPropagation(pending);
    return null;
  }
  if (!sameMemorySnapshot(source, latest)) {
    await cancelDependencyPropagation(pending);
    source = clonePropagationMemory(latest);
    pending = await prepareDependencyPropagation(getDelivery, buildEvent(source), enabled);
  }
  return { source, pending };
}
async function cancelDependencyPropagation(
  pending: PendingDependencyPropagation,
): Promise<void> {
  if (!pending.preparation?.ownsPreparedJob) return;
  try {
    await pending.delivery.cancel(pending.preparation);
  } catch (error) {
    log.warn(`consolidation dependency propagation cancellation failed: ${error}`);
  }
}

async function deferDependencyPropagation(
  pending: PendingDependencyPropagation | null,
): Promise<void> {
  if (!pending) return;
  let token = pending.preparation;
  if (token === null) {
    try {
      token = await pending.delivery.prepare(pending.event);
    } catch (error) {
      log.warn(`consolidation dependency propagation recovery preparation failed: ${error}`);
    }
  }
  if (token === null) return;
  try {
    await pending.delivery.deferPrepared(token);
  } catch (error) {
    log.warn(`consolidation dependency propagation defer failed: ${error}`);
  }
}

async function afterDependencyPropagationMutation(
  pending: PendingDependencyPropagation,
): Promise<void> {
  try {
    await pending.delivery.afterMutation(pending.preparation, pending.event);
  } catch (error) {
    log.warn(`consolidation dependency propagation delivery failed: ${error}`);
  }
}
type InvalidationCommitState = "committed" | "not-committed" | "unknown";

async function classifyInvalidation(
  storage: StorageManager,
  memoryId: string,
  expectedSnapshot: MemoryFile | null,
  options: {
    checkInvalidationProof?: boolean;
    missingMeansCommitted?: boolean;
    matchesCommitted?: (current: MemoryFile) => boolean;
  } = {},
): Promise<InvalidationCommitState> {
  if (options.checkInvalidationProof !== false && expectedSnapshot) {
    if (!storage.hasCommittedInvalidation) {
      log.warn(`consolidation invalidation proof capability missing for ${memoryId}`);
    } else {
      try {
        if (await storage.hasCommittedInvalidation(expectedSnapshot)) return "committed";
      } catch (error) {
        log.warn(`consolidation invalidation proof read failed for ${memoryId}: ${error}`);
      }
    }
  }
  try {
    const current = await storage.getMemoryById(memoryId);
    if (!current) {
      if (options.missingMeansCommitted === false) return "not-committed";
      if (expectedSnapshot && !storage.hasCommittedInvalidation) return "unknown";
      return "committed";
    }
    if (options.matchesCommitted?.(current)) return "committed";
    if (expectedSnapshot && sameMemorySnapshot(current, expectedSnapshot)) {
      return "not-committed";
    }
    return "unknown";
  } catch (error) {
    log.warn(`consolidation invalidation state read failed for ${memoryId}: ${error}`);
    return "unknown";
  }
}

async function settleFailedConsolidationPropagation(
  pending: PendingDependencyPropagation | null,
  commitState: InvalidationCommitState,
  memoryId: string,
): Promise<void> {
  if (!pending) return;
  let token = pending.preparation;
  if (commitState === "not-committed") {
    if (token !== null) await cancelDependencyPropagation({ ...pending, preparation: token });
    return;
  }
  if (token === null && (commitState === "committed" || commitState === "unknown")) {
    try {
      token = await pending.delivery.prepare(pending.event);
    } catch (error) {
      log.warn(
        `consolidation dependency propagation recovery preparation failed for ${memoryId}: ${error}`,
      );
    }
  }
  if (token !== null) {
    try {
      await pending.delivery.deferPrepared(token);
    } catch (error) {
      log.warn(`consolidation dependency propagation defer failed for ${memoryId}: ${error}`);
    }
  }
}

type HarmonicCatalogCursor = {
  nextStorageDir?: string;
};

export class ConsolidationRunCoordinator {
  constructor(private readonly deps: ConsolidationRunCoordinatorDeps) {}

  private async readHarmonicCatalogCursor(defaultDir: string): Promise<string | undefined> {
    const cursorPath = path.join(defaultDir, "state", HARMONIC_CATALOG_CURSOR_FILE);
    try {
      const raw = await readFile(cursorPath, "utf-8");
      const parsed = JSON.parse(raw) as HarmonicCatalogCursor;
      return typeof parsed.nextStorageDir === "string" && parsed.nextStorageDir.length > 0
        ? path.resolve(parsed.nextStorageDir)
        : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn(
          `harmonic namespace catalog cursor read failed open: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return undefined;
    }
  }

  private async writeHarmonicCatalogCursor(
    defaultDir: string,
    nextStorageDir: string,
  ): Promise<void> {
    const stateDir = path.join(defaultDir, "state");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, HARMONIC_CATALOG_CURSOR_FILE),
      JSON.stringify({ nextStorageDir }, null, 2),
      "utf-8",
    );
  }

  private async pruneHarmonicStores(storage: StorageManager): Promise<void> {
    const config = this.deps.config;
    if (
      !resolveCapabilities(config).harmonicRetrieval ||
      !resolveConsolidationCapabilities(config).abstractionAnchors
    ) {
      return;
    }

    const stores = new Map<string, HarmonicStore>();
    const defaultDir = path.resolve(storage.dir);
    stores.set(defaultDir, {
      memoryDir: storage.dir,
      abstractionNodeStoreDir: config.abstractionNodeStoreDir,
    });

    try {
      const catalog = this.deps.getNamespaceCatalog?.();
      if (catalog?.enabled) {
        const records = await catalog.listNamespaces({ discoveredBy: "write" });
        const catalogStores = new Map<string, HarmonicStore>();
        for (const record of records) {
          const storageDir = path.resolve(record.storageDir);
          if (!stores.has(storageDir) && !catalogStores.has(storageDir)) {
            catalogStores.set(storageDir, { memoryDir: record.storageDir });
          }
        }

        const candidates = [...catalogStores.entries()];
        if (candidates.length > 0) {
          const cursor = await this.readHarmonicCatalogCursor(defaultDir);
          const cursorIndex = cursor
            ? candidates.findIndex(([storageDir]) => storageDir === cursor)
            : -1;
          const startIndex = cursorIndex >= 0 ? cursorIndex : 0;
          const selectedCount = Math.min(
            candidates.length,
            MAX_HARMONIC_NAMESPACE_STORES - 1,
          );

          for (let offset = 0; offset < selectedCount; offset += 1) {
            const index = (startIndex + offset) % candidates.length;
            const [storageDir, store] = candidates[index];
            stores.set(storageDir, store);
          }

          const nextIndex = (startIndex + selectedCount) % candidates.length;
          const nextStorageDir = candidates[nextIndex][0];
          try {
            await this.writeHarmonicCatalogCursor(defaultDir, nextStorageDir);
          } catch (error) {
            log.warn(
              `harmonic namespace catalog cursor write failed open: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }

          if (selectedCount < candidates.length) {
            log.warn(
              `harmonic namespace catalog truncated at ${MAX_HARMONIC_NAMESPACE_STORES} stores; ` +
                `skipped ${candidates.length - selectedCount} store(s)`,
            );
          }
        }
      }
    } catch (error) {
      log.warn(
        `harmonic namespace catalog read failed open: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    for (const store of stores.values()) {
      try {
        const removed = await pruneOrphanCueAnchors(store);
        if (removed > 0) {
          log.info(`harmonic anchor prune removed ${removed} orphan(s) from ${store.memoryDir}`);
        }
      } catch (error) {
        log.warn(
          `harmonic anchor prune failed open for ${store.memoryDir}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

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
    await this.pruneHarmonicStores(storage);

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

    // Collect deindex entries from INVALIDATE/MERGE actions and de-index them in
    // one batch, instead of a full index read-modify-write per memory. The flush
    // runs in `finally` so memories already invalidated on disk are still
    // de-indexed if a later iteration throws; it runs exactly once and any loop
    // error still propagates after it.
    const itemsDeindexBatch: Array<{ path: string; createdAt: string; tags: string[] }> = [];

    try {
      for (const item of result.items) {
        switch (item.action) {
          case "INVALIDATE": {
            const prepared = await prepareCurrentDependencyPropagation(
              storage,
              this.deps.getDependencyPropagationDelivery,
              item.existingId,
              (propagationOld) => ({
                oldMemory: propagationOld,
                replacementId: null,
                replacementContent: null,
                cause: "consolidation_invalidate",
                namespaceScope: this.deps.storageDirNamespace(storage.dir),
              }),
              config.dependencyPropagation.enabled &&
                config.dependencyPropagation.maxDependents > 0,
            );
            const propagationOld = prepared?.source ?? null;
            const pending = prepared?.pending ?? null;
            const toInvalidate = resolveIndexingCapabilities(config).queryAwareIndexing
              ? propagationOld
              : null;
            const recordCommitProof = pending?.preparation?.ownsPreparedJob === true;
            let didInvalidate: boolean;
            try {
              didInvalidate = await storage.invalidateMemory(
                item.existingId,
                propagationOld ?? undefined,
                { recordCommitProof },
              );
            } catch (error) {
              const commitState = await classifyInvalidation(storage, item.existingId, propagationOld);
              await settleFailedConsolidationPropagation(
                pending,
                commitState,
                item.existingId,
              );
              throw error;
            }
            if (!didInvalidate) {
              const commitState = await classifyInvalidation(storage, item.existingId, propagationOld);
              await settleFailedConsolidationPropagation(
                pending,
                commitState,
                item.existingId,
              );
              break;
            }
            invalidated += 1;
            memoryItemMutated = true;
            if (pending) await afterDependencyPropagationMutation(pending);
            await this.deps.embeddingFallback.removeFromIndex(item.existingId);
            if (toInvalidate?.path && toInvalidate.frontmatter?.created) {
              itemsDeindexBatch.push({
                path: toInvalidate.path,
                createdAt: toInvalidate.frontmatter.created,
                tags: toInvalidate.frontmatter.tags ?? [],
              });
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
              const updatedContent = item.updatedContent;
              const mergeWith = item.mergeWith;
              const survivorBefore = allMemories.find(
                (memory) => memory.frontmatter.id === item.existingId,
              );
              const survivorSnapshot = survivorBefore
                ? clonePropagationMemory(survivorBefore)
                : null;
              const prepared = await prepareCurrentDependencyPropagation(
                storage,
                this.deps.getDependencyPropagationDelivery,
                item.mergeWith,
                (propagationOld) => ({
                  oldMemory: propagationOld,
                  replacementId: item.existingId,
                  replacementContent: updatedContent,
                  cause: "consolidation_merge",
                  namespaceScope: this.deps.storageDirNamespace(storage.dir),
                }),
                config.dependencyPropagation.enabled &&
                  config.dependencyPropagation.maxDependents > 0,
              );
              const propagationOld = prepared?.source ?? null;
              const pending = prepared?.pending ?? null;
              const toMergeInvalidate = resolveIndexingCapabilities(config).queryAwareIndexing
                ? propagationOld
                : null;
              let didUpdate: boolean;
              try {
                didUpdate = await storage.updateMemory(
                  item.existingId,
                  updatedContent,
                  {
                    supersedes: item.mergeWith,
                    lineage: [item.existingId, item.mergeWith],
                  },
                );
              } catch (error) {
                await deferDependencyPropagation(pending);
                throw error;
              }
              if (!didUpdate) {
                if (pending) await cancelDependencyPropagation(pending);
                break;
              }
              memoryItemMutated = true;
              await this.deps.indexPersistedMemory(storage, item.existingId);
              // updateMemory() only changes content/updated/supersedes/lineage — path, created, and tags
              // are preserved, so the temporal/tag index entry for the survivor is already correct.
              let didInvalidate: boolean;
              try {
                didInvalidate = await storage.invalidateMemory(
                  item.mergeWith,
                  propagationOld ?? undefined,
                  { recordCommitProof: pending?.preparation?.ownsPreparedJob === true },
                );
              } catch (error) {
                const commitState = await classifyInvalidation(storage, item.mergeWith, propagationOld);
                await settleFailedConsolidationPropagation(
                  pending,
                  commitState,
                  item.mergeWith,
                );
                throw error;
              }
              if (!didInvalidate) {
                const commitState = await classifyInvalidation(storage, item.mergeWith, propagationOld);
                await settleFailedConsolidationPropagation(
                  pending,
                  commitState,
                  item.mergeWith,
                );
                break;
              }
              invalidated += 1;
              merged += 1;
              if (pending) await afterDependencyPropagationMutation(pending);
              await this.deps.embeddingFallback.removeFromIndex(item.mergeWith);
              if (toMergeInvalidate?.path && toMergeInvalidate.frontmatter?.created) {
                itemsDeindexBatch.push({
                  path: toMergeInvalidate.path,
                  createdAt: toMergeInvalidate.frontmatter.created,
                  tags: toMergeInvalidate.frontmatter.tags ?? [],
                });
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
