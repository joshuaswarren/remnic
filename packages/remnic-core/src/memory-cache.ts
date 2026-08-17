import type { EntityFile, MemoryFile } from "./types.js";
import { clearQmdRecallCache, qmdRecallCacheSize } from "./qmd-recall-cache.js";

interface CacheEntry {
  memories: Map<string, MemoryFile>; // keyed by file path
  version: number;
  loadedAt: number;
  // Secure-store key identity that decrypted these memories (issue #1902, Codex
  // P1). "" for plaintext/locked stores. A manager only reads an entry whose
  // keyId matches its own, so a locked/unkeyed instance never sees content
  // another instance decrypted under a key for the same baseDir.
  keyId: string;
  // Effective TTL (ms) this entry was stored under (issue #1902, Codex Medium),
  // so the opportunistic sweep can evict abandoned corpora that are never
  // revisited. 0 = no TTL (never swept by age).
  ttlMs: number;
}

// Module-level singleton — shared across all StorageManager instances and sessions
const hotCacheByDir = new Map<string, CacheEntry>();
const archiveCacheByDir = new Map<string, CacheEntry>();

/**
 * Evict every hot entry whose own TTL has elapsed (issue #1902, Codex Medium).
 * Called opportunistically on each set so a long-running process that reads many
 * namespace/temporary roots and never revisits some of them still releases their
 * (potentially hundreds-of-MB) corpora within the TTL, instead of holding them
 * resident until an explicit global clear. O(entries) over a small map.
 */
function sweepExpiredHotEntries(now: number): void {
  for (const [dir, entry] of hotCacheByDir) {
    if (entry.ttlMs > 0 && now - entry.loadedAt > entry.ttlMs) hotCacheByDir.delete(dir);
  }
}

/**
 * Shared read gate for every versioned cache layer (issue #2481): serve an
 * entry only when its version and secure-store keyId match the caller.
 * `currentVersion === 0` means version tracking is unavailable (tests, fresh
 * installs) and always misses so disk is read. The TTL is a safety net for
 * external filesystem edits that bypass the version sentinel (issue #1902):
 * ttlMs <= 0 disables it, and on expiry the entry is evicted — not just
 * skipped — so a stale dir releases its resident corpus instead of lingering
 * until an explicit clear.
 */
function getVersionedCacheEntry<K, E extends { version: number; keyId: string; loadedAt: number }>(
  cache: Map<K, E>,
  key: K,
  currentVersion: number,
  keyId: string,
  ttlMs: number,
): E | null {
  if (currentVersion === 0) return null;
  const entry = cache.get(key);
  if (!entry || entry.version !== currentVersion || entry.keyId !== keyId) return null;
  if (ttlMs > 0 && Date.now() - entry.loadedAt > ttlMs) {
    cache.delete(key);
    return null;
  }
  return entry;
}

export function getCachedMemories(
  baseDir: string,
  currentVersion: number,
  keyId = "",
  ttlMs = 0,
): MemoryFile[] | null {
  const entry = getVersionedCacheEntry(hotCacheByDir, baseDir, currentVersion, keyId, ttlMs);
  return entry ? [...entry.memories.values()] : null;
}

export function setCachedMemories(
  baseDir: string,
  memories: MemoryFile[],
  version: number,
  keyId = "",
  ttlMs = 0,
): void {
  const map = new Map<string, MemoryFile>();
  for (const m of memories) map.set(m.path, m);
  const now = Date.now();
  hotCacheByDir.set(baseDir, { memories: map, version, loadedAt: now, keyId, ttlMs });
  // Release abandoned corpora that expired but were never revisited (Codex Medium).
  sweepExpiredHotEntries(now);
}

export function updateCacheOnWrite(baseDir: string, memory: MemoryFile, keyId = ""): void {
  const entry = hotCacheByDir.get(baseDir);
  // Only mutate an entry that belongs to THIS key identity (issue #1902, Codex
  // Medium). A concurrent differently-keyed manager may have replaced the
  // single hotCacheByDir slot during an awaited parse; inserting our decrypted
  // MemoryFile into its entry would leak plaintext across the key boundary.
  if (entry && entry.keyId === keyId) entry.memories.set(memory.path, memory);
}

export function updateCacheOnDelete(baseDir: string, filePath: string, keyId = ""): void {
  const entry = hotCacheByDir.get(baseDir);
  if (entry && entry.keyId === keyId) entry.memories.delete(filePath);
}
// Archive cache — same pattern, separate store
export function getCachedArchivedMemories(
  baseDir: string,
  currentVersion: number,
  keyId = "",
): MemoryFile[] | null {
  // ttlMs 0: the archive cache has no age TTL; it is version-keyed and cleared
  // via invalidation.
  const entry = getVersionedCacheEntry(archiveCacheByDir, baseDir, currentVersion, keyId, 0);
  return entry ? [...entry.memories.values()] : null;
}

export function setCachedArchivedMemories(
  baseDir: string,
  memories: MemoryFile[],
  version: number,
  keyId = "",
): void {
  const map = new Map<string, MemoryFile>();
  for (const m of memories) map.set(m.path, m);
  // ttlMs: 0 — the archive cache has no age TTL; it is version-keyed and cleared
  // via invalidation. The field satisfies the shared CacheEntry shape (#1902).
  archiveCacheByDir.set(baseDir, { memories: map, version, loadedAt: Date.now(), keyId, ttlMs: 0 });
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
  version: number; // matches the hot cache version it was derived from
  keyId: string; // secure-store key identity of the corpus it was derived from (#1902)
  loadedAt: number; // build time — bounds staleness from external edits via ttlMs (#1902)
}

const episodeMapByDir = new Map<string, DerivedCacheEntry<Map<string, MemoryFile>>>();
const ruleMemoriesByDir = new Map<string, DerivedCacheEntry<{ all: MemoryFile[]; byId: Map<string, MemoryFile> }>>();

export function getCachedEpisodeMap(
  baseDir: string,
  currentVersion: number,
  keyId = "",
  ttlMs = 0,
): Map<string, MemoryFile> | null {
  const entry = getVersionedCacheEntry(episodeMapByDir, baseDir, currentVersion, keyId, ttlMs);
  return entry ? entry.data : null;
}

/** Build and cache the episode memory map from the full memory list. */
export function setCachedEpisodeMap(
  baseDir: string,
  memories: MemoryFile[],
  version: number,
  cache = true,
  keyId = "",
): Map<string, MemoryFile> {
  const map = new Map<string, MemoryFile>();
  for (const m of memories) {
    if (m.frontmatter.status === "archived" || m.frontmatter.status === "forgotten") continue;
    if (m.frontmatter.memoryKind !== "episode") continue;
    map.set(m.frontmatter.id, m);
  }
  if (cache) episodeMapByDir.set(baseDir, { data: map, version, keyId, loadedAt: Date.now() });
  return map;
}

/** Get pre-filtered rule memories. Derived from hot cache. */
export function getCachedRuleMemories(
  baseDir: string,
  currentVersion: number,
  keyId = "",
  ttlMs = 0,
): { all: MemoryFile[]; byId: Map<string, MemoryFile> } | null {
  const entry = getVersionedCacheEntry(ruleMemoriesByDir, baseDir, currentVersion, keyId, ttlMs);
  return entry ? entry.data : null;
}

/** Build and cache the rule memories from the full memory list. */
export function setCachedRuleMemories(
  baseDir: string,
  memories: MemoryFile[],
  version: number,
  cache = true,
  keyId = "",
): { all: MemoryFile[]; byId: Map<string, MemoryFile> } {
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
  if (cache) ruleMemoriesByDir.set(baseDir, { data: result, version, keyId, loadedAt: Date.now() });
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
 * Mutation scopes (issue #1904). A cache layer declares (via `evictOn`) which
 * of these mutation kinds evict it, so the invalidation chokepoint can clear
 * only the layers a given write actually affects instead of nuking every
 * layer on every write (the permanently-cold-cache regression #1904 fixes).
 */
export type MemoryMutationScope =
  | "memory-create" // a new memory doc added; no existing doc's recall-visibility changes
  | "memory-mutate" // existing doc changed/moved/removed/status-changed (update, supersede,
  //   archive, invalidate, frontmatter, cold-tier change, bulk delete)
  | "entity-write" // an entity file changed
  | "secure-key-change"; // encryption key rotated; everything is now unreadable → evict all

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
  /** Which mutation scopes evict this layer (issue #1904). A `memory-create`
   *  only refreshes the full-memory-list views (hot + derived episode/rule); a
   *  `memory-mutate`/`entity-write`/`secure-key-change` evicts every layer whose
   *  content it can affect. Adding a layer REQUIRES declaring this. */
  readonly evictOn: Partial<Record<MemoryMutationScope, true>>;
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
    evictOn: { "memory-create": true, "memory-mutate": true, "secure-key-change": true },
    invalidateForDir: (baseDir) => void hotCacheByDir.delete(baseDir),
    clearAll: () => hotCacheByDir.clear(),
    hasEntriesFor: (baseDir) => hotCacheByDir.has(baseDir),
  },
  {
    name: "archive-memories",
    scope: "dir",
    evictOn: { "memory-mutate": true, "secure-key-change": true },
    invalidateForDir: (baseDir) => void archiveCacheByDir.delete(baseDir),
    clearAll: () => archiveCacheByDir.clear(),
    hasEntriesFor: (baseDir) => archiveCacheByDir.has(baseDir),
  },
  {
    name: "entities",
    scope: "dir",
    evictOn: { "entity-write": true, "secure-key-change": true },
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
    evictOn: { "memory-create": true, "memory-mutate": true, "secure-key-change": true },
    invalidateForDir: (baseDir) => void episodeMapByDir.delete(baseDir),
    clearAll: () => episodeMapByDir.clear(),
    hasEntriesFor: (baseDir) => episodeMapByDir.has(baseDir),
  },
  {
    name: "derived-rule-memories",
    scope: "dir",
    evictOn: { "memory-create": true, "memory-mutate": true, "secure-key-change": true },
    invalidateForDir: (baseDir) => void ruleMemoriesByDir.delete(baseDir),
    clearAll: () => ruleMemoriesByDir.clear(),
    hasEntriesFor: (baseDir) => ruleMemoriesByDir.has(baseDir),
  },
  {
    name: "qmd-search",
    scope: "global",
    evictOn: { "memory-mutate": true, "entity-write": true, "secure-key-change": true },
    invalidateForDir: () => qmdSearchCache.clear(),
    clearAll: () => qmdSearchCache.clear(),
    hasEntriesFor: () => qmdSearchCache.size > 0,
  },
  {
    name: "qmd-recall",
    scope: "global",
    evictOn: { "memory-mutate": true, "entity-write": true, "secure-key-change": true },
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

/**
 * Scope-aware invalidation chokepoint (issue #1904). Evicts only the layers
 * whose `evictOn` includes `scope`, so the highest-frequency write
 * (`memory-create`, fired continuously by extraction) stops nuking the QMD
 * result caches and the version-keyed entity cache it cannot affect. This is
 * the single scoped entry point — like `invalidateAllForDir`, it iterates the
 * `ALL_CACHE_LAYERS` registry rather than clearing any layer ad hoc, so the
 * single-chokepoint invariant (#1535) holds: a new layer only participates by
 * declaring `evictOn`.
 */
export function invalidateForScope(baseDir: string, scope: MemoryMutationScope): void {
  for (const layer of ALL_CACHE_LAYERS) {
    if (layer.evictOn[scope]) layer.invalidateForDir(baseDir);
  }
}

/**
 * Companion to {@link invalidateForScope} for the single-file write fast path
 * (issue #1902 + #1904): it patches the hot-memories entry in place and
 * re-keys it, so this evicts every OTHER layer the scope would clear but leaves
 * hot-memories alone. A `memory-create` thus evicts only the derived
 * episode/rule views (hot patched, QMD/entities/archive kept warm), which is
 * the whole point of #1904 — a create must not evict the QMD result caches.
 */
export function invalidateForScopeExceptHot(baseDir: string, scope: MemoryMutationScope): void {
  for (const layer of ALL_CACHE_LAYERS) {
    if (layer.name === "hot-memories") continue;
    if (layer.evictOn[scope]) layer.invalidateForDir(baseDir);
  }
}

/**
 * Invalidate every cache layer for `baseDir` EXCEPT the hot-memories layer
 * (issue #1902). Single-file write paths use this instead of
 * `invalidateAllForDir` because they patch the hot-memories entry in place
 * (via `updateCacheOnWrite`/`updateCacheOnDelete`) and re-key it to the bumped
 * version — so dropping it here would defeat the whole warm-cache fast path.
 * The derived episode/rule views and the global QMD caches are cheap to
 * rebuild and are not patched, so they are still evicted here. Every other
 * layer remains reachable for the wholesale `invalidateAllForDir` /
 * `clearMemoryCache` chokepoint used by bulk/ambiguous mutations.
 */
export function invalidateDerivedAndGlobalForDir(baseDir: string): void {
  // Preserve the layers a single-file write intentionally keeps warm (issue
  // #1902, Codex Medium): hot-memories is patched + re-keyed in place; the
  // entities layer is keyed on memory-status, which plain create/content writes
  // deliberately do NOT bump (so entity retrieval stays warm); and the
  // archive-memories layer is version-keyed on the archive tier, untouched by a
  // hot-tier write. Evict ONLY the derived (episode/rule) and global (QMD) views.
  for (const layer of ALL_CACHE_LAYERS) {
    if (
      layer.name === "hot-memories" ||
      layer.name === "entities" ||
      layer.name === "archive-memories"
    ) {
      continue;
    }
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

/**
 * Clear ONLY the two global QMD result caches (qmd-search + qmd-recall), leaving
 * every dir-scoped layer (hot/archive/entities/derived) untouched. Called after
 * a successful QMD maintenance update+embed (#1904, Codex): a newly-persisted
 * fact becomes searchable at that moment, so any cached pre-index recall/search
 * bundle is now stale and must not be served. This lets the create path keep the
 * QMD caches warm during index lag (perf win) while guaranteeing invalidation
 * the moment the fact is actually indexed — no extended stale window.
 */
export function clearQmdResultCaches(): void {
  qmdSearchCache.clear();
  clearQmdRecallCache();
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
