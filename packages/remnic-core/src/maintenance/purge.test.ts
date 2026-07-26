import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { purgeMemories } from "./purge.js";
import { rebuildMemoryProjection } from "./rebuild-memory-projection.js";
import { readProjectedMemoryBrowse } from "../memory-projection-store.js";
import { StorageManager } from "../storage.js";
import type { MemoryFile } from "../types.js";
import { buildExplicitCaptureDedupKey } from "../storage/tombstone-blocked-capture-index.js";

test("purgeMemories records audit errors without blocking hard delete", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-purge-"));
  try {
    const memoryPath = path.join(dir, "cold-memory.md");
    await writeFile(memoryPath, "content", "utf8");
    await mkdir(path.join(dir, "state"), { recursive: true });
    await writeFile(path.join(dir, "state", "observation-ledger"), "not a directory", "utf8");

    const memory: MemoryFile = {
      path: memoryPath,
      content: "old cold memory",
      frontmatter: {
        id: "cold-1",
        category: "fact",
        created: "2026-01-01T00:00:00.000Z",
        updated: "2026-01-01T00:00:00.000Z",
        source: "test",
        confidence: 0.8,
        confidenceTier: "explicit",
        tags: [],
      },
    };

    const storage = {
      dir,
      readAllMemories: async () => [],
      readAllColdMemories: async () => [memory],
      readArchivedMemories: async () => [],
      deleteMemoryForMaintenance: async (candidate: MemoryFile) => {
        await unlink(candidate.path);
        return candidate;
      },
    };

    const result = await purgeMemories({
      storage: storage as never,
      olderThanMs: 1,
      dryRun: false,
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    });

    assert.equal(result.purgedCount, 1);
    assert.equal(result.errorCount, 2);
    assert.equal(result.errors[0]?.id, "(purge-audit)");
    assert.equal(result.errors[1]?.id, "(purge-audit)");
    assert.equal(await fileExists(memoryPath), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("purgeMemories invalidates projection rows for hard-deleted memories", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-purge-projection-"));
  try {
    const storage = new StorageManager(dir);
    const { id } = await storage.writeMemory("fact", "purge projection target", {
      source: "test",
    });
    const memory = await storage.getMemoryById(id);
    assert.ok(memory);
    await rebuildMemoryProjection({ memoryDir: dir, dryRun: false });
    assert.equal(readProjectedMemoryBrowse(dir, { limit: 5, offset: 0 })?.total, 1);

    const result = await purgeMemories({
      storage,
      olderThanMs: 1,
      tier: "all",
      dryRun: false,
      now: () => new Date(Date.now() + 86_400_000),
    });

    assert.equal(result.purgedCount, 1);
    assert.equal(readProjectedMemoryBrowse(dir, { limit: 5, offset: 0 })?.total, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("purgeMemories invalidates projection rows for already-absent files but not failed deletes, and dry-run never mutates", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-purge-projection-branches-"));
  try {
    // Real projection with two rows; candidates come from a mock storage so the
    // unlink outcomes are deterministic: one path is already absent (ENOENT),
    // the other is a non-empty directory (unlink fails, not ENOENT).
    const realStorage = new StorageManager(dir);
    const first = await realStorage.writeMemory("fact", "purge branch enoent", { source: "test" });
    const second = await realStorage.writeMemory("fact", "purge branch failure", { source: "test" });
    await rebuildMemoryProjection({ memoryDir: dir, dryRun: false });
    assert.equal(readProjectedMemoryBrowse(dir, { limit: 5, offset: 0 })?.total, 2);

    const firstMemory = await realStorage.getMemoryById(first.id);
    const secondMemory = await realStorage.getMemoryById(second.id);
    assert.ok(firstMemory && secondMemory);
    await rm(firstMemory.path);
    await rm(secondMemory.path);
    await mkdir(secondMemory.path);
    await writeFile(path.join(secondMemory.path, "block.txt"), "x", "utf8");

    const mockStorage = {
      dir,
      readAllMemories: async () => [firstMemory, secondMemory],
      readAllColdMemories: async () => [],
      deleteMemoryForMaintenance: async (candidate: MemoryFile) => {
        await unlink(candidate.path);
        return candidate;
      },
      readArchivedMemories: async () => [],
    };
    const future = () => new Date(Date.now() + 86_400_000);

    // Dry-run: no projection mutation.
    await purgeMemories({ storage: mockStorage as never, olderThanMs: 1, tier: "all", dryRun: true, now: future });
    assert.equal(readProjectedMemoryBrowse(dir, { limit: 5, offset: 0 })?.total, 2);

    const result = await purgeMemories({ storage: mockStorage as never, olderThanMs: 1, tier: "all", dryRun: false, now: future });

    assert.equal(result.alreadyAbsentCount, 1);
    assert.equal(result.purgedCount, 0);
    assert.equal(result.errors.filter((e) => e.id === second.id).length, 1);
    const page = readProjectedMemoryBrowse(dir, { limit: 5, offset: 0 });
    assert.ok(page);
    // ENOENT row invalidated; failed-delete row keeps its projection entry.
    assert.equal(page.total, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cleanExpiredCommitments coordinates blocked capture deletion", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-commitment-delete-lock-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    storage.setTombstonesConfig({
      enabled: true,
      semanticMatch: false,
      semanticThreshold: 0.9,
      namespace: "default",
    });
    const content = "A blocked commitment must not disappear under a concurrent capture.";
    const tombstoneId = await storage.appendTombstone({
      reason: "correction",
      createdBy: "user_correction",
      sourceMemoryId: "commitment-delete-lock",
      rawContent: content,
    });
    assert.ok(tombstoneId);
    const result = await storage.writeMemory("fact", content, {
      source: "test",
      sourceConnector: "provider-a",
    });
    assert.equal(result.tombstoneBlocked, true);
    const blocked = await storage.getMemoryById(result.id);
    assert.ok(blocked);
    assert.equal(
      await storage.writeMemoryFrontmatter(blocked, {
        category: "commitment",
        tags: ["fulfilled"],
      }),
      true,
    );
    const identity = buildExplicitCaptureDedupKey(content, "commitment", "provider-a");
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const held = storage.withTombstoneBlockedCaptureWriteLock(async () => {
      entered.resolve();
      await release.promise;
    }, identity);
    await entered.promise;

    let completed = false;
    const pending = storage.cleanExpiredCommitments(-1).then((deleted) => {
      completed = true;
      return deleted;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(completed, false, "commitment cleanup must wait for the blocked capture identity lock");
    release.resolve();
    await held;
    const deleted = await pending;
    assert.equal(deleted.length, 1);
    assert.equal(deleted[0]?.frontmatter.id, result.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("purgeMemories coordinates blocked capture deletion", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-purge-delete-lock-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    storage.setTombstonesConfig({
      enabled: true,
      semanticMatch: false,
      semanticThreshold: 0.9,
      namespace: "default",
    });
    const content = "A blocked memory must not disappear under a concurrent capture.";
    const tombstoneId = await storage.appendTombstone({
      reason: "correction",
      createdBy: "user_correction",
      sourceMemoryId: "purge-delete-lock",
      rawContent: content,
    });
    assert.ok(tombstoneId);
    const result = await storage.writeMemory("fact", content, {
      source: "test",
      sourceConnector: "provider-a",
    });
    assert.equal(result.tombstoneBlocked, true);
    const blocked = await storage.getMemoryById(result.id);
    assert.ok(blocked);
    const identity = buildExplicitCaptureDedupKey(content, "fact", "provider-a");
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const held = storage.withTombstoneBlockedCaptureWriteLock(async () => {
      entered.resolve();
      await release.promise;
    }, identity);
    await entered.promise;

    let completed = false;
    const pending = purgeMemories({
      storage,
      olderThanMs: 1,
      tier: "all",
      dryRun: false,
      now: () => new Date(Date.now() + 86_400_000),
    }).then((purged) => {
      completed = true;
      return purged;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(completed, false, "purge must wait for the blocked capture identity lock");
    release.resolve();
    await held;
    const purged = await pending;
    assert.equal(purged.purgedCount, 1);
    assert.equal(await fileExists(blocked.path), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("maintenance deletion prefers the candidate path when IDs overlap across tiers", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-delete-tier-path-"));
  try {
    StorageManager.clearAllStaticCaches();
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const content = "The cold candidate path must win when a hot copy shares its ID.";
    const result = await storage.writeMemory("fact", content, {
      source: "test",
      sourceConnector: "provider-a",
    });
    const hot = await storage.getMemoryById(result.id);
    assert.ok(hot);
    const coldPath = storage.buildTierMemoryPath(hot, "cold");
    await mkdir(path.dirname(coldPath), { recursive: true });
    await writeFile(coldPath, await readFile(hot.path));
    StorageManager.clearAllStaticCaches();

    const cold = (await storage.readAllColdMemories()).find((memory) => memory.frontmatter.id === result.id);
    assert.ok(cold);
    const removed = await storage.deleteMemoryForMaintenance(cold);
    assert.equal(removed?.path, coldPath);
    assert.equal(await fileExists(coldPath), false);
    assert.equal(await fileExists(hot.path), true);
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
