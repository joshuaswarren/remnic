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
import { appendFile, mkdtemp, mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
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

test("hot cache (#1902/#1904 compat): a plain fact create does NOT bump memory-status", async () => {
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

test("hot cache (#1902): a legacy store bootstraps a non-zero sentinel and warms after one scan", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-hot-bootstrap-"));
  try {
    resetStaticCaches();
    const seed = new StorageManager(dir);
    await seed.ensureDirectories();
    await seed.writeMemory("fact", "legacy seed");
    await unlink(path.join(dir, "state", ".memory-corpus-version.log"));
    resetStaticCaches();

    const sm = new StorageManager(dir);
    const spy = installScanSpy(sm);
    await sm.readAllMemories();
    await sm.readAllMemories();
    assert.equal(sm.getMemoryCorpusVersion() > 0, true);
    assert.equal((await stat(path.join(dir, "state", ".memory-corpus-version.log"))).size > 0, true);
    assert.equal(spy.scans(), 1, "read-only legacy corpora should scan once, then stay warm");
  } finally {
    resetStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});

test("hot cache (#1902): a peer raw write plus sentinel bump is visible after exactly one rescan", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-hot-peer-write-"));
  try {
    resetStaticCaches();
    const sm = new StorageManager(dir);
    await sm.ensureDirectories();
    const { id } = await sm.writeMemory("fact", "local seed");
    const seed = await sm.getMemoryById(id);
    assert.ok(seed);
    await sm.readAllMemories();
    const spy = installScanSpy(sm);

    const peerId = "peer-raw-write";
    const peerPath = path.join(path.dirname(seed!.path), `${peerId}.md`);
    const raw = await readFile(seed!.path, "utf-8");
    await writeFile(
      peerPath,
      raw.replace(`id: ${id}`, `id: ${peerId}`).replace("local seed", "written by peer"),
      "utf-8",
    );
    await appendFile(path.join(dir, "state", ".memory-corpus-version.log"), "x");

    const after = await sm.readAllMemories();
    assert.equal(spy.scans(), 1);
    assert.ok(after.some((memory) => memory.frontmatter.id === peerId && memory.content === "written by peer"));
    await sm.readAllMemories();
    assert.equal(spy.scans(), 1, "the peer-rescan result should become the new warm entry");
  } finally {
    resetStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});

test("hot cache (#1902): tier classification is relative to the store root", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "remnic-hot-tier-"));
  const dir = path.join(parent, "cold", "archive", "store");
  try {
    await mkdir(dir, { recursive: true });
    resetStaticCaches();
    const sm = new StorageManager(dir);
    await sm.writeMemory("fact", "A");
    await sm.readAllMemories();
    const spy = installScanSpy(sm);
    await sm.writeMemory("fact", "B");
    const after = await sm.readAllMemories();
    assert.equal(spy.scans(), 0, "ancestor names cold/archive must not misclassify active files");
    assert.deepEqual(after.map((memory) => memory.content).sort(), ["A", "B"]);
  } finally {
    resetStaticCaches();
    await rm(parent, { recursive: true, force: true });
  }
});

test("hot cache (#1902): cache gating remains per instance", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-hot-instance-gate-"));
  try {
    resetStaticCaches();
    const enabled = new StorageManager(dir, undefined, true);
    const disabled = new StorageManager(dir, undefined, false);
    await enabled.writeMemory("fact", "A");
    await enabled.readAllMemories();
    const enabledSpy = installScanSpy(enabled);
    const disabledSpy = installScanSpy(disabled);

    await disabled.readAllMemories();
    await disabled.readAllMemories();
    await enabled.readAllMemories();
    assert.equal(disabledSpy.scans(), 2, "disabled instance must ignore a peer's warm cache");
    assert.equal(enabledSpy.scans(), 0, "enabled instance must remain warm");
  } finally {
    resetStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});

test("hot cache (#1902): active mutation matrix never serves pre-mutation objects", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-hot-mutations-"));
  try {
    resetStaticCaches();
    const sm = new StorageManager(dir);

    const { id: parentId } = await sm.writeMemory("fact", "parent");
    await sm.readAllMemories();
    const warmSpy = installScanSpy(sm);
    await sm.writeChunk(parentId, 0, 1, "fact", "chunk body");
    assert.ok((await sm.readAllMemories()).some((memory) => memory.frontmatter.parentId === parentId));
    assert.equal(warmSpy.scans(), 0, "chunk writes should patch the warm entry");

    await sm.flushAccessTracking([{
      memoryId: parentId,
      newCount: 7,
      lastAccessed: "2026-07-16T00:00:00.000Z",
    }]);
    assert.equal((await sm.getMemoryById(parentId))?.frontmatter.accessCount, 7);
    assert.equal(warmSpy.scans(), 0, "access tracking should patch the warm entry");

    const { id: ttlId } = await sm.writeMemory("fact", "expired ttl", {
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    await sm.cleanExpiredTTL();
    assert.equal(await sm.getMemoryById(ttlId), null, "TTL cleanup must remove the warm object");

    const { id: commitmentId } = await sm.writeMemory("commitment", "fulfilled", {
      tags: ["fulfilled"],
    });
    const commitment = await sm.getMemoryById(commitmentId);
    assert.ok(commitment);
    await sm.writeMemoryFrontmatter(commitment!, { updated: "2000-01-01T00:00:00.000Z" });
    await sm.cleanExpiredCommitments(1);
    assert.equal(await sm.getMemoryById(commitmentId), null, "commitment decay must remove the warm object");

    const { id: archivedId } = await sm.writeMemory("fact", "archive me");
    const archived = await sm.getMemoryById(archivedId);
    assert.ok(archived);
    assert.ok(await sm.archiveMemory(archived!));
    assert.equal(await sm.getMemoryById(archivedId), null, "archive moves must remove the active warm object");

    const { id: oldId } = await sm.writeMemory("fact", "old truth");
    const { id: newId } = await sm.writeMemory("fact", "new truth");
    assert.equal(await sm.supersedeMemory(oldId, newId, "test"), true);
    assert.equal((await sm.getMemoryById(oldId))?.frontmatter.status, "superseded");
  } finally {
    resetStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});
