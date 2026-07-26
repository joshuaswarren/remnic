import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { log } from "../logger.js";
import type { MemoryFile, MemoryFrontmatter } from "../types.js";
import { RECALL_FALLBACK_DIRS } from "../utils/category-dir.js";
import { isErrnoCode } from "../utils/errno.js";
import { withHeldFileLock } from "../utils/serialize-mutations.js";
import {
  CONTENT_HASH_INDEX_RETRY_MAX_DELAY_MS,
  ContentHashIndex,
  type ContentHashIndexLockOptions,
} from "./content-hash-index.js";
import { writeMaybeEncryptedFileFromChunks } from "../secure-store/secure-fs.js";

const REBUILD_MAX_ATTEMPTS = 3;
const REBUILD_RETRY_BASE_MS = 50;

const TOMBSTONE_CAPTURE_WRITE_LOCK_STALE_MS = 60_000;
const CAPTURE_WRITE_LOCK_MAX_ATTEMPTS = 3;
const CAPTURE_WRITE_LOCK_RETRY_BASE_MS = 25;
const ABANDONED_MARKER_MIN_AGE_MS = 60_000;
const CAPTURE_WRITE_LOCK_BUSY_MESSAGE = "tombstone-blocked capture write lock remained busy";

export function isTombstoneBlockedCaptureWriteLockBusy(error: unknown): boolean {
  return error instanceof Error && error.message === CAPTURE_WRITE_LOCK_BUSY_MESSAGE;
}

type RebuildMarker = {
  path: string;
  committed: boolean;
  pid?: number;
  ownerId?: string;
  createdAt?: number;
  malformed?: boolean;
};

/**
 * Normalize the content identity used by explicit-capture duplicate checks.
 * This deliberately matches the capture path's historical comparison rather
 * than the punctuation-stripping fact-hash index: the index is only an
 * optimization, while this key gates whether a durable row needs inspection.
 */
export function normalizeExplicitCaptureContent(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Build the targeted identity for a tombstone-blocked explicit-capture row.
 * Content uses the same whitespace-only normalization as durable duplicate
 * checks; category and connector preserve their exact trimmed values.
 */
export function buildExplicitCaptureDedupKey(
  content: string,
  category: string,
  sourceConnector: string | undefined
): string {
  const encode = (label: string, value: string): string => `${label} ${value.length} ${value}`;
  return [
    encode("category", category),
    encode("connector", sourceConnector?.trim() ?? ""),
    encode("content", normalizeExplicitCaptureContent(content)),
  ].join(" ");
}

export type OfflineSyncMemoryParser = (filePath: string, content: Buffer) => MemoryFile | null;

export function parseTombstoneBlockedOfflineSyncMemory(
  filePath: string,
  content: Buffer,
  memoryDir: string,
  parseFrontmatter: (raw: string) => { frontmatter: MemoryFrontmatter; content: string } | null,
  normalizeFrontmatterForPath: (frontmatter: MemoryFrontmatter, pathRel: string, content?: string) => MemoryFrontmatter,
  toMemoryPathRel: (baseDir: string, filePath: string) => string
): MemoryFile | null {
  const parsed = parseFrontmatter(content.toString("utf8"));
  if (!parsed) return null;
  return {
    path: filePath,
    frontmatter: normalizeFrontmatterForPath(parsed.frontmatter, toMemoryPathRel(memoryDir, filePath), parsed.content),
    content: parsed.content,
  };
}

export type TombstoneBlockedCaptureIndexOptions = {
  readonly stateDir: string;
  readonly memoryDir: string;
  readonly secureStoreKeyProvider: () => Buffer | null;
  readonly secureStoreWriteKeyProvider: () => Buffer | null;
  readonly lockOptions: () => ContentHashIndexLockOptions;
  readonly readAllMemories: () => Promise<MemoryFile[]>;
  readonly readAllColdMemories: () => Promise<MemoryFile[]>;
  readonly parseMemory?: OfflineSyncMemoryParser;
  readonly withHeldFileLock?: typeof withHeldFileLock;
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
      this.options.lockOptions()
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
      const entries = (await readdir(this.rebuildMarkerPath())).filter((entry) => !entry.startsWith("."));
      return (
        await Promise.all(
          entries.map(async (entry) => {
            const markerPath = path.join(this.rebuildMarkerPath(), entry);
            try {
              const raw = (await readFile(markerPath, "utf8")).trim();
              if (raw === "committed") return { path: markerPath, committed: true };
              let value: Record<string, unknown>;
              let malformed = false;
              try {
                const parsed = JSON.parse(raw) as unknown;
                if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                  malformed = true;
                  value = {};
                } else {
                  value = parsed as Record<string, unknown>;
                }
              } catch {
                malformed = true;
                value = {};
              }
              const state = value.state;
              if (state !== "pending" && state !== "committed") malformed = true;
              const markerStat = await stat(markerPath).catch(() => null);
              // A torn payload can lose its JSON metadata, but the atomic
              // marker filename and filesystem mtime still identify its owner
              // and age. Preserve both so stale malformed markers can be
              // reaped without treating a fresh pre-commit gap as abandoned.
              const createdAt =
                typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
                  ? value.createdAt
                  : markerStat?.mtimeMs;
              if (typeof value.pid !== "number" || !Number.isInteger(value.pid)) malformed = true;
              const ownerId =
                typeof value.ownerId === "string" && value.ownerId.length > 0
                  ? value.ownerId
                  : path.basename(markerPath);
              if (typeof value.ownerId !== "string" || value.ownerId.length === 0) malformed = true;
              return {
                path: markerPath,
                committed: state === "committed",
                ...(typeof value.pid === "number" && Number.isInteger(value.pid) ? { pid: value.pid } : {}),
                ...(ownerId.length > 0 ? { ownerId } : {}),
                ...(typeof createdAt === "number" && Number.isFinite(createdAt) ? { createdAt } : {}),
                ...(malformed ? { malformed: true } : {}),
              };
            } catch (err) {
              if (isErrnoCode(err, "ENOENT")) return null;
              throw err;
            }
          })
        )
      ).filter((marker): marker is RebuildMarker => marker !== null);
    } catch (err) {
      if (isErrnoCode(err, "ENOENT")) return [];
      throw err;
    }
  }
  private isAbandonedMarker(marker: RebuildMarker): boolean {
    if (marker.committed || marker.createdAt === undefined) return false;
    if (Date.now() - marker.createdAt < ABANDONED_MARKER_MIN_AGE_MS) return false;
    if (marker.malformed) return true;
    return marker.pid !== undefined && !this.isProcessAlive(marker.pid);
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return !isErrnoCode(err, "ESRCH");
    }
  }

  private async getRebuildMarkers(): Promise<RebuildMarker[]> {
    return await this.readRebuildMarkers();
  }

  // A pending marker protects the pre-commit gap; only committed markers are safe for another writer to clear.
  private async writeMarkerAtomically(markerPath: string, payload: string): Promise<void> {
    const temporaryPath = `${markerPath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(temporaryPath, payload, "utf8");
      await rename(temporaryPath, markerPath);
    } finally {
      await unlink(temporaryPath).catch((err: unknown) => {
        if (!isErrnoCode(err, "ENOENT")) throw err;
      });
    }
  }

  private async markRebuildRequired(committed = false): Promise<string> {
    const markerDir = this.rebuildMarkerPath();
    await mkdir(markerDir, { recursive: true });
    const ownerId = randomUUID();
    const markerPath = path.join(markerDir, ownerId);
    await this.writeMarkerAtomically(
      markerPath,
      `${JSON.stringify({
        state: committed ? "committed" : "pending",
        pid: process.pid,
        ownerId,
        createdAt: Date.now(),
      })}\n`
    );
    return markerPath;
  }

  private async markRebuildCommitted(markerPath: string): Promise<void> {
    await this.writeMarkerAtomically(
      markerPath,
      `${JSON.stringify({
        state: "committed",
        pid: process.pid,
        ownerId: path.basename(markerPath),
        createdAt: Date.now(),
      })}\n`
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
      })
    );
  }

  private async hasRebuildRequired(excludedMarkers: readonly string[] = []): Promise<boolean> {
    const excluded = new Set(excludedMarkers);
    return (await this.getRebuildMarkers()).some((marker) => !excluded.has(marker.path));
  }

  private async setAuthoritative(rebuilt: boolean): Promise<void> {
    this.authoritative = rebuilt && !(await this.getRebuildMarkers()).some((marker) => !marker.committed);
  }
  private isBlocked(memory: MemoryFile): boolean {
    return memory.frontmatter.status === "pending_review" && Boolean(memory.frontmatter.blockedBy);
  }

  private async rebuild(index: ContentHashIndex): Promise<boolean> {
    return await index.rebuildUnderLock(async () => {
      index.clear();
      const existing = [...(await this.options.readAllMemories()), ...(await this.options.readAllColdMemories())];
      for (const memory of existing) {
        if (!this.isBlocked(memory)) continue;
        index.add(
          buildExplicitCaptureDedupKey(memory.content, memory.frontmatter.category, memory.frontmatter.sourceConnector)
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
            const delayState = Promise.withResolvers<void>();
            setTimeout(delayState.resolve, wait);
            await delayState.promise;
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

  private captureWriteLockPath(identity: string): string {
    const filename =
      identity.length === 0
        ? "explicit-capture-write.lock"
        : `explicit-capture-write-${createHash("sha256").update(identity).digest("hex")}.lock`;
    return path.join(this.options.stateDir, "tombstone-blocked-capture", filename);
  }

  private async withSingleCaptureWriteLock<T>(lockPath: string, task: () => Promise<T>): Promise<T> {
    await mkdir(path.dirname(lockPath), { recursive: true });
    const retry = Symbol("retry");
    const permanentFailure = Symbol("permanent-failure");
    const runWithHeldFileLock = this.options.withHeldFileLock ?? withHeldFileLock;
    for (let attempt = 0; attempt < CAPTURE_WRITE_LOCK_MAX_ATTEMPTS; attempt += 1) {
      const result = await runWithHeldFileLock<T | typeof retry | typeof permanentFailure>(
        lockPath,
        {
          staleMs: TOMBSTONE_CAPTURE_WRITE_LOCK_STALE_MS,
          maxWaitMs: 1_000,
          pollMs: 25,
        },
        async (acquired, controller) => {
          if (acquired) return await task();
          return controller.failure === "error" ? permanentFailure : retry;
        }
      );
      if (result === permanentFailure) {
        throw new Error("tombstone-blocked capture write lock acquisition failed");
      }
      if (result !== retry) return result;
      if (attempt === CAPTURE_WRITE_LOCK_MAX_ATTEMPTS - 1) break;
      const delayState = Promise.withResolvers<void>();
      setTimeout(delayState.resolve, CAPTURE_WRITE_LOCK_RETRY_BASE_MS * 2 ** attempt);
      await delayState.promise;
    }
    throw new Error(CAPTURE_WRITE_LOCK_BUSY_MESSAGE);
  }

  async withCaptureWriteLock<T>(task: () => Promise<T>, identity?: string | readonly string[]): Promise<T> {
    const identities =
      Array.isArray(identity) && identity.length > 0 ? identity : [typeof identity === "string" ? identity : ""];
    const lockPaths = [...new Set(identities.map((key) => this.captureWriteLockPath(key)))].sort();
    const run = async (index: number): Promise<T> => {
      if (index === lockPaths.length) return await task();
      return await this.withSingleCaptureWriteLock(lockPaths[index], () => run(index + 1));
    };
    return await run(0);
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
    sourceConnector?: string
  ): Promise<{ has: boolean; authoritative: boolean }> {
    const key = buildExplicitCaptureDedupKey(content, category, sourceConnector);
    let index = await this.getIndex();
    if ((await this.hasRebuildRequired()) || !(await index.isDiskFingerprintCurrent())) {
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
    if ((await this.hasRebuildRequired()) || !(await index.isDiskFingerprintCurrent())) {
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

  /** Drop a pending marker when the protected memory write never commits. */
  async discardWrite(rebuildMarker: string): Promise<void> {
    await this.clearRebuildRequired([rebuildMarker]);
  }

  /** Add a newly persisted blocked row to the durable targeted index. */
  async add(memory: MemoryFile, rebuildMarker?: string): Promise<void> {
    if (!this.isBlocked(memory)) return;
    let index = await this.getIndex();
    if (
      (await this.hasRebuildRequired(rebuildMarker ? [rebuildMarker] : [])) ||
      !(await index.isDiskFingerprintCurrent())
    ) {
      index = await this.reload();
    }
    index.add(
      buildExplicitCaptureDedupKey(memory.content, memory.frontmatter.category, memory.frontmatter.sourceConnector)
    );
    const marker = rebuildMarker ?? (await this.markRebuildRequired(true));
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
  async rebuildIfLoaded(ownedMarker?: string): Promise<void> {
    const index = this.index ?? ((await this.hasPersistedIndexOrMarkers()) ? this.getIndex() : null);
    if (!index) return;
    const rebuildMarkers = await this.getRebuildMarkers();
    const rebuildMarker = await this.markRebuildRequired(true);
    const rebuilt = await this.rebuild(await index);
    if (rebuilt) {
      await this.clearRebuildRequired([
        ...rebuildMarkers
          .filter((marker) => marker.committed || this.isAbandonedMarker(marker) || marker.path === ownedMarker)
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
      before.frontmatter.sourceConnector
    );
    const afterKey = buildExplicitCaptureDedupKey(
      after.content,
      after.frontmatter.category,
      after.frontmatter.sourceConnector
    );
    if (beforeBlocked && afterBlocked && beforeKey === afterKey) {
      if (rebuildMarker) {
        await this.markRebuildCommitted(rebuildMarker);
        await this.clearRebuildRequired([rebuildMarker]);
      }
      return;
    }
    const existingMarkers = await this.getRebuildMarkers();
    const marker = rebuildMarker ?? (await this.markRebuildRequired(true));
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
    rebuildMarker?: string
  ): Promise<void> {
    await this.failOpen("writeMemory", () => this.add({ path: pathname, frontmatter, content }, rebuildMarker));
  }

  async rebuildAfterInvalidation(ownedMarker?: string): Promise<void> {
    await this.failOpen("invalidateMemory", () => this.rebuildIfLoaded(ownedMarker));
  }

  async syncUpdatedMemory(
    before: MemoryFile,
    frontmatter: MemoryFrontmatter,
    content: string,
    rebuildMarker?: string
  ): Promise<void> {
    await this.failOpen("updateMemory", () => this.sync(before, { ...before, frontmatter, content }, rebuildMarker));
  }

  async syncUpdatedFrontmatter(
    before: MemoryFile,
    frontmatter: MemoryFrontmatter,
    rebuildMarker?: string
  ): Promise<void> {
    await this.failOpen("writeMemoryFrontmatter", () => this.sync(before, { ...before, frontmatter }, rebuildMarker));
  }
  shouldRebuildAfterInvalidationForPath(filePath: string): boolean {
    const relative = path.relative(path.resolve(this.options.memoryDir), path.resolve(filePath));
    const category = relative.split(path.sep)[0];
    return category === "cold" || RECALL_FALLBACK_DIRS.includes(category);
  }
}

export abstract class TombstoneBlockedCaptureIndexHost {
  private tombstoneBlockedCaptureIndex: TombstoneBlockedCaptureIndex | null = null;
  private readonly captureWriteLockContext = new AsyncLocalStorage<ReadonlySet<string>>();
  protected abstract tombstoneBlockedCaptureIndexOptions(): TombstoneBlockedCaptureIndexOptions;
  protected abstract writeStorageSecureFile(
    filePath: string,
    content: string | Buffer,
    forceEncrypt?: boolean
  ): Promise<void>;
  protected abstract assertManagedStoragePath(filePath: string, method: string): string;
  protected abstract notifyCatalogWriteForPath(filePath: string): void;
  protected abstract readMemoryByPath(filePath: string): Promise<MemoryFile | null>;
  protected abstract invalidateAllMemoriesCache(): void;
  protected abstract invalidateKnowledgeIndexCache(): void;
  protected abstract invalidateColdMemoriesCache(): void;
  protected abstract bumpArtifactWriteVersion(): number;
  protected abstract bumpMemoryStatusVersion(): void;
  protected abstract markFactHashIndexNotAuthoritative(): void;

  private async writeStorageSecureFileChunks(filePath: string, chunks: AsyncIterable<Buffer>): Promise<void> {
    const options = this.tombstoneBlockedCaptureIndexOptions();
    await writeMaybeEncryptedFileFromChunks(
      filePath,
      chunks,
      options.secureStoreWriteKeyProvider(),
      {},
      options.memoryDir
    );
    this.notifyCatalogWriteForPath(filePath);
  }

  protected getTombstoneBlockedCaptureIndex(): TombstoneBlockedCaptureIndex {
    if (this.tombstoneBlockedCaptureIndex === null) {
      this.tombstoneBlockedCaptureIndex = new TombstoneBlockedCaptureIndex(this.tombstoneBlockedCaptureIndexOptions());
    }
    return this.tombstoneBlockedCaptureIndex;
  }
  async withTombstoneBlockedCaptureWriteLock<T>(
    task: () => Promise<T>,
    identity?: string | readonly string[]
  ): Promise<T> {
    const identities =
      Array.isArray(identity) && identity.length > 0 ? identity : [typeof identity === "string" ? identity : ""];
    const current = this.captureWriteLockContext.getStore();
    const missing = current ? identities.filter((key) => !current.has(key)) : identities;
    if (missing.length === 0) {
      return await task();
    }
    const next = new Set(current);
    for (const key of identities) next.add(key);
    return await this.getTombstoneBlockedCaptureIndex().withCaptureWriteLock(
      () => this.captureWriteLockContext.run(next, task),
      missing
    );
  }
  private tombstoneBlocked(frontmatter: MemoryFrontmatter): boolean {
    return frontmatter.status === "pending_review" && Boolean(frontmatter.blockedBy);
  }

  private async writeTombstoneBlockedMutation(
    blocked: boolean,
    pathname: string,
    fileContent: string,
    identity: string | readonly string[],
    updateIndex: (rebuildMarker?: string) => Promise<void>,
    beforeIndexUpdate?: () => Promise<void>
  ): Promise<void> {
    const mutate = async (): Promise<void> => {
      const rebuildMarker = blocked ? await this.getTombstoneBlockedCaptureIndex().prepareWrite() : undefined;
      try {
        await this.writeStorageSecureFile(pathname, fileContent);
      } catch (err) {
        if (rebuildMarker) {
          try {
            await this.getTombstoneBlockedCaptureIndex().discardWrite(rebuildMarker);
          } catch (cleanupError) {
            this.getTombstoneBlockedCaptureIndex().markUntrusted();
            log.warn(`storage.tombstoneBlocked failed to clear write marker: ${cleanupError}`);
          }
        }
        throw err;
      }
      if (rebuildMarker) {
        try {
          await this.getTombstoneBlockedCaptureIndex().commitWrite(rebuildMarker);
        } catch (err) {
          // Retain the marker for the index hook: it can retry publication under
          // the same ownership token and clear it after the durable index update.
          this.getTombstoneBlockedCaptureIndex().markUntrusted();
          log.warn(`storage.tombstoneBlocked committed write marker failed: ${err}`);
        }
      }
      if (rebuildMarker) await beforeIndexUpdate?.();
      await updateIndex(rebuildMarker);
    };
    if (!blocked || this.captureWriteLockContext.getStore() !== undefined) {
      await mutate();
      return;
    }
    await this.withTombstoneBlockedCaptureWriteLock(mutate, identity);
  }

  protected async writeTombstoneBlockedMemory(
    pathname: string,
    fileContent: string,
    frontmatter: MemoryFrontmatter,
    content: string,
    beforeIndexUpdate?: () => Promise<void>
  ): Promise<void> {
    await this.writeTombstoneBlockedMutation(
      this.tombstoneBlocked(frontmatter),
      pathname,
      fileContent,
      buildExplicitCaptureDedupKey(content, frontmatter.category, frontmatter.sourceConnector),
      (rebuildMarker) =>
        this.getTombstoneBlockedCaptureIndex().addWrittenMemory(pathname, frontmatter, content, rebuildMarker),
      beforeIndexUpdate
    );
  }

  protected async writeTombstoneBlockedChunk(
    pathname: string,
    fileContent: string,
    frontmatter: MemoryFrontmatter,
    content: string,
    findDuplicate: () => Promise<MemoryFile | null>,
    afterWrite: () => Promise<void>
  ): Promise<string> {
    const blocked = this.tombstoneBlocked(frontmatter);
    const persist = async (): Promise<string> => {
      if (blocked) {
        const duplicate = await findDuplicate();
        if (duplicate) return duplicate.frontmatter.id;
      }
      await this.writeTombstoneBlockedMemory(pathname, fileContent, frontmatter, content);
      await afterWrite();
      return frontmatter.id;
    };
    if (blocked) {
      return await this.withTombstoneBlockedCaptureWriteLock(
        persist,
        buildExplicitCaptureDedupKey(content, frontmatter.category, frontmatter.sourceConnector)
      );
    }
    return await persist();
  }

  protected async writeTombstoneBlockedUpdate(
    before: MemoryFile,
    fileContent: string,
    frontmatter: MemoryFrontmatter,
    content: string,
    beforeIndexUpdate?: () => Promise<void>
  ): Promise<void> {
    await this.writeTombstoneBlockedMutation(
      this.tombstoneBlocked(before.frontmatter) || this.tombstoneBlocked(frontmatter),
      before.path,
      fileContent,
      [
        ...(this.tombstoneBlocked(before.frontmatter)
          ? [
              buildExplicitCaptureDedupKey(
                before.content,
                before.frontmatter.category,
                before.frontmatter.sourceConnector
              ),
            ]
          : []),
        ...(this.tombstoneBlocked(frontmatter)
          ? [buildExplicitCaptureDedupKey(content, frontmatter.category, frontmatter.sourceConnector)]
          : []),
      ],
      (rebuildMarker) =>
        this.getTombstoneBlockedCaptureIndex().syncUpdatedMemory(before, frontmatter, content, rebuildMarker),
      beforeIndexUpdate
    );
  }

  protected async writeTombstoneBlockedFrontmatter(
    before: MemoryFile,
    fileContent: string,
    frontmatter: MemoryFrontmatter,
    beforeIndexUpdate?: () => Promise<void>
  ): Promise<void> {
    await this.writeTombstoneBlockedMutation(
      this.tombstoneBlocked(before.frontmatter) || this.tombstoneBlocked(frontmatter),
      before.path,
      fileContent,
      [
        ...(this.tombstoneBlocked(before.frontmatter)
          ? [
              buildExplicitCaptureDedupKey(
                before.content,
                before.frontmatter.category,
                before.frontmatter.sourceConnector
              ),
            ]
          : []),
        ...(this.tombstoneBlocked(frontmatter)
          ? [buildExplicitCaptureDedupKey(before.content, frontmatter.category, frontmatter.sourceConnector)]
          : []),
      ],
      (rebuildMarker) =>
        this.getTombstoneBlockedCaptureIndex().syncUpdatedFrontmatter(before, frontmatter, rebuildMarker),
      beforeIndexUpdate
    );
  }

  private isTombstoneBlockedMemory(memory: MemoryFile | null): memory is MemoryFile {
    return memory !== null && memory.frontmatter.status === "pending_review" && Boolean(memory.frontmatter.blockedBy);
  }

  private offlineSyncMemoryIdentity(memory: MemoryFile): string {
    return buildExplicitCaptureDedupKey(
      memory.content,
      memory.frontmatter.category,
      memory.frontmatter.sourceConnector
    );
  }
  private async isDuplicateTombstoneBlockedOfflineSync(target: string, incoming: MemoryFile): Promise<boolean> {
    const before = await this.readMemoryByPath(target);
    const duplicate = await this.getTombstoneBlockedCaptureIndex().has(
      incoming.content,
      incoming.frontmatter.category,
      incoming.frontmatter.sourceConnector
    );
    if (!duplicate) return false;
    const incomingIdentity = this.offlineSyncMemoryIdentity(incoming);
    const options = this.tombstoneBlockedCaptureIndexOptions();
    const existing = [...(await options.readAllMemories()), ...(await options.readAllColdMemories())];
    const exactMatch = existing.some(
      (memory) => this.isTombstoneBlockedMemory(memory) && this.offlineSyncMemoryIdentity(memory) === incomingIdentity
    );
    if (!exactMatch) return false;
    if (!this.isTombstoneBlockedMemory(before)) return true;
    if (this.offlineSyncMemoryIdentity(before) !== incomingIdentity) return false;
    return before.content === incoming.content && isDeepStrictEqual(before.frontmatter, incoming.frontmatter);
  }

  private async invalidateAfterOfflineSyncMutation(filePath: string, ownedMarker?: string): Promise<void> {
    this.invalidateAllMemoriesCache();
    this.invalidateKnowledgeIndexCache();
    this.markFactHashIndexNotAuthoritative();
    if (filePath.includes(`${path.sep}cold${path.sep}`)) {
      this.invalidateColdMemoriesCache();
    }
    await this.rebuildTombstoneBlockedCaptureAfterInvalidationForPath(filePath, ownedMarker);
    if (filePath.includes(`${path.sep}artifacts${path.sep}`)) {
      this.bumpArtifactWriteVersion();
    }
    this.bumpMemoryStatusVersion();
  }

  protected async runTombstoneBlockedInvalidation(
    memory: MemoryFile,
    task: (
      current: MemoryFile,
      rebuildMarker: string | undefined,
      markDurable: () => void
    ) => Promise<boolean>
  ): Promise<boolean> {
    const initiallyBlocked = this.isTombstoneBlockedMemory(memory);
    const invalidate = async (): Promise<boolean> => {
      const current = (await this.tombstoneBlockedCaptureIndexOptions().readAllMemories()).find(
        (candidate) => candidate.frontmatter.id === memory.frontmatter.id
      );
      if (!current) return false;
      const blocked = this.isTombstoneBlockedMemory(current);
      const blockedIndex = blocked ? this.getTombstoneBlockedCaptureIndex() : null;
      let rebuildMarker: string | undefined;
      let durable = false;
      try {
        if (blockedIndex) rebuildMarker = await blockedIndex.prepareWrite();
        return await task(current, rebuildMarker, () => {
          durable = true;
        });
      } catch {
        if (rebuildMarker && !durable && blockedIndex) {
          try {
            await blockedIndex.discardWrite(rebuildMarker);
          } catch {
            blockedIndex.markUntrusted();
          }
        }
        return false;
      }
    };
    if (!initiallyBlocked) return invalidate();
    return await this.withTombstoneBlockedCaptureWriteLock(
      invalidate,
      buildExplicitCaptureDedupKey(memory.content, memory.frontmatter.category, memory.frontmatter.sourceConnector)
    );
  }

  protected async runTombstoneBlockedOfflineSyncMutation(
    target: string,
    after: MemoryFile | null,
    write: () => Promise<void>,
    coordinate = false
  ): Promise<void> {
    const before = await this.readMemoryByPath(target);
    const blocked = coordinate || this.isTombstoneBlockedMemory(before) || this.isTombstoneBlockedMemory(after);
    const identities = [
      ...(this.isTombstoneBlockedMemory(before) ? [this.offlineSyncMemoryIdentity(before)] : []),
      ...(this.isTombstoneBlockedMemory(after) ? [this.offlineSyncMemoryIdentity(after)] : []),
      ...(coordinate ? [target] : []),
      // A coordinate stream that cannot be parsed has no incoming identity
      // yet; hold the global capture lock while the durable stream is in flight.
      ...(coordinate && after === null ? [""] : []),
    ];
    const mutate = async (): Promise<void> => {
      if (
        this.isTombstoneBlockedMemory(after) &&
        (await this.isDuplicateTombstoneBlockedOfflineSync(target, after))
      ) {
        return;
      }
      const marker = blocked ? await this.getTombstoneBlockedCaptureIndex().prepareWrite() : undefined;
      let durable = false;
      try {
        await write();
        durable = true;
        if (marker) {
          try {
            await this.getTombstoneBlockedCaptureIndex().commitWrite(marker);
          } catch (err) {
            this.getTombstoneBlockedCaptureIndex().markUntrusted();
            log.warn(`storage.offlineSyncFile committed write marker failed: ${err}`);
          }
        }
        await this.invalidateAfterOfflineSyncMutation(target, marker);
      } catch (err) {
        if (marker && !durable) {
          try {
            await this.getTombstoneBlockedCaptureIndex().discardWrite(marker);
          } catch (cleanupError) {
            this.getTombstoneBlockedCaptureIndex().markUntrusted();
            log.warn(`storage.offlineSyncFile failed to clear write marker: ${cleanupError}`);
          }
        }
        throw err;
      }
    };
    if (!blocked || this.captureWriteLockContext.getStore() !== undefined) {
      await mutate();
      return;
    }
    await this.withTombstoneBlockedCaptureWriteLock(mutate, identities);
  }

  protected async writeTombstoneBlockedOfflineSyncFile(target: string, content: Buffer): Promise<void> {
    await this.runTombstoneBlockedOfflineSyncMutation(
      target,
      this.tombstoneBlockedCaptureIndexOptions().parseMemory?.(target, content) ?? null,
      () => this.writeStorageSecureFile(target, content)
    );
  }

  private async prepareTombstoneBlockedOfflineSyncChunks(
    target: string,
    chunks: AsyncIterable<Buffer>
  ): Promise<{ after: MemoryFile | null; chunks: AsyncIterable<Buffer> }> {
    const parseMemory = this.tombstoneBlockedCaptureIndexOptions().parseMemory;
    if (!parseMemory) return { after: null, chunks };

    const iterator = chunks[Symbol.asyncIterator]();
    const buffered: Buffer[] = [];
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      buffered.push(next.value);
    }

    let after: MemoryFile | null = null;
    try {
      after = parseMemory(target, Buffer.concat(buffered));
    } catch {
      after = null;
    }
    const replay = (async function* (): AsyncIterable<Buffer> {
      for (const chunk of buffered) yield chunk;
    })();
    return { after, chunks: replay };
  }

  protected async writeTombstoneBlockedOfflineSyncFileChunks(
    target: string,
    chunks: AsyncIterable<Buffer>
  ): Promise<void> {
    const coordinate = this.getTombstoneBlockedCaptureIndex().shouldRebuildAfterInvalidationForPath(target);
    const prepared = coordinate
      ? await this.prepareTombstoneBlockedOfflineSyncChunks(target, chunks)
      : { after: null, chunks };
    const incoming = this.isTombstoneBlockedMemory(prepared.after) ? prepared.after : null;
    const incomingIdentity = incoming ? this.offlineSyncMemoryIdentity(incoming) : null;
    const identities = [
      ...(incomingIdentity ? [incomingIdentity] : []),
      ...(coordinate ? [target] : []),
      ...(coordinate && prepared.after === null ? [""] : []),
    ];
    const mutate = async (): Promise<void> => {
      await this.runTombstoneBlockedOfflineSyncMutation(
        target,
        prepared.after,
        () => this.writeStorageSecureFileChunks(target, prepared.chunks),
        coordinate
      );
    };
    if (!coordinate) {
      await mutate();
      return;
    }
    await this.withTombstoneBlockedCaptureWriteLock(mutate, identities);
  }

  async writeOfflineSyncFile(filePath: string, content: Buffer): Promise<void> {
    const target = this.assertManagedStoragePath(filePath, "storage.writeOfflineSyncFile");
    await this.writeTombstoneBlockedOfflineSyncFile(target, content);
  }

  async writeOfflineSyncFileChunks(filePath: string, chunks: AsyncIterable<Buffer>): Promise<void> {
    const target = this.assertManagedStoragePath(filePath, "storage.writeOfflineSyncFileChunks");
    await this.writeTombstoneBlockedOfflineSyncFileChunks(target, chunks);
  }

  async deleteOfflineSyncFile(filePath: string): Promise<void> {
    const target = this.assertManagedStoragePath(filePath, "storage.deleteOfflineSyncFile");
    await this.deleteTombstoneBlockedOfflineSyncFile(target);
  }

  protected async deleteTombstoneBlockedOfflineSyncFile(target: string): Promise<void> {
    await this.runTombstoneBlockedOfflineSyncMutation(target, null, async () => {
      await unlink(target).catch((error: unknown) => {
        if (isErrnoCode(error, "ENOENT")) return;
        throw error;
      });
    });
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

  protected async rebuildTombstoneBlockedCaptureAfterInvalidationForPath(
    filePath: string,
    ownedMarker?: string
  ): Promise<void> {
    const index = this.getTombstoneBlockedCaptureIndex();
    if (index.shouldRebuildAfterInvalidationForPath(filePath)) {
      await this.rebuildTombstoneBlockedCaptureAfterInvalidation(ownedMarker);
    }
  }
  protected async rebuildTombstoneBlockedCaptureAfterInvalidation(ownedMarker?: string): Promise<void> {
    await this.getTombstoneBlockedCaptureIndex().rebuildAfterInvalidation(ownedMarker);
  }
}
