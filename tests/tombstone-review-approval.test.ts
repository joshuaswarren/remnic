/**
 * Tombstone review-approval round-trip — issue #1579 PR 3 (review threads
 * Obb-C / Oblq_ / ObnTy / ObNtM / ObNtN).
 *
 * A tombstone-blocked fact MUST be:
 *   1. Visible in the review queue regardless of confidence (rule 34).
 *   2. Promotable to `status: active` on approval (thread ObNtM).
 *   3. Accompanied by a tombstone revocation so the content is re-allowed
 *      (thread Obb-C — the approval hook fires revokeTombstone).
 *   4. Re-registered in the dedup hash index so a later extraction of the same
 *      content does not create a second active fact (thread ObnTy).
 */
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { StorageManager } from "../packages/remnic-core/src/storage.ts";
import { listReviewItems, performReview } from "../packages/remnic-core/src/review/index.ts";

const NAMESPACE = "test";

async function makeStorage(): Promise<{ storage: StorageManager; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-tombstone-review-"));
  const storage = new StorageManager(dir);
  await storage.ensureDirectories();
  storage.setTombstonesConfig({
    enabled: true,
    semanticMatch: false,
    semanticThreshold: 0.9,
    namespace: NAMESPACE,
  });
  return { storage, dir };
}

test("#1579 review: a tombstone-blocked high-confidence fact is a review candidate", async () => {
  const { storage, dir } = await makeStorage();
  try {
    const content = "High-confidence fact that was corrected";
    await storage.appendTombstone({
      reason: "correction",
      createdBy: "user_correction",
      sourceMemoryId: "fact-old",
      rawContent: content,
    });
    // writeMemory defaults confidence to 0.8 — above the review module's 0.7
    // threshold. Without the tombstone_blocked inclusion it would be invisible.
    const { id: id } = await storage.writeMemory("fact", content, { source: "extraction" });
    const items = listReviewItems({ memoryDir: dir });
    const match = items.items.find((i) => i.id === id);
    assert.ok(match, "tombstone-blocked fact must appear in the review queue");
    assert.equal(match!.reviewReason, "tombstone_blocked");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#1579 review: approving a blocked fact revokes the tombstone and restores the hash", async () => {
  const { storage, dir } = await makeStorage();
  try {
    const content = "The deploy target is production-us-east";
    const tombstoneId = await storage.appendTombstone({
      reason: "supersession",
      createdBy: "supersession",
      sourceMemoryId: "fact-deploy-old",
      rawContent: content,
    });
    assert.ok(tombstoneId, "tombstone append must succeed when enabled");

    const { id: id } = await storage.writeMemory("fact", content, { source: "extraction" });
    // It landed blocked.
    let all = await storage.readAllMemories();
    let blocked = all.find((m) => m.frontmatter.id === id)!;
    assert.equal(blocked.frontmatter.status, "pending_review");
    assert.equal(blocked.frontmatter.blockedBy, tombstoneId);

    // Approve through the review module with the revocation + hash-restore hooks
    // wired exactly as the CLI does (cmdReview).
    const result = performReview(dir, id, "approve", {
      onApproveBlockedMemory: (tid) => {
        void storage.revokeTombstone(tid, "user_correction").catch(() => undefined);
      },
    });
    assert.equal(result.clearedTombstoneId, tombstoneId, "approval reports the cleared tombstone");

    // Await the revocation (the CLI awaits it before exit).
    await storage.revokeTombstone(tombstoneId, "user_correction");

    // The promoted fact is now active (thread ObNtM).
    all = await storage.readAllMemories();
    const promoted = all.find((m) => m.frontmatter.id === id)!;
    assert.equal(promoted.frontmatter.status, "active", "approved fact must be active");
    assert.ok(!promoted.frontmatter.blockedBy, "blockedBy must be cleared");

    // Re-register the hash (thread ObnTy).
    await storage.restoreFactHashAfterApproval(id);

    // The tombstone is revoked: a fresh write of the same content is NOT blocked.
    const { id: id2 } = await storage.writeMemory("fact", content, { source: "extraction" });
    all = await storage.readAllMemories();
    const fresh = all.find((m) => m.frontmatter.id === id2)!;
    assert.equal(
      fresh.frontmatter.status,
      "active",
      "revoked tombstone must not block the re-allowed content",
    );
    assert.ok(!fresh.frontmatter.blockedBy);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
