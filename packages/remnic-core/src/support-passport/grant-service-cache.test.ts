import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import type { StorageManager } from "../index.js";
import type { MemoryFile } from "../types.js";
import { computeSupportPassportOwnerKey } from "./card-projection.js";
import { SupportPassportGrantService } from "./grant-service.js";
import type { SupportPassportGrantStore } from "./grant-store.js";

function supportCardMemory(): MemoryFile {
  return {
    path: path.resolve(import.meta.dirname, "fixtures", "support-card.md"),
    content: "Offer me a quiet place and time.",
    frontmatter: {
      id: "support-card-1",
      category: "preference",
      source: "support-passport",
      confidence: 1,
      confidenceTier: "explicit",
      created: "2026-08-11T12:00:00.000Z",
      updated: "2026-08-11T12:00:00.000Z",
      status: "active",
      tags: ["support-passport-card"],
      structuredAttributes: {
        "support-passport-namespace": "alice",
        "support-passport-owner": computeSupportPassportOwnerKey("owner:alice"),
        "support-passport-title": "Quiet space",
        "support-passport-category": "environment",
        "support-passport-order": "0",
        "support-passport-review-by": "2026-09-01T12:00:00.000Z",
        "support-passport-source-ids": "source-1",
      },
    },
  } as MemoryFile;
}

test("card snapshots expire when a direct file edit bypasses corpus version counters", async () => {
  let nowMs = Date.parse("2026-08-11T12:00:00.000Z");
  let memories = [supportCardMemory()];
  const storage = {
    getCorpusScanVersion: () => 1,
    hotCacheKeyId: () => "stable",
    readAllMemories: async () => memories,
  } as unknown as StorageManager;
  const service = new SupportPassportGrantService({
    grantStore: {} as SupportPassportGrantStore,
    resolveOwner: async (principal) => ({ principal, namespace: "alice", storage }),
    resolveNamespace: async () => storage,
    now: () => new Date(nowMs),
  });
  const inspected = service as unknown as {
    readStoredCardSnapshot(
      storage: StorageManager,
      namespace?: string,
      ownerKey?: string,
    ): Promise<{ cardsById: ReadonlyMap<string, unknown> }>;
  };
  const ownerKey = computeSupportPassportOwnerKey("owner:alice");

  assert.equal((await inspected.readStoredCardSnapshot(storage, "alice", ownerKey)).cardsById.size, 1);
  memories = [];
  nowMs += 1_001;

  assert.equal((await inspected.readStoredCardSnapshot(storage, "alice", ownerKey)).cardsById.size, 0);
});
