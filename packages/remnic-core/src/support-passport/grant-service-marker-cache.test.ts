import assert from "node:assert/strict";
import test from "node:test";

import type { StorageManager } from "../index.js";
import type { StoredSupportPassportCard } from "./card-projection.js";
import type { GeneratedBatchMarker } from "./generated-batch.js";
import { SupportPassportGrantService } from "./grant-service.js";
import type { SupportPassportGrantStore } from "./grant-store.js";

interface TestSnapshot {
  version: string;
  cardsById: ReadonlyMap<string, StoredSupportPassportCard>;
  activeReplacementPredecessors: ReadonlySet<string>;
}

test("grant snapshots reuse generated batch markers across validation and projection", async () => {
  const storage = {
    getCorpusScanVersion: () => 7,
    hotCacheKeyId: () => "owner-cache",
  } as unknown as StorageManager;
  const service = new SupportPassportGrantService({
    grantStore: {} as SupportPassportGrantStore,
    resolveOwner: async () => ({ principal: "owner:alice", namespace: "alice", storage }),
    resolveNamespace: async () => storage,
  });
  const cached: TestSnapshot = {
    version: "7:owner-cache",
    cardsById: new Map(),
    activeReplacementPredecessors: new Set(),
  };
  const inspected = service as unknown as {
    cardSnapshots: WeakMap<StorageManager, Map<string, TestSnapshot>>;
    readStoredCardSnapshot(storage: StorageManager, namespace: string, ownerKey: string): Promise<TestSnapshot>;
    snapshotMarkersRemainCommitted(
      storage: StorageManager,
      snapshot: TestSnapshot,
      markerCache: Map<string, GeneratedBatchMarker | null>
    ): Promise<boolean>;
    readStoredCards(
      storage: StorageManager,
      namespace: string,
      ownerKey: string,
      markerCache: Map<string, GeneratedBatchMarker | null>
    ): Promise<StoredSupportPassportCard[]>;
  };
  inspected.cardSnapshots.set(storage, new Map([["alice\0owner-key", cached]]));
  let validationCache: Map<string, GeneratedBatchMarker | null> | undefined;
  inspected.snapshotMarkersRemainCommitted = async (_storage, _snapshot, markerCache) => {
    validationCache = markerCache;
    markerCache.set("00000000-0000-4000-8000-000000000001", null);
    return false;
  };
  inspected.readStoredCards = async (_storage, _namespace, _ownerKey, markerCache) => {
    assert.equal(markerCache, validationCache);
    assert.equal(markerCache.has("00000000-0000-4000-8000-000000000001"), true);
    return [];
  };

  const snapshot = await inspected.readStoredCardSnapshot(storage, "alice", "owner-key");

  assert.equal(snapshot.cardsById.size, 0);
});
