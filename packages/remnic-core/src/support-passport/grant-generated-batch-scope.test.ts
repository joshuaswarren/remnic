import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { StorageManager } from "../storage.js";
import { SUPPORT_PASSPORT_ATTRIBUTE_KEYS, computeSupportPassportOwnerKey } from "./card-projection.js";
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

test("a removed generated batch marker invalidates a cached grant snapshot", async () => {
  StorageManager.clearAllStaticCaches();
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-batch-cache-"));
  try {
    const storage = new StorageManager(path.join(root, "owner"));
    await storage.ensureDirectories();
    const now = () => new Date("2026-08-13T12:00:00.000Z");
    const resolveOwner = async (principal: string) => ({ principal, namespace: "owner", storage });
    const cardService = new SupportPassportCardService({ resolveOwner, now });
    const grantStore = new SupportPassportGrantStore({ memoryDir: path.join(root, "grants"), now });
    const grantService = new SupportPassportGrantService({
      grantStore,
      resolveOwner,
      resolveNamespace: async () => storage,
      now,
    });
    const [draft] = await cardService.createGeneratedDrafts({
      principal: "owner:alice",
      cards: [{
        title: "Time to answer",
        statement: "Give me time to answer.",
        category: "communication",
        sourceMemoryIds: ["source-1"],
      }],
    });
    assert.ok(draft);
    const card = await cardService.approveCard({
      principal: "owner:alice",
      cardId: draft.cardId,
      expectedRevision: draft.revision,
    });
    const grant = await grantService.createGrant({
      principal: "owner:alice",
      cards: [{ cardId: card.cardId, revision: card.revision }],
      expiresAt: "2026-08-13T13:00:00.000Z",
    });
    await grantService.readGrant({ grantId: grant.grant.grantId, secret: grant.secret });

    const memory = await storage.getMemoryById(card.cardId);
    const batchId = memory?.frontmatter.structuredAttributes?.[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.generatedBatchId];
    assert.ok(batchId);
    await unlink(path.join(storage.dir, "state", "support-passport", "generated-batches", `${batchId}.json`));

    await assert.rejects(
      grantService.readGrant({ grantId: grant.grant.grantId, secret: grant.secret }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "grant_stale",
    );
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(root, { recursive: true, force: true });
  }
});

test("a completed generated batch invalidates a cached omission", async () => {
  StorageManager.clearAllStaticCaches();
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-grant-batch-complete-"));
  try {
    const storage = new StorageManager(path.join(root, "owner"));
    await storage.ensureDirectories();
    const now = () => new Date("2026-08-13T12:00:00.000Z");
    const principal = "owner:alice";
    const resolveOwner = async () => ({ principal, namespace: "owner", storage });
    const cardService = new SupportPassportCardService({ resolveOwner, now });
    const [draft] = await cardService.createGeneratedDrafts({
      principal,
      cards: [{
        title: "Time to answer",
        statement: "Give me time to answer.",
        category: "communication",
        sourceMemoryIds: ["source-1"],
      }],
    });
    assert.ok(draft);
    const card = await cardService.approveCard({
      principal,
      cardId: draft.cardId,
      expectedRevision: draft.revision,
    });
    const memory = await storage.getMemoryById(card.cardId);
    const batchId = memory?.frontmatter.structuredAttributes?.[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.generatedBatchId];
    assert.ok(batchId);
    const markerPath = path.join(storage.dir, "state", "support-passport", "generated-batches", `${batchId}.json`);
    const completeMarker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
    await writeFile(markerPath, `${JSON.stringify({ ...completeMarker, complete: false })}\n`, "utf8");
    const service = new SupportPassportGrantService({
      grantStore: {} as SupportPassportGrantStore,
      resolveOwner,
      resolveNamespace: async () => storage,
      now,
    });
    const inspected = service as unknown as {
      readStoredCardSnapshot(
        target: StorageManager,
        namespace: string,
        ownerKey: string,
      ): Promise<{ cardsById: ReadonlyMap<string, unknown> }>;
    };
    const ownerKey = computeSupportPassportOwnerKey(principal);

    assert.equal((await inspected.readStoredCardSnapshot(storage, "owner", ownerKey)).cardsById.size, 0);
    await writeFile(markerPath, `${JSON.stringify(completeMarker)}\n`, "utf8");

    assert.equal((await inspected.readStoredCardSnapshot(storage, "owner", ownerKey)).cardsById.size, 1);
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(root, { recursive: true, force: true });
  }
});
