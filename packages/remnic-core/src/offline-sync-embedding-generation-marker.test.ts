// Issue #3182: the chunk-level pull path must advance the node-local
// generation marker around direct shard writes; partial chunks and no-ops
// must not disturb a valid completed stamp. Stat pinning emulates a
// coarse-tick filesystem so only a marker advance can move the stamp.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EmbeddingIndexFileStore,
  type EmbeddingIndexEntry,
  type EmbeddingIndexFile,
  shardIndexOf,
} from "./embedding-index-storage.js";
import { applyOfflineSyncFileContentChunk } from "./offline-sync.js";

// Pin the shard dir to one whole-millisecond tick, emulating a coarse-tick
// filesystem where the pre- and post-write directory stats alias (same
// technique as embedding-fallback-cross-process.test.ts).
const TICK_SEC = 1_700_000_000.5;
const MODEL = "text-embedding-3-small";

function shardRelFor(id: string): string {
  return `state/embeddings/shard-${String(shardIndexOf(id, 64)).padStart(4, "0")}.json`;
}

function indexFile(entries: Record<string, EmbeddingIndexEntry>): EmbeddingIndexFile {
  return { version: 1, provider: "openai", model: MODEL, entries };
}

function shardDirOf(memoryDir: string): string {
  return path.join(memoryDir, "state", "embeddings");
}

async function seedPublishedGeneration(memoryDir: string): Promise<EmbeddingIndexFileStore> {
  const stateDir = path.join(memoryDir, "state");
  const store = new EmbeddingIndexFileStore(
    path.join(stateDir, "embeddings.json"),
    path.join(stateDir, "embeddings"),
    path.join(stateDir, "embedding-fallback-status.json"),
  );
  // Same fixture shape as embedding-index-storage.test.ts: a published
  // sharded generation with one entry, completed through the store's
  // two-phase marker.
  await mkdir(path.join(stateDir, "embeddings"), { recursive: true });
  await writeFile(
    path.join(stateDir, "embeddings", shardRelFor("mem-old").split("/").pop()!),
    JSON.stringify(indexFile({ "mem-old": { vector: [1, 0], path: "facts/old.md" } })),
  );
  await store.persist(indexFile({ "mem-old": { vector: [1, 0], path: "facts/old.md" } }), {
    touchedIds: ["mem-old"],
    memoryId: "mem-old",
  });
  return store;
}

async function readMarker(memoryDir: string): Promise<string> {
  return (await readFile(path.join(memoryDir, "state", "embeddings.generation"), "utf-8")).trim();
}

async function pinShardDirStat(memoryDir: string): Promise<number> {
  const shardDir = shardDirOf(memoryDir);
  await utimes(shardDir, TICK_SEC, TICK_SEC);
  return (await lstat(shardDir)).ino;
}

async function assertInoUnchanged(memoryDir: string, inoBefore: number): Promise<void> {
  assert.equal(
    (await lstat(shardDirOf(memoryDir))).ino,
    inoBefore,
    "precondition: the pull rewrote the shard in place (no directory swap)",
  );
}

test("a completed offline-sync chunk write to a published shard moves the generation stamp", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-3182-chunk-"));
  try {
    const store = await seedPublishedGeneration(memoryDir);
    const shardRel = shardRelFor("mem-old");
    const updated = Buffer.from(
      JSON.stringify(indexFile({ "mem-old": { vector: [0, 1], path: "facts/old.md" } })),
      "utf-8",
    );

    const inoBefore = await pinShardDirStat(memoryDir);
    const markerBefore = await readMarker(memoryDir);
    const stampBefore = await store.identityStamp();
    assert.equal(await store.identityStamp(), stampBefore, "precondition: the completed stamp is stable");

    // The chunk-level pull path used by converge pulls and CLI hydrate:
    // no IO hooks, plain fs final write (writeSafeFileFromUpload).
    const result = await applyOfflineSyncFileContentChunk({
      root: memoryDir,
      sourceId: "remote",
      path: shardRel,
      sha256: createHash("sha256").update(updated).digest("hex"),
      bytes: updated.length,
      mtimeMs: 1000,
      offset: 0,
      content: updated,
    });
    assert.equal(result.applied, true, "precondition: the shard write applied");

    // Force the exact stat the stamp reads so only a marker advance can move it.
    await utimes(shardDirOf(memoryDir), TICK_SEC, TICK_SEC);
    await assertInoUnchanged(memoryDir, inoBefore);

    assert.notEqual(
      await readMarker(memoryDir),
      markerBefore,
      "a peer pull that published new generation bytes must advance the generation marker",
    );
    const stampAfter = await store.identityStamp();
    assert.notEqual(
      stampAfter,
      stampBefore,
      "a peer pull that changed generation bytes must move the warm-cache stamp even when the directory stat aliases",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("a partial chunk (staging only) must not invalidate a valid completed stamp", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-3182-partial-"));
  try {
    const store = await seedPublishedGeneration(memoryDir);
    const shardRel = shardRelFor("mem-old");
    const onDiskBefore = await readFile(path.join(memoryDir, ...shardRel.split("/")));

    const updated = Buffer.from(
      JSON.stringify(indexFile({ "mem-old": { vector: [0, 1], path: "facts/old.md" } })),
      "utf-8",
    );
    const inoBefore = await pinShardDirStat(memoryDir);
    const markerBefore = await readMarker(memoryDir);
    const stampBefore = await store.identityStamp();

    const result = await applyOfflineSyncFileContentChunk({
      root: memoryDir,
      sourceId: "remote",
      path: shardRel,
      sha256: createHash("sha256").update(updated).digest("hex"),
      bytes: updated.length,
      mtimeMs: 1000,
      offset: 0,
      content: updated.subarray(0, Math.floor(updated.length / 2)),
    });
    assert.equal(result.done, false, "precondition: the chunk is partial");
    assert.deepEqual(
      await readFile(path.join(memoryDir, ...shardRel.split("/"))),
      onDiskBefore,
      "precondition: a partial chunk spools to staging, never to the generation",
    );

    await utimes(shardDirOf(memoryDir), TICK_SEC, TICK_SEC);
    await assertInoUnchanged(memoryDir, inoBefore);

    assert.equal(await readMarker(memoryDir), markerBefore, "a staging-only write must not touch the generation marker");
    assert.equal(
      await store.identityStamp(),
      stampBefore,
      "no generation bytes changed: the completed stamp must stay valid so warm caches keep working",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("a skipped no-op chunk (content already identical) must not invalidate the stamp", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-3182-noop-"));
  try {
    const store = await seedPublishedGeneration(memoryDir);
    const shardRel = shardRelFor("mem-old");
    const onDisk = await readFile(path.join(memoryDir, ...shardRel.split("/")));

    const inoBefore = await pinShardDirStat(memoryDir);
    const markerBefore = await readMarker(memoryDir);
    const stampBefore = await store.identityStamp();

    const result = await applyOfflineSyncFileContentChunk({
      root: memoryDir,
      sourceId: "remote",
      path: shardRel,
      sha256: createHash("sha256").update(onDisk).digest("hex"),
      bytes: onDisk.length,
      mtimeMs: 1000,
      offset: 0,
      content: onDisk,
    });
    assert.equal(result.skipped, true, "precondition: identical content is a no-op");

    await utimes(shardDirOf(memoryDir), TICK_SEC, TICK_SEC);
    await assertInoUnchanged(memoryDir, inoBefore);

    assert.equal(await readMarker(memoryDir), markerBefore, "a no-op must not touch the generation marker");
    assert.equal(await store.identityStamp(), stampBefore, "no generation bytes changed: the stamp stays valid");
  } finally {
    await rm(memoryDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("a failed direct shard write leaves the marker in-flight: the stamp never repeats", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-3182-failed-"));
  try {
    const store = await seedPublishedGeneration(memoryDir);
    const shardRel = shardRelFor("mem-old");
    const updated = Buffer.from(
      JSON.stringify(indexFile({ "mem-old": { vector: [0, 1], path: "facts/old.md" } })),
      "utf-8",
    );

    const stampBefore = await store.identityStamp();

    // Force the final destructive write to fail: the publish rename cannot
    // replace the shard file with a directory in its place.
    const shardAbs = path.join(memoryDir, ...shardRel.split("/"));
    await rm(shardAbs);
    await mkdir(shardAbs);

    await assert.rejects(
      applyOfflineSyncFileContentChunk({
        root: memoryDir,
        sourceId: "remote",
        path: shardRel,
        sha256: createHash("sha256").update(updated).digest("hex"),
        bytes: updated.length,
        mtimeMs: 1000,
        offset: 0,
        content: updated,
      }),
    );

    assert.equal(await readMarker(memoryDir), "in-flight", "a failed publication must leave the in-flight barrier");
    const probeA = await store.identityStamp();
    const probeB = await store.identityStamp();
    assert.notEqual(probeA, probeB, "an in-flight stamp never repeats, so cached probes keep revalidating");
    assert.notEqual(probeA, stampBefore);
  } finally {
    await rm(memoryDir, { recursive: true, force: true }).catch(() => undefined);
  }
});
