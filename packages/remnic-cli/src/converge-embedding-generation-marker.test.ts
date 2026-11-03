// Issue #3182: converge's direct local deletions must advance the node-local
// generation marker; stat pinning emulates a coarse-tick filesystem so only a
// marker advance can move the stamp.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, readFile, rm, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EmbeddingIndexFileStore, parseConfig, shardIndexOf } from "@remnic/core";

import { executeConvergeApply } from "./converge.js";

// Pin the shard dir to one whole-millisecond tick, emulating a coarse-tick
// filesystem where the pre- and post-delete directory stats alias.
const TICK_SEC = 1_700_000_000.5;
const MODEL = "text-embedding-3-small";

test("a converge delete-local of a published embedding shard moves the generation stamp", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-3182-converge-del-"));
  const cursorDir = await mkdtemp(path.join(os.tmpdir(), "remnic-3182-converge-cur-"));
  try {
    const stateDir = path.join(memoryDir, "state");
    const store = new EmbeddingIndexFileStore(
      path.join(stateDir, "embeddings.json"),
      path.join(stateDir, "embeddings"),
      path.join(stateDir, "embedding-fallback-status.json"),
    );
    await mkdir(path.join(stateDir, "embeddings"), { recursive: true });
    await store.persist(
      {
        version: 1,
        provider: "openai",
        model: MODEL,
        entries: { "mem-old": { vector: [1, 0], path: "facts/old.md" } },
      },
      { touchedIds: ["mem-old"], memoryId: "mem-old" },
    );
    const shardRel = `state/embeddings/shard-${String(shardIndexOf("mem-old", 64)).padStart(4, "0")}.json`;
    const shardAbs = path.join(memoryDir, ...shardRel.split("/"));
    const shardDir = path.join(stateDir, "embeddings");
    const onDisk = await readFile(shardAbs);

    await utimes(shardDir, TICK_SEC, TICK_SEC);
    const inoBefore = (await lstat(shardDir)).ino;
    const markerBefore = (await readFile(path.join(stateDir, "embeddings.generation"), "utf-8")).trim();
    const stampBefore = await store.identityStamp();
    assert.equal(await store.identityStamp(), stampBefore, "precondition: the completed stamp is stable");

    // Real-root converge apply (no buffer maps): the delete-local branch
    // deletes through openStorageIo(rootDir) — StorageManager IO.
    // Local shard diverged from the shared base, peer deletion is newer:
    // newest-wins resolves peer-wins → delete-local.
    const result = await executeConvergeApply({
      config: parseConfig({ memoryDir, converge: { conflictPolicy: "newest-wins" } }),
      peerUrl: "buffer://peer",
      baseFilesByNamespace: new Map([
        ["default", [{ path: shardRel, sha256: createHash("sha256").update("stale base generation").digest("hex") }]],
      ]),
      localFilesByNamespace: new Map([
        ["default", [{ path: shardRel, sha256: createHash("sha256").update(onDisk).digest("hex"), mtimeMs: 1000 }]],
      ]),
      peerFilesByNamespace: new Map([["default", []]]),
      peerDeletionMtimeMsByNamespace: new Map([["default", new Map([[shardRel, 3000]])]]),
      cursorDir,
    });
    assert.equal(result.transfers.conflictsResolved, 1, "precondition: the deletion applied");
    assert.equal(result.transfers.failed, 0, "precondition: the delete-local branch did not fail");
    await assert.rejects(access(shardAbs), (err: NodeJS.ErrnoException) => err.code === "ENOENT", "precondition: the shard was deleted");

    // Force the exact stat the stamp reads so only a marker advance can move it.
    await utimes(shardDir, TICK_SEC, TICK_SEC);
    assert.equal((await lstat(shardDir)).ino, inoBefore, "precondition: deletion kept the shard dir (no directory swap)");

    assert.notEqual(
      (await readFile(path.join(stateDir, "embeddings.generation"), "utf-8")).trim(),
      markerBefore,
      "a convergence deletion that changed generation bytes must advance the generation marker",
    );
    assert.notEqual(
      await store.identityStamp(),
      stampBefore,
      "a convergence deletion must move the warm-cache stamp even when the directory stat aliases",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(cursorDir, { recursive: true, force: true }).catch(() => undefined);
  }
});
