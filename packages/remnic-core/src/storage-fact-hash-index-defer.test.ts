import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

import { ContentHashIndex, StorageManager } from "./storage.js";

// Issue #1909 (Part B): writeMemory("fact") used to rewrite the whole
// fact-hash index (which grows with corpus size) on EVERY fact, even though
// the extraction persist path already batch-saves the authoritative superset
// once at the end. The
// `deferHashIndexSave` option marks the index dirty but skips the per-fact
// flush; single-write callers keep the immediate, crash-safe save.

async function withMemoryDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-hash-defer-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("deferred fact writes do NO per-fact index saves; a single flush persists all", async () => {
  await withMemoryDir(async (dir) => {
    const saveSpy = mock.method(ContentHashIndex.prototype, "save");
    try {
      const storage = new StorageManager(dir);

      // Write 10 facts with the defer flag — the per-fact hot path in
      // extraction persist. None of them should flush the index.
      for (let i = 0; i < 10; i += 1) {
        await storage.writeMemory("fact", `deferred fact number ${i}`, {
          source: "extraction",
          deferHashIndexSave: true,
        });
      }
      assert.equal(
        saveSpy.mock.callCount(),
        0,
        "deferred fact writes must not flush the index per fact (was 10 flushes)",
      );

      // All 10 hashes are live in the in-memory index (dirty), so same-session
      // dedup still works despite no disk flush.
      for (let i = 0; i < 10; i += 1) {
        assert.equal(await storage.hasFactContentHash(`deferred fact number ${i}`), true);
      }

      // One authoritative batch save (mirrors saveContentHashIndexes) persists
      // the whole superset in a single rewrite.
      saveSpy.mock.resetCalls();
      const index = await (storage as unknown as {
        getFactHashIndex: () => Promise<ContentHashIndex>;
      }).getFactHashIndex.call(storage);
      await index.save();
      assert.equal(saveSpy.mock.callCount(), 1, "exactly one batch save, down from 10+");
    } finally {
      saveSpy.mock.restore();
    }

    // A fresh session (new StorageManager) sees every hash on disk.
    const reopened = new StorageManager(dir);
    for (let i = 0; i < 10; i += 1) {
      assert.equal(
        await reopened.hasFactContentHash(`deferred fact number ${i}`),
        true,
        "batch-saved hashes survive into a new session",
      );
    }
  });
});

test("direct writeMemory('fact') without the flag persists the hash immediately", async () => {
  await withMemoryDir(async (dir) => {
    const saveSpy = mock.method(ContentHashIndex.prototype, "save");
    try {
      const storage = new StorageManager(dir);
      await storage.writeMemory("fact", "single write fact", { source: "manual" });
      assert.ok(saveSpy.mock.callCount() >= 1, "single-write callers flush immediately");
      assert.equal(await storage.hasFactContentHash("single write fact"), true);
    } finally {
      saveSpy.mock.restore();
    }

    // No batch save was performed by the caller, yet a fresh session still finds
    // the hash — it was flushed at write time (crash-safe).
    const reopened = new StorageManager(dir);
    assert.equal(await reopened.hasFactContentHash("single write fact"), true);
  });
});

test("promotion-style immediate write survives restart even with fact-hashes.ready present", async () => {
  // Issue #1909 review finding 2: promotion writes (profile/shared) do NOT
  // register with the orchestrator's batch save (no addContentHashDedup), so
  // they must keep their immediate per-fact index save. If they deferred, the
  // hash would be absent from fact-hashes.txt and — with fact-hashes.ready
  // present — a restart would trust the on-disk index (no rebuild) and MISS the
  // hash, re-creating the promoted fact on the next extraction.
  await withMemoryDir(async (dir) => {
    // Warm the index authoritative and create the .ready marker (empty backfill).
    const warm = new StorageManager(dir);
    assert.equal(await warm.hasFactContentHash("nothing yet"), false);
    // Promotion-style write: no deferHashIndexSave → immediate index flush.
    await warm.writeMemory("fact", "promoted profile fact", { source: "extraction" });

    // A fresh session with .ready present trusts the on-disk index (no rebuild).
    const restarted = new StorageManager(dir);
    assert.equal(
      await restarted.hasFactContentHash("promoted profile fact"),
      true,
      "the promoted hash is on disk and found after restart — no duplicate re-creation",
    );
  });
});

test("durability: deferred writes with NO batch save are rebuildable from on-disk facts (fail-open)", async () => {
  await withMemoryDir(async (dir) => {
    // Simulate a crash mid-extraction: facts written with deferHashIndexSave but
    // the process dies before saveContentHashIndexes runs. The fact-hash file is
    // never written, but the fact .md files ARE on disk.
    {
      const storage = new StorageManager(dir);
      for (let i = 0; i < 5; i += 1) {
        await storage.writeMemory("fact", `crash fact ${i}`, {
          source: "extraction",
          deferHashIndexSave: true,
        });
      }
      // Intentionally no batch save — the crash window.
    }

    // A new session rebuilds the index authoritatively from the on-disk facts
    // (ensureFactHashIndexAuthoritative), so dedup is correct and no data is lost.
    const recovered = new StorageManager(dir);
    for (let i = 0; i < 5; i += 1) {
      assert.equal(
        await recovered.hasFactContentHash(`crash fact ${i}`),
        true,
        "a lost hash is rebuilt from the durable fact corpus — never a data loss",
      );
    }
  });
});

test("concurrent deferred fact writes both land in the index (no lost update)", async () => {
  await withMemoryDir(async (dir) => {
    const storage = new StorageManager(dir);
    await Promise.all([
      storage.writeMemory("fact", "concurrent alpha", {
        source: "extraction",
        deferHashIndexSave: true,
      }),
      storage.writeMemory("fact", "concurrent beta", {
        source: "extraction",
        deferHashIndexSave: true,
      }),
    ]);
    const index = await (storage as unknown as {
      getFactHashIndex: () => Promise<ContentHashIndex>;
    }).getFactHashIndex.call(storage);
    await index.save();

    const reopened = new StorageManager(dir);
    assert.equal(await reopened.hasFactContentHash("concurrent alpha"), true);
    assert.equal(await reopened.hasFactContentHash("concurrent beta"), true);
  });
});

test("#1909 round 11: a deferred write with no batch save is rebuilt from the corpus on restart", async () => {
  // No fact-hashes.ready marker exists anymore — the fact-hash index is ALWAYS
  // rebuilt from the durable fact corpus on first use per process. So a deferred
  // write that never got flushed (crash before the batch save) is still deduped
  // after restart because the fact .md is on disk and the rebuild includes it.
  await withMemoryDir(async (dir) => {
    const readyPath = path.join(dir, "state", "fact-hashes.ready");
    const warm = new StorageManager(dir);
    await warm.writeMemory("fact", "windowed fact", {
      source: "extraction",
      deferHashIndexSave: true,
    });
    // CRASH: no batch save. Drop the instance.
    assert.equal(existsSync(readyPath), false, "no ready marker is ever written (round 11)");

    const restarted = new StorageManager(dir);
    assert.equal(
      await restarted.hasFactContentHash("windowed fact"),
      true,
      "the fact is rebuilt from the corpus — never lost from dedup",
    );
  });
});

test("#1909 round 11: the fact-hash ready marker is never written (always rebuild on start)", async () => {
  await withMemoryDir(async (dir) => {
    const readyPath = path.join(dir, "state", "fact-hashes.ready");
    const storage = new StorageManager(dir);
    await storage.writeMemory("fact", "a durable fact", { source: "manual" });
    assert.equal(await storage.hasFactContentHash("a durable fact"), true); // triggers rebuild
    assert.equal(existsSync(readyPath), false, "no ready marker written after a rebuild");

    // A fresh instance rebuilds authoritatively from the corpus and still dedups.
    const restarted = new StorageManager(dir);
    assert.equal(await restarted.hasFactContentHash("a durable fact"), true);
    assert.equal(existsSync(readyPath), false, "still no marker after the restart rebuild");
  });
});

test("#1909: saveMergingWithDisk unions with a concurrent writer instead of clobbering", async () => {
  // Review round 6 finding 2: two independent index instances (two processes)
  // that both snapshot an empty file must not clobber each other on save.
  await withMemoryDir(async (dir) => {
    const stateDir = path.join(dir, "state");
    await mkdir(stateDir, { recursive: true });
    const a = new ContentHashIndex(stateDir);
    const b = new ContentHashIndex(stateDir);
    await a.load();
    await b.load();
    a.add("interleaved fact A");
    b.add("interleaved fact B");

    // Interleave the saves: a blind whole-file overwrite by B would drop A's
    // hash; the union-merge preserves both regardless of order.
    await a.saveMergingWithDisk();
    await b.saveMergingWithDisk();

    const fresh = new ContentHashIndex(stateDir);
    await fresh.load();
    assert.ok(fresh.has("interleaved fact A"), "A's hash preserved after B's concurrent save");
    assert.ok(fresh.has("interleaved fact B"), "B's hash preserved");
  });
});

test("#1909: concurrent (parallel) merge-saves serialize via the file lock — both survive", async () => {
  // Review round 7 finding 2: the per-file advisory lock serializes the
  // read-union→write window across truly concurrent writers (here two instances
  // saving in parallel), closing the TOCTOU where both read {prior} then both
  // atomically replace and one drop wins.
  await withMemoryDir(async (dir) => {
    const stateDir = path.join(dir, "state");
    await mkdir(stateDir, { recursive: true });
    const a = new ContentHashIndex(stateDir);
    const b = new ContentHashIndex(stateDir);
    await a.load();
    await b.load();
    a.add("parallel fact A");
    b.add("parallel fact B");

    await Promise.all([a.saveMergingWithDisk(), b.saveMergingWithDisk()]);

    const fresh = new ContentHashIndex(stateDir);
    await fresh.load();
    assert.ok(fresh.has("parallel fact A"), "A survived the concurrent publish");
    assert.ok(fresh.has("parallel fact B"), "B survived the concurrent publish");
  });
});

test("#1909: removing a hash and reconcile-saving drops it from disk (no resurrection)", async () => {
  // Review round 7/8: a removal must never resurrect. The reconciling save is
  // removal-aware — it subtracts removed hashes from the latest on-disk state
  // rather than blindly unioning the pre-removal contents back in.
  await withMemoryDir(async (dir) => {
    const stateDir = path.join(dir, "state");
    await mkdir(stateDir, { recursive: true });
    const idx = new ContentHashIndex(stateDir);
    await idx.load();
    idx.add("archived fact body");
    await idx.save();
    const mid = new ContentHashIndex(stateDir);
    await mid.load();
    assert.ok(mid.has("archived fact body"), "hash is on disk before archival");

    // Archival: remove + reconciling save (the production saveContentHashIndexes path).
    idx.remove("archived fact body");
    await idx.saveMergingWithDisk();

    const fresh = new ContentHashIndex(stateDir);
    await fresh.load();
    assert.equal(
      fresh.has("archived fact body"),
      false,
      "removed hash stays gone → re-extraction of that content is allowed",
    );
  });
});

test("#1909: reconciling removal drops the removed hash AND preserves a concurrent append", async () => {
  // Review round 8 thread 3: removal and append batches serialize under the same
  // per-file lock and both reconcile with the latest on-disk state — so a removal
  // neither resurrects its own hash nor clobbers a concurrent extraction's append.
  await withMemoryDir(async (dir) => {
    const stateDir = path.join(dir, "state");
    await mkdir(stateDir, { recursive: true });
    const seed = new ContentHashIndex(stateDir);
    await seed.load();
    seed.add("to be archived");
    await seed.save();

    // Remover loads {archived} and marks it removed (not yet published).
    const remover = new ContentHashIndex(stateDir);
    await remover.load();
    remover.remove("to be archived");

    // Concurrent appender (another instance) adds a new hash and publishes first.
    const appender = new ContentHashIndex(stateDir);
    await appender.load();
    appender.add("freshly appended");
    await appender.saveMergingWithDisk();

    // Remover reconciles against the now-updated disk: drops its removal, keeps
    // the concurrent append.
    await remover.saveMergingWithDisk();

    const fresh = new ContentHashIndex(stateDir);
    await fresh.load();
    assert.equal(fresh.has("to be archived"), false, "removed hash dropped — no resurrection");
    assert.ok(fresh.has("freshly appended"), "concurrent append preserved — no clobber");
  });
});

test("#1909: saveMergingWithDisk is a no-op when the index is not dirty (dirty short-circuit)", async () => {
  // Review round 7 finding 3: a no-fact/deduped run must not re-read+rewrite the
  // whole fact-hashes.txt. An unmutated index skips the O(file) work entirely.
  await withMemoryDir(async (dir) => {
    const stateDir = path.join(dir, "state");
    await mkdir(stateDir, { recursive: true });
    const seed = new ContentHashIndex(stateDir);
    await seed.load();
    seed.add("seed fact");
    await seed.save();

    // A fresh instance that only LOADS (adds nothing) is not dirty → merge-save
    // writes nothing. Prove it by making a foreign writer append, then a clean
    // merge-save must NOT clobber that foreign row.
    const clean = new ContentHashIndex(stateDir);
    await clean.load();
    const foreign = new ContentHashIndex(stateDir);
    await foreign.load();
    foreign.add("foreign fact");
    await foreign.save();

    await clean.saveMergingWithDisk(); // not dirty → must be a no-op

    const fresh = new ContentHashIndex(stateDir);
    await fresh.load();
    assert.ok(fresh.has("seed fact"));
    assert.ok(fresh.has("foreign fact"), "a non-dirty merge-save did not rewrite/clobber the file");
  });
});

// Issue #1909 review round 14: the markerless authoritative rebuild
// (ensureFactHashIndexAuthoritative) used to read ONLY the hot tier
// (readAllMemories). A fact or procedure demoted to the cold tier is still
// active, so a restart dropped its content-hash from the dedup index and the
// next extraction re-created the demoted memory. The rebuild now unions the hot
// AND cold tiers (readAllColdMemories), so hashes survive a hot/cold restart.

test("#1909: rebuild indexes ACTIVE cold-tier facts; a demoted fact's hash survives restart", async () => {
  await withMemoryDir(async (dir) => {
    StorageManager.clearAllStaticCaches();
    const storage = new StorageManager(dir);

    // Two facts: one stays hot, one is demoted to cold.
    await storage.writeMemory("fact", "hot tier fact stays put", { source: "manual" });
    await storage.writeMemory("fact", "cold tier fact was demoted", { source: "manual" });

    storage.invalidateAllMemoriesCacheForDir();
    const demoted = (await storage.readAllMemories()).find(
      (m) => m.content.includes("cold tier fact was demoted"),
    );
    assert.ok(demoted, "the fact to demote must be readable in hot before migration");
    await storage.migrateMemoryToTier(demoted!, "cold");

    // Simulate a process restart: drop every static/in-memory cache and open a
    // fresh StorageManager over the same baseDir. Its first dedup lookup forces
    // a full corpus rebuild with no marker to trust.
    StorageManager.clearAllStaticCaches();
    const reopened = new StorageManager(dir);

    // The cold-demoted fact must be confirmed present in the rebuilt index (this
    // FAILS on a hot-only rebuild), and the hot fact must still be present too.
    assert.equal(
      await reopened.hasFactContentHash("cold tier fact was demoted"),
      true,
      "a fact demoted to cold must survive the corpus rebuild (hot+cold union)",
    );
    assert.equal(
      await reopened.hasFactContentHash("hot tier fact stays put"),
      true,
      "the hot-tier fact must also survive the rebuild",
    );
  });
});
