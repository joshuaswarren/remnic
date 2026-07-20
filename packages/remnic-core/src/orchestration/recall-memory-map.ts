import type { MemoryFile, QmdSearchResult } from "../types.js";

export function memoryMapKey(result: Pick<QmdSearchResult, "namespace" | "path">): string {
  return `${result.namespace ?? ""}\0${result.path}`;
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
