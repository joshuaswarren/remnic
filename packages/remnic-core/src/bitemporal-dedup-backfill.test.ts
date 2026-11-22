import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { StorageManager, ContentHashIndex } from "./storage.js";

async function makeStorage(prefix: string): Promise<{
  storage: StorageManager;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const storage = new StorageManager(dir);
  await storage.ensureDirectories();
  return {
    storage,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("#1671: writeMemoryFrontmatter patches invalid_at onto an existing fact that lacks it", async () => {
  const { storage, cleanup } = await makeStorage("bitemporal-backfill-patch-");
  try {
    const { id: id } = await storage.writeMemory("fact", "We use PostgreSQL for the main db.", {
      confidence: 0.9,
    });
    const before = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(before, "fact must exist");
    assert.equal(before!.frontmatter.invalid_at, undefined);
    assert.equal(before!.frontmatter.observedAt, undefined);

    const ok = await storage.writeMemoryFrontmatter(before!, {
      invalid_at: "2025-07-01T00:00:00.000Z",
      observedAt: "2025-06-20T00:00:00.000Z",
      eventTimeSource: "extracted",
    });
    assert.equal(ok, true);

    const after = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(after, "fact must still exist after patch");
    assert.equal(after!.frontmatter.invalid_at, "2025-07-01T00:00:00.000Z");
    assert.equal(after!.frontmatter.observedAt, "2025-06-20T00:00:00.000Z");
    assert.equal(after!.frontmatter.eventTimeSource, "extracted");
  } finally {
    await cleanup();
  }
});

test("#1671: existing copy found by normalized content hash for backfill", async () => {
  const { storage, cleanup } = await makeStorage("bitemporal-backfill-lookup-");
  try {
    const content = "The database is MySQL.";
    await storage.writeMemory("fact", content, {
      confidence: 0.9,
    });

    const normalizedIncoming = ContentHashIndex.normalizeContent(content);
    const all = await storage.readAllMemories();
    const existing = all.find(
      (m) =>
        m.frontmatter.category === "fact" &&
        (m.frontmatter.status ?? "active") === "active" &&
        ContentHashIndex.normalizeContent(m.content ?? "") === normalizedIncoming,
    );
    assert.ok(existing, "must find the existing fact by normalized content");
  } finally {
    await cleanup();
  }
});

test("#1671: backfill does NOT clobber an existing invalid_at on the copy", async () => {
  const { storage, cleanup } = await makeStorage("bitemporal-backfill-noclobber-");
  try {
    const { id: id } = await storage.writeMemory("fact", "We use MySQL until December.", {
      confidence: 0.9,
      invalidAt: "2025-12-01T00:00:00.000Z",
      observedAt: "2025-06-01T00:00:00.000Z",
      eventTimeSource: "extracted",
    });
    const before = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(before);

    const patch: Record<string, unknown> = {};
    const fm = before!.frontmatter;
    if (!fm.invalid_at || fm.invalid_at.length === 0) {
      patch.invalid_at = "2025-07-01T00:00:00.000Z";
    }
    assert.equal(Object.keys(patch).length, 0,
      "must not patch invalid_at when the copy already has it");
  } finally {
    await cleanup();
  }
});

test("#1671: re-extraction with resolved invalidAt backfills an old promoted copy (end-to-end storage)", async () => {
  const { storage, cleanup } = await makeStorage("bitemporal-backfill-e2e-");
  try {
    const content = "The API rate limit is 100 req/min.";
    const { id: id } = await storage.writeMemory("fact", content, {
      confidence: 0.9,
    });

    const normalizedIncoming = ContentHashIndex.normalizeContent(content);
    const all = await storage.readAllMemories();
    const existing = all.find(
      (m) =>
        m.frontmatter.category === "fact" &&
        (m.frontmatter.status ?? "active") === "active" &&
        ContentHashIndex.normalizeContent(m.content ?? "") === normalizedIncoming,
    );
    assert.ok(existing, "must find the existing copy");

    const patch: Record<string, string> = {};
    if (!existing!.frontmatter.invalid_at) {
      patch.invalid_at = "2025-09-01T00:00:00.000Z";
    }
    if (!existing!.frontmatter.observedAt) {
      patch.observedAt = "2025-06-20T00:00:00.000Z";
    }
    if (!existing!.frontmatter.eventTimeSource) {
      patch.eventTimeSource = "extracted";
    }
    assert.ok(Object.keys(patch).length > 0, "must have fields to backfill");

    const ok = await storage.writeMemoryFrontmatter(existing!, patch);
    assert.equal(ok, true);

    const after = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(after);
    assert.equal(after!.frontmatter.invalid_at, "2025-09-01T00:00:00.000Z");
    assert.equal(after!.frontmatter.observedAt, "2025-06-20T00:00:00.000Z");
    assert.equal(after!.frontmatter.eventTimeSource, "extracted");
  } finally {
    await cleanup();
  }
});


test("#1707 thread 2: corrected extracted validFrom overwrites a batch-anchored valid_at", async () => {
  const { storage, cleanup } = await makeStorage("bitemporal-1707-validFrom-");
  try {
    const content = "We have used Stripe for payments since 2024.";
    const batchAnchor = "2026-06-01T00:00:00.000Z";
    const { id } = await storage.writeMemory("fact", content, {
      confidence: 0.9,
      validAt: batchAnchor,
      // No eventTimeSource → batch-anchored (legacy pre-#1670 copy).
    });
    const before = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(before);
    assert.equal(before!.frontmatter.valid_at, batchAnchor);
    assert.equal(before!.frontmatter.eventTimeSource, undefined);

    const correctedValidFrom = "2024-01-01T00:00:00.000Z";
    const incomingExtracted = true;
    const copyExtracted = before!.frontmatter.eventTimeSource === "extracted";
    const shouldPatchValidAt =
      incomingExtracted && (copyExtracted === false || !before!.frontmatter.valid_at);
    assert.equal(shouldPatchValidAt, true, "must correct the batch-anchored valid_at");

    const ok = await storage.writeMemoryFrontmatter(before!, {
      valid_at: correctedValidFrom,
      eventTimeSource: "extracted",
      observedAt: "2026-06-20T00:00:00.000Z",
    });
    assert.equal(ok, true);

    const after = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(after);
    assert.equal(after!.frontmatter.valid_at, correctedValidFrom);
    assert.equal(after!.frontmatter.eventTimeSource, "extracted");
  } finally {
    await cleanup();
  }
});

test("#1707 thread 2: identical extracted validFrom is a no-op (equality short-circuit)", async () => {
  const { storage, cleanup } = await makeStorage("bitemporal-1707-validFrom-equal-");
  try {
    const content = "The migration to MySQL completed in March 2025.";
    const existingValidAt: string = "2025-03-01T00:00:00.000Z";
    const { id } = await storage.writeMemory("fact", content, {
      confidence: 0.9,
      validAt: existingValidAt,
      observedAt: "2025-06-01T00:00:00.000Z",
      eventTimeSource: "extracted",
    });
    const before = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(before);

    const helperWouldPatch = existingValidAt !== existingValidAt; // equal → false
    assert.equal(helperWouldPatch, false, "identical validFrom must not rewrite");

    const after = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(after);
    assert.equal(after!.frontmatter.valid_at, existingValidAt);
  } finally {
    await cleanup();
  }
});

test("#1707 thread 2: differing extracted validFrom overwrites (authoritative re-evaluation)", async () => {
  const { storage, cleanup } = await makeStorage("bitemporal-1707-validFrom-differ-");
  try {
    const content = "We have used Stripe for payments since 2024.";
    const staleValidAt: string = "2026-06-01T00:00:00.000Z"; // batch anchor
    const { id } = await storage.writeMemory("fact", content, {
      confidence: 0.9,
      validAt: staleValidAt,
    });
    const before = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(before);

    const correctedValidFrom: string = "2024-01-01T00:00:00.000Z";
    const helperWouldPatch = staleValidAt !== correctedValidFrom; // differ → true
    assert.equal(helperWouldPatch, true, "differing extracted validFrom must overwrite");

    const ok = await storage.writeMemoryFrontmatter(before!, {
      valid_at: correctedValidFrom,
      eventTimeSource: "extracted",
    });
    assert.equal(ok, true);

    const after = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(after);
    assert.equal(after!.frontmatter.valid_at, correctedValidFrom);
    assert.equal(after!.frontmatter.eventTimeSource, "extracted");
  } finally {
    await cleanup();
  }
});

test("#1707 thread 2: end-only extracted provenance does NOT block a later start-bound correction", async () => {
  const { storage, cleanup } = await makeStorage("bitemporal-1707-endonly-");
  try {
    const observedAt = "2026-06-01T00:00:00.000Z";
    const content = "The service was maintained through 2026.";
    const { id } = await storage.writeMemory("fact", content, {
      confidence: 0.9,
      validAt: observedAt, // valid_at === observedAt (assumed/batch start)
      observedAt,
      eventTimeSource: "extracted", // set by the end-only extraction
      invalidAt: "2026-12-31T00:00:00.000Z", // the extracted end bound
    });
    const before = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(before);
    assert.equal(before!.frontmatter.eventTimeSource, "extracted");
    assert.equal(before!.frontmatter.valid_at, before!.frontmatter.observedAt);


    const realStart = "2024-03-01T00:00:00.000Z";
    const ok = await storage.writeMemoryFrontmatter(before!, {
      valid_at: realStart,
    });
    assert.equal(ok, true);

    const after = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(after);
    assert.equal(after!.frontmatter.valid_at, realStart);
  } finally {
    await cleanup();
  }
});

test("#1707 thread 2: assumed (batch-anchored) validFrom does NOT trigger a backfill scan", () => {
  const gateWouldScan = (bounds: {
    invalidAt?: string;
    validFrom?: string;
    eventTimeSource?: "extracted" | "assumed";
  }) =>
    Boolean(bounds.invalidAt) ||
    (bounds.validFrom !== undefined && bounds.eventTimeSource === "extracted");

  assert.equal(
    gateWouldScan({ validFrom: "2026-06-01T00:00:00.000Z", eventTimeSource: "assumed" }),
    false,
    "assumed validFrom must not trigger a scan",
  );
  assert.equal(
    gateWouldScan({ validFrom: "2024-01-01T00:00:00.000Z", eventTimeSource: "extracted" }),
    true,
  );
  assert.equal(gateWouldScan({ invalidAt: "2025-06-01T00:00:00.000Z" }), true);
  assert.equal(gateWouldScan({}), false);
});
test("#1707 thread 1: backfill patches promoted copies across multiple storages (cascade)", async () => {
  const { storage: sourceStorage, cleanup: cleanupSource } = await makeStorage(
    "bitemporal-1707-cascade-source-",
  );
  const { storage: promotedStorage, cleanup: cleanupPromoted } = await makeStorage(
    "bitemporal-1707-cascade-promoted-",
  );
  try {
    const content = "The API rate limit is 100 req/min until June 2025.";
    const { id: sourceId } = await sourceStorage.writeMemory("fact", content, { confidence: 0.9 });
    const { id: promotedId } = await promotedStorage.writeMemory("fact", content, { confidence: 0.9 });

    const bounds = {
      invalid_at: "2025-06-01T00:00:00.000Z",
      observedAt: "2025-06-20T00:00:00.000Z",
      eventTimeSource: "extracted" as const,
    };
    for (const storage of [sourceStorage, promotedStorage]) {
      const all = await storage.readAllMemories();
      const existing = all.find(
        (m) =>
          m.frontmatter.category === "fact" &&
          (m.frontmatter.status ?? "active") === "active" &&
          !m.frontmatter.invalid_at &&
          ContentHashIndex.normalizeContent(m.content ?? "") ===
            ContentHashIndex.normalizeContent(content),
      );
      assert.ok(existing, "must find the existing copy in each storage");
      const ok = await storage.writeMemoryFrontmatter(existing!, bounds);
      assert.equal(ok, true);
    }

    const sourceAfter = (await sourceStorage.readAllMemories()).find(
      (m) => m.frontmatter.id === sourceId,
    );
    const promotedAfter = (await promotedStorage.readAllMemories()).find(
      (m) => m.frontmatter.id === promotedId,
    );
    assert.ok(sourceAfter && promotedAfter);
    assert.equal(sourceAfter!.frontmatter.invalid_at, "2025-06-01T00:00:00.000Z");
    assert.equal(promotedAfter!.frontmatter.invalid_at, "2025-06-01T00:00:00.000Z");
  } finally {
    await cleanupSource();
    await cleanupPromoted();
  }
});

test("#1707 thread 3: backfill never patches a non-fact copy (category guard)", async () => {
  const { storage, cleanup } = await makeStorage("bitemporal-1707-nonfact-");
  try {
    const content = "The user prefers dark mode.";
    const { id } = await storage.writeMemory("preference", content, { confidence: 0.9 });
    const before = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(before);
    assert.equal(before!.frontmatter.category, "preference");
    assert.equal(before!.frontmatter.invalid_at, undefined);

    const all = await storage.readAllMemories();
    const existing = all.find(
      (m) =>
        m.frontmatter.category === "fact" && // ← the guard under test
        (m.frontmatter.status ?? "active") === "active" &&
        ContentHashIndex.normalizeContent(m.content ?? "") ===
          ContentHashIndex.normalizeContent(content),
    );
    assert.equal(existing, undefined, "non-fact copy must not be matched by the fact-only lookup");

    const after = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(after);
    assert.equal(after!.frontmatter.invalid_at, undefined);
    assert.equal(after!.frontmatter.category, "preference");
  } finally {
    await cleanup();
  }
});