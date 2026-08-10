/**
 * Dependency propagation lifecycle subject for the scenario-matrix harness.
 *
 * Each namespace uses a real StorageManager over an isolated temporary directory.
 * DependencyPropagationDelivery uses the production durable queue and recovery path.
 * ExtractionEngine uses its production revalidation route with deterministic completion.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ExtractionEngine } from "../../extraction.js";
import {
  DependencyPropagationDelivery,
  type DependencyPropagationJob,
} from "../../orchestration/dependency-propagation-delivery.js";
import type { PropagationEvent } from "../../orchestration/dependency-propagation.js";
import { applyTemporalSupersessionPrimaryMutation } from "../../temporal-supersession.js";
import type { RevalidationFastChatCompletion } from "../../orchestration/dependency-revalidation.js";
import { StorageManager } from "../../storage.js";
import type { MemoryFile, MemoryLinkType, PluginConfig } from "../../types.js";
import {
  type LifecycleSubject,
  type MatrixRow,
  runLifecycleMatrix,
} from "../lifecycle-matrix.js";

const NOW = "2026-08-09T00:00:00.000Z";
const TEMPORAL_SUPERSEDED_AT = "2026-08-09T00:00:01.000Z";
type NamespaceName = "alice" | "bob" | "default";
type NamespaceDirectoryMap = Map<NamespaceName, string>;
type NamespaceStorageMap = Map<NamespaceName, StorageManager>;
type CompletionCall = {
  messages: Parameters<RevalidationFastChatCompletion>[0];
  options: Parameters<RevalidationFastChatCompletion>[1];
};

type PropagationState = {
  rootDir: string;
  queueRoot: string;
  namespaceDirs: NamespaceDirectoryMap;
  storages: NamespaceStorageMap;
  activeNamespace: NamespaceName;
  storage: StorageManager;
  extraction: ExtractionEngine;
  delivery: DependencyPropagationDelivery;
  deliveries: DependencyPropagationDelivery[];
  propagationCalls: PropagationEvent[];
  completionCalls: CompletionCall[];
  revalidationCalls: Array<{
    supersededId: string;
    dependentIds: string[];
  }>;
  lifecycleLabels: string[];
  commitProofObserved: boolean;
  recoveryCalled: boolean;
  durableJobCount: number;
};

function makeMemory(
  id: string,
  options: {
    links?: Array<{ targetId: string; linkType: MemoryLinkType }>;
    content?: string;
  } = {},
): MemoryFile {
  return {
    path: `synthetic/${id}.md`,
    content: options.content ?? `claim for ${id}`,
    frontmatter: {
      id,
      category: "fact",
      created: NOW,
      updated: NOW,
      source: "synthetic-dependency-propagation",
      confidence: 0.9,
      confidenceTier: "explicit",
      tags: [],
      status: "active",
      links: options.links?.map((link) => ({ ...link, strength: 0.9 })),
    },
  } as unknown as MemoryFile;
}

function makeConfig(memoryDir: string): PluginConfig {
  return {
    memoryDir,
    model: "synthetic-dependency-propagation",
    modelSource: "plugin",
    localLlmEnabled: false,
    dependencyPropagation: {
      enabled: true,
      linkTypes: ["supports", "follows"],
      maxDependents: 10,
      timeoutMs: 500,
      dryRun: false,
    },
  } as unknown as PluginConfig;
}

function namespaceMemories(namespace: NamespaceName): MemoryFile[] {
  const oldId = `${namespace}-old`;
  const dependentId = `${namespace}-dependent`;
  const grandchildId = `${namespace}-grandchild`;
  return [
    makeMemory(oldId, {
      content: `supporting claim for ${namespace}`,
      links: [{ targetId: dependentId, linkType: "supports" }],
    }),
    makeMemory(dependentId, {
      links: [{ targetId: oldId, linkType: "follows" }],
    }),
    makeMemory(grandchildId, {
      links: [{ targetId: dependentId, linkType: "supports" }],
    }),
    makeMemory(`${namespace}-replacement`, {
      content: `replacement claim for ${namespace}`,
    }),
  ];
}

function serializeFixture(memory: MemoryFile): string {
  const links = (memory.frontmatter.links ?? [])
    .map(
      (link) =>
        `  - targetId: ${link.targetId} linkType: ${link.linkType} strength: ${link.strength ?? 0.9}`,
    )
    .join("\n");
  return [
    "---",
    `id: ${memory.frontmatter.id}`,
    `category: ${memory.frontmatter.category}`,
    `created: ${memory.frontmatter.created}`,
    `updated: ${memory.frontmatter.updated}`,
    `source: ${memory.frontmatter.source}`,
    `confidence: ${memory.frontmatter.confidence}`,
    `confidenceTier: ${memory.frontmatter.confidenceTier}`,
    "tags: []",
    `status: ${memory.frontmatter.status}`,
    "links:",
    links,
    "---",
    "",
    memory.content,
    "",
  ].join("\n");
}

async function persistFixtures(directory: string, memories: MemoryFile[]): Promise<void> {
  const factsDir = path.join(directory, "facts", "2026-08-09");
  await mkdir(factsDir, { recursive: true });
  await Promise.all(
    memories.map((memory) =>
      writeFile(
        path.join(factsDir, `${memory.frontmatter.id}.md`),
        serializeFixture(memory),
        "utf8",
      ),
    ),
  );
}

function activeStorage(state: PropagationState): StorageManager {
  const storage = state.storages.get(state.activeNamespace);
  assert.ok(storage, `missing namespace storage ${state.activeNamespace}`);
  return storage;
}

function makeExtraction(
  stateRef: { current?: PropagationState },
  config: PluginConfig,
): ExtractionEngine {
  const fastCompletion: RevalidationFastChatCompletion = async (messages, options) => {
    const state = stateRef.current;
    assert.ok(state, "extraction state is not initialized");
    state.completionCalls.push({ messages, options });
    const userMessage = messages.find((message) => message.role === "user")?.content ?? "";
    const supersededId = userMessage.match(/^SUPERSEDED MEMORY \(id: ([^)]+)\):$/m)?.[1] ?? "";
    const dependentIds = [...userMessage.matchAll(/^\[\d+\] id: ([^ |]+) \| category:/gm)].flatMap(
      (match) => match[1] ? [match[1]] : [],
    );
    state.revalidationCalls.push({ supersededId, dependentIds });
    if (options.signal?.aborted) return null;
    return {
      content: JSON.stringify({
        verdicts: dependentIds.map((memoryId) => ({
          memoryId,
          verdict: "invalidated",
          reason: "synthetic supporting claim changed",
        })),
      }),
    };
  };
  return new ExtractionEngine(config, undefined, undefined, undefined, undefined, fastCompletion);
}

function namespaceFor(row: MatrixRow): NamespaceName {
  if (row.dimensions.providerIdentity === "rebound") return "bob";
  if (row.dimensions.providerIdentity === "sparse" && !row.dimensions.rememberedBinding) return "default";
  return "alice";
}

function causeFor(row: MatrixRow): PropagationEvent["cause"] {
  switch (row.dimensions.flush) {
    case "compaction":
      return "consolidation_invalidate";
    case "before_reset":
      return "contradiction";
    case "session_end":
      return "temporal_supersession";
    case "none":
      return "contradiction";
  }
}

async function eventFor(state: PropagationState, row: MatrixRow): Promise<PropagationEvent> {
  const old = await activeStorage(state).getMemoryById(`${state.activeNamespace}-old`);
  assert.ok(old, `missing old memory for ${state.activeNamespace}`);
  return {
    oldMemory: {
      content: old.content,
      frontmatter: { ...old.frontmatter },
    },
    replacementId: `${state.activeNamespace}-replacement`,
    replacementContent: `replacement claim for ${state.activeNamespace}`,
    cause: causeFor(row),
    namespaceScope: state.activeNamespace,
    ...(row.dimensions.flush === "session_end"
      ? {
          temporalMutation: {
            supersededAt: TEMPORAL_SUPERSEDED_AT,
            matchedKeys: [],
          },
        }
      : {}),
  };
}

function makeDelivery(
  state: PropagationState,
  extraction: ExtractionEngine,
  workerId: string,
): DependencyPropagationDelivery {
  const memoryDir = state.namespaceDirs.get(state.activeNamespace);
  assert.ok(memoryDir, `missing namespace directory ${state.activeNamespace}`);
  return new DependencyPropagationDelivery({
    queueRoot: state.queueRoot,
    config: makeConfig(memoryDir),
    extraction,
    getStorage: async (namespace) => {
      const storage = state.storages.get(namespace as NamespaceName);
      assert.ok(storage, `missing namespace storage ${namespace}`);
      return storage;
    },
    workerId,
    autoStart: false,
  });
}

async function applyPrimaryMutation(
  state: PropagationState,
  event: PropagationEvent,
): Promise<void> {
  const storage = activeStorage(state);
  const oldId = event.oldMemory.frontmatter.id;
  if (event.cause === "consolidation_invalidate") {
    assert.equal(
      await storage.invalidateMemory(oldId, event.oldMemory, { recordCommitProof: true }),
      true,
    );
    state.commitProofObserved = await storage.hasCommittedInvalidation(event.oldMemory);
    return;
  }
  if (event.cause === "contradiction") {
    assert.ok(event.replacementId, "contradiction event requires a replacement");
    assert.equal(
      await storage.supersedeMemory(
        oldId,
        event.replacementId,
        "synthetic primary contradiction",
        undefined,
        { expectedSnapshot: event.oldMemory },
      ),
      true,
    );
    return;
  }
  assert.equal(event.cause, "temporal_supersession");
  assert.ok(event.replacementId);
  assert.ok(event.temporalMutation);
  const old = await storage.getMemoryById(oldId);
  assert.ok(old, `missing temporal source ${oldId}`);
  assert.equal(
    await applyTemporalSupersessionPrimaryMutation({
      storage,
      oldMemory: old,
      replacementId: event.replacementId,
      mutation: event.temporalMutation,
      allCandidates: await storage.readAllMemories(),
    }),
    true,
  );
}

function jobById(jobs: DependencyPropagationJob[], jobId: string): DependencyPropagationJob {
  const job = jobs.find((candidate) => candidate.jobId === jobId);
  assert.ok(job, `missing durable job ${jobId}`);
  return job;
}

const subject: LifecycleSubject<PropagationState> = {
  async setup(row: MatrixRow): Promise<PropagationState> {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "remnic-dependency-propagation-"));
    try {
      const namespaceDirs: NamespaceDirectoryMap = new Map();
      const storages: NamespaceStorageMap = new Map();
      for (const namespace of ["alice", "bob", "default"] as const) {
        const directory = path.join(rootDir, namespace);
        await mkdir(directory, { recursive: true });
        const storage = new StorageManager(directory);
        await storage.ensureDirectories();
        await persistFixtures(directory, namespaceMemories(namespace));
        namespaceDirs.set(namespace, directory);
        storages.set(namespace, storage);
      }
      const activeNamespace = namespaceFor(row);
      const storage = storages.get(activeNamespace);
      const memoryDir = namespaceDirs.get(activeNamespace);
      assert.ok(storage, `missing namespace storage ${activeNamespace}`);
      assert.ok(memoryDir, `missing namespace directory ${activeNamespace}`);
      const stateRef: { current?: PropagationState } = {};
      const state: PropagationState = {
        rootDir,
        queueRoot: path.join(rootDir, "dependency-propagation"),
        namespaceDirs,
        storages,
        activeNamespace,
        storage,
        extraction: makeExtraction(stateRef, makeConfig(memoryDir)),
        delivery: undefined as unknown as DependencyPropagationDelivery,
        deliveries: [],
        propagationCalls: [],
        completionCalls: [],
        revalidationCalls: [],
        lifecycleLabels: [],
        commitProofObserved: false,
        recoveryCalled: false,
        durableJobCount: 0,
      };
      stateRef.current = state;
      state.delivery = makeDelivery(state, state.extraction, `lifecycle-${row.id}`);
      state.deliveries.push(state.delivery);
      return state;
    } catch (error) {
      await rm(rootDir, { recursive: true, force: true });
      throw error;
    }
  },

  async exercise(state: PropagationState, row: MatrixRow): Promise<void> {
    state.lifecycleLabels.push(row.dimensions.flush);
    const event = await eventFor(state, row);
    state.propagationCalls.push(event);
    const token = await state.delivery.prepare(event);
    assert.ok(token, "delivery must durably prepare the propagation job");
    if (row.dimensions.dedupeOrReplay) {
      const duplicateToken = await state.delivery.prepare(event);
      assert.ok(duplicateToken, "duplicate prepare must reserve the existing durable job");
      assert.equal((await state.delivery.listJobs()).length, 1);
      await applyPrimaryMutation(state, event);
      await state.delivery.afterMutation(token, event);
      await state.delivery.afterMutation(duplicateToken, event);
      await state.delivery.runUntilIdle();
    } else if (row.dimensions.restart) {
      await applyPrimaryMutation(state, event);
      const directory = state.namespaceDirs.get(state.activeNamespace);
      assert.ok(directory, `missing namespace directory ${state.activeNamespace}`);
      const reloadedStorage = new StorageManager(directory);
      await reloadedStorage.ensureDirectories();
      state.storage = reloadedStorage;
      state.storages.set(state.activeNamespace, reloadedStorage);
      const stateRef: { current?: PropagationState } = { current: state };
      state.extraction = makeExtraction(stateRef, makeConfig(directory));
      const recovered = makeDelivery(state, state.extraction, `lifecycle-${row.id}-reloaded`);
      state.delivery = recovered;
      state.deliveries.push(recovered);
      state.recoveryCalled = true;
      await recovered.recover();
      await recovered.runUntilIdle();
    } else {
      await applyPrimaryMutation(state, event);
      await state.delivery.afterMutation(token, event);
      await state.delivery.runUntilIdle();
    }
    const jobs = await state.delivery.listJobs();
    state.durableJobCount = jobs.length;
  },

  async invariants(state: PropagationState, row: MatrixRow): Promise<void> {
    assert.equal(state.propagationCalls.length, 1);
    assert.equal(state.durableJobCount, 1, "one durable job must represent the event");
    const jobs = await state.delivery.listJobs();
    assert.equal(jobs.length, 1);
    const firstJob = jobs[0];
    assert.ok(firstJob, "missing durable job");
    const job = jobById(jobs, firstJob.jobId);
    assert.equal(job.status, "completed");
    assert.equal(job.attempts, 1);
    assert.equal(state.revalidationCalls.length, 1, "the real LLM revalidation path must run");
    const revalidation = state.revalidationCalls[0];
    assert.ok(revalidation, "missing revalidation call");
    assert.equal(revalidation.supersededId, `${state.activeNamespace}-old`);
    assert.deepEqual(
      revalidation.dependentIds,
      [`${state.activeNamespace}-dependent`],
      "discovery must stay one-hop and namespace-scoped",
    );
    assert.equal(state.completionCalls.length, 1, "one durable job must produce one completion");
    const completion = state.completionCalls[0];
    assert.ok(completion, "missing completion call");
    assert.deepEqual(completion.messages.map((message) => message.role), ["system", "user"]);
    assert.equal(
      completion.messages[1]?.content,
      `SUPERSEDED MEMORY (id: ${state.activeNamespace}-old):
supporting claim for ${state.activeNamespace}

REPLACEMENT (id: ${state.activeNamespace}-replacement):
replacement claim for ${state.activeNamespace}

DEPENDENTS TO REVALIDATE (return exactly one verdict per id):
[1] id: ${state.activeNamespace}-dependent | category: fact
claim for ${state.activeNamespace}-dependent`,
    );
    assert.match(completion.messages[0]?.content ?? "", /Never invent memory IDs/);
    assert.equal(completion.options.temperature, 0.2);
    assert.equal(completion.options.maxTokens, 1024);
    assert.equal(completion.options.timeoutMs, 500);
    assert.equal(completion.options.operation, "dependency_revalidation");
    assert.equal(completion.options.priority, "background");
    assert.ok(completion.options.signal instanceof AbortSignal);
    assert.equal(completion.options.signal?.aborted, false);
    assert.equal(state.lifecycleLabels.length, 1);
    assert.equal(state.lifecycleLabels[0], row.dimensions.flush);
    if (row.dimensions.restart) {
      assert.equal(state.deliveries.length, 2, "restart must create a second delivery");
      assert.equal(state.recoveryCalled, true, "restart must call recovery");
    } else {
      assert.equal(state.deliveries.length, 1);
    }

    const active = await activeStorage(state).readAllMemories();
    const old = active.find((memory) => memory.frontmatter.id === `${state.activeNamespace}-old`);
    const dependent = active.find((memory) => memory.frontmatter.id === `${state.activeNamespace}-dependent`);
    const grandchild = active.find((memory) => memory.frontmatter.id === `${state.activeNamespace}-grandchild`);
    if (row.dimensions.flush === "compaction") {
      assert.equal(old, undefined, "consolidation invalidation must delete the source");
      assert.equal(state.commitProofObserved, true, "consolidation must record an invalidation commit proof");
      const propagation = state.propagationCalls[0];
      assert.ok(propagation, "missing propagation event");
      assert.equal(await activeStorage(state).hasCommittedInvalidation({
        content: `supporting claim for ${state.activeNamespace}`,
        frontmatter: {
          ...propagation.oldMemory.frontmatter,
        },
      }), false, "completed delivery must clear the commit proof");
    } else {
      assert.equal(old?.frontmatter.status, "superseded");
      assert.equal(old?.frontmatter.supersededBy, `${state.activeNamespace}-replacement`);
    }
    assert.equal(dependent?.frontmatter.status, "superseded");
    assert.equal(dependent?.frontmatter.supersededBy, `${state.activeNamespace}-replacement`);
    assert.equal(dependent?.frontmatter.supersessionCause, "dependency");
    assert.equal(dependent?.frontmatter.invalidatedBy, `${state.activeNamespace}-old`);
    assert.equal(grandchild?.frontmatter.status, "active");
    for (const [namespace, storage] of state.storages) {
      if (namespace === state.activeNamespace) continue;
      const memories = await storage.readAllMemories();
      assert.equal(
        memories.find((memory) => memory.frontmatter.id === `${namespace}-old`)?.frontmatter.status,
        "active",
        `source in ${namespace} must remain active`,
      );
      assert.equal(
        memories.find((memory) => memory.frontmatter.id === `${namespace}-dependent`)?.frontmatter.status,
        "active",
        `dependent in ${namespace} must not be invalidated by ${state.activeNamespace}`,
      );
      assert.equal(
        memories.find((memory) => memory.frontmatter.id === `${namespace}-grandchild`)?.frontmatter.status,
        "active",
        `grandchild in ${namespace} must remain untouched`,
      );
    }
  },

  async teardown(state: PropagationState): Promise<void> {
    try {
      for (const delivery of state.deliveries) await delivery.shutdown();
    } finally {
      StorageManager.clearAllStaticCaches();
      await rm(state.rootDir, { recursive: true, force: true });
    }
  },
};

runLifecycleMatrix("dependency-propagation", subject);
