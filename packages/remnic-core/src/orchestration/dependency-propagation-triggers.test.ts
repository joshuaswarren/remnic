import assert from "node:assert/strict";
import test from "node:test";
import { applyTemporalSupersession } from "../temporal-supersession.js";
import { ContradictionLinkingCoordinator } from "./contradiction-linking-coordinator.js";
import { ConsolidationRunCoordinator } from "./consolidation-run.js";
import type { ExtractionEngine } from "../extraction.js";
import type { MemoryFile, PluginConfig } from "../types.js";
import type { StorageManager } from "../storage.js";

const NOW = "2026-08-08T00:00:00.000Z";

function makeMemory(
  id: string,
  options: {
    links?: Array<{ targetId: string; linkType: "supports" | "follows" }>;
    status?: string;
    content?: string;
    entityRef?: string;
    structuredAttributes?: Record<string, string>;
  } = {},
): MemoryFile {
  return {
    path: `/synthetic/${id}.md`,
    content: options.content ?? `claim for ${id}`,
    frontmatter: {
      id,
      category: "fact",
      created: NOW,
      updated: NOW,
      source: "synthetic-trigger-test",
      confidence: 0.9,
      confidenceTier: "explicit",
      tags: [],
      status: (options.status ?? "active") as MemoryFile["frontmatter"]["status"],
      links: options.links?.map((link) => ({ ...link, strength: 0.9 })),
      entityRef: options.entityRef,
      structuredAttributes: options.structuredAttributes,
    },
  } as unknown as MemoryFile;
}

function propagationConfig(): PluginConfig {
  return {
    memoryDir: "/synthetic/remnic-trigger-tests",
    queryAwareIndexingEnabled: false,
    contradictionAutoResolve: true,
    contradictionSimilarityThreshold: 0.7,
    contradictionMinConfidence: 0.8,
    dependencyPropagation: {
      enabled: true,
      linkTypes: ["supports", "follows"],
      maxDependents: 10,
      timeoutMs: 50,
      dryRun: false,
    },
  } as unknown as PluginConfig;
}

type TriggerStorage = {
  memories: Map<string, MemoryFile>;
  supersedeCalls: Array<{ id: string; replacementId: string; reason: string }>;
  frontmatterCalls: Array<{ id: string; patch: Record<string, unknown> }>;
  invalidateCalls: string[];
  storage: StorageManager;
};

function makeStorage(initial: MemoryFile[]): TriggerStorage {
  const memories = new Map(initial.map((item) => [item.frontmatter.id, item]));
  const supersedeCalls: TriggerStorage["supersedeCalls"] = [];
  const frontmatterCalls: TriggerStorage["frontmatterCalls"] = [];
  const invalidateCalls: string[] = [];
  const storage = {
    memories,
    supersedeCalls,
    frontmatterCalls,
    invalidateCalls,
    async getMemoryById(id: string): Promise<MemoryFile | null> {
      return memories.get(id) ?? null;
    },
    async readAllMemories(): Promise<MemoryFile[]> {
      return [...memories.values()];
    },
    async readAllColdMemories(): Promise<MemoryFile[]> {
      return [];
    },
    async readMemoryByPath(path: string): Promise<MemoryFile | null> {
      return [...memories.values()].find((memory) => memory.path === path) ?? null;
    },
    async readProfile(): Promise<string> {
      return "";
    },
    async appendTombstone(): Promise<void> {},
    async mergeFragmentedEntities(): Promise<number> {
      return 0;
    },
    async cleanExpiredCommitments(): Promise<MemoryFile[]> {
      return [];
    },
    async cleanExpiredTTL(): Promise<MemoryFile[]> {
      return [];
    },
    async profileNeedsConsolidation(): Promise<boolean> {
      return false;
    },
    async loadMeta(): Promise<Record<string, unknown>> {
      return {};
    },
    async saveMeta(): Promise<void> {},
    async supersedeMemory(id: string, replacementId: string, reason: string): Promise<boolean> {
      supersedeCalls.push({ id, replacementId, reason });
      const current = memories.get(id);
      if (!current) return false;
      current.frontmatter.status = "superseded";
      current.frontmatter.supersededBy = replacementId;
      return true;
    },
    async writeMemoryFrontmatter(current: MemoryFile, patch: Record<string, unknown>): Promise<boolean> {
      frontmatterCalls.push({ id: current.frontmatter.id, patch });
      const stored = memories.get(current.frontmatter.id);
      if (!stored) return false;
      Object.assign(stored.frontmatter, patch);
      return true;
    },
    async invalidateMemory(id: string): Promise<boolean> {
      invalidateCalls.push(id);
      return memories.delete(id);
    },
  } as unknown as StorageManager;
  return { memories, supersedeCalls, frontmatterCalls, invalidateCalls, storage };
}

function makeRevalidationExtraction(
  revalidateCalls: Array<unknown>,
): ExtractionEngine {
  return {
    async revalidateDependents(
      superseded: { id: string; content: string },
      replacement: { id: string; content: string } | null,
      dependents: Array<{ id: string; category: string; content: string }>,
      signal?: AbortSignal,
    ) {
      revalidateCalls.push({ superseded, replacement, dependents, signal });
      return {
        verdicts: dependents.map((dependent) => ({
          memoryId: dependent.id,
          verdict: "invalidated",
          reason: "supporting claim changed",
        })),
      };
    },
  } as unknown as ExtractionEngine;
}

test("contradiction resolve propagates after superseding the captured old memory", async () => {
  const old = makeMemory("old", { links: [{ targetId: "dependent", linkType: "supports" }] });
  const replacement = makeMemory("replacement", { content: "new claim" });
  const dependent = makeMemory("dependent");
  const fixture = makeStorage([old, replacement, dependent]);
  const revalidateCalls: unknown[] = [];
  const extraction = makeRevalidationExtraction(revalidateCalls);
  const config = propagationConfig();
  const coordinator = new ContradictionLinkingCoordinator({
    getConfig: () => config,
    isSearchAvailable: () => false,
    searchAcrossNamespaces: async () => [],
    extractMemoryIdsFromResults: () => [],
    namespaceFromPath: () => "namespace-a",
    storageForNamespace: async () => fixture.storage,
    getExtraction: () => extraction,
  });

  await coordinator.applyDeferredContradictionResolve(
    {
      supersededId: "old",
      reason: "newer contradiction",
      supersededPath: old.path,
      supersededCreated: old.frontmatter.created,
      supersededTags: [],
    },
    fixture.storage,
    "replacement",
    false,
  );

  assert.deepEqual(fixture.supersedeCalls, [
    { id: "old", replacementId: "replacement", reason: "newer contradiction" },
    { id: "dependent", replacementId: "replacement", reason: "dependency_propagation:contradiction" },
  ]);
  assert.equal(fixture.memories.get("dependent")?.frontmatter.supersessionCause, "dependency");
  assert.equal(fixture.memories.get("dependent")?.frontmatter.invalidatedBy, "old");
  assert.equal(revalidateCalls.length, 1);
});

test("temporal supersession propagates to a dependent after the old fact is retired", async () => {
  const old = makeMemory("old", {
    entityRef: "project-a",
    structuredAttributes: { city: "Austin" },
    links: [{ targetId: "dependent", linkType: "supports" }],
  });
  const replacement = makeMemory("replacement", {
    entityRef: "project-a",
    structuredAttributes: { city: "Boston" },
    content: "project-a moved to Boston",
  });
  replacement.frontmatter.created = "2026-08-09T00:00:00.000Z";
  const dependent = makeMemory("dependent");
  const fixture = makeStorage([old, replacement, dependent]);
  const revalidateCalls: unknown[] = [];
  const extraction = makeRevalidationExtraction(revalidateCalls);
  const temporalArgs = {
    storage: fixture.storage,
    newMemoryId: "replacement",
    entityRef: "project-a",
    structuredAttributes: { city: "Boston" },
    createdAt: "2026-08-09T00:00:00.000Z",
    enabled: true,
    extraction,
    config: propagationConfig(),
    namespaceScope: "namespace-a",
  };

  const result = await (applyTemporalSupersession as unknown as (args: typeof temporalArgs) => Promise<{
    supersededIds: string[];
  }>)(temporalArgs);

  assert.deepEqual(result.supersededIds, ["old"]);
  assert.equal(fixture.memories.get("dependent")?.frontmatter.invalidatedBy, "old");
  assert.equal(revalidateCalls.length, 1);
});

test("consolidation INVALIDATE captures links before deletion with query-aware indexing disabled", async () => {
  const doomed = makeMemory("doomed", { links: [{ targetId: "dependent", linkType: "supports" }] });
  const dependent = makeMemory("dependent");
  const fillers = ["filler-a", "filler-b", "filler-c"].map((id) => makeMemory(id));
  const fixture = makeStorage([doomed, dependent, ...fillers]);
  const revalidateCalls: unknown[] = [];
  const extraction = {
    ...makeRevalidationExtraction(revalidateCalls),
    async consolidate() {
      return {
        items: [{ existingId: "doomed", action: "INVALIDATE", reason: "duplicate" }],
        profileUpdates: [],
        entityUpdates: [],
      };
    },
  } as unknown as ExtractionEngine;
  const config = propagationConfig();
  const coordinator = new ConsolidationRunCoordinator({
    config,
    getStorage: () => fixture.storage,
    getStorageRouter: () => ({ recordWrite: async () => {} }) as never,
    getExtraction: () => extraction,
    embeddingFallback: { removeFromIndex: async () => {} } as never,
    tmtBuilder: { maybeRebuildNodes: async () => {} } as never,
    consolidationObservers: new Set(),
    getAccessTrackingBuffer: () => new Map(),
    lifecyclePolicyCoordinator: {
      runFactArchival: async () => 0,
      runSummarization: async () => {},
      runTopicExtraction: async () => {},
    } as never,
    compressionGuidelineCoordinator: {
      runCompressionGuidelineLearningPass: async () => {},
    } as never,
    semanticConsolidationCoordinator: {} as never,
    entitySynthesisCoordinator: {} as never,
    recallSectionCoordinator: {
      getRecallSectionEntry: () => undefined,
    } as never,
    tierMigrationCoordinator: {
      runCycle: async () => ({ migrated: 0 }),
    } as never,
    flushAccessTracking: async () => {},
    indexPersistedMemory: async () => {},
    autoConsolidateIdentity: async () => {},
    fastChatCompletion: async () => null,
  });

  await coordinator.run();

  assert.deepEqual(fixture.invalidateCalls, ["doomed"]);
  assert.equal(fixture.memories.has("doomed"), false);
  assert.equal(fixture.memories.get("dependent")?.frontmatter.status, "superseded");
  assert.equal(fixture.memories.get("dependent")?.frontmatter.invalidatedBy, "doomed");
  assert.equal(revalidateCalls.length, 1);
});
