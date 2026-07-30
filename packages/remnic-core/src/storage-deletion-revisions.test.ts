import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { StorageManager } from "./storage.js";

test("storage persists the actual revision time for a successful path deletion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-deletion-revision-"));
  try {
    const relativePath = "facts/deleted.md";
    const filePath = path.join(root, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "deleted content");

    const storage = new StorageManager(root);
    const beforeDelete = Date.now();
    await storage.deleteOfflineSyncFile(filePath);
    const afterDelete = Date.now();

    const revisions = await new StorageManager(root).readDeletionRevisions();
    const deletedAtMs = revisions.get(relativePath);
    assert.ok(deletedAtMs !== undefined);
    assert.ok(deletedAtMs >= beforeDelete && deletedAtMs <= afterDelete);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("storage does not restamp an already-absent path on a delete retry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-deletion-retry-"));
  try {
    const relativePath = "facts/deleted.md";
    const filePath = path.join(root, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "deleted content");

    const storage = new StorageManager(root);
    await storage.deleteOfflineSyncFile(filePath);
    const firstRevision = (await storage.readDeletionRevisions()).get(relativePath);
    assert.ok(firstRevision !== undefined);

    await storage.deleteOfflineSyncFile(filePath);

    assert.equal((await storage.readDeletionRevisions()).get(relativePath), firstRevision);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a new path generation replaces or clears stale deletion evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-deletion-generation-"));
  try {
    const relativePath = "facts/deleted.md";
    const filePath = path.join(root, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    const storage = new StorageManager(root);

    await writeFile(filePath, "generation one");
    await storage.deleteOfflineSyncFile(filePath, 5000);
    assert.equal((await storage.readDeletionRevisions()).get(relativePath), 5000);

    await storage.writeOfflineSyncFile(filePath, Buffer.from("generation two"));
    assert.equal((await storage.readDeletionRevisions()).has(relativePath), false);
    await storage.deleteOfflineSyncFile(filePath, 3000);
    assert.equal((await storage.readDeletionRevisions()).get(relativePath), 3000);

    await storage.writeOfflineSyncFile(filePath, Buffer.from("legacy generation"));
    assert.equal((await storage.readDeletionRevisions()).has(relativePath), false);
    await storage.deleteOfflineSyncFile(filePath, null);
    assert.equal((await storage.readDeletionRevisions()).has(relativePath), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("storage merges a known replicated deletion revision for an already-absent path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-deletion-relay-"));
  try {
    const relativePath = "facts/deleted.md";
    const storage = new StorageManager(root);

    await storage.recordReplicatedDeletionRevision(path.join(root, relativePath), 2000);
    assert.equal((await storage.readDeletionRevisions()).get(relativePath), 2000);

    await storage.recordReplicatedDeletionRevision(path.join(root, relativePath), 1000);
    assert.equal((await storage.readDeletionRevisions()).get(relativePath), 2000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
