import assert from "node:assert/strict";
import test from "node:test";

import {
  ALL_CACHE_LAYERS,
  clearMemoryCache,
  getCachedQmdSearch,
  invalidateAllForDir,
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

test("overlapping QMD recalls enforce their own TTL without evicting each other's entries", async (t) => {
  let now = 1_000;
  t.mock.method(Date, "now", () => now);
  clearMemoryCache();
  const hits = [{ path: "facts/current.md" }];
  const key = "shared-recall-cache-entry";
  setCachedQmdSearch(key, hits);
  now += 70_000;

  const release = Promise.withResolvers<void>();
  const long = runInQmdSearchCacheRecallScope(120_000, async () => {
    await release.promise;
    return getCachedQmdSearch(key);
  });
  try {
    const short = await runInQmdSearchCacheRecallScope(60_000, async () => getCachedQmdSearch(key));
    assert.equal(short, null);
    assert.equal(getCachedQmdSearch(key), null);
  } finally {
    release.resolve();
    await long;
  }
  assert.deepEqual(await long, hits);
});

test("QMD search cache evicts the oldest write at capacity", () => {
  clearMemoryCache();
  const hits = [{ path: "facts/current.md" }];
  for (let i = 0; i < 200; i++) setCachedQmdSearch(`qmd-cache-${i}`, hits);
  setCachedQmdSearch("qmd-cache-new", hits);
  assert.equal(getCachedQmdSearch("qmd-cache-0"), null);
  assert.deepEqual(getCachedQmdSearch("qmd-cache-1"), hits);
  assert.deepEqual(getCachedQmdSearch("qmd-cache-new"), hits);
});

test("nested QMD scopes restore the outer TTL even if the inner callback fails", async (t) => {
  const clock = t.mock.method(Date, "now", () => 1_000);
  clearMemoryCache();
  const key = "nested-recall-cache-entry";
  const hits = [{ path: "facts/current.md" }];
  setCachedQmdSearch(key, hits);
  clock.mock.mockImplementation(() => 71_000);

  await runInQmdSearchCacheRecallScope(120_000, async () => {
    await assert.rejects(runInQmdSearchCacheRecallScope(Number.NaN, async () => {
      assert.equal(getCachedQmdSearch(key), null);
      throw new Error("inner recall failed");
    }), /inner recall failed/);
    assert.deepEqual(getCachedQmdSearch(key), hits);
  });
  assert.equal(getCachedQmdSearch(key), null);
});
