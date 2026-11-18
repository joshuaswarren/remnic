import assert from "node:assert/strict";
import test from "node:test";

import {
  ALL_CACHE_LAYERS,
  clearMemoryCache,
  getCachedQmdSearch,
  invalidateAllForDir,
  peekQmdSearchCacheRecallScopeDepth,
  runInQmdSearchCacheRecallScope,
  setCachedQmdSearch,
} from "./memory-cache.js";
import {
  getCachedQmdRecall,
  setCachedQmdRecall,
} from "./qmd-recall-cache.js";

test("scoped memory cache invalidation clears QMD search results", () => {
  clearMemoryCache();
  setCachedQmdSearch("qmd-cache-key", [{ path: "deleted.md" }]);

  assert.deepEqual(getCachedQmdSearch("qmd-cache-key"), [{ path: "deleted.md" }]);

  clearMemoryCache("/tmp/remnic-memory");

  assert.equal(getCachedQmdSearch("qmd-cache-key"), null);
});

test("invalidateAllForDir clears both QMD cache layers (issue #1535)", () => {
  clearMemoryCache();
  setCachedQmdSearch("qmd-search-key", [{ path: "stale.md" }]);
  setCachedQmdRecall("qmd-recall-key", { bundle: "stale" }, { maxEntries: 16 });
  assert.ok(getCachedQmdSearch("qmd-search-key"));
  assert.ok(
    getCachedQmdRecall("qmd-recall-key", { freshTtlMs: 60_000, staleTtlMs: 600_000 }),
  );

  invalidateAllForDir("/tmp/remnic-memory");

  assert.equal(getCachedQmdSearch("qmd-search-key"), null);
  assert.equal(
    getCachedQmdRecall("qmd-recall-key", { freshTtlMs: 60_000, staleTtlMs: 600_000 }),
    null,
  );
});

test("ALL_CACHE_LAYERS registers the QMD recall layer alongside the QMD search layer", () => {
  const names = ALL_CACHE_LAYERS.map((layer) => layer.name);
  assert.ok(names.includes("qmd-search"));
  assert.ok(names.includes("qmd-recall"));
});

test("runInQmdSearchCacheRecallScope refcounts nested positive TTL", async () => {
  assert.equal(peekQmdSearchCacheRecallScopeDepth(), 0);
  await runInQmdSearchCacheRecallScope(60_000, async () => {
    assert.equal(peekQmdSearchCacheRecallScopeDepth(), 1);
    await runInQmdSearchCacheRecallScope(90_000, async () => {
      assert.equal(peekQmdSearchCacheRecallScopeDepth(), 2);
    });
    assert.equal(peekQmdSearchCacheRecallScopeDepth(), 1);
  });
  assert.equal(peekQmdSearchCacheRecallScopeDepth(), 0);
});

test("non-positive TTL scope does not decrement an outer recall scope", async () => {
  await runInQmdSearchCacheRecallScope(120_000, async () => {
    assert.equal(peekQmdSearchCacheRecallScopeDepth(), 1);
    await runInQmdSearchCacheRecallScope(0, async () => {
      assert.equal(peekQmdSearchCacheRecallScopeDepth(), 1);
    });
    await runInQmdSearchCacheRecallScope(Number.NaN, async () => {
      assert.equal(peekQmdSearchCacheRecallScopeDepth(), 1);
    });
  });
  assert.equal(peekQmdSearchCacheRecallScopeDepth(), 0);
});
