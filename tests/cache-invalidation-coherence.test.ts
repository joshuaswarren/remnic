/**
 * Cache invalidation coherence (issue #1535 + #1904).
 *
 * #1535 established the single invalidation chokepoint and the ALL_CACHE_LAYERS
 * registry: a mutation must never leave a stale QMD recall bundle behind, or a
 * superseded/edited memory resurfaces past the lifecycle filter.
 *
 * #1904 refines the chokepoint from "clear every layer on every write" to
 * scope-aware invalidation. The highest-frequency write — a plain fact
 * `create`, fired continuously by extraction — must no longer evict the global
 * QMD result caches or the version-keyed entity cache (which a create cannot
 * affect), while every mutate path keeps evicting the QMD caches so the
 * lifecycle-correctness contract holds. #1902's in-place hot-memories patch is
 * preserved on the single-file write paths, so the hot-memories layer's map
 * entry is not asserted here (it is patched/re-keyed, not dropped, and its
 * warmth is version-dependent given the fake seed version below).
 */
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import { StorageManager } from "../src/storage.ts";
import { ALL_CACHE_LAYERS, clearMemoryCache } from "../src/memory-cache.ts";
import {
  buildQmdRecallCacheKey,
  getCachedQmdRecall,
  setCachedQmdRecall,
} from "../src/qmd-recall-cache.ts";
import {
  getCachedEntities,
  setCachedMemories,
  setCachedArchivedMemories,
  setCachedEntities,
  setCachedEpisodeMap,
  setCachedRuleMemories,
  setCachedQmdSearch,
} from "../src/memory-cache.ts";
import { parseConfig } from "../src/config.ts";
import type { EntityFile, MemoryFile } from "../src/types.ts";

const RECALL_TTLS = { freshTtlMs: 60_000, staleTtlMs: 600_000 };

function makeMemory(id: string, filePath: string): MemoryFile {
  return {
    path: filePath,
    frontmatter: {
      id,
      category: "fact",
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      source: "test",
      confidence: 0.9,
      confidenceTier: "explicit",
      tags: [],
    },
    content: `Memory content for ${id}`,
  };
}

function makeEntity(name: string): EntityFile {
  return {
    name,
    type: "person",
    updated: new Date().toISOString(),
    facts: [`${name} is a test entity`],
    timeline: [],
    relationships: [],
    activity: [],
    aliases: [],
  };
}

/** Seed every registered cache layer for `dir`. Fails loudly when a layer
 *  has no seeder, so adding a cache layer forces updating this test. */
function seedAllLayers(dir: string): void {
  const seeders: Record<string, (baseDir: string) => void> = {
    // Seed the hot layer at a version that cannot collide with the small
    // corpus-version sentinel these tiny tests produce (issue #1902): reads
    // must miss this fake entry (version mismatch) and rescan real disk data,
    // so read-then-mutate paths (e.g. invalidateMemory) find the real memory.
    "hot-memories": (baseDir) => setCachedMemories(baseDir, [makeMemory("h1", `${baseDir}/facts/h1.md`)], 1_000_000),
    "archive-memories": (baseDir) =>
      setCachedArchivedMemories(baseDir, [makeMemory("a1", `${baseDir}/archive/a1.md`)], 1),
    entities: (baseDir) => {
      setCachedEntities(baseDir, [makeEntity("Alice")], 1);
      setCachedEntities(baseDir, [makeEntity("Bob")], 1, "schema-v2");
    },
    "derived-episode-map": (baseDir) => void setCachedEpisodeMap(baseDir, [makeMemory("e1", `${baseDir}/facts/e1.md`)], 1),
    "derived-rule-memories": (baseDir) =>
      void setCachedRuleMemories(baseDir, [makeMemory("r1", `${baseDir}/facts/r1.md`)], 1),
    "qmd-search": (baseDir) => setCachedQmdSearch(`qmd-search:${baseDir}`, [{ path: `${baseDir}/facts/h1.md` }]),
    "qmd-recall": (baseDir) => setCachedQmdRecall(`qmd-recall:${baseDir}`, { bundle: baseDir }, { maxEntries: 16 }),
  };
  for (const layer of ALL_CACHE_LAYERS) {
    const seeder = seeders[layer.name];
    assert.ok(seeder, `no seeder for cache layer "${layer.name}" — add one to this test`);
    seeder(dir);
    assert.equal(layer.hasEntriesFor(dir), true, `seeding layer "${layer.name}" had no effect`);
  }
}

function assertAllLayersEmpty(dir: string, mutation: string): void {
  for (const layer of ALL_CACHE_LAYERS) {
    assert.equal(
      layer.hasEntriesFor(dir),
      false,
      `cache layer "${layer.name}" still holds entries after ${mutation}`,
    );
  }
}

/**
 * Single-file MUTATE paths (updateMemory/writeMemoryFrontmatter) PATCH the
 * hot-memories layer in place and deliberately do NOT bump the memory-status
 * sentinel (issue #1902), so they keep three layers warm: hot-memories
 * (patched/re-keyed), entities (keyed on the unchanged memory-status), and
 * archive-memories (keyed on the untouched archive tier). Only the derived
 * (episode/rule) and global (QMD) views are cleared — the QMD clear is the
 * lifecycle-correctness contract (#1535): a superseded/edited memory must not
 * resurface from a stale recall bundle. hot is not asserted (its warmth is
 * version-dependent given the fake seed version).
 */
function assertOnlyDerivedAndGlobalCleared(dir: string, mutation: string): void {
  const keptWarm = ["entities", "archive-memories"];
  for (const layer of ALL_CACHE_LAYERS) {
    if (layer.name === "hot-memories") continue;
    if (keptWarm.includes(layer.name)) {
      assert.equal(
        layer.hasEntriesFor(dir),
        true,
        `cache layer "${layer.name}" should stay warm after ${mutation} (memory-status/archive tier unchanged)`,
      );
      continue;
    }
    assert.equal(
      layer.hasEntriesFor(dir),
      false,
      `derived/global cache layer "${layer.name}" still holds entries after ${mutation}`,
    );
  }
}

/**
 * A `memory-create` (writeMemory/writeChunk) adds a doc that changes no existing
 * doc's recall visibility and is not yet in the QMD index (issue #1904). It
 * patches the hot layer in place and evicts ONLY the derived episode/rule views,
 * keeping the global QMD result caches AND the version-keyed entity cache AND the
 * archive cache warm — the whole point of #1904 (stop nuking QMD/entity caches on
 * every fact write). hot is not asserted (patched in place, version-dependent).
 */
function assertCreateScopeCleared(dir: string, mutation: string): void {
  const keptWarm = ["entities", "archive-memories", "qmd-search", "qmd-recall"];
  for (const layer of ALL_CACHE_LAYERS) {
    if (layer.name === "hot-memories") continue;
    if (keptWarm.includes(layer.name)) {
      assert.equal(
        layer.hasEntriesFor(dir),
        true,
        `cache layer "${layer.name}" must stay warm after ${mutation} (a create cannot affect it)`,
      );
      continue;
    }
    // derived-episode-map + derived-rule-memories are refreshed on a create.
    assert.equal(
      layer.hasEntriesFor(dir),
      false,
      `derived view "${layer.name}" should be cleared after ${mutation}`,
    );
  }
}

async function withStorage(
  fn: (storage: StorageManager, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-cache-coherence-"));
  try {
    clearMemoryCache();
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    await fn(storage, storage.dir);
  } finally {
    clearMemoryCache();
    StorageManager.clearAllStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Stale-recall repro (#1535). A mutate must evict a warmed QMD recall entry
// within its TTL, or recall keeps serving the pre-edit bundle.
// ---------------------------------------------------------------------------

test("repro #1535: editing a memory invalidates a warmed QMD recall cache entry within its TTL", async () => {
  await withStorage(async (storage, dir) => {
    const { id: id } = await storage.writeMemory("fact", "the deploy target is staging", {
      source: "test",
    });

    const cacheKey = buildQmdRecallCacheKey({
      query: "what is the deploy target?",
      namespaces: ["default"],
      recallMode: "full",
      maxResults: 5,
      memoryDir: dir,
    });
    setCachedQmdRecall(cacheKey, { bundle: "the deploy target is staging" }, { maxEntries: 32 });
    const warmed = getCachedQmdRecall<{ bundle: string }>(cacheKey, RECALL_TTLS);
    assert.ok(warmed, "recall cache should be warm before the edit");
    assert.equal(warmed.value.bundle, "the deploy target is staging");

    const updated = await storage.updateMemory(id, "the deploy target is production");
    assert.equal(updated, true);

    assert.equal(
      getCachedQmdRecall(cacheKey, RECALL_TTLS),
      null,
      "recall cache served the pre-edit bundle after the memory was edited (stale-recall bug)",
    );
  });
});

// ---------------------------------------------------------------------------
// Mutation-path scope matrix (#1904). Each public storage mutation clears only
// the layers its scope can affect.
// ---------------------------------------------------------------------------

test("scope matrix: writeMemory (create) keeps QMD/entity/archive warm, refreshes derived views", async () => {
  await withStorage(async (storage, dir) => {
    seedAllLayers(dir);
    await storage.writeMemory("fact", "a brand new memory", { source: "test" });
    assertCreateScopeCleared(dir, "writeMemory");
  });
});

test("scope matrix: updateMemory (mutate) clears the derived + QMD views, keeps entities/archive", async () => {
  await withStorage(async (storage, dir) => {
    const { id: id } = await storage.writeMemory("fact", "original content", { source: "test" });
    seedAllLayers(dir);
    assert.equal(await storage.updateMemory(id, "edited content"), true);
    assertOnlyDerivedAndGlobalCleared(dir, "updateMemory");
  });
});

test("scope matrix: writeMemoryFrontmatter (mutate) clears the derived + QMD views", async () => {
  await withStorage(async (storage, dir) => {
    const { id: id } = await storage.writeMemory("fact", "frontmatter target", { source: "test" });
    const memory = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(memory);
    seedAllLayers(dir);
    assert.equal(await storage.writeMemoryFrontmatter(memory, { tags: ["patched"] }), true);
    assertOnlyDerivedAndGlobalCleared(dir, "writeMemoryFrontmatter");
  });
});

test("scope matrix: archiveMemory clears every cache layer (status bump backstop)", async () => {
  await withStorage(async (storage, dir) => {
    const { id: id } = await storage.writeMemory("fact", "archive target", { source: "test" });
    const memory = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(memory);
    seedAllLayers(dir);
    assert.equal(typeof (await storage.archiveMemory(memory)), "string");
    assertAllLayersEmpty(dir, "archiveMemory");
  });
});

test("scope matrix: invalidateMemory clears every cache layer (status bump backstop)", async () => {
  await withStorage(async (storage, dir) => {
    const { id: id } = await storage.writeMemory("fact", "invalidate target", { source: "test" });
    seedAllLayers(dir);
    assert.equal(await storage.invalidateMemory(id), true);
    assertAllLayersEmpty(dir, "invalidateMemory");
  });
});

test("scope matrix: supersedeMemory clears every cache layer and evicts QMD", async () => {
  await withStorage(async (storage, dir) => {
    const { id: oldId } = await storage.writeMemory("fact", "old fact", { source: "test" });
    const { id: newId } = await storage.writeMemory("fact", "new fact", { source: "test" });
    seedAllLayers(dir);
    assert.equal(await storage.supersedeMemory(oldId, newId, "newer replaces older"), true);
    assertAllLayersEmpty(dir, "supersedeMemory");
  });
});

test("scope matrix: writeEntity clears entities + QMD (entity-write scope)", async () => {
  await withStorage(async (storage, dir) => {
    seedAllLayers(dir);
    await storage.writeEntity("Test Person", "person", ["Test Person is a test entity"], {
      source: "test",
    });
    // writeEntity bumps memory-status (the correctness backstop kept full per
    // #1904 Step 3.4), so it clears every layer — a superset of the entity-write
    // scope. The entity-write guarantee (entities + QMD cleared) is what matters.
    for (const name of ["entities", "qmd-search", "qmd-recall"]) {
      const layer = ALL_CACHE_LAYERS.find((l) => l.name === name);
      assert.ok(layer);
      assert.equal(layer.hasEntriesFor(dir), false, `entity-write must clear "${name}"`);
    }
    assertAllLayersEmpty(dir, "writeEntity");
  });
});

test("scope matrix: cold-only tier invalidation clears every cache layer", async () => {
  await withStorage(async (storage, dir) => {
    seedAllLayers(dir);
    // The cold-only branch of invalidateMemoryCachesForTiers (used by
    // maintenance/purge) bypasses invalidateAllMemoriesCache(); the
    // chokepoint must still fire via invalidateColdMemoriesCache().
    storage.invalidateMemoryCachesForTiers(["cold"]);
    assertAllLayersEmpty(dir, "invalidateMemoryCachesForTiers([cold])");
  });
});

test("scope matrix: setSecureStoreKey clears every cache layer (secure-key-change)", async () => {
  await withStorage(async (storage, dir) => {
    seedAllLayers(dir);
    storage.setSecureStoreKey(null);
    assertAllLayersEmpty(dir, "setSecureStoreKey");
  });
});

// ---------------------------------------------------------------------------
// #1904 create keeps the QMD recall + entity caches warm; a mutate evicts QMD.
// ---------------------------------------------------------------------------

test("#1904: concurrent creates leave a warmed QMD recall entry and the entity cache intact; a mutate evicts QMD", async () => {
  await withStorage(async (storage, dir) => {
    // Warm a QMD recall entry and the entity cache the way recall/KI do.
    const recallKey = buildQmdRecallCacheKey({
      query: "who is on call?",
      namespaces: ["default"],
      recallMode: "full",
      maxResults: 5,
      memoryDir: dir,
    });
    setCachedQmdRecall(recallKey, { bundle: "on-call rotation" }, { maxEntries: 32 });
    setCachedEntities(dir, [makeEntity("Alice")], storage.getMemoryStatusVersion());

    const entitiesLayer = ALL_CACHE_LAYERS.find((l) => l.name === "entities");
    assert.ok(entitiesLayer);

    for (let i = 0; i < 5; i++) {
      await storage.writeMemory("fact", `concurrent create ${i}`, { source: "test" });
      assert.ok(
        getCachedQmdRecall(recallKey, RECALL_TTLS),
        `QMD recall entry must survive create #${i} (a create is not in the QMD index yet)`,
      );
      assert.equal(entitiesLayer.hasEntriesFor(dir), true, `entity cache must survive create #${i}`);
    }

    // A single mutate must evict the warmed recall bundle.
    const { id } = await storage.writeMemory("fact", "mutable fact", { source: "test" });
    setCachedQmdRecall(recallKey, { bundle: "on-call rotation" }, { maxEntries: 32 });
    assert.ok(getCachedQmdRecall(recallKey, RECALL_TTLS), "re-warmed before the mutate");
    assert.equal(await storage.updateMemory(id, "mutated fact"), true);
    assert.equal(
      getCachedQmdRecall(recallKey, RECALL_TTLS),
      null,
      "a mutate must evict the warmed QMD recall entry",
    );
  });
});

test("#1904: a superseded memory cannot be served from a pre-supersede recall bundle", async () => {
  await withStorage(async (storage, dir) => {
    const { id: oldId } = await storage.writeMemory("fact", "the office is in Dallas", { source: "test" });
    const { id: newId } = await storage.writeMemory("fact", "the office is in Austin", { source: "test" });
    const recallKey = buildQmdRecallCacheKey({
      query: "where is the office?",
      namespaces: ["default"],
      recallMode: "full",
      maxResults: 5,
      memoryDir: dir,
    });
    setCachedQmdRecall(recallKey, { bundle: "the office is in Dallas" }, { maxEntries: 32 });
    assert.ok(getCachedQmdRecall(recallKey, RECALL_TTLS), "warm before supersede");

    assert.equal(await storage.supersedeMemory(oldId, newId, "moved office"), true);
    assert.equal(
      getCachedQmdRecall(recallKey, RECALL_TTLS),
      null,
      "supersede must evict the pre-supersede recall bundle so the superseded fact cannot resurface",
    );
  });
});

test("#1904: entity cache survives 1000 sequential fact creates without a status bump", async () => {
  await withStorage(async (storage, dir) => {
    // Establish a non-zero memory-status version (the entity cache never caches
    // at version 0). writeEntity bumps memory-status and clears the entity cache.
    await storage.writeEntity("Alice", "person", ["Alice is a test entity"], { source: "test" });
    const v1 = storage.getMemoryStatusVersion();
    assert.ok(v1 > 0, "writeEntity must bump memory-status above 0");
    // Warm the entity cache at that version, the way readAllEntityFiles()/
    // buildKnowledgeIndex() do.
    setCachedEntities(dir, [makeEntity("Alice"), makeEntity("Bob")], v1);
    assert.ok(getCachedEntities(dir, v1), "entity cache warm before the create burst");

    for (let i = 0; i < 1000; i++) {
      await storage.writeMemory("fact", `bulk create ${i}`, { source: "test" });
    }

    // Creates do NOT bump memory-status (issue #1902/#1904), so the version the
    // entity cache keys on is unchanged and the cache is never invalidated —
    // no per-create re-read of the ~1,800-file entity dir.
    assert.equal(storage.getMemoryStatusVersion(), v1, "a fact create must not bump memory-status");
    assert.ok(
      getCachedEntities(dir, v1),
      "entity cache must survive 1000 creates without a re-read (create scope does not evict entities)",
    );
  });
});

// ---------------------------------------------------------------------------
// Rollback lever: scopedCacheInvalidationEnabled=false restores pre-#1904
// behavior — a create evicts the derived + QMD views (the #1902 baseline).
// ---------------------------------------------------------------------------

test("#1904 rollback: scopedCacheInvalidationEnabled=false makes a create evict the QMD caches (legacy)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-cache-legacy-"));
  try {
    clearMemoryCache();
    StorageManager.setScopedCacheInvalidationDefault(dir, false);
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    seedAllLayers(dir);
    await storage.writeMemory("fact", "legacy create", { source: "test" });
    // Legacy (#1902) create path: derived + global QMD views cleared,
    // entities + archive kept warm. In particular the QMD caches ARE evicted,
    // unlike the scoped-on create above.
    assertOnlyDerivedAndGlobalCleared(dir, "writeMemory (scoped off)");
  } finally {
    clearMemoryCache();
    StorageManager.clearAllStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Cross-instance coherence: a create on A is visible to B; a mutate on A
// evicts A's QMD recall cache (the global caches remain eagerly cleared).
// ---------------------------------------------------------------------------

test("cross-instance: a create on A is visible to B; a mutate evicts the QMD recall cache", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-cache-xproc-"));
  try {
    clearMemoryCache();
    const a = new StorageManager(dir);
    await a.ensureDirectories();
    const b = new StorageManager(dir);

    const { id } = await a.writeMemory("fact", "shared fact one", { source: "test" });
    const seenByB = (await b.readAllMemories()).some((m) => m.frontmatter.id === id);
    assert.ok(seenByB, "instance B must observe A's create (corpus version bump forces a rescan)");

    const recallKey = buildQmdRecallCacheKey({
      query: "shared?",
      namespaces: ["default"],
      recallMode: "full",
      maxResults: 5,
      memoryDir: dir,
    });
    setCachedQmdRecall(recallKey, { bundle: "shared fact one" }, { maxEntries: 8 });
    assert.ok(getCachedQmdRecall(recallKey, RECALL_TTLS), "warm before the mutate");
    assert.equal(await a.updateMemory(id, "shared fact two"), true);
    assert.equal(
      getCachedQmdRecall(recallKey, RECALL_TTLS),
      null,
      "a mutate must evict the global QMD recall cache",
    );
  } finally {
    clearMemoryCache();
    StorageManager.clearAllStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Zero-limit semantics are unchanged (#1904 must not alter caching disable).
// ---------------------------------------------------------------------------

test("zero-limit: qmdRecallCacheMaxEntries:0 disables recall caching (unchanged by #1904)", () => {
  clearMemoryCache();
  const key = "zero-limit-key";
  setCachedQmdRecall(key, { bundle: "y" }, { maxEntries: 0 });
  assert.equal(getCachedQmdRecall(key, RECALL_TTLS), null, "maxEntries:0 must not cache the recall bundle");
});

// ---------------------------------------------------------------------------
// Config defaults (#1904): both flags default true, explicit false preserved.
// ---------------------------------------------------------------------------

test("config: scoped-invalidation flags default true and preserve an explicit false", () => {
  const dflt = parseConfig({ memoryDir: "/tmp/remnic-config-defaults" });
  assert.equal(dflt.scopedCacheInvalidationEnabled, true, "scopedCacheInvalidationEnabled defaults true");
  assert.equal(dflt.graphEdgeCacheIncrementalEnabled, true, "graphEdgeCacheIncrementalEnabled defaults true");

  const off = parseConfig({
    memoryDir: "/tmp/remnic-config-off",
    scopedCacheInvalidationEnabled: false,
    graphEdgeCacheIncrementalEnabled: false,
  });
  assert.equal(off.scopedCacheInvalidationEnabled, false, "explicit false preserved");
  assert.equal(off.graphEdgeCacheIncrementalEnabled, false, "explicit false preserved");
});

// ---------------------------------------------------------------------------
// Registration fitness: every module-level cache store is registered in
// ALL_CACHE_LAYERS, and every layer declares a non-empty evictOn (#1904) so a
// new layer must state which mutation scopes evict it.
// ---------------------------------------------------------------------------

test("fitness: every module-level cache store is registered in ALL_CACHE_LAYERS with an evictOn", async () => {
  const cacheModules = [
    new URL("../packages/remnic-core/src/memory-cache.ts", import.meta.url),
    new URL("../packages/remnic-core/src/qmd-recall-cache.ts", import.meta.url),
  ];
  let moduleLevelStores = 0;
  for (const moduleUrl of cacheModules) {
    const source = await readFile(moduleUrl, "utf8");
    // Module-level (column-0) Map declarations are cache stores; Maps built
    // inside functions are transient values and intentionally not counted.
    moduleLevelStores += (source.match(/^const \w+ = new Map/gm) ?? []).length;
  }
  assert.equal(
    moduleLevelStores,
    ALL_CACHE_LAYERS.length,
    "a module-level cache store in memory-cache.ts / qmd-recall-cache.ts is not registered in " +
      "ALL_CACHE_LAYERS (or a layer was removed without deleting its store). Register the layer " +
      "and add a seeder to the mutation-matrix tests in this file.",
  );

  for (const layer of ALL_CACHE_LAYERS) {
    assert.ok(
      Object.keys(layer.evictOn).length > 0,
      `cache layer "${layer.name}" declares no evictOn scopes — a layer must state which mutations evict it (#1904)`,
    );
  }
});
