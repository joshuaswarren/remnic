import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StorageManager } from "./storage.js";
import type { MemoryLifecycleEvent } from "./types.js";


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

    const body = await readFile(ledgerPath, "utf8");
    const rows = body.split("\n").filter((line) => line.startsWith("{"));
    assert.equal(rows.length, 3, "all three appended events are present");
    assert.ok(body.startsWith("x".repeat(100)), "the original plaintext body is preserved");

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

    const plainPath = path.join(dir, "big-plain.jsonl");
    await writeFile(plainPath, `${"y".repeat(1_500_000)}\n`, "utf8");
    assert.equal(await priv.isEncryptedFileHeader.call(storage, plainPath), false);

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

    assert.equal(
      await priv.isEncryptedFileHeader.call(storage, path.join(dir, "does-not-exist.jsonl")),
      false,
    );
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

    const events = await storage.readAllMemoryLifecycleEvents();
    const ids = events.map((e) => e.eventId).sort();
    assert.deepEqual(ids, ["one", "two"]);

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
    const n = await storage.appendMemoryLifecycleEvents([lifecycleEvent("fresh")]);
    assert.equal(n, 1);
    assert.equal(wholeReads.count(), 0, "creating the ledger does no whole-file read");

    const ledgerPath = path.join(dir, "state", "memory-lifecycle-ledger.jsonl");
    const body = await readFile(ledgerPath, "utf8");
    assert.ok(body.includes("\"eventId\":\"fresh\""));
  });
});

test("#1909 round 10: a peer encrypting the file flips the sniff classification (no raw append into ciphertext)", async () => {
  await withMemoryDir(async (dir) => {
    const a = new StorageManager(dir); // no key → plaintext writer
    await a.appendMemoryLifecycleEvents([lifecycleEvent("a1")]); // creates the ledger
    await a.appendMemoryLifecycleEvents([lifecycleEvent("a2")]); // now A caches plaintext=false

    const b = new StorageManager(dir);
    b.setSecureStoreKey(Buffer.alloc(32, 7));
    await b.appendMemoryLifecycleEvents([lifecycleEvent("b1")]); // whole-file rewrite → encrypted

    await assert.rejects(() => a.appendMemoryLifecycleEvents([lifecycleEvent("a3")]));

    const ids = (await b.readAllMemoryLifecycleEvents()).map((e) => e.eventId).sort();
    assert.deepEqual(ids, ["a1", "a2", "b1"]);
  });
});
