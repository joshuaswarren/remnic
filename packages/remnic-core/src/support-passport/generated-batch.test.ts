import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { StorageManager } from "../storage.js";
import { SupportPassportCardService } from "./card-service.js";
import { SupportPassportError } from "./errors.js";

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
