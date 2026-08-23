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

export function buildCapturePathLockIdentity(pathname: string): string {
  return `path ${pathname.length} ${pathname}`;
}

export function captureIdentityHash(memory: MemoryFile): string {
  return createHash("sha256")
    .update(
      buildExplicitCaptureDedupKey(memory.content, memory.frontmatter.category, memory.frontmatter.sourceConnector)
    )
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
      identityHash.length === 0 ? "explicit-capture-write.lock" : `explicit-capture-write-${identityHash}.lock`;
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
    const lockPaths = [...new Set(identityHashes.map((hash) => this.captureWriteLockPathForHash(hash)))];
    const acquire = async (index: number): Promise<T> => {
      if (index === lockPaths.length) return await task();
      return await this.withSingleCaptureWriteLock(lockPaths[index], () => acquire(index + 1));
    };
    return await acquire(0);
  }

  async withCaptureWriteLock<T>(task: () => Promise<T>, identity?: string | readonly string[]): Promise<T> {
    const identities =
      Array.isArray(identity) && identity.length > 0 ? identity : [typeof identity === "string" ? identity : ""];
    return await this.withCaptureWriteLocks(task, identities, []);
  }

  async withCaptureWriteLockHashes<T>(task: () => Promise<T>, identityHashes: readonly string[]): Promise<T> {
    return await this.withCaptureWriteLocks(task, [], identityHashes);
  }

  async withCaptureWriteLockAndHashes<T>(
    task: () => Promise<T>,
    identity: string | readonly string[] | undefined,
    identityHashes: readonly string[]
  ): Promise<T> {
    const identities =
      Array.isArray(identity) && identity.length > 0 ? identity : [typeof identity === "string" ? identity : ""];
    return await this.withCaptureWriteLocks(task, identities, identityHashes);
  }

  private async withCaptureWriteLocks<T>(
    task: () => Promise<T>,
    identities: readonly string[],
    identityHashes: readonly string[]
  ): Promise<T> {
    const current = this.context.getStore();
    const hashToken = (key: string): string =>
      `\u0000${key.length === 0 ? "" : createHash("sha256").update(key).digest("hex")}`;
    const identityHash = (key: string): string =>
      key.length === 0 ? "" : createHash("sha256").update(key).digest("hex");
    const identityKeys = [...new Set(identities)];
    const hashes = [...new Set(identityHashes)];
    const requested = [
      ...identityKeys
        .filter((key) => !current || (!current.has(key) && !current.has(hashToken(key))))
        .map((key) => ({ hash: identityHash(key), pathLock: key.startsWith("path ") })),
      ...hashes.filter((hash) => !current || !current.has(`\u0000${hash}`)).map((hash) => ({ hash, pathLock: false })),
    ]
      .filter((entry, index, entries) => entries.findIndex((candidate) => candidate.hash === entry.hash) === index)
      .sort(
        (left, right) =>
          Number(left.pathLock) - Number(right.pathLock) ||
          this.captureWriteLockPathForHash(left.hash).localeCompare(this.captureWriteLockPathForHash(right.hash))
      );
    const physicalMissing = requested.map((entry) => entry.hash);
    if (current && requested.length > 0) {
      const held = [...current]
        .filter((token) => token.startsWith("\u0000"))
        .map((token) => {
          const hash = token.slice(1);
          const pathLock = [...current].some(
            (key) => !key.startsWith("\u0000") && key.startsWith("path ") && hashToken(key) === token
          );
          return { hash, pathLock };
        });
      const requestedFirst = requested[0];
      const heldLast = held
        .sort(
          (left, right) =>
            Number(left.pathLock) - Number(right.pathLock) ||
            this.captureWriteLockPathForHash(left.hash).localeCompare(this.captureWriteLockPathForHash(right.hash))
        )
        .at(-1);
      if (
        heldLast &&
        requestedFirst &&
        (Number(requestedFirst.pathLock) < Number(heldLast.pathLock) ||
          (requestedFirst.pathLock === heldLast.pathLock &&
            this.captureWriteLockPathForHash(requestedFirst.hash) < this.captureWriteLockPathForHash(heldLast.hash)))
      ) {
        throw new Error(CAPTURE_WRITE_LOCK_BUSY_MESSAGE);
      }
    }
    const next = new Set(current);
    for (const key of identityKeys) {
      next.add(key);
      next.add(hashToken(key));
    }
    for (const hash of hashes) next.add(`\u0000${hash}`);
    const run = () => this.context.run(next, task);
    if (physicalMissing.length === 0) return await run();
    return await this.withPhysicalCaptureWriteLocks(run, physicalMissing);
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
  commitDurableMemoryRevision?: (pathname: string) => Promise<string | undefined>;
};

export type TombstoneBlockedMutation = {
  blocked: boolean;
  pathname: string;
  fileContent: string;
  identity: string | readonly string[];
  updateIndex: (rebuildMarker?: string, current?: MemoryFile | null) => Promise<void>;
  beforeIndexUpdate?: () => Promise<void>;
  coordinate?: boolean;
  shouldMintRevision?: (current: MemoryFile | null) => boolean;
};

export async function runTombstoneBlockedMutation(
  host: TombstoneBlockedMutationHost,
  mutation: TombstoneBlockedMutation
): Promise<string | undefined> {
  let lockIdentity: string | readonly string[] = mutation.identity;
  for (;;) {
    let retryIdentity: string | undefined;
    let mintedRevision: string | undefined;
    const mutate = async (): Promise<void> => {
      const current = await host.readCurrent();
      const currentBlocked = host.isBlocked(current);
      const currentQueuedReview = host.isQueuedReview(current);
      if (current !== null && (mutation.coordinate === true || currentBlocked || currentQueuedReview)) {
        const currentIdentity = host.memoryIdentity(current);
        const heldIdentities = Array.isArray(lockIdentity) ? lockIdentity : [lockIdentity];
        if (!heldIdentities.includes(currentIdentity)) {
          retryIdentity = currentIdentity;
          return;
        }
      }
      const rebuildMarker = mutation.blocked || currentBlocked ? await host.prepareWrite() : undefined;
      try {
        // #2813 (P1 B): reserve the receipt BEFORE the durable file
        // publish, inside this same path lock. A failed mint must leave the
        // memory file untouched — never a mutated record without a receipt.
        // A later file-write failure may strand a skipped receipt (token
        // minted, record unchanged), which retires no earlier receipt and
        // attributes no false ownership.
        if (mutation.shouldMintRevision?.(current)) {
          mintedRevision = await host.commitDurableMemoryRevision?.(mutation.pathname);
        }
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

    await host.withCaptureWriteLock(mutate, lockIdentity);
    if (retryIdentity === undefined) return mintedRevision;
    const identities = Array.isArray(lockIdentity) ? [...lockIdentity, retryIdentity] : [lockIdentity, retryIdentity];
    lockIdentity = [...new Set(identities)];
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
