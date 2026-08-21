/**
 * Round-trip integration tests for the recall tag filter (issue #689).
 *
 * The filter runs post-search inside `EngramAccessService.recall()` after
 * results are hydrated from frontmatter. These tests stub the orchestrator
 * with a small in-memory storage layer that returns memories with known
 * tag sets, then drive `recall()` and assert that the response respects
 * `any` / `all` semantics.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { EngramAccessService } from "../packages/remnic-core/src/access-service.js";
import {
  applyTagFilter,
  evaluateTagFilter,
  normalizeTags,
  parseTagMatch,
} from "../packages/remnic-core/src/recall-tag-filter.js";

interface FakeMemory {
  id: string;
  path: string;
  tags: string[];
  category: string;
  content: string;
  created: string;
  updated: string;
}

function fakeMemory(overrides: Partial<FakeMemory> & { id: string; tags: string[] }): FakeMemory {
  return {
    path: `facts/${overrides.id}.md`,
    category: "fact",
    content: `body for ${overrides.id}`,
    created: "2026-01-01T00:00:00Z",
    updated: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function buildService(memories: FakeMemory[]) {
  const memoriesById = new Map(memories.map((m) => [m.id, m]));
  const memoriesByPath = new Map(memories.map((m) => [m.path, m]));
  const snapshot = {
    sessionKey: "session-1",
    recordedAt: "2026-04-25T00:00:00Z",
    queryHash: "qh",
    queryLen: 10,
    memoryIds: memories.map((m) => m.id),
    namespace: "global",
    resultPaths: memories.map((m) => m.path),
    sourcesUsed: ["qmd"],
    fallbackUsed: false,
  };
  const orchestrator = {
    config: {
      memoryDir: "/tmp/engram",
      namespacesEnabled: false,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [],
      namespacePolicies: [],
      defaultRecallNamespaces: ["self"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
      recallCrossNamespaceBudgetEnabled: false,
      recallCrossNamespaceBudgetWindowMs: 60_000,
      recallCrossNamespaceBudgetSoftLimit: 10,
      recallCrossNamespaceBudgetHardLimit: 30,
      recallDisclosureEscalation: "manual",
      recallDisclosureEscalationThreshold: 0.5,
      qmdMaxResults: 10,
    },
    recall: async () => "ctx",
    lastRecall: {
      get: () => snapshot,
      getMostRecent: () => snapshot,
    },
    getStorage: async () => ({
      dir: "/tmp/engram",
      getMemoryById: async (id: string) => {
        const m = memoriesById.get(id);
        if (!m) return null;
        return {
          path: m.path,
          content: m.content,
          frontmatter: {
            id: m.id,
            category: m.category,
            tags: m.tags,
            created: m.created,
            updated: m.updated,
          },
        };
      },
      readMemoryByPath: async (path: string) => {
        const m = memoriesByPath.get(path);
        if (!m) return null;
        return {
          path: m.path,
          content: m.content,
          frontmatter: {
            id: m.id,
            category: m.category,
            tags: m.tags,
            created: m.created,
            updated: m.updated,
          },
        };
      },
      getMemoryTimeline: async () => [],
    }),
    recallIntrospection: {
    getLastIntentSnapshot: async () => null,
    getLastGraphRecallSnapshot: async () => null,
    },
  };
  return new EngramAccessService(orchestrator as never);
}

const MEMORIES: FakeMemory[] = [
  fakeMemory({ id: "m1", tags: ["draft", "weekly-review"] }),
  fakeMemory({ id: "m2", tags: ["client-acme"] }),
  fakeMemory({ id: "m3", tags: ["draft", "client-acme"] }),
  fakeMemory({ id: "m4", tags: [] }),
];

test("recall: no tags filter returns every result", async () => {
  const service = buildService(MEMORIES);
  const response = await service.recall({ query: "test", sessionKey: "session-1" });
  assert.equal(response.results.length, 4);
  assert.deepEqual(response.results.map((r) => r.id), ["m1", "m2", "m3", "m4"]);
});

test("recall: tag-match=any keeps results carrying any of the filter tags", async () => {
  const service = buildService(MEMORIES);
  const response = await service.recall({
    query: "test",
    sessionKey: "session-1",
    tags: ["draft"],
  });
  assert.deepEqual(
    response.results.map((r) => r.id).sort(),
    ["m1", "m3"],
  );
  assert.equal(response.count, 2);
  assert.deepEqual(response.memoryIds.sort(), ["m1", "m3"]);
});

test("recall: tag-match=any with multiple tags admits any match", async () => {
  const service = buildService(MEMORIES);
  const response = await service.recall({
    query: "test",
    sessionKey: "session-1",
    tags: ["draft", "client-acme"],
    tagMatch: "any",
  });
  assert.deepEqual(
    response.results.map((r) => r.id).sort(),
    ["m1", "m2", "m3"],
  );
});

test("recall: tag-match=all requires every filter tag", async () => {
  const service = buildService(MEMORIES);
  const response = await service.recall({
    query: "test",
    sessionKey: "session-1",
    tags: ["draft", "client-acme"],
    tagMatch: "all",
  });
  assert.deepEqual(response.results.map((r) => r.id), ["m3"]);
  assert.equal(response.count, 1);
});

test("recall: tag filter with no matching tag yields zero results", async () => {
  const service = buildService(MEMORIES);
  const response = await service.recall({
    query: "test",
    sessionKey: "session-1",
    tags: ["nonexistent-tag"],
  });
  assert.equal(response.results.length, 0);
  assert.equal(response.count, 0);
  assert.deepEqual(response.memoryIds, []);
});

test("recall: tagMatch without tags is ignored (no error)", async () => {
  const service = buildService(MEMORIES);
  const response = await service.recall({
    query: "test",
    sessionKey: "session-1",
    tagMatch: "all",
  });
  assert.equal(response.results.length, 4);
});

test("recall: empty tags array is treated as no filter", async () => {
  const service = buildService(MEMORIES);
  const response = await service.recall({
    query: "test",
    sessionKey: "session-1",
    tags: [],
  });
  assert.equal(response.results.length, 4);
});

test("recall: invalid tagMatch value is rejected loudly", async () => {
  const service = buildService(MEMORIES);
  await assert.rejects(
    () => service.recall({
      query: "test",
      sessionKey: "session-1",
      tags: ["draft"],
      tagMatch: "every" as never,
    }),
    /tagMatch/,
  );
});

// ---- helper-level coverage ------------------------------------------------

test("evaluateTagFilter: empty filter admits everything", () => {
  assert.equal(evaluateTagFilter([], { tags: undefined, tagMatch: undefined }).admitted, true);
  assert.equal(evaluateTagFilter(["x"], { tags: [], tagMatch: "all" }).admitted, true);
});

test("evaluateTagFilter: any-mode admits when at least one filter tag is present", () => {
  assert.equal(
    evaluateTagFilter(["draft"], { tags: ["draft", "review"], tagMatch: "any" }).admitted,
    true,
  );
  assert.equal(
    evaluateTagFilter(["other"], { tags: ["draft"], tagMatch: "any" }).admitted,
    false,
  );
});

test("evaluateTagFilter: all-mode requires every filter tag", () => {
  assert.equal(
    evaluateTagFilter(["draft", "review"], { tags: ["draft", "review"], tagMatch: "all" }).admitted,
    true,
  );
  assert.equal(
    evaluateTagFilter(["draft"], { tags: ["draft", "review"], tagMatch: "all" }).admitted,
    false,
  );
});

test("evaluateTagFilter: comparison is case-sensitive exact match", () => {
  assert.equal(
    evaluateTagFilter(["Draft"], { tags: ["draft"], tagMatch: "any" }).admitted,
    false,
  );
});

test("normalizeTags: trims, dedupes, and returns undefined when empty", () => {
  assert.deepEqual(normalizeTags(["  draft  ", "draft", " review"]), ["draft", "review"]);
  assert.equal(normalizeTags([]), undefined);
  assert.equal(normalizeTags(["", "  "]), undefined);
  assert.equal(normalizeTags("not-an-array" as never), undefined);
});

test("parseTagMatch: accepts any/all, rejects others, passes through undefined", () => {
  assert.equal(parseTagMatch(undefined), undefined);
  assert.equal(parseTagMatch(null), undefined);
  assert.equal(parseTagMatch(""), undefined);
  assert.equal(parseTagMatch("any"), "any");
  assert.equal(parseTagMatch("all"), "all");
  assert.throws(() => parseTagMatch("every"), /invalid tagMatch/);
  assert.throws(() => parseTagMatch(123 as never), /must be a string/);
});

test("applyTagFilter: returns trace with considered/admitted counts", () => {
  const results = [
    { tags: ["a", "b"] },
    { tags: ["c"] },
    { tags: ["a"] },
  ];
  const { results: filtered, trace } = applyTagFilter(results, {
    tags: ["a"],
    tagMatch: "any",
  });
  assert.equal(filtered.length, 2);
  assert.notEqual(trace, null);
  assert.equal(trace!.name, "tag-filter");
  assert.equal(trace!.considered, 3);
  assert.equal(trace!.admitted, 2);
});

test("applyTagFilter: no filter returns null trace and original array", () => {
  const results = [{ tags: ["a"] }];
  const { results: filtered, trace } = applyTagFilter(results, {
    tags: undefined,
    tagMatch: "any",
  });
  assert.equal(trace, null);
  assert.equal(filtered, results);
});
