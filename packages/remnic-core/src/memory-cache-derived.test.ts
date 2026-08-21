/**
 * Issue #2481 — the derived cache layers (episode map, rule memories) share
 * one getVersionedCacheEntry read gate with the hot layer. These pin the
 * per-layer contracts that must keep holding after that dedup: version-keyed
 * round-trip, version-mismatch miss, keyId mismatch miss, and TTL expiry
 * miss on EACH layer. (Hot-layer equivalents live in memory-cache-hot.test.ts.)
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  clearMemoryCache,
  getCachedEpisodeMap,
  getCachedRuleMemories,
  setCachedEpisodeMap,
  setCachedRuleMemories,
} from "./memory-cache.js";
import type { MemoryFile } from "./types.js";

function mem(path: string, id: string, category = "fact", memoryKind?: string): MemoryFile {
  return {
    path,
    frontmatter: { id, category, ...(memoryKind ? { memoryKind } : {}) },
    content: "x",
  } as unknown as MemoryFile;
}

const EPISODE = mem("a.md", "ep-1", "fact", "episode");

test("episode map: matching version hits; version or keyId mismatch misses", () => {
  const dir = "/tmp/remnic-derived-ep-ver";
  clearMemoryCache();
  setCachedEpisodeMap(dir, [EPISODE], 7, true, "key:1");
  const got = getCachedEpisodeMap(dir, 7, "key:1");
  assert.ok(got, "expected a hit at the matching version and keyId");
  assert.deepEqual([...got.keys()], ["ep-1"]);
  assert.equal(getCachedEpisodeMap(dir, 8, "key:1"), null, "a bumped version must miss");
  assert.equal(getCachedEpisodeMap(dir, 7, "key:2"), null, "a mismatched keyId must miss");
  clearMemoryCache();
});

test("episode map: TTL expiry misses; ttl=0 disables expiry", (t) => {
  const dir = "/tmp/remnic-derived-ep-ttl";
  clearMemoryCache();
  t.mock.timers.enable({ apis: ["Date"] });
  try {
    setCachedEpisodeMap(dir, [EPISODE], 9);
    assert.ok(getCachedEpisodeMap(dir, 9, "", 60_000), "fresh entry within TTL hits");
    t.mock.timers.tick(120_000);
    assert.equal(getCachedEpisodeMap(dir, 9, "", 60_000), null, "entry older than ttl is a miss");
    setCachedEpisodeMap(dir, [EPISODE], 9);
    t.mock.timers.tick(600_000);
    assert.ok(getCachedEpisodeMap(dir, 9, "", 0), "ttl=0 disables expiry");
  } finally {
    t.mock.timers.reset();
    clearMemoryCache();
  }
});

test("rule memories: matching version hits; version or keyId mismatch misses", () => {
  const dir = "/tmp/remnic-derived-rule-ver";
  clearMemoryCache();
  setCachedRuleMemories(dir, [mem("r.md", "r-1", "rule"), mem("f.md", "f-1", "fact")], 7, true, "key:1");
  const got = getCachedRuleMemories(dir, 7, "key:1");
  assert.ok(got, "expected a hit at the matching version and keyId");
  assert.deepEqual(got.all.map((m) => m.frontmatter.id), ["r-1"], "only rule-category memories in all");
  assert.ok(got.byId.has("f-1"), "byId indexes every memory");
  assert.equal(getCachedRuleMemories(dir, 8, "key:1"), null, "a bumped version must miss");
  assert.equal(getCachedRuleMemories(dir, 7, "key:2"), null, "a mismatched keyId must miss");
  clearMemoryCache();
});

test("rule memories: TTL expiry misses; ttl=0 disables expiry", (t) => {
  const dir = "/tmp/remnic-derived-rule-ttl";
  clearMemoryCache();
  t.mock.timers.enable({ apis: ["Date"] });
  try {
    setCachedRuleMemories(dir, [mem("r.md", "r-1", "rule")], 9);
    assert.ok(getCachedRuleMemories(dir, 9, "", 60_000), "fresh entry within TTL hits");
    t.mock.timers.tick(120_000);
    assert.equal(getCachedRuleMemories(dir, 9, "", 60_000), null, "entry older than ttl is a miss");
    setCachedRuleMemories(dir, [mem("r.md", "r-1", "rule")], 9);
    t.mock.timers.tick(600_000);
    assert.ok(getCachedRuleMemories(dir, 9, "", 0), "ttl=0 disables expiry");
  } finally {
    t.mock.timers.reset();
    clearMemoryCache();
  }
});
