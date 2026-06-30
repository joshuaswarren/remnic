/**
 * NIBOi (codex P2): a consolidation pass that performs ONLY memory-item actions
 * (UPDATE / MERGE / INVALIDATE) — and produces no profile/entity updates — still
 * durably rewrites memory state, so it must refresh the namespace catalog's
 * `lastWriteAt`. Without the fix the touch gate only checked profile/entity
 * updates, leaving the default namespace's write recency stale after
 * consolidation-only mutations.
 */
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";

test("consolidation with only an INVALIDATE memory-item action records a catalog write touch", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-consolidate-catalog-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-consolidate-ws-"));
  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      topicExtractionEnabled: false,
      summarizationEnabled: false,
      identityEnabled: false,
      entitySummaryEnabled: false,
      namespacesEnabled: true,
      namespaceCatalogEnabled: true,
    });

    const orchestrator = new Orchestrator(config) as any;
    const storage = orchestrator.storage;

    // runConsolidation only runs with >= 5 memories. Seed a corpus, then have the
    // pass INVALIDATE one — a durable mutation with NO profile/entity updates.
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(await storage.writeMemory("fact", `seed fact ${i}`, { source: "test" }));
    }
    const staleId = ids[0];
    orchestrator.extraction = {
      consolidate: async () => ({
        items: [{ action: "INVALIDATE", existingId: staleId }],
        profileUpdates: [],
        entityUpdates: [],
      }),
    };

    // Establish the default namespace in the catalog so we can observe its
    // lastWriteAt advance (vs. an absent record).
    await orchestrator.namespaceCatalog.registerConfiguredNamespaces();
    const before = await orchestrator.namespaceCatalog.getNamespaceRecord(config.defaultNamespace);
    const beforeWriteAt = before?.lastWriteAt;

    await orchestrator.runConsolidationNow();

    // The catalog touch is best-effort/fire-and-forget; let its serialized write
    // chain settle, then read back the record.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = await orchestrator.namespaceCatalog.getNamespaceRecord(config.defaultNamespace);

    assert.ok(after, "default namespace record must exist after consolidation");
    assert.ok(
      after!.lastWriteAt,
      "consolidation-only memory-item mutation must record a catalog write touch",
    );
    if (beforeWriteAt) {
      assert.ok(
        new Date(after!.lastWriteAt!).getTime() >= new Date(beforeWriteAt).getTime(),
        "lastWriteAt must advance (or hold) after a consolidation memory-item mutation",
      );
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
