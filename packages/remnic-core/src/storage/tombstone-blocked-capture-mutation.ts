import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { log } from "../logger.js";
import type { MemoryFile, MemoryFrontmatter } from "../types.js";
import { withHeldFileLock } from "../utils/serialize-mutations.js";
import { sleep } from "../utils/sleep.js";
import {
  CAPTURE_WRITE_LOCK_BUSY_MESSAGE,
  type CaptureWriteLockLimitSource,
  captureWriteLockDelayMs,
  resolveCaptureWriteLockBackoffLimits,
} from "./capture-write-lock-backoff.js";
import type { CasRevisionTransaction } from "./cas-revision-store.js";

export { isTombstoneBlockedCaptureWriteLockBusy } from "./capture-write-lock-backoff.js";

const TOMBSTONE_CAPTURE_WRITE_LOCK_STALE_MS = 60_000;
/**
 * One exclusive-create probe. The bounded wait lives in the outer backoff,
 * which runs only after every lock from this attempt has been released.
 * A multi-second poll here would hold an already-acquired sibling lock.
 */
const CAPTURE_WRITE_LOCK_PROBE_MS = 1;
const CAPTURE_WRITE_LOCK_RETRY = Symbol("capture-write-lock-retry");
const CAPTURE_WRITE_LOCK_PERMANENT = Symbol("capture-write-lock-permanent-failure");

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
  /** Read when an acquire starts, after the caller has installed converge config. */
  readonly lockOptions?: () => CaptureWriteLockLimitSource;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly logDebug?: (message: string) => void;
  readonly logWarn?: (message: string) => void;
};

export class TombstoneBlockedCaptureWriteLock {
  private readonly context = new AsyncLocalStorage<ReadonlySet<string>>();

  constructor(private readonly options: TombstoneBlockedCaptureWriteLockOptions) {}

  private captureWriteLockPathForHash(identityHash: string): string {
    const filename =
      identityHash.length === 0 ? "explicit-capture-write.lock" : `explicit-capture-write-${identityHash}.lock`;
    return path.join(this.options.stateDir, "tombstone-blocked-capture", filename);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private debug(message: string): void {
    if (this.options.logDebug) {
      this.options.logDebug(message);
      return;
    }
    log.debug(message);
  }

  private warn(message: string): void {
    if (this.options.logWarn) {
      this.options.logWarn(message);
      return;
    }
    log.warn(message);
  }

  /**
   * One probe of a single lock file. Returns the retry symbol when the lock
   * is busy and the permanent symbol on a filesystem error. Does not sleep:
   * the caller backs off only after the whole chain has unwound.
   */
  private async withSingleCaptureWriteLockOnce<T>(
    lockPath: string,
    task: () => Promise<T | typeof CAPTURE_WRITE_LOCK_RETRY>
  ): Promise<T | typeof CAPTURE_WRITE_LOCK_RETRY | typeof CAPTURE_WRITE_LOCK_PERMANENT> {
    await mkdir(path.dirname(lockPath), { recursive: true });
    const runWithHeldFileLock = this.options.withHeldFileLock ?? withHeldFileLock;
    return await runWithHeldFileLock(
      lockPath,
      {
        staleMs: TOMBSTONE_CAPTURE_WRITE_LOCK_STALE_MS,
        maxWaitMs: CAPTURE_WRITE_LOCK_PROBE_MS,
        pollMs: CAPTURE_WRITE_LOCK_PROBE_MS,
      },
      async (acquired, controller) => {
        if (acquired) return await task();
        return controller.failure === "error" ? CAPTURE_WRITE_LOCK_PERMANENT : CAPTURE_WRITE_LOCK_RETRY;
      }
    );
  }

  private async withPhysicalCaptureWriteLocks<T>(
    task: () => Promise<T>,
    identityHashes: readonly string[]
  ): Promise<T> {
    const lockPaths = [...new Set(identityHashes.map((hash) => this.captureWriteLockPathForHash(hash)))];
    const limits = resolveCaptureWriteLockBackoffLimits(this.options.lockOptions?.());
    const deadline = this.now() + limits.deadlineMs;
    const giveUp = (): never => {
      this.warn(
        `tombstone-blocked capture write lock remained busy after ${limits.deadlineMs}ms; failing this write so the rest of the cycle can continue`
      );
      throw new Error(CAPTURE_WRITE_LOCK_BUSY_MESSAGE);
    };
    const acquire = async (
      index: number
    ): Promise<T | typeof CAPTURE_WRITE_LOCK_RETRY | typeof CAPTURE_WRITE_LOCK_PERMANENT> => {
      if (index === lockPaths.length) return await task();
      const lockPath = lockPaths[index];
      if (lockPath === undefined) return await task();
      return await this.withSingleCaptureWriteLockOnce(lockPath, () => acquire(index + 1));
    };
    for (let attempt = 0; ; attempt += 1) {
      const outcome = await acquire(0);
      if (outcome === CAPTURE_WRITE_LOCK_PERMANENT) {
        throw new Error("tombstone-blocked capture write lock acquisition failed");
      }
      if (outcome !== CAPTURE_WRITE_LOCK_RETRY) return outcome;
      const now = this.now();
      if (now >= deadline) giveUp();
      const delay = Math.min(
        captureWriteLockDelayMs(attempt, limits, this.options.random ?? Math.random),
        deadline - now
      );
      if (delay <= 0) giveUp();
      this.debug(`tombstone-blocked capture write lock busy; backing off ${delay}ms before retry ${attempt + 1}`);
      await (this.options.sleep ?? sleep)(delay);
    }
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
  beginDurableMemoryRevision?: (
    pathname: string,
    expectedContent?: string | Buffer | null
  ) => Promise<CasRevisionTransaction | undefined>;
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
      const discardRebuildMarker = async (): Promise<void> => {
        if (!rebuildMarker) return;
        try {
          await host.discardWrite(rebuildMarker);
        } catch (cleanupError) {
          host.markUntrusted();
          host.logWarning(`storage.tombstoneBlocked failed to clear write marker: ${cleanupError}`);
        }
      };
      let transaction: CasRevisionTransaction | undefined;
      try {
        // #2813 (P1 C): a two-phase receipt transaction under this same
        // path lock. The PENDING reservation is minted BEFORE the durable
        // file publish, so a failed reservation leaves the memory file
        // untouched — never a mutated record without a receipt. The
        // COMMITTED receipt publishes only AFTER the write lands, so a
        // failed write can never leave the reservation posing as
        // ownership.
        transaction = mutation.shouldMintRevision?.(current)
          ? await host.beginDurableMemoryRevision?.(mutation.pathname, mutation.fileContent)
          : undefined;
        await host.writeStorageSecureFile(mutation.pathname, mutation.fileContent);
      } catch (err) {
        // The memory write failed (or never ran): abort the reservation so
        // no pending marker survives a write that did not land. A failed
        // abort keeps the marker — ambiguity, recovered later.
        if (transaction) {
          try {
            await transaction.abort();
          } catch (abortError) {
            host.logWarning(
              `storage.tombstoneBlocked failed to abort the reserved receipt (pending marker preserved): ${abortError}`
            );
          }
        }
        await discardRebuildMarker();
        throw err;
      }
      if (transaction) {
        // #2807: record the post-write fingerprint in the PENDING marker
        // BEFORE publishing, so a crash between the durable write and the
        // COMMITTED receipt is decisively recoverable. The evidence only
        // guards that crash window — a recording failure must not fail the
        // landed write, so commit still runs and publishes truthfully.
        try {
          await transaction.writeLanded();
        } catch (evidenceError) {
          host.logWarning(
            `storage.tombstoneBlocked failed to record receipt crash evidence (pending marker preserved): ${evidenceError}`
          );
        }
        try {
          await transaction.commit();
        } catch (err) {
          // #2813 (P1 C): the memory file LANDED but the COMMITTED receipt
          // never published. The PENDING marker stays: readers must see
          // unavailable/recovery-needed — never ownership, never absence —
          // and promotion/rollback refuse until recovery reconciles. The
          // reservation must NOT be aborted: the write is on disk.
          host.logWarning(
            `storage.tombstoneBlocked receipt publication failed after the memory write (pending marker preserved for recovery): ${err}`
          );
          await discardRebuildMarker();
          throw err;
        }
      }
      mintedRevision = transaction?.pendingRevision;
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
