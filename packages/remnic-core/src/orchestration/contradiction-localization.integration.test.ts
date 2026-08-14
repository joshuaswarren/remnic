import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseConfig } from "../config.js";
import { Orchestrator } from "../orchestrator.js";
import type { GraphConstructionCapabilitySet } from "../capabilities.js";
import type { ExtractionEngine } from "../extraction.js";
import type { ExtractionResult, MemoryFile, PluginConfig } from "../types.js";
import type { StorageManager } from "../storage.js";
import { initLogger, resetLogger } from "../logger.js";
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

test("keeps durable fact writes when anchor snapshot refresh read fails", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-contradiction-anchor-refresh-failure-"));
  const warnings: string[] = [];
  initLogger(
    {
      info: () => {},
      warn: (message) => warnings.push(message),
      error: () => {},
      debug: () => {},
    },
    false,
    { timestamps: false },
  );
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
      ) => Promise<{ persistedIds: string[] }>;
      contradictionLinkingCoordinator: ContradictionLinkingCoordinator;
    };
    const snapshots: unknown[] = [];
    orchestrator.contradictionLinkingCoordinator.checkForContradiction = async (...args: unknown[]) => {
      const anchor = args[3];
      if (anchor && typeof anchor === "object" && "storageSnapshot" in anchor) {
        snapshots.push(anchor.storageSnapshot);
      } else {
        snapshots.push(undefined);
      }
      return null;
    };
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();
    const readMemoryByPath = storage.readMemoryByPath.bind(storage);
    let failRefreshRead = true;
    storage.readMemoryByPath = async (memoryPath: string) => {
      const memory = await readMemoryByPath(memoryPath);
      if (failRefreshRead && memory) {
        failRefreshRead = false;
        throw new Error("anchor snapshot refresh read failed");
      }
      return memory;
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

    const persisted = await orchestrator.persistExtraction(
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

    assert.equal(persisted.persistedIds.length, 2);
    assert.equal((await storage.readAllMemories()).length, 2);
    assert.equal(snapshots.length, 2);
    assert.ok(Array.isArray(snapshots[0]));
    assert.deepEqual(snapshots[1], []);
    assert.ok(warnings.some((warning) => warning.includes("anchor snapshot update failed")));
  } finally {
    resetLogger();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("disables anchor snapshot reuse after a rejected read", async () => {
  let hotReads = 0;
  const storage = {
    dir: "/tmp/remnic-anchor-snapshot-test",
    readAllMemories: async () => {
      hotReads++;
      if (hotReads === 1) throw new Error("transient snapshot read");
      return [];
    },
    readAllColdMemories: async () => [],
  } as unknown as StorageManager;
  const snapshots = new ExtractionAnchorSnapshot();

  assert.deepEqual(await snapshots.get(storage, "person:alice"), []);
  assert.deepEqual(await snapshots.get(storage, "person:alice"), []);
  assert.equal(hotReads, 1);
});

test("anchor snapshot prefers an active cold copy over a path-archived hot duplicate", async () => {
  const storageDir = "/tmp/remnic-anchor-snapshot-archive-duplicate";
  const hot = {
    path: path.join(storageDir, "archive", "duplicate.md"),
    content: "hot archived",
    frontmatter: {
      id: "duplicate",
      category: "fact",
      created: "2026-08-01T00:00:00.000Z",
      updated: "2026-08-01T00:00:00.000Z",
      status: "active",
      archivedAt: "2026-08-08T00:00:00.000Z",
    },
  } as unknown as MemoryFile;
  const cold = {
    path: path.join(storageDir, "cold", "duplicate.md"),
    content: "cold active",
    frontmatter: {
      ...hot.frontmatter,
      status: "active",
      archivedAt: undefined,
    },
  } as unknown as MemoryFile;
  const storage = {
    dir: storageDir,
    readAllMemories: async () => [hot],
    readAllColdMemories: async () => [cold],
  } as unknown as StorageManager;
  const snapshots = new ExtractionAnchorSnapshot();

  assert.deepEqual(await snapshots.get(storage, "person:alice"), [cold]);
});

test("isolates anchor snapshot failures per storage", async () => {
  const snapshots = new ExtractionAnchorSnapshot();
  const failedStorage = {
    dir: "/tmp/remnic-anchor-snapshot-failed",
    readAllMemories: async () => {
      throw new Error("storage A read failed");
    },
    readAllColdMemories: async () => [],
  } as unknown as StorageManager;
  const replacement = {
    path: "memories/storage-b.md",
    content: "storage B",
    frontmatter: { id: "storage-b", category: "fact" },
  } as unknown as MemoryFile;
  const healthyStorage = {
    dir: "/tmp/remnic-anchor-snapshot-healthy",
    readAllMemories: async () => [],
    readAllColdMemories: async () => [],
    readMemoryByPath: async () => replacement,
  } as unknown as StorageManager;

  assert.deepEqual(await snapshots.get(failedStorage, "person:alice"), []);
  const healthySnapshot = await snapshots.get(healthyStorage, "person:bob");
  assert.deepEqual(healthySnapshot, []);
  await snapshots.replace(
    healthyStorage,
    "storage-b",
    "fact",
    new Map([["storage-b", "memories/storage-b.md"]]),
  );
  assert.deepEqual(healthySnapshot, [replacement]);
});


test("keeps durable fact writes when initial anchor snapshot read fails", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-contradiction-anchor-initial-read-failure-"));
  const warnings: string[] = [];
  initLogger(
    {
      info: () => {},
      warn: (message) => warnings.push(message),
      error: () => {},
      debug: () => {},
    },
    false,
    { timestamps: false },
  );
  try {
    const orchestrator = new Orchestrator(
      baseConfig(memoryDir, { semanticDedupEnabled: false }),
    ) as unknown as {
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
      ) => Promise<{ persistedIds: string[] }>;
      contradictionLinkingCoordinator: ContradictionLinkingCoordinator;
    };
    orchestrator.qmd = { isAvailable: () => false };
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();
    const readAllMemories = storage.readAllMemories.bind(storage);
    const readAllColdMemories = storage.readAllColdMemories.bind(storage);
    let hotReadActive = false;
    let failedCorpusReads = 0;
    storage.readAllMemories = async () => {
      hotReadActive = true;
      try {
        return await readAllMemories();
      } finally {
        hotReadActive = false;
      }
    };
    storage.readAllColdMemories = async () => {
      if (hotReadActive && failedCorpusReads === 0) {
        failedCorpusReads++;
        throw new Error("initial anchor snapshot read failed");
      }
      return readAllColdMemories();
    };

    const persisted = await orchestrator.persistExtraction(
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
      },
    );
    assert.equal(persisted.persistedIds.length, 1);
    assert.equal((await storage.readAllMemories()).length, 1);

    assert.equal(failedCorpusReads, 1);
    assert.ok(warnings.some((warning) => warning.includes("anchor snapshot update failed")));
  } finally {
    resetLogger();
    await rm(memoryDir, { recursive: true, force: true });
  }
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
test("clears a losing supersedes link and removes the raced anchor", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-contradiction-supersede-race-"));
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
    const supersedeMemory = storage.supersedeMemory.bind(storage);
    storage.supersedeMemory = async (...args: Parameters<StorageManager["supersedeMemory"]>) => {
      await supersedeMemory(...args);
      return false;
    };
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
    assert.equal(snapshots[1]?.some((memory) => memory.frontmatter.id === oldId), false);
    const persisted = (await storage.readAllMemories()).filter(
      (memory) => memory.frontmatter.id !== oldId,
    );
    const losingWrites = persisted.filter(
      (memory) => memory.content.includes("Boston") || memory.content.includes("Dallas"),
    );
    assert.equal(losingWrites.length, 2);
    assert.equal(losingWrites.every((memory) => memory.frontmatter.supersedes === undefined), true);
    assert.equal(
      (await storage.getMemoryById(oldId))?.frontmatter.status,
      "superseded",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
test("preserves an active cold anchor when a supersede race sees an inactive hot copy", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-contradiction-cold-race-"));
  try {
    const config = baseConfig(memoryDir, { contradictionAutoResolve: true });
    const activeCold = {
      path: path.join(memoryDir, "cold", "old.md"),
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
      },
    } as unknown as MemoryFile;
    const inactiveHot = {
      ...activeCold,
      path: path.join(memoryDir, "old.md"),
      frontmatter: {
        ...activeCold.frontmatter,
        status: "superseded",
        supersededBy: "other",
      },
    } as unknown as MemoryFile;
    const losing = {
      ...activeCold,
      path: path.join(memoryDir, "new.md"),
      content: "Alice lives in Boston",
      frontmatter: {
        ...activeCold.frontmatter,
        id: "new",
        supersedes: "old",
      },
    } as unknown as MemoryFile;
    let clearCalls = 0;
    const storage = {
      dir: memoryDir,
      getMemoryById: async (id: string) =>
        id === "old" ? inactiveHot : id === "new" ? losing : null,
      readAllMemories: async () => [inactiveHot, losing],
      readAllColdMemories: async () => [activeCold],
      supersedeMemory: async () => false,
      writeMemoryFrontmatter: async (memory: MemoryFile) => {
        clearCalls += 1;
        memory.frontmatter.supersedes = undefined;
        return true;
      },
    } as unknown as StorageManager;
    const coordinator = new ContradictionLinkingCoordinator({
      getConfig: () => config,
      isSearchAvailable: () => false,
      searchAcrossNamespaces: async () => [],
      extractMemoryIdsFromResults: () => [],
      namespaceFromPath: () => "default",
      storageForNamespace: async () => storage,
      getExtraction: () => ({}) as ExtractionEngine,
    });

    const outcome = await coordinator.applyDeferredContradictionResolve(
      {
        supersededId: "old",
        reason: "city changed",
        supersededPath: activeCold.path,
        supersededCreated: activeCold.frontmatter.created,
        supersededTags: [],
      },
      storage,
      "new",
      false,
    );

    assert.equal(outcome, "supersede_failed");
    assert.equal(activeCold.frontmatter.status, "active");
    assert.equal(losing.frontmatter.supersedes, undefined);
    assert.equal(clearCalls, 1);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
test("cleanup I/O failure with an active target returns supersedes_clear_failed and preserves the anchor", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-contradiction-active-clear-io-"));
  try {
    const config = baseConfig(memoryDir, { contradictionAutoResolve: true });
    const activeOld = {
      path: path.join(memoryDir, "old.md"),
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
      },
    } as unknown as MemoryFile;
    const losing = {
      ...activeOld,
      path: path.join(memoryDir, "new.md"),
      content: "Alice lives in Boston",
      frontmatter: {
        ...activeOld.frontmatter,
        id: "new",
        supersedes: "old",
      },
    } as unknown as MemoryFile;
    const storage = {
      dir: memoryDir,
      getMemoryById: async (id: string) => (id === "old" ? activeOld : id === "new" ? losing : null),
      readAllMemories: async () => [activeOld, losing],
      readAllColdMemories: async () => [],
      supersedeMemory: async () => false,
      writeMemoryFrontmatter: async () => {
        throw new Error("supersedes clear I/O failed");
      },
    } as unknown as StorageManager;
    const coordinator = new ContradictionLinkingCoordinator({
      getConfig: () => config,
      isSearchAvailable: () => false,
      searchAcrossNamespaces: async () => [],
      extractMemoryIdsFromResults: () => [],
      namespaceFromPath: () => "default",
      storageForNamespace: async () => storage,
      getExtraction: () => ({}) as ExtractionEngine,
    });

    const outcome = await coordinator.applyDeferredContradictionResolve(
      {
        supersededId: "old",
        reason: "city changed",
        supersededPath: activeOld.path,
        supersededCreated: activeOld.frontmatter.created,
        supersededTags: [],
      },
      storage,
      "new",
      false,
    );

    assert.equal(outcome, "supersedes_clear_failed");
    assert.equal(activeOld.frontmatter.status, "active");
    assert.equal(losing.frontmatter.supersedes, "old");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
test("propagation snapshots the canonical active cold contradiction target", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-contradiction-propagation-cold-"));
  try {
    const config = baseConfig(memoryDir, {
      contradictionAutoResolve: true,
      dependencyPropagation: {
        enabled: true,
        linkTypes: ["supports"],
        maxDependents: 10,
        timeoutMs: 50,
        dryRun: false,
      },
    });
    const activeCold = {
      path: path.join(memoryDir, "cold", "old.md"),
      content: "canonical cold contradiction",
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
        links: [{ targetId: "dependent", linkType: "supports", strength: 0.9 }],
      },
    } as unknown as MemoryFile;
    const inactiveHot = {
      ...activeCold,
      path: path.join(memoryDir, "old.md"),
      content: "inactive hot duplicate",
      frontmatter: {
        ...activeCold.frontmatter,
        status: "superseded",
        supersededBy: "previous",
        links: [],
      },
    } as unknown as MemoryFile;
    const replacement = {
      ...activeCold,
      path: path.join(memoryDir, "new.md"),
      content: "replacement contradiction",
      frontmatter: {
        ...activeCold.frontmatter,
        id: "new",
        links: [],
      },
    } as unknown as MemoryFile;
    const dependent = {
      ...activeCold,
      path: path.join(memoryDir, "dependent.md"),
      content: "dependent claim",
      frontmatter: {
        ...activeCold.frontmatter,
        id: "dependent",
        links: [],
      },
    } as unknown as MemoryFile;
    let revalidationInput: {
      superseded: { id: string; content: string };
      dependents: Array<{ id: string; content: string }>;
    } | null = null;
    const storage = {
      dir: memoryDir,
      getMemoryById: async (id: string) =>
        id === "old" ? inactiveHot : id === "new" ? replacement : id === "dependent" ? dependent : null,
      readAllMemories: async () => [inactiveHot, replacement, dependent],
      readAllColdMemories: async () => [activeCold],
      supersedeMemory: async () => true,
    } as unknown as StorageManager;
    const extraction = {
      revalidateDependents: async (
        superseded: { id: string; content: string },
        _replacement: { id: string; content: string } | null,
        dependents: Array<{ id: string; content: string }>,
      ) => {
        revalidationInput = {
          superseded,
          dependents: dependents.map(({ id, content }) => ({ id, content })),
        };
        return {
          verdicts: dependents.map((item) => ({
            memoryId: item.id,
            verdict: "still_valid" as const,
          })),
        };
      },
    } as unknown as ExtractionEngine;
    const coordinator = new ContradictionLinkingCoordinator({
      getConfig: () => config,
      isSearchAvailable: () => false,
      searchAcrossNamespaces: async () => [],
      extractMemoryIdsFromResults: () => [],
      namespaceFromPath: () => "default",
      storageForNamespace: async () => storage,
      getExtraction: () => extraction,
    });

    const outcome = await coordinator.applyDeferredContradictionResolve(
      {
        supersededId: "old",
        reason: "city changed",
        supersededPath: activeCold.path,
        supersededCreated: activeCold.frontmatter.created,
        supersededTags: [],
      },
      storage,
      "new",
      false,
    );

    assert.equal(outcome, "resolved");
    assert.deepEqual(revalidationInput, {
      superseded: { id: "old", content: "canonical cold contradiction" },
      dependents: [{ id: "dependent", content: "dependent claim" }],
    });
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
test("preserves the anchor when the supersede race target is missing", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-contradiction-missing-race-"));
  try {
    const config = baseConfig(memoryDir, { contradictionAutoResolve: true });
    const old = {
      path: path.join(memoryDir, "old.md"),
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
      },
    } as unknown as MemoryFile;
    const losing = {
      ...old,
      path: path.join(memoryDir, "new.md"),
      content: "Alice lives in Boston",
      frontmatter: {
        ...old.frontmatter,
        id: "new",
        supersedes: "old",
      },
    } as unknown as MemoryFile;
    let clearCalls = 0;
    const storage = {
      dir: memoryDir,
      getMemoryById: async (id: string) => (id === "old" ? old : id === "new" ? losing : null),
      readAllMemories: async () => [],
      readAllColdMemories: async () => [],
      supersedeMemory: async () => false,
      writeMemoryFrontmatter: async () => {
        clearCalls += 1;
        return true;
      },
    } as unknown as StorageManager;
    const coordinator = new ContradictionLinkingCoordinator({
      getConfig: () => config,
      isSearchAvailable: () => false,
      searchAcrossNamespaces: async () => [],
      extractMemoryIdsFromResults: () => [],
      namespaceFromPath: () => "default",
      storageForNamespace: async () => storage,
      getExtraction: () => ({}) as ExtractionEngine,
    });

    const outcome = await coordinator.applyDeferredContradictionResolve(
      {
        supersededId: "old",
        reason: "city changed",
        supersededPath: old.path,
        supersededCreated: old.frontmatter.created,
        supersededTags: [],
      },
      storage,
      "new",
      false,
    );

    assert.equal(outcome, "supersede_failed");
    assert.equal(old.frontmatter.status, "active");
    assert.equal(losing.frontmatter.supersedes, "old");
    assert.equal(clearCalls, 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("clears the canonical active new-memory copy after a confirmed race", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-contradiction-new-copy-race-"));
  try {
    const config = baseConfig(memoryDir, { contradictionAutoResolve: true });
    const inactiveTarget = {
      path: path.join(memoryDir, "old.md"),
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
        status: "superseded",
      },
    } as unknown as MemoryFile;
    const losingHot = {
      ...inactiveTarget,
      path: path.join(memoryDir, "new.md"),
      content: "Alice lives in Boston",
      frontmatter: {
        ...inactiveTarget.frontmatter,
        id: "new",
        status: "superseded",
        supersedes: "old",
      },
    } as unknown as MemoryFile;
    const losingCold = {
      ...losingHot,
      path: path.join(memoryDir, "cold", "new.md"),
      frontmatter: {
        ...losingHot.frontmatter,
        status: "active",
      },
    } as unknown as MemoryFile;
    const clearedPaths: string[] = [];
    const storage = {
      dir: memoryDir,
      getMemoryById: async (id: string) =>
        id === "old" ? inactiveTarget : id === "new" ? losingHot : null,
      readAllMemories: async () => [inactiveTarget, losingHot],
      readAllColdMemories: async () => [losingCold],
      supersedeMemory: async () => false,
      writeMemoryFrontmatter: async (memory: MemoryFile) => {
        clearedPaths.push(memory.path);
        memory.frontmatter.supersedes = undefined;
        return true;
      },
    } as unknown as StorageManager;
    const coordinator = new ContradictionLinkingCoordinator({
      getConfig: () => config,
      isSearchAvailable: () => false,
      searchAcrossNamespaces: async () => [],
      extractMemoryIdsFromResults: () => [],
      namespaceFromPath: () => "default",
      storageForNamespace: async () => storage,
      getExtraction: () => ({}) as ExtractionEngine,
    });

    const outcome = await coordinator.applyDeferredContradictionResolve(
      {
        supersededId: "old",
        reason: "city changed",
        supersededPath: inactiveTarget.path,
        supersededCreated: inactiveTarget.frontmatter.created,
        supersededTags: [],
      },
      storage,
      "new",
      false,
    );

    assert.equal(outcome, "lost_race");
    assert.deepEqual(clearedPaths, [losingCold.path]);
    assert.equal(losingHot.frontmatter.supersedes, "old");
    assert.equal(losingCold.frontmatter.supersedes, undefined);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
test("preserves the anchor when the canonical new-memory copy is unreadable or inactive", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-contradiction-new-missing-race-"));
  try {
    const config = baseConfig(memoryDir, { contradictionAutoResolve: true });
    const inactiveTarget = {
      path: path.join(memoryDir, "old.md"),
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
        status: "superseded",
      },
    } as unknown as MemoryFile;
    const inactiveLosing = {
      ...inactiveTarget,
      path: path.join(memoryDir, "new.md"),
      content: "Alice lives in Boston",
      frontmatter: {
        ...inactiveTarget.frontmatter,
        id: "new",
        supersedes: "old",
      },
    } as unknown as MemoryFile;
    let hotMemories: MemoryFile[] = [inactiveTarget];
    let clearCalls = 0;
    const storage = {
      dir: memoryDir,
      getMemoryById: async (id: string) => (id === "old" ? inactiveTarget : null),
      readAllMemories: async () => hotMemories,
      readAllColdMemories: async () => [],
      supersedeMemory: async () => false,
      writeMemoryFrontmatter: async () => {
        clearCalls += 1;
        return true;
      },
    } as unknown as StorageManager;
    const coordinator = new ContradictionLinkingCoordinator({
      getConfig: () => config,
      isSearchAvailable: () => false,
      searchAcrossNamespaces: async () => [],
      extractMemoryIdsFromResults: () => [],
      namespaceFromPath: () => "default",
      storageForNamespace: async () => storage,
      getExtraction: () => ({}) as ExtractionEngine,
    });
    const contradiction = {
      supersededId: "old",
      reason: "city changed",
      supersededPath: inactiveTarget.path,
      supersededCreated: inactiveTarget.frontmatter.created,
      supersededTags: [],
    };

    const missingOutcome = await coordinator.applyDeferredContradictionResolve(
      contradiction,
      storage,
      "new",
      false,
    );
    hotMemories = [inactiveTarget, inactiveLosing];
    const inactiveOutcome = await coordinator.applyDeferredContradictionResolve(
      contradiction,
      storage,
      "new",
      false,
    );

    assert.equal(missingOutcome, "supersede_failed");
    assert.equal(inactiveOutcome, "supersede_failed");
    assert.equal(inactiveTarget.frontmatter.status, "superseded");
    assert.equal(inactiveLosing.frontmatter.supersedes, "old");
    assert.equal(clearCalls, 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
test("preserves the anchor when supersede I/O throws", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-contradiction-supersede-io-"));
  try {
    const config = baseConfig(memoryDir, { contradictionAutoResolve: true });
    const old = {
      path: path.join(memoryDir, "old.md"),
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
      },
    } as unknown as MemoryFile;
    const storage = {
      dir: memoryDir,
      getMemoryById: async (id: string) => (id === "old" ? old : null),
      readAllColdMemories: async () => [],
      supersedeMemory: async () => {
        throw new Error("supersede I/O failed");
      },
    } as unknown as StorageManager;
    const coordinator = new ContradictionLinkingCoordinator({
      getConfig: () => config,
      isSearchAvailable: () => false,
      searchAcrossNamespaces: async () => [],
      extractMemoryIdsFromResults: () => [],
      namespaceFromPath: () => "default",
      storageForNamespace: async () => storage,
      getExtraction: () => ({}) as ExtractionEngine,
    });

    const outcome = await coordinator.applyDeferredContradictionResolve(
      {
        supersededId: "old",
        reason: "city changed",
        supersededPath: old.path,
        supersededCreated: old.frontmatter.created,
        supersededTags: [],
      },
      storage,
      "new",
      false,
    );
    assert.equal(outcome, "supersede_failed");
    assert.equal(old.frontmatter.status, "active");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("preserves the anchor when a losing supersedes clear fails", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-contradiction-clear-io-"));
  try {
    const config = baseConfig(memoryDir, { contradictionAutoResolve: true });
    const old = {
      path: path.join(memoryDir, "old.md"),
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
      },
    } as unknown as MemoryFile;
    const losing = {
      path: path.join(memoryDir, "new.md"),
      content: "Alice lives in Boston",
      frontmatter: {
        ...old.frontmatter,
        id: "new",
        supersedes: "old",
      },
    } as unknown as MemoryFile;
    const storage = {
      dir: memoryDir,
      getMemoryById: async (id: string) => (id === "old" ? old : id === "new" ? losing : null),
      readAllColdMemories: async () => [],
      supersedeMemory: async () => {
        old.frontmatter.status = "superseded";
        return false;
      },
      writeMemoryFrontmatter: async () => {
        throw new Error("supersedes clear I/O failed");
      },
    } as unknown as StorageManager;
    const coordinator = new ContradictionLinkingCoordinator({
      getConfig: () => config,
      isSearchAvailable: () => false,
      searchAcrossNamespaces: async () => [],
      extractMemoryIdsFromResults: () => [],
      namespaceFromPath: () => "default",
      storageForNamespace: async () => storage,
      getExtraction: () => ({}) as ExtractionEngine,
    });

    const outcome = await coordinator.applyDeferredContradictionResolve(
      {
        supersededId: "old",
        reason: "city changed",
        supersededPath: old.path,
        supersededCreated: old.frontmatter.created,
        supersededTags: [],
      },
      storage,
      "new",
      false,
    );
    assert.equal(outcome, "supersedes_clear_failed");
    assert.equal(old.frontmatter.status, "superseded");
    assert.equal(losing.frontmatter.supersedes, "old");
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
test("supersedeMemory skips an inactive hot duplicate and updates the active cold copy", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-supersede-duplicate-tier-"));
  try {
    const orchestrator = new Orchestrator(baseConfig(memoryDir, { tombstonesEnabled: false })) as unknown as {
      getStorage: (namespace: string) => Promise<StorageManager>;
    };
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();
    const { id } = await storage.writeMemory("fact", "Alice lives in Austin", { source: "test" });
    const hot = (await storage.readAllMemories()).find((memory) => memory.frontmatter.id === id);
    assert.ok(hot);
    assert.equal((await storage.migrateMemoryToTier(hot, "cold")).changed, true);
    const cold = (await storage.readAllColdMemories()).find((memory) => memory.frontmatter.id === id);
    assert.ok(cold);

    const hotPath = storage.buildTierMemoryPath(cold, "hot");
    await mkdir(path.dirname(hotPath), { recursive: true });
    await writeFile(hotPath, await readFile(cold.path));
    const hotDuplicate = await storage.readMemoryByPath(hotPath);
    assert.ok(hotDuplicate);
    await storage.writeMemoryFrontmatter(hotDuplicate, {
      status: "superseded",
      supersededBy: "older-replacement",
    });

    assert.equal(await storage.supersedeMemory(id, "replacement", "city changed"), true);
    const updatedCold = (await storage.readAllColdMemories()).find((memory) => memory.frontmatter.id === id);
    assert.ok(updatedCold);
    assert.equal(updatedCold.frontmatter.status, "superseded");
    assert.equal(updatedCold.frontmatter.supersededBy, "replacement");
    const unchangedHot = await storage.readMemoryByPath(hotPath);
    assert.equal(unchangedHot?.frontmatter.supersededBy, "older-replacement");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
test("committed cold supersession returns true when correction audit fails", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-supersede-cold-audit-failure-"));
  try {
    const orchestrator = new Orchestrator(baseConfig(memoryDir, { tombstonesEnabled: false })) as unknown as {
      getStorage: (namespace: string) => Promise<StorageManager>;
    };
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();
    const { id } = await storage.writeMemory("fact", "Alice lives in Austin", {
      entityRef: "person:alice",
      source: "test",
    });
    const hot = (await storage.readAllMemories()).find((memory) => memory.frontmatter.id === id);
    assert.ok(hot);
    assert.equal((await storage.migrateMemoryToTier(hot, "cold")).changed, true);

    storage.writeSealedMemory = async () => {
      throw new Error("correction audit failed");
    };

    assert.equal(await storage.supersedeMemory(id, "replacement", "city changed"), true);
    const cold = (await storage.readAllColdMemories()).find((memory) => memory.frontmatter.id === id);
    assert.ok(cold);
    assert.equal(cold.frontmatter.status, "superseded");
    assert.equal(cold.frontmatter.supersededBy, "replacement");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("failed cold supersession mutation returns false and preserves the active file", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-supersede-cold-mutation-failure-"));
  try {
    const orchestrator = new Orchestrator(baseConfig(memoryDir, { tombstonesEnabled: false })) as unknown as {
      getStorage: (namespace: string) => Promise<StorageManager>;
    };
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();
    const { id } = await storage.writeMemory("fact", "Alice lives in Austin", {
      entityRef: "person:alice",
      source: "test",
    });
    const hot = (await storage.readAllMemories()).find((memory) => memory.frontmatter.id === id);
    assert.ok(hot);
    assert.equal((await storage.migrateMemoryToTier(hot, "cold")).changed, true);
    const storageInternals = storage as unknown as {
      writeTombstoneBlockedFrontmatter: (...args: readonly unknown[]) => Promise<void>;
    };
    storageInternals.writeTombstoneBlockedFrontmatter = async () => {
      throw new Error("cold mutation failed");
    };

    assert.equal(await storage.supersedeMemory(id, "replacement", "city changed"), false);
    const cold = (await storage.readAllColdMemories()).find((memory) => memory.frontmatter.id === id);
    assert.ok(cold);
    assert.equal(cold.frontmatter.status, "active");
    assert.equal(cold.frontmatter.supersededBy, undefined);
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
async function assertQmdCandidateStatusIsNotSupersedable(
  status: "pending_review" | "rejected" | "quarantined" | "active",
  options: { archivedAt?: string; archivePath?: string; omitStatus?: boolean } = {},
): Promise<void> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), `remnic-contradiction-qmd-${status}-`));
  try {
    const config = baseConfig(memoryDir) as PluginConfig;
    const candidate = {
      path: options.archivePath
        ? path.join(memoryDir, options.archivePath)
        : `/synthetic/default/${status}.md`,
      content: "Alice lives in Austin",
      frontmatter: {
        id: `candidate-${status}`,
        category: "fact",
        created: "2026-08-01T00:00:00.000Z",
        updated: "2026-08-01T00:00:00.000Z",
        source: "test",
        confidence: 0.9,
        confidenceTier: "explicit",
        tags: [],
        ...(options.omitStatus ? {} : { status }),
        ...(options.archivedAt ? { archivedAt: options.archivedAt } : {}),
      },
    } as unknown as MemoryFile;
    const storage = {
      dir: memoryDir,
      readAllMemories: async () => [],
      readAllColdMemories: async () => [],
      getMemoryById: async (id: string) => (id === candidate.frontmatter.id ? candidate : null),
    } as never as StorageManager;
    let verificationCalls = 0;
    const extraction = {
      verifyContradiction: async () => {
        verificationCalls++;
        return {
          isContradiction: true,
          confidence: 0.99,
          reasoning: "city changed",
          whichIsNewer: "second",
        };
      },
    } as unknown as ExtractionEngine;
    const coordinator = new ContradictionLinkingCoordinator({
      getConfig: () => config,
      isSearchAvailable: () => true,
      searchAcrossNamespaces: async () => [
        {
          docid: candidate.path,
          path: candidate.path,
          snippet: candidate.content,
          score: 0.99,
        },
      ],
      extractMemoryIdsFromResults: () => [candidate.frontmatter.id],
      namespaceFromPath: () => "default",
      storageForNamespace: async () => storage,
      getExtraction: () => extraction,
    });

    const contradiction = await coordinator.checkForContradiction(
      "Alice lives in New York",
      "fact",
      "default",
    );

    assert.equal(contradiction, null);
    assert.equal(verificationCalls, 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
}

test("QMD contradiction candidates in pending_review are not eligible for supersession", async () => {
  await assertQmdCandidateStatusIsNotSupersedable("pending_review");
});

test("QMD contradiction candidates in rejected are not eligible for supersession", async () => {
  await assertQmdCandidateStatusIsNotSupersedable("rejected");
});

test("QMD contradiction candidates in quarantined are not eligible for supersession", async () => {
  await assertQmdCandidateStatusIsNotSupersedable("quarantined");
});

test("QMD active candidates with archivedAt are not eligible for supersession", async () => {
  await assertQmdCandidateStatusIsNotSupersedable("active", {
    archivedAt: "2026-08-08T00:00:00.000Z",
  });
});

test("QMD candidates under archive paths are not eligible without raw status", async () => {
  await assertQmdCandidateStatusIsNotSupersedable("active", {
    archivePath: "archive/archived.md",
    omitStatus: true,
  });
});

test("live contradiction linking excludes support passport QMD candidates", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-contradiction-passport-qmd-"));
  try {
    const config = baseConfig(memoryDir) as PluginConfig;
    const candidate = {
      path: path.join(memoryDir, "facts", "passport.md"),
      content: "I need written instructions.",
      frontmatter: {
        id: "passport-card",
        category: "preference",
        created: "2026-08-01T00:00:00.000Z",
        updated: "2026-08-01T00:00:00.000Z",
        source: "support-passport",
        confidence: 1,
        confidenceTier: "explicit",
        tags: ["support-passport-card"],
        status: "active",
      },
    } as unknown as MemoryFile;
    const storage = {
      dir: memoryDir,
      readAllMemories: async () => [],
      readAllColdMemories: async () => [],
      getMemoryById: async () => candidate,
    } as never as StorageManager;
    let verificationCalls = 0;
    const coordinator = new ContradictionLinkingCoordinator({
      getConfig: () => config,
      isSearchAvailable: () => true,
      searchAcrossNamespaces: async () => [{
        docid: candidate.path,
        path: candidate.path,
        snippet: candidate.content,
        score: 0.99,
      }],
      extractMemoryIdsFromResults: () => [candidate.frontmatter.id],
      namespaceFromPath: () => "default",
      storageForNamespace: async () => storage,
      getExtraction: () => ({
        verifyContradiction: async () => {
          verificationCalls++;
          return null;
        },
      }) as unknown as ExtractionEngine,
    });

    const contradiction = await coordinator.checkForContradiction(
      "New preference",
      "preference",
      "default",
    );

    assert.equal(contradiction, null);
    assert.equal(verificationCalls, 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("live contradiction linking excludes support passport anchor candidates", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-contradiction-passport-anchor-"));
  try {
    const config = baseConfig(memoryDir) as PluginConfig;
    const candidate = {
      path: path.join(memoryDir, "facts", "passport.md"),
      content: "I need written instructions.",
      frontmatter: {
        id: "passport-card",
        category: "preference",
        created: "2026-08-01T00:00:00.000Z",
        updated: "2026-08-01T00:00:00.000Z",
        source: "support-passport",
        confidence: 1,
        confidenceTier: "explicit",
        tags: ["support-passport-card"],
        status: "active",
        entityRef: "person:owner",
      },
    } as unknown as MemoryFile;
    const storage = {
      dir: memoryDir,
      readAllMemories: async () => [candidate],
      readAllColdMemories: async () => [],
      getMemoryById: async () => candidate,
    } as never as StorageManager;
    let verificationCalls = 0;
    const coordinator = new ContradictionLinkingCoordinator({
      getConfig: () => config,
      isSearchAvailable: () => false,
      searchAcrossNamespaces: async () => [],
      extractMemoryIdsFromResults: () => [],
      namespaceFromPath: () => "default",
      storageForNamespace: async () => storage,
      getExtraction: () => ({
        verifyContradiction: async () => {
          verificationCalls++;
          return null;
        },
      }) as unknown as ExtractionEngine,
    });

    const contradiction = await coordinator.checkForContradiction(
      "New preference",
      "preference",
      "default",
      { entityRef: "person:owner", storageSnapshot: [candidate] },
    );

    assert.equal(contradiction, null);
    assert.equal(verificationCalls, 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
