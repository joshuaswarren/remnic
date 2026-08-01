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
import { appendFile, mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
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

test("hot cache (#1902): the gate default is isolated per memory dir (Codex P2)", async () => {
  const dirOff = await mkdtemp(path.join(os.tmpdir(), "remnic-hot-perdir-off-"));
  const dirOn = await mkdtemp(path.join(os.tmpdir(), "remnic-hot-perdir-on-"));
  try {
    resetStaticCaches();
    // Register divergent per-dir settings; a later registration must NOT flip
    // an earlier dir's behavior (the "last orchestrator wins" bug).
    StorageManager.setHotMemoriesCacheDefault(dirOff, false);
    StorageManager.setHotMemoriesCacheDefault(dirOn, true);
    // Constructed WITHOUT a per-instance override, so each resolves its own
    // dir's registered default.
    const smOff = new StorageManager(dirOff);
    const smOn = new StorageManager(dirOn);
    await smOff.ensureDirectories();
    await smOff.writeMemory("fact", "A");
    await smOn.ensureDirectories();
    await smOn.writeMemory("fact", "B");
    const spyOff = installScanSpy(smOff);
    const spyOn = installScanSpy(smOn);
    await smOff.readAllMemories();
    await smOff.readAllMemories();
    await smOn.readAllMemories();
    await smOn.readAllMemories();
    assert.equal(spyOff.scans(), 2, "dir registered false rescans on every read");
    assert.equal(spyOn.scans(), 1, "dir registered true serves the second read from cache");
  } finally {
    resetStaticCaches();
    await rm(dirOff, { recursive: true, force: true });
    await rm(dirOn, { recursive: true, force: true });
  }
});

test("hot cache (#1902): flushAccessTracking patches locally + bumps for cross-process coherence", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-hot-access-"));
  try {
    resetStaticCaches();
    const sm = new StorageManager(dir);
    await sm.ensureDirectories();
    const { id } = await sm.writeMemory("fact", "trackable");
    // Warm the cache.
    const warm = await sm.readAllMemories();
    assert.equal(warm.length, 1);
    const versionBefore = sm.getMemoryCorpusVersion();
    const spy = installScanSpy(sm);
    await sm.flushAccessTracking([
      { memoryId: id, newCount: 7, lastAccessed: "2026-07-16T00:00:00.000Z" },
    ]);
    const after = await sm.readAllMemories();
    // Local process: patched in place + re-keyed, so no rescan and fresh counts.
    assert.equal(spy.scans(), 0, "access-tracking flush must not rescan the corpus locally");
    const m = after.find((x) => x.frontmatter.id === id);
    assert.equal(m?.frontmatter.accessCount, 7, "hot cache reflects the flushed access count");
    assert.equal(m?.frontmatter.lastAccessed, "2026-07-16T00:00:00.000Z");
    // Cross-process: the shared sentinel advanced so peer processes rescan and
    // never overwrite this process's increment (Codex P2).
    assert.ok(
      sm.getMemoryCorpusVersion() > versionBefore,
      "access-tracking flush advances the corpus sentinel for peer coherence",
    );
  } finally {
    resetStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});

test("hot cache (#1902): ensureDirectories activates a version-0 corpus so reads cache (Cursor Medium)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-hot-zero-"));
  try {
    resetStaticCaches();
    // Simulate an existing corpus with NO sentinel yet: write a fact file
    // directly to disk (bypassing StorageManager, so nothing bumps the sentinel).
    await mkdir(path.join(dir, "facts"), { recursive: true });
    await writeFile(path.join(dir, "facts", "a.md"), "---\nid: fact-a\n---\nA");
    const sm = new StorageManager(dir);
    assert.equal(sm.getMemoryCorpusVersion(), 0, "precondition: sentinel starts at 0");
    // The daemon calls ensureDirectories() at startup (before serving reads); it
    // seeds a nonzero sentinel so the hot path engages on a read-heavy workload.
    await sm.ensureDirectories();
    assert.ok(sm.getMemoryCorpusVersion() > 0, "ensureDirectories activates the sentinel");
    const spy = installScanSpy(sm);
    const first = await sm.readAllMemories();
    assert.equal(first.length, 1);
    await sm.readAllMemories();
    assert.equal(spy.scans(), 1, "second read is served from cache — activation worked");
  } finally {
    resetStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});

test("hot cache (#1902): an empty corpus is served from cache, not rescanned (kilo null-check)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-hot-empty-"));
  try {
    resetStaticCaches();
    const sm = new StorageManager(dir);
    // ensureDirectories activates the sentinel (version > 0); the corpus is empty.
    await sm.ensureDirectories();
    const first = await sm.readAllMemories();
    assert.equal(first.length, 0, "corpus is empty");
    const spy = installScanSpy(sm);
    await sm.readAllMemories();
    await sm.readAllMemories();
    // getCachedMemories returns [] (falsy) for an empty corpus; the read guard
    // must null-check, not truthiness-check, or every read rescans.
    assert.equal(spy.scans(), 0, "empty corpus is served from cache on repeat reads");
  } finally {
    resetStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});
test("hot cache (#2020): path-scoped access flush updates the cited duplicate ID file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-hot-access-path-"));
  try {
    resetStaticCaches();
    const sm = new StorageManager(dir);
    await sm.ensureDirectories();
    await sm.writeMemory("fact", "first duplicate");
    await sm.writeMemory("fact", "second duplicate");
    const initial = await sm.readAllMemories();
    const first = initial.find((memory) => memory.content === "first duplicate");
    const second = initial.find((memory) => memory.content === "second duplicate");
    assert.ok(first);
    assert.ok(second);

    const secondFile = await readFile(second.path, "utf8");
    await writeFile(second.path, secondFile.replace(/^id: .*$/m, `id: ${first.frontmatter.id}`));
    resetStaticCaches();
    const fresh = new StorageManager(dir);
    await fresh.ensureDirectories();
    await fresh.flushAccessTracking([
      {
        memoryId: first.frontmatter.id,
        memoryPath: first.path,
        newCount: 17,
        lastAccessed: "2026-07-19T00:00:00.000Z",
      },
    ]);

    const after = await fresh.readAllMemories();
    assert.equal(after.find((memory) => memory.path === first.path)?.frontmatter.accessCount, 17);
    assert.notEqual(after.find((memory) => memory.path === second.path)?.frontmatter.accessCount, 17);
  } finally {
    resetStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});
test("citation path lookup returns every duplicate when no preferred path matches", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-citation-duplicates-"));
  try {
    resetStaticCaches();
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    await storage.writeMemory("fact", "first duplicate");
    await storage.writeMemory("fact", "second duplicate");
    const initial = await storage.readAllMemories();
    const first = initial.find((memory) => memory.content === "first duplicate");
    const second = initial.find((memory) => memory.content === "second duplicate");
    assert.ok(first);
    assert.ok(second);

    const secondFile = await readFile(second.path, "utf8");
    const duplicatePath = path.join(dir, "facts", "duplicate", path.basename(first.path));
    await mkdir(path.dirname(duplicatePath), { recursive: true });
    await writeFile(
      duplicatePath,
      secondFile.replace(/^id: .*$/m, `id: ${first.frontmatter.id}`),
    );
    await rm(second.path);
    resetStaticCaches();
    const fresh = new StorageManager(dir);
    await fresh.ensureDirectories();

    const found = await fresh.findExistingMemoryPaths(
      [first.frontmatter.id],
      new Map([[first.frontmatter.id, ["/missing/preferred/path.md"]]]),
    );

    assert.deepEqual(found.get(first.frontmatter.id)?.sort(), [first.path, duplicatePath].sort());
  } finally {
    resetStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});

test("citation path lookup resolves collection-prefixed QMD paths", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-citation-path-"));
  try {
    resetStaticCaches();
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const { id } = await storage.writeMemory("fact", "citation target");
    const [memory] = await storage.readAllMemories();
    assert.ok(memory);

    const found = await storage.findExistingMemoryPaths(
      [id],
      new Map([[id, [`collection/${path.relative(dir, memory.path)}`]]]),
    );

    assert.deepEqual(found.get(id), [memory.path]);
  } finally {
    resetStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});
test("memory snapshots ignore object key order", async () => {
  const { createMemorySnapshot } = await import("../storage/canonical-snapshot.js");
  type SnapshotInput = Parameters<typeof createMemorySnapshot>[0];
  const first = {
    content: "payload",
    frontmatter: { z: 1, nested: { y: 2, x: 3 } },
  } as unknown as SnapshotInput;
  const second = {
    frontmatter: { nested: { x: 3, y: 2 }, z: 1 },
    content: "payload",
  } as unknown as SnapshotInput;
  assert.equal(createMemorySnapshot(first), createMemorySnapshot(second));
});

test("tier move: caller-only mutation is not persisted by moveMemoryToPath", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-caller-mut-"));
  try {
    resetStaticCaches();
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const { id } = await storage.writeMemory("fact", "original disk content");
    const memories = await storage.readAllMemories();
    const memory = memories.find((m) => m.frontmatter.id === id);
    assert.ok(memory, "memory must exist");

    memory.content = "caller mutated unpersisted content";

    const targetPath = storage.buildTierMemoryPath(memory, "cold");
    await storage.moveMemoryToPath(memory, targetPath);

    const onDisk = await readFile(targetPath, "utf8");
    assert.ok(onDisk.includes("original disk content"), "Moved file on disk must retain original content");
    assert.ok(!onDisk.includes("caller mutated unpersisted content"), "Moved file on disk must not carry caller's unpersisted content mutation");
  } finally {
    resetStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});

test("tier move: stale on-disk mutation fails snapshot check during move", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-stale-disk-"));
  try {
    resetStaticCaches();
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const { id } = await storage.writeMemory("fact", "unmodified content");
    const memories = await storage.readAllMemories();
    const memory = memories.find((m) => m.frontmatter.id === id);
    assert.ok(memory, "memory must exist");

    const diskContent = await readFile(memory.path, "utf8");
    await writeFile(memory.path, diskContent.replace("unmodified content", "external edit on disk"));

    const targetPath = storage.buildTierMemoryPath(memory, "cold");
    await assert.rejects(
      async () => {
        await storage.moveMemoryToPath(memory, targetPath);
      },
      (err: Error) => {
        return err.message.includes("changed before its tier move");
      }
    );
  } finally {
    resetStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});

test("tier move: cold-to-hot move invalidates cold cache and cannot remain in readAllColdMemories", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-cold-to-hot-"));
  try {
    resetStaticCaches();
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const { id } = await storage.writeMemory("fact", "demoted to cold then promoted");
    const memories = await storage.readAllMemories();
    const memory = memories.find((m) => m.frontmatter.id === id);
    assert.ok(memory, "memory must exist");

    const { targetPath: coldPath } = await storage.migrateMemoryToTier(memory, "cold");

    const coldMemories = await storage.readAllColdMemories();
    const coldMem = coldMemories.find((m) => m.frontmatter.id === id);
    assert.ok(coldMem, "memory must be present in cold tier read");

    const { changed } = await storage.migrateMemoryToTier(coldMem, "hot");
    assert.equal(changed, true, "migration from cold to hot must succeed");

    const coldMemoriesAfter = await storage.readAllColdMemories();
    const foundInCold = coldMemoriesAfter.some((m) => m.frontmatter.id === id);
    assert.equal(foundInCold, false, "promoted memory must not remain in readAllColdMemories cache");
  } finally {
    resetStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});
