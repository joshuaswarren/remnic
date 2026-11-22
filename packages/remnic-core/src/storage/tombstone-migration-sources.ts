import { statSync } from "node:fs";
import path from "node:path";
import type { TombstoneStoreOptions } from "../lifecycle/tombstones.js";
import type { MemoryFile } from "../types.js";

export interface TombstoneMigrationSourceDeps {
  /** On-disk tombstone ledger path; its mtime scopes both caches below. */
  tombstonesPath: () => string;
  collectTombstoneMigrationPaths: () => Promise<string[]>;
  readParsedMemoriesFromPaths: (filePaths: string[], batchSize?: number) => Promise<MemoryFile[]>;
  storedContentIdentityCandidates: (content: string) => string[];
}

export function createTombstoneMigrationSourceContents(
  deps: TombstoneMigrationSourceDeps,
): NonNullable<TombstoneStoreOptions["sourceContentsForMemoryIds"]> {
  let sourcePathsPromise: Promise<string[]> | undefined;
  let sourceContentsByIdPromise: Promise<Map<string, readonly string[]>> | undefined;
  let ledgerMtimeMs: number | null = null;
  const dropCachesIfLedgerChanged = (): void => {
    let mtimeMs: number | null;
    try {
      mtimeMs = Math.floor(statSync(deps.tombstonesPath()).mtimeMs);
    } catch {
      return; // ENOENT / stat failure — keep whatever is cached.
    }
    if (mtimeMs === ledgerMtimeMs) return;
    ledgerMtimeMs = mtimeMs;
    sourcePathsPromise = undefined;
    sourceContentsByIdPromise = undefined;
  };
  return async (sourceMemoryIds) => {
    for (;;) {
      dropCachesIfLedgerChanged();
      const revision = ledgerMtimeMs;
      const requested = new Set(sourceMemoryIds);
      const sourcePaths = await (sourcePathsPromise ??= deps.collectTombstoneMigrationPaths());
      if (ledgerMtimeMs !== revision) continue;
      const directPaths = sourcePaths.filter((filePath) =>
        requested.has(path.basename(filePath, ".md"))
      );
      const contents = new Map<string, readonly string[]>();
      for (const memory of await deps.readParsedMemoriesFromPaths(directPaths, 50)) {
        const id = memory.frontmatter.id;
        if (requested.has(id) && !contents.has(id)) {
          contents.set(id, deps.storedContentIdentityCandidates(memory.content));
        }
      }
      if (ledgerMtimeMs !== revision) continue;
      if (contents.size === requested.size) return contents;
      const fill = (sourceContentsByIdPromise ??= (async () => {
        const allContents = new Map<string, readonly string[]>();
        for (const memory of await deps.readParsedMemoriesFromPaths(sourcePaths, 50)) {
          const id = memory.frontmatter.id;
          if (!allContents.has(id)) {
            allContents.set(id, deps.storedContentIdentityCandidates(memory.content));
          }
        }
        return allContents;
      })());
      const allContents = await fill;
      if (ledgerMtimeMs !== revision) continue;
      for (const id of requested) {
        const content = allContents.get(id);
        if (content !== undefined) contents.set(id, content);
      }
      return contents;
    }
  };
}
