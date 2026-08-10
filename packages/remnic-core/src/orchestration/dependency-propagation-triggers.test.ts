import assert from "node:assert/strict";
import test from "node:test";
import { applyTemporalSupersession } from "../temporal-supersession.js";
import { ContradictionLinkingCoordinator } from "./contradiction-linking-coordinator.js";
import { ConsolidationRunCoordinator } from "./consolidation-run.js";
import type { ExtractionEngine } from "../extraction.js";
import type { MemoryFile, PluginConfig } from "../types.js";
import type { StorageManager } from "../storage.js";
import { propagateInvalidation, type PropagationEvent } from "./dependency-propagation.js";
import type { DependencyPropagationPreparationToken } from "./dependency-propagation-delivery.js";

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
type TombstoneInput = Parameters<StorageManager["appendTombstone"]>[0];


type TriggerStorage = {
  memories: Map<string, MemoryFile>;
  supersedeCalls: Array<{ id: string; replacementId: string; reason: string }>;
  tombstoneInputs: TombstoneInput[];
  tombstoneIds: Array<string | null>;
  frontmatterCalls: Array<{ id: string; patch: Record<string, unknown> }>;
  invalidateCalls: string[];
  order: string[];
  storage: StorageManager;
};

type SyntheticImmediateDelivery = {
  prepare(event: PropagationEvent): Promise<DependencyPropagationPreparationToken | null>;
  afterMutation(token: DependencyPropagationPreparationToken | null, event: PropagationEvent): Promise<void>;
  cancel(token: DependencyPropagationPreparationToken | null): Promise<void>;
  deferPrepared(token: DependencyPropagationPreparationToken | null): Promise<void>;
};

type SyntheticImmediateDeliveryOptions = {
  prepareReturnsNull?: boolean;
  requireExactReplacement?: boolean;
};

function makeSyntheticImmediateDelivery(
  storage: StorageManager,
  extraction: ExtractionEngine,
  config: PluginConfig,
  order: string[],
  options: SyntheticImmediateDeliveryOptions = {},
): SyntheticImmediateDelivery {
  const prepared = new Map<string, PropagationEvent>();
  let nextJob = 0;
  return {
    async prepare(event) {
      order.push(`prepare:${event.cause}`);
      if (options.prepareReturnsNull) return null;
      const jobId = `synthetic-job-${++nextJob}`;
      prepared.set(jobId, event);
      return { jobId, revision: 0, ownsPreparedJob: true, reservationId: `reservation-${jobId}` };
    },
    async afterMutation(token, event) {
      if (token !== null) assert.ok(prepared.has(token.jobId));
      if (
        options.requireExactReplacement &&
        event.replacementId !== null &&
        event.replacementContent !== null
      ) {
        const replacement = await storage.getMemoryById(event.replacementId);
        if (!replacement || replacement.content !== event.replacementContent) return;
      }
      order.push(`afterMutation:${event.cause}`);
      order.push(`ready:${event.cause}`);
      await propagateInvalidation({ storage, extraction, config }, event);
    },
    async cancel(token) {
      if (token === null) {
        order.push("cancel:null");
        return;
      }
      const event = prepared.get(token.jobId);
      assert.ok(event);
      order.push(`cancel:${event.cause}`);
      prepared.delete(token.jobId);
    },
    async deferPrepared(token) {
      const event = token === null ? undefined : prepared.get(token.jobId);
      order.push(`defer:${event?.cause ?? "null"}`);
    },
  };
}

function assertReadyAfterMutation(
  order: string[],
  cause: PropagationEvent["cause"],
  primaryMutation: string,
): void {
  const prepare = order.indexOf(`prepare:${cause}`);
  const mutation = order.indexOf(primaryMutation);
  const afterMutation = order.indexOf(`afterMutation:${cause}`);
  const ready = order.indexOf(`ready:${cause}`);
  assert.ok(prepare >= 0);
  assert.ok(mutation >= 0);
  assert.ok(afterMutation >= 0);
  assert.ok(ready >= 0);
  assert.ok(prepare < mutation);
  assert.ok(mutation < afterMutation);
  assert.ok(afterMutation < ready);
}
function makeStorage(
  initial: MemoryFile[],
  options: {
    failSupersedeIds?: string[];
    partialSupersedeIds?: string[];
    failStateReadAfterSupersedeIds?: string[];
    failPrePrimaryReadIds?: string[];
    failInvalidateIds?: string[];
    throwAfterUpdateIds?: string[];
    partialFrontmatterIds?: string[];
    mutateBeforeInvalidateIds?: string[];
    touchAccessBeforeInvalidateIds?: string[];
  } = {},
): TriggerStorage {
  const memories = new Map(initial.map((item) => [item.frontmatter.id, item]));
  const tombstoneInputs: TombstoneInput[] = [];
  const tombstoneIds: Array<string | null> = [];
  const supersedeCalls: TriggerStorage["supersedeCalls"] = [];
  const frontmatterCalls: TriggerStorage["frontmatterCalls"] = [];
  const invalidateCalls: string[] = [];
  const failSupersedeIds = new Set(options.failSupersedeIds ?? []);
  const partialSupersedeIds = new Set(options.partialSupersedeIds ?? []);
  const failStateReadAfterSupersedeIds = new Set(options.failStateReadAfterSupersedeIds ?? []);
  const failPrePrimaryReadIds = new Set(options.failPrePrimaryReadIds ?? []);
  const failInvalidateIds = new Set(options.failInvalidateIds ?? []);
  const throwAfterUpdateIds = new Set(options.throwAfterUpdateIds ?? []);
  const partialFrontmatterIds = new Set(options.partialFrontmatterIds ?? []);
  const mutateBeforeInvalidateIds = new Set(options.mutateBeforeInvalidateIds ?? []);
  const touchAccessBeforeInvalidateIds = new Set(options.touchAccessBeforeInvalidateIds ?? []);
  const order: string[] = [];
  const storage = {
    memories,
    supersedeCalls,
    tombstoneInputs,
    tombstoneIds,
    frontmatterCalls,
    invalidateCalls,
    order,
    async getMemoryById(id: string): Promise<MemoryFile | null> {
      if (
        failPrePrimaryReadIds.has(id) &&
        order.some((entry) => entry.startsWith("prepare:consolidation_"))
      ) {
        throw new Error("synthetic pre-primary read failure");
      }
      if (failStateReadAfterSupersedeIds.has(id) && order.includes(`supersede:${id}`)) {
        throw new Error("synthetic post-mutation read failure");
      }
      return memories.get(id) ?? null;
    },
    async readAllMemories(): Promise<MemoryFile[]> {
      return [...memories.values()];
    },
    async readAllColdMemories(): Promise<MemoryFile[]> {
      return [];
    },
    async readMemoryByPath(memoryPath: string): Promise<MemoryFile | null> {
      return [...memories.values()].find((memory) => memory.path === memoryPath) ?? null;
    },
    async getMemoryTimeline(): Promise<[]> {
      return [];
    },
    async readProfile(): Promise<string> {
      return "";
    },
    async appendTombstone(input: TombstoneInput): Promise<string | null> {
      const recordedInput = structuredClone(input);
      const returnedId = `synthetic-tombstone-${input.sourceMemoryId}`;
      tombstoneInputs.push(recordedInput);
      tombstoneIds.push(returnedId);
      return returnedId;
    },
    async hasExactTombstone(input: TombstoneInput): Promise<boolean> {
      return tombstoneInputs.some((existing) =>
        existing.sourceMemoryId === input.sourceMemoryId &&
        existing.contentHash === input.contentHash &&
        existing.entityRef === input.entityRef &&
        existing.supersessionKey === input.supersessionKey &&
        existing.createdAt === input.createdAt &&
        existing.operationKey === input.operationKey
      );
    },
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
    async supersedeMemory(
      id: string,
      replacementId: string,
      reason: string,
      metadata?: Record<string, unknown>,
    ): Promise<boolean> {
      order.push(`supersede:${id}`);
      supersedeCalls.push({ id, replacementId, reason });
      const current = memories.get(id);
      if (!current || failSupersedeIds.has(id)) return false;
      Object.assign(current.frontmatter, metadata, {
        status: "superseded",
        supersededBy: replacementId,
      });
      if (partialSupersedeIds.has(id)) return false;
      return true;
    },
    async writeMemoryFrontmatter(current: MemoryFile, patch: Record<string, unknown>): Promise<boolean> {
      order.push(`frontmatter:${current.frontmatter.id}`);
      frontmatterCalls.push({ id: current.frontmatter.id, patch });
      const stored = memories.get(current.frontmatter.id);
      if (!stored) return false;
      Object.assign(stored.frontmatter, patch);
      if (partialFrontmatterIds.has(current.frontmatter.id)) return false;
      return true;
    },
    async writeMemoryFrontmatterIfUnchanged(
      current: MemoryFile,
      patch: Record<string, unknown>,
    ): Promise<boolean> {
      return storage.writeMemoryFrontmatter(current, patch);
    },
    async invalidateMemory(
      id: string,
      expectedSnapshot?: Pick<MemoryFile, "content" | "frontmatter">,
    ): Promise<boolean> {
      order.push(`invalidate:${id}`);
      invalidateCalls.push(id);
      if (failInvalidateIds.has(id)) return false;
      const current = memories.get(id);
      if (!current) return false;
      if (mutateBeforeInvalidateIds.has(id)) {
        current.content = "concurrent source update";
        mutateBeforeInvalidateIds.delete(id);
      }
      if (touchAccessBeforeInvalidateIds.has(id)) {
        current.frontmatter.accessCount = 4;
        current.frontmatter.lastAccessed = "2026-08-10T00:00:00.000Z";
        touchAccessBeforeInvalidateIds.delete(id);
      }
      if (
        expectedSnapshot &&
        (current.content !== expectedSnapshot.content ||
          JSON.stringify({ ...current.frontmatter, accessCount: undefined, lastAccessed: undefined }) !==
            JSON.stringify({
              ...expectedSnapshot.frontmatter,
              accessCount: undefined,
              lastAccessed: undefined,
            }))
      ) {
        return false;
      }
      return memories.delete(id);
    },
    async updateMemory(
      id: string,
      newContent: string,
      patch?: { supersedes?: string; lineage?: string[] },
    ): Promise<boolean> {
      order.push(`update:${id}`);
      const current = memories.get(id);
      if (!current) return false;
      current.content = newContent;
      if (patch?.supersedes !== undefined) current.frontmatter.supersedes = patch.supersedes;
      if (patch?.lineage !== undefined) current.frontmatter.lineage = patch.lineage;
      if (throwAfterUpdateIds.has(id)) {
        throw new Error("synthetic post-write update failure");
      }
      return true;
    },
  } as unknown as StorageManager;
  return {
    memories,
    supersedeCalls,
    tombstoneInputs,
    tombstoneIds,
    frontmatterCalls,
    invalidateCalls,
    order,
    storage,
  };
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

function makeContradictionCoordinator(
  fixture: TriggerStorage,
  extraction: ExtractionEngine,
  config: PluginConfig,
  delivery: SyntheticImmediateDelivery,
): ContradictionLinkingCoordinator {
  return new ContradictionLinkingCoordinator({
    getConfig: () => config,
    isSearchAvailable: () => false,
    searchAcrossNamespaces: async () => [],
    extractMemoryIdsFromResults: () => [],
    namespaceFromPath: () => "namespace-a",
    storageForNamespace: async () => fixture.storage,
    getExtraction: () => extraction,
    storageDirNamespace: () => "namespace-a",
    getDependencyPropagationDelivery: () => delivery,
  });
}

function makeConsolidationCoordinator(
  fixture: TriggerStorage,
  extraction: ExtractionEngine,
  config: PluginConfig,
  delivery: SyntheticImmediateDelivery,
): ConsolidationRunCoordinator {
  return new ConsolidationRunCoordinator({
    config,
    getStorage: () => fixture.storage,
    getStorageRouter: () => ({ recordWrite: async () => {} }) as never,
    getExtraction: () => extraction,
    storageDirNamespace: () => "namespace-a",
    getDependencyPropagationDelivery: () => delivery,
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
}

function makeConsolidationExtraction(
  revalidateCalls: Array<unknown>,
  item: Record<string, unknown>,
): ExtractionEngine {
  return {
    ...makeRevalidationExtraction(revalidateCalls),
    async consolidate() {
      return {
        items: [item],
        profileUpdates: [],
        entityUpdates: [],
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
  const dependencyPropagationDelivery = makeSyntheticImmediateDelivery(
    fixture.storage,
    extraction,
    config,
    fixture.order,
  );
  const coordinator = new ContradictionLinkingCoordinator({
    getConfig: () => config,
    isSearchAvailable: () => false,
    searchAcrossNamespaces: async () => [],
    extractMemoryIdsFromResults: () => [],
    namespaceFromPath: () => "namespace-a",
    storageForNamespace: async () => fixture.storage,
    getExtraction: () => extraction,
    storageDirNamespace: () => "namespace-a",
    getDependencyPropagationDelivery: () => dependencyPropagationDelivery,
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
  assertReadyAfterMutation(fixture.order, "contradiction", "supersede:old");
});

test("contradiction resolve skips propagation when replacement content is missing", async () => {
  const old = makeMemory("old", { links: [{ targetId: "dependent", linkType: "supports" }] });
  const dependent = makeMemory("dependent");
  const fixture = makeStorage([old, dependent]);
  const extraction = makeRevalidationExtraction([]);
  const config = propagationConfig();
  const delivery = makeSyntheticImmediateDelivery(
    fixture.storage,
    extraction,
    config,
    fixture.order,
  );
  const coordinator = makeContradictionCoordinator(fixture, extraction, config, delivery);

  await coordinator.applyDeferredContradictionResolve(
    {
      supersededId: "old",
      reason: "replacement unavailable",
      supersededPath: old.path,
      supersededCreated: old.frontmatter.created,
      supersededTags: [],
    },
    fixture.storage,
    "replacement",
    false,
  );

  assert.deepEqual(fixture.supersedeCalls, [
    { id: "old", replacementId: "replacement", reason: "replacement unavailable" },
  ]);
  assert.equal(fixture.order.some((entry) => entry === "prepare:contradiction"), false);
  assert.equal(fixture.memories.get("dependent")?.frontmatter.status, "active");
});
test("contradiction resolve skips dependent retirement when replacement content changes", async () => {
  const old = makeMemory("old", { links: [{ targetId: "dependent", linkType: "supports" }] });
  const replacement = makeMemory("replacement", { content: "captured claim" });
  const dependent = makeMemory("dependent");
  const fixture = makeStorage([old, replacement, dependent]);
  const extraction = makeRevalidationExtraction([]);
  const config = propagationConfig();
  const delivery = makeSyntheticImmediateDelivery(
    fixture.storage,
    extraction,
    config,
    fixture.order,
    { requireExactReplacement: true },
  );
  const originalSupersede = fixture.storage.supersedeMemory.bind(fixture.storage);
  fixture.storage.supersedeMemory = async (...args) => {
    const committed = await originalSupersede(...args);
    replacement.content = "changed claim";
    return committed;
  };
  const coordinator = makeContradictionCoordinator(fixture, extraction, config, delivery);

  await coordinator.applyDeferredContradictionResolve(
    {
      supersededId: "old",
      reason: "replacement changed",
      supersededPath: old.path,
      supersededCreated: old.frontmatter.created,
      supersededTags: [],
    },
    fixture.storage,
    "replacement",
    false,
  );

  assert.deepEqual(fixture.supersedeCalls, [
    { id: "old", replacementId: "replacement", reason: "replacement changed" },
  ]);
  assert.ok(fixture.order.includes("prepare:contradiction"));
  assert.equal(fixture.memories.get("dependent")?.frontmatter.status, "active");
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
  const config = propagationConfig();
  const dependencyPropagationDelivery = makeSyntheticImmediateDelivery(
    fixture.storage,
    extraction,
    config,
    fixture.order,
  );
  const temporalArgs = {
    storage: fixture.storage,
    newMemoryId: "replacement",
    entityRef: "project-a",
    structuredAttributes: { city: "Boston" },
    createdAt: "2026-08-09T00:00:00.000Z",
    enabled: true,
    extraction,
    config,
    namespaceScope: "namespace-a",
    dependencyPropagationDelivery,
  };

  const result = await (applyTemporalSupersession as unknown as (args: typeof temporalArgs) => Promise<{
    supersededIds: string[];
  }>)(temporalArgs);

  assert.deepEqual(result.supersededIds, ["old"]);
  assert.equal(fixture.memories.get("dependent")?.frontmatter.invalidatedBy, "old");
  assert.equal(revalidateCalls.length, 1);
  assertReadyAfterMutation(fixture.order, "temporal_supersession", "frontmatter:old");
  assert.equal(fixture.tombstoneInputs.length, 1);
  assert.deepEqual(fixture.tombstoneIds, ["synthetic-tombstone-old"]);
  const tombstone = fixture.tombstoneInputs[0];
  assert.equal(tombstone.reason, "supersession");
  assert.equal(tombstone.createdBy, "supersession");
  assert.equal(tombstone.sourceMemoryId, "old");
  assert.equal(tombstone.rawContent, old.content);
  assert.equal(tombstone.entityRef, "project-a");
  assert.equal(tombstone.supersessionKey, "project-a::city");
  assert.equal(tombstone.createdAt, "2026-08-09T00:00:00.000Z");
  assert.match(tombstone.operationKey ?? "", /^[a-f0-9]{64}:tombstone:project-a::city$/);

  const replay = await (applyTemporalSupersession as unknown as (args: typeof temporalArgs) => Promise<{
    supersededIds: string[];
  }>)(temporalArgs);
  assert.deepEqual(replay.supersededIds, []);
  assert.equal(fixture.tombstoneInputs.length, 1);
});
test("temporal supersession defers prepared recovery after a committed false mutation", async () => {
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
  const fixture = makeStorage([old, replacement, dependent], { partialFrontmatterIds: ["old"] });
  const extraction = makeRevalidationExtraction([]);
  const config = propagationConfig();
  const dependencyPropagationDelivery = makeSyntheticImmediateDelivery(
    fixture.storage,
    extraction,
    config,
    fixture.order,
  );

  const result = await (applyTemporalSupersession as unknown as (args: {
    storage: StorageManager;
    newMemoryId: string;
    entityRef: string;
    structuredAttributes: Record<string, string>;
    createdAt: string;
    enabled: boolean;
    extraction: ExtractionEngine;
    config: PluginConfig;
    namespaceScope: string;
    dependencyPropagationDelivery: SyntheticImmediateDelivery;
  }) => Promise<{ supersededIds: string[] }>)({
    storage: fixture.storage,
    newMemoryId: "replacement",
    entityRef: "project-a",
    structuredAttributes: { city: "Boston" },
    createdAt: "2026-08-09T00:00:00.000Z",
    enabled: true,
    extraction,
    config,
    namespaceScope: "namespace-a",
    dependencyPropagationDelivery,
  });

  assert.deepEqual(result.supersededIds, []);
  assert.equal(fixture.memories.get("old")?.frontmatter.status, "superseded");
  assert.ok(fixture.order.includes("defer:temporal_supersession"));
  assert.equal(fixture.order.includes("cancel:temporal_supersession"), false);
  assert.equal(fixture.tombstoneInputs.length, 0);
  assert.deepEqual(fixture.tombstoneIds, []);
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
      doomed.content = "current source snapshot";
      return {
        items: [{ existingId: "doomed", action: "INVALIDATE", reason: "duplicate" }],
        profileUpdates: [],
        entityUpdates: [],
      };
    },
  } as unknown as ExtractionEngine;
  const config = propagationConfig();
  const dependencyPropagationDelivery = makeSyntheticImmediateDelivery(
    fixture.storage,
    extraction,
    config,
    fixture.order,
  );
  const coordinator = new ConsolidationRunCoordinator({
    config,
    getStorage: () => fixture.storage,
    getStorageRouter: () => ({ recordWrite: async () => {} }) as never,
    getExtraction: () => extraction,
    storageDirNamespace: () => "namespace-a",
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
    getDependencyPropagationDelivery: () => dependencyPropagationDelivery,
  });

  await coordinator.run();

  assert.deepEqual(fixture.invalidateCalls, ["doomed"]);
  assert.equal(fixture.memories.has("doomed"), false);
  assert.equal(fixture.memories.get("dependent")?.frontmatter.status, "superseded");
  assert.equal(fixture.memories.get("dependent")?.frontmatter.invalidatedBy, "doomed");
  assert.equal(revalidateCalls.length, 1);
  assert.equal((revalidateCalls[0] as { superseded: { content: string } }).superseded.content, "current source snapshot");
  assertReadyAfterMutation(fixture.order, "consolidation_invalidate", "invalidate:doomed");
});

test("consolidation INVALIDATE does not delete after a concurrent source update", async () => {
  const doomed = makeMemory("doomed", { links: [{ targetId: "dependent", linkType: "supports" }] });
  const dependent = makeMemory("dependent");
  const fillers = ["filler-a", "filler-b", "filler-c"].map((id) => makeMemory(id));
  const fixture = makeStorage([doomed, dependent, ...fillers], {
    mutateBeforeInvalidateIds: ["doomed"],
  });
  const revalidateCalls: unknown[] = [];
  const extraction = makeConsolidationExtraction(revalidateCalls, {
    existingId: "doomed",
    action: "INVALIDATE",
    reason: "duplicate",
  });
  const config = propagationConfig();
  const delivery = makeSyntheticImmediateDelivery(fixture.storage, extraction, config, fixture.order);
  const coordinator = makeConsolidationCoordinator(fixture, extraction, config, delivery);

  await coordinator.run();

  assert.equal(fixture.memories.has("doomed"), true);
  assert.equal(fixture.memories.get("doomed")?.content, "concurrent source update");
  assert.equal(revalidateCalls.length, 0);
  assert.equal(fixture.order.includes("afterMutation:consolidation_invalidate"), false);
});
test("consolidation INVALIDATE preserves mutation semantics when propagation is disabled", async () => {
  const doomed = makeMemory("doomed", { links: [{ targetId: "dependent", linkType: "supports" }] });
  const dependent = makeMemory("dependent");
  const fillers = ["filler-a", "filler-b", "filler-c"].map((id) => makeMemory(id));
  const fixture = makeStorage([doomed, dependent, ...fillers], {
    mutateBeforeInvalidateIds: ["doomed"],
  });
  const revalidateCalls: unknown[] = [];
  const extraction = makeConsolidationExtraction(revalidateCalls, {
    existingId: "doomed",
    action: "INVALIDATE",
    reason: "duplicate",
  });
  const config = propagationConfig();
  config.dependencyPropagation.enabled = false;
  const delivery = makeSyntheticImmediateDelivery(fixture.storage, extraction, config, fixture.order);
  const coordinator = makeConsolidationCoordinator(fixture, extraction, config, delivery);

  await coordinator.run();

  assert.equal(fixture.memories.has("doomed"), false);
  assert.equal(fixture.invalidateCalls[0], "doomed");
  assert.equal(revalidateCalls.length, 0);
  assert.equal(fixture.order.some((entry) => entry.startsWith("prepare:")), false);
});


test("consolidation INVALIDATE deletes after an access-only source update", async () => {
  const doomed = makeMemory("doomed", { links: [{ targetId: "dependent", linkType: "supports" }] });
  const dependent = makeMemory("dependent");
  const fillers = ["filler-a", "filler-b", "filler-c"].map((id) => makeMemory(id));
  const fixture = makeStorage([doomed, dependent, ...fillers], {
    touchAccessBeforeInvalidateIds: ["doomed"],
  });
  const revalidateCalls: unknown[] = [];
  const extraction = makeConsolidationExtraction(revalidateCalls, {
    existingId: "doomed",
    action: "INVALIDATE",
    reason: "duplicate",
  });
  const config = propagationConfig();
  const delivery = makeSyntheticImmediateDelivery(fixture.storage, extraction, config, fixture.order);
  const coordinator = makeConsolidationCoordinator(fixture, extraction, config, delivery);

  await coordinator.run();

  assert.equal(fixture.memories.has("doomed"), false);
  assert.equal(revalidateCalls.length, 1);
  assertReadyAfterMutation(fixture.order, "consolidation_invalidate", "invalidate:doomed");
});

test("consolidation MERGE prepares before update and invalidation, then marks ready", async () => {
  const doomed = makeMemory("doomed", { links: [{ targetId: "dependent", linkType: "supports" }] });
  const replacement = makeMemory("replacement", { content: "merged claim" });
  const dependent = makeMemory("dependent");
  const fillers = ["filler-a", "filler-b", "filler-c"].map((id) => makeMemory(id));
  const fixture = makeStorage([doomed, replacement, dependent, ...fillers]);
  const revalidateCalls: unknown[] = [];
  const extraction = {
    ...makeRevalidationExtraction(revalidateCalls),
    async consolidate() {
      return {
        items: [{
          existingId: "replacement",
          action: "MERGE",
          mergeWith: "doomed",
          updatedContent: "merged claim",
          reason: "duplicate",
        }],
        profileUpdates: [],
        entityUpdates: [],
      };
    },
  } as unknown as ExtractionEngine;
  const config = propagationConfig();
  const dependencyPropagationDelivery = makeSyntheticImmediateDelivery(
    fixture.storage,
    extraction,
    config,
    fixture.order,
  );
  const coordinator = new ConsolidationRunCoordinator({
    config,
    getStorage: () => fixture.storage,
    getStorageRouter: () => ({ recordWrite: async () => {} }) as never,
    getExtraction: () => extraction,
    storageDirNamespace: () => "namespace-a",
    getDependencyPropagationDelivery: () => dependencyPropagationDelivery,
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

  assert.equal(fixture.memories.has("doomed"), false);
  assert.equal(fixture.memories.get("replacement")?.content, "merged claim");
  assert.equal(fixture.memories.get("dependent")?.frontmatter.invalidatedBy, "doomed");
  assert.equal(revalidateCalls.length, 1);
  assertReadyAfterMutation(fixture.order, "consolidation_merge", "invalidate:doomed");
  assert.ok(fixture.order.indexOf("prepare:consolidation_merge") < fixture.order.indexOf("update:replacement"));
  assert.ok(fixture.order.indexOf("update:replacement") < fixture.order.indexOf("invalidate:doomed"));
});
test("consolidation MERGE preserves mutation semantics when propagation is disabled", async () => {
  const doomed = makeMemory("doomed", { links: [{ targetId: "dependent", linkType: "supports" }] });
  const replacement = makeMemory("replacement", { content: "original replacement" });
  const dependent = makeMemory("dependent");
  const fillers = ["filler-a", "filler-b", "filler-c"].map((id) => makeMemory(id));
  const fixture = makeStorage([doomed, replacement, dependent, ...fillers], {
    mutateBeforeInvalidateIds: ["doomed"],
  });
  const revalidateCalls: unknown[] = [];
  const extraction = makeConsolidationExtraction(revalidateCalls, {
    existingId: "replacement",
    action: "MERGE",
    mergeWith: "doomed",
    updatedContent: "merged claim",
    reason: "duplicate",
  });
  const config = propagationConfig();
  config.dependencyPropagation.enabled = false;
  const delivery = makeSyntheticImmediateDelivery(fixture.storage, extraction, config, fixture.order);
  const coordinator = makeConsolidationCoordinator(fixture, extraction, config, delivery);

  await coordinator.run();

  assert.equal(fixture.memories.has("doomed"), false);
  assert.equal(fixture.memories.get("replacement")?.content, "merged claim");
  assert.equal(revalidateCalls.length, 0);
  assert.equal(fixture.order.some((entry) => entry.startsWith("prepare:")), false);
});


test("consolidation MERGE cancels propagation when source invalidation did not commit", async () => {
  const doomed = makeMemory("doomed", { links: [{ targetId: "dependent", linkType: "supports" }] });
  const replacement = makeMemory("replacement", { content: "merged claim" });
  const dependent = makeMemory("dependent");
  const fillers = ["filler-a", "filler-b", "filler-c"].map((id) => makeMemory(id));
  const fixture = makeStorage([doomed, replacement, dependent, ...fillers], {
    failInvalidateIds: ["doomed"],
  });
  const revalidateCalls: unknown[] = [];
  const extraction = makeConsolidationExtraction(revalidateCalls, {
    existingId: "replacement",
    action: "MERGE",
    mergeWith: "doomed",
    updatedContent: "merged claim",
    reason: "duplicate",
  });
  const config = propagationConfig();
  const delivery = makeSyntheticImmediateDelivery(fixture.storage, extraction, config, fixture.order);
  const coordinator = makeConsolidationCoordinator(fixture, extraction, config, delivery);

  await coordinator.run();

  assert.equal(fixture.memories.get("replacement")?.content, "merged claim");
  assert.equal(fixture.memories.has("doomed"), true);
  assert.equal(revalidateCalls.length, 0);
  assert.equal(fixture.order.includes("cancel:consolidation_merge"), true);
});

test("contradiction resolve retains propagation after partial supersession failure", async () => {
  const old = makeMemory("old", { links: [{ targetId: "dependent", linkType: "supports" }] });
  const replacement = makeMemory("replacement", { content: "new claim" });
  const dependent = makeMemory("dependent");
  const fixture = makeStorage([old, replacement, dependent], { partialSupersedeIds: ["old"] });
  const revalidateCalls: unknown[] = [];
  const extraction = makeRevalidationExtraction(revalidateCalls);
  const config = propagationConfig();
  const dependencyPropagationDelivery = makeSyntheticImmediateDelivery(
    fixture.storage,
    extraction,
    config,
    fixture.order,
  );
  const coordinator = new ContradictionLinkingCoordinator({
    getConfig: () => config,
    isSearchAvailable: () => false,
    searchAcrossNamespaces: async () => [],
    extractMemoryIdsFromResults: () => [],
    namespaceFromPath: () => "namespace-a",
    storageForNamespace: async () => fixture.storage,
    getExtraction: () => extraction,
    storageDirNamespace: () => "namespace-a",
    getDependencyPropagationDelivery: () => dependencyPropagationDelivery,
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

  assert.equal(fixture.memories.get("old")?.frontmatter.status, "superseded");
  assert.equal(revalidateCalls.length, 1);
  assert.equal(fixture.order.includes("cancel:contradiction"), false);
  assertReadyAfterMutation(fixture.order, "contradiction", "supersede:old");
});

test("contradiction resolve retains prepared propagation when commit state cannot be read", async () => {
  const old = makeMemory("old", { links: [{ targetId: "dependent", linkType: "supports" }] });
  const replacement = makeMemory("replacement", { content: "new claim" });
  const dependent = makeMemory("dependent");
  const fixture = makeStorage(
    [old, replacement, dependent],
    {
      failSupersedeIds: ["old"],
      failStateReadAfterSupersedeIds: ["old"],
    },
  );
  const revalidateCalls: unknown[] = [];
  const extraction = makeRevalidationExtraction(revalidateCalls);
  const config = propagationConfig();
  const dependencyPropagationDelivery = makeSyntheticImmediateDelivery(
    fixture.storage,
    extraction,
    config,
    fixture.order,
  );
  const coordinator = new ContradictionLinkingCoordinator({
    getConfig: () => config,
    isSearchAvailable: () => false,
    searchAcrossNamespaces: async () => [],
    extractMemoryIdsFromResults: () => [],
    namespaceFromPath: () => "namespace-a",
    storageForNamespace: async () => fixture.storage,
    getExtraction: () => extraction,
    storageDirNamespace: () => "namespace-a",
    getDependencyPropagationDelivery: () => dependencyPropagationDelivery,
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

  assert.deepEqual(fixture.order, ["prepare:contradiction", "supersede:old", "defer:contradiction"]);
  assert.equal(revalidateCalls.length, 0);
});

test("contradiction resolve cancels prepared propagation when primary supersession fails", async () => {
  const old = makeMemory("old", { links: [{ targetId: "dependent", linkType: "supports" }] });
  const replacement = makeMemory("replacement", { content: "new claim" });
  const dependent = makeMemory("dependent");
  const fixture = makeStorage([old, replacement, dependent], { failSupersedeIds: ["old"] });
  const revalidateCalls: unknown[] = [];
  const extraction = makeRevalidationExtraction(revalidateCalls);
  const config = propagationConfig();
  const dependencyPropagationDelivery = makeSyntheticImmediateDelivery(
    fixture.storage,
    extraction,
    config,
    fixture.order,
  );
  const coordinator = new ContradictionLinkingCoordinator({
    getConfig: () => config,
    isSearchAvailable: () => false,
    searchAcrossNamespaces: async () => [],
    extractMemoryIdsFromResults: () => [],
    namespaceFromPath: () => "namespace-a",
    storageForNamespace: async () => fixture.storage,
    getExtraction: () => extraction,
    storageDirNamespace: () => "namespace-a",
    getDependencyPropagationDelivery: () => dependencyPropagationDelivery,
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

  assert.deepEqual(fixture.order, [
    "prepare:contradiction",
    "supersede:old",
    "cancel:contradiction",
  ]);
  assert.equal(revalidateCalls.length, 0);
  assert.equal(fixture.order.some((entry) => entry.startsWith("afterMutation:")), false);
});
test("contradiction resolve propagates after a null preparation token", async () => {
  const old = makeMemory("old", { links: [{ targetId: "dependent", linkType: "supports" }] });
  const replacement = makeMemory("replacement", { content: "new claim" });
  const dependent = makeMemory("dependent");
  const fixture = makeStorage([old, replacement, dependent]);
  const revalidateCalls: unknown[] = [];
  const extraction = makeRevalidationExtraction(revalidateCalls);
  const config = propagationConfig();
  const delivery = makeSyntheticImmediateDelivery(
    fixture.storage,
    extraction,
    config,
    fixture.order,
    { prepareReturnsNull: true },
  );
  const coordinator = makeContradictionCoordinator(fixture, extraction, config, delivery);

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

  assertReadyAfterMutation(fixture.order, "contradiction", "supersede:old");
  assert.equal(fixture.order.filter((entry) => entry === "afterMutation:contradiction").length, 1);
  assert.equal(revalidateCalls.length, 1);
});

test("consolidation INVALIDATE propagates after a null preparation token", async () => {
  const doomed = makeMemory("doomed", { links: [{ targetId: "dependent", linkType: "supports" }] });
  const dependent = makeMemory("dependent");
  const fillers = ["filler-a", "filler-b", "filler-c"].map((id) => makeMemory(id));
  const fixture = makeStorage([doomed, dependent, ...fillers]);
  const revalidateCalls: unknown[] = [];
  const config = propagationConfig();
  const extraction = makeConsolidationExtraction(revalidateCalls, {
    existingId: "doomed",
    action: "INVALIDATE",
    reason: "duplicate",
  });
  const delivery = makeSyntheticImmediateDelivery(
    fixture.storage,
    extraction,
    config,
    fixture.order,
    { prepareReturnsNull: true },
  );

  await makeConsolidationCoordinator(fixture, extraction, config, delivery).run();

  assertReadyAfterMutation(fixture.order, "consolidation_invalidate", "invalidate:doomed");
  assert.equal(fixture.order.filter((entry) => entry === "afterMutation:consolidation_invalidate").length, 1);
  assert.equal(revalidateCalls.length, 1);
});

test("consolidation MERGE propagates after a null preparation token", async () => {
  const doomed = makeMemory("doomed", { links: [{ targetId: "dependent", linkType: "supports" }] });
  const replacement = makeMemory("replacement", { content: "merged claim" });
  const dependent = makeMemory("dependent");
  const fillers = ["filler-a", "filler-b", "filler-c"].map((id) => makeMemory(id));
  const fixture = makeStorage([doomed, replacement, dependent, ...fillers]);
  const revalidateCalls: unknown[] = [];
  const config = propagationConfig();
  const extraction = makeConsolidationExtraction(revalidateCalls, {
    existingId: "replacement",
    action: "MERGE",
    mergeWith: "doomed",
    updatedContent: "merged claim",
    reason: "duplicate",
  });
  const delivery = makeSyntheticImmediateDelivery(
    fixture.storage,
    extraction,
    config,
    fixture.order,
    { prepareReturnsNull: true },
  );

  await makeConsolidationCoordinator(fixture, extraction, config, delivery).run();

  assertReadyAfterMutation(fixture.order, "consolidation_merge", "invalidate:doomed");
  assert.equal(fixture.order.filter((entry) => entry === "afterMutation:consolidation_merge").length, 1);
  assert.equal(revalidateCalls.length, 1);
});

test("disabled propagation skips preparation and afterMutation", async () => {
  for (const disabledBy of ["enabled", "maxDependents"] as const) {
    const old = makeMemory("old", { links: [{ targetId: "dependent", linkType: "supports" }] });
    const replacement = makeMemory("replacement", { content: "new claim" });
    const dependent = makeMemory("dependent");
    const fixture = makeStorage([old, replacement, dependent]);
    const revalidateCalls: unknown[] = [];
    const extraction = makeRevalidationExtraction(revalidateCalls);
    const config = propagationConfig();
    if (disabledBy === "enabled") {
      config.dependencyPropagation.enabled = false;
    } else {
      config.dependencyPropagation.maxDependents = 0;
    }
    const delivery = makeSyntheticImmediateDelivery(
      fixture.storage,
      extraction,
      config,
      fixture.order,
    );
    const coordinator = makeContradictionCoordinator(fixture, extraction, config, delivery);

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

    assert.equal(fixture.order.some((entry) => entry.startsWith("prepare:")), false);
    assert.equal(fixture.order.some((entry) => entry.startsWith("afterMutation:")), false);
    assert.equal(revalidateCalls.length, 0);
  }
});


test("consolidation cancels or defers prepared propagation when source invalidation fails", async () => {
  for (const action of ["INVALIDATE", "MERGE"] as const) {
    const doomed = makeMemory("doomed", { links: [{ targetId: "dependent", linkType: "supports" }] });
    const replacement = makeMemory("replacement", { content: "merged claim" });
    const dependent = makeMemory("dependent");
    const fillers = ["filler-a", "filler-b", "filler-c"].map((id) => makeMemory(id));
    const fixture = makeStorage(
      [doomed, replacement, dependent, ...fillers],
      { failInvalidateIds: ["doomed"] },
    );
    const revalidateCalls: unknown[] = [];
    const config = propagationConfig();
    const extraction = makeConsolidationExtraction(revalidateCalls, action === "INVALIDATE"
      ? {
          existingId: "doomed",
          action,
          reason: "duplicate",
        }
      : {
          existingId: "replacement",
          action,
          mergeWith: "doomed",
          updatedContent: "merged claim",
          reason: "duplicate",
        });
    const delivery = makeSyntheticImmediateDelivery(
      fixture.storage,
      extraction,
      config,
      fixture.order,
    );

    await makeConsolidationCoordinator(fixture, extraction, config, delivery).run();

    const cause = action === "INVALIDATE"
      ? "consolidation_invalidate"
      : "consolidation_merge";
    assert.ok(fixture.order.includes(`prepare:${cause}`));
    assert.ok(fixture.order.includes("invalidate:doomed"));
    const terminalAction = "cancel";
    assert.ok(fixture.order.includes(`${terminalAction}:${cause}`));
    assert.equal(fixture.order.some((entry) => entry.startsWith("afterMutation:")), false);
    assert.equal(revalidateCalls.length, 0);
  }
});
test("consolidation cancels a prepared propagation when the pre-primary source read throws", async () => {
  const doomed = makeMemory("doomed", { links: [{ targetId: "dependent", linkType: "supports" }] });
  const dependent = makeMemory("dependent");
  const fillers = ["filler-a", "filler-b", "filler-c"].map((id) => makeMemory(id));
  const fixture = makeStorage([doomed, dependent, ...fillers], {
    failPrePrimaryReadIds: ["doomed"],
  });
  const revalidateCalls: unknown[] = [];
  const config = propagationConfig();
  const extraction = makeConsolidationExtraction(revalidateCalls, {
    existingId: "doomed",
    action: "INVALIDATE",
    reason: "duplicate",
  });
  const delivery = makeSyntheticImmediateDelivery(fixture.storage, extraction, config, fixture.order);

  await assert.rejects(
    makeConsolidationCoordinator(fixture, extraction, config, delivery).run(),
    /synthetic pre-primary read failure/,
  );

  assert.deepEqual(fixture.order, [
    "prepare:consolidation_invalidate",
    "cancel:consolidation_invalidate",
  ]);
  assert.equal(fixture.memories.has("doomed"), true);
  assert.equal(revalidateCalls.length, 0);
});

test("consolidation defers merge propagation when the survivor write throws after commit", async () => {
  const doomed = makeMemory("doomed", { links: [{ targetId: "dependent", linkType: "supports" }] });
  const replacement = makeMemory("replacement", { content: "old replacement claim" });
  const dependent = makeMemory("dependent");
  const fillers = ["filler-a", "filler-b", "filler-c"].map((id) => makeMemory(id));
  const fixture = makeStorage([doomed, replacement, dependent, ...fillers], {
    throwAfterUpdateIds: ["replacement"],
  });
  const revalidateCalls: unknown[] = [];
  const config = propagationConfig();
  const extraction = makeConsolidationExtraction(revalidateCalls, {
    existingId: "replacement",
    action: "MERGE",
    mergeWith: "doomed",
    updatedContent: "merged claim",
    reason: "duplicate",
  });
  const delivery = makeSyntheticImmediateDelivery(
    fixture.storage,
    extraction,
    config,
    fixture.order,
  );

  await assert.rejects(
    makeConsolidationCoordinator(fixture, extraction, config, delivery).run(),
    /synthetic post-write update failure/,
  );

  assert.equal(fixture.memories.get("replacement")?.content, "merged claim");
  assert.equal(fixture.memories.get("dependent")?.frontmatter.invalidatedBy, undefined);
  assert.deepEqual(fixture.order.slice(0, 3), [
    "prepare:consolidation_merge",
    "update:replacement",
    "defer:consolidation_merge",
  ]);
  assert.equal(fixture.order.includes("afterMutation:consolidation_merge"), false);
  assert.equal(fixture.order.includes("invalidate:doomed"), false);
  assert.equal(revalidateCalls.length, 0);
});