import { ContradictionLinkingCoordinator } from "./contradiction-linking-coordinator.js";
import type { ExtractionEngine } from "../extraction.js";
import type { QmdSearchResult, PluginConfig } from "../types.js";
import assert from "node:assert/strict";
import test from "node:test";
import { initLogger } from "../logger.js";

import {
  localizeUpdateCandidates,
  mergeMemorySnapshots,
  type UpdateLocalizationSearchHit,
} from "./update-localization.js";
import type { MemoryFile } from "../types.js";
import type { StorageManager } from "../storage.js";

const NOW = "2026-08-08T00:00:00.000Z";

function memory(
  id: string,
  options: {
    entityRef?: string;
    category?: string;
    status?: string;
    created?: string;
    attributes?: Record<string, string>;
    content?: string;
  } = {},
): MemoryFile {
  return {
    path: `/synthetic/${id}.md`,
    content: options.content ?? `content for ${id}`,
    frontmatter: {
      id,
      category: (options.category ?? "fact") as MemoryFile["frontmatter"]["category"],
      created: options.created ?? NOW,
      updated: options.created ?? NOW,
      source: "synthetic-test",
      confidence: 0.9,
      confidenceTier: "explicit",
      tags: [],
      status: (options.status ?? "active") as MemoryFile["frontmatter"]["status"],
      ...(options.entityRef ? { entityRef: options.entityRef } : {}),
      ...(options.attributes ? { structuredAttributes: options.attributes } : {}),
    },
  } as unknown as MemoryFile;
}

function storage(memories: MemoryFile[], coldMemories: MemoryFile[] = []): StorageManager {
  return {
    readAllMemories: async () => memories,
    readAllColdMemories: async () => coldMemories,
    getMemoryById: async (id: string) => memories.find((entry) => entry.frontmatter.id === id) ?? null,
  } as unknown as StorageManager;
}

function hit(id: string, score: number): UpdateLocalizationSearchHit {
  return { id, content: `search content for ${id}`, category: "fact", score };
}

function search(...hits: Array<UpdateLocalizationSearchHit>): (query: string, limit: number) => Promise<UpdateLocalizationSearchHit[]> {
  return async () => hits;
}

const options = {
  anchorCandidates: 5,
  searchCandidates: 5,
  maxCandidates: 8,
};

test("localizes exact entity and category anchors, excluding other entities and categories", async () => {
  const result = await localizeUpdateCandidates(
    {
      storage: storage([
        memory("same", { entityRef: "person:alice" }),
        memory("other-entity", { entityRef: "person:bob" }),
        memory("other-category", { entityRef: "person:alice", category: "decision" }),
      ]),
      qmdSearch: search(),
    },
    { entityRef: "person:alice", category: "fact" },
    "incoming",
    options,
  );

  assert.deepEqual(result.map((candidate) => candidate.id), ["same"]);
  assert.equal(result[0]?.source, "anchor");
});

test("skips anchor pass when the new fact has no entityRef", async () => {
  const result = await localizeUpdateCandidates(
    {
      storage: storage([memory("stored", { entityRef: "person:alice" })]),
      qmdSearch: search(hit("search-hit", 0.8)),
    },
    { category: "fact" },
    "incoming",
    options,
  );

  assert.deepEqual(result.map((candidate) => candidate.id), ["search-hit"]);
  assert.equal(result[0]?.source, "search");
});

test("includes only active memories in the anchor pass", async () => {
  const statuses = ["superseded", "forgotten", "archived", "pending_review", "active"];
  const result = await localizeUpdateCandidates(
    {
      storage: storage(statuses.map((status) => memory(status, { entityRef: "person:alice", status }))),
      qmdSearch: search(),
    },
    { entityRef: "person:alice", category: "fact" },
    "incoming",
    options,
  );

  assert.deepEqual(result.map((candidate) => candidate.id), ["active"]);
});

test("prefers an active cold copy over a superseded hot duplicate", async () => {
  const id = "duplicate";
  const result = await localizeUpdateCandidates(
    {
      storage: storage(
        [memory(id, { entityRef: "person:alice", status: "superseded", content: "hot copy" })],
        [memory(id, { entityRef: "person:alice", status: "active", content: "cold copy" })],
      ),
      qmdSearch: search(),
    },
    { entityRef: "person:alice", category: "fact" },
    "incoming",
    options,
  );

  assert.deepEqual(result.map((candidate) => candidate.id), [id]);
  assert.equal(result[0]?.content, "cold copy");
});

test("keeps the hot copy when duplicate statuses are both active", () => {
  const merged = mergeMemorySnapshots(
    [memory("duplicate", { content: "hot copy" })],
    [memory("duplicate", { content: "cold copy" })],
  );

  assert.deepEqual(merged.map((entry) => entry.content), ["hot copy"]);
});

test("scores matching attribute keys before recency and reuses normalized attribute keys", async () => {
  const result = await localizeUpdateCandidates(
    {
      storage: storage([
        memory("one-key", {
          entityRef: "person:alice",
          attributes: { City: "Austin" },
          created: "2026-08-08T00:00:00.000Z",
        }),
        memory("two-keys", {
          entityRef: "person:alice",
          attributes: { city: "Austin", "job title": "Engineer" },
          created: "2020-01-01T00:00:00.000Z",
        }),
      ]),
      qmdSearch: search(),
    },
    {
      entityRef: "person:alice",
      category: "fact",
      attributes: { " CITY ": "New York", "job-title": "Manager" },
    },
    "incoming",
    options,
  );

  assert.deepEqual(result.map((candidate) => candidate.id), ["two-keys", "one-key"]);
  assert.equal(result[0]?.score, 2);
  assert.equal(result[1]?.score, 1);
});

test("merges anchor results first and deduplicates search results by id", async () => {
  const result = await localizeUpdateCandidates(
    {
      storage: storage([
        memory("anchor", { entityRef: "person:alice" }),
        memory("search-only"),
      ]),
      qmdSearch: search(hit("anchor", 0.99), hit("search-only", 0.8)),
    },
    { entityRef: "person:alice", category: "fact" },
    "incoming",
    options,
  );

  assert.deepEqual(result.map((candidate) => candidate.id), ["anchor", "search-only"]);
  assert.equal(result[0]?.source, "anchor");
});

test("honors zero anchor, search, and total caps", async () => {
  let calls = 0;
  const qmdSearch = async () => {
    calls++;
    return [hit("search", 1)];
  };
  const deps = { storage: storage([memory("anchor", { entityRef: "person:alice" })]), qmdSearch };

  assert.deepEqual(
    await localizeUpdateCandidates(deps, { entityRef: "person:alice", category: "fact" }, "incoming", {
      ...options,
      anchorCandidates: 0,
    }).then((candidates) => candidates.map((candidate) => candidate.id)),
    ["search"],
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    await localizeUpdateCandidates(deps, { entityRef: "person:alice", category: "fact" }, "incoming", {
      ...options,
      searchCandidates: 0,
    }).then((candidates) => candidates.map((candidate) => candidate.id)),
    ["anchor"],
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    await localizeUpdateCandidates(deps, { entityRef: "person:alice", category: "fact" }, "incoming", {
      ...options,
      maxCandidates: 0,
    }),
    [],
  );
  assert.equal(calls, 1);
});

test("orders equal scores by id and remains deterministic across invocations", async () => {
  const deps = {
    storage: storage([memory("b", { entityRef: "person:alice" }), memory("a", { entityRef: "person:alice" })]),
    qmdSearch: search(hit("d", 0.5), hit("c", 0.5)),
  };
  const anchor = { entityRef: "person:alice", category: "fact" };
  const first = await localizeUpdateCandidates(deps, anchor, "incoming", options);
  const second = await localizeUpdateCandidates(deps, anchor, "incoming", options);

  assert.deepEqual(first, second);
  assert.deepEqual(first.map((candidate) => candidate.id), ["a", "b", "c", "d"]);
});

test("surfaces QMD failures separately from an empty search", async () => {
  const anchorDeps = {
    storage: storage([memory("anchor", { entityRef: "person:alice" })]),
    qmdSearch: async () => {
      throw new Error("qmd unavailable");
    },
  };
  await assert.rejects(
    localizeUpdateCandidates(anchorDeps, { entityRef: "person:alice", category: "fact" }, "incoming", options),
    /qmd unavailable/,
  );

  const empty = await localizeUpdateCandidates(
    { storage: storage([memory("anchor", { entityRef: "person:alice" })]), qmdSearch: search() },
    { entityRef: "person:alice", category: "fact" },
    "incoming",
    options,
  );
  assert.deepEqual(empty.map((candidate) => candidate.id), ["anchor"]);
});
function qmdResult(id: string, score: number, namespace = "default"): QmdSearchResult {
  return {
    docid: id,
    path: `/synthetic/${namespace}/${id}.md`,
    snippet: `snippet for ${id}`,
    score,
  };
}
function coordinatorFixture(
  configOverrides: Record<string, unknown> = {},
  searchAvailable = true,
  storageOverride?: StorageManager,
) {
  const candidate = memory("old", { entityRef: "person:alice", content: "Alice lives in Austin" });
  const memories = [candidate];
  const verificationCalls: Array<{ incoming: unknown; existing: unknown }> = [];
  const extraction = {
    verifyContradiction: async (incoming: unknown, existing: unknown) => {
      verificationCalls.push({ incoming, existing });
      return {
        isContradiction: true,
        confidence: 0.99,
        reasoning: "values conflict",
        whichIsNewer: "second",
      };
    },
  } as unknown as ExtractionEngine;
  const config = {
    contradictionSimilarityThreshold: 0.7,
    contradictionMinConfidence: 0.9,
    contradictionAutoResolve: true,
    contradictionLocalization: {
      anchorEnabled: true,
      anchorCandidates: 5,
      searchCandidates: 5,
      maxCandidates: 8,
    },
    ...configOverrides,
  } as unknown as PluginConfig;
  const coordinator = new ContradictionLinkingCoordinator({
    getConfig: () => config,
    isSearchAvailable: () => searchAvailable,
    searchAcrossNamespaces: async () => [],
    extractMemoryIdsFromResults: (results) => results.map((result) => result.docid),
    namespaceFromPath: () => "default",
    storageForNamespace: async () => storageOverride ?? storage(memories),
    getExtraction: () => extraction,
  });
  return { coordinator, verificationCalls, candidate };
}

test("finds a contradiction from an anchor when QMD search misses it", async () => {
  const { coordinator, verificationCalls, candidate } = coordinatorFixture();
  const result = await coordinator.checkForContradiction(
    "Alice lives in New York",
    "fact",
    "default",
    { entityRef: "person:alice", attributes: { city: "New York" } },
  );

  assert.equal(result?.supersededId, candidate.frontmatter.id);
  assert.equal(verificationCalls.length, 1);
});
test("continues with anchors and warns when QMD is unavailable", async () => {
  const warns: string[] = [];
  initLogger({ info() {}, warn: (message) => warns.push(message), error() {}, debug() {} }, false, {
    timestamps: false,
  });
  try {
    const { coordinator, candidate } = coordinatorFixture({}, false);
    const result = await coordinator.checkForContradiction(
      "Alice lives in New York",
      "fact",
      "default",
      { entityRef: "person:alice" },
    );
    assert.equal(result?.supersededId, candidate.frontmatter.id);
    assert.equal(warns.length, 1);
    assert.match(warns[0] ?? "", /QMD unavailable/);
    assert.doesNotMatch(warns[0] ?? "", /Alice lives in New York|person:alice/);
  } finally {
    initLogger({ info() {}, warn() {}, error() {}, debug() {} });
  }
});

test("localizes an active cold anchor when QMD search is unavailable", async () => {
  const coldCandidate = memory("cold-old", {
    entityRef: "person:alice",
    content: "Alice lives in Austin",
  });
  const coldStorage = {
    readAllMemories: async () => [],
    readAllColdMemories: async () => [coldCandidate],
    getMemoryById: async () => null,
  } as unknown as StorageManager;
  const { coordinator, verificationCalls } = coordinatorFixture(
    {
      contradictionLocalization: {
        anchorEnabled: true,
        anchorCandidates: 5,
        searchCandidates: 0,
        maxCandidates: 8,
      },
    },
    false,
    coldStorage,
  );
  const result = await coordinator.checkForContradiction(
    "Alice lives in New York",
    "fact",
    "default",
    { entityRef: "person:alice" },
  );
  assert.equal(result?.supersededId, coldCandidate.frontmatter.id);
  assert.equal(verificationCalls.length, 1);
});

test("disabled localization preserves the legacy fixed QMD limit", async () => {
  let requestedLimit = 0;
  const { coordinator, candidate } = coordinatorFixture({
    contradictionLocalization: {
      anchorEnabled: false,
      anchorCandidates: 0,
      searchCandidates: 0,
      maxCandidates: 0,
    },
  });
  (coordinator as unknown as { searchAcrossNamespaces: unknown }).searchAcrossNamespaces = async (
    options: { maxResults: number },
  ) => {
    requestedLimit = options.maxResults;
    return [qmdResult(candidate.frontmatter.id, 0.95)];
  };
  const result = await coordinator.checkForContradiction(
    "Alice lives in New York",
    "fact",
    "default",
  );
  assert.equal(result?.supersededId, candidate.frontmatter.id);
  assert.equal(requestedLimit, 5);
});

test("disabled localization preserves search-only verification inputs, including string false", async () => {
  const { coordinator, verificationCalls, candidate } = coordinatorFixture({
    contradictionLocalization: {
      anchorEnabled: "false",
      anchorCandidates: 5,
      searchCandidates: 5,
      maxCandidates: 8,
    },
  });
  (coordinator as unknown as { searchAcrossNamespaces: unknown }).searchAcrossNamespaces = async () => [
    qmdResult(candidate.frontmatter.id, 0.95),
  ];

  const result = await coordinator.checkForContradiction(
    "Alice lives in New York",
    "fact",
    "default",
    { entityRef: "person:alice", attributes: { city: "New York" } },
  );

  assert.equal(result?.supersededId, candidate.frontmatter.id);
  assert.deepEqual(verificationCalls, [
    {
      incoming: { content: "Alice lives in New York", category: "fact" },
      existing: {
        id: candidate.frontmatter.id,
        content: candidate.content,
        category: "fact",
        created: candidate.frontmatter.created,
      },
    },
  ]);
});
test("keeps anchor and search candidates within the requested namespace", async () => {
  const oldDefault = memory("default-old", { entityRef: "person:alice" });
  const oldOther = memory("other-old", { entityRef: "person:alice" });
  const calls: string[] = [];
  const extraction = {
    verifyContradiction: async (_incoming: unknown, existing: { id: string }) => {
      calls.push(existing.id);
      return {
        isContradiction: true,
        confidence: 0.99,
        reasoning: "values conflict",
        whichIsNewer: "second",
      };
    },
  } as unknown as ExtractionEngine;
  const coordinator = new ContradictionLinkingCoordinator({
    getConfig: () =>
      ({
        contradictionSimilarityThreshold: 0.7,
        contradictionMinConfidence: 0.9,
        contradictionAutoResolve: true,
        contradictionLocalization: {
          anchorEnabled: true,
          anchorCandidates: 5,
          searchCandidates: 5,
          maxCandidates: 8,
        },
      }) as unknown as PluginConfig,
    isSearchAvailable: () => true,
    searchAcrossNamespaces: async () => [qmdResult("other-old", 0.99, "other")],
    extractMemoryIdsFromResults: (results) => results.map((result) => result.docid),
    namespaceFromPath: (path) => (path.includes("/other/") ? "other" : "default"),
    storageForNamespace: async (namespace) => storage(namespace === "other" ? [oldOther] : [oldDefault]),
    getExtraction: () => extraction,
  });

  const result = await coordinator.checkForContradiction(
    "new content",
    "fact",
    "default",
    { entityRef: "person:alice" },
  );

  assert.equal(result?.supersededId, "default-old");
  assert.deepEqual(calls, ["default-old"]);
});
test("deferred resolve propagates invalidation from a cold anchor", async () => {
  const old = memory("cold-old", { content: "old cold claim" });
  old.frontmatter.links = [{ targetId: "dependent", linkType: "supports", strength: 0.9 }];
  old.path = "/synthetic/cold/cold-old.md";
  const dependent = memory("dependent", { content: "dependent claim" });
  dependent.frontmatter.links = [{ targetId: old.frontmatter.id, linkType: "supports", strength: 0.9 }];
  const calls: string[] = [];
  const extraction = {
    revalidateDependents: async (
      _old: unknown,
      _replacement: unknown,
      dependents: Array<{ id: string }>,
    ) => ({
      verdicts: dependents.map((item) => ({
        memoryId: item.id,
        verdict: "invalidated" as const,
        reason: "dependent invalidated",
      })),
    }),
  } as unknown as ExtractionEngine;
  const coldStorage = {
    readAllMemories: async () => [dependent],
    readAllColdMemories: async () => [old],
    getMemoryById: async (id: string) => {
      if (id === old.frontmatter.id) return null;
      if (id === dependent.frontmatter.id) return dependent;
      return memory(id, { content: "replacement claim" });
    },
    supersedeMemory: async (id: string, replacementId: string) => {
      calls.push(`${id}->${replacementId}`);
      return true;
    },
  } as unknown as StorageManager;
  const coordinator = new ContradictionLinkingCoordinator({
    getConfig: () =>
      ({
        contradictionAutoResolve: true,
        dependencyPropagation: {
          enabled: true,
          linkTypes: ["supports"],
          maxDependents: 10,
          timeoutMs: 50,
          dryRun: false,
        },
      }) as unknown as PluginConfig,
    isSearchAvailable: () => false,
    searchAcrossNamespaces: async () => [],
    extractMemoryIdsFromResults: () => [],
    namespaceFromPath: () => "default",
    storageForNamespace: async () => coldStorage,
    getExtraction: () => extraction,
  });

  await coordinator.applyDeferredContradictionResolve(
    {
      supersededId: old.frontmatter.id,
      reason: "old claim retired",
      supersededPath: old.path,
      supersededCreated: old.frontmatter.created,
      supersededTags: [],
    },
    coldStorage,
    "replacement",
    false,
  );

  assert.deepEqual(calls, ["cold-old->replacement", "dependent->replacement"]);
});
test("scores anchor candidates with missing attributes as zero when the incoming anchor has attributes", async () => {
  const result = await localizeUpdateCandidates(
    {
      storage: storage([
        memory("with-overlap", {
          entityRef: "person:alice",
          attributes: { city: "Austin" },
          created: "2020-01-01T00:00:00.000Z",
        }),
        memory("without-attributes", {
          entityRef: "person:alice",
          created: "2026-08-08T00:00:00.000Z",
        }),
      ]),
      qmdSearch: search(),
    },
    { entityRef: "person:alice", category: "fact", attributes: { city: "New York" } },
    "incoming",
    options,
  );

  assert.deepEqual(result.map((candidate) => candidate.id), ["with-overlap", "without-attributes"]);
  assert.equal(result[0]?.score, 1);
  assert.equal(result[1]?.score, 0);
});
test("preserves search candidates with pending_review status in enabled mode", async () => {
  const candidate = memory("pending", { status: "pending_review" });
  const extraction = {
    verifyContradiction: async () => ({
      isContradiction: true,
      confidence: 0.99,
      reasoning: "values conflict",
      whichIsNewer: "second",
    }),
  } as unknown as ExtractionEngine;
  const coordinator = new ContradictionLinkingCoordinator({
    getConfig: () =>
      ({
        contradictionSimilarityThreshold: 0.7,
        contradictionMinConfidence: 0.9,
        contradictionAutoResolve: true,
        contradictionLocalization: {
          anchorEnabled: true,
          anchorCandidates: 5,
          searchCandidates: 5,
          maxCandidates: 8,
        },
      }) as unknown as PluginConfig,
    isSearchAvailable: () => true,
    searchAcrossNamespaces: async () => [qmdResult("pending", 0.95)],
    extractMemoryIdsFromResults: (results) => results.map((result) => result.docid),
    namespaceFromPath: () => "default",
    storageForNamespace: async () => storage([candidate]),
    getExtraction: () => extraction,
  });

  const result = await coordinator.checkForContradiction("incoming", "fact", "default");
  assert.equal(result?.supersededId, "pending");
});

test("forwards the new content and search limit to QMD", async () => {
  const calls: Array<{ query: string; limit: number }> = [];
  const result = await localizeUpdateCandidates(
    {
      storage: storage([]),
      qmdSearch: async (query, limit) => {
        calls.push({ query, limit });
        return [hit("search-hit", 0.9)];
      },
    },
    { category: "fact" },
    "incoming content",
    { anchorCandidates: 0, searchCandidates: 3, maxCandidates: 5 },
  );

  assert.deepEqual(calls, [{ query: "incoming content", limit: 3 }]);
  assert.deepEqual(result.map((candidate) => candidate.id), ["search-hit"]);
});

test("rejects malformed entity references without reading the memory corpus", async () => {
  let readCount = 0;
  let qmdCount = 0;
  const result = await localizeUpdateCandidates(
    {
      storage: {
        readAllMemories: async () => {
          readCount++;
          return [memory("stored", { entityRef: "person:alice" })];
        },
      },
      qmdSearch: async () => {
        qmdCount++;
        return [];
      },
    },
    { entityRef: { invalid: true } as unknown as string, category: "fact" },
    "incoming content",
    { anchorCandidates: 5, searchCandidates: 0, maxCandidates: 5 },
  );

  assert.deepEqual(result, []);
  assert.equal(readCount, 0);
  assert.equal(qmdCount, 0);
});

test("normalizes extracted and stored entity references symmetrically", async () => {
  const result = await localizeUpdateCandidates(
    {
      storage: storage([memory("stored", { entityRef: "PERSON-ALICE" })]),
      qmdSearch: search(),
    },
    { entityRef: "person alice", category: "fact" },
    "incoming content",
    { anchorCandidates: 5, searchCandidates: 0, maxCandidates: 5 },
  );

  assert.deepEqual(result.map((candidate) => candidate.id), ["stored"]);
});

test("runs anchor localization when QMD is unavailable and search is disabled", async () => {
  const { coordinator, candidate } = coordinatorFixture({
    contradictionLocalization: {
      anchorEnabled: true,
      anchorCandidates: 5,
      searchCandidates: 0,
      maxCandidates: 8,
    },
  });
  (coordinator as unknown as { isSearchAvailable: () => boolean }).isSearchAvailable = () => false;

  const result = await coordinator.checkForContradiction(
    "Alice lives in New York",
    "fact",
    "default",
    { entityRef: "person:alice", attributes: { city: "New York" } },
  );

  assert.equal(result?.supersededId, candidate.frontmatter.id);
});