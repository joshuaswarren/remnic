import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StorageManager } from "@remnic/core";
import {
  buildHeader,
  buildMetadata,
  keyring,
  secureStoreDir,
  writeHeader,
} from "@remnic/core/secure-store";
import { encryptFileBody, filePathAad } from "@remnic/core/secure-store";

import {
  createConfiguredOfflineStorage,
  createOfflineStorageForPath,
  createOfflineStorageIo,
} from "./offline-storage-io.js";

test("offline storage creates namespace-scoped secure storage for lifecycle drains", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-offline-storage-namespace-"));
  const key = Buffer.alloc(32, 43);
  try {
    const configured = {
      storage: new StorageManager(memoryDir),
      secureStoreKey: key,
      secureStoreRequired: true,
    };
    const ledgerPath = path.join(
      memoryDir,
      "namespaces",
      "project-a",
      "state",
      "memory-lifecycle-ledger.jsonl",
    );
    const namespaceStorage = createOfflineStorageForPath(memoryDir, ledgerPath, configured, true);
    const pendingPath = path.join(
      memoryDir,
      "namespaces",
      "project-a",
      "state",
      "memory-lifecycle-ledger.jsonl.pending.d",
      "spill.jsonl",
    );
    await mkdir(path.dirname(pendingPath), { recursive: true });
    await namespaceStorage.writeMemoryLifecycleLedgerContent('{"memoryId":"mem-1"}\n', pendingPath);
    await namespaceStorage.drainPendingMemoryLifecycleEventsForSyncAt(ledgerPath);

    assert.ok((await namespaceStorage.readMemoryLifecycleLedgerRawBufferForCompaction()).includes(
      Buffer.from('{"memoryId":"mem-1"}'),
    ));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});


test("offline storage IO decrypts encrypted files for reads and streaming digests", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-offline-storage-io-"));
  try {
    const storage = new StorageManager(memoryDir);
    const key = Buffer.alloc(32, 23);
    storage.setSecureStoreRequired(true);
    storage.setSecureStoreKey(key);
    const filePath = path.join(memoryDir, "facts", "example.md");
    const content = Buffer.from("encrypted offline sync content\n".repeat(128));

    await storage.writeOfflineSyncFile(filePath, content);
    const io = await createOfflineStorageIo(memoryDir, {
      storage,
      secureStoreKey: key,
      secureStoreRequired: true,
    });
    const target = { root: memoryDir, path: "facts/example.md", filePath };
    const readFile = io.readFile;
    assert.ok(readFile);
    const read = await readFile(target);
    const digest = await io.readFileDigest(target);
    const chunks: Buffer[] = [];
    for await (const chunk of io.readFileChunks({ ...target, chunkSize: 31 })) {
      chunks.push(chunk);
    }

    assert.deepEqual(read, content);
    assert.deepEqual(Buffer.concat(chunks), content);
    assert.deepEqual(digest, {
      sha256: createHash("sha256").update(content).digest("hex"),
      bytes: content.byteLength,
    });
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("offline storage IO decrypts legacy namespaced AAD files in chunks", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-offline-storage-legacy-aad-"));
  try {
    const storage = new StorageManager(memoryDir);
    const key = Buffer.alloc(32, 29);
    storage.setSecureStoreRequired(true);
    storage.setSecureStoreKey(key);
    const namespaceRoot = path.join(memoryDir, "namespaces", "project-a");
    const filePath = path.join(namespaceRoot, "facts", "legacy.md");
    await mkdir(path.dirname(filePath), { recursive: true });
    const content = Buffer.from("legacy namespaced offline sync content\n".repeat(96));
    await writeFile(filePath, encryptFileBody(content, key, filePathAad(filePath, namespaceRoot)));

    const io = await createOfflineStorageIo(memoryDir, {
      storage,
      secureStoreKey: key,
      secureStoreRequired: true,
    });
    const target = { root: memoryDir, path: "namespaces/project-a/facts/legacy.md", filePath };
    const chunks: Buffer[] = [];
    for await (const chunk of io.readFileChunks({ ...target, chunkSize: 37 })) {
      chunks.push(chunk);
    }

    assert.deepEqual(Buffer.concat(chunks), content);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("configured offline storage preserves disabled secure-store encryption policy", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-offline-storage-policy-"));
  const storeKey = Buffer.alloc(32, 41);
  try {
    const metadata = buildMetadata({
      algorithm: "scrypt",
      salt: Buffer.alloc(16, 42),
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await writeHeader(
      memoryDir,
      buildHeader({
        metadata,
        derivedKey: storeKey,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    keyring.unlock(secureStoreDir(memoryDir), storeKey);
    const configured = await createConfiguredOfflineStorage(memoryDir, false);
    assert.equal(configured.secureStoreKey, storeKey);
    assert.equal(configured.storage.willEncryptStateWrites(), false);
  } finally {
    keyring.lock(secureStoreDir(memoryDir));
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("offline storage IO stages encrypted decryption inside the memory root, not os.tmpdir(), and cleans up (#2033 P1)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-offline-storage-decrypt-loc-"));
  try {
    const storage = new StorageManager(memoryDir);
    const key = Buffer.alloc(32, 71);
    storage.setSecureStoreRequired(true);
    storage.setSecureStoreKey(key);
    const filePath = path.join(memoryDir, "facts", "secret.md");
    const content = Buffer.from("secure-store plaintext must not spill to tmp\n".repeat(64));
    await storage.writeOfflineSyncFile(filePath, content);

    const io = await createOfflineStorageIo(memoryDir, {
      storage,
      secureStoreKey: key,
      secureStoreRequired: true,
    });
    const target = { root: memoryDir, path: "facts/secret.md", filePath };

    const stagingPrefix = ".remnic-offline-decrypt-";
    let sawStagingUnderMemoryRoot = false;
    const chunks: Buffer[] = [];
    for await (const chunk of io.readFileChunks({ ...target, chunkSize: 41 })) {
      // The whole plaintext is staged before the first chunk is yielded, so the
      // staging dir is observable HERE - and it must live under the memory root,
      // never in world-readable os.tmpdir().
      if ((await readdir(memoryDir)).some((e) => e.startsWith(stagingPrefix))) {
        sawStagingUnderMemoryRoot = true;
      }
      chunks.push(chunk);
    }

    assert.deepEqual(Buffer.concat(chunks), content, "decrypt still yields the exact plaintext");
    assert.ok(
      sawStagingUnderMemoryRoot,
      "decryption must stage inside the secure-store-protected memory root",
    );
    assert.ok(
      !(await readdir(memoryDir)).some((e) => e.startsWith(stagingPrefix)),
      "the plaintext staging dir must be cleaned up after the read",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
