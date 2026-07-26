import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { withHeldFileLock } from "../utils/serialize-mutations.js";
import type { MemoryFile, MemoryFrontmatter } from "../types.js";
const TOMBSTONE_CAPTURE_WRITE_LOCK_STALE_MS = 60_000;
const CAPTURE_WRITE_LOCK_MAX_ATTEMPTS = 3;
const CAPTURE_WRITE_LOCK_RETRY_BASE_MS = 25;
const CAPTURE_WRITE_LOCK_BUSY_MESSAGE = "tombstone-blocked capture write lock remained busy";

export function isTombstoneBlockedCaptureWriteLockBusy(error: unknown): boolean {
  return error instanceof Error && error.message === CAPTURE_WRITE_LOCK_BUSY_MESSAGE;
}

export function normalizeExplicitCaptureContent(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

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

export function captureIdentityHash(memory: MemoryFile): string {
  return createHash("sha256")
    .update(buildExplicitCaptureDedupKey(memory.content, memory.frontmatter.category, memory.frontmatter.sourceConnector))
    .digest("hex");
}

export type TombstoneBlockedCaptureWriteLockOptions = {
  readonly stateDir: string;
  readonly withHeldFileLock?: typeof withHeldFileLock;
};

export class TombstoneBlockedCaptureWriteLock {
  private readonly context = new AsyncLocalStorage<ReadonlySet<string>>();

  constructor(private readonly options: TombstoneBlockedCaptureWriteLockOptions) {}

  private captureWriteLockPathForHash(identityHash: string): string {
    const filename =
      identityHash.length === 0
        ? "explicit-capture-write.lock"
        : `explicit-capture-write-${identityHash}.lock`;
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
  private async withPhysicalCaptureWriteLocks<T>(
    task: () => Promise<T>,
    identityHashes: readonly string[]
  ): Promise<T> {
    const lockPaths = [...new Set(identityHashes.map((hash) => this.captureWriteLockPathForHash(hash)))].sort();
    const acquire = async (index: number): Promise<T> => {
      if (index === lockPaths.length) return await task();
      return await this.withSingleCaptureWriteLock(lockPaths[index], () => acquire(index + 1));
    };
    return await acquire(0);
  }


  async withCaptureWriteLock<T>(
    task: () => Promise<T>,
    identity?: string | readonly string[]
  ): Promise<T> {
    const identities =
      Array.isArray(identity) && identity.length > 0 ? identity : [typeof identity === "string" ? identity : ""];
    const current = this.context.getStore();
    const hashToken = (key: string): string =>
      `\u0000${key.length === 0 ? "" : createHash("sha256").update(key).digest("hex")}`;
    const physicalMissing = current
      ? identities.filter((key) => !current.has(key) && !current.has(hashToken(key)))
      : identities;
    const next = new Set(current);
    for (const key of identities) {
      next.add(key);
      next.add(hashToken(key));
    }
    const run = () => this.context.run(next, task);
    if (physicalMissing.length === 0) return await run();
    return await this.withPhysicalCaptureWriteLocks(
      run,
      physicalMissing.map((key) => (key.length === 0 ? "" : createHash("sha256").update(key).digest("hex")))
    );
  }

  async withCaptureWriteLockHashes<T>(
    task: () => Promise<T>,
    identityHashes: readonly string[]
  ): Promise<T> {
    const hashes = [...new Set(identityHashes)];
    const current = this.context.getStore();
    const token = (hash: string): string => `\u0000${hash}`;
    const missing = current ? hashes.filter((hash) => !current.has(token(hash))) : hashes;
    const next = new Set(current);
    for (const hash of hashes) next.add(token(hash));
    const run = () => this.context.run(next, task);
    if (missing.length === 0) return await run();
    return await this.withPhysicalCaptureWriteLocks(run, missing);
  }
}


export type TombstoneBlockedMutationHost = {
  readCurrent: () => Promise<MemoryFile | null>;
  isBlocked: (memory: MemoryFile | null) => boolean;
  isQueuedReview: (memory: MemoryFile | null) => boolean;
  memoryIdentity: (memory: MemoryFile) => string;
  prepareWrite: () => Promise<string>;
  commitWrite: (marker: string) => Promise<void>;
  discardWrite: (marker: string) => Promise<void>;
  markUntrusted: () => void;
  writeStorageSecureFile: (pathname: string, fileContent: string) => Promise<void>;
  withCaptureWriteLock: (task: () => Promise<void>, identity: string | readonly string[]) => Promise<void>;
  logWarning: (message: string) => void;
};

export type TombstoneBlockedMutation = {
  blocked: boolean;
  pathname: string;
  fileContent: string;
  identity: string | readonly string[];
  updateIndex: (rebuildMarker?: string, current?: MemoryFile | null) => Promise<void>;
  beforeIndexUpdate?: () => Promise<void>;
  coordinate?: boolean;
};

export async function runTombstoneBlockedMutation(
  host: TombstoneBlockedMutationHost,
  mutation: TombstoneBlockedMutation,
): Promise<void> {
  let lockIdentity: string | readonly string[] = mutation.identity;
  let mustLock = mutation.blocked || mutation.coordinate === true;
  for (;;) {
    let retryIdentity: string | undefined;
    const mutate = async (): Promise<void> => {
      const current = await host.readCurrent();
      const currentBlocked = host.isBlocked(current);
      const currentQueuedReview = host.isQueuedReview(current);
      if (current !== null && (currentBlocked || currentQueuedReview)) {
        const currentIdentity = host.memoryIdentity(current);
        const heldIdentities = Array.isArray(lockIdentity) ? lockIdentity : [lockIdentity];
        if (!heldIdentities.includes(currentIdentity)) {
          retryIdentity = currentIdentity;
          return;
        }
      }
      const rebuildMarker = mutation.blocked || currentBlocked ? await host.prepareWrite() : undefined;
      try {
        await host.writeStorageSecureFile(mutation.pathname, mutation.fileContent);
      } catch (err) {
        if (rebuildMarker) {
          try {
            await host.discardWrite(rebuildMarker);
          } catch (cleanupError) {
            host.markUntrusted();
            host.logWarning(`storage.tombstoneBlocked failed to clear write marker: ${cleanupError}`);
          }
        }
        throw err;
      }
      if (rebuildMarker) {
        try {
          await host.commitWrite(rebuildMarker);
        } catch (err) {
          host.markUntrusted();
          host.logWarning(`storage.tombstoneBlocked committed write marker failed: ${err}`);
        }
      }
      if (rebuildMarker) await mutation.beforeIndexUpdate?.();
      await mutation.updateIndex(rebuildMarker, currentBlocked && current !== null ? current : undefined);
    };
    if (mustLock) {
      await host.withCaptureWriteLock(mutate, lockIdentity);
    } else {
      await mutate();
    }
    if (retryIdentity === undefined) return;
    const identities = Array.isArray(lockIdentity)
      ? [...lockIdentity, retryIdentity]
      : [lockIdentity, retryIdentity];
    lockIdentity = [...new Set(identities)];
    mustLock = true;
  }
}

export function tombstoneBlocked(frontmatter: MemoryFrontmatter): boolean {
  return frontmatter.status === "pending_review" && Boolean(frontmatter.blockedBy);
}

export function isQueuedReviewFrontmatter(frontmatter: MemoryFrontmatter): boolean {
  return frontmatter.status === "pending_review" && (frontmatter.tags ?? []).includes("queued-review");
}

export function isQueuedReviewMemory(memory: MemoryFile | null): memory is MemoryFile {
  return memory !== null && isQueuedReviewFrontmatter(memory.frontmatter);
}

export type TombstoneBlockedChunkMutation = {
  blocked: boolean;
  id: string;
  identity: string;
  findDuplicate: () => Promise<MemoryFile | null>;
  persistMemory: () => Promise<void>;
  afterWrite: () => Promise<void>;
  withCaptureWriteLock: (task: () => Promise<string>, identity: string) => Promise<string>;
};

export async function runTombstoneBlockedChunkMutation(
  mutation: TombstoneBlockedChunkMutation,
): Promise<string> {
  const persist = async (): Promise<string> => {
    if (mutation.blocked) {
      const duplicate = await mutation.findDuplicate();
      if (duplicate) return duplicate.frontmatter.id;
    }
    await mutation.persistMemory();
    await mutation.afterWrite();
    return mutation.id;
  };
  return mutation.blocked
    ? await mutation.withCaptureWriteLock(persist, mutation.identity)
    : await persist();
}
