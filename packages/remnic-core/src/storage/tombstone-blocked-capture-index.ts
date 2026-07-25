import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { MemoryFile, MemoryFrontmatter } from "../types.js";
import {
  ContentHashIndex,
  CONTENT_HASH_INDEX_RETRY_MAX_DELAY_MS,
  type ContentHashIndexLockOptions,
} from "./content-hash-index.js";
import { normalizeContent } from "../content-hash.js";
import { isErrnoCode } from "../utils/errno.js";
import { log } from "../logger.js";

const REBUILD_MAX_ATTEMPTS = 3;
const REBUILD_RETRY_BASE_MS = 50;

/**
 * Normalize the content identity used by explicit-capture duplicate checks.
 * This deliberately matches the capture path's historical comparison rather
 * than the punctuation-stripping fact-hash index: the index is only an
 * optimization, while this key gates whether a durable row needs inspection.
 */
export function normalizeExplicitCaptureContent(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build the targeted identity for a tombstone-blocked explicit-capture row.
 * Each field is normalized and length-prefixed so the punctuation-stripping
 * content-hash index cannot collapse tuple boundaries or distinct providers.
 */
export function buildExplicitCaptureDedupKey(
  content: string,
  category: string,
  sourceConnector: string | undefined,
): string {
  const encode = (label: string, value: string): string => {
    const normalized = normalizeContent(value);
    return `${label} ${normalized.length} ${normalized}`;
  };
  return [
    encode("category", category),
    encode("connector", sourceConnector?.trim() ?? ""),
    encode("content", normalizeExplicitCaptureContent(content)),
  ].join(" ");
}

export type TombstoneBlockedCaptureIndexOptions = {
  readonly stateDir: string;
  readonly memoryDir: string;
  readonly secureStoreKeyProvider: () => Buffer | null;
  readonly secureStoreWriteKeyProvider: () => Buffer | null;
  readonly lockOptions: () => ContentHashIndexLockOptions;
  readonly readAllMemories: () => Promise<MemoryFile[]>;
  readonly readAllColdMemories: () => Promise<MemoryFile[]>;
};

/**
 * Durable targeted deduplication for tombstone-blocked explicit captures.
 *
 * The active fact-hash index intentionally excludes blocked rows. This small
 * companion index keeps the blocked identity visible without making every
 * authoritative active-index miss scan the full corpus.
 */
export class TombstoneBlockedCaptureIndex {
  private readonly options: TombstoneBlockedCaptureIndexOptions;
  private index: ContentHashIndex | null = null;
  private loadPromise: Promise<ContentHashIndex> | null = null;
  private refreshPromise: Promise<ContentHashIndex> | null = null;
  private authoritative = false;

  constructor(options: TombstoneBlockedCaptureIndexOptions) {
    this.options = options;
  }

  private createIndex(): ContentHashIndex {
    return new ContentHashIndex(
      path.join(this.options.stateDir, "tombstone-blocked-capture"),
      this.options.secureStoreKeyProvider,
      this.options.secureStoreWriteKeyProvider,
      this.options.memoryDir,
      this.options.lockOptions(),
    );
  }

  private indexPath(): string {
    return path.join(this.options.stateDir, "tombstone-blocked-capture", "fact-hashes.txt");
  }

  private rebuildMarkerPath(): string {
    return path.join(this.options.stateDir, "tombstone-blocked-capture", "rebuild-required");
  }

  private async getRebuildMarkers(): Promise<{ path: string; committed: boolean }[]> {
    try {
      const entries = await readdir(this.rebuildMarkerPath());
      return await Promise.all(
        entries.map(async (entry) => {
          const markerPath = path.join(this.rebuildMarkerPath(), entry);
          let committed = false;
          try {
            committed = (await readFile(markerPath, "utf8")).trim() === "committed";
          } catch (err) {
            if (!isErrnoCode(err, "ENOENT")) throw err;
          }
          return { path: markerPath, committed };
        }),
      );
    } catch (err) {
      if (isErrnoCode(err, "ENOENT")) return [];
      throw err;
    }
  }

  // A pending marker protects the pre-commit gap; only committed markers are safe for another writer to clear.
  private async markRebuildRequired(committed = false): Promise<string> {
    const markerDir = this.rebuildMarkerPath();
    await mkdir(markerDir, { recursive: true });
    const markerPath = path.join(markerDir, randomUUID());
    await writeFile(markerPath, `${committed ? "committed" : "pending"}\n`, "utf8");
    return markerPath;
  }

  private async markRebuildCommitted(markerPath: string): Promise<void> {
    await writeFile(markerPath, "committed\n", "utf8");
  }

  private async clearRebuildRequired(markerPaths: readonly string[]): Promise<void> {
    await Promise.all(
      markerPaths.map(async (markerPath) => {
        try {
          await unlink(markerPath);
        } catch (err) {
          if (!isErrnoCode(err, "ENOENT")) throw err;
        }
      }),
    );
  }

  private async hasRebuildRequired(): Promise<boolean> {
    return (await this.getRebuildMarkers()).length > 0;
  }

  private isBlocked(memory: MemoryFile): boolean {
    return memory.frontmatter.status === "pending_review" && Boolean(memory.frontmatter.blockedBy);
  }

  private async rebuild(index: ContentHashIndex): Promise<boolean> {
    return await index.rebuildUnderLock(async () => {
      index.clear();
      const existing = [
        ...(await this.options.readAllMemories()),
        ...(await this.options.readAllColdMemories()),
      ];
      for (const memory of existing) {
        if (!this.isBlocked(memory)) continue;
        index.add(
          buildExplicitCaptureDedupKey(
            memory.content,
            memory.frontmatter.category,
            memory.frontmatter.sourceConnector,
          ),
        );
      }
    });
  }

  private async getIndex(): Promise<ContentHashIndex> {
    if (this.index) return this.index;
    if (!this.loadPromise) {
      const index = this.createIndex();
      this.loadPromise = (async () => {
        await index.load();
        const rebuildMarkers = await this.getRebuildMarkers();
        const committedRebuildMarkers = rebuildMarkers
          .filter((marker) => marker.committed)
          .map((marker) => marker.path);
        let persisted = true;
        try {
          await stat(this.indexPath());
          if (rebuildMarkers.length > 0) persisted = false;
        } catch (err) {
          if (isErrnoCode(err, "ENOENT")) persisted = false;
          else throw err;
        }
        if (!persisted) {
          const lockOptions = this.options.lockOptions();
          const maxAttempts = lockOptions.retryMaxAttempts ?? REBUILD_MAX_ATTEMPTS;
          const baseMs = lockOptions.retryBaseMs ?? REBUILD_RETRY_BASE_MS;
          let rebuilt = false;
          for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
            rebuilt = await this.rebuild(index);
            if (rebuilt || attempt === maxAttempts - 1) break;
            const wait = Math.min(baseMs * 2 ** attempt, CONTENT_HASH_INDEX_RETRY_MAX_DELAY_MS);
            await new Promise<void>((resolve) => setTimeout(resolve, wait));
          }
          if (!rebuilt) {
            throw new Error("tombstone-blocked capture index rebuild lock unavailable");
          }
          await this.clearRebuildRequired(committedRebuildMarkers);
        }
        this.authoritative = true;
        this.index = index;
        return index;
      })().catch((err) => {
        this.loadPromise = null;
        throw err;
      });
    }
    return this.loadPromise;
  }

  private async reload(): Promise<ContentHashIndex> {
    if (!this.refreshPromise) {
      this.refreshPromise = (async () => {
        this.index = null;
        this.loadPromise = null;
        return await this.getIndex();
      })().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  /** Return blocked-row membership and authority from one index snapshot. */
  async check(
    content: string,
    category: string,
    sourceConnector?: string,
  ): Promise<{ has: boolean; authoritative: boolean }> {
    const key = buildExplicitCaptureDedupKey(content, category, sourceConnector);
    let index = await this.getIndex();
    if (
      await this.hasRebuildRequired()
      || !(await index.isDiskFingerprintCurrent())
    ) {
      index = await this.reload();
    }
    return { has: index.has(key), authoritative: this.authoritative };
  }

  /** Return whether a blocked row matches this explicit-capture identity. */
  async has(content: string, category: string, sourceConnector?: string): Promise<boolean> {
    return (await this.check(content, category, sourceConnector)).has;
  }

  /** Return whether the in-memory index is safe to answer an authoritative miss. */
  async isAuthoritative(): Promise<boolean> {
    const index = await this.getIndex();
    if (
      await this.hasRebuildRequired()
      || !(await index.isDiskFingerprintCurrent())
    ) {
      await this.reload();
    }
    return this.authoritative;
  }

  /** Reserve durable rebuild intent before a blocked memory file is committed. */
  async prepareWrite(): Promise<string> {
    return this.markRebuildRequired();
  }

  /** Mark a prepared write committed once its memory file is durable. */
  async commitWrite(rebuildMarker: string): Promise<void> {
    await this.markRebuildCommitted(rebuildMarker);
  }

  /** Add a newly persisted blocked row to the durable targeted index. */
  async add(memory: MemoryFile, rebuildMarker?: string): Promise<void> {
    if (!this.isBlocked(memory)) return;
    let index = await this.getIndex();
    if (
      await this.hasRebuildRequired()
      || !(await index.isDiskFingerprintCurrent())
    ) {
      index = await this.reload();
    }
    index.add(
      buildExplicitCaptureDedupKey(
        memory.content,
        memory.frontmatter.category,
        memory.frontmatter.sourceConnector,
      ),
    );
    const marker = rebuildMarker ?? await this.markRebuildRequired(true);
    if (rebuildMarker) await this.markRebuildCommitted(rebuildMarker);
    await index.saveMergingWithDisk();
    await index.flushReconcileRetry();
    if (index.hasPendingChanges) {
      this.markUntrusted();
      return;
    }
    await this.clearRebuildRequired([marker]);
    this.authoritative = true;
  }

  /** Rebuild the loaded index after a blocked row changes or is removed. */
  async rebuildIfLoaded(): Promise<void> {
    if (!this.index) return;
    const rebuildMarkers = await this.getRebuildMarkers();
    const rebuildMarker = await this.markRebuildRequired(true);
    const rebuilt = await this.rebuild(this.index);
    if (rebuilt) {
      await this.clearRebuildRequired([
        ...rebuildMarkers.filter((marker) => marker.committed).map((marker) => marker.path),
        rebuildMarker,
      ]);
    }
    this.authoritative = rebuilt;
  }

  /** Rebuild when either side of a write is blocked and its identity changed. */
  async sync(before: MemoryFile, after: MemoryFile, rebuildMarker?: string): Promise<void> {
    const beforeBlocked = this.isBlocked(before);
    const afterBlocked = this.isBlocked(after);
    if (!beforeBlocked && !afterBlocked) return;
    const beforeKey = buildExplicitCaptureDedupKey(
      before.content,
      before.frontmatter.category,
      before.frontmatter.sourceConnector,
    );
    const afterKey = buildExplicitCaptureDedupKey(
      after.content,
      after.frontmatter.category,
      after.frontmatter.sourceConnector,
    );
    if (beforeBlocked && afterBlocked && beforeKey === afterKey) {
      if (rebuildMarker) {
        await this.markRebuildCommitted(rebuildMarker);
        await this.clearRebuildRequired([rebuildMarker]);
      }
      return;
    }
    const existingMarkers = await this.getRebuildMarkers();
    const marker = rebuildMarker ?? await this.markRebuildRequired(true);
    if (rebuildMarker) await this.markRebuildCommitted(rebuildMarker);
    const rebuilt = await this.rebuild(await this.getIndex());
    if (rebuilt) {
      await this.clearRebuildRequired([
        ...existingMarkers.filter((entry) => entry.committed).map((entry) => entry.path),
        marker,
      ]);
    }
    this.authoritative = rebuilt;
  }


  markUntrusted(): void {
    this.authoritative = false;
  }

  private async failOpen(operation: string, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (err) {
      this.markUntrusted();
      log.warn(`storage.${operation} completed but failed to update tombstone-blocked capture index: ${err}`);
    }
  }

  async addWrittenMemory(
    pathname: string,
    frontmatter: MemoryFrontmatter,
    content: string,
    rebuildMarker?: string,
  ): Promise<void> {
    await this.failOpen("writeMemory", () =>
      this.add({ path: pathname, frontmatter, content }, rebuildMarker),
    );
  }

  async rebuildAfterInvalidation(): Promise<void> {
    await this.failOpen("invalidateMemory", () => this.rebuildIfLoaded());
  }

  async syncUpdatedMemory(
    before: MemoryFile,
    frontmatter: MemoryFrontmatter,
    content: string,
    rebuildMarker?: string,
  ): Promise<void> {
    await this.failOpen("updateMemory", () =>
      this.sync(before, { ...before, frontmatter, content }, rebuildMarker),
    );
  }

  async syncUpdatedFrontmatter(
    before: MemoryFile,
    frontmatter: MemoryFrontmatter,
    rebuildMarker?: string,
  ): Promise<void> {
    await this.failOpen("writeMemoryFrontmatter", () =>
      this.sync(before, { ...before, frontmatter }, rebuildMarker),
    );
  }
}

export abstract class TombstoneBlockedCaptureIndexHost {
  private tombstoneBlockedCaptureIndex: TombstoneBlockedCaptureIndex | null = null;
  protected abstract tombstoneBlockedCaptureIndexOptions(): TombstoneBlockedCaptureIndexOptions;

  protected getTombstoneBlockedCaptureIndex(): TombstoneBlockedCaptureIndex {
    return this.tombstoneBlockedCaptureIndex ??= new TombstoneBlockedCaptureIndex(
      this.tombstoneBlockedCaptureIndexOptions(),
    );
  }

  async checkTombstoneBlockedExplicitCapture(
    ...args: [string, string, string?]
  ): Promise<{ has: boolean; authoritative: boolean }> {
    return this.getTombstoneBlockedCaptureIndex().check(...args);
  }

  async hasTombstoneBlockedExplicitCapture(...args: [string, string, string?]): Promise<boolean> {
    return this.getTombstoneBlockedCaptureIndex().has(...args);
  }

  async isTombstoneBlockedExplicitCaptureIndexAuthoritative(): Promise<boolean> {
    return this.getTombstoneBlockedCaptureIndex().isAuthoritative();
  }

  protected async rebuildTombstoneBlockedCaptureAfterInvalidation(): Promise<void> {
    await this.tombstoneBlockedCaptureIndex?.rebuildAfterInvalidation();
  }
}
