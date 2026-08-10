/**
 * Replay reconciliation for dependency-propagation recovery.
 *
 * Reconciles the index effects — reindex the survivor, deindex the superseded
 * set — of a replayed consolidation merge so a recovery pass matches what a
 * normal consolidation MERGE/INVALIDATE performs inline. Host-agnostic: it
 * imports no index backend and never references the orchestrator. The namespace
 * storage lookup, survivor reindex, embedding deindex, and query-aware-indexing
 * gate all flow through core APIs plus the injected
 * {@link DependencyPropagationReplayHost}. Cause-gating mirrors consolidation
 * exactly: reindex runs only for a consolidation_merge survivor; deindex runs
 * for consolidation_merge and consolidation_invalidate superseded memories,
 * dropping embedding visibility first then the temporal index entry. Any
 * rejection propagates so the delivery keeps recovery retryable rather than
 * marking the job safely complete.
 */
import { deindexMemoriesBatchAsync } from "../temporal-index.js";
import { resolveIndexingCapabilities } from "../capabilities.js";
import type { StorageManager } from "../storage.js";
import type { PluginConfig } from "../types.js";
import type { DependencyPropagationReplayReconciliationPort } from "./dependency-propagation-delivery.js";

/**
 * Narrow host port: the index primitives a recovery replay needs. The host
 * (orchestrator) supplies them; this module owns the cause-gating and
 * deindex/reindex ordering and imports no index backend of its own.
 */
export interface DependencyPropagationReplayHost {
  /** Resolve the storage owning a propagation event's namespace scope. */
  getStorage(namespace: string): Promise<StorageManager>;
  /** Reindex/refresh a still-active survivor's index visibility. */
  indexPersistedMemory(storage: StorageManager, memoryId: string): Promise<void>;
  /** Remove a superseded memory's stale embedding index entry. */
  removeFromIndex(memoryId: string): Promise<void>;
  /** Host config; read for the query-aware-indexing gate. */
  readonly config: PluginConfig;
}

/**
 * Build the replay-reconciliation port bound to a host's index primitives. The
 * returned port is handed to {@link DependencyPropagationDelivery} as
 * `replayReconciliation`; it is inert until the delivery replays a job.
 */
export function createDependencyPropagationReplayReconciliation(
  host: DependencyPropagationReplayHost,
): DependencyPropagationReplayReconciliationPort {
  return {
    reindex: async (event, survivorId) => {
      if (event.cause !== "consolidation_merge") return;
      const storage = await host.getStorage(event.namespaceScope);
      await host.indexPersistedMemory(storage, survivorId);
    },
    deindex: async (event, memoryIds) => {
      if (
        event.cause !== "consolidation_merge" &&
        event.cause !== "consolidation_invalidate"
      ) {
        return;
      }
      await Promise.all(
        memoryIds.map((memoryId) => host.removeFromIndex(memoryId)),
      );
      if (!resolveIndexingCapabilities(host.config).queryAwareIndexing) return;
      if (!event.oldMemory.path || !event.oldMemory.frontmatter.created) return;
      const storage = await host.getStorage(event.namespaceScope);
      await deindexMemoriesBatchAsync(storage.dir, [{
        path: event.oldMemory.path,
        createdAt: event.oldMemory.frontmatter.created,
        tags: event.oldMemory.frontmatter.tags ?? [],
      }]);
    },
  };
}
