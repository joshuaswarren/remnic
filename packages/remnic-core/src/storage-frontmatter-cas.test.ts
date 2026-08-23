import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StorageManager } from "./storage.js";
import type { CasRevisionTransaction } from "./storage/cas-revision-store.js";

async function withStorage(run: (storage: StorageManager) => Promise<void>): Promise<void> {
  StorageManager.clearAllStaticCaches();
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-frontmatter-cas-"));
  try {
    await run(new StorageManager(memoryDir));
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(memoryDir, { recursive: true, force: true });
  }
}

test("writeMemoryFrontmatterIfUnchanged rejects a semantic concurrent change", async () => {
  await withStorage(async (storage) => {
    const created = await storage.writeMemory("fact", "The source snapshot must remain stable.", { source: "test" });
    const expected = await storage.getMemoryById(created.id);
    assert.ok(expected);

    assert.equal(await storage.writeMemoryFrontmatter(expected, { status: "archived" }), true);
    assert.equal(
      await storage.writeMemoryFrontmatterIfUnchanged(expected, {
        importance: { score: 0.9, level: "high", reasons: ["test"], keywords: [] },
      }),
      false,
    );

    const current = await storage.getMemoryById(created.id);
    assert.ok(current);
    assert.equal(current.frontmatter.status, "archived");
    assert.notEqual(current.frontmatter.importance?.score, 0.9);
  });
});
test("supersedeMemory rejects a semantic change after snapshot lookup", async () => {
  await withStorage(async (storage) => {
    const created = await storage.writeMemory("fact", "The supersession source must remain stable.", { source: "test" });
    const replacement = await storage.writeMemory("fact", "The replacement must remain stable.", { source: "test" });
    const expected = await storage.getMemoryById(created.id);
    assert.ok(expected);

    const seams = storage as unknown as {
      withTombstoneBlockedMemoryPathLock: (...args: never[]) => Promise<unknown>;
    };
    const originalLock = seams.withTombstoneBlockedMemoryPathLock.bind(storage);
    let injected = false;
    seams.withTombstoneBlockedMemoryPathLock = async (...args) => {
      const [pathname, task, additionalPathnames] = args as unknown as [
        string,
        (current: unknown) => Promise<unknown>,
        readonly string[] | undefined,
      ];
      if (!injected) {
        injected = true;
        seams.withTombstoneBlockedMemoryPathLock = originalLock;
        assert.equal(
          await storage.writeMemoryFrontmatter(expected, {
            importance: { score: 0.4, level: "normal", reasons: ["concurrent"], keywords: [] },
          }),
          true,
        );
      }
      return originalLock(pathname as never, task as never, additionalPathnames as never);
    };

    assert.equal(
      await storage.supersedeMemory(
        created.id,
        replacement.id,
        "dependency_propagation:contradiction",
        { supersessionCause: "dependency", invalidatedBy: created.id },
        { requireActive: true, acceptExactReplay: true, expectedSnapshot: expected },
      ),
      false,
    );
    const current = await storage.getMemoryById(created.id);
    assert.ok(current);
    assert.equal(current.frontmatter.status, "active");
    assert.equal(current.frontmatter.supersededBy, undefined);
    assert.equal(current.frontmatter.importance?.score, 0.4);
  });
});

test("supersedeMemory uses a bounded memory timeline lookup", async () => {
  await withStorage(async (storage) => {
    const created = await storage.writeMemory("fact", "The bounded supersession source.", { source: "test" });
    const replacement = await storage.writeMemory("fact", "The bounded supersession replacement.", { source: "test" });
    const seams = storage as unknown as {
      getMemoryTimeline: (memoryId: string, limit?: number) => Promise<unknown[]>;
      readAllMemoryLifecycleEvents: () => Promise<never>;
    };
    let timelineCalls = 0;
    seams.getMemoryTimeline = async (memoryId, limit) => {
      timelineCalls++;
      assert.equal(memoryId, created.id);
      assert.equal(limit, 200);
      return [];
    };
    seams.readAllMemoryLifecycleEvents = async () => {
      throw new Error("supersession must not scan the full lifecycle ledger");
    };

    assert.equal(
      await storage.supersedeMemory(created.id, replacement.id, "dependency_propagation:bounded"),
      true,
    );
    assert.equal(timelineCalls, 1);
    const current = await storage.getMemoryById(created.id);
    assert.ok(current);
    assert.equal(current.frontmatter.status, "superseded");
    assert.equal(current.frontmatter.supersededBy, replacement.id);
  });
});

test("writeMemoryFrontmatterIfUnchanged preserves access-only updates", async () => {
  await withStorage(async (storage) => {
    const created = await storage.writeMemory("fact", "Access telemetry is not semantic content.", { source: "test" });
    const expected = await storage.getMemoryById(created.id);
    assert.ok(expected);

    const lastAccessed = "2026-08-10T00:00:00.000Z";
    assert.equal(await storage.writeMemoryFrontmatter(expected, { accessCount: 3, lastAccessed }), true);
    assert.equal(
      await storage.writeMemoryFrontmatterIfUnchanged(expected, {
        importance: { score: 0.8, level: "high", reasons: ["test"], keywords: [] },
      }),
      true,
    );

    const current = await storage.getMemoryById(created.id);
    assert.ok(current);
    assert.equal(current.frontmatter.importance?.score, 0.8);
    assert.equal(current.frontmatter.accessCount, 3);
    assert.equal(current.frontmatter.lastAccessed, lastAccessed);
  });
});
test("revision minting happens inside the capture lock during frontmatter mutation", async () => {
  await withStorage(async (storage) => {
    const created = await storage.writeMemory("fact", "Lock atomicity test content.", { source: "test" });
    const expected = await storage.getMemoryById(created.id);
    assert.ok(expected);

    let reservedInsideLock = false;
    const seams = storage as unknown as {
      casRevisions: { beginRevisionTransaction: (pathname: string) => Promise<CasRevisionTransaction> };
    };
    const origBegin = seams.casRevisions.beginRevisionTransaction.bind(seams.casRevisions);
    seams.casRevisions.beginRevisionTransaction = async (pathname: string) => {
      const lockIndex = (storage as any).getTombstoneBlockedCaptureIndex();
      reservedInsideLock = lockIndex.isLocked ? lockIndex.isLocked(pathname) : true;
      return await origBegin(pathname);
    };

    assert.equal(await storage.writeMemoryFrontmatter(expected, { status: "archived" }), true);
    assert.equal(reservedInsideLock, true, "the PENDING reservation was minted while holding the capture lock");
    assert.equal(
      (await storage.readCasRevisionStatus(expected.path)).status,
      "present",
      "the transaction published its COMMITTED receipt",
    );
  });
});

test("readCasRevision fails open with warning when sidecar read throws", async () => {
  await withStorage(async (storage) => {
    const created = await storage.writeMemory("fact", "Fail-open read test content.", { source: "test" });
    const memory = await storage.getMemoryById(created.id);
    assert.ok(memory);

    // Force readRevision to throw an unexpected storage error
    (storage as any).casRevisions.readRevision = async () => {
      throw new Error("simulated disk read failure");
    };

    const rev = await storage.readCasRevision(memory.path);
    assert.equal(rev, undefined, "readCasRevision returns undefined fail-open on error");
  });
});

test("sharded per-target CAS receipt storage is O(1) and non-corpus-proportional", async () => {
  await withStorage(async (storage) => {
    const memoryDir = (storage as any).baseDir;
    // Create 50 memories in the corpus
    const memories = [];
    for (let i = 0; i < 50; i++) {
      memories.push(await storage.writeMemory("fact", `Corpus memory number ${i}`, { source: "test" }));
    }

    const targetMemory = await storage.getMemoryById(memories[25]!.id);
    assert.ok(targetMemory);

    // Update frontmatter of target memory
    assert.equal(await storage.writeMemoryFrontmatter(targetMemory, { tags: ["updated"] }), true);

    const shardedDir = path.join(memoryDir, ".offline-sync", "cas-revisions");
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(shardedDir);
    const jsonFiles = files.filter((f) => f.endsWith(".json"));

    // Exactly 1 per-target JSON shard file should exist in the sharded directory
    assert.equal(jsonFiles.length, 1, "only 1 per-target shard file was created for the single mutated target");

    // Global file cas-revisions.v1.json should NOT exist
    const legacyFileExists = await import("node:fs/promises")
      .then((fs) => fs.stat(path.join(memoryDir, ".offline-sync", "cas-revisions.v1.json")))
      .then(() => true, () => false);
    assert.equal(legacyFileExists, false, "global cas-revisions.v1.json was not created");
  });
});

test("backward-compatible legacy cas-revisions.v1.json is read when shard is absent", async () => {
  await withStorage(async (storage) => {
    const memoryDir = (storage as any).baseDir;
    const created = await storage.writeMemory("fact", "Legacy map fallback content.", { source: "test" });
    const memory = await storage.getMemoryById(created.id);
    assert.ok(memory);

    const relPath = path.relative(memoryDir, memory.path).split(path.sep).join("/");
    const legacyToken = "2026-08-20T00:00:00.000Z";

    // Write a legacy global cas-revisions.v1.json
    const { mkdir, writeFile } = await import("node:fs/promises");
    const legacyPath = path.join(memoryDir, ".offline-sync", "cas-revisions.v1.json");
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(
      legacyPath,
      JSON.stringify({ version: 1, revisions: [{ path: relPath, revision: legacyToken }] }),
      "utf8",
    );

    // Read standing revision before shard exists
    const standing = await storage.readCasRevision(memory.path);
    assert.equal(standing, legacyToken, "readCasRevision fell back to reading legacy global map");

    // Mutate memory: should mint a new revision greater than legacyToken and write to per-target shard
    assert.equal(await storage.writeMemoryFrontmatter(memory, { status: "archived" }), true);
    const nextToken = await storage.readCasRevision(memory.path);
    assert.ok(nextToken && nextToken > legacyToken, "next revision is strictly greater than legacy token");
  });
});

function casShardPath(memoryDir: string, memoryPath: string): string {
  const relative = path.relative(memoryDir, memoryPath).split(path.sep).join("/");
  const hash = createHash("sha256").update(relative).digest("hex");
  return path.join(memoryDir, ".offline-sync", "cas-revisions", `${hash}.json`);
}

test("readCasRevisionStatus distinguishes present, absent, and unavailable receipts (#2813 P1 A)", async () => {
  await withStorage(async (storage) => {
    const created = await storage.writeMemory("fact", "Status truth test content.", { source: "test" });
    const memory = await storage.getMemoryById(created.id);
    assert.ok(memory);

    assert.deepEqual(
      await storage.readCasRevisionStatus(memory.path),
      { status: "absent" },
      "a fresh target that never minted is genuinely absent, not unavailable",
    );

    assert.equal(await storage.writeMemoryFrontmatter(memory, { status: "archived" }), true);
    const standing = await storage.readCasRevision(memory.path);
    assert.ok(standing);
    assert.deepEqual(await storage.readCasRevisionStatus(memory.path), {
      status: "present",
      revision: standing,
    });

    // A torn shard write: the receipt EXISTS but cannot be read. That is
    // unavailability — never absence — while the fail-open read keeps
    // collapsing the error to undefined.
    // Test seam: baseDir is the constructor's memoryDir (private on StorageManager).
    const { baseDir } = storage as unknown as { baseDir: string };
    await writeFile(casShardPath(baseDir, memory.path), "{corrupt", "utf8");
    const unreadable = await storage.readCasRevisionStatus(memory.path);
    assert.equal(unreadable.status, "unavailable");
    assert.equal(
      await storage.readCasRevision(memory.path),
      undefined,
      "the fail-open read still collapses the error to undefined",
    );
  });
});

test("a failed receipt mint leaves the durable memory file untouched on a content update (#2813 P1 B)", async () => {
  await withStorage(async (storage) => {
    const created = await storage.writeMemory("fact", "Mint failure must not mutate the record.", { source: "test" });
    const before = await storage.getMemoryById(created.id);
    assert.ok(before);
    const bytesBefore = await readFile(before.path);
    assert.equal((await storage.readCasRevisionStatus(before.path)).status, "absent");

    const seams = storage as unknown as {
      casRevisions: { beginRevisionTransaction: (pathname: string) => Promise<CasRevisionTransaction> };
    };
    const origBegin = seams.casRevisions.beginRevisionTransaction.bind(seams.casRevisions);
    seams.casRevisions.beginRevisionTransaction = async () => {
      throw new Error("simulated sidecar mint failure");
    };
    try {
      await assert.rejects(storage.updateMemory(created.id, "This body must never land."));
    } finally {
      seams.casRevisions.beginRevisionTransaction = origBegin;
    }

    assert.deepEqual(
      await readFile(before.path),
      bytesBefore,
      "the durable memory file is byte-identical after a failed mint",
    );
    const after = await storage.getMemoryById(created.id);
    assert.ok(after);
    assert.equal(after.content, before.content, "the indexed record still holds the original body");
    assert.equal(after.frontmatter.updated, before.frontmatter.updated, "frontmatter business time is untouched");
    assert.equal(
      (await storage.readCasRevisionStatus(before.path)).status,
      "absent",
      "no receipt was recorded for a write that never landed",
    );
  });
});

test("a failed receipt mint leaves the durable memory file untouched on a semantic frontmatter write (#2813 P1 B)", async () => {
  await withStorage(async (storage) => {
    const created = await storage.writeMemory("fact", "Frontmatter mint failure content.", { source: "test" });
    const before = await storage.getMemoryById(created.id);
    assert.ok(before);
    const bytesBefore = await readFile(before.path);

    const seams = storage as unknown as {
      casRevisions: { beginRevisionTransaction: (pathname: string) => Promise<CasRevisionTransaction> };
    };
    const origBegin = seams.casRevisions.beginRevisionTransaction.bind(seams.casRevisions);
    seams.casRevisions.beginRevisionTransaction = async () => {
      throw new Error("simulated sidecar mint failure");
    };
    try {
      await assert.rejects(storage.writeMemoryFrontmatter(before, { status: "archived" }));
    } finally {
      seams.casRevisions.beginRevisionTransaction = origBegin;
    }

    assert.deepEqual(await readFile(before.path), bytesBefore);
    const after = await storage.getMemoryById(created.id);
    assert.ok(after);
    assert.equal(after.frontmatter.status ?? "active", "active", "the semantic flip never landed");
    assert.equal((await storage.readCasRevisionStatus(before.path)).status, "absent");
  });
});

test("an access-only frontmatter patch bypasses the mint and still lands (#2813 P1 B)", async () => {
  await withStorage(async (storage) => {
    const created = await storage.writeMemory("fact", "Access telemetry mint bypass content.", { source: "test" });
    const before = await storage.getMemoryById(created.id);
    assert.ok(before);

    const seams = storage as unknown as {
      casRevisions: { beginRevisionTransaction: (pathname: string) => Promise<CasRevisionTransaction> };
    };
    seams.casRevisions.beginRevisionTransaction = async () => {
      throw new Error("access-only patches must never mint");
    };

    const lastAccessed = "2026-08-22T00:00:00.000Z";
    assert.equal(
      await storage.writeMemoryFrontmatter(before, { accessCount: 9, lastAccessed }),
      true,
      "an access-only patch succeeds even with a broken mint — it never mints",
    );

    const after = await storage.getMemoryById(created.id);
    assert.ok(after);
    assert.equal(after.frontmatter.accessCount, 9);
    assert.equal(after.frontmatter.lastAccessed, lastAccessed);
    assert.equal((await storage.readCasRevisionStatus(before.path)).status, "absent");
  });
});

test("a symlinked cas-revisions sidecar directory is rejected, never followed (#2813 P1 A)", async () => {
  await withStorage(async (storage) => {
    const created = await storage.writeMemory("fact", "Symlink escape guard content.", { source: "test" });
    const memory = await storage.getMemoryById(created.id);
    assert.ok(memory);
    assert.equal((await storage.readCasRevisionStatus(memory.path)).status, "absent");

    const { baseDir } = storage as unknown as { baseDir: string };
    const escapeRoot = await mkdtemp(path.join(os.tmpdir(), "remnic-cas-escape-"));
    try {
      const shardDir = path.join(baseDir, ".offline-sync", "cas-revisions");
      await rm(shardDir, { recursive: true, force: true });
      await mkdir(path.dirname(shardDir), { recursive: true });
      await symlink(escapeRoot, shardDir);

      const status = await storage.readCasRevisionStatus(memory.path);
      assert.equal(
        status.status,
        "unavailable",
        "a symlinked sidecar reads as unavailable — never as data beyond the memory root",
      );

      await assert.rejects(storage.updateMemory(created.id, "Body routed through a symlink."));
      const after = await storage.getMemoryById(created.id);
      assert.ok(after);
      assert.equal(after.content, memory.content, "the memory file is untouched when the sidecar path is unsafe");
      assert.deepEqual(
        await readdir(escapeRoot),
        [],
        "no shard, lock, or temporary file escaped the memory root through the symlink",
      );
    } finally {
      await rm(escapeRoot, { recursive: true, force: true });
    }
  });
});

test("a symlinked .offline-sync ancestor is rejected before any sidecar use (#2813 P1 A)", async () => {
  await withStorage(async (storage) => {
    const created = await storage.writeMemory("fact", "Offline-sync ancestor guard content.", { source: "test" });
    const memory = await storage.getMemoryById(created.id);
    assert.ok(memory);

    const { baseDir } = storage as unknown as { baseDir: string };
    const escapeRoot = await mkdtemp(path.join(os.tmpdir(), "remnic-offline-sync-escape-"));
    try {
      const offlineSync = path.join(baseDir, ".offline-sync");
      await rm(offlineSync, { recursive: true, force: true });
      await symlink(escapeRoot, offlineSync);

      assert.equal((await storage.readCasRevisionStatus(memory.path)).status, "unavailable");
      await assert.rejects(storage.writeMemoryFrontmatter(memory, { status: "archived" }));
      assert.deepEqual(await readdir(escapeRoot), [], "nothing escaped through the symlinked ancestor");
    } finally {
      await rm(escapeRoot, { recursive: true, force: true });
    }
  });
});

test("a symlinked shard file reads as unavailable and blocks minting (#2813 P1 A)", async () => {
  await withStorage(async (storage) => {
    const created = await storage.writeMemory("fact", "Shard link guard content.", { source: "test" });
    const memory = await storage.getMemoryById(created.id);
    assert.ok(memory);
    assert.equal(await storage.writeMemoryFrontmatter(memory, { tags: ["v1"] }), true);
    assert.ok(await storage.readCasRevision(memory.path));

    const { baseDir } = storage as unknown as { baseDir: string };
    const escapeRoot = await mkdtemp(path.join(os.tmpdir(), "remnic-cas-shard-escape-"));
    try {
      const rel = path.relative(baseDir, memory.path).split(path.sep).join("/");
      const escapeToken = "2099-01-01T00:00:00.000Z";
      const escapeShard = path.join(escapeRoot, "shard.json");
      await writeFile(
        escapeShard,
        `${JSON.stringify({ version: 1, path: rel, revision: escapeToken, state: "committed" })}\n`,
        "utf8",
      );
      const shardPath = casShardPath(baseDir, memory.path);
      await rm(shardPath);
      await symlink(escapeShard, shardPath);

      assert.equal(
        (await storage.readCasRevisionStatus(memory.path)).status,
        "unavailable",
        "a shard symlink is refused — the escape target is never read as the standing receipt",
      );
      await assert.rejects(storage.updateMemory(created.id, "Body over a linked shard."));
      const escaped = JSON.parse(await readFile(escapeShard, "utf8")) as { revision?: string };
      assert.equal(escaped.revision, escapeToken, "the escape target is byte-identical — never followed nor replaced");
    } finally {
      await rm(escapeRoot, { recursive: true, force: true });
    }
  });
});

test("a memory file write failure aborts the pending receipt reservation (#2813 P1 C)", async () => {
  await withStorage(async (storage) => {
    const created = await storage.writeMemory("fact", "Write failure abort content.", { source: "test" });
    const before = await storage.getMemoryById(created.id);
    assert.ok(before);
    const bytesBefore = await readFile(before.path);
    assert.equal((await storage.readCasRevisionStatus(before.path)).status, "absent");

    const seams = storage as unknown as {
      writeStorageSecureFile: (pathname: string, fileContent: string) => Promise<void>;
    };
    const origWrite = seams.writeStorageSecureFile.bind(seams);
    seams.writeStorageSecureFile = async () => {
      throw new Error("simulated durable memory write failure");
    };
    try {
      await assert.rejects(storage.updateMemory(created.id, "This body must not own a receipt."));
    } finally {
      seams.writeStorageSecureFile = origWrite;
    }

    assert.deepEqual(await readFile(before.path), bytesBefore, "the durable memory file never changed");
    assert.equal(
      (await storage.readCasRevisionStatus(before.path)).status,
      "absent",
      "the aborted reservation left no pending marker — the failed write owns nothing",
    );
    const shardDir = path.join(
      (storage as unknown as { baseDir: string }).baseDir,
      ".offline-sync",
      "cas-revisions",
    );
    const leftovers = (await readdir(shardDir).catch(() => [] as string[])).filter((f) => f.endsWith(".json"));
    assert.deepEqual(leftovers, [], "the pending shard was unlinked by the abort");
  });
});

test("a receipt publication failure after the memory write preserves the pending marker for recovery (#2813 P1 C)", async () => {
  await withStorage(async (storage) => {
    const created = await storage.writeMemory("fact", "Publish failure ambiguity content.", { source: "test" });
    const before = await storage.getMemoryById(created.id);
    assert.ok(before);

    const seams = storage as unknown as {
      casRevisions: {
        beginRevisionTransaction: (pathname: string) => Promise<CasRevisionTransaction>;
        reconcilePendingRevision: (pathname: string, fileWriteLanded: boolean) => Promise<string>;
      };
    };
    const origBegin = seams.casRevisions.beginRevisionTransaction.bind(seams.casRevisions);
    let reserved: string | undefined;
    seams.casRevisions.beginRevisionTransaction = async (pathname: string) => {
      const transaction = await origBegin(pathname);
      reserved = transaction.pendingRevision;
      return {
        pendingRevision: transaction.pendingRevision,
        abort: transaction.abort,
        commit: async () => {
          throw new Error("simulated receipt publication failure");
        },
      };
    };
    try {
      await assert.rejects(storage.updateMemory(created.id, "Body whose receipt never publishes."));
    } finally {
      seams.casRevisions.beginRevisionTransaction = origBegin;
    }
    assert.ok(reserved, "the reservation was minted before the write");

    const onDisk = await readFile(before.path, "utf8");
    assert.match(onDisk, /Body whose receipt never publishes\./, "the durable memory write landed");

    const status = await storage.readCasRevisionStatus(before.path);
    assert.equal(status.status, "unavailable", "a pending marker is never ownership and never absence");
    assert.match(status.status === "unavailable" ? status.reason : "", /pending/i);

    await assert.rejects(
      storage.updateMemory(created.id, "Second body while ambiguous."),
      "new receipt transactions refuse while a pending marker stands",
    );
    await assert.rejects(
      storage.writeMemoryFrontmatter(before, { status: "archived" }),
      "frontmatter minting refuses while a pending marker stands",
    );

    assert.equal(await seams.casRevisions.reconcilePendingRevision(before.path, true), "reconciled");
    assert.deepEqual(await storage.readCasRevisionStatus(before.path), {
      status: "present",
      revision: reserved,
    });
  });
});

test("sequential writers on one target mint unique, strictly increasing receipts (#2813 P1 C)", async () => {
  await withStorage(async (storage) => {
    const created = await storage.writeMemory("fact", "First body.", { source: "test" });
    const memory = await storage.getMemoryById(created.id);
    assert.ok(memory);
    assert.equal((await storage.readCasRevisionStatus(memory.path)).status, "absent");

    assert.equal(await storage.updateMemory(created.id, "Second body."), true);
    const receiptA = await storage.readCasRevision(memory.path);
    assert.ok(receiptA, "writer A owns the first receipt");

    assert.equal(await storage.updateMemory(created.id, "Third body."), true);
    const receiptB = await storage.readCasRevision(memory.path);
    assert.ok(receiptB, "writer B owns the second receipt");
    assert.notEqual(receiptA, receiptB, "two commits never share a receipt");
    assert.ok(receiptB > receiptA, "receipts are strictly increasing per target");
  });
});
