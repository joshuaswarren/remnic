import { stat } from "node:fs/promises";
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
        let persisted = true;
        try {
          await stat(this.indexPath());
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

  /** Return whether a blocked row matches this explicit-capture identity. */
  async has(content: string, category: string, sourceConnector?: string): Promise<boolean> {
    const key = buildExplicitCaptureDedupKey(content, category, sourceConnector);
    const index = await this.getIndex();
    if (await index.isDiskFingerprintCurrent()) return index.has(key);
    return (await this.reload()).has(key);
  }

  /** Return whether the in-memory index is safe to answer an authoritative miss. */
  async isAuthoritative(): Promise<boolean> {
    const index = await this.getIndex();
    if (!(await index.isDiskFingerprintCurrent())) await this.reload();
    return this.authoritative;
  }

  /** Add a newly persisted blocked row to the durable targeted index. */
  async add(memory: MemoryFile): Promise<void> {
    if (!this.isBlocked(memory)) return;
    const index = await this.getIndex();
    index.add(
      buildExplicitCaptureDedupKey(
        memory.content,
        memory.frontmatter.category,
        memory.frontmatter.sourceConnector,
      ),
    );
    await index.saveMergingWithDisk();
    await index.flushReconcileRetry();
  }

  /** Rebuild the loaded index after a blocked row changes or is removed. */
  async rebuildIfLoaded(): Promise<void> {
    if (!this.index) return;
    this.authoritative = await this.rebuild(this.index);
  }

  /** Rebuild when either side of a write is blocked and its identity changed. */
  async sync(before: MemoryFile, after: MemoryFile): Promise<void> {
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
    if (beforeBlocked && afterBlocked && beforeKey === afterKey) return;
    this.authoritative = await this.rebuild(await this.getIndex());
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

  async addWrittenMemory(pathname: string, frontmatter: MemoryFrontmatter, content: string): Promise<void> {
    await this.failOpen("writeMemory", () => this.add({ path: pathname, frontmatter, content }));
  }

  async rebuildAfterInvalidation(): Promise<void> {
    await this.failOpen("invalidateMemory", () => this.rebuildIfLoaded());
  }

  async syncUpdatedMemory(
    before: MemoryFile,
    frontmatter: MemoryFrontmatter,
    content: string,
  ): Promise<void> {
    await this.failOpen("updateMemory", () => this.sync(before, { ...before, frontmatter, content }));
  }

  async syncUpdatedFrontmatter(before: MemoryFile, frontmatter: MemoryFrontmatter): Promise<void> {
    await this.failOpen("writeMemoryFrontmatter", () => this.sync(before, { ...before, frontmatter }));
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
