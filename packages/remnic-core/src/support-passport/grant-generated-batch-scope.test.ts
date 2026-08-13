import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { StorageManager } from "../storage.js";
import { SUPPORT_PASSPORT_ATTRIBUTE_KEYS } from "./card-projection.js";
import { SupportPassportCardService } from "./card-service.js";
import { SupportPassportError } from "./errors.js";
import { SupportPassportGrantService } from "./grant-service.js";
import { SupportPassportGrantStore } from "./grant-store.js";

test("grant reads do not open another owner's generated batch marker", async () => {
  StorageManager.clearAllStaticCaches();
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-batch-scope-"));
  try {
    const storage = new StorageManager(path.join(root, "shared"));
    await storage.ensureDirectories();
    const now = () => new Date("2026-08-13T12:00:00.000Z");
    const resolveOwner = async (principal: string) => ({ principal, namespace: "team", storage });
    const cardService = new SupportPassportCardService({ resolveOwner, now });
    const grantStore = new SupportPassportGrantStore({ memoryDir: path.join(root, "grants"), now });
    const grantService = new SupportPassportGrantService({
      grantStore,
      resolveOwner,
      resolveNamespace: async () => storage,
      now,
    });
    const cards = new Map<string, Awaited<ReturnType<typeof cardService.approveCard>>>();
    for (const principal of ["owner:alice", "owner:bob"]) {
      const [draft] = await cardService.createGeneratedDrafts({
        principal,
        cards: [{
          title: `${principal} support`,
          statement: "Give me time to answer.",
          category: "communication",
          sourceMemoryIds: ["source-1"],
        }],
      });
      assert.ok(draft);
      cards.set(principal, await cardService.approveCard({
        principal,
        cardId: draft.cardId,
        expectedRevision: draft.revision,
      }));
    }
    const grants = new Map<string, Awaited<ReturnType<typeof grantService.createGrant>>>();
    for (const principal of ["owner:alice", "owner:bob"]) {
      const card = cards.get(principal);
      assert.ok(card);
      grants.set(principal, await grantService.createGrant({
        principal,
        cards: [{ cardId: card.cardId, revision: card.revision }],
        expiresAt: "2026-08-13T13:00:00.000Z",
      }));
    }

    const bobCard = cards.get("owner:bob");
    assert.ok(bobCard);
    const bobMemory = await storage.getMemoryById(bobCard.cardId);
    const batchId = bobMemory?.frontmatter.structuredAttributes?.[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.generatedBatchId];
    assert.ok(batchId);
    await writeFile(
      path.join(storage.dir, "state", "support-passport", "generated-batches", `${batchId}.json`),
      "not-json\n",
      "utf8",
    );
    const freshService = new SupportPassportGrantService({
      grantStore,
      resolveOwner,
      resolveNamespace: async () => storage,
      now,
    });
    const aliceGrant = grants.get("owner:alice");
    const bobGrant = grants.get("owner:bob");
    assert.ok(aliceGrant);
    assert.ok(bobGrant);

    assert.equal(
      (await freshService.readGrant({ grantId: aliceGrant.grant.grantId, secret: aliceGrant.secret })).cards[0]?.cardId,
      cards.get("owner:alice")?.cardId,
    );
    await assert.rejects(
      freshService.readGrant({ grantId: bobGrant.grant.grantId, secret: bobGrant.secret }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "card_data_invalid",
    );
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(root, { recursive: true, force: true });
  }
});
