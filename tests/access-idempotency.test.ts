import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { AccessIdempotencyStore, setAccessIdempotencyTestHooks } from "../src/access-idempotency.js";

test("access idempotency store refreshes when another process writes a key", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-idempotency-refresh-"));
  try {
    const storeA = new AccessIdempotencyStore(memoryDir);
    const storeB = new AccessIdempotencyStore(memoryDir);

    await storeA.get("shared-key", "hash-a");
    await storeB.put("shared-key", "hash-a", { accepted: true, memoryId: "fact-1" });

    const cachedRead = await storeA.get("shared-key", "hash-a");
    assert.equal(cachedRead.conflict, false);
    assert.deepEqual(cachedRead.response, { accepted: true, memoryId: "fact-1" });

    const conflictRead = await storeA.get("shared-key", "hash-b");
    assert.equal(conflictRead.conflict, true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access idempotency store reloads forced refreshes when another writer preserves the same mtime", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-idempotency-equal-mtime-"));
  try {
    const storeA = new AccessIdempotencyStore(memoryDir);
    const storeB = new AccessIdempotencyStore(memoryDir);
    const statePath = path.join(memoryDir, "state", "access-idempotency.json");

    await storeB.put("seed-key", "hash-seed", { seeded: true });
    await storeA.get("seed-key", "hash-seed");

    await storeB.put("shared-key", "hash-a", { accepted: true, memoryId: "fact-1" });
    (storeA as AccessIdempotencyStore & { loadedMtimeMs: number }).loadedMtimeMs = (await stat(statePath)).mtimeMs;

    const cachedRead = await storeA.get("shared-key", "hash-a");
    assert.equal(cachedRead.conflict, false);
    assert.deepEqual(cachedRead.response, { accepted: true, memoryId: "fact-1" });
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access idempotency store merges shared state before flushing a local write", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-idempotency-merge-"));
  try {
    const storeA = new AccessIdempotencyStore(memoryDir);
    const storeB = new AccessIdempotencyStore(memoryDir);
    const storeC = new AccessIdempotencyStore(memoryDir);

    await storeA.get("load-first", "hash-load");
    await storeB.put("key-b", "hash-b", { queued: true });
    await storeA.put("key-a", "hash-a", { queued: false });

    const readA = await storeC.get("key-a", "hash-a");
    const readB = await storeC.get("key-b", "hash-b");

    assert.deepEqual(readA.response, { queued: false });
    assert.deepEqual(readB.response, { queued: true });
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access idempotency store serializes concurrent flushes so neither key is dropped", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-idempotency-lock-"));
  try {
    const storeA = new AccessIdempotencyStore(memoryDir);
    const storeB = new AccessIdempotencyStore(memoryDir);
    const verifier = new AccessIdempotencyStore(memoryDir);
    let releaseFirstWrite: (() => void) | null = null;
    const firstWritePaused = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let firstWriteEnteredResolve: (() => void) | null = null;
    const firstWriteEntered = new Promise<void>((resolve) => {
      firstWriteEnteredResolve = resolve;
    });
    let flushWriteCalls = 0;

    setAccessIdempotencyTestHooks({
      beforeFlushWrite: async () => {
        flushWriteCalls += 1;
        if (flushWriteCalls === 1) {
          firstWriteEnteredResolve?.();
          await firstWritePaused;
        }
      },
    });

    try {
      const putA = storeA.put("key-a", "hash-a", { accepted: true });
      await firstWriteEntered;

      let putBResolved = false;
      const putB = storeB.put("key-b", "hash-b", { queued: true }).then(() => {
        putBResolved = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(
        putBResolved,
        false,
        "second writer should stay blocked until the first flush releases the shared lock",
      );

      releaseFirstWrite?.();
      await Promise.all([putA, putB]);
    } finally {
      setAccessIdempotencyTestHooks(null);
    }

    const readA = await verifier.get("key-a", "hash-a");
    const readB = await verifier.get("key-b", "hash-b");

    assert.deepEqual(readA.response, { accepted: true });
    assert.deepEqual(readB.response, { queued: true });
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access idempotency store serializes concurrent writes on the same store instance", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-idempotency-instance-"));
  try {
    const store = new AccessIdempotencyStore(memoryDir);
    const verifier = new AccessIdempotencyStore(memoryDir);
    let releaseFirstWrite: (() => void) | null = null;
    const firstWritePaused = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let firstWriteEnteredResolve: (() => void) | null = null;
    const firstWriteEntered = new Promise<void>((resolve) => {
      firstWriteEnteredResolve = resolve;
    });
    let flushWriteCalls = 0;

    setAccessIdempotencyTestHooks({
      beforeFlushWrite: async () => {
        flushWriteCalls += 1;
        if (flushWriteCalls === 1) {
          firstWriteEnteredResolve?.();
          await firstWritePaused;
        }
      },
    });

    try {
      const putA = store.put("key-a", "hash-a", { accepted: true });
      await firstWriteEntered;

      let putBResolved = false;
      const putB = store.put("key-b", "hash-b", { queued: true }).then(() => {
        putBResolved = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(
        putBResolved,
        false,
        "second write on the same store should wait until the first write has finished mutating local state",
      );

      releaseFirstWrite?.();
      await Promise.all([putA, putB]);
    } finally {
      setAccessIdempotencyTestHooks(null);
    }

    const readA = await verifier.get("key-a", "hash-a");
    const readB = await verifier.get("key-b", "hash-b");

    assert.deepEqual(readA.response, { accepted: true });
    assert.deepEqual(readB.response, { queued: true });
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access idempotency key locks stay live while the guarded callback is still running", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-idempotency-key-heartbeat-"));
  try {
    const storeA = new AccessIdempotencyStore(memoryDir);
    const storeB = new AccessIdempotencyStore(memoryDir);
    let releaseFirstCallback: (() => void) | null = null;
    const firstCallbackPaused = new Promise<void>((resolve) => {
      releaseFirstCallback = resolve;
    });
    let firstCallbackEnteredResolve: (() => void) | null = null;
    const firstCallbackEntered = new Promise<void>((resolve) => {
      firstCallbackEnteredResolve = resolve;
    });

    setAccessIdempotencyTestHooks({
      lockTimeoutMs: 500,
      staleLockMs: 40,
      lockHeartbeatMs: 10,
    });

    try {
      const firstLock = storeA.withKeyLock("shared-key", async () => {
        firstCallbackEnteredResolve?.();
        await firstCallbackPaused;
      });
      await firstCallbackEntered;

      let secondLockResolved = false;
      const secondLock = storeB.withKeyLock("shared-key", async () => {
        secondLockResolved = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.equal(
        secondLockResolved,
        false,
        "a live key lock should not be reclaimed as stale while its callback is still running",
      );

      releaseFirstCallback?.();
      await Promise.all([firstLock, secondLock]);
    } finally {
      setAccessIdempotencyTestHooks(null);
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access idempotency stale lock cleanup does not delete a fresh contender lock", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-idempotency-stale-owner-"));
  try {
    const storeA = new AccessIdempotencyStore(memoryDir);
    const storeB = new AccessIdempotencyStore(memoryDir);
    const key = "shared-key";
    const keyHash = createHash("sha256").update(key).digest("hex");
    const lockDir = path.join(memoryDir, "state", "access-idempotency-locks");
    const lockPath = path.join(lockDir, `${keyHash}.lock`);
    await mkdir(lockDir, { recursive: true });
    await writeFile(lockPath, "stale-owner", "utf-8");
    const staleTime = new Date(Date.now() - 10_000);
    await utimes(lockPath, staleTime, staleTime);

    let releaseFirstCleanup: (() => void) | null = null;
    const firstCleanupPaused = new Promise<void>((resolve) => {
      releaseFirstCleanup = resolve;
    });
    let firstCleanupEnteredResolve: (() => void) | null = null;
    const firstCleanupEntered = new Promise<void>((resolve) => {
      firstCleanupEnteredResolve = resolve;
    });
    let staleCleanupCalls = 0;

    let releaseSecondCallback: (() => void) | null = null;
    const secondCallbackPaused = new Promise<void>((resolve) => {
      releaseSecondCallback = resolve;
    });
    let secondCallbackEnteredResolve: (() => void) | null = null;
    const secondCallbackEntered = new Promise<void>((resolve) => {
      secondCallbackEnteredResolve = resolve;
    });
    let firstCallbackEntered = false;

    setAccessIdempotencyTestHooks({
      lockTimeoutMs: 1_000,
      staleLockMs: 100,
      lockHeartbeatMs: 20,
      beforeStaleLockUnlink: async () => {
        staleCleanupCalls += 1;
        if (staleCleanupCalls === 1) {
          firstCleanupEnteredResolve?.();
          await firstCleanupPaused;
        }
      },
    });

    try {
      const firstLock = storeA.withKeyLock(key, async () => {
        firstCallbackEntered = true;
      });
      await firstCleanupEntered;

      const secondLock = storeB.withKeyLock(key, async () => {
        secondCallbackEnteredResolve?.();
        await secondCallbackPaused;
      });
      await secondCallbackEntered;

      releaseFirstCleanup?.();
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(
        firstCallbackEntered,
        false,
        "first contender must not enter while the second contender holds the fresh lock",
      );

      releaseSecondCallback?.();
      await Promise.all([firstLock, secondLock]);
      assert.equal(firstCallbackEntered, true);
    } finally {
      setAccessIdempotencyTestHooks(null);
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access idempotency store get waits for same-instance writes instead of clobbering staged state", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-idempotency-get-wait-"));
  try {
    const storeA = new AccessIdempotencyStore(memoryDir);
    const storeB = new AccessIdempotencyStore(memoryDir);
    const verifier = new AccessIdempotencyStore(memoryDir);
    let releaseFirstWrite: (() => void) | null = null;
    const firstWritePaused = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let firstWriteEnteredResolve: (() => void) | null = null;
    const firstWriteEntered = new Promise<void>((resolve) => {
      firstWriteEnteredResolve = resolve;
    });
    let flushWriteCalls = 0;

    setAccessIdempotencyTestHooks({
      beforeFlushWrite: async () => {
        flushWriteCalls += 1;
        if (flushWriteCalls === 1) {
          firstWriteEnteredResolve?.();
          await firstWritePaused;
        }
      },
    });

    try {
      const lockHolder = storeB.put("key-lock", "hash-lock", { locked: true });
      await firstWriteEntered;

      const pendingPut = storeA.put("key-a", "hash-a", { accepted: true });
      await new Promise((resolve) => setTimeout(resolve, 25));

      let readResolved = false;
      const blockedRead = storeA.get("key-lock", "hash-lock").then((result) => {
        readResolved = true;
        return result;
      });

      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(
        readResolved,
        false,
        "same-instance reads should wait for the staged write to finish instead of reloading over in-memory state",
      );

      releaseFirstWrite?.();
      const [readResult] = await Promise.all([blockedRead, lockHolder, pendingPut]);
      assert.deepEqual(readResult.response, { locked: true });
    } finally {
      setAccessIdempotencyTestHooks(null);
    }

    const stored = await verifier.get("key-a", "hash-a");
    assert.deepEqual(stored.response, { accepted: true });
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
