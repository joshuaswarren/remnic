import type { EntityFile, MemoryFile } from "./types.js";

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

function buildEntityCacheKey(baseDir: string, schemaKey: string = ""): string {
  return `${baseDir}\u0000${schemaKey}`;
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
  const prefix = `${baseDir}\u0000`;
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

export function clearMemoryCache(baseDir?: string): void {
  if (baseDir) {
    hotCacheByDir.delete(baseDir);
    archiveCacheByDir.delete(baseDir);
    invalidateCachedEntities(baseDir);
    episodeMapByDir.delete(baseDir);
    ruleMemoriesByDir.delete(baseDir);
    qmdSearchCache.clear();
  } else {
    hotCacheByDir.clear();
    archiveCacheByDir.clear();
    entityCacheByDir.clear();
    episodeMapByDir.clear();
    ruleMemoriesByDir.clear();
    qmdSearchCache.clear();
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
