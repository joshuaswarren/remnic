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
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

type ScanSpy = { _readAllMemoriesFromDisk: () => Promise<unknown> };

function installScanSpy(sm: StorageManager): { scans: () => number } {
  const spy = sm as unknown as ScanSpy;
  const orig = spy._readAllMemoriesFromDisk.bind(sm);
  let count = 0;
  spy._readAllMemoriesFromDisk = async () => {
    count += 1;
    return orig();
  };
  return { scans: () => count };
}

test("hot cache (#1902): a warm readAllMemories() serves without re-scanning disk", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-hot-warm-"));
  try {
    resetStaticCaches();
    const sm = new StorageManager(dir);
    await sm.ensureDirectories();
    await sm.writeMemory("fact", "A");
    await sm.readAllMemories(); // warming scan populates the hot cache
    const spy = installScanSpy(sm);
    const warm = await sm.readAllMemories();
    assert.equal(spy.scans(), 0, "a warm read must not touch disk");
    assert.ok(warm.some((m) => m.content === "A"));
  } finally {
    resetStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});

test("hot cache (#1902): a single-file write patches the cache in place — next read stays warm", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-hot-patch-"));
  try {
    resetStaticCaches();
    const sm = new StorageManager(dir);
    await sm.ensureDirectories();
    await sm.writeMemory("fact", "A");
    await sm.readAllMemories(); // warm
    const spy = installScanSpy(sm);
    await sm.writeMemory("fact", "B"); // patch-on-write keeps the entry warm
    const after = await sm.readAllMemories();
    assert.equal(spy.scans(), 0, "patch-on-write must keep the cache warm (no rescan)");
    assert.ok(after.some((m) => m.content === "B"), "the newly written fact is present");
    assert.ok(after.some((m) => m.content === "A"), "the prior fact survives the patch");
  } finally {
    resetStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});

test("hot cache (#1902): a peer corpus-version bump forces exactly one rescan (cross-process coherence)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-hot-peer-"));
  try {
    resetStaticCaches();
    const sm = new StorageManager(dir);
    await sm.ensureDirectories();
    await sm.writeMemory("fact", "A");
    await sm.readAllMemories(); // warm
    const spy = installScanSpy(sm);
    // Simulate a peer process advancing the on-disk corpus sentinel (its byte
    // size IS the version). This instance's warm entry is now stale-versioned.
    await appendFile(path.join(dir, "state", ".memory-corpus-version.log"), "x");
    const afterPeer = await sm.readAllMemories();
    assert.equal(spy.scans(), 1, "a peer sentinel bump must force exactly one rescan");
    assert.ok(afterPeer.some((m) => m.content === "A"));
  } finally {
    resetStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});

test("hot cache (#1902): a delete rescans and drops the removed memory", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-hot-del-"));
  try {
    resetStaticCaches();
    const sm = new StorageManager(dir);
    await sm.ensureDirectories();
    const { id } = await sm.writeMemory("fact", "A");
    await sm.writeMemory("fact", "B");
    await sm.readAllMemories(); // warm
    await sm.invalidateMemory(id); // delete drops the hot layer wholesale
    const after = await sm.readAllMemories();
    assert.ok(after.some((m) => m.content === "B"), "surviving memory remains");
    assert.ok(!after.some((m) => m.content === "A"), "the deleted memory is gone");
  } finally {
    resetStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});

test("hot cache (#1902/#1904 compat): a plain fact create does NOT bump memory-status (entity cache stays warm)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-hot-status-"));
  try {
    resetStaticCaches();
    const sm = new StorageManager(dir);
    await sm.ensureDirectories();
    await sm.writeMemory("fact", "seed"); // establish the state dir + baseline
    const before = sm.getMemoryStatusVersion();
    await sm.writeMemory("fact", "another create");
    assert.equal(
      sm.getMemoryStatusVersion(),
      before,
      "a plain fact create must not bump memory-status (the entity cache keys on it)",
    );
  } finally {
    resetStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});

test("hot cache (#1902): hotMemoriesCacheEnabled=false forces every read to rescan", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-hot-off-"));
  try {
    resetStaticCaches();
    const sm = new StorageManager(dir, undefined, false); // gate off
    await sm.ensureDirectories();
    await sm.writeMemory("fact", "A");
    const spy = installScanSpy(sm);
    await sm.readAllMemories();
    await sm.readAllMemories();
    assert.equal(spy.scans(), 2, "with the cache disabled, each sequential read scans disk");
  } finally {
    resetStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});
