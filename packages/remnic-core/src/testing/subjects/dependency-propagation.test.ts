/**
 * Dependency propagation lifecycle subject for the scenario-matrix harness.
 *
 * The storage adapter isolates namespace snapshots in memory. The extraction
 * adapter calls the real LLM revalidation parser with deterministic completion.
 */

import assert from "node:assert/strict";

import type { ExtractionEngine } from "../../extraction.js";
import { propagateInvalidation, type PropagationEvent } from "../../orchestration/dependency-propagation.js";
import { revalidateDependentsViaLlm } from "../../orchestration/dependency-revalidation.js";
import type { StorageManager } from "../../storage.js";
import type { MemoryFile, MemoryLinkType, PluginConfig } from "../../types.js";
import {
  type LifecycleSubject,
  type MatrixRow,
  runLifecycleMatrix,
} from "../lifecycle-matrix.js";

const NOW = "2026-08-09T00:00:00.000Z";
type NamespaceName = "alice" | "bob" | "default";
type NamespaceStore = Map<string, MemoryFile>;

type PropagationState = {
  stores: Map<NamespaceName, NamespaceStore>;
  activeNamespace: NamespaceName;
  storage: StorageManager;
  extraction: ExtractionEngine;
  propagationCalls: PropagationEvent[];
  revalidationCalls: Array<{
    supersededId: string;
    dependentIds: string[];
  }>;
  supersedeCalls: Array<{
    namespace: NamespaceName;
    id: string;
    replacementId: string;
    reason: string;
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
    path: `/synthetic/${id}.md`,
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

function makeConfig(): PluginConfig {
  return {
    memoryDir: "/synthetic/dependency-propagation",
    dependencyPropagation: {
      enabled: true,
      linkTypes: ["supports", "follows"],
      maxDependents: 10,
      timeoutMs: 500,
      dryRun: false,
    },
  } as unknown as PluginConfig;
}

function namespaceStore(namespace: NamespaceName): NamespaceStore {
  const oldId = `${namespace}-old`;
  const dependentId = `${namespace}-dependent`;
  const grandchildId = `${namespace}-grandchild`;
  return new Map([
    [
      oldId,
      makeMemory(oldId, {
        content: `supporting claim for ${namespace}`,
        links: [{ targetId: dependentId, linkType: "supports" }],
      }),
    ],
    [
      dependentId,
      makeMemory(dependentId, {
        links: [{ targetId: oldId, linkType: "follows" }],
      }),
    ],
    [
      grandchildId,
      makeMemory(grandchildId, {
        links: [{ targetId: dependentId, linkType: "supports" }],
      }),
    ],
  ]);
}

function activeStore(state: PropagationState): NamespaceStore {
  const store = state.stores.get(state.activeNamespace);
  assert.ok(store, `missing namespace store ${state.activeNamespace}`);
  return store;
}

function makeStorage(state: PropagationState): StorageManager {
  return {
    async readAllMemories(): Promise<MemoryFile[]> {
      return [...activeStore(state).values()];
    },
    async getMemoryById(id: string): Promise<MemoryFile | null> {
      return activeStore(state).get(id) ?? null;
    },
    async supersedeMemory(id: string, replacementId: string, reason: string): Promise<boolean> {
      state.supersedeCalls.push({
        namespace: state.activeNamespace,
        id,
        replacementId,
        reason,
      });
      const current = activeStore(state).get(id);
      if (!current || current.frontmatter.status !== "active") return false;
      current.frontmatter.status = "superseded";
      current.frontmatter.supersededBy = replacementId;
      return true;
    },
    async writeMemoryFrontmatter(
      current: MemoryFile,
      patch: Record<string, unknown>,
    ): Promise<boolean> {
      const stored = activeStore(state).get(current.frontmatter.id);
      if (!stored) return false;
      Object.assign(stored.frontmatter, patch);
      return true;
    },
  } as unknown as StorageManager;
}

function makeExtraction(state: PropagationState): ExtractionEngine {
  const parseJsonObject = (raw: string | null): unknown => (raw === null ? null : JSON.parse(raw));
  return {
    async revalidateDependents(
      superseded: { id: string; content: string },
      replacement: { id: string; content: string } | null,
      dependents: Array<{ id: string; category: string; content: string }>,
      signal?: AbortSignal,
    ) {
      state.revalidationCalls.push({
        supersededId: superseded.id,
        dependentIds: dependents.map((dependent) => dependent.id),
      });
      return revalidateDependentsViaLlm(
        {
          fastChatCompletion: async (_messages, options) => {
            if (options.signal?.aborted || signal?.aborted) return null;
            return {
              content: JSON.stringify({
                verdicts: dependents.map((dependent) => ({
                  memoryId: dependent.id,
                  verdict: "invalidated",
                  reason: "synthetic supporting claim changed",
                })),
              }),
            };
          },
          parseJsonObject,
        },
        superseded,
        replacement,
        dependents,
        { signal, timeoutMs: 500 },
      );
    },
  } as unknown as ExtractionEngine;
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

function eventFor(state: PropagationState, row: MatrixRow): PropagationEvent {
  const old = activeStore(state).get(`${state.activeNamespace}-old`);
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
    const stores = new Map<NamespaceName, NamespaceStore>([
      ["alice", namespaceStore("alice")],
      ["bob", namespaceStore("bob")],
      ["default", namespaceStore("default")],
    ]);
    const state = {
      stores,
      activeNamespace: namespaceFor(row),
      storage: undefined as unknown as StorageManager,
      extraction: undefined as unknown as ExtractionEngine,
      propagationCalls: [],
      revalidationCalls: [],
      supersedeCalls: [],
      lifecycleLabels: [],
    } satisfies Omit<PropagationState, "storage" | "extraction"> & {
      storage: StorageManager;
      extraction: ExtractionEngine;
    };
    state.storage = makeStorage(state);
    state.extraction = makeExtraction(state);
    return state;
  },

  async exercise(state: PropagationState, row: MatrixRow): Promise<void> {
    state.lifecycleLabels.push(row.dimensions.flush);
    const run = async (): Promise<void> => {
      state.propagationCalls.push(eventFor(state, row));
      await propagateInvalidation(
        { storage: state.storage, extraction: state.extraction, config: makeConfig() },
        state.propagationCalls.at(-1)!,
      );
    };

    if (row.dimensions.restart) {
      state.storage = makeStorage(state);
      state.extraction = makeExtraction(state);
    }
    await run();
    if (row.dimensions.dedupeOrReplay) await run();
  },

  async invariants(state: PropagationState, row: MatrixRow): Promise<void> {
    assert.equal(state.propagationCalls.length, row.dimensions.dedupeOrReplay ? 2 : 1);
    assert.equal(state.revalidationCalls.length, 1, "the real LLM revalidation path must run");
    assert.deepEqual(
      state.revalidationCalls[0]?.dependentIds,
      [`${state.activeNamespace}-dependent`],
      "discovery must stay one-hop and namespace-scoped",
    );
    assert.equal(state.lifecycleLabels.length, 1);
    assert.equal(state.lifecycleLabels[0], row.dimensions.flush);

    const active = activeStore(state);
    assert.equal(active.get(`${state.activeNamespace}-dependent`)?.frontmatter.status, "superseded");
    assert.equal(active.get(`${state.activeNamespace}-grandchild`)?.frontmatter.status, "active");
    for (const [namespace, store] of state.stores) {
      if (namespace === state.activeNamespace) continue;
      assert.equal(
        store.get(`${namespace}-dependent`)?.frontmatter.status,
        "active",
        `dependent in ${namespace} must not be invalidated by ${state.activeNamespace}`,
      );
      assert.equal(
        store.get(`${namespace}-grandchild`)?.frontmatter.status,
        "active",
        `grandchild in ${namespace} must remain untouched`,
      );
    }
    assert.equal(
      state.supersedeCalls.length,
      1,
      row.dimensions.dedupeOrReplay
        ? "replay must produce one durable supersession effect"
        : "one dependent must receive one durable supersession effect",
    );
    assert.equal(state.supersedeCalls[0]?.namespace, state.activeNamespace);
  },

  async teardown(state: PropagationState): Promise<void> {
    state.stores.clear();
    state.propagationCalls.length = 0;
    state.revalidationCalls.length = 0;
    state.supersedeCalls.length = 0;
    state.lifecycleLabels.length = 0;
  },
};

runLifecycleMatrix("dependency-propagation", subject);
