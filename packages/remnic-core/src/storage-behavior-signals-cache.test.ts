import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StorageManager } from "./storage.js";
import { SecureStoreLockedError } from "./secure-store/secure-fs.js";
import type { BehaviorSignalEvent } from "./types.js";

// Issue #1909 (Part C): appendBehaviorSignals used to re-read + JSON.parse the
// whole (unbounded) behavior-signals.jsonl on EVERY append to rebuild a dedup
// key set. It now keeps the key set in memory, validated by (size, mtime) file
// identity; a foreign write forces a reload, matching the catalog cache pattern.

function signal(memoryId: string, signalHash: string): BehaviorSignalEvent {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    namespace: "default",
    memoryId,
    category: "preference",
    signalType: "preference_affinity",
    direction: "positive",
    confidence: 0.9,
    signalHash,
    source: "extraction",
  };
}

interface BehaviorSignalsCacheOwner {
  behaviorSignalsKeyCache:
    | { identity: { size: number; mtimeMs: number }; keys: Set<string> }
    | null;
}

function cacheOf(storage: StorageManager): BehaviorSignalsCacheOwner {
  return storage as unknown as BehaviorSignalsCacheOwner;
}

async function withMemoryDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-behavior-cache-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readRows(filePath: string): Promise<string[]> {
  const raw = await readFile(filePath, "utf8");
  return raw.split("\n").map((l) => l.trim()).filter(Boolean);
}

test("steady-state appends reuse the cached key set — no full-file reload", async () => {
  await withMemoryDir(async (dir) => {
    const storage = new StorageManager(dir);
    const signalsPath = path.join(dir, "state", "behavior-signals.jsonl");

    await storage.appendBehaviorSignals([signal("m1", "h1")]);
    const owner = cacheOf(storage);
    assert.ok(owner.behaviorSignalsKeyCache, "cache populated after first append");
    const firstKeySet = owner.behaviorSignalsKeyCache.keys;

    await storage.appendBehaviorSignals([signal("m2", "h2")]);
    assert.strictEqual(
      owner.behaviorSignalsKeyCache?.keys,
      firstKeySet,
      "the same in-memory key set is reused across appends (no reload/re-parse)",
    );

    // Duplicate memoryId:signalHash is still suppressed via the cached set.
    const appended = await storage.appendBehaviorSignals([signal("m1", "h1")]);
    assert.equal(appended, 0, "duplicate signal is deduped against the cached set");
    assert.strictEqual(owner.behaviorSignalsKeyCache?.keys, firstKeySet, "still no reload");

    const rows = await readRows(signalsPath);
    assert.equal(rows.length, 2, "only the two distinct signals are on disk");
  });
});

test("a foreign modification (changed size/mtime) forces a reload and dedups against it", async () => {
  await withMemoryDir(async (dir) => {
    const storage = new StorageManager(dir);
    const signalsPath = path.join(dir, "state", "behavior-signals.jsonl");

    await storage.appendBehaviorSignals([signal("m1", "h1")]);
    const owner = cacheOf(storage);
    const firstKeySet = owner.behaviorSignalsKeyCache?.keys;

    // Another process appends a row out-of-band, changing size + mtime.
    await appendFile(signalsPath, `${JSON.stringify(signal("m-foreign", "h-foreign"))}\n`, "utf8");
    // Ensure mtime advances even on coarse-grained clocks.
    const future = new Date(Date.now() + 5_000);
    await utimes(signalsPath, future, future);

    // Appending the foreign row again must be deduped — proving we reloaded.
    const appended = await storage.appendBehaviorSignals([signal("m-foreign", "h-foreign")]);
    assert.equal(appended, 0, "foreign row was reloaded and recognized as a duplicate");
    assert.notStrictEqual(
      owner.behaviorSignalsKeyCache?.keys,
      firstKeySet,
      "the key set was rebuilt after the foreign change",
    );

    const rows = await readRows(signalsPath);
    assert.equal(rows.length, 2, "no duplicate foreign row was written");
  });
});

test("first write (ENOENT) creates the file and seeds the cache", async () => {
  await withMemoryDir(async (dir) => {
    const storage = new StorageManager(dir);
    const signalsPath = path.join(dir, "state", "behavior-signals.jsonl");

    const n = await storage.appendBehaviorSignals([signal("m1", "h1")]);
    assert.equal(n, 1);
    assert.ok(cacheOf(storage).behaviorSignalsKeyCache, "cache seeded after first write");
    const rows = await readRows(signalsPath);
    assert.equal(rows.length, 1);
  });
});

test("malformed rows on disk are skipped (fail-open) and do not block deduping valid rows", async () => {
  await withMemoryDir(async (dir) => {
    const signalsPath = path.join(dir, "state", "behavior-signals.jsonl");
    await mkdir(path.dirname(signalsPath), { recursive: true });
    await writeFile(
      signalsPath,
      `{not json\n${JSON.stringify(signal("m1", "h1"))}\n   \n`,
      "utf8",
    );

    const storage = new StorageManager(dir);
    // m1:h1 already present (valid row) → deduped despite the malformed line.
    const dup = await storage.appendBehaviorSignals([signal("m1", "h1")]);
    assert.equal(dup, 0, "valid existing row is recognized; malformed row ignored");
    // A new distinct signal appends fine.
    const fresh = await storage.appendBehaviorSignals([signal("m2", "h2")]);
    assert.equal(fresh, 1);
  });
});

test("SecureStoreLockedError propagates when reading an encrypted ledger while locked", async () => {
  await withMemoryDir(async (dir) => {
    // Write an encrypted behavior-signals ledger under a key.
    const writer = new StorageManager(dir);
    writer.setSecureStoreKey(Buffer.alloc(32, 3));
    await writer.appendBehaviorSignals([signal("m1", "h1")]);

    // A fresh, locked, secure-required store must not silently read plaintext —
    // reading the encrypted ledger to rebuild the dedup set throws.
    const locked = new StorageManager(dir);
    locked.setSecureStoreRequired(true);
    locked.setSecureStoreKey(null);
    await assert.rejects(
      () => locked.appendBehaviorSignals([signal("m2", "h2")]),
      SecureStoreLockedError,
    );
  });
});
