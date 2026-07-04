/**
 * #1533 Phase A — cache coherence across instances (issue done-when #6,
 * CLAUDE.md rule 37): a write via instance A is visible to a fresh instance B
 * constructed over the same dir. The module-level caches in `memory-cache.ts`
 * are keyed by baseDir; `StorageManager` invalidates its own dir's cache on
 * write. This test pins the cross-instance invariant — B must NOT serve a
 * stale empty snapshot after A writes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { StorageManager } from "../../packages/remnic-core/src/storage.js";
import { createScratchDir, withScratchDir } from "./helpers.js";
import { rm } from "node:fs/promises";

test("cache coherence: instance B (fresh, same dir) sees a memory written via instance A", async () => {
  await withScratchDir("cache-cross-instance", async (dir) => {
    const a = new StorageManager(dir);
    await a.ensureDirectories();
    const id = await a.writeMemory("fact", "shared fact body", { confidence: 0.9 });

    // Construct a SECOND StorageManager over the same dir AFTER the write — it
    // has its own in-process cache, but the on-disk state is authoritative and
    // the cache must not shadow it.
    const b = new StorageManager(dir);
    const seen = await b.getMemoryById(id);
    assert.ok(seen, "instance B must see the memory written by instance A (cross-instance coherence)");
    assert.equal(seen!.content, "shared fact body");

    const all = await b.readAllMemories();
    assert.equal(all.length, 1, "instance B readAllMemories must reflect A's write");
  });
});

test("cache coherence: instance B with a primed empty cache sees A's later write (stale-empty invalidation)", async () => {
  await withScratchDir("cache-stale-empty", async (dir) => {
    const a = new StorageManager(dir);
    await a.ensureDirectories();
    const b = new StorageManager(dir);
    await b.ensureDirectories();

    // Prime B's cache with an EMPTY snapshot BEFORE A writes anything. The
    // regression this guards: writeMemory stops invalidating an already-cached
    // empty snapshot, so B would keep serving a stale [] after A writes.
    const empty = await b.readAllMemories();
    assert.equal(empty.length, 0, "store is empty before A writes");

    // A writes — this must invalidate the baseDir-keyed cache so B does not
    // serve the stale empty snapshot it just cached.
    const id = await a.writeMemory("fact", "fact A writes after B primed empty", {
      confidence: 0.9,
    });

    const seen = await b.getMemoryById(id);
    assert.ok(seen, "B must see A's write despite having cached an empty snapshot first");
    const all = await b.readAllMemories();
    assert.equal(all.length, 1, "B readAllMemories must reflect A's write (stale-empty invalidation)");
  });
});

test("cache coherence: invalidateMemory on A is reflected on a fresh B", async () => {
  await withScratchDir("cache-cross-invalidate", async (dir) => {
    const a = new StorageManager(dir);
    await a.ensureDirectories();
    const id = await a.writeMemory("fact", "ephemeral", { confidence: 0.9 });
    const removed = await a.invalidateMemory(id);
    assert.equal(removed, true);

    const b = new StorageManager(dir);
    const seen = await b.getMemoryById(id);
    assert.equal(seen, null, "instance B must see the deletion performed by instance A");
  });
});
test("cache coherence: status version sentinel moves across instances after a status-changing write", async () => {
  await withScratchDir("cache-status-version", async (dir) => {
    const a = new StorageManager(dir);
    await a.ensureDirectories();
    const before = a.getMemoryStatusVersion();

    // writeMemory alone does NOT bump the status sentinel (only
    // invalidateAllMemoriesCache). Status-changing ops — writeEntity,
    // invalidateMemory, supersedeMemory, archiveMemories — call
    // bumpMemoryStatusVersion(). Use writeEntity to exercise the cross-instance
    // sentinel path; it persists to <dir>/state/.memory-status-version.log so
    // a fresh instance reads the advanced value.
    await a.writeEntity("Status Sentinel Entity", "person", ["fact"]);

    const b = new StorageManager(dir);
    const after = b.getMemoryStatusVersion();
    assert.ok(after > before, `status version must advance after a status-changing write (${before} → ${after})`);
  });
});

test("cache coherence: two instances over DIFFERENT dirs do not cross-contaminate", async () => {
  const dirA = await createScratchDir("cache-isolation-a");
  const dirB = await createScratchDir("cache-isolation-b");
  try {
    const a = new StorageManager(dirA);
    await a.ensureDirectories();
    const b = new StorageManager(dirB);
    await b.ensureDirectories();

    const id = await a.writeMemory("fact", "only in A", { confidence: 0.9 });
    const seenB = await b.getMemoryById(id);
    assert.equal(seenB, null, "instance over dir B must NOT see a memory written to dir A");
  } finally {
    await Promise.all([
      rm(dirA, { recursive: true, force: true }),
      rm(dirB, { recursive: true, force: true }),
    ]);
  }
});
