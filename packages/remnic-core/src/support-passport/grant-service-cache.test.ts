import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { StorageManager } from "../index.js";
import type { MemoryFile } from "../types.js";
import { computeSupportPassportOwnerKey, projectSupportPassportCard } from "./card-projection.js";
import { SupportPassportError } from "./errors.js";
import type { SupportPassportGrantState } from "./grant-contracts.js";
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

test("card snapshots match the storage cache freshness window", async () => {
  let nowMs = Date.parse("2026-08-11T12:00:00.000Z");
  let diskMemories = [supportCardMemory()];
  let cachedMemories: MemoryFile[] | undefined;
  let cacheLoadedAt = 0;
  let calls = 0;
  let diskReads = 0;
  const storage = {
    getCorpusScanVersion: () => 1,
    hotCacheKeyId: () => "stable",
    hotCacheTtlMs: () => 60_000,
    isHotCacheEnabled: () => true,
    readAllMemories: async () => {
      calls += 1;
      if (cachedMemories && nowMs - cacheLoadedAt <= 60_000) return cachedMemories;
      diskReads += 1;
      cachedMemories = diskMemories;
      cacheLoadedAt = nowMs;
      return cachedMemories;
    },
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
      ownerKey?: string
    ): Promise<{ cardsById: ReadonlyMap<string, unknown> }>;
  };
  const ownerKey = computeSupportPassportOwnerKey("owner:alice");

  assert.equal((await inspected.readStoredCardSnapshot(storage, "alice", ownerKey)).cardsById.size, 1);
  diskMemories = [];
  nowMs += 1_001;
  assert.equal((await inspected.readStoredCardSnapshot(storage, "alice", ownerKey)).cardsById.size, 1);
  assert.equal(calls, 2);
  assert.equal(diskReads, 1);
  nowMs += 59_000;

  assert.equal((await inspected.readStoredCardSnapshot(storage, "alice", ownerKey)).cardsById.size, 0);
  assert.equal(calls, 3);
  assert.equal(diskReads, 2);
});

test("guide assembly rechecks snapshot age after owner-lock delay", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-cache-"));
  try {
    await mkdir(path.join(root, "state"), { recursive: true });
    let nowMs = Date.parse("2026-08-11T12:00:00.000Z");
    let memories = [supportCardMemory()];
    const projected = projectSupportPassportCard(memories[0]);
    assert.ok(projected);
    const state: SupportPassportGrantState = {
      schemaVersion: 1,
      stateVersion: 1,
      grantId: "00000000-0000-4000-8000-000000000001",
      namespace: "alice",
      principalHash: computeSupportPassportOwnerKey("owner:alice"),
      ownerLockKey: "a".repeat(64),
      secretHash: "b".repeat(64),
      cards: [{ cardId: projected.card.cardId, revision: projected.card.revision }],
      createdAt: "2026-08-11T12:00:00.000Z",
      expiresAt: "2026-08-11T13:00:00.000Z",
    };
    const storage = {
      dir: root,
      getCorpusScanVersion: () => 1,
      hotCacheKeyId: () => "stable",
      hotCacheTtlMs: () => 1_000,
      isHotCacheEnabled: () => true,
      readAllMemories: async () => memories,
    } as unknown as StorageManager;
    const grantStore = {
      authenticate: async () => state,
      withAuthenticatedGrant: async <T>(
        _grantId: string,
        _secret: string,
        task: (current: SupportPassportGrantState) => Promise<T>,
        beforeReturn?: (current: SupportPassportGrantState) => Promise<void>
      ): Promise<T> => {
        nowMs += 1_001;
        memories = [];
        const result = await task(state);
        await beforeReturn?.(state);
        return result;
      },
    } as unknown as SupportPassportGrantStore;
    const service = new SupportPassportGrantService({
      grantStore,
      resolveOwner: async (principal) => ({ principal, namespace: "alice", storage }),
      resolveNamespace: async () => storage,
      now: () => new Date(nowMs),
    });

    await assert.rejects(
      service.readGrant({ grantId: state.grantId, secret: "secret" }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "grant_stale"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
