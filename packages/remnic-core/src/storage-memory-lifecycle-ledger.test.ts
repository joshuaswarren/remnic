import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StorageManager } from "./storage.js";
import { encryptFileBody, filePathAad } from "./secure-store/secure-fs.js";
import type { MemoryLifecycleEvent } from "./types.js";

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

test("readMemoryLifecycleEvents applies its limit after streamed lifecycle sorting", async () => {
  const first = lifecycleEvent("event-1", "memory-a", "2026-01-01T00:00:00.000Z");
  const second = lifecycleEvent("event-2", "memory-a", "2026-01-02T00:00:00.000Z");
  const third = lifecycleEvent("event-3", "memory-b", "2026-01-01T00:00:00.000Z");

  await withLifecycleLedger([
    JSON.stringify(third),
    JSON.stringify(first),
    JSON.stringify(second),
  ], async (storage) => {
    assert.deepEqual(await storage.readMemoryLifecycleEvents(2), [second, third]);
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
