import type { RecallPlanMode } from "./types.js";
import type { SearchQueryOptions } from "./search/port.js";

type QmdRecallCacheEntry = {
  value: unknown;
  cachedAtMs: number;
};

export type QmdRecallCacheSource = "fresh" | "stale";

export interface QmdRecallCacheHit<T> {
  value: T;
  source: QmdRecallCacheSource;
  ageMs: number;
}

export interface QmdRecallCacheKeyOptions {
  query: string;
  namespaces: string[];
  recallMode: RecallPlanMode;
  maxResults: number;
  memoryDir?: string;
  collection?: string;
  searchOptions?: SearchQueryOptions;
  // QMD search/subprocess strategies change the recalled results, so they must
  // participate in the cache key — otherwise a different strategy's cached QMD
  // phase is served within the TTL (gotcha #37). Issue #1335 (codex review #1422).
  searchStrategy?: string;
  subprocessStrategy?: string;
}

const qmdRecallCache = new Map<string, QmdRecallCacheEntry>();

function cloneCacheValue<T>(value: T): T {
  return structuredClone(value);
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizePathScope(pathValue: string | undefined): string {
  if (typeof pathValue !== "string") return "";
  return pathValue.trim().replace(/\\/g, "/");
}

function normalizeSearchOptions(
  options: SearchQueryOptions | undefined,
): Record<string, unknown> {
  if (!options) return {};
  return Object.fromEntries(
    Object.entries(options)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function buildQmdRecallCacheKey(
  options: QmdRecallCacheKeyOptions,
): string {
  return JSON.stringify({
    query: normalizeQuery(options.query),
    namespaces: [...options.namespaces].sort(),
    recallMode: options.recallMode,
    maxResults: options.maxResults,
    memoryDir: normalizePathScope(options.memoryDir),
    collection: options.collection ?? "",
    searchOptions: normalizeSearchOptions(options.searchOptions),
    searchStrategy: options.searchStrategy ?? "",
    subprocessStrategy: options.subprocessStrategy ?? "",
  });
}

export function getCachedQmdRecall<T>(
  cacheKey: string,
  options: {
    freshTtlMs: number;
    staleTtlMs: number;
  },
): QmdRecallCacheHit<T> | null {
  const entry = qmdRecallCache.get(cacheKey);
  if (!entry) return null;

  const ageMs = Date.now() - entry.cachedAtMs;
  if (ageMs <= options.freshTtlMs) {
    return { value: cloneCacheValue(entry.value as T), source: "fresh", ageMs };
  }
  if (ageMs <= options.staleTtlMs) {
    return { value: cloneCacheValue(entry.value as T), source: "stale", ageMs };
  }

  qmdRecallCache.delete(cacheKey);
  return null;
}

export function setCachedQmdRecall<T>(
  cacheKey: string,
  value: T,
  options: { maxEntries: number },
): void {
  qmdRecallCache.delete(cacheKey);
  if (options.maxEntries <= 0) return;

  qmdRecallCache.set(cacheKey, {
    value: cloneCacheValue(value),
    cachedAtMs: Date.now(),
  });

  while (qmdRecallCache.size > options.maxEntries) {
    const oldestKey = qmdRecallCache.keys().next().value;
    if (typeof oldestKey !== "string") break;
    qmdRecallCache.delete(oldestKey);
  }
}

export function clearQmdRecallCache(): void {
  qmdRecallCache.clear();
}
