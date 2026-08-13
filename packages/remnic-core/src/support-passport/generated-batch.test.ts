import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { StorageManager } from "../storage.js";
import type { StoredSupportPassportCard } from "./card-projection.js";
import { computeSupportPassportOwnerKey } from "./card-projection.js";
import { SupportPassportCardService } from "./card-service.js";
import { SupportPassportError } from "./errors.js";
import { commitSupportPassportGeneratedBatch, persistSupportPassportGeneratedBatchMarker } from "./generated-batch.js";

test("a visible generated batch marker does not hide its durability error", async () => {
  StorageManager.clearAllStaticCaches();
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-passport-batch-durability-"));
  const storage = new StorageManager(path.join(root, "shared"));
  await storage.ensureDirectories();
  const principal = "owner:alice";
  const namespace = "team";
  const context = {
    storage,
    principal,
    namespace,
    now: () => new Date("2026-08-13T12:00:00.000Z"),
    requireOwnerLock: async () => undefined,
  };
  const batchId = "00000000-0000-4000-8000-000000000001";

  try {
    const marker = await persistSupportPassportGeneratedBatchMarker(context, batchId, 1);
    const markerPath = path.join(storage.dir, "state", "support-passport", "generated-batches", `${batchId}.json`);
    const card = {
      namespace,
      owner: computeSupportPassportOwnerKey(principal),
      generatedBatchId: batchId,
      generatedBatchSize: 1,
      card: { cardId: "00000000-0000-4000-8000-000000000002", status: "pending_review" },
    } as StoredSupportPassportCard;
    const durabilityError = Object.assign(new Error("simulated directory sync failure"), { code: "EIO" });

    await assert.rejects(
      commitSupportPassportGeneratedBatch(context, marker, [card], async (_storage, committed) => {
        await writeFile(markerPath, `${JSON.stringify(committed)}\n`, "utf8");
        throw durabilityError;
      }),
      durabilityError
    );
    assert.equal((JSON.parse(await readFile(markerPath, "utf8")) as { complete: boolean }).complete, true);
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(root, { recursive: true, force: true });
  }
});

test("generated batch recovery reads only markers referenced by the requested owner", async () => {
  StorageManager.clearAllStaticCaches();
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-passport-batches-"));
  const storage = new StorageManager(path.join(root, "shared"));
  await storage.ensureDirectories();
  const service = new SupportPassportCardService({
    resolveOwner: async (principal) => ({ principal, namespace: "team", storage }),
  });

  try {
    const cards = new Map<string, Awaited<ReturnType<typeof service.createGeneratedDrafts>>>();
    for (const principal of ["owner:alice", "owner:bob"]) {
      cards.set(
        principal,
        await service.createGeneratedDrafts({
          principal,
          cards: [
            {
              title: `${principal} support`,
              statement: "Give me time to answer.",
              category: "communication",
              sourceMemoryIds: ["source-1"],
            },
          ],
        })
      );
    }

    const markerRoot = path.join(storage.dir, "state", "support-passport", "generated-batches");
    const [bobCard] = cards.get("owner:bob") ?? [];
    assert.ok(bobCard);
    const bobMemory = await storage.getMemoryById(bobCard.cardId);
    const bobBatchId = bobMemory?.frontmatter.structuredAttributes?.["support-passport-generated-batch-id"];
    assert.ok(bobBatchId);
    const bobMarkerPath = path.join(markerRoot, `${bobBatchId}.json`);
    await writeFile(bobMarkerPath, "not-json\n", "utf8");

    assert.equal((await service.listCards({ principal: "owner:alice" })).length, 1);
    await assert.rejects(
      service.listCards({ principal: "owner:bob" }),
      (error: unknown) => error instanceof SupportPassportError && error.code === "card_data_invalid"
    );
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(root, { recursive: true, force: true });
  }
});
