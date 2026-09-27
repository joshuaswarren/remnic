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
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { EmbeddingIndexFileStore } from "./embedding-index-storage.js";

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
