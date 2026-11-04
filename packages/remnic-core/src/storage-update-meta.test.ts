import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StorageManager } from "./storage.js";
import { withHeldFileLock } from "./utils/serialize-mutations.js";

// Real wall-clock is deliberate here: the lock helper's acquire budget and
// heartbeat polling run on platform timers, and the contention windows below
// exist to bracket updateMeta's real 2s acquire budget. Fake timers cannot
// drive the helper's internal polling loop.
function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Await the real signal "holder owns the lock file", not a guessed duration. */
async function waitForLockFile(lockPath: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      await stat(lockPath);
      return;
    } catch {
      if (Date.now() >= deadline) throw new Error(`lock file never appeared: ${lockPath}`);
      await delay(20);
    }
  }
}

async function makeStorage(): Promise<{
  storage: StorageManager;
  lockPath: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-meta-lock-"));
  await mkdir(path.join(root, "state"), { recursive: true });
  return {
    storage: new StorageManager(root),
    lockPath: path.join(root, "state", "meta.json.lock"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("updateMeta fails closed when meta.json.lock stays held past the acquire budget", async () => {
  const { storage, lockPath, cleanup } = await makeStorage();
  try {
    await storage.updateMeta((meta) => {
      meta.extractionCount = 1;
    });

    // A live external holder (a different owner id through the same helper the
    // out-of-process drain workers use) keeps the lock past updateMeta's 2s
    // wait budget. The update must fail instead of writing unlocked.
    const hold = withHeldFileLock(
      lockPath,
      { staleMs: 30_000, maxWaitMs: 30_000, pollMs: 50 },
      async () => {
        await delay(2_600);
      },
    );
    await waitForLockFile(lockPath);

    await assert.rejects(
      storage.updateMeta((meta) => {
        meta.extractionCount = 2;
      }),
      /not acquired/,
    );
    assert.equal(
      (await storage.loadMeta()).extractionCount,
      1,
      "a timed-out update must not perform an unlocked read-modify-write",
    );

    await hold;
    await storage.updateMeta((meta) => {
      meta.extractionCount = 3;
    });
    assert.equal((await storage.loadMeta()).extractionCount, 3);
  } finally {
    await cleanup();
  }
});

test("concurrent updateMeta additive updates both survive short external contention", async () => {
  const { storage, lockPath, cleanup } = await makeStorage();
  try {
    const hold = withHeldFileLock(
      lockPath,
      { staleMs: 30_000, maxWaitMs: 30_000, pollMs: 50 },
      async () => {
        await delay(300);
      },
    );
    await waitForLockFile(lockPath);
    await Promise.all([
      storage.updateMeta((meta) => {
        meta.totalMemories += 5;
      }),
      storage.updateMeta((meta) => {
        meta.totalEntities += 7;
      }),
    ]);
    await hold;
    const meta = await storage.loadMeta();
    assert.equal(meta.totalMemories, 5);
    assert.equal(meta.totalEntities, 7);
  } finally {
    await cleanup();
  }
});
