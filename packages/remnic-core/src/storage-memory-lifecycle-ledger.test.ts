import assert from "node:assert/strict";
import { appendFile, chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StorageManager } from "./storage.js";
import { encryptFileBody, filePathAad, isEncryptedFile } from "./secure-store/secure-fs.js";
import type { MemoryLifecycleEvent } from "./types.js";
import {
  appendLifecycleEventsSerialized,
  drainPendingLifecycleAppendsSerialized,
  pendingLifecycleLedgerDir,
  type LifecyclePendingIo,
} from "./storage/memory-lifecycle-ledger-access.js";
import { withHeldFileLock } from "./utils/serialize-mutations.js";
import {
  memoryLifecycleLedgerLockPath,
  MEMORY_LIFECYCLE_LEDGER_LOCK_STALE_MS,
  MEMORY_LIFECYCLE_LEDGER_APPEND_LOCK_MAX_WAIT_MS,
} from "./memory-lifecycle-ledger-utils.js";

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
 *  integration test below exercises the encrypted-at-rest path). */
function plaintextPendingIo(): LifecyclePendingIo {
  return {
    writeSecure: async (p, c) => {
      await mkdir(path.dirname(p), { recursive: true });
      await writeFile(p, c, "utf8");
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
