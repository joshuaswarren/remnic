import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StorageManager } from "./storage.js";
import { ContentHashIndex } from "./storage/content-hash-index.js";

const FACT = "the quarterly budget was approved by the board";
const CONTENDED_LOCK_OPTIONS = { maxWaitMs: 40, pollMs: 10, retryMaxAttempts: 2, retryBaseMs: 10 };

async function withMemoryDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-fact-hash-publish-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Hold the fact-hash index lock the way a peer mid-publish does; returns the release. */
async function holdIndexLock(dir: string): Promise<() => Promise<void>> {
  const lockPath = path.join(dir, "state", "fact-hashes.txt.lock");
  await mkdir(path.dirname(lockPath), { recursive: true });
  await writeFile(lockPath, `99999 peer-owner ${new Date().toISOString()}\n`);
  return () => rm(lockPath, { force: true });
}

test("a publish that throws leaves peers revalidating instead of trusting the old file (#3355)", async () => {
  await withMemoryDir(async (dir) => {
    const stateDir = path.join(dir, "state");
    const peer = new ContentHashIndex(stateDir);
    peer.add("seed fact");
    await peer.saveMergingWithDisk();
    assert.equal(await peer.isDiskFingerprintCurrent(), true, "the peer starts in sync with the file");

    const writer = new ContentHashIndex(
      stateDir,
      () => null,
      () => {
        throw new Error("write key unavailable");
      },
    );
    await writer.load();
    writer.add("pending fact");
    await assert.rejects(writer.saveMergingWithDisk(), /write key unavailable/);

    assert.equal(writer.hasPendingChanges, true, "the failed addition stays pending in the writer");
    assert.equal(
      await peer.isDiskFingerprintCurrent(),
      false,
      "the file did not change, yet the peer must stop trusting its snapshot",
    );
  });
});

test("a writeMemory whose publish stays deferred does not leave a peer answering an authoritative MISS (#3355)", async () => {
  await withMemoryDir(async (dir) => {
    const peer = new StorageManager(dir);
    const writer = new StorageManager(dir);
    peer.factHashIndexLockOptions = CONTENDED_LOCK_OPTIONS;
    writer.factHashIndexLockOptions = CONTENDED_LOCK_OPTIONS;
    assert.deepEqual(
      await peer.lookupContentHash(FACT),
      { present: false, authoritative: true },
      "the peer starts with an authoritative, empty index",
    );

    const release = await holdIndexLock(dir);
    const written = await writer.writeMemory("fact", FACT);
    assert.ok(written.id, "the memory is durable, so the write still succeeds");

    const duringContention = await peer.lookupContentHash(FACT);
    assert.ok(
      duringContention.present || !duringContention.authoritative,
      `a peer must not report an authoritative MISS for a fact on disk: ${JSON.stringify(duringContention)}`,
    );

    await release();
    assert.deepEqual(
      await peer.lookupContentHash(FACT),
      { present: true, authoritative: true },
      "once the lock is free the peer rebuilds from the corpus and sees the fact",
    );
    await writer.lookupContentHash(FACT);
  });
});
