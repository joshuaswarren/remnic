/**
 * Issue #1902 — unit tests for the hot-memories result cache layer.
 *
 * These pin the low-level cache contract that StorageManager.readAllMemories()
 * relies on: version-keyed round-trip, the version-0 and version-mismatch null
 * guards, in-place patch-on-write / patch-on-delete, and the two invalidation
 * shapes (wholesale drop vs derived/global-only keep).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  clearMemoryCache,
  getCachedMemories,
  invalidateAllForDir,
  invalidateDerivedAndGlobalForDir,
  setCachedMemories,
  updateCacheOnDelete,
  updateCacheOnWrite,
} from "./memory-cache.js";
import type { MemoryFile } from "./types.js";

function mem(p: string, content = "x"): MemoryFile {
  return {
    path: p,
    frontmatter: { id: p, category: "fact" },
    content,
  } as unknown as MemoryFile;
}

test("hot cache: round-trips at a matching version", () => {
  const dir = "/tmp/remnic-hot-unit-a";
  clearMemoryCache();
  setCachedMemories(dir, [mem("a.md"), mem("b.md")], 3);
  const got = getCachedMemories(dir, 3);
  assert.ok(got, "expected a cache hit at the matching version");
  assert.deepEqual(got!.map((m) => m.path).sort(), ["a.md", "b.md"]);
  clearMemoryCache();
});

test("hot cache: version 0 always misses (fresh/test dirs)", () => {
  const dir = "/tmp/remnic-hot-unit-b";
  clearMemoryCache();
  setCachedMemories(dir, [mem("a.md")], 0);
  assert.equal(getCachedMemories(dir, 0), null, "version 0 must never serve a cache hit");
  clearMemoryCache();
});

test("hot cache: version mismatch misses (never serves stale)", () => {
  const dir = "/tmp/remnic-hot-unit-c";
  clearMemoryCache();
  setCachedMemories(dir, [mem("a.md")], 5);
  assert.ok(getCachedMemories(dir, 5), "same version hits");
  assert.equal(getCachedMemories(dir, 6), null, "a bumped version must miss");
  clearMemoryCache();
});

test("hot cache: updateCacheOnWrite / updateCacheOnDelete mutate the entry in place", () => {
  const dir = "/tmp/remnic-hot-unit-d";
  clearMemoryCache();
  setCachedMemories(dir, [mem("a.md")], 2);
  updateCacheOnWrite(dir, mem("b.md", "new"));
  const afterWrite = getCachedMemories(dir, 2);
  assert.deepEqual(afterWrite!.map((m) => m.path).sort(), ["a.md", "b.md"], "write adds in place");
  updateCacheOnWrite(dir, mem("a.md", "updated"));
  assert.equal(
    getCachedMemories(dir, 2)!.find((m) => m.path === "a.md")!.content,
    "updated",
    "write to an existing path replaces in place",
  );
  updateCacheOnDelete(dir, "a.md");
  assert.deepEqual(getCachedMemories(dir, 2)!.map((m) => m.path), ["b.md"], "delete removes in place");
  clearMemoryCache();
});

test("hot cache: wholesale invalidateAllForDir drops the hot layer; invalidateDerivedAndGlobalForDir keeps it", () => {
  const dir = "/tmp/remnic-hot-unit-e";
  clearMemoryCache();
  setCachedMemories(dir, [mem("a.md")], 4);
  invalidateDerivedAndGlobalForDir(dir);
  assert.ok(
    getCachedMemories(dir, 4),
    "invalidateDerivedAndGlobalForDir must NOT drop the hot layer (patch-on-write keeps it warm)",
  );
  invalidateAllForDir(dir);
  assert.equal(getCachedMemories(dir, 4), null, "invalidateAllForDir must drop the hot layer");
  clearMemoryCache();
});

test("hot cache: keyId scopes entries — a mismatched secure-store key misses (#1902 Codex P1)", () => {
  const dir = "/tmp/remnic-hot-unit-keyid";
  clearMemoryCache();
  // A keyed (unlocked encrypted) manager warms the cache with decrypted content.
  setCachedMemories(dir, [mem("secret.md", "decrypted")], 5, "secure-store:key:1");
  // A locked/unkeyed manager for the SAME dir must NOT read the decrypted entry.
  assert.equal(
    getCachedMemories(dir, 5, ""),
    null,
    "a manager without the matching key must miss the decrypted cache entry",
  );
  // A different key id also misses.
  assert.equal(getCachedMemories(dir, 5, "secure-store:key:2"), null, "a different key id misses");
  // The matching key id hits.
  const got = getCachedMemories(dir, 5, "secure-store:key:1");
  assert.ok(got, "the matching key id serves the cached corpus");
  assert.deepEqual(got!.map((m) => m.path), ["secret.md"]);
  clearMemoryCache();
});

test("hot cache: TTL expires an entry so external edits self-heal (#1902 Codex P1)", (t) => {
  const dir = "/tmp/remnic-hot-unit-ttl";
  clearMemoryCache();
  // Deterministic time control (no real timers): the entry's loadedAt is stamped
  // from the mocked clock at set time; advancing it past the TTL forces a miss.
  t.mock.timers.enable({ apis: ["Date"] });
  try {
    setCachedMemories(dir, [mem("a.md")], 9, "");
    // ttl=0 disables the TTL: always a hit at the matching version.
    assert.ok(getCachedMemories(dir, 9, "", 0), "ttl=0 disables expiry");
    // Fresh entry within a generous TTL still hits.
    assert.ok(getCachedMemories(dir, 9, "", 60_000), "fresh entry within TTL hits");
    // Advance past the TTL: the entry is now a miss, forcing a rescan that would
    // pick up any external filesystem edit that bypassed the version sentinel.
    t.mock.timers.tick(120_000);
    assert.equal(getCachedMemories(dir, 9, "", 60_000), null, "entry older than ttl is a miss");
  } finally {
    t.mock.timers.reset();
    clearMemoryCache();
  }
});
