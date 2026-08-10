import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseConfig } from "../config.js";
import { Orchestrator } from "../orchestrator.js";
import type { GraphConstructionCapabilitySet } from "../capabilities.js";
import type { ExtractionEngine } from "../extraction.js";
import type { ExtractionResult, MemoryFile, PluginConfig } from "../types.js";
import type { StorageManager } from "../storage.js";
import { ContradictionLinkingCoordinator } from "./contradiction-linking-coordinator.js";
import { ExtractionAnchorSnapshot } from "./extraction-anchor-snapshot.js";

function baseConfig(memoryDir: string, overrides: Record<string, unknown> = {}) {
  return parseConfig({
    openaiApiKey: "test-key",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    contradictionDetectionEnabled: true,
    contradictionLocalization: {
      anchorEnabled: true,
      anchorCandidates: 5,
      searchCandidates: 5,
      maxCandidates: 8,
    },
    ...overrides,
  });
}

function extractionResult(fact: Record<string, unknown>): ExtractionResult {
  return {
    facts: [fact],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  } as unknown as ExtractionResult;
}

test("persistExtraction forwards ExtractedFact anchors to contradiction detection", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-contradiction-anchor-"));
  try {
    const orchestrator = new Orchestrator(baseConfig(memoryDir)) as unknown as {
      qmd: { isAvailable: () => boolean };
      getStorage: (namespace: string) => Promise<StorageManager>;
      persistExtraction: (result: ExtractionResult, storage: StorageManager, threadId: null) => Promise<unknown>;
      contradictionLinkingCoordinator: ContradictionLinkingCoordinator;
    };
    orchestrator.qmd = { isAvailable: () => true };
    const calls: unknown[][] = [];
    orchestrator.contradictionLinkingCoordinator.checkForContradiction = async (...args: unknown[]) => {
      calls.push(args);
      return null;
    };
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();

    await orchestrator.persistExtraction(
      extractionResult({
        category: "fact",
        content: "Alice lives in New York",
        confidence: 0.95,
        tags: [],
        entityRef: "person:alice",
        structuredAttributes: { city: "New York" },
      }),
      storage,
      null,
    );

    assert.equal(calls.length, 1);
    const anchor = calls[0]?.[3] as {
      entityRef?: string;
      structuredAttributes?: Record<string, string>;
      storageSnapshot?: unknown;
    };
    assert.deepEqual(
      {
        entityRef: anchor.entityRef,
        structuredAttributes: anchor.structuredAttributes,
      },
      {
        entityRef: "person:alice",
        structuredAttributes: { city: "New York" },
      },
    );
    assert.ok(Array.isArray(anchor.storageSnapshot));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
test("persistExtraction keeps malformed fact entityRef out of anchor lookup", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-contradiction-anchor-invalid-ref-"));
  try {
    const orchestrator = new Orchestrator(baseConfig(memoryDir)) as unknown as {
      qmd: { isAvailable: () => boolean };
      getStorage: (namespace: string) => Promise<StorageManager>;
      persistExtraction: (result: ExtractionResult, storage: StorageManager, threadId: null) => Promise<unknown>;
      contradictionLinkingCoordinator: ContradictionLinkingCoordinator;
    };
    orchestrator.qmd = { isAvailable: () => true };
    const calls: unknown[][] = [];
    orchestrator.contradictionLinkingCoordinator.checkForContradiction = async (...args: unknown[]) => {
      calls.push(args);
      return null;
    };
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();

    await orchestrator.persistExtraction(
      extractionResult({
        category: "fact",
        content: "Alice lives in New York",
        confidence: 0.95,
        tags: [],
        entityRef: 42,
      }),
      storage,
      null,
    );

    assert.equal(calls.length, 1);
    const anchor = calls[0]?.[3] as {
      entityRef?: unknown;
      storageSnapshot?: unknown;
    };
    assert.equal(anchor.entityRef, undefined);
    assert.equal(anchor.storageSnapshot, undefined);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});


test("persistExtraction treats string false anchorEnabled as disabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-contradiction-anchor-false-"));
  try {
    const config = baseConfig(memoryDir);
    const rawLocalization = config.contradictionLocalization as unknown as Record<string, unknown>;
    rawLocalization.anchorEnabled = "false";
    const orchestrator = new Orchestrator(config) as unknown as {
      qmd: { isAvailable: () => boolean };
      getStorage: (namespace: string) => Promise<StorageManager>;
      persistExtraction: (result: ExtractionResult, storage: StorageManager, threadId: null) => Promise<unknown>;
      contradictionLinkingCoordinator: ContradictionLinkingCoordinator;
    };
    orchestrator.qmd = { isAvailable: () => true };
    const calls: unknown[][] = [];
    orchestrator.contradictionLinkingCoordinator.checkForContradiction = async (...args: unknown[]) => {
      calls.push(args);
      return null;
    };
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();

    await orchestrator.persistExtraction(
      extractionResult({
        category: "fact",
        content: "Alice lives in New York",
        confidence: 0.95,
        tags: [],
        entityRef: "person:alice",
      }),
      storage,
      null,
    );

    const anchor = calls[0]?.[3];
    assert.ok(anchor && typeof anchor === "object" && "storageSnapshot" in anchor);
    const storageSnapshot =
      anchor && typeof anchor === "object" && "storageSnapshot" in anchor ? anchor.storageSnapshot : "missing";
    assert.equal(storageSnapshot, undefined);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("persistExtraction memoizes one anchor snapshot for all facts in one pass", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-contradiction-snapshot-"));
  try {
    const orchestrator = new Orchestrator(baseConfig(memoryDir)) as unknown as {
      qmd: { isAvailable: () => boolean };
      getStorage: (namespace: string) => Promise<StorageManager>;
      persistExtraction: (
        result: ExtractionResult,
        storage: StorageManager,
        threadId: null,
        sourceContext?: undefined,
        baseNamespace?: undefined,
        scopeProfileWritePlan?: undefined,
        sourceText?: undefined,
        graphCaps?: GraphConstructionCapabilitySet,
      ) => Promise<unknown>;
      contradictionLinkingCoordinator: ContradictionLinkingCoordinator;
    };
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();
    await storage.getSharedFactHashIndex();
    let hotReadCount = 0;
    let coldReadCount = 0;
    const readAllMemories = storage.readAllMemories.bind(storage);
    storage.readAllMemories = async () => {
      hotReadCount++;
      return readAllMemories();
    };
    const readAllColdMemories = storage.readAllColdMemories.bind(storage);
    storage.readAllColdMemories = async () => {
      coldReadCount++;
      return readAllColdMemories();
    };
    const snapshots: unknown[] = [];
    orchestrator.contradictionLinkingCoordinator.checkForContradiction = async (...args: unknown[]) => {
      const anchor = args[3];
      if (anchor && typeof anchor === "object" && "storageSnapshot" in anchor) {
        snapshots.push(anchor.storageSnapshot);
      }
      return null;
    };
    const result = extractionResult({
      category: "fact",
      content: "Alice lives in Austin",
      confidence: 0.95,
      tags: [],
      entityRef: "person:alice",
    });
    result.facts.push({
      category: "fact",
      content: "Alice works in Austin",
      confidence: 0.95,
      tags: [],
      entityRef: "person:alice",
    });

    await orchestrator.persistExtraction(
      result,
      storage,
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        entityGraph: false,
        timeGraph: false,
        causalGraph: false,
        multiGraphMemory: false,
        graphWriteSessionAdjacency: false,
      },
    );
    await orchestrator.persistExtraction(
      extractionResult({
        category: "fact",
        content: "Bob lives in Dallas",
        confidence: 0.95,
        tags: [],
        entityRef: "person:bob",
      }),
      storage,
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        entityGraph: false,
        timeGraph: false,
        causalGraph: false,
        multiGraphMemory: false,
        graphWriteSessionAdjacency: false,
      },
    );

    assert.equal(snapshots.length, 3);
    assert.equal(snapshots[0], snapshots[1]);
    assert.notEqual(snapshots[1], snapshots[2]);
    assert.equal(hotReadCount, 2);
    assert.equal(coldReadCount, 2);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("evicts a rejected anchor snapshot so the next call retries", async () => {
  let hotReads = 0;
  const replacement = {
    path: "memories/replacement.md",
    content: "replacement",
    frontmatter: {
      id: "replacement",
      category: "fact",
    },
  } as unknown as MemoryFile;
  const storage = {
    dir: "/tmp/remnic-anchor-snapshot-test",
    readAllMemories: async () => {
      hotReads++;
      if (hotReads === 1) throw new Error("transient snapshot read");
      return [];
    },
    readAllColdMemories: async () => [],
    readMemoryByPath: async () => replacement,
  } as unknown as StorageManager;
  const snapshots = new ExtractionAnchorSnapshot();

  await assert.rejects(
    snapshots.get(storage, "person:alice"),
    /transient snapshot read/,
  );
  const retry = await snapshots.get(storage, "person:alice");
  assert.deepEqual(retry, []);

  await snapshots.replace(storage, "replacement", "fact", new Map([["replacement", "memories/replacement.md"]]));
  assert.deepEqual(retry, [replacement]);
  await snapshots.remove(storage, "replacement");
  assert.deepEqual(retry, []);
  assert.equal(hotReads, 2);
});


test("updates the memoized anchor snapshot after each same-batch write", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-contradiction-batch-snapshot-"));
  try {
    const orchestrator = new Orchestrator(baseConfig(memoryDir)) as unknown as {
      qmd: { isAvailable: () => boolean };
      getStorage: (namespace: string) => Promise<StorageManager>;
      persistExtraction: (
        result: ExtractionResult,
        storage: StorageManager,
        threadId: null,
        sourceContext?: undefined,
        baseNamespace?: undefined,
        scopeProfileWritePlan?: undefined,
        sourceText?: undefined,
        graphCaps?: GraphConstructionCapabilitySet,
      ) => Promise<unknown>;
      contradictionLinkingCoordinator: ContradictionLinkingCoordinator;
    };
    orchestrator.qmd = { isAvailable: () => false };
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();
    const snapshots: MemoryFile[][] = [];
    orchestrator.contradictionLinkingCoordinator.checkForContradiction = async (...args: unknown[]) => {
      const anchor = args[3];
      snapshots.push(
        anchor && typeof anchor === "object" && "storageSnapshot" in anchor
          ? [...((anchor as { storageSnapshot?: MemoryFile[] }).storageSnapshot ?? [])]
          : [],
      );
      return null;
    };
    const result = extractionResult({
      category: "fact",
      content: "Alice lives in Austin",
      confidence: 0.95,
      tags: [],
      entityRef: "person:alice",
    });
    result.facts.push({
      category: "fact",
      content: "Alice lives in New York",
      confidence: 0.95,
      tags: [],
      entityRef: "person:alice",
    });
    await orchestrator.persistExtraction(result, storage, null, undefined, undefined, undefined, undefined, {
      entityGraph: false,
      timeGraph: false,

      causalGraph: false,
      multiGraphMemory: false,
      graphWriteSessionAdjacency: false,
    });
    assert.equal(snapshots.length, 2);
    assert.equal(snapshots[0]?.some((memory) => memory.content.includes("Austin")), false);
    assert.equal(snapshots[1]?.some((memory) => memory.content.includes("Austin")), true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
test("keeps a failed supersession anchor in the next same-batch snapshot", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-contradiction-supersede-failure-"));
  try {
    const orchestrator = new Orchestrator(
      baseConfig(memoryDir, { contradictionAutoResolve: true }),
    ) as unknown as {
      getStorage: (namespace: string) => Promise<StorageManager>;
      persistExtraction: (
        result: ExtractionResult,
        storage: StorageManager,
        threadId: null,
        sourceContext?: undefined,
        baseNamespace?: undefined,
        scopeProfileWritePlan?: undefined,
        sourceText?: undefined,
        graphCaps?: GraphConstructionCapabilitySet,
      ) => Promise<unknown>;
      contradictionLinkingCoordinator: ContradictionLinkingCoordinator;
    };
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();
    const { id: oldId } = await storage.writeMemory("fact", "Alice lives in Austin", {
      entityRef: "person:alice",
      source: "test",
    });
    storage.supersedeMemory = async () => false;
    const snapshots: MemoryFile[][] = [];
    orchestrator.contradictionLinkingCoordinator.checkForContradiction = async (...args: unknown[]) => {
      const anchor = args[3];
      snapshots.push(
        anchor && typeof anchor === "object" && "storageSnapshot" in anchor
          ? [...((anchor as { storageSnapshot?: MemoryFile[] }).storageSnapshot ?? [])]
          : [],
      );
      return {
        supersededId: oldId,
        confidence: 0.99,
        reason: "same entity conflict",
        supersededPath: `/synthetic/${oldId}.md`,
        supersededCreated: "2026-08-09T00:00:00.000Z",
        supersededTags: [],
      };
    };

    const result = extractionResult({
      category: "fact",
      content: "Alice lives in Boston",
      confidence: 0.95,
      tags: [],
      entityRef: "person:alice",
    });
    result.facts.push({
      category: "fact",
      content: "Alice lives in Dallas",
      confidence: 0.95,
      tags: [],
      entityRef: "person:alice",
    });
    await orchestrator.persistExtraction(result, storage, null, undefined, undefined, undefined, undefined, {
      entityGraph: false,
      timeGraph: false,
      causalGraph: false,
      multiGraphMemory: false,
      graphWriteSessionAdjacency: false,
    });

    assert.equal(snapshots.length, 2);
    assert.equal(snapshots[0]?.some((memory) => memory.frontmatter.id === oldId), true);
    assert.equal(snapshots[1]?.some((memory) => memory.frontmatter.id === oldId), true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("removes temporally superseded anchors before the next same-batch fact", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-contradiction-temporal-snapshot-"));
  try {
    const orchestrator = new Orchestrator(baseConfig(memoryDir, { tombstonesEnabled: false })) as unknown as {
      qmd: { isAvailable: () => boolean };
      getStorage: (namespace: string) => Promise<StorageManager>;
      persistExtraction: (
        result: ExtractionResult,
        storage: StorageManager,
        threadId: null,
        sourceContext?: undefined,
        baseNamespace?: undefined,
        scopeProfileWritePlan?: undefined,
        sourceText?: undefined,
        graphCaps?: GraphConstructionCapabilitySet,
      ) => Promise<unknown>;
      contradictionLinkingCoordinator: ContradictionLinkingCoordinator;
    };
    orchestrator.qmd = { isAvailable: () => false };
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();
    const snapshots: MemoryFile[][] = [];
    orchestrator.contradictionLinkingCoordinator.checkForContradiction = async (...args: unknown[]) => {
      const anchor = args[3];
      snapshots.push(
        anchor && typeof anchor === "object" && "storageSnapshot" in anchor
          ? [...((anchor as { storageSnapshot?: MemoryFile[] }).storageSnapshot ?? [])]
          : [],
      );
      return null;
    };

    await orchestrator.persistExtraction(
      extractionResult({
        category: "fact",
        content: "Alice lives in Austin",
        confidence: 0.95,
        tags: [],
        entityRef: "person:alice",
        structuredAttributes: { city: "Austin" },
      }),
      storage,
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        entityGraph: false,
        timeGraph: false,
        causalGraph: false,
        multiGraphMemory: false,
        graphWriteSessionAdjacency: false,
      } as unknown as GraphConstructionCapabilitySet,
    );

    const result = extractionResult({
      category: "fact",
      content: "Alice lives in New York",
      confidence: 0.95,
      tags: [],
      entityRef: "person:alice",
      structuredAttributes: { city: "New York" },
    });
    result.facts.push({
      category: "fact",
      content: "The current city for Alice is Boston, Massachusetts",
      confidence: 0.95,
      tags: [],
      entityRef: "person:alice",
      structuredAttributes: { city: "Boston" },
    });
    await orchestrator.persistExtraction(
      result,
      storage,
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        entityGraph: false,
        timeGraph: false,
        causalGraph: false,
        multiGraphMemory: false,
        graphWriteSessionAdjacency: false,
      },
    );
    assert.equal(snapshots.length, 3);
    assert.equal(snapshots[1]?.some((memory) => memory.content.includes("Austin")), true);
    assert.equal(snapshots[2]?.some((memory) => memory.content.includes("Austin")), false);
    assert.equal(snapshots[2]?.some((memory) => memory.content.includes("New York")), true);
    assert.equal(snapshots[2]?.some((memory) => memory.content.includes("Boston")), false);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
test("removes superseded anchors from the same-batch snapshot", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-contradiction-superseded-snapshot-"));
  try {
    const orchestrator = new Orchestrator(baseConfig(memoryDir)) as unknown as {
      qmd: { isAvailable: () => boolean };
      getStorage: (namespace: string) => Promise<StorageManager>;
      persistExtraction: (
        result: ExtractionResult,
        storage: StorageManager,
        threadId: null,
        sourceContext?: undefined,
        baseNamespace?: undefined,
        scopeProfileWritePlan?: undefined,
        sourceText?: undefined,
        graphCaps?: GraphConstructionCapabilitySet,
      ) => Promise<unknown>;
      contradictionLinkingCoordinator: ContradictionLinkingCoordinator;
    };
    orchestrator.qmd = { isAvailable: () => false };
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();
    let checkCount = 0;
    let oldId = "";
    orchestrator.contradictionLinkingCoordinator.checkForContradiction = async (...args: unknown[]) => {
      const anchor = args[3];
      const snapshot =
        anchor && typeof anchor === "object" && "storageSnapshot" in anchor
          ? ((anchor as { storageSnapshot?: MemoryFile[] }).storageSnapshot ?? [])
          : [];
      if (checkCount === 0) {
        checkCount++;
        return null;
      }
      if (checkCount === 1) {
        assert.ok(snapshot.some((memory) => memory.frontmatter.id === oldId));
        checkCount++;
        const old = snapshot.find((memory) => memory.frontmatter.id === oldId);
        return {
          supersededId: oldId,
          confidence: 0.99,
          reason: "city changed",
          supersededPath: old?.path ?? "",
          supersededCreated: "2026-08-09T00:00:00.000Z",
          supersededTags: old?.frontmatter.tags ?? [],
        };
      }
      assert.equal(snapshot.some((memory) => memory.frontmatter.id === oldId), false);
      checkCount++;
      return null;
    };
    const graphCaps = {
      entityGraph: false,
      timeGraph: false,
      causalGraph: false,
      multiGraphMemory: false,
      graphWriteSessionAdjacency: false,
    };
    await orchestrator.persistExtraction(
      extractionResult({
        category: "fact",
        content: "Alice lives in Austin",
        confidence: 0.95,
        tags: [],
        entityRef: "person:alice",
      }),
      storage,
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      graphCaps,
    );
    oldId = (await storage.readAllMemories()).find((memory) => memory.content.includes("Austin"))?.frontmatter.id ?? "";
    assert.notEqual(oldId, "");
    const result = extractionResult({
      category: "fact",
      content: "Alice lives in New York",
      confidence: 0.95,
      tags: [],
      entityRef: "person:alice",
    });
    result.facts.push({
      category: "fact",
      content: "Alice works in New York",
      confidence: 0.95,
      tags: [],
      entityRef: "person:alice",
    });
    await orchestrator.persistExtraction(
      result,
      storage,
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      graphCaps,
    );
    assert.equal(checkCount, 3);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("supersedeMemory does not overwrite an already-superseded cold memory", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-supersede-cold-cas-"));
  try {
    const orchestrator = new Orchestrator(baseConfig(memoryDir, { tombstonesEnabled: false })) as unknown as {
      getStorage: (namespace: string) => Promise<StorageManager>;
    };
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();

    const { id } = await storage.writeMemory("preference", "Alice prefers tea", { source: "test" });
    const hot = (await storage.readAllMemories()).find((memory) => memory.frontmatter.id === id);
    assert.ok(hot);
    const moved = await storage.migrateMemoryToTier(hot, "cold");
    assert.equal(moved.changed, true);

    assert.equal(await storage.supersedeMemory(id, "replacement-one", "first replacement"), true);
    assert.equal(await storage.supersedeMemory(id, "replacement-two", "duplicate replacement"), false);

    const cold = (await storage.readAllColdMemories()).find((memory) => memory.frontmatter.id === id);
    assert.ok(cold);
    assert.equal(cold.frontmatter.status, "superseded");
    assert.equal(cold.frontmatter.supersededBy, "replacement-one");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("anchor-only contradiction verifies an active cold anchor through deferred resolve", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-contradiction-cold-anchor-"));
  try {
    const orchestrator = new Orchestrator(baseConfig(memoryDir, {
      tombstonesEnabled: false,
      contradictionAutoResolve: true,
    })) as unknown as {
      qmd: { isAvailable: () => boolean };
      getStorage: (namespace: string) => Promise<StorageManager>;
      persistExtraction: (
        result: ExtractionResult,
        storage: StorageManager,
        threadId: null,
        sourceContext?: undefined,
        baseNamespace?: undefined,
        scopeProfileWritePlan?: undefined,
        sourceText?: undefined,
        graphCaps?: GraphConstructionCapabilitySet,
      ) => Promise<unknown>;
      contradictionLinkingCoordinator: ContradictionLinkingCoordinator;
    };
    orchestrator.qmd = { isAvailable: () => false };
    let coldAnchorVerified = false;
    let detected: {
      supersededId: string;
      confidence: number;
      reason: string;
      supersededPath: string;
      supersededCreated: string;
      supersededTags: string[];
    } | null = null;
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();
    let oldId = "";
    const graphCaps = {
      entityGraph: false,
      timeGraph: false,
      causalGraph: false,
      graphWriteSessionAdjacency: false,
    };
    let supersedeCalls = 0;
    const supersedeMemory = storage.supersedeMemory.bind(storage);
    storage.supersedeMemory = async (...args: Parameters<StorageManager["supersedeMemory"]>) => {
      supersedeCalls++;
      return supersedeMemory(...args);
    };
    orchestrator.contradictionLinkingCoordinator.checkForContradiction = async (...args: unknown[]) => {
      const anchor = args[3];
      const snapshot =
        anchor && typeof anchor === "object" && "storageSnapshot" in anchor
          ? ((anchor as { storageSnapshot?: MemoryFile[] }).storageSnapshot ?? [])
          : [];
      if (!oldId) return null;
      const old = snapshot.find((memory) => memory.frontmatter.id === oldId);
      assert.ok(old);
      assert.ok(old.path.includes(`${path.sep}cold${path.sep}`));
      coldAnchorVerified = true;
      detected = {
        supersededId: oldId,
        confidence: 0.99,
        reason: "city changed",
        supersededPath: old.path,
        supersededCreated: "2026-08-09T00:00:00.000Z",
        supersededTags: old.frontmatter.tags ?? [],
      };
      return detected;
    };
    await orchestrator.persistExtraction(
      extractionResult({
        category: "fact",
        content: "Alice lives in Austin",
        confidence: 0.95,
        tags: [],
        entityRef: "person:alice",
      }),
      storage,
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        entityGraph: false,
        timeGraph: false,
        causalGraph: false,
        multiGraphMemory: false,
        graphWriteSessionAdjacency: false,
      } as unknown as GraphConstructionCapabilitySet,
    );
    const old = (await storage.readAllMemories()).find((memory) => memory.content.includes("Austin"));
    assert.ok(old);
    oldId = old.frontmatter.id;
    const moved = await storage.migrateMemoryToTier(old, "cold");
    assert.equal(moved.changed, true);

    await orchestrator.persistExtraction(
      extractionResult({
        category: "fact",
        content: "Alice lives in New York",
        confidence: 0.95,
        tags: [],
        entityRef: "person:alice",
      }),
      storage,
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        entityGraph: false,
        timeGraph: false,
        causalGraph: false,
        multiGraphMemory: false,
        graphWriteSessionAdjacency: false,
      } as unknown as GraphConstructionCapabilitySet,
    );
    assert.equal(coldAnchorVerified, true);
    const cold = (await storage.readAllColdMemories()).find((memory) => memory.frontmatter.id === oldId);
    assert.ok(cold);
    assert.equal(cold.frontmatter.status, "superseded");
    assert.equal(cold.frontmatter.supersededBy !== undefined, true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("anchor-only contradiction flows through deferred resolve and supersedes the old memory", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-contradiction-deferred-"));
  try {
    const config = baseConfig(memoryDir) as PluginConfig;
    const old = {
      path: "/synthetic/default/old.md",
      content: "Alice lives in Austin",
      frontmatter: {
        id: "old",
        category: "fact",
        created: "2026-08-01T00:00:00.000Z",
        updated: "2026-08-01T00:00:00.000Z",
        source: "test",
        confidence: 0.9,
        confidenceTier: "explicit",
        tags: [],
        status: "active",
        entityRef: "person:alice",
        structuredAttributes: { city: "Austin" },
      },
    } as unknown as MemoryFile;
    const storage = {
      readAllMemories: async () => [old],
      getMemoryById: async (id: string) => (id === "old" ? old : null),
      supersedeMemory: async (id: string) => {
        if (id !== "old") return false;
        old.frontmatter.status = "superseded";
        return true;
      },
    } as never as StorageManager;
    const extraction = {
      verifyContradiction: async () => ({
        isContradiction: true,
        confidence: 0.99,
        reasoning: "city changed",
        whichIsNewer: "second",
      }),
    } as unknown as ExtractionEngine;
    const coordinator = new ContradictionLinkingCoordinator({
      getConfig: () => config,
      isSearchAvailable: () => true,
      searchAcrossNamespaces: async () => [],
      extractMemoryIdsFromResults: () => [],
      namespaceFromPath: () => "default",
      storageForNamespace: async () => storage,
      getExtraction: () => extraction,
    });

    const contradiction = await coordinator.checkForContradiction(
      "Alice lives in New York",
      "fact",
      "default",
      { entityRef: "person:alice", structuredAttributes: { city: "New York" } },
    );
    assert.equal(contradiction?.supersededId, "old");

    await coordinator.applyDeferredContradictionResolve(contradiction, storage, "new", false);
    assert.equal(old.frontmatter.status, "superseded");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
