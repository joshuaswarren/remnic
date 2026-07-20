import type { MemoryFile, QmdSearchResult } from "./types.js";

export function memoryMapKey(result: Pick<QmdSearchResult, "namespace" | "path">): string {
  // No namespace -> bare path (backward-compatible with path-keyed lookups).
  // Namespaced -> composite so the same relative path across namespaces stays distinct.
  return result.namespace ? `${result.namespace}\0${result.path}` : result.path;
}

export function memoryForResult(
  memoryByPath: ReadonlyMap<string, MemoryFile>,
  result: Pick<QmdSearchResult, "namespace" | "path">,
): MemoryFile | undefined {
  return memoryByPath.get(memoryMapKey(result));
}

export function hasMemoryForResult(
  memoryByPath: ReadonlyMap<string, MemoryFile>,
  result: Pick<QmdSearchResult, "namespace" | "path">,
): boolean {
  return memoryByPath.has(memoryMapKey(result));
}

export function markResultKey(
  keys: Set<string>,
  result: Pick<QmdSearchResult, "namespace" | "path">,
): void {
  keys.add(memoryMapKey(result));
}

export function resultHasKey(
  keys: ReadonlySet<string>,
  result: Pick<QmdSearchResult, "namespace" | "path">,
): boolean {
  return keys.has(memoryMapKey(result));
}

/**
 * Merge recall results from multiple producers, deduplicating by the composite
 * (namespace, path) identity so the same memory found by a fanout hit and a
 * seed/hybrid/archive hit collapses to ONE entry instead of being injected and
 * access-tracked twice (#2020). The namespace is resolved the SAME way on every
 * producer — carried when present, else derived from the path — and stamped on
 * the surviving result. Highest score wins; a surviving result keeps its own
 * snippet, falling back to the displaced entry's snippet when empty. Results are
 * returned sorted by descending score and capped to `limit`.
 */
export function dedupeResultsByNamespace(
  results: readonly QmdSearchResult[],
  namespaceFromPath: (path: string) => string,
  limit: number,
  options?: {
    transportFallback?: QmdSearchResult["transport"];
    filter?: (result: QmdSearchResult) => boolean;
  },
): QmdSearchResult[] {
  const merged = new Map<string, QmdSearchResult>();
  for (const result of results) {
    const namespace = result.namespace ?? namespaceFromPath(result.path);
    const key = `${namespace}\0${result.path || result.docid}`;
    const existing = merged.get(key);
    if (existing && result.score <= existing.score) continue;
    merged.set(key, {
      ...result,
      namespace,
      ...(options?.transportFallback !== undefined
        ? { transport: result.transport ?? options.transportFallback }
        : {}),
      snippet: result.snippet || existing?.snippet || "",
    });
  }
  let out = [...merged.values()];
  if (options?.filter) out = out.filter(options.filter);
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
