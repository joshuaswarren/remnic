import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
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
import {
  buildExplicitCaptureDedupKey,
  TombstoneBlockedCaptureWriteLock,
} from "./tombstone-blocked-capture-mutation.js";
import type { OfflineSyncMemoryParser } from "./tombstone-blocked-capture-sync.js";
export {
  buildExplicitCaptureDedupKey,
  isTombstoneBlockedCaptureWriteLockBusy,
  normalizeExplicitCaptureContent,
} from "./tombstone-blocked-capture-mutation.js";
export {
  parseTombstoneBlockedOfflineSyncMemory,
  type OfflineSyncMemoryParser,
  TombstoneBlockedCaptureIndexHost,
} from "./tombstone-blocked-capture-sync.js";

const REBUILD_MAX_ATTEMPTS = 3;
const execFileAsync = promisify(execFile);
const REBUILD_RETRY_BASE_MS = 50;

const ABANDONED_MARKER_MIN_AGE_MS = 60_000;
const MARKER_PROCESS_START_TOLERANCE_MS = 2_000;
const DOTNET_UNIX_EPOCH_TICKS = 621_355_968_000_000_000;
const MARKER_PROCESS_STARTED_AT_MS = Date.now() - process.uptime() * 1000;


type RebuildMarker = {
  path: string;
  committed: boolean;
  pid?: number;
  ownerId?: string;
  createdAt?: number;
  processStartedAtMs?: number;
  malformed?: boolean;
};


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
  private readonly captureWriteLock: TombstoneBlockedCaptureWriteLock;

  constructor(options: TombstoneBlockedCaptureIndexOptions) {
    this.options = options;
    this.captureWriteLock = new TombstoneBlockedCaptureWriteLock(options);
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
              const processStartedAtMs =
                typeof value.processStartedAtMs === "number" &&
                Number.isFinite(value.processStartedAtMs) &&
                value.processStartedAtMs > 0
                  ? value.processStartedAtMs
                  : undefined;
              return {
                path: markerPath,
                committed: state === "committed",
                ...(typeof value.pid === "number" && Number.isInteger(value.pid) ? { pid: value.pid } : {}),
                ...(ownerId.length > 0 ? { ownerId } : {}),
                ...(typeof createdAt === "number" && Number.isFinite(createdAt) ? { createdAt } : {}),
                ...(processStartedAtMs === undefined ? {} : { processStartedAtMs }),
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
  private async isAbandonedMarker(marker: RebuildMarker): Promise<boolean> {
    if (marker.committed || marker.createdAt === undefined) return false;
    if (Date.now() - marker.createdAt < ABANDONED_MARKER_MIN_AGE_MS) return false;
    if (marker.malformed) return true;
    return marker.pid !== undefined && !(await this.isProcessAlive(marker.pid, marker.processStartedAtMs));
  }

  private async isProcessAlive(pid: number, processStartedAtMs?: number): Promise<boolean> {
    try {
      process.kill(pid, 0);
    } catch (err) {
      return !isErrnoCode(err, "ESRCH");
    }
    if (processStartedAtMs === undefined) return true;
    const runningStartedAtMs = await this.readProcessStartedAtMs(pid);
    if (runningStartedAtMs === null) return true;
    return runningStartedAtMs <= processStartedAtMs + MARKER_PROCESS_START_TOLERANCE_MS;
  }
  private async readProcessStartedAtMs(pid: number): Promise<number | null> {
    try {
      if (process.platform === "win32") {
        const { stdout } = await execFileAsync(
          "powershell.exe",
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
          ],
          { encoding: "utf8", timeout: 1_000 }
        );
        const ticks = Number(stdout.trim());
        return Number.isFinite(ticks) ? (ticks - DOTNET_UNIX_EPOCH_TICKS) / 10_000 : null;
      }
      const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        timeout: 1_000,
      });
      const output = stdout.trim();
      if (!output) return null;
      const startedAtMs = Date.parse(output);
      return Number.isFinite(startedAtMs) ? startedAtMs : null;
    } catch {
      return null;
    }
  }

  private async getClearableRebuildMarkerPaths(markers: readonly RebuildMarker[]): Promise<string[]> {
    const paths = await Promise.all(
      markers.map(async (marker) => (marker.committed || (await this.isAbandonedMarker(marker)) ? marker.path : null))
    );
    return paths.filter((markerPath): markerPath is string => markerPath !== null);
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
        processStartedAtMs: MARKER_PROCESS_STARTED_AT_MS,
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
        processStartedAtMs: MARKER_PROCESS_STARTED_AT_MS,
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
        const clearableRebuildMarkers = await this.getClearableRebuildMarkerPaths(rebuildMarkers);
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

  async withCaptureWriteLock<T>(task: () => Promise<T>, identity?: string | readonly string[]): Promise<T> {
    return await this.captureWriteLock.withCaptureWriteLock(task, identity);
  }

  async withCaptureWriteLockHashes<T>(task: () => Promise<T>, identityHashes: readonly string[]): Promise<T> {
    return await this.captureWriteLock.withCaptureWriteLockHashes(task, identityHashes);
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
    const clearableRebuildMarkers = await this.getClearableRebuildMarkerPaths(rebuildMarkers);
    const rebuilt = await this.rebuild(await index);
    if (rebuilt) {
      await this.clearRebuildRequired([
        ...clearableRebuildMarkers,
        ...(ownedMarker === undefined || clearableRebuildMarkers.includes(ownedMarker) ? [] : [ownedMarker]),
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
    const clearableExistingMarkers = await this.getClearableRebuildMarkerPaths(existingMarkers);
    if (rebuildMarker) await this.markRebuildCommitted(rebuildMarker);
    const rebuilt = await this.rebuild(await this.getIndex());
    if (rebuilt) {
      await this.clearRebuildRequired([
        ...clearableExistingMarkers,
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
