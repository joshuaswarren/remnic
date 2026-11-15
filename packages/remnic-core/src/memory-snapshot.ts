import type { MemoryFile, MemoryFrontmatter } from "./types.js";

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

/**
 * created/updated for a snapshot rebuilt from a file's text. parseFrontmatter stamps a missing key with "now", so take
 * the loaded memory's own stamp instead, as the old eager snapshot did: a file with no timestamps then never matches a
 * later read of itself (refused every time, not by clock tick). Key presence follows the parser, which trims the key.
 */
export function loadTimeStamps(raw: string, parsed: MemoryFrontmatter, loaded: MemoryFrontmatter): Pick<MemoryFrontmatter, "created" | "updated"> {
  const front = raw.slice(0, raw.indexOf("\n---", 3)); // the block parseFrontmatter reads, without a lazy regex
  return {
    created: /^[ \t]*created[ \t]*:/m.test(front) ? parsed.created : loaded.created,
    updated: /^[ \t]*updated[ \t]*:/m.test(front) ? parsed.updated : loaded.updated,
  };
}
