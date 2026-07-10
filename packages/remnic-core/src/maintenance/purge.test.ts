import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { purgeMemories } from "./purge.js";
import { rebuildMemoryProjection } from "./rebuild-memory-projection.js";
import { readProjectedMemoryBrowse } from "../memory-projection-store.js";
import { StorageManager } from "../storage.js";
import type { MemoryFile } from "../types.js";

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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
