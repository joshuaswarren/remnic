import { drainPendingLifecycleForSyncOrThrow } from "./storage/memory-lifecycle-ledger-access.js";

type PendingImpressionDrain = () => Promise<{ pendingDeferred: boolean }>;

type PendingLifecycleDrain = {
  drainPendingMemoryLifecycleEventsForSync(): Promise<{ folded: boolean; pendingDeferred: boolean }>;
};

type PendingImpressionHost = {
  drainPendingRecallImpressions(): Promise<{ pendingDeferred: boolean }>;
};
/**
 * Fold pending recall-impression spills before building an offline-sync snapshot.
 * A deferred or failed drain must abort the snapshot rather than silently omit
 * durable rows from the sync payload.
 */
export async function drainPendingImpressionsForOfflineSync(
  host: PendingImpressionDrain,
): Promise<void> {
  const maxAttempts = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await host();
      if (!result.pendingDeferred) return;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
  }
  const detail = lastError
    ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    : " (rotation lock held by a peer)";
  throw new Error(
    `offline-sync impression drain could not fold pending recall impressions after ${maxAttempts} attempts${detail}; aborting snapshot so the pending rows are not silently excluded (#2033)`,
  );
}


export async function getOfflineSyncStorage<T extends PendingLifecycleDrain>(
  orchestrator: PendingImpressionHost & {
    getStorage(namespace: string): Promise<T>;
  },
  namespace: string,
): Promise<T> {
  const storage = await orchestrator.getStorage(namespace);
  await drainPendingImpressionsForOfflineSync(() => orchestrator.drainPendingRecallImpressions());
  await drainPendingLifecycleForSyncOrThrow(() => storage.drainPendingMemoryLifecycleEventsForSync());
  return storage;
}
