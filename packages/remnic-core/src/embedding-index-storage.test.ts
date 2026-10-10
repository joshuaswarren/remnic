/**
 * Issue #3148 review round 1: detectLayout() must decide the layout on the
 * FIRST call after a restart inside the replacement rename gap — rolling the
 * transaction backup back into place and returning "sharded" immediately, so
 * a stray legacy embeddings.json never wins. Higher-level search tests can
 * hide this because a second detectLayout() call inside the same operation
 * sees the already-rolled-back directory.
 */
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { chmod, lstat, mkdtemp, mkdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { EmbeddingIndexFileStore, EmbeddingIndexStorageError, type EmbeddingIndexStoreIo } from "./embedding-index-storage.js";

const SHARD_FILE = JSON.stringify({
  version: 1,
  provider: "openai",
  model: "text-embedding-3-small",
  entries: { "mem-old": { vector: [1, 0], path: "facts/old.md" } },
});

function newStore(memoryDir: string): EmbeddingIndexFileStore {
  const stateDir = path.join(memoryDir, "state");
  return new EmbeddingIndexFileStore(
    path.join(stateDir, "embeddings.json"),
    path.join(stateDir, "embeddings"),
    path.join(stateDir, "embedding-fallback-status.json"),
  );
}

test("detectLayout returns sharded on the first post-gap call and ignores a stray legacy file", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-emb3146-gapfirst-"));
  const store = newStore(memoryDir);
  const stateDir = path.join(memoryDir, "state");
  try {
    const backupDir = path.join(stateDir, "embeddings.pre-replace.tmp");
    await mkdir(backupDir, { recursive: true });
    await writeFile(path.join(backupDir, "shard-0058.json"), SHARD_FILE, "utf-8");
    await writeFile(
      path.join(stateDir, "embeddings.json"),
      JSON.stringify({
        version: 1,
        provider: "openai",
        model: "text-embedding-3-small",
        entries: { "mem-stale": { vector: [0, 1], path: "facts/stale.md" } },
      }),
      "utf-8",
    );

    // First post-gap call reports SHARDED without writing: reads fail open
    // to an empty view (the gap generation cannot be enumerated) and the
    // stray legacy file never wins.
    assert.equal(await store.detectLayout(), "sharded");
    let probe: Record<string, { vector: number[]; path: string }> = {};
    const identity = await store.readShardGenerationInto(probe);
    assert.equal(identity, null);
    assert.deepEqual(probe, {});
    try {
      await stat(path.join(stateDir, "embeddings"));
      assert.fail("detectLayout must not write on a read path");
    } catch (err) {
      assert.equal((err as NodeJS.ErrnoException).code, "ENOENT");
    }

    // The mutation wrapper performs the recovery (restored generation
    // becomes the loaded view) and lands the write on it: old + new.
    assert.equal(await store.recoverIfInterrupted(), true);
    const loaded = await (async () => {
      const merged: Record<string, { vector: number[]; path: string }> = {};
      await store.readShardGenerationInto(merged);
      return merged;
    })();
    loaded["mem-new"] = { vector: [1, 1], path: "facts/new.md" };
    await store.persist(
      {
        version: 1,
        provider: "openai",
        model: "text-embedding-3-small",
        entries: loaded,
      },
      { touchedIds: ["mem-new"], memoryId: "mem-new" },
    );
    assert.equal(await store.detectLayout(), "sharded");
    probe = {};
    const identityAfter = await store.readShardGenerationInto(probe);
    assert.deepEqual(identityAfter, { provider: "openai", model: "text-embedding-3-small" });
    assert.deepEqual(Object.keys(probe).sort(), ["mem-new", "mem-old"]);
    assert.equal(probe["mem-old"].path, "facts/old.md");
  } finally {
    await rm(memoryDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// PR #3176 codex P2 — the generation stamp must not alias consecutive
// publications. A dirty-shard write keeps the published directory's inode and
// only moves its mtime; on a coarse-tick filesystem two consecutive
// publications can report the same directory stat, so the stamp must move
// through something that cannot alias.
// ---------------------------------------------------------------------------

test("consecutive shard publications move the generation stamp even when the directory stat is preserved", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-emb3176-stamp-"));
  const store = newStore(memoryDir);
  try {
    const shardDir = path.join(memoryDir, "state", "embeddings");
    await mkdir(shardDir, { recursive: true });
    // mem-old hashes to shard-0058 (same fixture as the membership test).
    await writeFile(path.join(shardDir, "shard-0058.json"), SHARD_FILE);
    const identity = { provider: "openai" as const, model: "text-embedding-3-small" };
    const entryOld = { vector: [1, 0], path: "facts/old.md" };
    const entryNew = { vector: [0, 1], path: "facts/new.md" };

    await store.persist(
      { version: 1, ...identity, entries: { "mem-old": entryOld } },
      { touchedIds: ["mem-old"], memoryId: "mem-old" },
    );
    // Force the exact stat the stamp reads, emulating a coarse mtime tick:
    // the aliased stamp must still move on the NEXT publication.
    await utimes(shardDir, 1_700_000_000.5, 1_700_000_000.5);
    const stampBefore = await store.identityStamp();

    await store.persist(
      { version: 1, ...identity, entries: { "mem-old": entryOld, "mem-new": entryNew } },
      { touchedIds: ["mem-new"], memoryId: "mem-new" },
    );
    await utimes(shardDir, 1_700_000_000.5, 1_700_000_000.5);

    const stampAfter = await store.identityStamp();
    assert.notEqual(
      stampAfter,
      stampBefore,
      "two consecutive publications must never alias to one generation stamp",
    );
    // The published generation itself carries both entries: the stamp move
    // is about revalidation, not about losing data.
    const merged: Record<string, { vector: number[]; path: string }> = {};
    await store.readShardGenerationInto(merged);
    assert.deepEqual(Object.keys(merged).sort(), ["mem-new", "mem-old"]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("a publication's stamp moves twice: in-flight before its writes and final only after them", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-emb3176-barrier-"));
  const store = newStore(memoryDir);
  try {
    const shardDir = path.join(memoryDir, "state", "embeddings");
    await mkdir(shardDir, { recursive: true });
    // mem-old hashes to shard-0058 (same fixture as the membership test).
    await writeFile(path.join(shardDir, "shard-0058.json"), SHARD_FILE);
    const identity = { provider: "openai" as const, model: "text-embedding-3-small" };
    const entryOld = { vector: [1, 0], path: "facts/old.md" };
    const entryNew = { vector: [0, 1], path: "facts/new.md" };

    await store.persist(
      { version: 1, ...identity, entries: { "mem-old": entryOld } },
      { touchedIds: ["mem-old"], memoryId: "mem-old" },
    );
    const stampBefore = await store.identityStamp();

    // Freeze the publication between its first shard write and completion;
    // the write-boundary signal guarantees the in-flight marker already moved.
    const { promise: release, resolve: unblock } = Promise.withResolvers<void>();
    const { promise: atWrite, resolve: reachedWrite } = Promise.withResolvers<void>();
    let gated = false;
    const io: EmbeddingIndexStoreIo = {
      readUtf8: async (filePath) => readFile(filePath, "utf-8"),
      writeUtf8: async (filePath, contents) => {
        if (!gated) {
          await mkdir(path.dirname(filePath), { recursive: true });
          await writeFile(filePath, contents, "utf-8");
          return;
        }
        gated = false;
        reachedWrite();
        await release;
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, contents, "utf-8");
      },
    };
    const gatedStore = new EmbeddingIndexFileStore(
      path.join(memoryDir, "state", "embeddings.json"),
      shardDir,
      path.join(memoryDir, "state", "embedding-fallback-status.json"),
      io,
    );
    gated = true;
    const publication = gatedStore.persist(
      { version: 1, ...identity, entries: { "mem-old": entryOld, "mem-new": entryNew } },
      { touchedIds: ["mem-new"], memoryId: "mem-new" },
    );
    await atWrite;
    const stampMidFlight = await store.identityStamp();
    assert.notEqual(stampMidFlight, stampBefore, "a reader must never see the previous final stamp during a publication");

    unblock();
    await publication;
    const stampFinal = await store.identityStamp();
    assert.notEqual(
      stampFinal,
      stampMidFlight,
      "the stamp must move again when the publication completes: a mid-flight stamp must never be the last stable one",
    );
    const merged: Record<string, { vector: number[]; path: string }> = {};
    await store.readShardGenerationInto(merged);
    assert.deepEqual(Object.keys(merged).sort(), ["mem-new", "mem-old"]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("an in-flight marker never yields a repeatable stamp, so a cached probe always revalidates", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-emb3176-inflight-"));
  const store = newStore(memoryDir);
  try {
    const shardDir = path.join(memoryDir, "state", "embeddings");
    await mkdir(shardDir, { recursive: true });
    // mem-old hashes to shard-0058 (same fixture as the membership test).
    await writeFile(path.join(shardDir, "shard-0058.json"), SHARD_FILE);
    const identity = { provider: "openai" as const, model: "text-embedding-3-small" };

    await store.persist(
      { version: 1, ...identity, entries: { "mem-old": { vector: [1, 0], path: "facts/old.md" } } },
      { touchedIds: ["mem-old"], memoryId: "mem-old" },
    );
    // Real post-crash state: the in-flight marker landed, the completion
    // marker never did. A reader may have cached this stamp mid-flight; it
    // must never see the same stamp again until a publication completes.
    await writeFile(path.join(memoryDir, "state", "embeddings.generation"), "in-flight");
    const probeA = await store.identityStamp();
    const probeB = await store.identityStamp();
    const probeC = await store.identityStamp();
    assert.notEqual(probeB, probeA, "an in-flight marker must never produce a repeatable stamp");
    assert.notEqual(probeC, probeB, "an in-flight marker must never produce a repeatable stamp");

    await store.persist(
      { version: 1, ...identity, entries: { "mem-old": { vector: [1, 0], path: "facts/old.md" }, "mem-new": { vector: [0, 1], path: "facts/new.md" } } },
      { touchedIds: ["mem-new"], memoryId: "mem-new" },
    );
    const settledA = await store.identityStamp();
    const settledB = await store.identityStamp();
    assert.notEqual(settledA, probeC, "the completed publication must move the stamp off every in-flight probe");
    assert.equal(settledB, settledA, "a completed publication's stamp is stable");
  } finally {
    await rm(memoryDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("recovering an interrupted replacement finalizes the marker on the restored generation", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-emb3176-recovery-"));
  const store = newStore(memoryDir);
  try {
    const stateDir = path.join(memoryDir, "state");
    const shardDir = path.join(stateDir, "embeddings");
    await mkdir(shardDir, { recursive: true });
    await writeFile(path.join(shardDir, "shard-0058.json"), SHARD_FILE);
    await store.persist(
      { version: 1, provider: "openai", model: "text-embedding-3-small", entries: { "mem-old": { vector: [1, 0], path: "facts/old.md" } } },
      { touchedIds: ["mem-old"], memoryId: "mem-old" },
    );

    // Crash after the in-flight marker, before the staging publication: the
    // published directory sits in the transaction backup and the marker is
    // still in-flight.
    await rename(shardDir, path.join(stateDir, "embeddings.pre-replace.tmp"));
    await writeFile(path.join(stateDir, "embeddings.generation"), "in-flight");

    assert.equal(await store.recoverIfInterrupted(), true);
    const marker = (await readFile(path.join(stateDir, "embeddings.generation"), "utf-8")).trim();
    assert.notEqual(marker, "in-flight", "a recovered generation must not keep the in-flight marker");
    const probeA = await store.identityStamp();
    const probeB = await store.identityStamp();
    assert.equal(probeA, probeB, "the recovered generation's stamp is stable: warm searches must not reload");
    const merged: Record<string, { vector: number[]; path: string }> = {};
    await store.readShardGenerationInto(merged);
    assert.deepEqual(Object.keys(merged), ["mem-old"], "the restored generation is intact");
  } finally {
    await rm(memoryDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("a failed publication's rollback finalizes the marker on the restored generation", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-emb3176-rollback-"));
  const store = newStore(memoryDir);
  try {
    const stateDir = path.join(memoryDir, "state");
    const shardDir = path.join(stateDir, "embeddings");
    await mkdir(shardDir, { recursive: true });
    await writeFile(path.join(shardDir, "shard-0058.json"), SHARD_FILE);
    await store.persist(
      { version: 1, provider: "openai", model: "text-embedding-3-small", entries: { "mem-old": { vector: [1, 0], path: "facts/old.md" } } },
      { touchedIds: ["mem-old"], memoryId: "mem-old" },
    );

    // A publication whose staging rename fails: the shard directory was
    // already demoted to the backup, so the catch rolls it back. The
    // restored generation must be finalized, not left in-flight.
    await assert.rejects(
      () => store.publishSwappedGeneration(path.join(stateDir, "embeddings.staging.tmp-nonexistent")),
      (err: NodeJS.ErrnoException) => err.code === "ENOENT",
    );
    const marker = (await readFile(path.join(stateDir, "embeddings.generation"), "utf-8")).trim();
    assert.notEqual(marker, "in-flight", "a rolled-back generation must not keep the in-flight marker");
    const probeA = await store.identityStamp();
    const probeB = await store.identityStamp();
    assert.equal(probeA, probeB, "the rolled-back generation's stamp is stable");
    const merged: Record<string, { vector: number[]; path: string }> = {};
    await store.readShardGenerationInto(merged);
    assert.deepEqual(Object.keys(merged), ["mem-old"], "the rolled-back generation is intact");
  } finally {
    await rm(memoryDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("a failed recovery rollback keeps the marker in-flight and a later recovery finalizes it", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-emb3176-rollbackfail-"));
  const store = newStore(memoryDir);
  try {
    const stateDir = path.join(memoryDir, "state");
    const shardDir = path.join(stateDir, "embeddings");
    await mkdir(shardDir, { recursive: true });
    await writeFile(path.join(shardDir, "shard-0058.json"), SHARD_FILE);
    await store.persist(
      { version: 1, provider: "openai", model: "text-embedding-3-small", entries: { "mem-old": { vector: [1, 0], path: "facts/old.md" } } },
      { touchedIds: ["mem-old"], memoryId: "mem-old" },
    );

    await rename(shardDir, path.join(stateDir, "embeddings.pre-replace.tmp"));
    await writeFile(path.join(stateDir, "embeddings.generation"), "in-flight");

    // Real rollback failure at the filesystem boundary: the state dir is
    // unwritable, so the restore rename fails and recovery fails closed.
    const prevMode = (await stat(stateDir)).mode;
    await chmod(stateDir, 0o500);
    try {
      await assert.rejects(
        () => store.recoverIfInterrupted(),
        (err: NodeJS.ErrnoException) => err.code === "EACCES",
      );
      assert.equal(
        await readFile(path.join(stateDir, "embeddings.generation"), "utf-8"),
        "in-flight",
        "a failed rollback must never finalize the marker",
      );
    } finally {
      await chmod(stateDir, prevMode);
    }

    // A later recovery under a writable state dir restores and finalizes.
    assert.equal(await store.recoverIfInterrupted(), true);
    const marker = (await readFile(path.join(stateDir, "embeddings.generation"), "utf-8")).trim();
    assert.notEqual(marker, "in-flight");
    const probeA = await store.identityStamp();
    const probeB = await store.identityStamp();
    assert.equal(probeA, probeB, "the recovered generation's stamp is stable");
  } finally {
    await rm(memoryDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("a corrupt replacement backup shape surfaces as a tagged storage error, never the legacy fallback", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-emb3146-gapbackup-"));
  const store = newStore(memoryDir);
  try {
    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
    // `embeddings.pre-replace.tmp` exists but is NOT a directory: the
    // rollback moves that junk file into the published position, where the
    // shard enumeration must fail loudly (tagged) instead of degrading to
    // the legacy fallback.
    await writeFile(path.join(stateDir, "embeddings.pre-replace.tmp"), "junk", "utf-8");
    // The mutation wrapper's recovery moves the junk file into the published
    // position; the subsequent persist must then fail loudly (tagged) when
    // shard enumeration hits it, instead of degrading to the legacy
    // fallback.
    assert.equal(await store.recoverIfInterrupted(), true);
    await assert.rejects(
      store.persist({
        version: 1,
        provider: "openai",
        model: "text-embedding-3-small",
        entries: {},
      }),
      (err: NodeJS.ErrnoException) => err.name === "EmbeddingIndexStorageError",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("removing an index on an empty store publishes an empty layout marker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-remove-empty-"));
  try {
    const store = newStore(root);
    await store.removePublishedGeneration();
    assert.equal(await newStore(root).detectLayout(), "sharded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("misplaced shard entries record read diagnostics before failing closed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-misplaced-status-"));
  try {
    await mkdir(path.join(root, "state/embeddings"), { recursive: true });
    // mem-old hashes to shard-0058, not 0000.
    await writeFile(path.join(root, "state/embeddings/shard-0000.json"), SHARD_FILE);
    const store = newStore(root);
    await assert.rejects(() => store.readShardGenerationInto({}), /shard/);
    const { readFile } = await import("node:fs/promises");
    const status = JSON.parse(await readFile(path.join(root, "state/embedding-fallback-status.json"), "utf-8"));
    assert.match(status.lastReadRecovery.message, /shard-0000/);
    assert.equal(await readFile(path.join(root, "state/embeddings/shard-0000.json"), "utf-8"), SHARD_FILE);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Codex PRRT_kwDORJXyws6mZ72r — symlinked generation dir / members are
// rejected at read and mutation boundaries; planted links must never serve
// or write through to paths outside the state directory.
// ---------------------------------------------------------------------------

test("a symlinked embedding shard directory is rejected at the layout and read boundaries", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-emb-symlink-dir-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "remnic-emb-symlink-outside-"));
  try {
    // Use a shard whose entry id hashes to the same shard name so a
    // successful parse would otherwise validate; the symlink boundary must
    // throw BEFORE any shard membership check.
    const shardNameForId = (id: string): string => {
      let h = 0x811c9dc5;
      for (let i = 0; i < id.length; i++) {
        h ^= id.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      return `shard-${String(h % 64).padStart(4, "0")}.json`;
    };
    const fixtureId = "mem-old";
    const fixtureShard = shardNameForId(fixtureId);
    await mkdir(path.join(outside, "embeddings"), { recursive: true });
    await writeFile(
      path.join(outside, "embeddings", fixtureShard),
      JSON.stringify({
        version: 1,
        provider: "openai",
        model: "text-embedding-3-small",
        entries: { [fixtureId]: { vector: [1, 0], path: "facts/old.md" } },
      }),
      "utf-8",
    );
    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
    await symlink(path.join(outside, "embeddings"), path.join(stateDir, "embeddings"), "dir");
    assert.equal((await (await import("node:fs/promises")).lstat(path.join(stateDir, "embeddings"))).isSymbolicLink(), true, "fixture assumption: state/embeddings must be a symlink");
    const store = newStore(memoryDir);

    await assert.rejects(
      () => store.detectLayout(),
      (err: unknown) => err instanceof EmbeddingIndexStorageError && /symlink/.test(err.message),
    );
    await assert.rejects(
      () => store.readShardGenerationInto({}),
      (err: unknown) => err instanceof EmbeddingIndexStorageError && /symlink/.test(err.message),
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("a symlinked shard member pointing outside the state dir is rejected on read", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-emb-symlink-mem-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "remnic-emb-symlink-mem-out-"));
  try {
    const shardDir = path.join(memoryDir, "state", "embeddings");
    await mkdir(shardDir, { recursive: true });
    const fixtureId = "mem-old";
    let h = 0x811c9dc5;
    for (let i = 0; i < fixtureId.length; i++) {
      h ^= fixtureId.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    const fixtureShard = `shard-${String(h % 64).padStart(4, "0")}.json`;
    await writeFile(
      path.join(outside, "planted.json"),
      JSON.stringify({
        version: 1,
        provider: "openai",
        model: "text-embedding-3-small",
        entries: { [fixtureId]: { vector: [1, 0], path: "facts/old.md" } },
      }),
      "utf-8",
    );
    await symlink(
      path.join(outside, "planted.json"),
      path.join(shardDir, fixtureShard),
    );
    const store = newStore(memoryDir);
    await assert.rejects(
      () => store.readShardGenerationInto({}),
      (err: unknown) =>
        err instanceof EmbeddingIndexStorageError &&
        (/symlink/.test(err.message) || /escapes the state directory/.test(err.message)),
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
