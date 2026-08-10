import * as assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { DeletionRevisionStore } from "./storage/deletion-revision-store.js";
import type { MemoryFile } from "./types.js";
import { StorageManager } from "./storage.js";

function createDeletionRevisionStore(baseDir: string): DeletionRevisionStore {
  const metadataDir = path.join(baseDir, ".offline-sync");
  return new DeletionRevisionStore({
    baseDir,
    deletionRevisionMetadataPath: path.join(metadataDir, "deletion-revisions.v1.json"),
    invalidationCommitMetadataPath: path.join(metadataDir, "invalidation-commits.v1.json"),
    deletionRevisionLockPath: path.join(metadataDir, "deletion-revisions.v1.json.lock"),
    assertManagedStoragePath: (filePath) => path.resolve(filePath),
  });
}

function proofMemory(id = "memory-1"): MemoryFile {
  return {
    path: `facts/${id}.md`,
    content: "proof source",
    frontmatter: { id },
  } as MemoryFile;
}

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

test("deletion revision and proof stores reject a symlinked storage root", async () => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "remnic-symlink-root-outside-"));
  const rootLink = path.join(path.dirname(outside), `${path.basename(outside)}-link`);
  try {
    await symlink(outside, rootLink, "dir");
    const store = createDeletionRevisionStore(rootLink);

    await assert.rejects(store.readDeletionRevisions(), /must not pass through a symlink/);
    await assert.rejects(store.recordCommittedInvalidation(proofMemory()), /must not pass through a symlink/);
    await assert.rejects(
      lstat(path.join(outside, ".offline-sync")),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
  } finally {
    await rm(rootLink, { force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("deletion revision and proof stores reject a symlinked metadata parent before outside writes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-symlink-parent-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "remnic-symlink-parent-outside-"));
  try {
    await symlink(outside, path.join(root, ".offline-sync"), "dir");
    const store = createDeletionRevisionStore(root);

    await assert.rejects(
      store.recordReplicatedDeletionRevision(path.join(root, "facts", "deleted.md"), 2000),
      /must not pass through a symlink/,
    );
    await assert.rejects(store.recordCommittedInvalidation(proofMemory()), /must not pass through a symlink/);
    await assert.rejects(
      lstat(path.join(outside, "deletion-revisions.v1.json")),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
    await assert.rejects(
      lstat(path.join(outside, "invalidation-commits.v1.json")),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("deletion revision and proof stores reject symlinked metadata targets before outside reads or writes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-symlink-target-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "remnic-symlink-target-outside-"));
  const deletionSentinel = path.join(outside, "deletion-sentinel");
  const proofSentinel = path.join(outside, "proof-sentinel");
  try {
    const metadataDir = path.join(root, ".offline-sync");
    await mkdir(metadataDir, { recursive: true });
    await writeFile(deletionSentinel, "deletion sentinel");
    await writeFile(proofSentinel, "proof sentinel");
    await symlink(deletionSentinel, path.join(metadataDir, "deletion-revisions.v1.json"));
    await symlink(proofSentinel, path.join(metadataDir, "invalidation-commits.v1.json"));
    const store = createDeletionRevisionStore(root);

    await assert.rejects(store.readDeletionRevisions(), /must not pass through a symlink/);
    await assert.rejects(
      store.recordCommittedInvalidation(proofMemory()),
      /must not pass through a symlink/,
    );
    assert.equal(await readFile(deletionSentinel, "utf8"), "deletion sentinel");
    assert.equal(await readFile(proofSentinel, "utf8"), "proof sentinel");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("managed deletion and write reject a symlinked storage-file parent before outside access", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-symlink-file-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "remnic-symlink-file-outside-"));
  const outsideDeleted = path.join(outside, "deleted.md");
  const outsideWritten = path.join(outside, "written.md");
  try {
    await writeFile(outsideDeleted, "must remain");
    await symlink(outside, path.join(root, "facts"), "dir");
    const store = createDeletionRevisionStore(root);

    await assert.rejects(
      store.deleteManagedStorageFile(path.join(root, "facts", "deleted.md")),
      /must not pass through a symlink/,
    );
    await assert.rejects(
      store.writeManagedStorageFile(path.join(root, "facts", "written.md"), async () => {
        await writeFile(outsideWritten, "must not write");
      }),
      /must not pass through a symlink/,
    );
    assert.equal(await readFile(outsideDeleted, "utf8"), "must remain");
    await assert.rejects(
      lstat(outsideWritten),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
test("failed proof rollback stays quarantined and fails closed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-invalidation-proof-quarantine-"));
  try {
    const store = createDeletionRevisionStore(root);
    const memory = proofMemory("quarantine-memory");
    await store.recordCommittedInvalidation(memory);
    const internal = store as unknown as {
      writeInvalidationCommitMetadata: (...args: unknown[]) => Promise<void>;
    };
    internal.writeInvalidationCommitMetadata = async () => {
      throw new Error("synthetic proof rollback failure");
    };

    await assert.rejects(
      store.clearCommittedInvalidation(memory),
      /synthetic proof rollback failure/,
    );
    assert.equal(await store.hasCommittedInvalidation(memory), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("proof quarantine is instance-scoped and does not mask durable proof in another store", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-invalidation-proof-quarantine-instance-"));
  try {
    const writer = createDeletionRevisionStore(root);
    const reader = createDeletionRevisionStore(root);
    const memory = proofMemory("instance-scoped-quarantine");
    await writer.recordCommittedInvalidation(memory);

    const internal = writer as unknown as {
      writeInvalidationCommitMetadata: (...args: unknown[]) => Promise<void>;
    };
    internal.writeInvalidationCommitMetadata = async () => {
      throw new Error("synthetic proof rollback failure");
    };

    await assert.rejects(
      writer.clearCommittedInvalidation(memory),
      /synthetic proof rollback failure/,
    );
    assert.equal(await writer.hasCommittedInvalidation(memory), false);
    assert.equal(await reader.hasCommittedInvalidation(memory), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("failed proof rollback quarantine stays bounded and fails closed after the cap", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-invalidation-proof-quarantine-cap-"));
  try {
    const store = createDeletionRevisionStore(root);
    const internal = store as unknown as {
      invalidationProofQuarantine: Set<string>;
      writeInvalidationCommitMetadata: (...args: unknown[]) => Promise<void>;
    };
    const originalWrite = internal.writeInvalidationCommitMetadata;
    for (let index = 0; index <= 1024; index += 1) {
      const memory = proofMemory(`bounded-quarantine-${index}`);
      await store.recordCommittedInvalidation(memory);
      internal.writeInvalidationCommitMetadata = async () => {
        throw new Error("synthetic proof rollback failure");
      };
      await assert.rejects(store.clearCommittedInvalidation(memory), /synthetic proof rollback failure/);
      internal.writeInvalidationCommitMetadata = originalWrite;
    }

    const quarantinedBeforeOverflow = proofMemory("bounded-quarantine-0");
    assert.equal(await store.hasCommittedInvalidation(quarantinedBeforeOverflow), false);

    const recordedAfterOverflow = proofMemory("recorded-after-quarantine-cap");
    await store.recordCommittedInvalidation(recordedAfterOverflow);
    assert.equal(await store.hasCommittedInvalidation(recordedAfterOverflow), true);
    internal.writeInvalidationCommitMetadata = async () => {
      throw new Error("synthetic post-overflow rollback failure");
    };
    await assert.rejects(
      store.clearCommittedInvalidation(recordedAfterOverflow),
      /synthetic post-overflow rollback failure/,
    );
    assert.equal(await store.hasCommittedInvalidation(recordedAfterOverflow), false);
    internal.writeInvalidationCommitMetadata = originalWrite;
    await store.recordCommittedInvalidation(recordedAfterOverflow);
    assert.equal(await store.hasCommittedInvalidation(recordedAfterOverflow), true);
    assert.equal(internal.invalidationProofQuarantine.size, 1024);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
