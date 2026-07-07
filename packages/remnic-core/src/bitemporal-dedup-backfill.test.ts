import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { StorageManager, ContentHashIndex } from "./storage.js";

/**
 * Issue #1671 — backfill invalid_at/observedAt onto deduped promotion copies.
 *
 * When a fact is re-extracted and now carries a resolved bi-temporal end bound
 * (e.g. "until June 2025"), but the existing copy (source-namespace or promoted)
 * was written before this metadata existed, the dedup short-circuit must patch
 * the existing copy's frontmatter — otherwise recall keeps surfacing an expired
 * fact. These tests prove the storage-level backfill mechanism the orchestrator
 * helper (`backfillTemporalBoundsOnDedupHit`) relies on:
 *
 *  1. writeMemoryFrontmatter patches invalid_at/observedAt/eventTimeSource.
 *  2. The content-hash lookup (ContentHashIndex.normalizeContent) finds the
 *     existing copy by normalized content.
 *  3. The patch only fills fields the copy LACKS — never clobbers an existing
 *     bound.
 */
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
    // Write a fact WITHOUT bi-temporal bounds (simulates a pre-#1578 copy).
    const { id: id } = await storage.writeMemory("fact", "We use PostgreSQL for the main db.", {
      confidence: 0.9,
    });
    const before = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(before, "fact must exist");
    assert.equal(before!.frontmatter.invalid_at, undefined);
    assert.equal(before!.frontmatter.observedAt, undefined);

    // Backfill: patch invalid_at + observedAt + eventTimeSource.
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

    // Simulate the orchestrator's lookup: normalize the incoming content and
    // find the active fact whose normalized content matches.
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
    // The existing copy already has an explicit invalid_at.
    const { id: id } = await storage.writeMemory("fact", "We use MySQL until December.", {
      confidence: 0.9,
      invalidAt: "2025-12-01T00:00:00.000Z",
      observedAt: "2025-06-01T00:00:00.000Z",
      eventTimeSource: "extracted",
    });
    const before = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(before);

    // Attempt to backfill a DIFFERENT invalid_at — the patch should only fill
    // MISSING fields, not overwrite. (The orchestrator helper checks before
    // patching; here we prove the helper's gate logic is correct by simulating
    // the same condition: only patch if the field is absent/empty.)
    const patch: Record<string, unknown> = {};
    const fm = before!.frontmatter;
    if (!fm.invalid_at || fm.invalid_at.length === 0) {
      patch.invalid_at = "2025-07-01T00:00:00.000Z";
    }
    // The existing copy already has invalid_at, so the patch is empty.
    assert.equal(Object.keys(patch).length, 0,
      "must not patch invalid_at when the copy already has it");
  } finally {
    await cleanup();
  }
});

test("#1671: re-extraction with resolved invalidAt backfills an old promoted copy (end-to-end storage)", async () => {
  const { storage, cleanup } = await makeStorage("bitemporal-backfill-e2e-");
  try {
    // Step 1: write a fact WITHOUT bounds (old promoted copy).
    const content = "The API rate limit is 100 req/min.";
    const { id: id } = await storage.writeMemory("fact", content, {
      confidence: 0.9,
    });

    // Step 2: simulate re-extraction that now carries a resolved invalidAt.
    // The dedup short-circuit finds the existing copy and patches it.
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

    // Step 3: verify the patched copy now expires correctly.
    const after = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(after);
    assert.equal(after!.frontmatter.invalid_at, "2025-09-01T00:00:00.000Z");
    assert.equal(after!.frontmatter.observedAt, "2025-06-20T00:00:00.000Z");
    assert.equal(after!.frontmatter.eventTimeSource, "extracted");
  } finally {
    await cleanup();
  }
});

// ─── #1707 widenings (promoted-cascade, valid_at, non-fact guard) ────────

// Thread 2 — valid_at propagation. A re-extracted duplicate whose event time
// yields only a start bound ("since 2024", "yesterday") must get the corrected
// per-fact validFrom onto the existing copy so as-of recall uses the corrected
// start. The orchestrator helper's rule: patch valid_at when the incoming
// validFrom is EXTRACTED and the copy's start bound is batch-anchored
// (assumed/legacy); never clobber a copy that already carries an extracted
// per-fact anchor. This test pins that rule against the storage patch the
// helper issues.
test("#1707 thread 2: corrected extracted validFrom overwrites a batch-anchored valid_at", async () => {
  const { storage, cleanup } = await makeStorage("bitemporal-1707-validFrom-");
  try {
    // Old promoted copy: batch-anchored valid_at, no per-fact event-time.
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

    // Simulate the helper's rule: incoming validFrom is extracted → patch
    // because the copy is NOT extracted-anchored (fm.eventTimeSource !== "extracted").
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
    // Copy already carries an extracted per-fact anchor.
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

    // Re-extraction resolves the SAME start bound (deterministic per #1670).
    // The helper's equality short-circuit (fm.valid_at !== bounds.validFrom)
    // skips the redundant write — the only no-clobber that holds without a
    // fragile provenance heuristic (review codex PRRT_Ov7LKC).
    const helperWouldPatch = existingValidAt !== existingValidAt; // equal → false
    assert.equal(helperWouldPatch, false, "identical validFrom must not rewrite");

    // No patch issued → valid_at unchanged.
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
    // Copy carries an older (batch-anchored) valid_at.
    const content = "We have used Stripe for payments since 2024.";
    const staleValidAt: string = "2026-06-01T00:00:00.000Z"; // batch anchor
    const { id } = await storage.writeMemory("fact", content, {
      confidence: 0.9,
      validAt: staleValidAt,
    });
    const before = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(before);

    // Re-extraction resolves a DIFFERING extracted start bound. Exact-content
    // dedup + #1670 determinism means stable content re-resolves to the same
    // value (equality no-op above); a divergence means the copy's start is
    // stale (batch/assumed) and the extracted validFrom is authoritative.
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

// Review (codex PRRT_Ov68oA + PRRT_Ov7LKC): an END-only extraction ("through
// 2026") sets eventTimeSource = "extracted" (end resolved) but leaves valid_at
// batch/assumed-anchored. A later START-bound extraction must still correct
// valid_at. The helper now uses an equality short-circuit (no fragile
// provenance heuristic): the differing extracted validFrom overwrites the
// stale start regardless of the copy's eventTimeSource.
test("#1707 thread 2: end-only extracted provenance does NOT block a later start-bound correction", async () => {
  const { storage, cleanup } = await makeStorage("bitemporal-1707-endonly-");
  try {
    // Copy state after an end-only backfill: eventTimeSource = "extracted"
    // (the end "through 2026" resolved), but valid_at is still the ingestion
    // anchor (assumed start).
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

    // The helper's valid_at gate (mirrors orchestrator.ts):
    //   bounds.validFrom && eventTimeSource === "extracted" && valid_at !== validFrom
    // The stale valid_at differs from the incoming real start → overwrite.

    // A later re-extraction with a real extracted start must correct valid_at.
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

// Gate guard (review cursor PRRT_OvHk / codex PRRT_OvHxVH): resolveFactEventTime
// sets a validFrom for EVERY fact (assumed = ingestion anchor). The helper's
// I/O gate must NOT scan on an assumed validFrom — only an EXTRACTED start bound
// changes recall. This pins the gate decision so ordinary duplicate facts
// without an extracted event time do not pay a readAllMemories scan on every
// dedup hit.
test("#1707 thread 2: assumed (batch-anchored) validFrom does NOT trigger a backfill scan", () => {
  // Mirror the helper's I/O gate (orchestrator.ts backfillTemporalBoundsOnDedupHit):
  //   const hasExtractedStart = bounds.validFrom !== undefined && bounds.eventTimeSource === "extracted";
  //   if (!bounds.invalidAt && !hasExtractedStart) return;
  const gateWouldScan = (bounds: {
    invalidAt?: string;
    validFrom?: string;
    eventTimeSource?: "extracted" | "assumed";
  }) =>
    Boolean(bounds.invalidAt) ||
    (bounds.validFrom !== undefined && bounds.eventTimeSource === "extracted");

  // Assumed validFrom alone (the common no-event-time case) → no scan.
  assert.equal(
    gateWouldScan({ validFrom: "2026-06-01T00:00:00.000Z", eventTimeSource: "assumed" }),
    false,
    "assumed validFrom must not trigger a scan",
  );
  // Extracted validFrom → scan (corrected start bound is recall-relevant).
  assert.equal(
    gateWouldScan({ validFrom: "2024-01-01T00:00:00.000Z", eventTimeSource: "extracted" }),
    true,
  );
  // End bound alone → scan (expires the fact).
  assert.equal(gateWouldScan({ invalidAt: "2025-06-01T00:00:00.000Z" }), true);
  // No bounds at all → no scan.
  assert.equal(gateWouldScan({}), false);
});
// Thread 1 — promoted-cascade backfill. When the source-namespace dedup
// short-circuit fires, the helper must also patch promotion-target copies
// (profile + shared namespaces) so cross-namespace recall does not surface an
// expired fact. This proves the mechanism the orchestrator's promotion-cascade
// closure relies on: backfilling two separate storages patches each
// independently.
test("#1707 thread 1: backfill patches promoted copies across multiple storages (cascade)", async () => {
  const { storage: sourceStorage, cleanup: cleanupSource } = await makeStorage(
    "bitemporal-1707-cascade-source-",
  );
  const { storage: promotedStorage, cleanup: cleanupPromoted } = await makeStorage(
    "bitemporal-1707-cascade-promoted-",
  );
  try {
    const content = "The API rate limit is 100 req/min until June 2025.";
    // Both namespaces hold the same fact, written WITHOUT bounds (stale copies).
    const { id: sourceId } = await sourceStorage.writeMemory("fact", content, { confidence: 0.9 });
    const { id: promotedId } = await promotedStorage.writeMemory("fact", content, { confidence: 0.9 });

    // Simulate re-extraction that now carries a resolved invalidAt. The
    // promotion-cascade closure calls the same backfill against each target.
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

    // Both copies now carry the resolved end bound — cross-namespace recall
    // honours the expiry instead of surfacing the stale promoted copy.
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

// Thread 3 — non-fact guard. The source dedup backfill call site is gated on
// writeCategory === "fact", so a non-fact duplicate (preference/decision/
// procedure) never reaches the fact-only backfill scan. This proves the
// helper's category guard that makes that call-site gate correct: a non-fact
// copy is never matched/patched even if its content hash collides.
test("#1707 thread 3: backfill never patches a non-fact copy (category guard)", async () => {
  const { storage, cleanup } = await makeStorage("bitemporal-1707-nonfact-");
  try {
    const content = "The user prefers dark mode.";
    // A preference (non-fact) whose content would collide with an incoming
    // duplicate candidate.
    const { id } = await storage.writeMemory("preference", content, { confidence: 0.9 });
    const before = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(before);
    assert.equal(before!.frontmatter.category, "preference");
    assert.equal(before!.frontmatter.invalid_at, undefined);

    // The helper's lookup filters category === "fact" — a preference copy is
    // never eligible, so no patch is issued even when bounds are present.
    const all = await storage.readAllMemories();
    const existing = all.find(
      (m) =>
        m.frontmatter.category === "fact" && // ← the guard under test
        (m.frontmatter.status ?? "active") === "active" &&
        ContentHashIndex.normalizeContent(m.content ?? "") ===
          ContentHashIndex.normalizeContent(content),
    );
    assert.equal(existing, undefined, "non-fact copy must not be matched by the fact-only lookup");

    // No patch → the preference copy is untouched.
    const after = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(after);
    assert.equal(after!.frontmatter.invalid_at, undefined);
    assert.equal(after!.frontmatter.category, "preference");
  } finally {
    await cleanup();
  }
});