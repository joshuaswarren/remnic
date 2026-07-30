import assert from "node:assert/strict";
import { appendFile, chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";

import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { StorageManager } from "./storage.js";
import { initLogger, resetLogger } from "./logger.js";
import {
  __resetProjectionFallbackWarnSuppressionForTest,
  PROJECTION_LEDGER_LAG_WARN_THRESHOLD_EVENTS,
  warnProjectionFallback,
} from "./storage-guards.js";
import { encryptFileBody, filePathAad, isEncryptedFile, readMaybeEncryptedFile, readMaybeEncryptedFileBuffer } from "./secure-store/secure-fs.js";
import type { MemoryLifecycleEvent } from "./types.js";
import {
  appendLifecycleEventsSerialized,
  drainPendingLifecycleAppendsSerialized,
  pendingLifecycleLedgerDir,
  readAllLifecycleEventsFromLedgerBuffer,
  type LifecyclePendingIo,
} from "./storage/memory-lifecycle-ledger-access.js";
import { withHeldFileLock } from "./utils/serialize-mutations.js";
import { listContainedSpillFiles } from "./utils/path-containment.js";
import { rebuildMemoryLifecycleLedger } from "./maintenance/rebuild-memory-lifecycle-ledger.js";
import type { RebuildMemoryLifecycleLedgerResult } from "./maintenance/rebuild-memory-lifecycle-ledger.js";
import {
  memoryLifecycleLedgerLockPath,
  MEMORY_LIFECYCLE_LEDGER_LOCK_STALE_MS,
  MEMORY_LIFECYCLE_LEDGER_APPEND_LOCK_MAX_WAIT_MS,
} from "./memory-lifecycle-ledger-utils.js";
import {
  readProjectionLifecycleLedgerHighWater,
} from "./maintenance/projection-support.js";
import { rebuildMemoryProjection } from "./maintenance/rebuild-memory-projection.js";

function lifecycleEvent(
  eventId: string,
  memoryId: string,
  timestamp: string,
): MemoryLifecycleEvent {
  return {
    eventId,
    memoryId,
    eventType: "created",
    timestamp,
    actor: "test",
    ruleVersion: "1",
  };
}

async function withLifecycleLedger(
  rows: string[],
  run: (storage: StorageManager, ledgerPath: string) => Promise<void>,
): Promise<void> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-lifecycle-stream-"));
  const ledgerPath = path.join(memoryDir, "state", "memory-lifecycle-ledger.jsonl");
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await writeFile(ledgerPath, `${rows.join("\n")}\n`, "utf8");
  try {
    await run(new StorageManager(memoryDir), ledgerPath);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
}

async function withStaleLifecycleProjection(
  projectedRows: MemoryLifecycleEvent[],
  appendedRows: MemoryLifecycleEvent[],
  run: (storage: StorageManager, memoryDir: string) => Promise<void>,
): Promise<void> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-lifecycle-projection-"));
  const ledgerPath = path.join(memoryDir, "state", "memory-lifecycle-ledger.jsonl");
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await writeFile(
    ledgerPath,
    `${projectedRows.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
  await rebuildMemoryProjection({ memoryDir, dryRun: false });
  await appendFile(
    ledgerPath,
    `${appendedRows.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
  try {
    await run(new StorageManager(memoryDir), memoryDir);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
}

test("readAllMemoryLifecycleEvents streams plaintext rows and preserves fail-open sorting", async () => {
  const later = lifecycleEvent("event-z", "memory-b", "2026-01-03T00:00:00.000Z");
  const earlier = lifecycleEvent("event-a", "memory-a", "2026-01-02T00:00:00.000Z");
  const earliest = lifecycleEvent("event-b", "memory-a", "2026-01-01T00:00:00.000Z");

  await withLifecycleLedger([
    JSON.stringify(later),
    "{malformed-json",
    JSON.stringify({ ...earlier, actor: 42 }),
    JSON.stringify(earlier),
    "   ",
    JSON.stringify(earliest),
  ], async (storage) => {
    let secureWholeFileReads = 0;
    const privateStorage = storage as unknown as {
      readStorageSecureFile(filePath: string): Promise<string>;
    };
    privateStorage.readStorageSecureFile = async () => {
      secureWholeFileReads += 1;
      throw new Error("plaintext lifecycle ledger must not use whole-file reads");
    };

    const events = await storage.readAllMemoryLifecycleEvents();

    assert.deepEqual(events, [earliest, earlier, later]);
    assert.equal(secureWholeFileReads, 0);
  });
});

test("readMemoryLifecycleEvents returns the canonical last-N tail, not the append tail", async () => {
  const first = lifecycleEvent("event-1", "memory-a", "2026-01-01T00:00:00.000Z");
  const second = lifecycleEvent("event-2", "memory-a", "2026-01-02T00:00:00.000Z");
  const third = lifecycleEvent("event-3", "memory-b", "2026-01-01T00:00:00.000Z");

  await withLifecycleLedger([
    JSON.stringify(third),
    JSON.stringify(first),
    JSON.stringify(second),
  ], async (storage) => {
    // The bounded read ranks by the canonical comparator (memoryId, timestamp,
    // eventType), then keeps the last 2 — identical to the pre-#1910 readAll →
    // sort → slice(-limit). Canonical order is [first, second, third], so the
    // last two are [second, third] regardless of append order (#1910,
    // CodeRabbit: keep the no-memoryId read on the canonical tail).
    assert.deepEqual(await storage.readMemoryLifecycleEvents(2), [second, third]);
  });
});

test("readMemoryLifecycleEvents(MAX_SAFE_INTEGER) equals readAllMemoryLifecycleEvents", async () => {
  const first = lifecycleEvent("event-1", "memory-a", "2026-01-01T00:00:00.000Z");
  const second = lifecycleEvent("event-2", "memory-a", "2026-01-02T00:00:00.000Z");
  const third = lifecycleEvent("event-3", "memory-b", "2026-01-01T00:00:00.000Z");

  await withLifecycleLedger([
    JSON.stringify(third),
    JSON.stringify(first),
    JSON.stringify(second),
  ], async (storage) => {
    const all = await storage.readAllMemoryLifecycleEvents();
    const capped = await storage.readMemoryLifecycleEvents(Number.MAX_SAFE_INTEGER);
    assert.deepEqual(capped, all);
  });
});

test("readMemoryLifecycleEvents(MAX_SAFE_INTEGER) admits unknown eventTypes exactly like readAll", async () => {
  const known = lifecycleEvent("event-1", "memory-a", "2026-01-01T00:00:00.000Z");
  // Structurally valid row whose eventType is NOT in the handled sort table.
  // readAll admits any string eventType, so the bounded governance read must
  // too — dropping it would silently diverge the projection-rebuild scan.
  const unknown = {
    eventId: "event-2",
    memoryId: "memory-a",
    eventType: "quantum_entangled",
    timestamp: "2026-01-02T00:00:00.000Z",
    actor: "test",
    ruleVersion: "1",
  };

  await withLifecycleLedger([
    JSON.stringify(known),
    JSON.stringify(unknown),
  ], async (storage) => {
    const all = await storage.readAllMemoryLifecycleEvents();
    const capped = await storage.readMemoryLifecycleEvents(Number.MAX_SAFE_INTEGER);
    assert.equal(all.length, 2, "readAll keeps the unknown-but-valid row");
    assert.deepEqual(capped, all, "governance read must not drop rows readAll admits");
    assert.ok(
      capped.map((event) => event.eventId).includes("event-2"),
      "unknown eventType row survives the governance read",
    );
  });
});

test("readMemoryLifecycleEvents tail read never triggers a whole-file secure read on plaintext", async () => {
  const rows: string[] = [];
  for (let i = 0; i < 500; i += 1) {
    const stamp = `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`;
    rows.push(JSON.stringify(lifecycleEvent(`event-${i}`, `memory-${i}`, stamp)));
  }
  await withLifecycleLedger(rows, async (storage) => {
    let secureWholeFileReads = 0;
    const privateStorage = storage as unknown as {
      readStorageSecureFile(filePath: string): Promise<string>;
    };
    privateStorage.readStorageSecureFile = async () => {
      secureWholeFileReads += 1;
      throw new Error("plaintext lifecycle ledger must not use whole-file reads");
    };
    const tail = await storage.readMemoryLifecycleEvents(200);
    assert.equal(tail.length, 200);
    assert.equal(secureWholeFileReads, 0);
  });
});

test("getMemoryTimeline fallback streams per-memory rows and warns", async () => {
  const target = "memory-target";
  const rows: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    // Target events appended in strictly increasing timestamp order — the
    // production invariant that makes ring-of-last-N-then-sort equal to the
    // old filter→slice(-N).
    const stamp = `2026-01-01T00:${String(i).padStart(2, "0")}:00.000Z`;
    rows.push(JSON.stringify(lifecycleEvent(`other-${i}`, `memory-other-${i}`, stamp)));
    rows.push(JSON.stringify(lifecycleEvent(`t-${i}`, target, stamp)));
  }
  await withLifecycleLedger(rows, async (storage) => {
    const all = await storage.readAllMemoryLifecycleEvents();
    const expected = all.filter((e) => e.memoryId === target).slice(-5);
    const timeline = await storage.getMemoryTimeline(target, 5);
    assert.deepEqual(timeline, expected);
    assert.ok(timeline.every((e) => e.memoryId === target));
  });
});

test("getMemoryTimeline fallback keeps the newest-by-timestamp events when an older row is appended last", async () => {
  const target = "memory-target";
  // Target rows appended in this order; the LAST-appended row carries the
  // OLDEST timestamp (a late backfill). The old append-tail-then-sort kept the
  // last N appended rows — so it would drop t2 (00:02, newer) and surface the
  // stale t5 (00:00). The canonical top-N must instead return the N newest by
  // timestamp, matching the pre-bounding filter→sort→slice semantics.
  const rows = [
    JSON.stringify(lifecycleEvent("other-a", "memory-other-a", "2026-01-01T00:05:00.000Z")),
    JSON.stringify(lifecycleEvent("t1", target, "2026-01-01T00:01:00.000Z")),
    JSON.stringify(lifecycleEvent("t2", target, "2026-01-01T00:02:00.000Z")),
    JSON.stringify(lifecycleEvent("other-b", "memory-other-b", "2026-01-01T00:06:00.000Z")),
    JSON.stringify(lifecycleEvent("t3", target, "2026-01-01T00:03:00.000Z")),
    JSON.stringify(lifecycleEvent("t4", target, "2026-01-01T00:04:00.000Z")),
    // Late-appended backfill with an older timestamp than t2/t3/t4.
    JSON.stringify(lifecycleEvent("t5", target, "2026-01-01T00:00:00.000Z")),
  ];
  await withLifecycleLedger(rows, async (storage) => {
    const all = await storage.readAllMemoryLifecycleEvents();
    const expected = all.filter((e) => e.memoryId === target).slice(-3);
    const timeline = await storage.getMemoryTimeline(target, 3);
    // Newest three by timestamp: t2 (00:02), t3 (00:03), t4 (00:04). The stale
    // last-appended t5 (00:00) is excluded.
    assert.deepEqual(
      timeline.map((e) => e.eventId),
      ["t2", "t3", "t4"],
    );
    assert.deepEqual(timeline, expected);
    assert.ok(timeline.every((e) => e.memoryId === target));
  });
});

test("readAllMemoryLifecycleEvents keeps the authenticated encrypted-file fallback", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-lifecycle-encrypted-"));
  const ledgerPath = path.join(memoryDir, "state", "memory-lifecycle-ledger.jsonl");
  const event = lifecycleEvent("event-encrypted", "memory-a", "2026-01-01T00:00:00.000Z");
  const key = Buffer.alloc(32, 7);
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await writeFile(
    ledgerPath,
    encryptFileBody(`${JSON.stringify(event)}\n`, key, filePathAad(ledgerPath, memoryDir)),
  );
  try {
    const storage = new StorageManager(memoryDir);
    storage.setSecureStoreKey(key);
    assert.deepEqual(await storage.readAllMemoryLifecycleEvents(), [event]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("readAllMemoryLifecycleEventsForCompaction reads an encrypted ledger via the uncapped buffer path (#2033)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-lifecycle-compaction-read-"));
  const ledgerPath = path.join(memoryDir, "state", "memory-lifecycle-ledger.jsonl");
  const a = lifecycleEvent("evt-a", "memory-a", "2026-01-01T00:00:00.000Z");
  const b = lifecycleEvent("evt-b", "memory-b", "2026-01-02T00:00:00.000Z");
  const key = Buffer.alloc(32, 3);
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await writeFile(
    ledgerPath,
    encryptFileBody(
      `${JSON.stringify(a)}\n${JSON.stringify(b)}\n`,
      key,
      filePathAad(ledgerPath, memoryDir),
    ),
  );
  try {
    const storage = new StorageManager(memoryDir);
    storage.setSecureStoreKey(key);
    // The compaction read must decrypt the same rows the general capped read
    // returns — but through the buffer path, so it also works past the
    // whole-file string decrypt cap that would otherwise block compaction.
    assert.deepEqual(await storage.readAllMemoryLifecycleEventsForCompaction(), [a, b]);
    assert.deepEqual(
      await storage.readAllMemoryLifecycleEventsForCompaction(),
      await storage.readAllMemoryLifecycleEvents(),
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("readAllMemoryLifecycleEventsForCompaction streams a plaintext ledger", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-lifecycle-plaintext-compaction-"));
  const ledgerPath = path.join(memoryDir, "state", "memory-lifecycle-ledger.jsonl");
  const a = lifecycleEvent("evt-plain-a", "memory-a", "2026-01-01T00:00:00.000Z");
  const b = lifecycleEvent("evt-plain-b", "memory-b", "2026-01-02T00:00:00.000Z");
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await writeFile(ledgerPath, `${JSON.stringify(a)}\n${JSON.stringify(b)}\n`, "utf8");
  try {
    const storage = new StorageManager(memoryDir);
    const privateStorage = storage as unknown as {
      readStorageSecureFile(filePath: string): Promise<string>;
    };
    privateStorage.readStorageSecureFile = async () => {
      throw new Error("plaintext lifecycle ledger must stream without whole-file reads");
    };
    assert.deepEqual(await storage.readAllMemoryLifecycleEventsForCompaction(), [a, b]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("readMemoryActionEventRows streams the action ledger and keeps source line numbers", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-action-stream-"));
  const ledgerPath = path.join(memoryDir, "state", "memory-actions.jsonl");
  const first = { timestamp: "2026-01-01T00:00:00.000Z", action: "store_note", outcome: "applied" };
  const second = { timestamp: "2026-01-02T00:00:00.000Z", action: "discard", outcome: "skipped" };
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await writeFile(
    ledgerPath,
    `${JSON.stringify(first)}\n{malformed-json\n${JSON.stringify(second)}\n`,
    "utf8",
  );
  try {
    const storage = new StorageManager(memoryDir);
    let secureWholeFileReads = 0;
    const privateStorage = storage as unknown as {
      readStorageSecureFile(filePath: string): Promise<string>;
    };
    privateStorage.readStorageSecureFile = async () => {
      secureWholeFileReads += 1;
      throw new Error("plaintext action ledger must not use whole-file reads");
    };

    assert.deepEqual(await storage.readMemoryActionEventRows(1), [{ line: 3, event: second }]);
    assert.equal(secureWholeFileReads, 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("appendLifecycleEventsSerialized waits out a held ledger lock instead of dropping the event (#2033)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-append-wait-"));
  try {
    const ledgerPath = path.join(dir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    await writeFile(ledgerPath, "", "utf8");
    const lockPath = memoryLifecycleLedgerLockPath(ledgerPath);

    // Simulate a compaction rewrite holding the shared lock while the append
    // contends for it. The append must WAIT for the holder to release rather
    // than give up and drop the event fail-open (the pre-#2033 behavior at 5s).
    // Ordering is driven by gate promises — never wall-clock sleeps — so the
    // holder provably owns the lock before the append starts and only releases
    // when we open the gate.
    const order: string[] = [];
    const acquiredGate = Promise.withResolvers<void>();
    const releaseGate = Promise.withResolvers<void>();
    const holder = withHeldFileLock(
      lockPath,
      { staleMs: MEMORY_LIFECYCLE_LEDGER_LOCK_STALE_MS, maxWaitMs: 1_000 },
      async (acquired) => {
        assert.ok(acquired, "test holder must acquire the lock");
        acquiredGate.resolve();
        await releaseGate.promise;
        order.push("holder-released");
      },
    );
    // The lock is provably held from here until we open the release gate.
    await acquiredGate.promise;

    const appendPromise = appendLifecycleEventsSerialized(
      ledgerPath,
      async (payload) => {
        order.push("append-ran");
        await appendFile(ledgerPath, payload, "utf8");
      },
      `${JSON.stringify(lifecycleEvent("evt-wait", "memory-a", "2026-03-08T00:00:00.000Z"))}\n`,
      undefined,
      { maxWaitMs: 2_000, pollMs: 20 },
    );

    // Release the holder; the append can only acquire after this.
    releaseGate.resolve();
    await appendPromise;
    await holder;

    assert.deepEqual(
      order,
      ["holder-released", "append-ran"],
      "append must acquire only after the holder released — it waited, not dropped",
    );
    assert.ok(
      (await readFile(ledgerPath, "utf8")).includes("evt-wait"),
      "the appended event must be persisted after the wait",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendLifecycleEventsSerialized refuses to append unlocked when the lock cannot be acquired (#2033)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-append-refuse-"));
  try {
    const ledgerPath = path.join(dir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    await writeFile(ledgerPath, "", "utf8");
    // A fresh (non-stale) foreign lock held for the whole test so acquisition
    // times out within the tiny budget and never stale-breaks. The append must
    // REFUSE to write unlocked rather than risk clobbering a concurrent rewrite.
    const lockPath = memoryLifecycleLedgerLockPath(ledgerPath);
    await writeFile(lockPath, `${process.pid} held-by-test ${new Date().toISOString()}\n`, "utf8");

    let appended = false;
    await assert.rejects(
      () => appendLifecycleEventsSerialized(
        ledgerPath,
        async () => {
          appended = true;
        },
        "x\n",
        undefined,
        { maxWaitMs: 100, pollMs: 20 },
      ),
      /could not acquire the ledger lock/,
    );
    assert.equal(appended, false, "must not append unlocked when the lock is unavailable");
    assert.equal(await readFile(ledgerPath, "utf8"), "", "ledger must be untouched");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("lifecycle append lock budget outlasts a compaction that holds the lock past 5s (#2033)", () => {
  // withHeldFileLock's default acquisition budget is 5s; a compaction rewrite of
  // a large ledger can legitimately hold the lock longer. The append budget must
  // cover the full stale-break window so such a hold is waited out (or a crashed
  // holder stale-broken) rather than dropping the event at 5s.
  assert.ok(
    MEMORY_LIFECYCLE_LEDGER_APPEND_LOCK_MAX_WAIT_MS >= MEMORY_LIFECYCLE_LEDGER_LOCK_STALE_MS,
    "append budget must be at least the stale window",
  );
  assert.ok(
    MEMORY_LIFECYCLE_LEDGER_APPEND_LOCK_MAX_WAIT_MS > 5_000,
    "append budget must exceed the 5s default that previously dropped events",
  );
});

/** Plaintext pending IO for the access-layer tests (the StorageManager
 *  integration test below exercises the encrypted-at-rest path). Faithful to the
 *  `LifecyclePendingIo` contract: `writeSecure` is ATOMIC — it writes to a temp
 *  file (a non-`*.jsonl` name the drain's lister skips) in the same dir, then
 *  renames it onto the final path, so a concurrent drain never sees a partial
 *  spill (#2033). */
function plaintextPendingIo(): LifecyclePendingIo {
  return {
    writeSecure: async (p, c) => {
      await mkdir(path.dirname(p), { recursive: true });
      const temp = `${p}.tmp-${randomUUID()}`;
      await writeFile(temp, c, "utf8");
      await rename(temp, p);
    },
    readSecure: (p) => readFile(p, "utf8"),
  };
}

test("appendLifecycleEventsSerialized spills to the durable pending queue instead of dropping when the lock is unavailable (#2033)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-append-spill-"));
  try {
    const ledgerPath = path.join(dir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    await writeFile(ledgerPath, "", "utf8");
    // A fresh (non-stale) foreign lock held for the whole test so acquisition
    // times out within the tiny budget and never stale-breaks.
    const lockPath = memoryLifecycleLedgerLockPath(ledgerPath);
    await writeFile(lockPath, `${process.pid} held-by-test ${new Date().toISOString()}\n`, "utf8");

    const pending = plaintextPendingIo();
    let ledgerAppended = false;
    // MUST NOT throw: the event is durably queued, not dropped fail-open.
    await appendLifecycleEventsSerialized(
      ledgerPath,
      async () => { ledgerAppended = true; },
      `${JSON.stringify(lifecycleEvent("evt-spill", "memory-a", "2026-03-08T00:00:00.000Z"))}\n`,
      pending,
      { maxWaitMs: 100, pollMs: 20 },
    );
    assert.equal(ledgerAppended, false, "lock unavailable — ledger not written directly");
    assert.equal(await readFile(ledgerPath, "utf8"), "", "ledger untouched while lock held");
    const spillDir = pendingLifecycleLedgerDir(ledgerPath);
    const files = await readdir(spillDir);
    assert.equal(files.length, 1, "exactly one spill file queued");
    assert.ok(
      (await readFile(path.join(spillDir, files[0]!), "utf8")).includes("evt-spill"),
      "event durably queued in the pending spill",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a concurrent drain never folds a partial spill; the finished spill is valid (#2033)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-append-spill-atomic-"));
  try {
    const ledgerPath = path.join(dir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    await writeFile(ledgerPath, "", "utf8");
    const spillDir = pendingLifecycleLedgerDir(ledgerPath);
    // Hold the ledger lock so the append cannot acquire it and must spill —
    // mirroring a compaction rewrite holding the lock while a lock-denied append
    // writes its spill WITHOUT the lock, concurrent with the holder's drain.
    const lockPath = memoryLifecycleLedgerLockPath(ledgerPath);
    await writeFile(lockPath, `${process.pid} held-by-test ${new Date().toISOString()}\n`, "utf8");
    const row = `${JSON.stringify(lifecycleEvent("evt-atomic", "memory-a", "2026-03-08T00:00:00.000Z"))}\n`;

    // Capture exactly what a concurrent fold-under-lock would enumerate + read
    // (the fold uses listContainedSpillFiles + a lazy readSecure) WHILE the
    // spill write is still in progress. An atomic writeSecure stages the full
    // payload under a temp name the `*.jsonl` lister skips, so the drain sees
    // nothing to fold until the rename lands the complete file (#2033).
    let drainSawDuringWrite: Array<{ file: string; content: string }> = [];
    const io: LifecyclePendingIo = {
      writeSecure: async (p, c) => {
        await mkdir(path.dirname(p), { recursive: true });
        const temp = `${p}.tmp-${randomUUID()}`;
        await writeFile(temp, c, "utf8");
        const listed = await listContainedSpillFiles(spillDir);
        drainSawDuringWrite = [];
        for (const f of listed) drainSawDuringWrite.push({ file: f, content: await readFile(f, "utf8") });
        await rename(temp, p);
      },
      readSecure: (p) => readFile(p, "utf8"),
    };

    await appendLifecycleEventsSerialized(
      ledgerPath,
      async () => { throw new Error("ledger append must not run while the lock is held"); },
      row,
      io,
      { maxWaitMs: 100, pollMs: 20 },
    );

    assert.deepEqual(
      drainSawDuringWrite,
      [],
      "a concurrent drain lists no in-progress spill, so it can never fold partial bytes",
    );

    // The finished spill is a single complete, valid row (never truncated).
    const spillFiles = await listContainedSpillFiles(spillDir);
    assert.equal(spillFiles.length, 1, "exactly one complete spill after the write");
    const spillContent = await readFile(spillFiles[0]!, "utf8");
    assert.equal(spillContent, row, "spill content is the whole payload, never a partial write");
    assert.doesNotThrow(() => JSON.parse(spillContent.trim()), "final spill is valid JSON");

    // Release the lock; a real drain folds exactly the one valid row.
    await rm(lockPath, { force: true });
    const drained = await drainPendingLifecycleAppendsSerialized(
      ledgerPath,
      async (payload) => { await appendFile(ledgerPath, payload, "utf8"); },
      io,
    );
    assert.equal(drained, true, "the completed spill drains into the ledger");
    const ledger = (await readFile(ledgerPath, "utf8")).trim().split("\n").filter(Boolean);
    assert.equal(ledger.length, 1, "exactly one row folded, none partial");
    assert.equal(JSON.parse(ledger[0]!).eventId, "evt-atomic");
    assert.equal((await readdir(spillDir)).length, 0, "spill removed after a successful drain");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a later append drains queued pending spills into the ledger (#2033)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-append-drain-"));
  try {
    const ledgerPath = path.join(dir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    await writeFile(ledgerPath, "", "utf8");
    const pending = plaintextPendingIo();
    // Pre-seed two spilled events (as prior lock-timed-out appends would leave).
    await pending.writeSecure(
      path.join(pendingLifecycleLedgerDir(ledgerPath), "a.jsonl"),
      `${JSON.stringify(lifecycleEvent("evt-old-1", "memory-a", "2026-03-08T00:00:00.000Z"))}\n`,
    );
    await pending.writeSecure(
      path.join(pendingLifecycleLedgerDir(ledgerPath), "b.jsonl"),
      `${JSON.stringify(lifecycleEvent("evt-old-2", "memory-a", "2026-03-08T00:30:00.000Z"))}\n`,
    );

    await appendLifecycleEventsSerialized(
      ledgerPath,
      async (payload) => { await appendFile(ledgerPath, payload, "utf8"); },
      `${JSON.stringify(lifecycleEvent("evt-new", "memory-b", "2026-03-08T01:00:00.000Z"))}\n`,
      pending,
    );

    const ledger = await readFile(ledgerPath, "utf8");
    assert.ok(ledger.includes("evt-old-1"), "first spilled event folded into ledger");
    assert.ok(ledger.includes("evt-old-2"), "second spilled event folded into ledger");
    assert.ok(ledger.includes("evt-new"), "new event appended");
    assert.equal(
      (await readdir(pendingLifecycleLedgerDir(ledgerPath))).length,
      0,
      "drained spill files removed",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("drainPendingLifecycleAppendsSerialized folds queued events into the ledger without a new append (#2033)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-append-drainonly-"));
  try {
    const ledgerPath = path.join(dir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    await writeFile(ledgerPath, "", "utf8");
    const pending = plaintextPendingIo();
    await pending.writeSecure(
      path.join(pendingLifecycleLedgerDir(ledgerPath), "q.jsonl"),
      `${JSON.stringify(lifecycleEvent("evt-queued", "memory-a", "2026-03-08T00:00:00.000Z"))}\n`,
    );

    const drained = await drainPendingLifecycleAppendsSerialized(
      ledgerPath,
      async (payload) => { await appendFile(ledgerPath, payload, "utf8"); },
      pending,
    );
    assert.equal(drained, true, "reports rows drained");
    assert.ok((await readFile(ledgerPath, "utf8")).includes("evt-queued"), "queued event in ledger");
    assert.equal(
      (await readdir(pendingLifecycleLedgerDir(ledgerPath))).length,
      0,
      "drained spill files removed",
    );

    // Nothing pending → no-op that reports false.
    const again = await drainPendingLifecycleAppendsSerialized(
      ledgerPath,
      async (payload) => { await appendFile(ledgerPath, payload, "utf8"); },
      pending,
    );
    assert.equal(again, false, "no pending rows → no drain");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test("pending drain commits oversized queues in bounded append batches (#2033)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-append-drain-bounded-"));
  try {
    const ledgerPath = path.join(dir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    await writeFile(ledgerPath, "", "utf8");
    const pending = plaintextPendingIo();
    const spillDir = pendingLifecycleLedgerDir(ledgerPath);
    const first = `first:${"x".repeat(700 * 1024)}\n`;
    const second = `second:${"y".repeat(700 * 1024)}\n`;
    await pending.writeSecure(path.join(spillDir, "a.jsonl"), first);
    await pending.writeSecure(path.join(spillDir, "b.jsonl"), second);
    const batches: string[] = [];

    const drained = await drainPendingLifecycleAppendsSerialized(
      ledgerPath,
      async (payload) => {
        batches.push(payload);
        await appendFile(ledgerPath, payload, "utf8");
      },
      pending,
    );

    assert.equal(drained, true, "rows were drained");
    assert.equal(batches.length, 2, "each oversized spill is committed separately");
    assert.ok(batches.every((payload) => Buffer.byteLength(payload, "utf8") <= 1024 * 1024));
    assert.equal(await readFile(ledgerPath, "utf8"), first + second);
    assert.equal((await readdir(spillDir)).length, 0, "all committed spills are removed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed ledger write leaves pending spills intact for retry (#2033)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-append-drainfail-"));
  try {
    const ledgerPath = path.join(dir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    await writeFile(ledgerPath, "", "utf8");
    const pending = plaintextPendingIo();
    await pending.writeSecure(
      path.join(pendingLifecycleLedgerDir(ledgerPath), "q.jsonl"),
      `${JSON.stringify(lifecycleEvent("evt-keep", "memory-a", "2026-03-08T00:00:00.000Z"))}\n`,
    );

    await assert.rejects(
      () => drainPendingLifecycleAppendsSerialized(
        ledgerPath,
        async () => { throw new Error("disk full"); },
        pending,
      ),
      /disk full/,
    );
    assert.equal(
      (await readdir(pendingLifecycleLedgerDir(ledgerPath))).length,
      1,
      "spill file NOT deleted when the ledger write failed",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager drains an encrypted pending spill into the encrypted-at-rest ledger (#2033)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-append-enc-drain-"));
  try {
    const key = Buffer.alloc(32, 7);
    const storage = new StorageManager(memoryDir);
    storage.setSecureStoreKey(key);
    const ledgerPath = path.join(memoryDir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    // Seed an encrypted-at-rest ledger with a base event through the storage API.
    await storage.appendMemoryLifecycleEvents([
      lifecycleEvent("evt-base", "memory-a", "2026-03-08T00:00:00.000Z"),
    ]);
    assert.ok(isEncryptedFile(await readFile(ledgerPath)), "precondition: ledger encrypted");

    // Pre-seed an encrypted spill file exactly as a lock-timed-out append leaves
    // it: encrypted at its own path-bound AAD.
    const spillDir = pendingLifecycleLedgerDir(ledgerPath);
    const spillPath = path.join(spillDir, "spill.jsonl");
    await mkdir(spillDir, { recursive: true });
    const spillRow = `${JSON.stringify(lifecycleEvent("evt-spilled", "memory-b", "2026-03-08T01:00:00.000Z"))}\n`;
    await writeFile(spillPath, encryptFileBody(spillRow, key, filePathAad(spillPath, memoryDir)));

    const drained = await storage.drainPendingMemoryLifecycleEvents();
    assert.equal(drained, true, "drain reports rows folded");
    const ids = (await storage.readAllMemoryLifecycleEvents()).map((e) => e.eventId);
    assert.ok(ids.includes("evt-base") && ids.includes("evt-spilled"), "both events readable from ledger");
    assert.ok(isEncryptedFile(await readFile(ledgerPath)), "ledger stays encrypted at rest after drain");
    await assert.rejects(() => stat(spillPath), /ENOENT/, "spill file removed after drain");

    // No pending → fast no-op.
    assert.equal(await storage.drainPendingMemoryLifecycleEvents(), false, "no pending → no drain");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("pending drain rejects a symlinked spill entry pointing outside the pending dir (#2033)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-append-spill-symlink-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "remnic-append-spill-outside-"));
  try {
    const ledgerPath = path.join(dir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    await writeFile(ledgerPath, "", "utf8");
    const pending = plaintextPendingIo();
    const spillDir = pendingLifecycleLedgerDir(ledgerPath);

    // A legitimate plaintext spill that MUST drain.
    await pending.writeSecure(
      path.join(spillDir, "legit.jsonl"),
      `${JSON.stringify(lifecycleEvent("evt-legit", "memory-a", "2026-03-08T00:00:00.000Z"))}\n`,
    );
    // A hostile secret OUTSIDE the pending dir, reached via a symlink whose name
    // ends in .jsonl so a naive drain would readSecure (and later unlink) it.
    const outsideSecret = path.join(outsideDir, "secret.txt");
    const outsideContent = "top-secret-outside-the-store\n";
    await writeFile(outsideSecret, outsideContent, "utf8");
    await symlink(outsideSecret, path.join(spillDir, "evil.jsonl"));

    const drained = await drainPendingLifecycleAppendsSerialized(
      ledgerPath,
      async (payload) => { await appendFile(ledgerPath, payload, "utf8"); },
      pending,
    );

    assert.equal(drained, true, "the legitimate spill still drained");
    const ledger = await readFile(ledgerPath, "utf8");
    assert.ok(ledger.includes("evt-legit"), "legit spill folded into the ledger");
    assert.ok(
      !ledger.includes("top-secret-outside-the-store"),
      "symlinked outside file must NOT be read into the ledger",
    );
    // The outside target must be untouched: never read into the ledger, never
    // unlinked through the symlink.
    assert.equal(
      await readFile(outsideSecret, "utf8"),
      outsideContent,
      "outside symlink target must survive the drain intact",
    );
    // The legit spill was drained (deleted); the hostile symlink was skipped
    // (never read, never deleted) so it remains.
    const remaining = await readdir(spillDir);
    assert.deepEqual(remaining, ["evil.jsonl"], "only the skipped hostile symlink remains");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("pending drain skips an unclaimable spill and later drains it exactly once — no duplicate (#2033)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-append-drain-dup-"));
  const ledgerPath = path.join(dir, "state", "memory-lifecycle-ledger.jsonl");
  const spillDir = pendingLifecycleLedgerDir(ledgerPath);
  try {
    await mkdir(spillDir, { recursive: true });
    await writeFile(ledgerPath, "", "utf8");
    const pending = plaintextPendingIo();
    await pending.writeSecure(
      path.join(spillDir, "q.jsonl"),
      `${JSON.stringify(lifecycleEvent("evt-dup", "memory-a", "2026-03-08T00:00:00.000Z"))}\n`,
    );

    // A read-only spill dir lets the read succeed but blocks the rename CLAIM
    // (`q.jsonl` → `q.jsonl.claimed`, which needs directory write). Because the
    // drain claims by rename BEFORE committing, an unclaimable spill is skipped
    // this pass — never committed-then-left-behind — so a later drain cannot
    // re-read and duplicate it.
    await chmod(spillDir, 0o555);
    const first = await drainPendingLifecycleAppendsSerialized(
      ledgerPath,
      async (payload) => { await appendFile(ledgerPath, payload, "utf8"); },
      pending,
    );
    assert.equal(first, false, "unclaimable spill is not drained this pass");
    assert.ok(
      !(await readFile(ledgerPath, "utf8")).includes("evt-dup"),
      "unclaimable spill must NOT be written to the ledger",
    );
    assert.equal((await readdir(spillDir)).length, 1, "unclaimed spill remains for a later pass");

    // Restore write permission; the spill drains exactly once.
    await chmod(spillDir, 0o755);
    const second = await drainPendingLifecycleAppendsSerialized(
      ledgerPath,
      async (payload) => { await appendFile(ledgerPath, payload, "utf8"); },
      pending,
    );
    assert.equal(second, true, "spill drains once permissions allow the claim");
    const ledger = await readFile(ledgerPath, "utf8");
    assert.equal(ledger.split("evt-dup").length - 1, 1, "event folded into the ledger exactly once — no duplicate");
    assert.equal((await readdir(spillDir)).length, 0, "pending spill drained empty");
  } finally {
    await chmod(spillDir, 0o755).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("pending drain recovers a claim orphaned by a crash before commit — the row is never lost (#2033)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-append-drain-crash-"));
  const ledgerPath = path.join(dir, "state", "memory-lifecycle-ledger.jsonl");
  const spillDir = pendingLifecycleLedgerDir(ledgerPath);
  try {
    await mkdir(spillDir, { recursive: true });
    await writeFile(ledgerPath, "", "utf8");
    const pending = plaintextPendingIo();
    // Simulate a drain that CLAIMED a spill (renamed q.jsonl → q.jsonl.claimed)
    // and then the process CRASHED before committing the rows to the ledger. The
    // .claimed file is the ONLY durable copy of the event — plain unlink-before-
    // commit would have already deleted it and lost the row.
    await writeFile(
      path.join(spillDir, "q.jsonl.claimed"),
      `${JSON.stringify(lifecycleEvent("evt-orphan", "memory-a", "2026-03-08T00:00:00.000Z"))}\n`,
      "utf8",
    );

    const drained = await drainPendingLifecycleAppendsSerialized(
      ledgerPath,
      async (payload) => { await appendFile(ledgerPath, payload, "utf8"); },
      pending,
    );

    assert.equal(drained, true, "orphaned claim is recovered and committed");
    const ledger = await readFile(ledgerPath, "utf8");
    assert.ok(ledger.includes("evt-orphan"), "orphaned event folded into the ledger — not lost to the crash");
    assert.equal(ledger.split("evt-orphan").length - 1, 1, "committed exactly once");
    assert.equal((await readdir(spillDir)).length, 0, "recovered claim cleaned up after commit");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an append recovers a crash-orphaned claim alongside the new event (#2033)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-append-crash-fold-"));
  const ledgerPath = path.join(dir, "state", "memory-lifecycle-ledger.jsonl");
  const spillDir = pendingLifecycleLedgerDir(ledgerPath);
  try {
    await mkdir(spillDir, { recursive: true });
    await writeFile(ledgerPath, "", "utf8");
    const pending = plaintextPendingIo();
    // A claim orphaned by a crashed prior drain, plus a brand-new append: the
    // append path must recover the orphan AND write the new event, losing neither.
    await writeFile(
      path.join(spillDir, "orphan.jsonl.claimed"),
      `${JSON.stringify(lifecycleEvent("evt-orphan", "memory-a", "2026-03-08T00:00:00.000Z"))}\n`,
      "utf8",
    );

    await appendLifecycleEventsSerialized(
      ledgerPath,
      async (payload) => { await appendFile(ledgerPath, payload, "utf8"); },
      `${JSON.stringify(lifecycleEvent("evt-new", "memory-b", "2026-03-08T01:00:00.000Z"))}\n`,
      pending,
    );

    const ledger = await readFile(ledgerPath, "utf8");
    assert.ok(ledger.includes("evt-orphan"), "crash-orphaned claim recovered into the ledger");
    assert.ok(ledger.includes("evt-new"), "new event appended");
    assert.equal((await readdir(spillDir)).length, 0, "spill dir drained empty");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendLifecycleEventsSerialized refuses to write a spill into a symlinked pending directory (#2033)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-append-spill-symlink-dir-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "remnic-append-spill-outside-dir-"));
  try {
    const ledgerPath = path.join(dir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    await writeFile(ledgerPath, "", "utf8");
    // Plant a symlink AT the spill-directory path pointing at a real directory
    // outside the memory store. The write path must refuse it before any file
    // lands in the target.
    const spillDir = pendingLifecycleLedgerDir(ledgerPath);
    await symlink(outsideDir, spillDir);

    // Hold the ledger lock from a foreign owner so the append takes the spill
    // branch instead of writing the ledger directly.
    const lockPath = memoryLifecycleLedgerLockPath(ledgerPath);
    await writeFile(lockPath, `${process.pid} held-by-test ${new Date().toISOString()}\n`, "utf8");

    await assert.rejects(
      () =>
        appendLifecycleEventsSerialized(
          ledgerPath,
          async () => { throw new Error("ledger append must not run"); },
          `${JSON.stringify(lifecycleEvent("evt-symlink", "memory-a", "2026-03-08T00:00:00.000Z"))}\n`,
          plaintextPendingIo(),
          { maxWaitMs: 100, pollMs: 20 },
        ),
      /symlinked or non-directory/,
      "spill write into a symlinked pending dir must be refused",
    );

    assert.equal(
      (await lstat(spillDir)).isSymbolicLink(),
      true,
      "spill directory symlink left intact (not replaced by a real dir)",
    );
    assert.deepEqual(
      await readdir(outsideDir),
      [],
      "no spill file leaked through the symlink into the outside directory",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("rebuild aborts the compaction rewrite when a peer stale-breaks the ledger lock mid-section (#1910/#2033)", async () => {
  // The preserve+merge+serialize inside the lock is CPU-bound and blocks the
  // timer heartbeat, so within the 30s stale window a peer can judge the lock
  // stale, break it, and hold its own. The rewrite MUST re-assert ownership
  // right before its destructive write and ABORT — not rename its compacted
  // file over the peer's append. We drive the peer break deterministically as a
  // side effect of the under-lock preserve read.
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-rebuild-lock-lost-"));
  try {
    await mkdir(path.join(memoryDir, "facts", "2026-03-08"), { recursive: true });
    await writeFile(
      path.join(memoryDir, "facts", "2026-03-08", "fact-1.md"),
      `---\nid: fact-1\ncategory: fact\ncreated: 2026-03-08T00:00:00.000Z\n`
      + `updated: 2026-03-08T01:00:00.000Z\nsource: test\nconfidence: 0.8\n`
      + `confidenceTier: implied\ntags: ["alpha"]\n---\n\nalpha\n`,
      "utf8",
    );
    const ledgerPath = path.join(memoryDir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    const originalRow =
      `${JSON.stringify(lifecycleEvent("evt-original", "fact-1", "2026-03-08T00:30:00.000Z"))}\n`;
    await writeFile(ledgerPath, originalRow, "utf8");

    const lockPath = memoryLifecycleLedgerLockPath(ledgerPath);
    const foreignOwner = "00000000-0000-4000-8000-000000000000";
    const storage = new StorageManager(memoryDir);
    // Simulate a peer stale-breaking our lock DURING the under-lock preserve
    // read: overwrite the lock content with a foreign owner id (a peer that now
    // holds it). The rewrite's pre-write ownership re-check must then see the
    // lock is no longer ours and abort.
    const origRead = storage.readAllMemoryLifecycleEventsForCompaction.bind(storage);
    let broken = false;
    storage.readAllMemoryLifecycleEventsForCompaction = async () => {
      const events = await origRead();
      if (!broken) {
        broken = true;
        await writeFile(lockPath, `999999 ${foreignOwner} ${new Date().toISOString()}\n`, "utf8");
      }
      return events;
    };

    await assert.rejects(
      rebuildMemoryLifecycleLedger({
        memoryDir,
        dryRun: false,
        storage,
        preserveExistingEvents: true,
      }),
      /lost the ledger lock during the compaction rewrite/,
      "rewrite must abort rather than clobber a peer that stale-broke the lock",
    );

    assert.match(
      await readFile(lockPath, "utf8"),
      new RegExp(foreignOwner),
      "foreign (peer) lock left intact — the aborted rewrite never released it",
    );
    assert.equal(
      await readFile(ledgerPath, "utf8"),
      originalRow,
      "active ledger not clobbered by the aborted rewrite",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("encrypted rebuild backup retains raw malformed/truncated/future rows verbatim while the active ledger normalizes (#2033)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-rebuild-raw-backup-"));
  try {
    const key = Buffer.alloc(32, 9);
    const storage = new StorageManager(memoryDir);
    storage.setSecureStoreKey(key);
    const ledgerPath = path.join(memoryDir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(ledgerPath), { recursive: true });

    // Seed an encrypted-at-rest ledger that mixes valid rows with rows the
    // fail-open parser silently drops: a non-JSON line, a truncated JSON line,
    // and a valid-but-future-schema row carrying an unknown field. The backup
    // must keep every byte; the compacted active ledger may drop the garbage.
    const validA = JSON.stringify(lifecycleEvent("evt-a", "memory-a", "2026-01-01T00:00:00.000Z"));
    const validB = JSON.stringify(lifecycleEvent("evt-b", "memory-b", "2026-01-02T00:00:00.000Z"));
    const malformed = "this-is-not-json-at-all";
    const truncated = '{"eventId":"evt-broken","memoryId":"memory-c",';
    const future = JSON.stringify({
      ...lifecycleEvent("evt-future", "memory-d", "9999-12-31T23:59:59.000Z"),
      unknownFutureField: { schema: 42 },
    });
    const rawContent = `${validA}\n${malformed}\n${truncated}\n${validB}\n${future}\n`;
    await writeFile(ledgerPath, encryptFileBody(rawContent, key, filePathAad(ledgerPath, memoryDir)));
    assert.ok(isEncryptedFile(await readFile(ledgerPath)), "precondition: ledger encrypted at rest");

    const result = await rebuildMemoryLifecycleLedger({
      memoryDir,
      dryRun: false,
      storage,
      preserveExistingEvents: true,
    });

    // A timestamped encrypted backup was written.
    assert.ok(result.backupPath, "a backup path was produced");
    assert.match(result.backupPath!, /archive[/\\]memory-lifecycle-ledger[/\\]/);
    assert.ok(isEncryptedFile(await readFile(result.backupPath!)), "backup encrypted at rest");

    // The backup, decrypted under its OWN path AAD, is byte-for-byte the raw
    // pre-compaction ledger: no reserialization, no dropped garbage rows.
    const backupDecrypted = await readMaybeEncryptedFile(result.backupPath!, key, memoryDir);
    assert.equal(backupDecrypted, rawContent, "backup preserves raw decrypted bytes verbatim");
    for (const raw of [malformed, truncated, future]) {
      assert.ok(backupDecrypted.includes(raw), `backup retains raw row: ${raw}`);
    }

    // The active ledger normalized: the garbage rows are gone, the valid rows
    // survive, and its decrypted content is NOT the raw seed.
    const activeDecrypted = await readMaybeEncryptedFile(ledgerPath, key, memoryDir);
    assert.notEqual(activeDecrypted, rawContent, "active ledger was compacted, not copied");
    assert.ok(!activeDecrypted.includes(malformed), "active ledger dropped the non-JSON row");
    assert.ok(!activeDecrypted.includes(truncated), "active ledger dropped the truncated row");
    const activeIds = (await storage.readAllMemoryLifecycleEvents()).map((e) => e.eventId);
    assert.ok(activeIds.includes("evt-a") && activeIds.includes("evt-b"), "valid rows preserved in active ledger");
    assert.ok(!activeIds.includes("evt-broken"), "malformed row absent from active ledger");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("encrypted rebuild forces encryption for backup + active ledger even when encrypt-on-write is paused (#2033)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-rebuild-force-encrypt-"));
  try {
    const key = Buffer.alloc(32, 11);
    // Store is UNLOCKED (key present) but the encrypt-on-write policy is paused.
    // A compaction of an already-encrypted ledger must still preserve encryption
    // at rest — a plaintext rewrite would silently downgrade encrypted state.
    const storage = new StorageManager(memoryDir);
    storage.setSecureStoreKey(key, false);
    assert.equal(storage.willEncryptStateWrites(), false, "precondition: encrypt-on-write paused");
    const ledgerPath = path.join(memoryDir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(ledgerPath), { recursive: true });

    // Seed an encrypted-at-rest ledger with two valid rows plus a garbage row so
    // the compaction produces a DIFFERENT active ledger (no no-op skip) and a
    // timestamped backup.
    const validA = JSON.stringify(lifecycleEvent("evt-a", "memory-a", "2026-01-01T00:00:00.000Z"));
    const validB = JSON.stringify(lifecycleEvent("evt-b", "memory-b", "2026-01-02T00:00:00.000Z"));
    const rawContent = `${validA}\nnot-json-garbage\n${validB}\n`;
    await writeFile(ledgerPath, encryptFileBody(rawContent, key, filePathAad(ledgerPath, memoryDir)));
    assert.ok(isEncryptedFile(await readFile(ledgerPath)), "precondition: ledger encrypted at rest");

    const result = await rebuildMemoryLifecycleLedger({
      memoryDir,
      dryRun: false,
      storage,
      preserveExistingEvents: true,
    });

    // The active ledger stays encrypted at rest and remains decryptable — no
    // plaintext downgrade despite the paused encrypt-on-write policy.
    assert.ok(result.rewritten, "a real rewrite happened");
    assert.ok(isEncryptedFile(await readFile(ledgerPath)), "active ledger stays encrypted at rest");
    const activeDecrypted = await readMaybeEncryptedFile(ledgerPath, key, memoryDir);
    assert.ok(!activeDecrypted.includes("not-json-garbage"), "active ledger compacted the garbage row");

    // The backup is encrypted at rest too and decrypts to the raw pre-compaction
    // bytes under its own path AAD.
    assert.ok(result.backupPath, "a backup path was produced");
    assert.ok(isEncryptedFile(await readFile(result.backupPath!)), "backup stays encrypted at rest");
    const backupDecrypted = await readMaybeEncryptedFile(result.backupPath!, key, memoryDir);
    assert.equal(backupDecrypted, rawContent, "backup preserves raw decrypted bytes verbatim");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("encrypted rebuild backup never materializes the raw ledger as one giant string and stays byte-identical (#2033)", async () => {
  // Regression for the P2 raw-backup thread: the secure-store backup path once
  // read the decrypted ledger via `Buffer.toString("utf8")`. For a ledger that
  // already grew past V8's ~512MB string ceiling — the exact corruption this PR
  // recovers from — that throw aborted BOTH auto-compaction and
  // `rebuild-memory-lifecycle-ledger --write`, leaving the oversized ledger
  // unrepairable. The raw bytes must now flow Buffer -> re-encrypt without a
  // whole-buffer decode. We prove it deterministically (no 512MB allocation) by
  // trapping any whole-buffer utf8 decode above a small cap while the rebuild
  // runs; a single such decode fails the test.
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-rebuild-raw-nostring-"));
  const originalToString = Buffer.prototype.toString;
  try {
    const key = Buffer.alloc(32, 7);
    const storage = new StorageManager(memoryDir);
    storage.setSecureStoreKey(key);
    const ledgerPath = path.join(memoryDir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(ledgerPath), { recursive: true });

    // A ~2MB encrypted ledger: two valid rows plus many non-JSON garbage lines
    // the fail-open parser drops. The active rewrite stays tiny (two rows) while
    // the RAW backup must retain every byte.
    const validA = JSON.stringify(lifecycleEvent("evt-a", "memory-a", "2026-01-01T00:00:00.000Z"));
    const validB = JSON.stringify(lifecycleEvent("evt-b", "memory-b", "2026-01-02T00:00:00.000Z"));
    const garbageLine = `not-json-${"x".repeat(200)}`;
    const garbage = `${garbageLine}\n`.repeat(10_000); // ~2MB of undroppable-verbatim noise
    const rawContent = `${validA}\n${garbage}${validB}\n`;
    const rawBytes = Buffer.from(rawContent, "utf8");
    assert.ok(rawBytes.byteLength > 2_000_000, "precondition: raw ledger is multi-megabyte");
    await writeFile(ledgerPath, encryptFileBody(rawContent, key, filePathAad(ledgerPath, memoryDir)));
    assert.ok(isEncryptedFile(await readFile(ledgerPath)), "precondition: ledger encrypted at rest");

    // Trap ONLY a whole-buffer utf8 decode larger than the cap. Ranged decodes
    // (the per-line ledger reader) produce small strings and pass, exactly as
    // V8's real "Invalid string length" limit fires on the result length — not
    // the receiver's size. If the raw-backup path still stringified the whole
    // decrypted buffer, this throws and the rebuild rejects.
    const STRING_CAP = 1_000_000;
    let trippedGiantDecode = false;
    Buffer.prototype.toString = function patchedToString(this: Buffer, ...args: unknown[]): string {
      const encoding = args[0];
      const start = typeof args[1] === "number" ? args[1] : 0;
      const end = typeof args[2] === "number" ? args[2] : this.length;
      const span = Math.max(0, end - start);
      const isUtf8 = encoding === undefined || /^utf-?8$/i.test(String(encoding));
      if (isUtf8 && span > STRING_CAP) {
        trippedGiantDecode = true;
        throw new Error(
          "Cannot create a string longer than 0x1fffffe8 characters (simulated V8 string cap)",
        );
      }
      return originalToString.apply(this, args as never) as string;
    } as typeof Buffer.prototype.toString;

    let result: RebuildMemoryLifecycleLedgerResult;
    try {
      result = await rebuildMemoryLifecycleLedger({
        memoryDir,
        dryRun: false,
        storage,
        preserveExistingEvents: true,
      });
    } finally {
      Buffer.prototype.toString = originalToString;
    }

    assert.equal(
      trippedGiantDecode,
      false,
      "rebuild must never decode the whole raw ledger buffer to a string",
    );

    // The backup, decrypted under its OWN path AAD, is byte-for-byte the raw
    // pre-compaction ledger — compared as buffers to avoid materializing a giant
    // string in the assertion itself.
    assert.ok(result.backupPath, "a backup path was produced");
    assert.ok(isEncryptedFile(await readFile(result.backupPath!)), "backup encrypted at rest");
    const backupBytes = await readMaybeEncryptedFileBuffer(result.backupPath!, key, memoryDir);
    assert.equal(Buffer.compare(backupBytes, rawBytes), 0, "backup preserves raw decrypted bytes verbatim");

    // The active ledger normalized down to the two valid rows.
    const activeIds = (await storage.readAllMemoryLifecycleEvents()).map((e) => e.eventId);
    assert.deepEqual(activeIds.sort(), ["evt-a", "evt-b"], "active ledger keeps only the valid rows");
  } finally {
    Buffer.prototype.toString = originalToString;
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("pending drain reads spills lazily per batch, not all up front — memory-bounded (#2033)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-append-drain-lazy-"));
  try {
    const ledgerPath = path.join(dir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    await writeFile(ledgerPath, "", "utf8");
    const spillDir = pendingLifecycleLedgerDir(ledgerPath);
    await mkdir(spillDir, { recursive: true });
    // Four ~400KB spills. Bounded 1MB batches commit two per append, so with a
    // LAZY per-batch read the second batch's reads happen AFTER the first
    // batch's append. An eager collect-all would read EVERY spill before any
    // append, holding the whole queue in memory at once (the memory the bound
    // exists to cap, #2033).
    const chunk = "z".repeat(400 * 1024);
    for (const name of ["a", "b", "c", "d"]) {
      await writeFile(path.join(spillDir, `${name}.jsonl`), `${name}:${chunk}\n`, "utf8");
    }
    const events: string[] = [];
    const io: LifecyclePendingIo = {
      writeSecure: async () => { throw new Error("writeSecure unused in this drain test"); },
      readSecure: async (p) => {
        events.push("read");
        return readFile(p, "utf8");
      },
    };
    const drained = await drainPendingLifecycleAppendsSerialized(
      ledgerPath,
      async (payload) => { events.push("append"); await appendFile(ledgerPath, payload, "utf8"); },
      io,
    );
    assert.equal(drained, true, "rows drained");
    assert.ok(events.includes("append"), "at least one append happened");
    assert.ok(
      events.indexOf("append") < events.lastIndexOf("read"),
      `a spill was read AFTER an append (lazy per-batch read), not all up front: ${events.join(",")}`,
    );
    const ledger = await readFile(ledgerPath, "utf8");
    for (const name of ["a", "b", "c", "d"]) {
      assert.ok(ledger.includes(`${name}:`), `${name} folded into the ledger`);
    }
    assert.equal((await readdir(spillDir)).length, 0, "all spills drained");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("compaction buffer reader skips an oversized unterminated row instead of throwing (#2033)", async () => {
  const validA = lifecycleEvent("evt-a", "memory-a", "2026-01-01T00:00:00.000Z");
  const validB = lifecycleEvent("evt-b", "memory-b", "2026-01-02T00:00:00.000Z");
  // A single malformed row far larger than the per-row decode cap (64MB) with no
  // newline: decoding it whole as one string could exceed V8's string limit and
  // THROW before the fail-open parser can drop it, aborting a compaction that
  // could otherwise rewrite the ledger from its good rows. It MUST be skipped
  // undecoded; the valid rows on either side still parse.
  const oversized = Buffer.alloc(64 * 1024 * 1024 + 1, 0x41); // 'A' * (cap+1), no newline
  const buf = Buffer.concat([
    oversized,
    Buffer.from(`\n${JSON.stringify(validA)}\n${JSON.stringify(validB)}\n`, "utf8"),
  ]);
  const events = await readAllLifecycleEventsFromLedgerBuffer(
    path.join("state", "memory-lifecycle-ledger.jsonl"),
    async () => buf,
  );
  assert.deepEqual(
    events.map((e) => e.eventId),
    ["evt-a", "evt-b"],
    "valid rows returned; the oversized row is skipped without throwing",
  );
});

test("getMemoryTimeline fallback WARN is loud with lag and rate-limited when the projection is missing (#2119)", async () => {
  const warns: string[] = [];
  initLogger({ info() {}, warn: (m) => warns.push(m), error() {}, debug() {} }, false);
  __resetProjectionFallbackWarnSuppressionForTest();
  try {
    const rows = [
      JSON.stringify(lifecycleEvent("t1", "memory-target", "2026-01-01T00:01:00.000Z")),
      JSON.stringify(lifecycleEvent("t2", "memory-target", "2026-01-01T00:02:00.000Z")),
    ];
    await withLifecycleLedger(rows, async (storage) => {
      // No projection sqlite exists in this temp dir, so both calls take the
      // ledger fallback — the exact issue-#2119 regression path.
      const first = await storage.getMemoryTimeline("memory-target", 5);
      const second = await storage.getMemoryTimeline("memory-target", 5);
      assert.equal(first.length, 2);
      assert.equal(second.length, 2);

      const timelineWarns = warns.filter((w) => w.includes("storage.getMemoryTimeline"));
      // Rate-limited: two fallbacks, but only ONE WARN in the interval (no spam).
      assert.equal(timelineWarns.length, 1, "fallback WARN must fire once, not per call");
      // Loud: the single WARN names the fallback AND the projection lag.
      assert.match(timelineWarns[0]!, /falling back to full corpus/);
      assert.match(timelineWarns[0]!, /projection never rebuilt/);
    });
  } finally {
    resetLogger();
    __resetProjectionFallbackWarnSuppressionForTest();
  }
});

test("getMemoryTimeline fallback emits below-threshold ledger lag telemetry without a WARN (#2119)", async () => {
  const warns: string[] = [];
  const debug: string[] = [];
  initLogger({ info() {}, warn: (message) => warns.push(message), error() {}, debug: (message) => debug.push(message) }, true);
  __resetProjectionFallbackWarnSuppressionForTest();
  try {
    const projected = lifecycleEvent("projected-1", "memory-existing", "2026-01-01T00:01:00.000Z");
    const appended = lifecycleEvent("current-1", "memory-target", "2026-01-01T00:02:00.000Z");
    await withStaleLifecycleProjection([projected], [appended], async (storage, memoryDir) => {
      const highWater = readProjectionLifecycleLedgerHighWater(memoryDir);
      assert.equal(highWater?.eventCount, 1, "rebuild persists the source-ledger event-count high-water");

      const timeline = await storage.getMemoryTimeline("memory-target", 5);
      assert.deepEqual(timeline.map((event) => event.eventId), ["current-1"]);
      assert.equal(warns.length, 0, "lag at or below the threshold must not WARN");
      const telemetry = debug.find((message) => message.includes("storage.getMemoryTimeline"));
      assert.ok(telemetry, "fallback emits ledger-relative lag telemetry below the WARN threshold");
      assert.match(telemetry, /projected_events=1/);
      assert.match(telemetry, /current_ledger_events=2/);
      assert.match(telemetry, /delta_events=1/);
      assert.match(telemetry, /fallback_action=full-ledger-scan/);
    });
  } finally {
    resetLogger();
    __resetProjectionFallbackWarnSuppressionForTest();
  }
});

test("getMemoryTimeline fallback WARNS above the ledger lag threshold and rate-limits repeats (#2119)", async () => {
  const warns: string[] = [];
  initLogger({ info() {}, warn: (message) => warns.push(message), error() {}, debug() {} }, false);
  __resetProjectionFallbackWarnSuppressionForTest();
  try {
    const projected = lifecycleEvent("projected-1", "memory-existing", "2026-01-01T00:00:00.000Z");
    const delta = PROJECTION_LEDGER_LAG_WARN_THRESHOLD_EVENTS + 1;
    const appended = Array.from({ length: delta }, (_, index) =>
      lifecycleEvent(
        `current-${index}`,
        "memory-target",
        `2026-01-01T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
      ));
    await withStaleLifecycleProjection([projected], appended, async (storage) => {
      const first = await storage.getMemoryTimeline("memory-target", 5);
      const second = await storage.getMemoryTimeline("memory-target", 5);
      assert.equal(first.length, 5);
      assert.deepEqual(second, first);

      const timelineWarns = warns.filter((message) => message.includes("storage.getMemoryTimeline"));
      assert.equal(timelineWarns.length, 1, "two above-threshold fallbacks emit one WARN per suppression interval");
      const warning = timelineWarns[0]!;
      assert.match(warning, /falling back to full corpus/);
      assert.match(warning, /projected_events=1/);
      assert.match(warning, new RegExp(`current_ledger_events=${delta + 1}`));
      assert.match(warning, new RegExp(`delta_events=${delta}`));
      assert.match(warning, new RegExp(`threshold_events=${PROJECTION_LEDGER_LAG_WARN_THRESHOLD_EVENTS}`));
      assert.match(warning, /fallback_action=full-ledger-scan/);
      assert.match(warning, /last rebuilt/);
    });
  } finally {
    resetLogger();
    __resetProjectionFallbackWarnSuppressionForTest();
  }
});

test("projection fallback threshold zero still WARNS for positive ledger lag (#2119)", () => {
  const warns: string[] = [];
  initLogger({ info() {}, warn: (message) => warns.push(message), error() {}, debug() {} }, false);
  __resetProjectionFallbackWarnSuppressionForTest();
  try {
    warnProjectionFallback(
      "memory-dir",
      "getMemoryTimeline",
      undefined,
      {
        projectedEvents: 0,
        currentLedgerEvents: 1,
        deltaEvents: 1,
        warnThresholdEvents: 0,
      },
    );
    assert.equal(warns.length, 1, "zero is an active threshold, not a disabled sentinel");
    assert.match(warns[0]!, /threshold_events=0/);
  } finally {
    resetLogger();
    __resetProjectionFallbackWarnSuppressionForTest();
  }
});

test("ledger lag stays event-relative when compaction shrinks and rewrites the ledger (#2119)", async () => {
  const warns: string[] = [];
  initLogger({ info() {}, warn: (message) => warns.push(message), error() {}, debug() {} }, false);
  __resetProjectionFallbackWarnSuppressionForTest();
  try {
    const projectedCount = PROJECTION_LEDGER_LAG_WARN_THRESHOLD_EVENTS + 50;
    const projected = Array.from({ length: projectedCount }, (_, index) =>
      lifecycleEvent(
        `projected-${index}`,
        "memory-existing",
        `2026-01-01T${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00.000Z`,
      ));
    const delta = PROJECTION_LEDGER_LAG_WARN_THRESHOLD_EVENTS + 1;
    const appended = Array.from({ length: delta }, (_, index) =>
      lifecycleEvent(
        `current-${index}`,
        "memory-target",
        `2026-01-02T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
      ));
    await withStaleLifecycleProjection(projected, [], async (storage, memoryDir) => {
      const retained = projected.at(-1)!;
      const compactedRows = [{
        ...retained,
        eventId: `rebuild-${retained.memoryId}-${retained.eventType}-${retained.timestamp}`,
      }, ...appended];
      await writeFile(
        path.join(memoryDir, "state", "memory-lifecycle-ledger.jsonl"),
        `${compactedRows.map((event) => JSON.stringify(event)).join("\n")}\n`,
        "utf8",
      );

      const timeline = await storage.getMemoryTimeline("memory-target", 5);
      assert.equal(timeline.length, 5);
      const warning = warns.find((message) => message.includes("storage.getMemoryTimeline"));
      assert.ok(warning);
      assert.match(warning, new RegExp(`projected_events=${projectedCount}`));
      assert.match(warning, new RegExp(`current_ledger_events=${delta + 1}`));
      assert.match(warning, new RegExp(`delta_events=${delta}`));
    });
  } finally {
    resetLogger();
    __resetProjectionFallbackWarnSuppressionForTest();
  }
});

test("concurrent cold fallbacks singleflight the full ledger lag scan (#2119)", async () => {
  const projected = lifecycleEvent("projected-1", "memory-existing", "2026-01-01T00:00:00.000Z");
  const appended = lifecycleEvent("current-1", "memory-target", "2026-01-02T00:00:00.000Z");
  await withStaleLifecycleProjection([projected], [appended], async (storage, memoryDir) => {
    const ledgerPath = path.join(memoryDir, "state", "memory-lifecycle-ledger.jsonl");
    const key = Buffer.alloc(32, 11);
    const plaintext = await readFile(ledgerPath, "utf8");
    await writeFile(ledgerPath, encryptFileBody(plaintext, key, filePathAad(ledgerPath, memoryDir)));
    storage.setSecureStoreKey(key);

    const secureStorage = storage as unknown as {
      readStorageSecureFile(filePath: string): Promise<string>;
    };
    const originalRead = secureStorage.readStorageSecureFile.bind(storage);
    const readRelease = Promise.withResolvers<void>();
    const readStart = Promise.withResolvers<void>();
    let secureReads = 0;
    secureStorage.readStorageSecureFile = async (filePath) => {
      secureReads += 1;
      readStart.resolve();
      await readRelease.promise;
      return originalRead(filePath);
    };

    const first = storage.getMemoryTimeline("memory-target", 5);
    await readStart.promise;
    const second = storage.getMemoryTimeline("memory-target", 5);
    await yieldToEventLoop();
    await yieldToEventLoop();
    readRelease.resolve();
    const timelines = await Promise.all([first, second]);

    assert.deepEqual(timelines[0], timelines[1]);
    assert.equal(secureReads, 1, "concurrent callers share the generation's full ledger scan");
  });
});

test("scoped rebuild metadata distinguishes source-ledger high-water from projected events (#2119)", async () => {
  const projected = lifecycleEvent("projected-1", "memory-existing", "2026-01-01T00:00:00.000Z");
  const outsideScope = lifecycleEvent("current-1", "memory-outside-scope", "2026-01-02T00:00:00.000Z");
  await withStaleLifecycleProjection([projected], [outsideScope], async (_storage, memoryDir) => {
    await rebuildMemoryProjection({
      memoryDir,
      dryRun: false,
      updatedAfter: "2026-01-03T00:00:00.000Z",
    });
    const highWater = readProjectionLifecycleLedgerHighWater(memoryDir);
    assert.equal(highWater?.eventCount, 1, "projected count reflects the rows written by the scoped merge");
    assert.equal(highWater?.sourceEventCount, 2, "source high-water still records the full ledger snapshot");
  });
});
