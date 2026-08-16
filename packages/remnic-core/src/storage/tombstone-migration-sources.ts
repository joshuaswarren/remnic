import { statSync } from "node:fs";
import path from "node:path";
import type { TombstoneStoreOptions } from "../lifecycle/tombstones.js";
import type { MemoryFile } from "../types.js";

/**
 * Deps injected by `StorageManager.buildTombstoneStore` so this module owns no
 * storage-god-file imports (issue #1533 ratchet).
 */
export interface TombstoneMigrationSourceDeps {
  /** On-disk tombstone ledger path; its mtime scopes both caches below. */
  tombstonesPath: () => string;
  collectTombstoneMigrationPaths: () => Promise<string[]>;
  readParsedMemoriesFromPaths: (filePaths: string[], batchSize?: number) => Promise<MemoryFile[]>;
  storedContentIdentityCandidates: (content: string) => string[];
}

/**
 * Build the `sourceContentsForMemoryIds` callback `TombstoneStore` uses to
 * verify pre-Unicode rows against their retired source memories. The corpus
 * path snapshot and the resolved source-content map are memoized for one
 * ledger revision only (issue #2367): a peer process can create and retire a
 * legacy-format memory after this snapshot, and the staleness reload must
 * resolve the new row against a FRESH path list — otherwise the row stays
 * unverified (withheld from the lookup tiers) until restart.
 */
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
      // In-flight fills are bound to the ledger revision they started
      // against: if the ledger advances while a fill awaits, restart
      // against the fresh revision instead of publishing a cache built
      // from a stale path snapshot (issue #2367 review round 2).
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
