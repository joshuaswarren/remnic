import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StorageManager } from "../packages/remnic-core/src/storage.js";

/**
 * Regression: an offline-sync (converge) write of an ordinary active memory
 * must not rebuild the tombstone-blocked capture index. The index only holds
 * tombstone-blocked explicit-capture keys, so a write where neither the
 * pre-write file nor the incoming memory is blocked cannot change it — but the
 * invalidation path rebuilt it unconditionally, re-reading the whole corpus per
 * replicated file (measured 15-31s per write against a ~190k-file corpus,
 * which turned a boot-scale `converge apply` into a multi-week projection).
 */
class CountingStorage extends StorageManager {
  readAllMemoriesCalls = 0;

  override async readAllMemories(options?: Parameters<StorageManager["readAllMemories"]>[0]) {
    this.readAllMemoriesCalls += 1;
    return super.readAllMemories(options);
  }

  captureIndex() {
    return this.getTombstoneBlockedCaptureIndex();
  }
}

function memoryMarkdown(id: string, body: string, extra = ""): string {
  return [
    "---",
    `id: ${id}`,
    "category: fact",
    "created: 2026-01-01T00:00:00.000Z",
    "updated: 2026-01-01T00:00:00.000Z",
    "status: active",
    extra,
    "---",
    body,
  ].join("\n");
}

async function withStorage(run: (storage: CountingStorage, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "offline-sync-index-cost-"));
  const storage = new CountingStorage(dir);
  try {
    await run(storage, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("offline-sync write of an unblocked memory does not re-read the corpus", async () => {
  await withStorage(async (storage, dir) => {
    await mkdir(path.join(dir, "facts", "2026-01-01"), { recursive: true });
    await writeFile(path.join(dir, "facts", "2026-01-01", "seed.md"), memoryMarkdown("seed-1", "seed body"));

    // Load the capture index the way a running daemon would (any blocked check).
    await storage.hasTombstoneBlockedExplicitCapture("nothing", "fact");
    const before = storage.readAllMemoriesCalls;
    assert.ok(before >= 1, "index warm-up must have read the corpus at least once");

    const target = path.join(dir, "facts", "2026-01-01", "replicated.md");
    await storage.writeOfflineSyncFile(target, Buffer.from(memoryMarkdown("repl-1", "replicated body")));

    assert.equal(
      storage.readAllMemoriesCalls,
      before,
      "an unblocked offline-sync write must not trigger a full corpus rebuild"
    );
    assert.equal(
      await storage.captureIndex().isAuthoritative(),
      true,
      "clearing the committed marker must restore index authority"
    );
    const stored = await storage.readMemoryByPath(target);
    assert.equal(stored?.frontmatter.id, "repl-1", "the replicated file must still be written");
  });
});

test("offline-sync write of a tombstone-blocked memory still rebuilds the index", async () => {
  await withStorage(async (storage, dir) => {
    await mkdir(path.join(dir, "facts", "2026-01-01"), { recursive: true });
    await storage.hasTombstoneBlockedExplicitCapture("nothing", "fact");
    const before = storage.readAllMemoriesCalls;

    const blocked = memoryMarkdown(
      "blocked-1",
      "blocked explicit capture body",
      "status: pending_review\nblockedBy: tomb-1"
    ).replace("status: active\n", "");
    const target = path.join(dir, "facts", "2026-01-01", "blocked.md");
    await storage.writeOfflineSyncFile(target, Buffer.from(blocked));

    assert.ok(
      storage.readAllMemoriesCalls > before,
      "a blocked offline-sync write must still update the index via rebuild"
    );
    assert.equal(
      await storage.hasTombstoneBlockedExplicitCapture("blocked explicit capture body", "fact"),
      true,
      "the blocked key must be indexed"
    );
  });
});

test("unblocking via offline-sync write rebuilds and drops the key", async () => {
  await withStorage(async (storage, dir) => {
    await mkdir(path.join(dir, "facts", "2026-01-01"), { recursive: true });
    const blocked = [
      "---",
      "id: blocked-2",
      "category: fact",
      "created: 2026-01-01T00:00:00.000Z",
      "updated: 2026-01-01T00:00:00.000Z",
      "status: pending_review",
      "blockedBy: tomb-2",
      "---",
      "body that was blocked",
    ].join("\n");
    const target = path.join(dir, "facts", "2026-01-01", "flip.md");
    await storage.writeOfflineSyncFile(target, Buffer.from(blocked));
    assert.equal(await storage.hasTombstoneBlockedExplicitCapture("body that was blocked", "fact"), true);

    const before = storage.readAllMemoriesCalls;
    await storage.writeOfflineSyncFile(target, Buffer.from(memoryMarkdown("blocked-2", "body that was blocked")));
    assert.ok(storage.readAllMemoriesCalls > before, "blocked -> active transition must rebuild");
    assert.equal(
      await storage.hasTombstoneBlockedExplicitCapture("body that was blocked", "fact"),
      false,
      "the unblocked key must be gone"
    );
  });
});

test("clearing a committed marker restores authority after a mid-write rebuild", async () => {
  await withStorage(async (storage) => {
    await storage.hasTombstoneBlockedExplicitCapture("nothing", "fact");
    const index = storage.captureIndex();
    assert.equal(await index.isAuthoritative(), true);

    const marker = await index.prepareWrite();
    await index.check("nothing", "fact");
    assert.equal(await index.isAuthoritative(), false, "a pending marker must make the index non-authoritative");

    await index.clearCommittedWriteMarker(marker);
    assert.equal(await index.isAuthoritative(), true, "clearing the last pending marker must restore authority");
  });
});
