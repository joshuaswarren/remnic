import assert from "node:assert/strict";
import test from "node:test";

import {
  buildQmdRecallCacheKey,
  clearQmdRecallCache,
  getCachedQmdRecall,
  setCachedQmdRecall,
} from "./qmd-recall-cache.js";

test("qmd recall cache returns fresh and then stale entries within TTL windows", async () => {
  clearQmdRecallCache();
  const key = buildQmdRecallCacheKey({
    query: "API Rate Limit issue",
    namespaces: ["work", "default"],
    recallMode: "full",
    maxResults: 8,
    memoryDir: "/tmp/engram-a",
    searchOptions: { intent: "debug", explain: true },
  });

  setCachedQmdRecall(key, { hits: ["a"] }, { maxEntries: 8 });

  const fresh = getCachedQmdRecall<{ hits: string[] }>(key, {
    freshTtlMs: 50,
    staleTtlMs: 250,
  });
  assert.equal(fresh?.source, "fresh");
  assert.deepEqual(fresh?.value.hits, ["a"]);

  await new Promise((resolve) => setTimeout(resolve, 75));

  const stale = getCachedQmdRecall<{ hits: string[] }>(key, {
    freshTtlMs: 50,
    staleTtlMs: 250,
  });
  assert.equal(stale?.source, "stale");
  assert.deepEqual(stale?.value.hits, ["a"]);
});

test("qmd recall cache key normalizes query and namespace ordering", () => {
  const left = buildQmdRecallCacheKey({
    query: "  API   RATE limit  ",
    namespaces: ["b", "a"],
    recallMode: "minimal",
    maxResults: 4,
    memoryDir: "/tmp/engram-a",
  });
  const right = buildQmdRecallCacheKey({
    query: "api rate limit",
    namespaces: ["a", "b"],
    recallMode: "minimal",
    maxResults: 4,
    memoryDir: "/tmp/engram-a",
  });

  assert.equal(left, right);
});

test("qmd recall cache key scopes entries by memory root", () => {
  const left = buildQmdRecallCacheKey({
    query: "api rate limit",
    namespaces: ["a", "b"],
    recallMode: "minimal",
    maxResults: 4,
    memoryDir: "/tmp/engram-a",
  });
  const right = buildQmdRecallCacheKey({
    query: "api rate limit",
    namespaces: ["a", "b"],
    recallMode: "minimal",
    maxResults: 4,
    memoryDir: "/tmp/engram-b",
  });

  assert.notEqual(left, right);
});

test("qmd recall cache key reflects all defined search options", () => {
  const left = buildQmdRecallCacheKey({
    query: "api rate limit",
    namespaces: ["a", "b"],
    recallMode: "minimal",
    maxResults: 4,
    memoryDir: "/tmp/engram-a",
    searchOptions: { intent: "debug", explain: true },
  });
  const right = buildQmdRecallCacheKey({
    query: "api rate limit",
    namespaces: ["a", "b"],
    recallMode: "minimal",
    maxResults: 4,
    memoryDir: "/tmp/engram-a",
    searchOptions: { intent: "debug", explain: false },
  });

  assert.notEqual(left, right);
});

test("qmd recall cache key reflects search and subprocess strategy (codex review #1422)", () => {
  const base = {
    query: "api rate limit",
    namespaces: ["a", "b"],
    recallMode: "minimal" as const,
    maxResults: 4,
    memoryDir: "/tmp/engram-a",
  };
  const hybrid = buildQmdRecallCacheKey({ ...base, searchStrategy: "hybrid", subprocessStrategy: "query" });
  const lex = buildQmdRecallCacheKey({ ...base, searchStrategy: "lex", subprocessStrategy: "query" });
  const bm25Fallback = buildQmdRecallCacheKey({ ...base, searchStrategy: "hybrid", subprocessStrategy: "search" });

  assert.notEqual(hybrid, lex, "different search strategies must not share a recall cache entry");
  assert.notEqual(hybrid, bm25Fallback, "different subprocess strategies must not share a recall cache entry");
});

test("qmd recall cache returns cloned values so callers cannot mutate cached entries", () => {
  clearQmdRecallCache();
  const key = buildQmdRecallCacheKey({
    query: "api rate limit",
    namespaces: ["a", "b"],
    recallMode: "minimal",
    maxResults: 4,
    memoryDir: "/tmp/engram-a",
  });

  const original = {
    memoryResultsLists: [[{ id: "r1", score: 0.8 }]],
    globalResults: [],
    preAugmentTopScore: 0.8,
    maxSpecializedScore: 0,
  };
  setCachedQmdRecall(key, original, { maxEntries: 8 });

  const originalFirstHit = original.memoryResultsLists[0]?.[0];
  if (!originalFirstHit) throw new Error("expected original hit");
  originalFirstHit.score = 0.1;

  const fresh = getCachedQmdRecall<typeof original>(key, {
    freshTtlMs: 250,
    staleTtlMs: 500,
  });
  assert.equal(fresh?.value.memoryResultsLists[0]?.[0]?.score, 0.8);

  if (!fresh) throw new Error("expected cached entry");
  const cachedFirstHit = fresh.value.memoryResultsLists[0]?.[0];
  if (!cachedFirstHit) throw new Error("expected cached hit");
  cachedFirstHit.score = 0.3;

  const again = getCachedQmdRecall<typeof original>(key, {
    freshTtlMs: 250,
    staleTtlMs: 500,
  });
  assert.equal(again?.value.memoryResultsLists[0]?.[0]?.score, 0.8);
});
