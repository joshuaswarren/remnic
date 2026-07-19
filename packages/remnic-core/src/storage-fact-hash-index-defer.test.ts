import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

import { ContentHashIndex, FactHashIndexNotAuthoritativeError, StorageManager } from "./storage.js";
import type { MemoryFile } from "./types.js";

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

test("direct writeMemory('fact') without the flag persists the hash via the LOCKED reconcile", async () => {
  // PR #2016 thread SDyCk: a direct (non-deferred) fact write used to publish
  // fact-hashes.txt with the unlocked whole-file save(), which can clobber — or
  // be clobbered by — a peer's concurrent locked rebuild/reconcile. It now flushes
  // through the SAME cross-process locked reconcile the batch/append/rebuild paths
  // use (saveMergingWithDisk), never the unlocked save().
  await withMemoryDir(async (dir) => {
    const saveSpy = mock.method(ContentHashIndex.prototype, "save");
    const reconcileSpy = mock.method(ContentHashIndex.prototype, "saveMergingWithDisk");
    try {
      const storage = new StorageManager(dir);
      await storage.writeMemory("fact", "single write fact", { source: "manual" });
      assert.ok(
        reconcileSpy.mock.callCount() >= 1,
        "single-write callers flush via the locked reconcile (saveMergingWithDisk)",
      );
      assert.equal(
        saveSpy.mock.callCount(),
        0,
        "the direct write must NOT use the unlocked whole-file save()",
      );
      assert.equal(await storage.hasFactContentHash("single write fact"), true);
    } finally {
      saveSpy.mock.restore();
      reconcileSpy.mock.restore();
    }

    // No batch save was performed by the caller, yet a fresh session still finds
    // the hash — it was flushed at write time (crash-safe).
    const reopened = new StorageManager(dir);
    assert.equal(await reopened.hasFactContentHash("single write fact"), true);
  });
});

test("#2016 thread SDzOT: a fact hash added during the authoritative rebuild's corpus scan is not lost", async () => {
  // The rebuild used to build a fresh `factOnly` set and publish it with
  // `this.factOnlyHashes = factOnly`, dropping any concurrent in-process
  // writeMemory that added to the LIVE set during the readAllMemories /
  // readAllColdMemories awaits. The rebuild now repopulates the live set in place
  // (clear + add), so a concurrent add survives publication — exactly as the
  // shared index preserves concurrent adds by mutating its `hashes` set in place.
  await withMemoryDir(async (dir) => {
    const storage = new StorageManager(dir);
    // One durable fact so the rebuild has corpus content to scan.
    await storage.writeMemory("fact", "alpha established fact", { source: "extraction" });

    const s = storage as unknown as {
      factOnlyHashes: Set<string>;
      factHashIndexAuthoritative: boolean | null;
      readAllColdMemories: () => Promise<unknown[]>;
      ensureFactHashIndexAuthoritative: () => Promise<boolean>;
    };
    const sentinel = "sentinel-concurrent-fact-hash";
    const realCold = s.readAllColdMemories.bind(storage);
    let injected = false;
    // Interpose on the SECOND corpus await inside the rebuild (after clear()):
    // simulate a concurrent writeMemory adding a fact hash to the live set while
    // the rebuild is mid-scan.
    s.readAllColdMemories = async () => {
      const res = await realCold();
      if (!injected) {
        injected = true;
        s.factOnlyHashes.add(sentinel);
      }
      return res;
    };

    // Force a fresh authoritative rebuild (clear -> scan -> publish).
    s.factHashIndexAuthoritative = null;
    assert.equal(await s.ensureFactHashIndexAuthoritative(), true, "rebuild published");

    assert.equal(
      s.factOnlyHashes.has(sentinel),
      true,
      "a fact hash added during the rebuild scan must survive publication (lost under reassign)",
    );
    // The corpus fact is present too — the in-place repopulate did not drop it.
    assert.equal(await storage.hasFactContentHash("alpha established fact"), true);
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

// PR #2016: when saveMergingWithDisk cannot acquire the cross-process lock in
// time, it used to resolve "successfully" while retaining the added hash ONLY
// in this process's memory — a silent gap. A long-lived peer that already built
// its authoritative in-memory index would never see the write, and no later
// save was guaranteed. The fix schedules a bounded, durable background retry
// that keeps re-attempting the locked publish until the addition lands.
//
// These tests hold the advisory lock deterministically (write the <index>.lock
// file with a fresh mtime so it is neither acquirable nor stale-breakable within
// the short test window) and use small injected lock/retry timings.
//
// ts-no-test-timers exception (same rationale as serialize-mutations.test.ts):
// the retry is driven by a REAL setTimeout coupled to withHeldFileLock's REAL
// filesystem mtime-staleness + poll loop — fake timers cannot advance the fs
// lock's platform clock, so time control here must be real. We never guess a
// duration: each test awaits the code's own `whenReconcileRetrySettled()`
// signal. The retry timer is `unref`'d in production so a pending retry never
// keeps a daemon alive, which means an awaiting test needs a ref'd keep-alive
// interval to hold the event loop open until that signal fires; it is cleared
// the instant the retry chain settles.

async function withRetryLoopAlive(run: () => Promise<void>): Promise<void> {
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await run();
  } finally {
    clearInterval(keepAlive);
  }
}

test("#2016: a lock-timed-out append is NOT silently dropped and eventually persists via durable retry", async () => {
  await withMemoryDir(async (dir) => {
    const stateDir = path.join(dir, "state");
    await mkdir(stateDir, { recursive: true });
    const lockPath = path.join(stateDir, "fact-hashes.txt.lock");

    // A peer holds the lock: a fresh, non-stale lock file the acquirer cannot take.
    await writeFile(lockPath, `99999 peer-owner ${new Date().toISOString()}\n`);

    const idx = new ContentHashIndex(stateDir, undefined, undefined, undefined, {
      maxWaitMs: 50,
      pollMs: 10,
      retryBaseMs: 15,
      retryMaxAttempts: 5,
    });
    await idx.load();
    idx.add("deferred-under-contended-lock");

    // The batch save times out on the lock. It must NOT publish (peer's lock is
    // held) but MUST arm a durable retry instead of resolving as "complete".
    await idx.saveMergingWithDisk();
    assert.equal(idx.hasPendingReconcileRetry, true, "a durable retry must be armed after the lock timeout");

    // Disk is untouched while the lock is held — proves it did not write unlocked.
    const early = new ContentHashIndex(stateDir);
    await early.load();
    assert.equal(early.has("deferred-under-contended-lock"), false, "no unlocked publish while the peer holds the lock");
    // In-memory dedup still works this session (dirty addition retained).
    assert.equal(idx.has("deferred-under-contended-lock"), true, "addition stays live in-memory");

    // The peer releases the lock; the background retry must then land the write.
    await rm(lockPath, { force: true });
    await withRetryLoopAlive(() => idx.whenReconcileRetrySettled());

    assert.equal(idx.hasPendingReconcileRetry, false, "retry chain settled after publishing");
    const fresh = new ContentHashIndex(stateDir);
    await fresh.load();
    assert.ok(
      fresh.has("deferred-under-contended-lock"),
      "the deferred addition eventually reached disk via the durable retry",
    );
  });
});

test("#2016: exhausting retries under a permanently held lock is best-effort, never a fatal append failure", async () => {
  await withMemoryDir(async (dir) => {
    const stateDir = path.join(dir, "state");
    await mkdir(stateDir, { recursive: true });
    const lockPath = path.join(stateDir, "fact-hashes.txt.lock");
    await writeFile(lockPath, `99999 peer-owner ${new Date().toISOString()}\n`);

    const idx = new ContentHashIndex(stateDir, undefined, undefined, undefined, {
      maxWaitMs: 25,
      pollMs: 10,
      retryBaseMs: 10,
      retryMaxAttempts: 2,
    });
    await idx.load();
    idx.add("never-persistable-while-locked");

    // The save resolves (best-effort) — a busy lock must never throw and turn a
    // durable-.md append into a fatal failure.
    await assert.doesNotReject(idx.saveMergingWithDisk());

    // Let the bounded retry chain run to exhaustion (lock is never released).
    await withRetryLoopAlive(() => idx.whenReconcileRetrySettled());

    assert.equal(idx.hasPendingReconcileRetry, false, "retries are bounded — the chain gives up, it does not spin forever");
    // The addition is still held in-memory (dedup stays correct this session);
    // disk stays empty, so the corpus-rebuild-on-restart safety net covers it.
    assert.equal(idx.has("never-persistable-while-locked"), true, "addition retained in-memory after giving up");
    const fresh = new ContentHashIndex(stateDir);
    await fresh.load();
    assert.equal(fresh.has("never-persistable-while-locked"), false, "nothing written unlocked while the lock stayed held");
  });
});

test("#2016: successive lock-timed-out saves do not stack duplicate retries (reentrancy guard)", async () => {
  await withMemoryDir(async (dir) => {
    const stateDir = path.join(dir, "state");
    await mkdir(stateDir, { recursive: true });
    const lockPath = path.join(stateDir, "fact-hashes.txt.lock");
    await writeFile(lockPath, `99999 peer-owner ${new Date().toISOString()}\n`);

    const idx = new ContentHashIndex(stateDir, undefined, undefined, undefined, {
      maxWaitMs: 40,
      pollMs: 10,
      retryBaseMs: 500, // long enough that neither timed-out save fires the retry mid-test
      retryMaxAttempts: 5,
    });
    await idx.load();
    idx.add("first-deferred");
    await idx.saveMergingWithDisk();
    assert.equal(idx.hasPendingReconcileRetry, true, "first timeout arms exactly one retry");

    // A second timed-out save while a retry is already armed must be a no-op for
    // scheduling — the single armed timer is the reentrancy guard.
    idx.add("second-deferred");
    await idx.saveMergingWithDisk();
    assert.equal(idx.hasPendingReconcileRetry, true, "still exactly one retry armed (no duplicate/parallel retries)");

    // Release the lock and let the single retry drain BOTH deferred additions in
    // one locked publish.
    await rm(lockPath, { force: true });
    await withRetryLoopAlive(() => idx.whenReconcileRetrySettled());

    const fresh = new ContentHashIndex(stateDir);
    await fresh.load();
    assert.ok(fresh.has("first-deferred"), "first deferred addition persisted");
    assert.ok(fresh.has("second-deferred"), "second deferred addition persisted by the same single retry");
  });
});

// PR #2016 (startup hash-index rebuild race): ensureFactHashIndexAuthoritative
// used to run its corpus scan and publish with an UNLOCKED clear→scan→save().
// A peer process that committed a newer hash to fact-hashes.txt under the
// per-file lock — or landed a deferred reconcile-retry — in the window between
// the rebuild's corpus scan and its overwrite was silently clobbered, and the
// in-process authoritative flag then suppressed any further rebuild that
// session. The rebuild now runs its scan + publish under the SAME per-file lock
// the reconciling saves use (ContentHashIndex.rebuildUnderLock): a concurrent
// locked writer serializes against it and its addition is preserved (reconciled
// on top), and a contended lock defers the rebuild rather than publishing an
// unlocked overwrite. Same real-timer rationale as the retry tests above.

test("#2016: rebuildUnderLock publishes the rebuilt set under an uncontended lock", async () => {
  await withMemoryDir(async (dir) => {
    const stateDir = path.join(dir, "state");
    await mkdir(stateDir, { recursive: true });
    const idx = new ContentHashIndex(stateDir);
    await idx.load();

    const published = await idx.rebuildUnderLock(async () => {
      idx.clear();
      idx.addByHash(ContentHashIndex.computeHash("rebuilt-fact"));
    });
    assert.equal(published, true, "rebuild published under an uncontended lock");

    const fresh = new ContentHashIndex(stateDir);
    await fresh.load();
    assert.ok(fresh.has("rebuilt-fact"), "the rebuilt hash reached disk under the lock");
  });
});

test("#2016: rebuildUnderLock refuses to publish while a peer holds the lock (no unlocked overwrite)", async () => {
  await withMemoryDir(async (dir) => {
    const stateDir = path.join(dir, "state");
    await mkdir(stateDir, { recursive: true });
    // A peer already committed a hash to disk.
    const peerHash = ContentHashIndex.computeHash("peer-committed-fact");
    await writeFile(path.join(stateDir, "fact-hashes.txt"), `${peerHash}\n`);
    // The peer holds the advisory lock (fresh, non-stale, not stale-breakable).
    const lockPath = path.join(stateDir, "fact-hashes.txt.lock");
    await writeFile(lockPath, `99999 peer-owner ${new Date().toISOString()}\n`);

    const idx = new ContentHashIndex(stateDir, undefined, undefined, undefined, {
      maxWaitMs: 50,
      pollMs: 10,
    });
    await idx.load();
    let populateRan = false;
    const published = await idx.rebuildUnderLock(async () => {
      populateRan = true;
      idx.clear();
      idx.addByHash(ContentHashIndex.computeHash("rebuild-would-clobber"));
    });
    assert.equal(published, false, "rebuild does not publish when the lock is contended");
    assert.equal(populateRan, false, "populate never runs without the lock — no half-cleared state");

    // Disk is untouched: the peer's committed hash is preserved and the
    // rebuild's set was NOT written unlocked.
    const disk = new ContentHashIndex(stateDir);
    await disk.load();
    assert.ok(disk.has("peer-committed-fact"), "peer's committed hash preserved (not clobbered)");
    assert.equal(disk.has("rebuild-would-clobber"), false, "no unlocked overwrite while the lock is held");
    // The rebuilder's in-memory index is non-destructive (still the loaded set).
    assert.ok(idx.has("peer-committed-fact"), "loaded set retained in-memory after a deferred rebuild");
  });
});

test("#2016: a rebuild serializes with a concurrent locked writer — the peer's addition is preserved, not clobbered", async () => {
  await withMemoryDir(async (dir) => {
    const stateDir = path.join(dir, "state");
    await mkdir(stateDir, { recursive: true });

    const rebuilder = new ContentHashIndex(stateDir);
    await rebuilder.load();
    const peer = new ContentHashIndex(stateDir, undefined, undefined, undefined, {
      maxWaitMs: 50,
      pollMs: 10,
      retryBaseMs: 15,
      retryMaxAttempts: 5,
    });
    await peer.load();
    peer.add("peer-append-during-rebuild");

    let peerBlockedDuringRebuild = false;
    const published = await rebuilder.rebuildUnderLock(async () => {
      rebuilder.clear();
      rebuilder.addByHash(ContentHashIndex.computeHash("rebuilt-corpus-fact"));
      // While the rebuild holds the lock the peer's locked publish must NOT be
      // able to interleave: it times out and arms a durable retry instead of
      // writing. This is also the deadlock-freedom proof — the non-reentrant
      // file lock yields acquired=false rather than blocking forever.
      await peer.saveMergingWithDisk();
      peerBlockedDuringRebuild = peer.hasPendingReconcileRetry;
    });
    assert.equal(published, true, "the rebuild published under the lock");
    assert.equal(
      peerBlockedDuringRebuild,
      true,
      "the peer could not acquire the lock while the rebuild held it (serialized)",
    );

    // The peer's deferred retry lands after the rebuild releases the lock and
    // reconciles ON TOP of the freshly-published set — losing neither hash.
    await withRetryLoopAlive(() => peer.whenReconcileRetrySettled());

    const fresh = new ContentHashIndex(stateDir);
    await fresh.load();
    assert.ok(fresh.has("rebuilt-corpus-fact"), "the rebuild's set was published");
    assert.ok(
      fresh.has("peer-append-during-rebuild"),
      "the peer's concurrent addition survived — reconciled on top of the rebuild, never clobbered",
    );
  });
});

test("#2016: a peer's committed fact survives a fresh-session authoritative rebuild (multi-process)", async () => {
  await withMemoryDir(async (dir) => {
    // Process A: writes a fact (real .md + committed hash).
    const peer = new StorageManager(dir);
    await peer.writeMemory("fact", "durable multiprocess fact", { source: "extraction" });

    // Process B: a fresh session rebuilds authoritatively under the lock and
    // still dedups the peer's fact (corpus scan + locked publish through
    // ensureFactHashIndexAuthoritative → rebuildUnderLock).
    const rebuilder = new StorageManager(dir);
    assert.equal(
      await rebuilder.hasFactContentHash("durable multiprocess fact"),
      true,
      "the peer's fact is deduped after a fresh-session locked rebuild",
    );
  });
});

// PR #2016 findings 1-2 + 3: when the authoritative rebuild lock cannot be
// acquired, hasFactContentHash()/getAuthoritativeFactHashIndex() must NOT answer
// from the stale loaded snapshot as if it were authoritative; and a deferred
// lock-timeout append must be drainable inline at a short-lived writer's
// shutdown boundary rather than relying on the unref'd background timer.
//
// These tests hold the advisory lock deterministically (a fresh, non-stale
// <index>.lock the acquirer cannot take within the short window) and inject
// tight lock/retry budgets so the miss path is exercised without real
// multi-second waits. Same real-timer rationale as the retry tests above.

test("#2016 finding 1: a lock-contended miss is verified against the corpus, never a stale-snapshot false miss", async () => {
  await withMemoryDir(async (dir) => {
    // Process A writes a durable fact (.md corpus + fact-hashes.txt).
    const writer = new StorageManager(dir);
    await writer.writeMemory("fact", "durable fact under contention", { source: "extraction" });

    // Drop the on-disk hash index so a fresh session's LOADED snapshot is EMPTY,
    // but keep the durable .md — the corpus is now the only source of truth.
    await rm(path.join(dir, "state", "fact-hashes.txt"), { force: true });

    // A peer holds the rebuild lock so process B cannot become authoritative.
    const lockPath = path.join(dir, "state", "fact-hashes.txt.lock");
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, `99999 peer-owner ${new Date().toISOString()}\n`);

    try {
      const reader = new StorageManager(dir);
      reader.factHashIndexLockOptions = { maxWaitMs: 40, pollMs: 10, retryMaxAttempts: 2, retryBaseMs: 10 };

      assert.equal(
        await reader.isFactContentHashAuthoritative(),
        false,
        "index cannot be authoritative while the peer holds the rebuild lock",
      );
      assert.equal(
        await reader.hasFactContentHash("durable fact under contention"),
        true,
        "a miss on the empty loaded snapshot is verified against the durable corpus — no false dedup miss",
      );
      assert.equal(
        await reader.hasFactContentHash("was never written anywhere"),
        false,
        "a genuine miss is still a miss under contention (corpus confirms absence)",
      );
    } finally {
      await rm(lockPath, { force: true });
    }
  });
});

test("#2016 finding 2: getAuthoritativeFactHashIndex fails explicitly instead of returning a non-authoritative index", async () => {
  await withMemoryDir(async (dir) => {
    const storage = new StorageManager(dir);
    storage.factHashIndexLockOptions = { maxWaitMs: 40, pollMs: 10, retryMaxAttempts: 2, retryBaseMs: 10 };
    const lockPath = path.join(dir, "state", "fact-hashes.txt.lock");
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, `99999 peer-owner ${new Date().toISOString()}\n`);

    try {
      await assert.rejects(
        () => storage.getAuthoritativeFactHashIndex(),
        (err: unknown) => err instanceof FactHashIndexNotAuthoritativeError,
        "must throw rather than return a stale/non-authoritative index",
      );
      assert.equal(
        await storage.isFactContentHashAuthoritative(),
        false,
        "the non-authoritative state is propagated, not masked as authoritative",
      );
    } finally {
      await rm(lockPath, { force: true });
    }

    // Once the lock is free the rebuild publishes and the accessor returns.
    const idx = await storage.getAuthoritativeFactHashIndex();
    assert.ok(idx, "returns the authoritative index after the lock clears");
    assert.equal(await storage.isFactContentHashAuthoritative(), true);
  });
});

test("#2016 finding 3: flushReconcileRetry drains a deferred lock-timeout append to disk at shutdown", async () => {
  await withMemoryDir(async (dir) => {
    const stateDir = path.join(dir, "state");
    await mkdir(stateDir, { recursive: true });
    const lockPath = path.join(stateDir, "fact-hashes.txt.lock");
    await writeFile(lockPath, `99999 peer-owner ${new Date().toISOString()}\n`);

    const idx = new ContentHashIndex(stateDir, undefined, undefined, undefined, {
      maxWaitMs: 30,
      pollMs: 10,
      retryBaseMs: 10,
      retryMaxAttempts: 5,
    });
    await idx.load();
    idx.add("deferred-drained-on-shutdown");
    await idx.saveMergingWithDisk();
    assert.equal(idx.hasPendingReconcileRetry, true, "the lock timeout armed a background retry");

    // The peer releases the lock; a short-lived writer drains INLINE at its
    // shutdown boundary instead of relying on the unref'd background timer.
    await rm(lockPath, { force: true });
    await idx.flushReconcileRetry();

    assert.equal(idx.hasPendingReconcileRetry, false, "no lingering retry after the inline drain");
    const fresh = new ContentHashIndex(stateDir);
    await fresh.load();
    assert.ok(
      fresh.has("deferred-drained-on-shutdown"),
      "the deferred hash reached disk via the inline shutdown drain",
    );
  });
});

// PR #2016 thread SDzOP: the storage-owned removal
// (removeFactContentHashesForMemories) and the approval re-add
// (addActiveFactContentHash) used to publish fact-hashes.txt with the unlocked
// whole-file save(). That republishes THIS instance's cached in-memory set, so a
// hash a peer appended to disk after this instance last synced — the exact
// concurrent-index window the reconcile path exists to close — is silently
// clobbered. Both paths now flush through the SAME cross-process locked,
// removal-aware reconcile (saveMergingWithDisk) the write/batch/rebuild paths
// use. This test reproduces the concurrent-append race deterministically: it
// re-baselines the cached index freshness fingerprint to the peer-advanced file
// so the removal keeps the authoritative fast path (no corpus rebuild) and its
// SAVE step alone is exercised — an unlocked save() drops the peer append, the
// locked reconcile keeps it.
test("#2016 thread SDzOP: a storage fact-hash removal reconciles under the lock, preserving a concurrent peer append", async () => {
  await withMemoryDir(async (dir) => {
    const stateDir = path.join(dir, "state");
    const storage = new StorageManager(dir);

    await storage.writeMemory("fact", "alpha stays active", { source: "manual" });
    await storage.writeMemory("fact", "beta gets archived", { source: "manual" });

    // Make the shared index authoritative and cached (the production hot path).
    assert.equal(await storage.hasFactContentHash("alpha stays active"), true);
    // Test-only access to storage/index internals: the shape is structurally
    // known and a runtime check would be meaningless here (private members).
    const storageInternals = storage as unknown as {
      getFactHashIndex: () => Promise<ContentHashIndex>;
      readAllMemories: () => Promise<MemoryFile[]>;
    };
    const idx = await storageInternals.getFactHashIndex.call(storage);

    // Archive beta off disk so the removal actually drops its hash (it is no
    // longer owned by an active corpus fact).
    const all = await storageInternals.readAllMemories.call(storage);
    const beta = all.find((m) => (m.content ?? "").includes("beta gets archived"));
    assert.ok(beta, "beta fact must exist in the corpus");
    await rm(beta!.path, { force: true });
    storage.invalidateAllMemoriesCacheForDir();

    // Concurrent index activity: a peer instance appends a NEW hash under the
    // cross-process lock. The storage's cached index does not know about it.
    const peer = new ContentHashIndex(stateDir);
    await peer.load();
    peer.add("peer concurrent append");
    await peer.saveMergingWithDisk();

    // Re-baseline the cached index freshness fingerprint to the peer-advanced
    // file so ensureFactHashIndexAuthoritative keeps the fast path (no rebuild),
    // isolating the removal's SAVE step — the exact code the reviewer flagged.
    const idxInternals = idx as unknown as {
      captureSyncedFingerprint: () => Promise<void>;
    };
    await idxInternals.captureSyncedFingerprint.call(idx);

    const saveSpy = mock.method(ContentHashIndex.prototype, "save");
    const reconcileSpy = mock.method(ContentHashIndex.prototype, "saveMergingWithDisk");
    try {
      await storage.removeFactContentHashesForMemories([beta!]);
      assert.ok(
        reconcileSpy.mock.callCount() >= 1,
        "the removal flushes via the locked reconcile (saveMergingWithDisk)",
      );
      assert.equal(
        saveSpy.mock.callCount(),
        0,
        "the removal must NOT use the unlocked whole-file save()",
      );
    } finally {
      saveSpy.mock.restore();
      reconcileSpy.mock.restore();
    }

    const fresh = new ContentHashIndex(stateDir);
    await fresh.load();
    assert.ok(fresh.has("alpha stays active"), "the surviving fact's hash is intact");
    assert.equal(
      fresh.has("beta gets archived"),
      false,
      "the archived fact's hash is dropped — no resurrection",
    );
    assert.ok(
      fresh.has("peer concurrent append"),
      "the concurrent peer append survives the removal (locked reconcile, not unlocked overwrite)",
    );
  });
});

// PR #2016 thread SD7Tj: the reconcile publish() snapshots this.added at its
// start, then read+rewrites fact-hashes.txt under the lock. A concurrent
// add()/remove() that lands during those disk awaits was silently dropped: the
// old publish cleared this.added/this.removed WHOLESALE and set dirty=false, so
// the mid-flight delta vanished from memory AND was never persisted. publish now
// consumes ONLY the deltas it published; late arrivals stay pending (dirty
// retained) and a bounded durable retry is re-armed to land them.
test("#2016 thread SD7Tj: a hash added while a reconcile save awaits disk is not lost", async () => {
  await withMemoryDir(async (dir) => {
    const stateDir = path.join(dir, "state");
    await mkdir(stateDir, { recursive: true });

    // The write-key provider is invoked synchronously at publish's write step —
    // AFTER publish has snapshotted this.added and BEFORE it consumes/clears it.
    // Injecting an add() there deterministically reproduces a concurrent add
    // landing in publish's mid-flight window, with no module mocking.
    let idx!: ContentHashIndex;
    let injected = false;
    const writeKeyProvider = (): Buffer | null => {
      if (!injected) {
        injected = true;
        idx.add("added-during-save");
      }
      return null;
    };
    idx = new ContentHashIndex(stateDir, () => null, writeKeyProvider, undefined, {
      maxWaitMs: 50,
      pollMs: 10,
      retryBaseMs: 10,
      retryMaxAttempts: 5,
    });
    await idx.load();
    idx.add("added-before-save");

    await idx.saveMergingWithDisk();

    // The pre-save addition published as expected.
    const afterFirst = new ContentHashIndex(stateDir);
    await afterFirst.load();
    assert.equal(afterFirst.has("added-before-save"), true, "the pre-save addition is on disk");

    // The mid-save addition must survive in-memory (old code wiped it via
    // `this.hashes = merged` + `this.added.clear()`).
    assert.equal(idx.has("added-during-save"), true, "mid-save addition retained in-memory");

    // ...and it must still be durably persistable — old code set dirty=false so
    // the drain below would be a no-op and the delta would be lost forever.
    await withRetryLoopAlive(() => idx.flushReconcileRetry());
    const fresh = new ContentHashIndex(stateDir);
    await fresh.load();
    assert.ok(fresh.has("added-before-save"), "pre-save addition still durable after drain");
    assert.ok(
      fresh.has("added-during-save"),
      "the mid-save addition reached disk — the mid-flight delta was preserved, not dropped",
    );
  });
});

// PR #2016 thread SD7Tk: a direct (non-deferred) writeMemory("fact") awaited
// saveMergingWithDisk, which on a lock timeout defers to an UNREF'd background
// retry and returns without publishing. writeMemory then returned as if the
// index were durable while the addition lived only in memory + a timer that a
// short-lived process can exit before it fires. writeMemory now drains that
// deferred retry inline (flushReconcileRetry) before returning, so a caller can
// never observe a lingering, exit-losable retry.
test("#2016 thread SD7Tk: a direct fact write drains its deferred hash retry before returning", async () => {
  await withMemoryDir(async (dir) => {
    const flushSpy = mock.method(ContentHashIndex.prototype, "flushReconcileRetry");
    const lockPath = path.join(dir, "state", "fact-hashes.txt.lock");
    await mkdir(path.dirname(lockPath), { recursive: true });
    // A peer holds the lock so the direct write's reconcile save times out and
    // defers to a background retry instead of publishing.
    await writeFile(lockPath, `99999 peer-owner ${new Date().toISOString()}\n`);
    try {
      const storage = new StorageManager(dir);
      storage.factHashIndexLockOptions = { maxWaitMs: 30, pollMs: 10, retryMaxAttempts: 2, retryBaseMs: 10 };

      await withRetryLoopAlive(async () => {
        await storage.writeMemory("fact", "direct-write-under-contended-lock", { source: "manual" });
      });

      // The direct write must have drained the deferred retry inline before
      // returning. Under the old code writeMemory awaited only
      // saveMergingWithDisk (which returned with the retry still armed) and never
      // called flushReconcileRetry — so this count was 0.
      assert.ok(
        flushSpy.mock.callCount() >= 1,
        "direct writeMemory drains the deferred hash retry (flushReconcileRetry) before returning",
      );
    } finally {
      flushSpy.mock.restore();
      await rm(lockPath, { force: true });
    }
  });
});
