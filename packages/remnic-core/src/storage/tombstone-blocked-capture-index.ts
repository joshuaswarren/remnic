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
import { RECALL_FALLBACK_DIRS } from "../utils/category-dir.js";
import { withHeldFileLock } from "../utils/serialize-mutations.js";
import { log } from "../logger.js";

const REBUILD_MAX_ATTEMPTS = 3;
const REBUILD_RETRY_BASE_MS = 50;

const TOMBSTONE_CAPTURE_WRITE_LOCK_STALE_MS = 60_000;
const ABANDONED_MARKER_MIN_AGE_MS = 60_000;

type RebuildMarker = {
  path: string;
  committed: boolean;
  pid?: number;
  ownerId?: string;
  createdAt?: number;
};

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

  private async readRebuildMarkers(): Promise<RebuildMarker[]> {
    try {
      const entries = await readdir(this.rebuildMarkerPath());
      return (
        await Promise.all(
          entries.map(async (entry) => {
            const markerPath = path.join(this.rebuildMarkerPath(), entry);
            try {
              const raw = (await readFile(markerPath, "utf8")).trim();
              if (raw === "committed") return { path: markerPath, committed: true };
              try {
                const value = JSON.parse(raw) as Record<string, unknown>;
                return {
                  path: markerPath,
                  committed: value.state === "committed",
                  ...(Number.isInteger(value.pid) ? { pid: value.pid as number } : {}),
                  ...(typeof value.ownerId === "string" ? { ownerId: value.ownerId } : {}),
                  ...(typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
                    ? { createdAt: value.createdAt }
                    : {}),
                };
              } catch {
                return { path: markerPath, committed: false };
              }
            } catch (err) {
              if (isErrnoCode(err, "ENOENT")) return null;
              throw err;
            }
          }),
        )
      ).filter((marker): marker is RebuildMarker => marker !== null);
    } catch (err) {
      if (isErrnoCode(err, "ENOENT")) return [];
      throw err;
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return !isErrnoCode(err, "ESRCH");
    }
  }

  private isAbandonedMarker(marker: RebuildMarker): boolean {
    return (
      !marker.committed
      && marker.pid !== undefined
      && marker.createdAt !== undefined
      && Date.now() - marker.createdAt >= ABANDONED_MARKER_MIN_AGE_MS
      && !this.isProcessAlive(marker.pid)
    );
  }

  private async getRebuildMarkers(): Promise<RebuildMarker[]> {
    return await this.readRebuildMarkers();
  }

  // A pending marker protects the pre-commit gap; only committed markers are safe for another writer to clear.
  private async markRebuildRequired(committed = false): Promise<string> {
    const markerDir = this.rebuildMarkerPath();
    await mkdir(markerDir, { recursive: true });
    const ownerId = randomUUID();
    const markerPath = path.join(markerDir, ownerId);
    await writeFile(
      markerPath,
      `${JSON.stringify({
        state: committed ? "committed" : "pending",
        pid: process.pid,
        ownerId,
        createdAt: Date.now(),
      })}\n`,
      "utf8",
    );
    return markerPath;
  }

  private async markRebuildCommitted(markerPath: string): Promise<void> {
    await writeFile(
      markerPath,
      `${JSON.stringify({
        state: "committed",
        pid: process.pid,
        ownerId: path.basename(markerPath),
        createdAt: Date.now(),
      })}\n`,
      "utf8",
    );
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

  private async hasRebuildRequired(excludedMarkers: readonly string[] = []): Promise<boolean> {
    const excluded = new Set(excludedMarkers);
    return (await this.getRebuildMarkers()).some((marker) => !excluded.has(marker.path));
  }


  private async setAuthoritative(rebuilt: boolean): Promise<void> {
    this.authoritative =
      rebuilt && !(await this.getRebuildMarkers()).some((marker) => !marker.committed);
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

  private async hasPersistedIndexOrMarkers(): Promise<boolean> {
    try {
      await stat(this.indexPath());
      return true;
    } catch (err) {
      if (!isErrnoCode(err, "ENOENT")) throw err;
      return (await this.readRebuildMarkers()).length > 0;
    }
  }

  private async getIndex(): Promise<ContentHashIndex> {
    if (this.index) return this.index;
    if (!this.loadPromise) {
      const index = this.createIndex();
      this.loadPromise = (async () => {
        await index.load();
        const rebuildMarkers = await this.getRebuildMarkers();
        const clearableRebuildMarkers = rebuildMarkers
          .filter((marker) => marker.committed || this.isAbandonedMarker(marker))
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
          await this.clearRebuildRequired(clearableRebuildMarkers);
        }
        await this.setAuthoritative(true);
        this.index = index;
        return index;
      })().catch((err) => {
        this.loadPromise = null;
        throw err;
      });
    }
    return this.loadPromise;
  }

  async withCaptureWriteLock<T>(task: () => Promise<T>): Promise<T> {
    const lockPath = path.join(
      this.options.stateDir,
      "tombstone-blocked-capture",
      "explicit-capture-write.lock",
    );
    await mkdir(path.dirname(lockPath), { recursive: true });
    const retry = Symbol("retry");
    for (;;) {
      const result = await withHeldFileLock<T | typeof retry>(
        lockPath,
        {
          staleMs: TOMBSTONE_CAPTURE_WRITE_LOCK_STALE_MS,
          maxWaitMs: 1_000,
          pollMs: 25,
        },
        async (acquired) => (acquired ? await task() : retry),
      );
      if (result !== retry) return result;
    }
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
      await this.hasRebuildRequired(rebuildMarker ? [rebuildMarker] : [])
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
    await this.setAuthoritative(true);
  }

  /** Rebuild the index after a blocked row changes or is removed. */
  async rebuildIfLoaded(): Promise<void> {
    const index = this.index ?? (await this.hasPersistedIndexOrMarkers() ? this.getIndex() : null);
    if (!index) return;
    const rebuildMarkers = await this.getRebuildMarkers();
    const rebuildMarker = await this.markRebuildRequired(true);
    const rebuilt = await this.rebuild(await index);
    if (rebuilt) {
      await this.clearRebuildRequired([
        ...rebuildMarkers
          .filter((marker) => marker.committed || this.isAbandonedMarker(marker))
          .map((marker) => marker.path),
        rebuildMarker,
      ]);
    }
    await this.setAuthoritative(rebuilt);
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
        ...existingMarkers
          .filter((entry) => entry.committed || this.isAbandonedMarker(entry))
          .map((entry) => entry.path),
        marker,
      ]);
    }
    await this.setAuthoritative(rebuilt);
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
  shouldRebuildAfterInvalidationForPath(filePath: string): boolean {
    const relative = path.relative(path.resolve(this.options.memoryDir), path.resolve(filePath));
    const category = relative.split(path.sep)[0];
    return category === "cold" || RECALL_FALLBACK_DIRS.includes(category);
  }
}

export abstract class TombstoneBlockedCaptureIndexHost {
  private tombstoneBlockedCaptureIndex: TombstoneBlockedCaptureIndex | null = null;
  protected abstract tombstoneBlockedCaptureIndexOptions(): TombstoneBlockedCaptureIndexOptions;
  protected abstract writeStorageSecureFile(
    filePath: string,
    content: string | Buffer,
    forceEncrypt?: boolean,
  ): Promise<void>;

  protected getTombstoneBlockedCaptureIndex(): TombstoneBlockedCaptureIndex {
    return this.tombstoneBlockedCaptureIndex ??= new TombstoneBlockedCaptureIndex(
      this.tombstoneBlockedCaptureIndexOptions(),
    );
  }

  async withTombstoneBlockedCaptureWriteLock<T>(task: () => Promise<T>): Promise<T> {
    return await this.getTombstoneBlockedCaptureIndex().withCaptureWriteLock(task);
  }
  private tombstoneBlocked(frontmatter: MemoryFrontmatter): boolean {
    return frontmatter.status === "pending_review" && Boolean(frontmatter.blockedBy);
  }

  private async writeTombstoneBlockedMutation(
    blocked: boolean,
    pathname: string,
    fileContent: string,
    updateIndex: (rebuildMarker?: string) => Promise<void>,
  ): Promise<void> {
    let rebuildMarker = blocked
      ? await this.getTombstoneBlockedCaptureIndex().prepareWrite()
      : undefined;
    await this.writeStorageSecureFile(pathname, fileContent);
    if (rebuildMarker) {
      try {
        await this.getTombstoneBlockedCaptureIndex().commitWrite(rebuildMarker);
      } catch (err) {
        this.getTombstoneBlockedCaptureIndex().markUntrusted();
        log.warn(`storage.tombstoneBlocked committed write marker failed: ${err}`);
        rebuildMarker = undefined;
      }
    }
    await updateIndex(rebuildMarker);
  }

  protected async writeTombstoneBlockedMemory(
    pathname: string,
    fileContent: string,
    frontmatter: MemoryFrontmatter,
    content: string,
  ): Promise<void> {
    await this.writeTombstoneBlockedMutation(
      this.tombstoneBlocked(frontmatter),
      pathname,
      fileContent,
      (rebuildMarker) => this.getTombstoneBlockedCaptureIndex().addWrittenMemory(
        pathname,
        frontmatter,
        content,
        rebuildMarker,
      ),
    );
  }

  protected async writeTombstoneBlockedUpdate(
    before: MemoryFile,
    fileContent: string,
    frontmatter: MemoryFrontmatter,
    content: string,
  ): Promise<void> {
    await this.writeTombstoneBlockedMutation(
      this.tombstoneBlocked(before.frontmatter) || this.tombstoneBlocked(frontmatter),
      before.path,
      fileContent,
      (rebuildMarker) => this.getTombstoneBlockedCaptureIndex().syncUpdatedMemory(
        before,
        frontmatter,
        content,
        rebuildMarker,
      ),
    );
  }

  protected async writeTombstoneBlockedFrontmatter(
    before: MemoryFile,
    fileContent: string,
    frontmatter: MemoryFrontmatter,
  ): Promise<void> {
    await this.writeTombstoneBlockedMutation(
      this.tombstoneBlocked(before.frontmatter) || this.tombstoneBlocked(frontmatter),
      before.path,
      fileContent,
      (rebuildMarker) => this.getTombstoneBlockedCaptureIndex().syncUpdatedFrontmatter(
        before,
        frontmatter,
        rebuildMarker,
      ),
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

  protected async rebuildTombstoneBlockedCaptureAfterInvalidationForPath(filePath: string): Promise<void> {
    const index = this.getTombstoneBlockedCaptureIndex();
    if (index.shouldRebuildAfterInvalidationForPath(filePath)) {
      await this.rebuildTombstoneBlockedCaptureAfterInvalidation();
    }
  }
  protected async rebuildTombstoneBlockedCaptureAfterInvalidation(): Promise<void> {
    await this.tombstoneBlockedCaptureIndex?.rebuildAfterInvalidation();
  }
}
