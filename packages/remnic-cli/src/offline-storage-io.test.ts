import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StorageManager, globToRegExp } from "@remnic/core";
import type { OfflineSyncSnapshot } from "@remnic/core";
import {
  DEFAULT_OFFLINE_SYNC_EXCLUDE_GLOBS,
  OFFLINE_DECRYPT_STAGING_DIR_PREFIX,
} from "@remnic/core/offline-sync-exclude-globs";
import { buildHeader, buildMetadata, keyring, secureStoreDir, writeHeader } from "@remnic/core/secure-store";
import { encryptFileBody, filePathAad } from "@remnic/core/secure-store";

import {
  cleanupOrphanedOfflineDecryptStaging,
  createConfiguredOfflineStorage,
  createOfflineStorageForPath,
  createOfflineStorageIo,
  filterOfflineSyncBaseFiles,
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
    const ledgerPath = path.join(memoryDir, "namespaces", "project-a", "state", "memory-lifecycle-ledger.jsonl");
    const namespaceStorage = await createOfflineStorageForPath(memoryDir, ledgerPath, configured, true);
    const pendingPath = path.join(
      memoryDir,
      "namespaces",
      "project-a",
      "state",
      "memory-lifecycle-ledger.jsonl.pending.d",
      "spill.jsonl"
    );
    await mkdir(path.dirname(pendingPath), { recursive: true });
    await namespaceStorage.writeMemoryLifecycleLedgerContent('{"memoryId":"mem-1"}\n', pendingPath);
    await namespaceStorage.drainPendingMemoryLifecycleEventsForSyncAt(ledgerPath);

    assert.ok(
      (await namespaceStorage.readMemoryLifecycleLedgerRawBufferForCompaction()).includes(
        Buffer.from('{"memoryId":"mem-1"}')
      )
    );
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
    let memoryReads = 0;
    const readMemoryByPath = storage.readMemoryByPath.bind(storage);
    storage.readMemoryByPath = async (filePath) => {
      memoryReads += 1;
      return await readMemoryByPath(filePath);
    };
    const io = await createOfflineStorageIo(memoryDir, {
      storage,
      secureStoreKey: null,
      secureStoreRequired: false,
    });

    assert.equal(
      await io.excludeFile({
        root: memoryDir,
        path: path.relative(memoryDir, privateWrite.memory.path),
        filePath: privateWrite.memory.path,
      }),
      true
    );
    assert.equal(
      await io.excludeFile({
        root: memoryDir,
        path: path.relative(memoryDir, privateWrite.memory.path),
        filePath: privateWrite.memory.path,
      }),
      true
    );
    assert.equal(
      await io.excludeFile({
        root: memoryDir,
        path: path.relative(memoryDir, publicWrite.memory.path),
        filePath: publicWrite.memory.path,
      }),
      false
    );
    assert.equal(
      await io.excludeFile({
        root: memoryDir,
        path: path.relative(memoryDir, publicWrite.memory.path),
        filePath: publicWrite.memory.path,
      }),
      false
    );
    assert.equal(memoryReads, 2);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("offline base privacy checks use bounded parallel batches", async () => {
  const files = Array.from({ length: 20 }, (_, index) => ({
    path: `facts/memory-${index}.md`,
    sha256: String(index).padStart(64, "0"),
    bytes: index,
    mtimeMs: index,
  }));
  let active = 0;
  let maximumActive = 0;
  const included = await filterOfflineSyncBaseFiles("/memory", files, async ({ path: filePath }) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return filePath.endsWith("memory-3.md");
  });

  assert.equal(maximumActive, 16);
  assert.deepEqual(
    included.map((file) => file.path),
    files.filter((_, index) => index !== 3).map((file) => file.path)
  );
});

test("offline base privacy checks tolerate files deleted after enumeration", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-offline-storage-deleted-"));
  try {
    const storage = new StorageManager(memoryDir);
    const written = await storage.writeMemory("fact", "This file will be deleted.", {
      source: "test",
      confidence: 1,
    });
    const file = await stat(written.memory.path);
    const baseFile = {
      path: path.relative(memoryDir, written.memory.path),
      sha256: "0".repeat(64),
      bytes: file.size,
      mtimeMs: file.mtimeMs,
    };
    const io = await createOfflineStorageIo(memoryDir, {
      storage,
      secureStoreKey: null,
      secureStoreRequired: false,
    });
    await rm(written.memory.path);

    assert.deepEqual(await filterOfflineSyncBaseFiles(memoryDir, [baseFile], io.excludeFile), [baseFile]);
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
      })
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
    assert.ok(sawStagingUnderMemoryRoot, "decryption must stage inside the secure-store-protected memory root");
    assert.ok(
      !(await readdir(memoryDir)).some((e) => e.startsWith(stagingPrefix)),
      "the plaintext staging dir must be cleaned up after the read"
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
    "a root-level staging dir's content must be excluded"
  );
  assert.ok(
    excluded(`namespaces/team/${OFFLINE_DECRYPT_STAGING_DIR_PREFIX}xyz/content`),
    "a nested staging dir's content must be excluded"
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


test("embedding generation members are excluded from direct hydration", async () => {
  const { shouldDirectHydrateOfflineFile } = await import("../src/index.js");
  const big = { path: "state/embeddings/shard-0000.json", sha256: "a".repeat(64), bytes: 17 * 1024 * 1024, mtimeMs: 1 };
  assert.equal(shouldDirectHydrateOfflineFile({ incoming: big }), false);
  const marker = { ...big, path: "state/embeddings.json" };
  assert.equal(shouldDirectHydrateOfflineFile({ incoming: marker }), false);
  const nonMember = { ...big, path: "assets/blob.bin" };
  assert.equal(shouldDirectHydrateOfflineFile({ incoming: nonMember }), true);
});

test("a >=16MiB changed shard hydrates via content fetch and applies atomically; payload failure preserves the old generation", async () => {
  const { offlineSnapshotContentFilesForApply, hydrateOfflineSnapshotContent } = await import("./index.js");
  const { applyOfflineSyncSnapshot, buildOfflineSyncSnapshot: buildRemote, EmbeddingIndexFileStore } = await import("@remnic/core");
  const localRoot = await mkdtemp(path.join(os.tmpdir(), "remnic-3148-bigshard-"));
  const remoteRoot = await mkdtemp(path.join(os.tmpdir(), "remnic-3148-bigshard-remote-"));
  try {
    const bigVector = Array.from({ length: 2_000_000 }, (_, k) => (k % 7) / 7);
    const oldShardBody = JSON.stringify({
      version: 1, provider: "openai", model: "m1",
      entries: { old1: { path: "p1", vector: [0, 0] } },
    });
    await mkdir(path.join(localRoot, "state/embeddings"), { recursive: true });
    await writeFile(path.join(localRoot, "state/embeddings/shard-0037.json"), oldShardBody);
    const bigBody = JSON.stringify({
      version: 1, provider: "openai", model: "m2",
      entries: { big1: { path: "p-big", vector: bigVector } },
    });
    await mkdir(path.join(remoteRoot, "state/embeddings"), { recursive: true });
    await writeFile(path.join(remoteRoot, "state/embeddings/shard-0024.json"), bigBody);
    const smallBody = JSON.stringify({
      version: 1, provider: "openai", model: "m2",
      entries: { small: { path: "p-small", vector: [1, 1] } },
    });
    await writeFile(path.join(remoteRoot, "state/embeddings/shard-0012.json"), smallBody);

    const full: OfflineSyncSnapshot & { namespace?: string } = await buildRemote({ root: remoteRoot, sourceId: "remote", includeContent: true });
    const metadataOnly: OfflineSyncSnapshot = {
      ...full,
      files: full.files.map((file) => ({
        path: file.path, sha256: file.sha256, bytes: file.bytes, mtimeMs: file.mtimeMs,
      })),
    };
    const bigRecord = metadataOnly.files.find((f) => f.path === "state/embeddings/shard-0024.json");
    assert.ok(bigRecord && bigRecord.bytes >= 16 * 1024 * 1024,
      "fixture assumption: the changed shard must be at least 16 MiB");
    const currentFiles = [
      { path: "state/embeddings/shard-0037.json",
        sha256: createHash("sha256").update(oldShardBody).digest("hex"),
        bytes: Buffer.byteLength(oldShardBody), mtimeMs: 1 },
    ];
    const baseFiles = currentFiles;
    // (a) The changed big shard is selected for content hydration.
    const needed = offlineSnapshotContentFilesForApply({
      snapshot: metadataOnly, baseFiles, currentFiles,
    });
    assert.deepEqual(needed.map((f) => f.path).sort(), [
      "state/embeddings/shard-0012.json",
      "state/embeddings/shard-0024.json",
    ]);
    // (b) Live generation untouched during hydration.
    assert.equal(
      await readFile(path.join(localRoot, "state/embeddings/shard-0037.json"), "utf-8"),
      oldShardBody,
    );
    // (c) Hydrate with a stubbed fetch serving the real remote bytes.
    const contentByPath = new Map<string, string>([
      ["state/embeddings/shard-0024.json", bigBody],
      ["state/embeddings/shard-0012.json", smallBody],
    ]);
    const hydrated = await hydrateOfflineSnapshotContent({
      remoteUrl: "http://stub", token: "t",
      includeTranscripts: true,
      snapshot: metadataOnly, baseFiles, currentFiles,
      fetchFiles: async ({ paths }) => ({
        ...metadataOnly,
        files: paths.map((p) => {
          const body = contentByPath.get(p);
          assert.ok(body !== undefined, "stub must serve every requested path");
          return {
            path: p,
            sha256: createHash("sha256").update(body).digest("hex"),
            bytes: Buffer.byteLength(body),
            mtimeMs: 1,
            contentBase64: Buffer.from(body).toString("base64"),
          };
        }),
      }),
    });
    // (d) Apply through the atomic generation transaction (plain mode).
    const store = new EmbeddingIndexFileStore(
      path.join(localRoot, "state/embeddings.json"),
      path.join(localRoot, "state/embeddings"),
      path.join(localRoot, "state/embedding-fallback-status.json"),
    );
    const result = await applyOfflineSyncSnapshot({ root: localRoot, snapshot: hydrated, baseFiles });
    const merged: Record<string, { path: string; vector: number[] }> = {};
    await store.readShardGenerationInto(merged);
    assert.deepEqual(Object.keys(merged).sort(), ["big1", "small"]);
    assert.equal(await store.detectLayout(), "sharded");
    assert.equal(result.upserted >= 2, true);
    // (e) Payload failure (fetched bytes do not match the declared digest)
    // rejects at apply and preserves the old generation.
    await rm(path.join(localRoot, "state/embeddings"), { recursive: true, force: true });
    await mkdir(path.join(localRoot, "state/embeddings"), { recursive: true });
    await writeFile(path.join(localRoot, "state/embeddings/shard-0037.json"), oldShardBody);
    const tamperedHydrated = await hydrateOfflineSnapshotContent({
      remoteUrl: "http://stub", token: "t",
      includeTranscripts: true,
      snapshot: metadataOnly, baseFiles, currentFiles,
      fetchFiles: async ({ paths }) => ({
        ...metadataOnly,
        files: paths.map((p) => ({
          path: p,
          sha256: createHash("sha256").update("tampered").digest("hex"),
          bytes: 8,
          mtimeMs: 1,
          contentBase64: Buffer.from("tampered").toString("base64"),
        })),
      }),
    });
    await assert.rejects(() => applyOfflineSyncSnapshot({ root: localRoot, snapshot: tamperedHydrated, baseFiles }));
    assert.equal(
      await readFile(path.join(localRoot, "state/embeddings/shard-0037.json"), "utf-8"),
      oldShardBody,
    );
  } finally {
    await rm(localRoot, { recursive: true, force: true });
    await rm(remoteRoot, { recursive: true, force: true });
  }
});


test("locally diverged generation members defer their whole generation", async () => {
  const { divergedEmbeddingGenerationDeferrals } = await import("./index.js");
  const baseFiles = [
    { path: "state/embeddings/shard-0000.json", sha256: "base0", bytes: 10, mtimeMs: 1 },
    { path: "state/embeddings/shard-0012.json", sha256: "base1", bytes: 10, mtimeMs: 1 },
  ];
  const incomingFiles = [
    // Unchanged vs base: no conflict (the transaction hydrates locally).
    { path: "state/embeddings/shard-0012.json", sha256: "base1" },
    // Locally diverged AFTER the base while the remote still serves the base
    // bytes: the daemon indexed between push and pull.
    { path: "state/embeddings/shard-0000.json", sha256: "base0" },
  ];
  const currentFiles = [
    { path: "state/embeddings/shard-0000.json", sha256: "diverged", bytes: 10, mtimeMs: 2 },
    { path: "state/embeddings/shard-0012.json", sha256: "base1", bytes: 10, mtimeMs: 1 },
  ];
  const deferred = divergedEmbeddingGenerationDeferrals({
    incomingFiles, baseFiles, currentFiles,
  });
  // Every incoming member of the conflicted generation is deferred together.
  assert.deepEqual(deferred, [
    "state/embeddings/shard-0000.json",
    "state/embeddings/shard-0012.json",
  ]);
  // Unrelated runtime files never defer.
  const unrelated = divergedEmbeddingGenerationDeferrals({
    incomingFiles: [{ path: "state/buffer.json", sha256: "x" }],
    baseFiles: [{ path: "state/buffer.json", sha256: "base" }],
    currentFiles: [{ path: "state/buffer.json", sha256: "diverged", bytes: 1, mtimeMs: 2 }],
  });
  assert.deepEqual(unrelated, []);
});
