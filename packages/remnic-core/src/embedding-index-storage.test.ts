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
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
  try {
    const stateDir = path.join(memoryDir, "state");
    const backupDir = path.join(stateDir, "embeddings.pre-replace.tmp");
    await mkdir(backupDir, { recursive: true });
    await writeFile(path.join(backupDir, "shard-0000.json"), SHARD_FILE, "utf-8");
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

    assert.equal(await store.detectLayout(), "sharded", "first post-gap call must return the restored generation");
    assert.equal(await store.detectLayout(), "sharded");
    // The restored generation is what a loader sees — not the stray legacy.
    const merged: Record<string, { vector: number[]; path: string }> = {};
    const identity = await store.readShardGenerationInto(merged, true);
    assert.deepEqual(identity, { provider: "openai", model: "text-embedding-3-small" });
    assert.deepEqual(Object.keys(merged), ["mem-old"]);
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
    const recovered = await store.detectLayout();
    assert.equal(recovered, "sharded");
    await assert.rejects(
      store.readShardGenerationInto({}, true),
      (err: NodeJS.ErrnoException) => err.name === "EmbeddingIndexStorageError",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true }).catch(() => undefined);
  }
});
