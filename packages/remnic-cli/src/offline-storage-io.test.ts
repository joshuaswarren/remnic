import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StorageManager } from "@remnic/core";

import { createOfflineStorageIo } from "./offline-storage-io.js";

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
    const io = await createOfflineStorageIo(memoryDir, { storage, secureStoreKey: key });
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
