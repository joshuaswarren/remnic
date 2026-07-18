import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StorageManager } from "./storage.js";
import type { MemoryLifecycleEvent } from "./types.js";

// Issue #1909 (Part A): the plaintext secure-append path must classify a file
// as encrypted by reading ONLY the fixed-size magic header, never the whole
// file (a lifecycle ledger can grow to hundreds of MB on a large corpus), and
// it must cache the classification so subsequent appends do NO reclassification
// read at all.

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
 * Spy the private whole-file read used by the encrypted-append branch so a test
 * can assert the plaintext append path NEVER reads the whole file to classify —
 * the #1909 Part A invariant. The classification uses a header-only sniff
 * (open + read MAGIC_HEADER_SIZE bytes), now (size, mtime)-identity-validated so
 * a peer rewrite is detected (round 10); it never falls back to a whole-file read.
 */
function instrumentWholeFileReads(storage: StorageManager): { count: () => number } {
  const priv = storage as unknown as {
    readStorageSecureFile: (filePath: string) => Promise<string>;
  };
  const real = priv.readStorageSecureFile.bind(storage);
  let reads = 0;
  priv.readStorageSecureFile = async (filePath: string) => {
    reads += 1;
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

test("plaintext appends classify via a header sniff only — never a whole-file read", async () => {
  await withMemoryDir(async (dir) => {
    const ledgerPath = path.join(dir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    // A large plaintext ledger — a whole-file sniff would scale with this.
    await writeFile(ledgerPath, `${"x".repeat(2_000_000)}\n`, "utf8");

    const storage = new StorageManager(dir);
    const wholeReads = instrumentWholeFileReads(storage);

    await storage.appendMemoryLifecycleEvents([lifecycleEvent("a")]);
    await storage.appendMemoryLifecycleEvents([lifecycleEvent("b")]);
    await storage.appendMemoryLifecycleEvents([lifecycleEvent("c")]);
    assert.equal(
      wholeReads.count(),
      0,
      "plaintext appends never read the whole file to classify (header sniff only)",
    );

    // The appends actually landed on top of the pre-existing large body.
    const body = await readFile(ledgerPath, "utf8");
    const rows = body.split("\n").filter((line) => line.startsWith("{"));
    assert.equal(rows.length, 3, "all three appended events are present");
    assert.ok(body.startsWith("x".repeat(100)), "the original plaintext body is preserved");

    // White-box: the identity-validated cache entry records plaintext.
    const cacheOwner = storage as unknown as {
      secureFileEncryptionSniffCache: Map<
        string,
        { identity: { size: number; mtimeMs: number }; encrypted: boolean }
      >;
    };
    assert.equal(
      cacheOwner.secureFileEncryptionSniffCache.get(ledgerPath)?.encrypted,
      false,
      "the ledger is classified as plaintext",
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
    const wholeReads = instrumentWholeFileReads(storage);
    // Fresh (ENOENT) ledger: the header sniff stats → ENOENT → not-encrypted, and
    // the append creates the file — never a whole-file read.
    const n = await storage.appendMemoryLifecycleEvents([lifecycleEvent("fresh")]);
    assert.equal(n, 1);
    assert.equal(wholeReads.count(), 0, "creating the ledger does no whole-file read");

    const ledgerPath = path.join(dir, "state", "memory-lifecycle-ledger.jsonl");
    const body = await readFile(ledgerPath, "utf8");
    assert.ok(body.includes("\"eventId\":\"fresh\""));
  });
});

test("#1909 round 10: a peer encrypting the file flips the sniff classification (no raw append into ciphertext)", async () => {
  // A long-lived manager caches plaintext for an append target; a SECOND manager
  // then encrypts that file (whole-file rewrite). The first manager's next append
  // must detect the flip via (size, mtime) identity re-validation and NOT append
  // raw bytes into the encrypted body (data corruption).
  await withMemoryDir(async (dir) => {
    const a = new StorageManager(dir); // no key → plaintext writer
    await a.appendMemoryLifecycleEvents([lifecycleEvent("a1")]); // creates the ledger
    await a.appendMemoryLifecycleEvents([lifecycleEvent("a2")]); // now A caches plaintext=false

    // Peer B encrypts the whole file by appending under a key.
    const b = new StorageManager(dir);
    b.setSecureStoreKey(Buffer.alloc(32, 7));
    await b.appendMemoryLifecycleEvents([lifecycleEvent("b1")]); // whole-file rewrite → encrypted

    // A's next append must detect the flip and refuse (A has no key) rather than
    // corrupt the ciphertext with a raw plaintext append.
    await assert.rejects(() => a.appendMemoryLifecycleEvents([lifecycleEvent("a3")]));

    // The encrypted ledger is intact and fully decryptable by B — a3 never landed.
    const ids = (await b.readAllMemoryLifecycleEvents()).map((e) => e.eventId).sort();
    assert.deepEqual(ids, ["a1", "a2", "b1"]);
  });
});
