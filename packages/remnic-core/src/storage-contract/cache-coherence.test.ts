/**
 * Issue #1533 — Phase A contract test: cache coherence across instances.
 *
 * Rule 37 (memory-cache): write via instance A, read via a FRESH instance B
 * over the same dir → B sees the write. The module-level caches
 * (readAllMemories in-flight, version sentinels) are keyed by baseDir and
 * shared/static — this test pins that a write invalidates correctly so a
 * second instance never serves stale data.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { StorageManager } from "../storage.js";
import { resetStaticCaches } from "./harness.js";

test("cache-coherence: write via instance A, read via fresh instance B → B sees the write", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-cache-coherence-"));
  try {
    resetStaticCaches();
    const smA = new StorageManager(dir);
    await smA.ensureDirectories();

    const { id: id } = await smA.writeMemory("fact", "written by A");

    // Fresh instance over the same dir
    const smB = new StorageManager(dir);
    await smB.ensureDirectories();
    const found = await smB.getMemoryById(id);
    assert.ok(found, "instance B must see the memory written by instance A");
    assert.equal(found!.content, "written by A");
  } finally {
    resetStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});

test("cache-coherence: delete via instance A is reflected in fresh instance B", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-cache-del-"));
  try {
    resetStaticCaches();
    const smA = new StorageManager(dir);
    await smA.ensureDirectories();
    const { id: id } = await smA.writeMemory("fact", "to be deleted");

    // Confirm B sees it
    const smB = new StorageManager(dir);
    await smB.ensureDirectories();
    assert.ok(await smB.getMemoryById(id));

    // A deletes
    await smA.invalidateMemory(id);

    // Fresh instance C must NOT see it
    const smC = new StorageManager(dir);
    await smC.ensureDirectories();
    const found = await smC.getMemoryById(id);
    assert.equal(found, null, "fresh instance must not see a deleted memory");
  } finally {
    resetStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});

test("cache-coherence: readAllMemories reflects writes across instances after invalidation", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-cache-list-"));
  try {
    resetStaticCaches();
    const smA = new StorageManager(dir);
    await smA.ensureDirectories();
    await smA.writeMemory("fact", "first");
    await smA.writeMemory("decision", "second");

    const smB = new StorageManager(dir);
    await smB.ensureDirectories();
    const all = await smB.readAllMemories();
    assert.ok(all.length >= 2, "fresh instance must list all written memories");

    // Write more via A
    await smA.writeMemory("principle", "third");

    const smC = new StorageManager(dir);
    await smC.ensureDirectories();
    const allAfter = await smC.readAllMemories();
    assert.ok(allAfter.length >= 3, "fresh instance must see the additional write");
    assert.ok(allAfter.some((m) => m.content === "third"));
  } finally {
    resetStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});
