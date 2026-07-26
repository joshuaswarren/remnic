/**
 * Correction storage-integration regression tests (#1672).
 *
 * Proves the three wiring-level fixes that prevent fact resurrection and
 * stale-candidate planning:
 *  - item 2: isEligibleCorrectionCandidate excludes archived memories.
 *  - item 3: applyEditMemory recomputes contentHash from the patched body.
 *  - item 4: appendTombstoneFn emits one tombstone per derived supersession key.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MemoryFile } from "../types.js";

import { StorageManager, ContentHashIndex } from "../storage.js";
import { sanitizeMemoryContent } from "../sanitize.js";
import {
  isEligibleCorrectionCandidate,
  applyEditMemory,
  appendTombstoneFn,
  retireMemoryFn,
  rescopeMemoryFn,
  writeReplacementMemory,
} from "./correction-access-wiring.js";

async function makeStorage(prefix = "remnic-corr-wiring-") {
  StorageManager.clearAllStaticCaches();
  const baseDir = await mkdtemp(path.join(tmpdir(), prefix));
  const storage = new StorageManager(baseDir);
  await storage.ensureDirectories();
  storage.invalidateAllMemoriesCacheForDir();
  storage.setTombstonesConfig({
    enabled: true,
    semanticMatch: false,
    semanticThreshold: 0.9,
    namespace: "default",
  });
  return { storage, baseDir, cleanup: async () => { StorageManager.clearAllStaticCaches(); await rm(baseDir, { recursive: true, force: true }); } };
}

function fakeMemoryFile(over: Partial<MemoryFile["frontmatter"]> & { id: string }): MemoryFile {
  const { id: _id, ...rest } = over;
  return {
    path: "facts/x.md",
    content: over.id,
    frontmatter: {
      id: over.id,
      category: "fact",
      created: "2026-01-01T00:00:00.000Z",
      updated: "2026-01-01T00:00:00.000Z",
      source: "test",
      confidence: 0.9,
      ...rest,
    } as MemoryFile["frontmatter"],
  } as MemoryFile;
}

// ---------------------------------------------------------------------------
// item 2: lifecycle-aware candidate filter
// ---------------------------------------------------------------------------

test("#1672 item 2: isEligibleCorrectionCandidate accepts an active, non-archived memory", () => {
  const m = fakeMemoryFile({ id: "m1", status: "active" });
  assert.equal(isEligibleCorrectionCandidate(m), true);
});

test("#1672 item 2: isEligibleCorrectionCandidate rejects an archived memory even when status is active", () => {
  const m = fakeMemoryFile({ id: "m2", status: "active", archivedAt: "2026-07-01T00:00:00.000Z" });
  assert.equal(isEligibleCorrectionCandidate(m), false);
});

test("#1672 item 2: isEligibleCorrectionCandidate rejects a non-active status", () => {
  const m = fakeMemoryFile({ id: "m3", status: "superseded" });
  assert.equal(isEligibleCorrectionCandidate(m), false);
});

test("#1672 item 2: isEligibleCorrectionCandidate rejects archived memory with no explicit status", () => {
  const m = fakeMemoryFile({ id: "m4", archivedAt: "2026-07-01T00:00:00.000Z" });
  assert.equal(isEligibleCorrectionCandidate(m), false);
});

// ---------------------------------------------------------------------------
// item 3: contentHash recomputed on edit
// ---------------------------------------------------------------------------

test("#1672 item 3: applyEditMemory recomputes contentHash from the patched body", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    const wiring = { orchestrator: { getStorage: async () => storage } } as any;
    const { id: id } = await storage.writeMemory("fact", "the database is MySQL", { source: "test" });
    const before = await storage.getMemoryById(id);
    assert.ok(before?.frontmatter.contentHash, "writeMemory must set an initial contentHash");
    const oldHash = before!.frontmatter.contentHash!;

    await applyEditMemory(wiring, "default", id, "the database is PostgreSQL");

    const after = await storage.getMemoryById(id);
    assert.ok(after, "edited memory must still exist");
    const expectedHash = ContentHashIndex.computeHash(sanitizeMemoryContent("the database is PostgreSQL").text);
    assert.equal(after!.frontmatter.contentHash, expectedHash,
      "contentHash must match the PATCHED body (recomputed on edit)");
    assert.notEqual(after!.frontmatter.contentHash, oldHash,
      "contentHash must differ from the pre-edit hash");
    assert.equal(after!.content, "the database is PostgreSQL");
  } finally {
    await cleanup();
  }
});

test("#1672 item 3: applyEditMemory leaves non-fact contentHash untouched (only facts are hashed)", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    const wiring = { orchestrator: { getStorage: async () => storage } } as any;
    const { id: id } = await storage.writeMemory("preference", "likes dark mode", { source: "test" });
    await applyEditMemory(wiring, "default", id, "likes light mode");
    const after = await storage.getMemoryById(id);
    assert.equal(after!.content, "likes light mode");
    // Non-fact categories are not content-hash indexed, so no hash is forced.
    assert.ok(!after!.frontmatter.contentHash, "non-fact edit must not synthesize a contentHash");
  } finally {
    await cleanup();
  }
});

test("#2128 edit returns its committed id after cancellation", async () => {
  const { storage, cleanup } = await makeStorage("remnic-corr-edit-abort-");
  try {
    const { id } = await storage.writeMemory("fact", "the database is MySQL", { source: "test" });
    const originalWriteFrontmatter = storage.writeMemoryFrontmatter.bind(storage);
    const abortController = new AbortController();
    let committed = false;
    (storage as any).writeMemoryFrontmatter = async (...args: any[]) => {
      const result = await (originalWriteFrontmatter as (...inner: any[]) => Promise<unknown>)(...args);
      committed = true;
      abortController.abort(new Error("caller disconnected"));
      return result;
    };
    const wiring = { orchestrator: { getStorage: async () => storage } } as any;

    const editedId = await applyEditMemory(
      wiring,
      "default",
      id,
      "the database is PostgreSQL",
      abortController.signal,
    );

    assert.equal(committed, true);
    assert.equal(editedId, id);
    assert.equal((await storage.getMemoryById(id))?.content, "the database is PostgreSQL");
  } finally {
    await cleanup();
  }
});

test("#2128 retirement completes after cancellation during the durable write", async () => {
  const { storage, cleanup } = await makeStorage("remnic-corr-retire-abort-");
  try {
    const { id } = await storage.writeMemory("fact", "the database is MySQL", { source: "test" });
    const originalWriteFrontmatter = storage.writeMemoryFrontmatter.bind(storage);
    const abortController = new AbortController();
    let committed = false;
    (storage as any).writeMemoryFrontmatter = async (...args: any[]) => {
      const result = await (originalWriteFrontmatter as (...inner: any[]) => Promise<unknown>)(...args);
      committed = true;
      abortController.abort(new Error("caller disconnected"));
      return result;
    };
    const wiring = { orchestrator: { getStorage: async () => storage } } as any;

    await retireMemoryFn(
      wiring,
      "default",
      id,
      { status: "retracted" },
      abortController.signal,
    );

    assert.equal(committed, true);
    assert.equal((await storage.getMemoryById(id))?.frontmatter.status, "forgotten");
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Rescope cancellation transaction
// ---------------------------------------------------------------------------

test("#2128 rescope retires the source when cancellation lands after destination write", async () => {
  const source = await makeStorage("remnic-corr-rescope-source-");
  const destination = await makeStorage("remnic-corr-rescope-dest-");
  try {
    const { id: sourceId } = await source.storage.writeMemory("fact", "the database is MySQL", {
      source: "test",
    });
    const abortController = new AbortController();
    const originalWriteSealedMemory = destination.storage.writeSealedMemory.bind(destination.storage);
    let destinationWriteCompleted = false;
    (destination.storage as any).writeSealedMemory = async (...args: any[]) => {
      const result = await (originalWriteSealedMemory as (...args: any[]) => Promise<unknown>)(...args);
      destinationWriteCompleted = true;
      abortController.abort(new Error("caller disconnected"));
      return result;
    };
    const wiring = {
      orchestrator: {
        getStorage: async (namespace: string) =>
          namespace === "source" ? source.storage : destination.storage,
      },
    } as any;

    const destinationId = await rescopeMemoryFn(
      wiring,
      "source",
      sourceId,
      "destination",
      abortController.signal,
    );

    assert.equal(destinationWriteCompleted, true);
    const archivedSource = await source.storage.getMemoryById(sourceId);
    const activeDestination = await destination.storage.getMemoryById(destinationId);
    assert.equal(archivedSource?.frontmatter.status, "archived");
    assert.equal(activeDestination?.frontmatter.status, "active");
  } finally {
    await source.cleanup();
    await destination.cleanup();
  }
});

test("#2128 replacement write returns its committed id after cancellation", async () => {
  const { storage, cleanup } = await makeStorage("remnic-corr-replacement-");
  try {
    const originalWriteSealedMemory = storage.writeSealedMemory.bind(storage);
    const abortController = new AbortController();
    let committed = false;
    (storage as any).writeSealedMemory = async (...args: any[]) => {
      const result = await (originalWriteSealedMemory as (...inner: any[]) => Promise<unknown>)(...args);
      committed = true;
      abortController.abort(new Error("caller disconnected"));
      return result;
    };
    const wiring = { orchestrator: { getStorage: async () => storage } } as any;

    const id = await writeReplacementMemory(
      wiring,
      "default",
      { content: "the database is PostgreSQL", supersedes: "source-id" },
      abortController.signal,
    );

    assert.equal(committed, true);
    assert.equal(typeof id, "string");
    assert.equal((await storage.getMemoryById(id))?.frontmatter.status, "active");
  } finally {
    await cleanup();
  }
});

test("#2128 tombstone append returns its committed id after cancellation", async () => {
  const { storage, cleanup } = await makeStorage("remnic-corr-tombstone-abort-");
  try {
    const originalAppendTombstone = storage.appendTombstone.bind(storage);
    const abortController = new AbortController();
    let committed = false;
    (storage as any).appendTombstone = async (...args: any[]) => {
      const result = await (originalAppendTombstone as (...inner: any[]) => Promise<string | null>)(...args);
      committed = true;
      abortController.abort(new Error("caller disconnected"));
      return result;
    };
    const wiring = { orchestrator: { getStorage: async () => storage } } as any;

    const id = await appendTombstoneFn(
      wiring,
      "default",
      {
        reason: "retraction",
        sourceMemoryId: "source-id",
        rawContent: "the database is PostgreSQL",
      },
      abortController.signal,
    );

    assert.equal(committed, true);
    assert.equal(typeof id, "string");
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// item 4: per-key tombstone emission
// ---------------------------------------------------------------------------

test("#1672 item 4: appendTombstoneFn emits one tombstone per supersession key, each carrying contentHash", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    const wiring = { orchestrator: { getStorage: async () => storage } } as any;
    const keys = ["entity-deploy::day", "entity-deploy::week"];
    const firstId = await appendTombstoneFn(wiring, "default", {
      reason: "supersession",
      sourceMemoryId: "fact-structured",
      rawContent: "deploys happen on Tuesdays",
      supersessionKeys: keys,
      contentHash: "canonical-hash-abc",
    });
    assert.ok(firstId, "appendTombstoneFn must return the first tombstone id");

    // Read the tombstone store directly to count entries.
    const store = (storage as any).tombstoneStore ?? await (storage as any).getTombstoneStore();
    const all = store.snapshot?.() ?? store.all?.() ?? [];
    const matching = Array.isArray(all)
      ? all.filter((t: any) => t?.sourceMemoryId === "fact-structured")
      : [];
    assert.equal(matching.length, keys.length,
      `emitted ${matching.length} tombstones, expected ${keys.length} (one per supersession key)`);
    for (const t of matching) {
      assert.equal(t.contentHash, "canonical-hash-abc",
        "every per-key tombstone must carry the canonical contentHash (exact tier)");
    }
    const tombKeys = matching.map((t: any) => t.supersessionKey).sort();
    assert.deepEqual(tombKeys, [...keys].sort(),
      "the emitted supersession keys must cover every derived key");
  } finally {
    await cleanup();
  }
});

test("#1672 item 4: appendTombstoneFn falls back to a single tombstone when no keys are derived", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    const wiring = { orchestrator: { getStorage: async () => storage } } as any;
    const firstId = await appendTombstoneFn(wiring, "default", {
      reason: "retraction",
      sourceMemoryId: "fact-plain",
      rawContent: "a plain unstructured fact",
      contentHash: "plain-hash",
    });
    assert.ok(firstId, "a content-only tombstone must still be emitted");
    const store = (storage as any).tombstoneStore ?? await (storage as any).getTombstoneStore();
    const all = store.snapshot?.() ?? store.all?.() ?? [];
    const matching = Array.isArray(all)
      ? all.filter((t: any) => t?.sourceMemoryId === "fact-plain")
      : [];
    assert.equal(matching.length, 1, "exactly one tombstone when no supersession keys");
    assert.equal(matching[0].contentHash, "plain-hash");
  } finally {
    await cleanup();
  }
});
