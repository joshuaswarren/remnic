import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StorageManager } from "./storage.js";
import type { MemoryLifecycleEvent } from "./types.js";

// Issue #1909 (Part A): the plaintext secure-append path must classify a file
// as encrypted by reading ONLY the fixed-size magic header, never the whole
// file (the production lifecycle ledger reached 119MB), and it must cache the
// classification so subsequent appends do NO reclassification read at all.

function lifecycleEvent(eventId: string): MemoryLifecycleEvent {
  return {
    eventId,
    memoryId: `m-${eventId}`,
    eventType: "created",
    timestamp: "2026-01-01T00:00:00.000Z",
    actor: "test",
    ruleVersion: "1",
  };
}

/**
 * Wrap the private header-sniff helper so a test can count how many appends
 * actually re-read the file to classify it. A cache HIT skips the read; a MISS
 * opens the file and reads the 12-byte header. We detect a miss by inspecting
 * the private classification cache at entry — exactly the branch production
 * takes — so the counter reflects real header reads, not helper invocations.
 */
function instrumentHeaderReads(storage: StorageManager): { count: () => number } {
  const priv = storage as unknown as {
    isEncryptedFileHeader: (filePath: string) => Promise<boolean>;
    secureFileEncryptionSniffCache: Map<string, boolean>;
  };
  const real = priv.isEncryptedFileHeader.bind(storage);
  let reads = 0;
  priv.isEncryptedFileHeader = async (filePath: string) => {
    if (!priv.secureFileEncryptionSniffCache.has(filePath)) reads += 1;
    return real(filePath);
  };
  return { count: () => reads };
}

async function withMemoryDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-header-sniff-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("plaintext append classifies via a single header read and caches it (no per-append reclassification)", async () => {
  await withMemoryDir(async (dir) => {
    const ledgerPath = path.join(dir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    // A large plaintext ledger — the whole-file sniff would scale with this.
    await writeFile(ledgerPath, `${"x".repeat(2_000_000)}\n`, "utf8");

    const storage = new StorageManager(dir);
    const reads = instrumentHeaderReads(storage);

    await storage.appendMemoryLifecycleEvents([lifecycleEvent("a")]);
    assert.equal(reads.count(), 1, "first append reads the header once to classify");

    await storage.appendMemoryLifecycleEvents([lifecycleEvent("b")]);
    await storage.appendMemoryLifecycleEvents([lifecycleEvent("c")]);
    assert.equal(
      reads.count(),
      1,
      "subsequent appends reuse the cached classification — zero reclassification reads",
    );

    // The appends actually landed on top of the pre-existing large body.
    const body = await readFile(ledgerPath, "utf8");
    const rows = body.split("\n").filter((line) => line.startsWith("{"));
    assert.equal(rows.length, 3, "all three appended events are present");
    assert.ok(body.startsWith("x".repeat(100)), "the original plaintext body is preserved");

    // White-box: read the private classification cache to confirm the ledger
    // was recorded as plaintext.
    const cacheOwner = storage as unknown as {
      secureFileEncryptionSniffCache: Map<string, boolean>;
    };
    assert.equal(
      cacheOwner.secureFileEncryptionSniffCache.get(ledgerPath),
      false,
      "the ledger is cached as plaintext",
    );
  });
});

test("isEncryptedFileHeader classifies large files correctly from the header alone", async () => {
  await withMemoryDir(async (dir) => {
    const storage = new StorageManager(dir);
    const priv = storage as unknown as {
      isEncryptedFileHeader: (filePath: string) => Promise<boolean>;
    };

    // Large plaintext file → not encrypted, regardless of its size.
    const plainPath = path.join(dir, "big-plain.jsonl");
    await writeFile(plainPath, `${"y".repeat(1_500_000)}\n`, "utf8");
    assert.equal(await priv.isEncryptedFileHeader.call(storage, plainPath), false);

    // Encrypted file produced by the secure write path → encrypted, detected by
    // the 12-byte magic header without decrypting the whole body.
    const encDir = await mkdtemp(path.join(os.tmpdir(), "remnic-header-enc-"));
    try {
      const encStorage = new StorageManager(encDir);
      encStorage.setSecureStoreKey(Buffer.alloc(32, 7));
      await encStorage.appendMemoryLifecycleEvents([lifecycleEvent("e")]);
      const encLedger = path.join(encDir, "state", "memory-lifecycle-ledger.jsonl");
      const encPriv = encStorage as unknown as {
        isEncryptedFileHeader: (filePath: string) => Promise<boolean>;
      };
      assert.equal(await encPriv.isEncryptedFileHeader.call(encStorage, encLedger), true);
    } finally {
      await rm(encDir, { recursive: true, force: true });
    }

    // Missing file → not encrypted (falls through to appendFile).
    assert.equal(
      await priv.isEncryptedFileHeader.call(storage, path.join(dir, "does-not-exist.jsonl")),
      false,
    );
    // Short file (< MAGIC_HEADER_SIZE) → not encrypted.
    const shortPath = path.join(dir, "short.jsonl");
    await writeFile(shortPath, "hi", "utf8");
    assert.equal(await priv.isEncryptedFileHeader.call(storage, shortPath), false);
  });
});

test("encrypted files still round-trip through the append path unchanged", async () => {
  await withMemoryDir(async (dir) => {
    const storage = new StorageManager(dir);
    storage.setSecureStoreKey(Buffer.alloc(32, 9));

    await storage.appendMemoryLifecycleEvents([lifecycleEvent("one")]);
    await storage.appendMemoryLifecycleEvents([lifecycleEvent("two")]);

    // The decrypt-append-rewrite branch keeps the ledger readable + intact.
    const events = await storage.readAllMemoryLifecycleEvents();
    const ids = events.map((e) => e.eventId).sort();
    assert.deepEqual(ids, ["one", "two"]);

    // On disk the file is genuinely encrypted (header magic present).
    const ledgerPath = path.join(dir, "state", "memory-lifecycle-ledger.jsonl");
    const raw = await readFile(ledgerPath);
    assert.ok(raw.length > 0);
    assert.notEqual(raw.toString("utf8").includes("\"eventId\":\"one\""), true, "body is not plaintext");
  });
});

test("append to a missing path creates the file via the plaintext append path", async () => {
  await withMemoryDir(async (dir) => {
    const storage = new StorageManager(dir);
    const reads = instrumentHeaderReads(storage);
    // Fresh (ENOENT) ledger: header sniff returns false without caching, and the
    // append creates the file.
    const n = await storage.appendMemoryLifecycleEvents([lifecycleEvent("fresh")]);
    assert.equal(n, 1);
    // ENOENT does not populate the cache, so the first read attempt counted as a
    // miss but the second append (file now exists) does the one real read.
    assert.ok(reads.count() >= 1);

    const ledgerPath = path.join(dir, "state", "memory-lifecycle-ledger.jsonl");
    const body = await readFile(ledgerPath, "utf8");
    assert.ok(body.includes("\"eventId\":\"fresh\""));
  });
});
