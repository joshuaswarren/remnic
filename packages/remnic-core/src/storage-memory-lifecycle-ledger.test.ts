import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StorageManager } from "./storage.js";
import { encryptFileBody, filePathAad } from "./secure-store/secure-fs.js";
import type { MemoryLifecycleEvent } from "./types.js";
import { appendLifecycleEventsSerialized } from "./storage/memory-lifecycle-ledger-access.js";
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
