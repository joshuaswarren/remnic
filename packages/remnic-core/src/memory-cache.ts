import type { EntityFile, MemoryFile } from "./types.js";
import { clearQmdRecallCache, qmdRecallCacheSize } from "./qmd-recall-cache.js";

interface CacheEntry {
  memories: Map<string, MemoryFile>; // keyed by file path
  version: number;
  loadedAt: number;
}

// Module-level singleton — shared across all StorageManager instances and sessions
const hotCacheByDir = new Map<string, CacheEntry>();
const archiveCacheByDir = new Map<string, CacheEntry>();

export function getCachedMemories(baseDir: string, currentVersion: number): MemoryFile[] | null {
  // Don't serve from cache when version tracking is unavailable (version=0).
  // This ensures tests and fresh installs without a version file always read disk.
  if (currentVersion === 0) return null;
  const entry = hotCacheByDir.get(baseDir);
  if (!entry || entry.version !== currentVersion) return null;
  return [...entry.memories.values()];
}

export function setCachedMemories(baseDir: string, memories: MemoryFile[], version: number): void {
  const map = new Map<string, MemoryFile>();
  for (const m of memories) map.set(m.path, m);
  hotCacheByDir.set(baseDir, { memories: map, version, loadedAt: Date.now() });
}

export function updateCacheOnWrite(baseDir: string, memory: MemoryFile): void {
  const entry = hotCacheByDir.get(baseDir);
  if (entry) entry.memories.set(memory.path, memory);
}

export function updateCacheOnDelete(baseDir: string, filePath: string): void {
  const entry = hotCacheByDir.get(baseDir);
  if (entry) entry.memories.delete(filePath);
}

// Archive cache — same pattern, separate store
export function getCachedArchivedMemories(baseDir: string, currentVersion: number): MemoryFile[] | null {
  if (currentVersion === 0) return null;
  const entry = archiveCacheByDir.get(baseDir);
  if (!entry || entry.version !== currentVersion) return null;
  return [...entry.memories.values()];
}

export function setCachedArchivedMemories(baseDir: string, memories: MemoryFile[], version: number): void {
  const map = new Map<string, MemoryFile>();
  for (const m of memories) map.set(m.path, m);
  archiveCacheByDir.set(baseDir, { memories: map, version, loadedAt: Date.now() });
}

// Entity cache — same pattern as memory cache, but keyed by schema-aware parse inputs.
const entityCacheByDir = new Map<string, { entities: EntityFile[]; version: number; loadedAt: number }>();

/**
 * Single normalization point for the entity-cache schema key (issue #1535).
 * BOTH the set/get key builder and the prefix invalidation derive from here so
 * `undefined` vs `""` (or any future normalization rule) can never diverge
 * between the write path and the invalidate path (rule 38 cousin).
 */
function normalizeEntitySchemaKey(schemaKey: string | undefined): string {
  return schemaKey ?? "";
}

/** Prefix shared by every entity-cache key for a dir, regardless of schemaKey. */
function entityCacheKeyPrefix(baseDir: string): string {
  return `${baseDir}\u0000`;
}

function buildEntityCacheKey(baseDir: string, schemaKey?: string): string {
  return `${entityCacheKeyPrefix(baseDir)}${normalizeEntitySchemaKey(schemaKey)}`;
}

export function getCachedEntities(
  baseDir: string,
  currentVersion: number,
  schemaKey: string = "",
): EntityFile[] | null {
  if (currentVersion === 0) return null;
  const entry = entityCacheByDir.get(buildEntityCacheKey(baseDir, schemaKey));
  if (!entry || entry.version !== currentVersion) return null;
  return entry.entities;
}

export function setCachedEntities(
  baseDir: string,
  entities: EntityFile[],
  version: number,
  schemaKey: string = "",
): void {
  entityCacheByDir.set(buildEntityCacheKey(baseDir, schemaKey), {
    entities,
    version,
    loadedAt: Date.now(),
  });
}

export function invalidateCachedEntities(baseDir: string): void {
  const prefix = entityCacheKeyPrefix(baseDir);
  for (const key of entityCacheByDir.keys()) {
    if (key.startsWith(prefix)) entityCacheByDir.delete(key);
  }
}

// Derived caches — pre-filtered views invalidated alongside the main cache.
// These avoid O(146K) filter+map on every verified recall/rules call.
interface DerivedCacheEntry<T> {
  data: T;
  sourceVersion: number; // matches the hot cache version it was derived from
}

const episodeMapByDir = new Map<string, DerivedCacheEntry<Map<string, MemoryFile>>>();
const ruleMemoriesByDir = new Map<string, DerivedCacheEntry<{ all: MemoryFile[]; byId: Map<string, MemoryFile> }>>();

/** Get a pre-filtered Map of episode memories (keyed by ID). Derived from hot cache. */
export function getCachedEpisodeMap(baseDir: string, currentVersion: number): Map<string, MemoryFile> | null {
  if (currentVersion === 0) return null;
  const entry = episodeMapByDir.get(baseDir);
  if (!entry || entry.sourceVersion !== currentVersion) return null;
  return entry.data;
}

/** Build and cache the episode memory map from the full memory list. */
export function setCachedEpisodeMap(baseDir: string, memories: MemoryFile[], version: number): Map<string, MemoryFile> {
  const map = new Map<string, MemoryFile>();
  for (const m of memories) {
    if (m.frontmatter.status === "archived" || m.frontmatter.status === "forgotten") continue;
    if (m.frontmatter.memoryKind !== "episode") continue;
    map.set(m.frontmatter.id, m);
  }
  episodeMapByDir.set(baseDir, { data: map, sourceVersion: version });
  return map;
}

/** Get pre-filtered rule memories. Derived from hot cache. */
export function getCachedRuleMemories(baseDir: string, currentVersion: number): { all: MemoryFile[]; byId: Map<string, MemoryFile> } | null {
  if (currentVersion === 0) return null;
  const entry = ruleMemoriesByDir.get(baseDir);
  if (!entry || entry.sourceVersion !== currentVersion) return null;
  return entry.data;
}

/** Build and cache the rule memories from the full memory list. */
export function setCachedRuleMemories(baseDir: string, memories: MemoryFile[], version: number): { all: MemoryFile[]; byId: Map<string, MemoryFile> } {
  const byId = new Map<string, MemoryFile>();
  const all: MemoryFile[] = [];
  for (const m of memories) {
    byId.set(m.frontmatter.id, m);
    if (
      m.frontmatter.category === "rule" &&
      m.frontmatter.status !== "archived" &&
      m.frontmatter.status !== "forgotten"
    ) {
      all.push(m);
    }
  }
  const result = { all, byId };
  ruleMemoriesByDir.set(baseDir, { data: result, sourceVersion: version });
  return result;
}

// QMD search result cache — short-lived (60s TTL) to avoid stale results
// while reducing redundant daemon calls for repeated/similar queries.
interface QmdCacheEntry {
  results: unknown[];
  cachedAt: number;
}
const QMD_CACHE_TTL_MS = 60_000;
const qmdSearchCache = new Map<string, QmdCacheEntry>();

export function getCachedQmdSearch(cacheKey: string): unknown[] | null {
  const entry = qmdSearchCache.get(cacheKey);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > QMD_CACHE_TTL_MS) {
    qmdSearchCache.delete(cacheKey);
    return null;
  }
  return entry.results;
}

export function setCachedQmdSearch(cacheKey: string, results: unknown[]): void {
  qmdSearchCache.set(cacheKey, { results, cachedAt: Date.now() });
  // Evict old entries to prevent unbounded growth
  if (qmdSearchCache.size > 200) {
    const now = Date.now();
    for (const [key, entry] of qmdSearchCache) {
      if (now - entry.cachedAt > QMD_CACHE_TTL_MS) qmdSearchCache.delete(key);
    }
  }
}

/**
 * Cache-layer registry (issue #1535).
 *
 * EVERY process-level cache that can serve memory-derived content is
 * enumerated here, and the single invalidation chokepoint
 * (`invalidateAllForDir`) iterates this list. Adding a new cache layer to
 * this module (or qmd-recall-cache.ts) REQUIRES registering it here —
 * otherwise mutations will never invalidate it (the exact bug this registry
 * exists to prevent) and the enumerate-all-layers fitness test in
 * tests/cache-invalidation-coherence.test.ts fails.
 */
export interface MemoryCacheLayer {
  /** Stable identifier used by tests and diagnostics. */
  readonly name: string;
  /** "dir" layers evict only entries for the given baseDir. "global" layers
   *  are fully cleared on any mutation: their keys embed queries, namespaces,
   *  and strategies rather than a storage dir, so a per-dir selective clear
   *  is not possible without recording the dir in each entry. Full clear is
   *  the simple-and-correct choice — these caches are re-warmable
   *  (issue #1535, implementation guide option (b)). */
  readonly scope: "dir" | "global";
  /** Evict entries for baseDir ("dir" scope) or everything ("global" scope). */
  readonly invalidateForDir: (baseDir: string) => void;
  /** Evict every entry across all dirs. */
  readonly clearAll: () => void;
  /** True when the layer still holds entries for baseDir ("dir" scope) or
   *  any entries at all ("global" scope). */
  readonly hasEntriesFor: (baseDir: string) => boolean;
}

export const ALL_CACHE_LAYERS: readonly MemoryCacheLayer[] = [
  {
    name: "hot-memories",
    scope: "dir",
    invalidateForDir: (baseDir) => void hotCacheByDir.delete(baseDir),
    clearAll: () => hotCacheByDir.clear(),
    hasEntriesFor: (baseDir) => hotCacheByDir.has(baseDir),
  },
  {
    name: "archive-memories",
    scope: "dir",
    invalidateForDir: (baseDir) => void archiveCacheByDir.delete(baseDir),
    clearAll: () => archiveCacheByDir.clear(),
    hasEntriesFor: (baseDir) => archiveCacheByDir.has(baseDir),
  },
  {
    name: "entities",
    scope: "dir",
    invalidateForDir: (baseDir) => invalidateCachedEntities(baseDir),
    clearAll: () => entityCacheByDir.clear(),
    hasEntriesFor: (baseDir) => {
      const prefix = entityCacheKeyPrefix(baseDir);
      for (const key of entityCacheByDir.keys()) {
        if (key.startsWith(prefix)) return true;
      }
      return false;
    },
  },
  {
    name: "derived-episode-map",
    scope: "dir",
    invalidateForDir: (baseDir) => void episodeMapByDir.delete(baseDir),
    clearAll: () => episodeMapByDir.clear(),
    hasEntriesFor: (baseDir) => episodeMapByDir.has(baseDir),
  },
  {
    name: "derived-rule-memories",
    scope: "dir",
    invalidateForDir: (baseDir) => void ruleMemoriesByDir.delete(baseDir),
    clearAll: () => ruleMemoriesByDir.clear(),
    hasEntriesFor: (baseDir) => ruleMemoriesByDir.has(baseDir),
  },
  {
    name: "qmd-search",
    scope: "global",
    invalidateForDir: () => qmdSearchCache.clear(),
    clearAll: () => qmdSearchCache.clear(),
    hasEntriesFor: () => qmdSearchCache.size > 0,
  },
  {
    name: "qmd-recall",
    scope: "global",
    invalidateForDir: () => clearQmdRecallCache(),
    clearAll: () => clearQmdRecallCache(),
    hasEntriesFor: () => qmdRecallCacheSize() > 0,
  },
];

/**
 * The single invalidation chokepoint (issue #1535, rule 37).
 *
 * Every memory/entity mutation path must route through this function —
 * storage.ts calls it from its internal invalidation funnels
 * (invalidateAllMemoriesCache / invalidateColdMemoriesCache /
 * bumpMemoryStatusVersion / setSecureStoreKey). Nothing may clear an
 * individual layer ad hoc: partial clears are how the stale-recall bug
 * happened (qmdRecallCache was never invalidated on mutations, so recall
 * served pre-edit bundles for the remainder of its fresh/stale TTL window).
 */
export function invalidateAllForDir(baseDir: string): void {
  for (const layer of ALL_CACHE_LAYERS) {
    layer.invalidateForDir(baseDir);
  }
}

export function clearMemoryCache(baseDir?: string): void {
  if (baseDir) {
    invalidateAllForDir(baseDir);
    return;
  }
  for (const layer of ALL_CACHE_LAYERS) {
    layer.clearAll();
  }
}

export function getMemoryCacheStats(baseDir: string): {
  hotSize: number;
  archiveSize: number;
  hotVersion: number | null;
  archiveVersion: number | null;
} {
  const hot = hotCacheByDir.get(baseDir);
  const archive = archiveCacheByDir.get(baseDir);
  return {
    hotSize: hot?.memories.size ?? 0,
    archiveSize: archive?.memories.size ?? 0,
    hotVersion: hot?.version ?? null,
    archiveVersion: archive?.version ?? null,
  };
}
