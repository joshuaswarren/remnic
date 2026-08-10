/**
 * Dependency propagation lifecycle subject for the scenario-matrix harness.
 *
 * Each namespace uses a real StorageManager over an isolated temporary directory.
 * ExtractionEngine uses its production revalidation route with deterministic completion.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ExtractionEngine } from "../../extraction.js";
import {
  propagateInvalidation,
  type PropagationEvent,
  type PropagationResult,
} from "../../orchestration/dependency-propagation.js";
import type { RevalidationFastChatCompletion } from "../../orchestration/dependency-revalidation.js";
import { StorageManager } from "../../storage.js";
import type { MemoryFile, MemoryLinkType, PluginConfig } from "../../types.js";
import {
  type LifecycleSubject,
  type MatrixRow,
  runLifecycleMatrix,
} from "../lifecycle-matrix.js";

const NOW = "2026-08-09T00:00:00.000Z";
type NamespaceName = "alice" | "bob" | "default";
type NamespaceDirectoryMap = Map<NamespaceName, string>;
type NamespaceStorageMap = Map<NamespaceName, StorageManager>;
type CompletionCall = {
  messages: Parameters<RevalidationFastChatCompletion>[0];
  options: Parameters<RevalidationFastChatCompletion>[1];
};

type PropagationState = {
  rootDir: string;
  namespaceDirs: NamespaceDirectoryMap;
  storages: NamespaceStorageMap;
  activeNamespace: NamespaceName;
  storage: StorageManager;
  extraction: ExtractionEngine;
  propagationCalls: PropagationEvent[];
  propagationResults: PropagationResult[];
  completionCalls: CompletionCall[];
  revalidationCalls: Array<{
    supersededId: string;
    dependentIds: string[];
  }>;
  lifecycleLabels: string[];
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
    const dependentIds = [...userMessage.matchAll(/^\[\d+\] id: ([^ |]+) \| category:/gm)].map(
      (match) => match[1]!,
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
  };
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
        namespaceDirs,
        storages,
        activeNamespace,
        storage,
        extraction: makeExtraction(stateRef, makeConfig(memoryDir)),
        propagationCalls: [],
        propagationResults: [],
        completionCalls: [],
        revalidationCalls: [],
        lifecycleLabels: [],
      };
      stateRef.current = state;
      return state;
    } catch (error) {
      await rm(rootDir, { recursive: true, force: true });
      throw error;
    }
  },

  async exercise(state: PropagationState, row: MatrixRow): Promise<void> {
    state.lifecycleLabels.push(row.dimensions.flush);
    if (row.dimensions.restart) {
      const directory = state.namespaceDirs.get(state.activeNamespace);
      assert.ok(directory, `missing namespace directory ${state.activeNamespace}`);
      state.storage = new StorageManager(directory);
      state.storages.set(state.activeNamespace, state.storage);
      const stateRef: { current?: PropagationState } = { current: state };
      state.extraction = makeExtraction(stateRef, makeConfig(directory));
    }
    const run = async (): Promise<void> => {
      const event = await eventFor(state, row);
      state.propagationCalls.push(event);
      state.propagationResults.push(
        await propagateInvalidation(
          {
            storage: state.storage,
            extraction: state.extraction,
            config: makeConfig(state.namespaceDirs.get(state.activeNamespace)!),
          },
          event,
        ),
      );
    };

    await run();
    if (row.dimensions.dedupeOrReplay) await run();
  },

  async invariants(state: PropagationState, row: MatrixRow): Promise<void> {
    assert.equal(state.propagationCalls.length, row.dimensions.dedupeOrReplay ? 2 : 1);
    assert.equal(state.propagationResults[0]?.route, "fast-completion");
    assert.equal(state.propagationResults[0]?.dependentsFound, 1);
    assert.equal(state.propagationResults[0]?.invalidated, 1);
    if (row.dimensions.dedupeOrReplay) {
      assert.equal(state.propagationResults[1]?.skipped, "no_dependents");
      assert.equal(state.propagationResults[1]?.dependentsFound, 0);
    }
    assert.equal(state.revalidationCalls.length, 1, "the real LLM revalidation path must run");
    const revalidation = state.revalidationCalls[0];
    assert.ok(revalidation, "missing revalidation call");
    assert.equal(revalidation.supersededId, `${state.activeNamespace}-old`);
    assert.deepEqual(
      revalidation.dependentIds,
      [`${state.activeNamespace}-dependent`],
      "discovery must stay one-hop and namespace-scoped",
    );
    assert.equal(state.completionCalls.length, 1);
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

    const active = await activeStorage(state).readAllMemories();
    const dependent = active.find((memory) => memory.frontmatter.id === `${state.activeNamespace}-dependent`);
    const grandchild = active.find((memory) => memory.frontmatter.id === `${state.activeNamespace}-grandchild`);
    assert.equal(dependent?.frontmatter.status, "superseded");
    assert.equal(dependent?.frontmatter.supersededBy, `${state.activeNamespace}-replacement`);
    assert.equal(dependent?.frontmatter.supersessionCause, "dependency");
    assert.equal(dependent?.frontmatter.invalidatedBy, `${state.activeNamespace}-old`);
    assert.equal(grandchild?.frontmatter.status, "active");
    for (const [namespace, storage] of state.storages) {
      if (namespace === state.activeNamespace) continue;
      const memories = await storage.readAllMemories();
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
    await rm(state.rootDir, { recursive: true, force: true });
  },
};

runLifecycleMatrix("dependency-propagation", subject);
