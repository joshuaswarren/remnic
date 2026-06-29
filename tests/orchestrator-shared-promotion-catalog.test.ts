import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";

// ── Round 2, Issue B (cursor[bot] Medium): a shared-namespace promotion writes
// to the shared namespace via `sharedStorage.writeMemory`, but round 1 only
// recorded `markCatalogWrite` for the routed SOURCE namespace. When promotion is
// the only write the shared namespace receives, its catalog `lastWriteAt` stayed
// stale — skewing `writtenSince` filters and maintenance fanout. The orchestrator
// now fires `markCatalogWrite(sharedNamespace, sharedStorage.dir)` after the
// promoted write lands. This test asserts that contract (the exact call the
// promotion path makes) updates the SHARED record without touching the source.
test("shared-namespace promotion updates the shared namespace lastWriteAt in the catalog", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-shared-promo-catalog-"));
  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      namespacesEnabled: true,
      namespaceCatalogEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
    });

    const orchestrator = new Orchestrator(config) as any;
    assert.equal(orchestrator.namespaceCatalog.enabled, true, "catalog must be enabled");

    // Resolve shared storage exactly as the promotion path does (router-routed),
    // so sharedStorage.dir matches the dir the orchestrator passes to the catalog.
    const sharedStorage = await orchestrator.getStorage("shared");
    await sharedStorage.ensureDirectories();

    // Before: no shared catalog write recorded yet.
    const before = await orchestrator.namespaceCatalog.getNamespaceRecord("shared");
    assert.ok(!before?.lastWriteAt, "shared lastWriteAt should be unset before promotion");

    // Fire the exact catalog touch the promotion path now performs after a
    // successful sharedStorage.writeMemory. markCatalogWrite is private; access
    // via the `as any` orchestrator handle, mirroring the routing tests.
    orchestrator.markCatalogWrite(config.sharedNamespace, sharedStorage.dir);

    // markCatalogWrite is fire-and-forget; let the serialized append settle.
    await orchestrator.namespaceCatalog.markRead("shared"); // serializes after the write

    const after = await orchestrator.namespaceCatalog.getNamespaceRecord("shared");
    assert.ok(after, "shared record must exist after promotion touch");
    assert.equal(after?.kind, "shared");
    assert.ok(
      after?.lastWriteAt,
      "shared promotion must update the shared namespace's lastWriteAt",
    );
    assert.equal(
      after?.storageDir,
      sharedStorage.dir,
      "shared catalog storageDir must match the router-resolved shared dir",
    );

    // No double-count of the source: the default/source namespace must not have
    // received a write touch from the shared promotion.
    const sourceRecord = await orchestrator.namespaceCatalog.getNamespaceRecord("default");
    assert.ok(
      !sourceRecord?.lastWriteAt,
      "shared promotion must not record a write on the source namespace",
    );

    // The shared record is surfaced by a writtenSince filter (the consumer the
    // bug report cited) using a lower bound just before the touch.
    const since = new Date(Date.parse(after!.lastWriteAt!) - 1000);
    const written = await orchestrator.namespaceCatalog.listNamespaces({ writtenSince: since });
    assert.ok(
      written.some((r: { namespace: string }) => r.namespace === "shared"),
      "writtenSince must now surface the shared namespace after promotion",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// Integration guard for Issue B: drive the actual promotion path via
// `persistExtraction` (auto-promote enabled, source namespace != shared) and
// assert the SHARED catalog record gains lastWriteAt as a side effect of the
// promoted write. This fails on the round-1 code (no shared markCatalogWrite in
// promoteMemoryToShared) and passes after the fix.
test("persistExtraction shared promotion records a shared-namespace catalog write", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-shared-promo-integ-"));
  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      namespacesEnabled: true,
      namespaceCatalogEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
      autoPromoteToSharedEnabled: true,
      autoPromoteToSharedCategories: ["fact"],
      autoPromoteMinConfidenceTier: "implied",
      // Keep the write path simple/offline: no linking, no chunking-by-size, no
      // semantic dedup that would need an embedding backend.
      memoryLinkingEnabled: false,
      inlineSourceAttributionEnabled: false,
    });

    const orchestrator = new Orchestrator(config) as any;
    // QMD unavailable so the write path stays offline and deterministic.
    orchestrator.qmd = { isAvailable: () => false };

    const sourceStorage = await orchestrator.getStorage("default");
    await sourceStorage.ensureDirectories();
    const sharedStorage = await orchestrator.getStorage("shared");
    await sharedStorage.ensureDirectories();

    // A single high-confidence fact in a promotable category.
    const result = {
      facts: [
        {
          content: "The team standup is at 9am every weekday.",
          category: "fact",
          confidence: 0.95,
          tags: ["schedule"],
        },
      ],
      entities: [],
      questions: [],
      profileUpdates: [],
    };

    await orchestrator.persistExtraction(result, sourceStorage, null, {
      sessionKey: "s1",
      principal: "default",
    });

    // Let any fire-and-forget catalog appends settle by serializing a read.
    await orchestrator.namespaceCatalog.markRead("shared");

    const sharedRecord = await orchestrator.namespaceCatalog.getNamespaceRecord("shared");
    assert.ok(sharedRecord, "shared record must exist after a promoted write");
    assert.ok(
      sharedRecord?.lastWriteAt,
      "the shared promotion must record a write touch on the shared namespace",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
