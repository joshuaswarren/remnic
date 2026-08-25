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
import { mkdtemp, rm, stat } from "node:fs/promises";
import { parseConfig } from "@remnic/core/config";
import { Orchestrator } from "@remnic/core/orchestrator";
import type { ExtractionEngine } from "../packages/remnic-core/src/extraction.js";
import type { MemoryFile } from "../packages/remnic-core/src/types.js";
import { recordAbstractionNode } from "@remnic/core/abstraction-nodes";
import { recordCueAnchor } from "@remnic/core/cue-anchors";
import { LifecyclePolicyCoordinator } from "../packages/remnic-core/src/orchestration/lifecycle-policy-coordinator.js";

type Consolidate = ExtractionEngine["consolidate"];

function installConsolidationStub(orchestrator: Orchestrator, consolidate: Consolidate): void {
  const descriptor = Object.getOwnPropertyDescriptor(orchestrator, "extraction");
  assert.ok(descriptor, "Orchestrator extraction field must exist");
  Object.defineProperty(orchestrator, "extraction", {
    configurable: true,
    value: { consolidate },
  });
}

test("consolidation with only an INVALIDATE memory-item action records a catalog write touch", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-consolidate-catalog-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-consolidate-ws-"));
  let orchestrator: Orchestrator | undefined;
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

    orchestrator = new Orchestrator(config);
    const storage = orchestrator.storage;

    // runConsolidation only runs with >= 5 memories. Seed a corpus, then have the
    // pass INVALIDATE one — a durable mutation with NO profile/entity updates.
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push((await storage.writeMemory("fact", `seed fact ${i}`, { source: "test" })).id);
    }
    const staleId = ids[0];
    let receivedNewMemories: MemoryFile[] | undefined;
    let receivedExistingMemories: MemoryFile[] | undefined;
    installConsolidationStub(orchestrator, async (newMemories, existingMemories, currentProfile) => {
      receivedNewMemories = newMemories;
      receivedExistingMemories = existingMemories;
      assert.equal(currentProfile, "");
      return {
        items: [{ action: "INVALIDATE", existingId: staleId, reason: "synthetic invalidation" }],
        profileUpdates: [],
        entityUpdates: [],
      };
    });

    // Establish the default namespace in the catalog so we can observe its
    // lastWriteAt advance (vs. an absent record).
    await orchestrator.namespaceCatalog.registerConfiguredNamespaces();
    const before = await orchestrator.namespaceCatalog.getNamespaceRecord(config.defaultNamespace);
    const beforeWriteAt = before?.lastWriteAt;

    await orchestrator.runConsolidationNow();
    assert.deepEqual(
      receivedNewMemories?.map((memory) => memory.content),
      ids.map((_, index) => `seed fact ${4 - index}`)
    );
    assert.deepEqual(
      receivedExistingMemories?.map((memory) => memory.content),
      ids.map((_, index) => `seed fact ${index}`)
    );

    // The catalog touch is best-effort/fire-and-forget; let its serialized write
    // chain settle, then read back the record.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = await orchestrator.namespaceCatalog.getNamespaceRecord(config.defaultNamespace);

    assert.ok(after, "default namespace record must exist after consolidation");
    assert.ok(after!.lastWriteAt, "consolidation-only memory-item mutation must record a catalog write touch");
    if (beforeWriteAt) {
      assert.ok(
        new Date(after!.lastWriteAt!).getTime() >= new Date(beforeWriteAt).getTime(),
        "lastWriteAt must advance (or hold) after a consolidation memory-item mutation"
      );
    }
  } finally {
    try {
      await orchestrator?.destroy();
    } finally {
      await rm(memoryDir, { recursive: true, force: true });
      await rm(workspaceDir, { recursive: true, force: true });
    }
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
  let orchestrator: Orchestrator | undefined;
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

    orchestrator = new Orchestrator(config);
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

    let receivedNewMemories: MemoryFile[] | undefined;
    let receivedExistingMemories: MemoryFile[] | undefined;
    installConsolidationStub(orchestrator, async (newMemories, existingMemories, currentProfile) => {
      receivedNewMemories = newMemories;
      receivedExistingMemories = existingMemories;
      assert.equal(currentProfile, "");
      return { items: [], profileUpdates: [], entityUpdates: [] };
    });

    await orchestrator.namespaceCatalog.registerConfiguredNamespaces();
    await orchestrator.runConsolidationNow();
    assert.deepEqual(
      receivedNewMemories?.map((memory) => memory.content),
      ["expired speculative fact", "keeper fact 3", "keeper fact 2", "keeper fact 1", "keeper fact 0"]
    );
    assert.deepEqual(
      receivedExistingMemories?.map((memory) => memory.content),
      ["keeper fact 0", "keeper fact 1", "keeper fact 2", "keeper fact 3", "expired speculative fact"]
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    const record = await orchestrator.namespaceCatalog.getNamespaceRecord(config.defaultNamespace);
    assert.ok(record, "default namespace record must exist after cleanup-only consolidation");
    assert.ok(record!.lastWriteAt, "a cleanup-only consolidation (TTL expiry) must record a catalog write touch");
  } finally {
    try {
      await orchestrator?.destroy();
    } finally {
      await rm(memoryDir, { recursive: true, force: true });
      await rm(workspaceDir, { recursive: true, force: true });
    }
  }
});

test("summarization records the catalog write touch after source memories are archived", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-summary-touch-order-"));
  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      namespacesEnabled: true,
      namespaceCatalogEnabled: true,
      summarizationTriggerCount: 50,
      summarizationRecentToKeep: 0,
      summarizationProtectedTags: [],
      summarizationImportanceThreshold: 1,
    });

    const orchestrator = Object.create(Orchestrator.prototype) as any;
    const events: string[] = [];
    orchestrator.config = config;
    const storage: {
      dir: string;
      onCatalogWrite?: () => void;
      writeSummary: () => Promise<void>;
      archiveMemories: () => Promise<number>;
    } = {
      dir: memoryDir,
      writeSummary: async () => {
        events.push("summary");
        storage.onCatalogWrite?.();
      },
      archiveMemories: async () => {
        events.push("archive");
        storage.onCatalogWrite?.();
        return 50;
      },
    };
    orchestrator.storage = storage;
    orchestrator.extraction = {
      summarizeMemories: async () => ({
        summaryText: "compressed memory summary",
        keyFacts: ["fact"],
        keyEntities: ["entity"],
      }),
    };
    orchestrator.storageDirNamespace = () => config.defaultNamespace;
    // #1526 seam 6: runSummarization delegates to LifecyclePolicyCoordinator.
    orchestrator.lifecyclePolicyCoordinator = new LifecyclePolicyCoordinator({
      config,
      getStorage: () => orchestrator.storage,
      extraction: orchestrator.extraction,
      embeddingFallback: orchestrator.embeddingFallback ?? { removeFromIndex: async () => {} },
      getEffectiveLifecycleThresholds: () =>
        orchestrator.effectiveLifecycleThresholds?.() ?? {
          promoteHeatThreshold: 70,
          staleDecayThreshold: 50,
          archiveDecayThreshold: 80,
        },
      removeContentHashForMemory: async () => {},
      saveContentHashIndexes: async () => {},
    });
    // #1522: the catalog touch now fires at the storage chokepoint via the
    // StorageManager's onCatalogWrite hook. Simulate that on the mock storage
    // so the test verifies the touch fires during the storage writes.
    storage.onCatalogWrite = () => {
      events.push("touch");
    };

    const memories = Array.from({ length: 50 }, (_, index) => ({
      path: path.join(memoryDir, `memory-${index}.md`),
      content: `summarizable fact ${index}`,
      frontmatter: {
        id: `memory-${index}`,
        category: "fact",
        created: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        tags: [],
        status: "active",
        importance: { score: 0.1, level: "low", reasons: [], keywords: [] },
      },
    }));

    // #1526 seam 17: runSummarization moved into ConsolidationRunCoordinator;
    // the test now exercises its real home — the LifecyclePolicyCoordinator it
    // already constructs above — preserving the catalog-touch-ordering property.
    await orchestrator.lifecyclePolicyCoordinator.runSummarization(memories);

    // #1522: with the storage chokepoint, each write fires its own catalog
    // touch. The touch from archiveMemories fires at the end of that operation
    // (after "archive"), preserving the original intent: the catalog
    // lastWriteAt touch covers the archived-state write.
    const lastArchiveIndex = events.lastIndexOf("archive");
    const lastTouchAfterArchive = events.indexOf("touch", lastArchiveIndex);
    assert.notEqual(lastArchiveIndex, -1, "precondition: archiveMemories ran");
    assert.notEqual(
      lastTouchAfterArchive,
      -1,
      `catalog touch must fire during/after archiveMemories; saw ${events.join(" -> ")}`
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("consolidation prunes orphan harmonic anchors in a cataloged non-default store", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-harmonic-prune-root-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-harmonic-prune-ws-"));
  let orchestrator: Orchestrator | undefined;
  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      namespacesEnabled: true,
      namespaceCatalogEnabled: true,
      harmonicRetrievalEnabled: true,
      abstractionAnchorsEnabled: true,
      qmdEnabled: false,
      topicExtractionEnabled: false,
      summarizationEnabled: false,
      identityEnabled: false,
      entitySummaryEnabled: false,
      semanticConsolidationEnabled: false,
      factArchivalEnabled: false,
      lifecyclePolicyEnabled: false,
    });
    orchestrator = new Orchestrator(config);
    const defaultStorage = orchestrator.storage;
    await defaultStorage.writeMemory("fact", "consolidation seed", { source: "test" });
    const namespaceStorage = await orchestrator.getStorageForNamespace("team");
    await namespaceStorage.writeMemory("fact", "team namespace seed", { source: "test" });
    await orchestrator.namespaceCatalog.markWrite("team", {
      discoveredBy: "write",
      storageDir: namespaceStorage.dir,
    });
    await recordAbstractionNode({
      memoryDir: namespaceStorage.dir,
      node: {
        schemaVersion: 1,
        nodeId: "team-live-node",
        recordedAt: "2026-03-08T00:00:00.000Z",
        sessionKey: "team",
        kind: "topic",
        abstractionLevel: "meso",
        title: "team topic",
        summary: "team topic",
      },
    });
    await recordCueAnchor({
      memoryDir: namespaceStorage.dir,
      anchor: {
        schemaVersion: 1,
        anchorId: "team-orphan-anchor",
        anchorType: "constraint",
        anchorValue: "orphan",
        normalizedCue: "orphan",
        recordedAt: "2026-03-08T00:01:00.000Z",
        sessionKey: "team",
        nodeRefs: ["deleted-team-node"],
      },
    });
    const orphanPath = path.join(
      namespaceStorage.dir,
      "state",
      "abstraction-nodes",
      "anchors",
      "constraint",
      "team-orphan-anchor.json"
    );

    await orchestrator.runConsolidationNow();

    await assert.rejects(() => stat(orphanPath), { code: "ENOENT" });
  } finally {
    try {
      await orchestrator?.destroy();
    } finally {
      await rm(memoryDir, { recursive: true, force: true });
      await rm(workspaceDir, { recursive: true, force: true });
    }
  }
});

test("consolidation rotates harmonic catalog pruning across more than 49 stores", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-harmonic-rotation-root-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-harmonic-rotation-ws-"));
  let orchestrator: Orchestrator | undefined;
  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      namespacesEnabled: true,
      namespaceCatalogEnabled: true,
      harmonicRetrievalEnabled: true,
      abstractionAnchorsEnabled: true,
      qmdEnabled: false,
      topicExtractionEnabled: false,
      summarizationEnabled: false,
      identityEnabled: false,
      entitySummaryEnabled: false,
      semanticConsolidationEnabled: false,
      factArchivalEnabled: false,
      lifecyclePolicyEnabled: false,
    });
    orchestrator = new Orchestrator(config);
    await orchestrator.storage.writeMemory("fact", "rotation default seed", { source: "test" });

    const namespaceCount = 55;
    const orphanPaths: string[] = [];
    for (let index = 0; index < namespaceCount; index += 1) {
      const namespace = `rotation-${String(index).padStart(2, "0")}`;
      const namespaceStorage = await orchestrator.getStorageForNamespace(namespace);
      await namespaceStorage.writeMemory("fact", `${namespace} seed`, { source: "test" });
      await orchestrator.namespaceCatalog.markWrite(namespace, {
        discoveredBy: "write",
        storageDir: namespaceStorage.dir,
      });
      const anchorId = `${namespace}-orphan`;
      await recordCueAnchor({
        memoryDir: namespaceStorage.dir,
        anchor: {
          schemaVersion: 1,
          anchorId,
          anchorType: "constraint",
          anchorValue: "orphan",
          normalizedCue: "orphan",
          recordedAt: "2026-03-08T00:01:00.000Z",
          sessionKey: namespace,
          nodeRefs: ["deleted-node"],
        },
      });
      orphanPaths.push(
        path.join(namespaceStorage.dir, "state", "abstraction-nodes", "anchors", "constraint", `${anchorId}.json`)
      );
    }
    await orchestrator.namespaceCatalog.flushPendingTouches();
    const catalogRecords = await orchestrator.namespaceCatalog.listNamespaces({
      discoveredBy: "write",
    });
    const duplicateRecord = catalogRecords.find((record) => record.namespace === "rotation-00");
    assert.ok(duplicateRecord, "rotation fixture must have a catalog record");
    Reflect.set(orchestrator.namespaceCatalog, "listNamespaces", async () => [
      ...catalogRecords,
      { ...duplicateRecord, storageDir: `${duplicateRecord.storageDir}${path.sep}.` },
    ]);

    const defaultAnchorPath = path.join(
      orchestrator.storage.dir,
      "state",
      "abstraction-nodes",
      "anchors",
      "constraint",
      "default-first-orphan.json"
    );
    await recordCueAnchor({
      memoryDir: orchestrator.storage.dir,
      anchor: {
        schemaVersion: 1,
        anchorId: "default-first-orphan",
        anchorType: "constraint",
        anchorValue: "orphan",
        normalizedCue: "orphan",
        recordedAt: "2026-03-08T00:01:00.000Z",
        sessionKey: "default",
        nodeRefs: ["deleted-node"],
      },
    });

    await orchestrator.runConsolidationNow();
    await assert.rejects(() => stat(defaultAnchorPath), { code: "ENOENT" });

    const presentAfterFirstRun = await Promise.all(
      orphanPaths.map(async (orphanPath) => {
        try {
          await stat(orphanPath);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          return false;
        }
      })
    );
    assert.equal(
      presentAfterFirstRun.filter(Boolean).length,
      namespaceCount - 49,
      "one run must prune at most 49 catalog stores plus the default store"
    );

    const defaultSecondAnchorPath = path.join(
      orchestrator.storage.dir,
      "state",
      "abstraction-nodes",
      "anchors",
      "constraint",
      "default-second-orphan.json"
    );
    await recordCueAnchor({
      memoryDir: orchestrator.storage.dir,
      anchor: {
        schemaVersion: 1,
        anchorId: "default-second-orphan",
        anchorType: "constraint",
        anchorValue: "orphan",
        normalizedCue: "orphan",
        recordedAt: "2026-03-08T00:02:00.000Z",
        sessionKey: "default",
        nodeRefs: ["deleted-node"],
      },
    });

    await orchestrator.runConsolidationNow();
    await assert.rejects(() => stat(defaultSecondAnchorPath), { code: "ENOENT" });
    for (const orphanPath of orphanPaths) {
      await assert.rejects(() => stat(orphanPath), { code: "ENOENT" });
    }
  } finally {
    try {
      await orchestrator?.destroy();
    } finally {
      await rm(memoryDir, { recursive: true, force: true });
      await rm(workspaceDir, { recursive: true, force: true });
    }
  }
});
