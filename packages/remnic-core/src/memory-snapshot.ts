import type { MemoryFile } from "./types.js";

function sortSnapshotObject(_key: string, candidate: unknown): unknown {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return candidate;
  return Object.keys(candidate)
    .sort()
    .reduce<Record<string, unknown>>((sorted, key) => {
      sorted[key] = (candidate as Record<string, unknown>)[key];
      return sorted;
    }, {});
}

export function createMemorySnapshot(memory: MemoryFile): string {
  return JSON.stringify([memory.frontmatter, memory.content], sortSnapshotObject);
}
