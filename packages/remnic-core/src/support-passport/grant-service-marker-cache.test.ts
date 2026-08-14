import assert from "node:assert/strict";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { StorageManager } from "../storage.js";
import {
  computeSupportPassportOwnerKey,
  type StoredSupportPassportCard,
} from "./card-projection.js";
import {
  commitSupportPassportGeneratedBatch,
  isCommittedGeneratedCard,
  persistSupportPassportGeneratedBatchMarker,
} from "./generated-batch.js";

test("generated card checks reuse a marker within one snapshot build", async () => {
  StorageManager.clearAllStaticCaches();
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-marker-cache-"));
  const storage = new StorageManager(path.join(root, "owner"));
  await storage.ensureDirectories();
  const batchId = "00000000-0000-4000-8000-000000000001";
  const context = {
    storage,
    principal: "owner:alice",
    namespace: "alice",
    now: () => new Date("2026-08-13T12:00:00.000Z"),
    requireOwnerLock: async () => undefined,
  };
  const owner = computeSupportPassportOwnerKey(context.principal);
  const cards = [
    {
      namespace: "alice",
      owner,
      generatedBatchId: batchId,
      generatedBatchSize: 2,
      card: { cardId: "00000000-0000-4000-8000-000000000002", status: "pending_review" },
    },
    {
      namespace: "alice",
      owner,
      generatedBatchId: batchId,
      generatedBatchSize: 2,
      card: { cardId: "00000000-0000-4000-8000-000000000003", status: "pending_review" },
    },
  ] as StoredSupportPassportCard[];

  try {
    const marker = await persistSupportPassportGeneratedBatchMarker(context, batchId, cards.length);
    await commitSupportPassportGeneratedBatch(context, marker, cards);
    const markerCache = new Map();

    assert.equal(await isCommittedGeneratedCard(storage, cards[0]!, markerCache), true);
    await unlink(path.join(storage.dir, "state", "support-passport", "generated-batches", `${batchId}.json`));
    assert.equal(await isCommittedGeneratedCard(storage, cards[1]!, markerCache), true);
    assert.equal(await isCommittedGeneratedCard(storage, cards[1]!, new Map()), false);
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(root, { recursive: true, force: true });
  }
});

test("grant snapshots revalidate after the cross-process cache bound", async () => {
  let currentTime = 1_000;
  const storage = {
    getCorpusScanVersion: () => 7,
    hotCacheKeyId: () => "owner-cache",
    hotCacheTtlMs: () => 1_000,
    isHotCacheEnabled: () => true,
  } as unknown as StorageManager;
  const service = new SupportPassportGrantService({
    grantStore: {} as SupportPassportGrantStore,
    resolveOwner: async () => ({ principal: "owner:alice", namespace: "alice", storage }),
    resolveNamespace: async () => storage,
    now: () => new Date(currentTime),
  });
  const cached: TestSnapshot = {
    version: "7:owner-cache",
    validatedAtMs: currentTime,
    cardsById: new Map(),
    generatedBatchMarkers: new Map(),
    activeReplacementPredecessors: new Set(),
  };
  const inspected = service as unknown as {
    cardSnapshots: WeakMap<StorageManager, Map<string, TestSnapshot>>;
    readStoredCardSnapshot(storage: StorageManager, namespace: string, ownerKey: string): Promise<TestSnapshot>;
    readStoredCards(): Promise<StoredSupportPassportCard[]>;
  };
  inspected.cardSnapshots.set(storage, new Map([["alice\0owner-key", cached]]));
  let storageReads = 0;
  inspected.readStoredCards = async () => {
    storageReads += 1;
    return [];
  };

  assert.equal(await inspected.readStoredCardSnapshot(storage, "alice", "owner-key"), cached);
  assert.equal(storageReads, 0);
  currentTime += 1_001;
  assert.notEqual(await inspected.readStoredCardSnapshot(storage, "alice", "owner-key"), cached);
  assert.equal(storageReads, 1);
});
