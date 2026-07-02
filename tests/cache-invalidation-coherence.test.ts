/**
 * Cache invalidation coherence (issue #1535).
 *
 * Memory mutations must invalidate EVERY process-level cache layer through
 * the single chokepoint (`invalidateAllForDir` in memory-cache.ts). Before
 * this fix, the QMD recall cache (qmd-recall-cache.ts) was never invalidated
 * on mutations — `clearQmdRecallCache()` was only called from test teardown —
 * so editing or storing a memory left recall serving the pre-edit bundle for
 * the remainder of the cache's fresh/stale TTL window.
 *
 * The stale-recall repro below fails on main without the chokepoint wiring.
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
  setCachedMemories,
  setCachedArchivedMemories,
  setCachedEntities,
  setCachedEpisodeMap,
  setCachedRuleMemories,
  setCachedQmdSearch,
} from "../src/memory-cache.ts";
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
    "hot-memories": (baseDir) => setCachedMemories(baseDir, [makeMemory("h1", `${baseDir}/facts/h1.md`)], 1),
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
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Stale-recall repro (prove-fail-before). On main, storage mutations never
// touch the QMD recall cache, so the final assertion fails: recall keeps
// serving the pre-edit bundle within the fresh TTL.
// ---------------------------------------------------------------------------

test("repro #1535: editing a memory invalidates a warmed QMD recall cache entry within its TTL", async () => {
  await withStorage(async (storage, dir) => {
    // 1. Store a memory.
    const id = await storage.writeMemory("fact", "the deploy target is staging", {
      source: "test",
    });

    // 2. Warm the recall cache the way the orchestrator does after a QMD
    //    phase completes (orchestrator.ts setCachedQmdRecall call).
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

    // 3. Edit the memory well within the fresh TTL window.
    const updated = await storage.updateMemory(id, "the deploy target is production");
    assert.equal(updated, true);

    // 4. A recall within the TTL must NOT serve the pre-edit bundle: the
    //    mutation must have evicted the cached entry so the next recall
    //    re-runs QMD and reflects the edit.
    assert.equal(
      getCachedQmdRecall(cacheKey, RECALL_TTLS),
      null,
      "recall cache served the pre-edit bundle after the memory was edited (stale-recall bug)",
    );
  });
});

// ---------------------------------------------------------------------------
// Mutation-path matrix: every public storage mutation path must clear every
// registered cache layer (rule 37: cache invalidation must clear ALL layers).
// ---------------------------------------------------------------------------

test("mutation matrix: writeMemory clears every cache layer", async () => {
  await withStorage(async (storage, dir) => {
    seedAllLayers(dir);
    await storage.writeMemory("fact", "a brand new memory", { source: "test" });
    assertAllLayersEmpty(dir, "writeMemory");
  });
});

test("mutation matrix: updateMemory clears every cache layer", async () => {
  await withStorage(async (storage, dir) => {
    const id = await storage.writeMemory("fact", "original content", { source: "test" });
    seedAllLayers(dir);
    assert.equal(await storage.updateMemory(id, "edited content"), true);
    assertAllLayersEmpty(dir, "updateMemory");
  });
});

test("mutation matrix: writeMemoryFrontmatter clears every cache layer", async () => {
  await withStorage(async (storage, dir) => {
    const id = await storage.writeMemory("fact", "frontmatter target", { source: "test" });
    const memory = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(memory);
    seedAllLayers(dir);
    assert.equal(await storage.writeMemoryFrontmatter(memory, { tags: ["patched"] }), true);
    assertAllLayersEmpty(dir, "writeMemoryFrontmatter");
  });
});

test("mutation matrix: archiveMemory clears every cache layer", async () => {
  await withStorage(async (storage, dir) => {
    const id = await storage.writeMemory("fact", "archive target", { source: "test" });
    const memory = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(memory);
    seedAllLayers(dir);
    assert.equal(typeof (await storage.archiveMemory(memory)), "string");
    assertAllLayersEmpty(dir, "archiveMemory");
  });
});

test("mutation matrix: invalidateMemory clears every cache layer", async () => {
  await withStorage(async (storage, dir) => {
    const id = await storage.writeMemory("fact", "invalidate target", { source: "test" });
    seedAllLayers(dir);
    assert.equal(await storage.invalidateMemory(id), true);
    assertAllLayersEmpty(dir, "invalidateMemory");
  });
});

test("mutation matrix: supersedeMemory clears every cache layer", async () => {
  await withStorage(async (storage, dir) => {
    const oldId = await storage.writeMemory("fact", "old fact", { source: "test" });
    const newId = await storage.writeMemory("fact", "new fact", { source: "test" });
    seedAllLayers(dir);
    assert.equal(await storage.supersedeMemory(oldId, newId, "newer replaces older"), true);
    assertAllLayersEmpty(dir, "supersedeMemory");
  });
});

test("mutation matrix: writeEntity clears every cache layer", async () => {
  await withStorage(async (storage, dir) => {
    seedAllLayers(dir);
    await storage.writeEntity("Test Person", "person", ["Test Person is a test entity"], {
      source: "test",
    });
    assertAllLayersEmpty(dir, "writeEntity");
  });
});

test("mutation matrix: cold-only tier invalidation clears every cache layer", async () => {
  await withStorage(async (storage, dir) => {
    seedAllLayers(dir);
    // The cold-only branch of invalidateMemoryCachesForTiers (used by
    // maintenance/purge) bypasses invalidateAllMemoriesCache(); the
    // chokepoint must still fire via invalidateColdMemoriesCache().
    storage.invalidateMemoryCachesForTiers(["cold"]);
    assertAllLayersEmpty(dir, "invalidateMemoryCachesForTiers([cold])");
  });
});

// ---------------------------------------------------------------------------
// Registration fitness: every module-level cache store in memory-cache.ts and
// qmd-recall-cache.ts must be registered in ALL_CACHE_LAYERS. Adding a cache
// Map to either module without registering it (and adding a seeder above)
// fails this test — an unregistered layer is invisible to the chokepoint,
// which is exactly how the stale-recall bug happened.
// ---------------------------------------------------------------------------

test("fitness: every module-level cache store is registered in ALL_CACHE_LAYERS", async () => {
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
});
