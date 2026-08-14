import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { StorageManager } from "../index.js";
import type { MemoryFile } from "../types.js";
import { computeSupportPassportOwnerKey, projectSupportPassportCard } from "./card-projection.js";
import { SupportPassportGrantService } from "./grant-service.js";
import type { SupportPassportGrantStore } from "./grant-store.js";

test("grant creation checks cancellation again before commit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-cancel-"));
  try {
    await mkdir(path.join(root, "state"), { recursive: true });
    const memory = {
      path: path.join(root, "preferences", "support-card.md"),
      content: "Offer me a quiet place and time.",
      frontmatter: {
        id: "support-card-1",
        category: "preference",
        source: "support-passport",
        confidence: 1,
        confidenceTier: "explicit",
        created: "2026-08-11T12:00:00.000Z",
        updated: "2026-08-11T12:00:00.000Z",
        status: "active",
        tags: ["support-passport-card"],
        structuredAttributes: {
          "support-passport-namespace": "alice",
          "support-passport-owner": computeSupportPassportOwnerKey("owner:alice"),
          "support-passport-title": "Quiet space",
          "support-passport-category": "environment",
          "support-passport-order": "0",
          "support-passport-review-by": "2026-09-01T12:00:00.000Z",
          "support-passport-source-ids": "source-1",
        },
      },
    } as MemoryFile;
    const projected = projectSupportPassportCard(memory);
    assert.ok(projected);
    const storage = {
      dir: root,
      readAllMemories: async () => [memory],
      getCorpusScanVersion: () => 1,
      hotCacheKeyId: () => "owner-cache",
    } as unknown as StorageManager;
    const controller = new AbortController();
    let committed = false;
    const grantStore = {
      create: async (_input: unknown, hooks: { beforeCommit?: () => Promise<void> }) => {
        controller.abort();
        await hooks.beforeCommit?.();
        committed = true;
        throw new Error("commit should not run");
      },
    } as unknown as SupportPassportGrantStore;
    const service = new SupportPassportGrantService({
      grantStore,
      resolveOwner: async (principal) => ({ principal, namespace: "alice", storage }),
      resolveNamespace: async () => storage,
      now: () => new Date("2026-08-11T12:00:00.000Z"),
    });

    await assert.rejects(
      service.createGrant(
        {
          principal: "owner:alice",
          cards: [{ cardId: projected.card.cardId, revision: projected.card.revision }],
          expiresAt: "2026-08-11T13:00:00.000Z",
        },
        { signal: controller.signal }
      ),
      (error: unknown) => error instanceof Error && error.name === "AbortError"
    );
    assert.equal(committed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
