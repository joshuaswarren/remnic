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

// NIjwl (codex P2): a consolidation pass with NO LLM outputs (empty items /
// profile / entity) can still mutate the namespace via cleanup maintenance —
// e.g. cleanExpiredTTL deleting an expired memory. Those cleanup-only mutations
// run after the LLM-action block, so the catalog touch must be recorded after all
// mutation-producing maintenance steps, or lastWriteAt stays stale.
test("cleanup-only consolidation (TTL expiry, no LLM outputs) records a catalog write touch", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-consolidate-cleanup-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-consolidate-cleanup-ws-"));
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
      semanticConsolidationEnabled: false,
      factArchivalEnabled: false,
      lifecyclePolicyEnabled: false,
      namespacesEnabled: true,
      namespaceCatalogEnabled: true,
    });

    const orchestrator = new Orchestrator(config) as any;
    const storage = orchestrator.storage;

    // Seed 5 memories (the consolidation floor); one is already TTL-expired so the
    // cleanup step deletes it — a durable namespace mutation with NO LLM outputs.
    for (let i = 0; i < 4; i += 1) {
      await storage.writeMemory("fact", `keeper fact ${i}`, { source: "test" });
    }
    await storage.writeMemory("fact", "expired speculative fact", {
      source: "test",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    // No LLM outputs at all — only cleanup will mutate the namespace.
    orchestrator.extraction = {
      consolidate: async () => ({ items: [], profileUpdates: [], entityUpdates: [] }),
    };

    await orchestrator.namespaceCatalog.registerConfiguredNamespaces();
    await orchestrator.runConsolidationNow();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const record = await orchestrator.namespaceCatalog.getNamespaceRecord(config.defaultNamespace);
    assert.ok(record, "default namespace record must exist after cleanup-only consolidation");
    assert.ok(
      record!.lastWriteAt,
      "a cleanup-only consolidation (TTL expiry) must record a catalog write touch",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
