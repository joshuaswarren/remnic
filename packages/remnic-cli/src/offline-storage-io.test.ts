import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  StorageManager,
  globToRegExp,
} from "@remnic/core";
import {
  DEFAULT_OFFLINE_SYNC_EXCLUDE_GLOBS,
  OFFLINE_DECRYPT_STAGING_DIR_PREFIX,
} from "@remnic/core/offline-sync-exclude-globs";
import {
  buildHeader,
  buildMetadata,
  keyring,
  secureStoreDir,
  writeHeader,
} from "@remnic/core/secure-store";
import { encryptFileBody, filePathAad } from "@remnic/core/secure-store";

import {
  cleanupOrphanedOfflineDecryptStaging,
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
    const namespaceStorage = await createOfflineStorageForPath(memoryDir, ledgerPath, configured, true);
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

test("offline storage IO excludes private support-passport memories from push views", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-offline-storage-passport-"));
  try {
    const storage = new StorageManager(memoryDir);
    const privateWrite = await storage.writeMemory("preference", "Offer a quiet place.", {
      source: "support-passport",
      tags: ["support-passport-card"],
      confidence: 1,
    });
    const publicWrite = await storage.writeMemory("fact", "The office opens at nine.", {
      source: "test",
      confidence: 1,
    });
    const io = await createOfflineStorageIo(memoryDir, {
      storage,
      secureStoreKey: null,
      secureStoreRequired: false,
    });

    assert.equal(await io.excludeFile({
      root: memoryDir,
      path: path.relative(memoryDir, privateWrite.memory.path),
      filePath: privateWrite.memory.path,
    }), true);
    assert.equal(await io.excludeFile({
      root: memoryDir,
      path: path.relative(memoryDir, publicWrite.memory.path),
      filePath: publicWrite.memory.path,
    }), false);
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

test("the default exclude globs keep crash-orphaned decrypt staging out of any snapshot (#2033 P1)", () => {
  const regexps = DEFAULT_OFFLINE_SYNC_EXCLUDE_GLOBS.map((glob) => globToRegExp(glob));
  const excluded = (relPosix: string): boolean => regexps.some((re) => re.test(relPosix));
  assert.ok(
    excluded(`${OFFLINE_DECRYPT_STAGING_DIR_PREFIX}AbCd/content`),
    "a root-level staging dir's content must be excluded",
  );
  assert.ok(
    excluded(`namespaces/team/${OFFLINE_DECRYPT_STAGING_DIR_PREFIX}xyz/content`),
    "a nested staging dir's content must be excluded",
  );
  assert.ok(!excluded("facts/note.md"), "ordinary files stay in the snapshot");
});

test("cleanupOrphanedOfflineDecryptStaging removes stale orphans but keeps in-flight staging (#2033 P1)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-offline-decrypt-cleanup-"));
  try {
    const stale = path.join(memoryDir, `${OFFLINE_DECRYPT_STAGING_DIR_PREFIX}stale`);
    const fresh = path.join(memoryDir, `${OFFLINE_DECRYPT_STAGING_DIR_PREFIX}fresh`);
    const unrelated = path.join(memoryDir, "facts");
    await mkdir(stale, { recursive: true });
    await writeFile(path.join(stale, "content"), "decrypted plaintext");
    await mkdir(fresh, { recursive: true });
    await writeFile(path.join(fresh, "content"), "in-flight plaintext");
    await mkdir(unrelated, { recursive: true });
    await writeFile(path.join(unrelated, "note.md"), "keep me");
    // Age the stale dir past the orphan threshold (2h ago); leave `fresh` recent.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(stale, twoHoursAgo, twoHoursAgo);

    await cleanupOrphanedOfflineDecryptStaging(memoryDir);

    await assert.rejects(stat(stale), "a stale orphan staging dir must be removed");
    assert.ok((await stat(fresh)).isDirectory(), "an in-flight staging dir must be preserved");
    assert.ok((await stat(unrelated)).isDirectory(), "unrelated dirs must be untouched");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("cleanupOrphanedOfflineDecryptStaging is a no-op on a missing memory dir (#2033 P1)", async () => {
  await cleanupOrphanedOfflineDecryptStaging(path.join(os.tmpdir(), "remnic-decrypt-cleanup-absent-xyz"));
});
