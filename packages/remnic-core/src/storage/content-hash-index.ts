// Content-hash dedup index for facts, extracted from storage.ts (issue #1909 /
// PR #2016 write-hot-paths). Self-contained: cross-process locked reconcile /
// rebuild saves plus the deferred durable-retry machinery. storage.ts imports
// these back and re-exports the class + companion types that were previously
// part of its public API.
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { computeContentHash, normalizeContent } from "../content-hash.js";
import { log } from "../logger.js";
import { SecureStoreLockedError, readMaybeEncryptedFile, writeMaybeEncryptedFile } from "../secure-store/secure-fs.js";
import { isErrnoCode } from "../utils/errno.js";
import { withHeldFileLock } from "../utils/serialize-mutations.js";

/**
 * Stale threshold (ms) for the per-file advisory lock guarding a fact-hash
 * index merge-save (issue #1909 review round 7). The critical section is a
 * single read+atomic-rewrite of one index file (≤ a few MB), so a holder older
 * than this is treated as crashed. Generous to tolerate slow/encrypted disks
 * without breaking a legitimately in-progress publish.
 */
const CONTENT_HASH_INDEX_LOCK_STALE_MS = 30_000;
/** Version marker for the normalized Unicode hash index format. */
const CONTENT_HASH_INDEX_FORMAT_HEADER = "# remnic-content-hash-index:v2";

function parseHashIndex(raw: string): { versioned: boolean; hashes: Set<string> } {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines[0] !== CONTENT_HASH_INDEX_FORMAT_HEADER) {
    return { versioned: false, hashes: new Set() };
  }
  return { versioned: true, hashes: new Set(lines.slice(1)) };
}

function serializeHashIndex(hashes: Set<string>): string {
  return `${CONTENT_HASH_INDEX_FORMAT_HEADER}\n${[...hashes].join("\n")}\n`;
}

/**
 * Durable-retry policy for a deferred content-hash reconcile save whose
 * cross-process lock acquire timed out (issue #1909 / PR #2016). When the lock
 * is contended past `withHeldFileLock`'s bounded wait, the added hashes are held
 * only in this process's memory; relying on "some later batch save" is not
 * durable (the run may be the last before idle/shutdown), and a long-lived peer
 * that already built its authoritative in-memory index will not see the write.
 * So we schedule a bounded, exponentially-backed-off background retry that keeps
 * re-attempting the locked publish until it lands. Bounded because the durable
 * fact `.md` is already on disk and a process restart rebuilds the index from
 * the corpus regardless — exhausting retries degrades to that rebuild safety
 * net, never to data loss or a fatal append failure.
 */
const CONTENT_HASH_INDEX_RETRY_MAX_ATTEMPTS = 5;
/** Base backoff (ms) before the first deferred reconcile-save retry; doubles each attempt. */
const CONTENT_HASH_INDEX_RETRY_BASE_MS = 500;
/** Ceiling (ms) for the exponential reconcile-save retry backoff. */
export const CONTENT_HASH_INDEX_RETRY_MAX_DELAY_MS = 5_000;

/**
 * Tuning for {@link ContentHashIndex} cross-process lock waits and the
 * deferred reconcile-save durable retry (issue #1909 / PR #2016). All optional;
 * production uses the module defaults. Tests inject small values so the
 * lock-timeout + retry path is exercised deterministically without real
 * multi-second waits.
 */
export interface ContentHashIndexLockOptions {
  /** Bounded wait to acquire the per-file advisory lock; passed to `withHeldFileLock` (default 5000ms). */
  readonly maxWaitMs?: number;
  /** Poll interval while waiting for a busy lock (default 50ms). */
  readonly pollMs?: number;
  /** Base backoff before the first deferred-save retry (default 500ms). */
  readonly retryBaseMs?: number;
  /** Max deferred-save retries before falling back to the corpus-rebuild safety net (default 5). */
  readonly retryMaxAttempts?: number;
}

/**
 * Thrown when the fact-hash index cannot be made authoritative — the
 * cross-process rebuild lock could not be acquired within the bounded retry
 * budget (PR #2016). Callers that require an authoritative dedup answer surface
 * this instead of silently trusting a stale loaded snapshot.
 */
export class FactHashIndexNotAuthoritativeError extends Error {
  constructor(stateDir: string) {
    super(
      `fact-hash index is not authoritative: the cross-process rebuild lock for ${stateDir} could not be acquired within the bounded retry budget`
    );
    this.name = "FactHashIndexNotAuthoritativeError";
  }
}

type DiskFingerprint = {
  mtimeMs: number;
  size: number;
  dev: number;
  ino: number;
  ctimeMs: number;
  birthtimeMs: number;
};
export interface ContentHashPathEntry {
  readonly path: string;
  readonly contentHash: string;
}

/**
 * Content-hash dedup index for facts.
 * Normalizes content (lowercase, strip punctuation, collapse whitespace),
 * computes SHA-256, and stores hashes in a line-delimited file.
 * Prevents writing semantically identical facts.
 */
export class ContentHashIndex {
  private hashes: Set<string> = new Set();
  private dirty = false;
  /** True when load() found the pre-Unicode, markerless on-disk format. */
  private formatMigrationRequired = false;
  /**
   * Hashes explicitly removed since the last successful save (issue #1909 review
   * round 8 thread 3). Tracked separately so `saveMergingWithDisk` can be
   * removal-AWARE: under the file lock it reads the latest on-disk set, DROPS
   * these, then unions our additions — so a removal batch cannot resurrect a
   * hash (union alone would) and cannot clobber a concurrent extraction's
   * appended hash (blind overwrite would). Consumed + cleared by every save.
   */
  private removed: Set<string> = new Set();
  /**
   * Hashes added by THIS instance since the last successful save (issue #1909
   * review round 9 finding 3). Tracked separately from the loaded snapshot so a
   * reconciling save publishes `(on-disk \ removed) ∪ added` — it re-applies only
   * OUR additions, never the stale loaded entries. Without this, seeding the
   * merge from `this.hashes` (loaded ∪ added) would resurrect a hash a peer
   * removed on disk while this instance held a stale snapshot.
   */
  private added: Set<string> = new Set();
  private readonly filePath: string;
  private readonly secureStoreKeyProvider: () => Buffer | null;
  private readonly secureStoreWriteKeyProvider: () => Buffer | null;
  private readonly memoryDir: string;
  private readonly lockOptions: ContentHashIndexLockOptions;
  /**
   * Deferred reconcile-save durable-retry state (issue #1909 / PR #2016). At
   * most ONE retry is ever armed (`reconcileRetryTimer` is the reentrancy guard)
   * so successive timed-out saves cannot stack duplicate/parallel retries.
   * `reconcileRetryBarrier` resolves when the chain settles (published or gave
   * up) — awaited by tests and any caller wanting the eventual result.
   */
  private reconcileRetryTimer: NodeJS.Timeout | null = null;
  private reconcileRetryAttempts = 0;
  private reconcileRetryBarrier: Promise<void> | null = null;
  private reconcileRetryResolve: (() => void) | null = null;
  /**
   * On-disk fingerprint captured at the last point THIS instance's in-memory
   * set matched disk — after `load()`, `save()`, or a reconcile publish. A peer
   * process that advances the durable index changes its file generation even
   * when byte size and mtime collide, so the freshness check remains safe
   * without an O(file-size) read on the hot path.
   */
  private lastSyncedFingerprint: DiskFingerprint | null = null;
  constructor(
    stateDir: string,
    secureStoreKeyProvider: () => Buffer | null = () => null,
    secureStoreWriteKeyProvider: () => Buffer | null = secureStoreKeyProvider,
    memoryDir: string = path.dirname(stateDir),
    lockOptions: ContentHashIndexLockOptions = {}
  ) {
    this.filePath = path.join(stateDir, "fact-hashes.txt");
    this.secureStoreKeyProvider = secureStoreKeyProvider;
    this.secureStoreWriteKeyProvider = secureStoreWriteKeyProvider;
    this.memoryDir = memoryDir;
    this.lockOptions = lockOptions;
  }
  /** Whether a caller with an authoritative corpus must rebuild this legacy index. */
  get requiresFormatMigration(): boolean {
    return this.formatMigrationRequired;
  }

  /** Load existing hashes from disk. Safe to call multiple times. */
  async load(): Promise<void> {
    try {
      const raw = await readMaybeEncryptedFile(this.filePath, this.secureStoreKeyProvider(), this.memoryDir);
      const parsed = parseHashIndex(raw);
      this.formatMigrationRequired = !parsed.versioned;
      if (!parsed.versioned) {
        // Hashes from the pre-NFC format are unsafe after normalization changes.
        // Ignore them until an authoritative corpus rebuild publishes v2.
        this.hashes.clear();
        log.warn(`content-hash index: ignored legacy unversioned index at ${this.filePath}`);
      } else {
        for (const hash of parsed.hashes) this.hashes.add(hash);
      }
      log.debug(`content-hash index: loaded ${this.hashes.size} hashes`);
    } catch (err) {
      if (err instanceof SecureStoreLockedError) throw err;
      if (!isErrnoCode(err, "ENOENT")) throw err;
      log.debug("content-hash index: no existing index — starting fresh");
    }
    // The loaded set now reflects the on-disk file — baseline the fingerprint so
    // a later peer write is detectable (PR #2016 review).
    await this.captureSyncedFingerprint();
  }

  /** Cheap `stat` of the durable index file; null when it does not exist yet. */
  private async statIndexFile(): Promise<DiskFingerprint | null> {
    try {
      const s = await stat(this.filePath);
      return {
        mtimeMs: s.mtimeMs,
        size: s.size,
        dev: s.dev,
        ino: s.ino,
        ctimeMs: s.ctimeMs,
        birthtimeMs: s.birthtimeMs,
      };
    } catch (err) {
      if (isErrnoCode(err, "ENOENT")) return null;
      throw err;
    }
  }

  /** Record the current on-disk fingerprint as this instance's synced baseline. */
  private async captureSyncedFingerprint(): Promise<void> {
    try {
      this.lastSyncedFingerprint = await this.statIndexFile();
    } catch (err) {
      // A stat failure other than ENOENT leaves no baseline; the next freshness
      // check reports non-current and the caller confirms against the corpus.
      this.lastSyncedFingerprint = null;
      log.debug(`content-hash index: could not fingerprint ${this.filePath}: ${err}`);
    }
  }

  /**
   * True when the durable index file is unchanged since this instance last
   * synced it (load / save / reconcile). False when a peer advanced it, when
   * the file appeared or vanished, or when freshness cannot be established
   * (stat error) — the caller then treats the in-memory snapshot as
   * non-authoritative and confirms a dedup miss against the durable corpus.
   * The stat includes file identity and generation metadata so same-size,
   * same-mtime atomic replacements are detected without reading the file body.
   */
  async isDiskFingerprintCurrent(): Promise<boolean> {
    let current: DiskFingerprint | null;
    try {
      current = await this.statIndexFile();
    } catch {
      return false;
    }
    const last = this.lastSyncedFingerprint;
    if (last === null || current === null) {
      return last === null && current === null;
    }
    return (
      current.mtimeMs === last.mtimeMs &&
      current.size === last.size &&
      current.dev === last.dev &&
      current.ino === last.ino &&
      current.ctimeMs === last.ctimeMs &&
      current.birthtimeMs === last.birthtimeMs
    );
  }

  /** Check if content already exists in the index. */
  has(content: string): boolean {
    return this.hashes.has(ContentHashIndex.computeHash(content));
  }

  /** Add content hash to the index. */
  add(content: string): void {
    const hash = ContentHashIndex.computeHash(content);
    // A re-add supersedes a pending removal of the same hash (round 8 thread 3).
    this.removed.delete(hash);
    // Record OUR durable delta even when the local snapshot already holds the
    // hash (PR #2016 thread SD-nG): local membership can be STALE — a peer
    // removed this hash on disk while this instance kept it in memory. Skipping
    // `added`/`dirty` on that path let the reconciling save compute
    // (on-disk \ removed) ∪ added and silently drop the reintroduced hash, so
    // the peer never saw it again. Set semantics keep this idempotent (no
    // duplicate entries) and the `removed.delete` above preserves remove/add
    // ordering.
    this.hashes.add(hash);
    this.added.add(hash);
    this.dirty = true;
  }

  get size(): number {
    return this.hashes.size;
  }

  /** Clear all loaded hashes so the next save rewrites the index from scratch. */
  clear(): void {
    if (this.hashes.size > 0) {
      this.hashes.clear();
    }
    // A full clear is always paired with a plain overwrite save() (rebuild);
    // pending per-hash add/remove deltas are subsumed by writing the rebuilt set.
    // Cancel any armed deferred-reconcile retry (PR #2016) so it cannot fire in
    // the clear→rebuild→save window and union the pre-clear on-disk rows back.
    this.added.clear();
    this.removed.clear();
    this.cancelReconcileRetry();
    this.dirty = true;
  }

  /** Persist index to disk if changed (plain whole-file overwrite). */
  async save(): Promise<void> {
    if (!this.dirty) return;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    // Snapshot the deltas + overwrite body THIS save publishes BEFORE the write
    // yields the event loop. `writeMaybeEncryptedFile` materializes `serialized`
    // eagerly, then the disk await lets a concurrent same-process add()/remove()
    // land a late delta (PR #2016 thread PRRT_kwDORJXyws6SEBri). Clearing the
    // LIVE added/removed sets afterward — as the previous unconditional
    // clear()+`dirty = false` did — would drop that late hash from the index AND
    // leave no retry, so peers never see it until a corpus rebuild. Consume only
    // what we published; late deltas stay pending. Mirrors saveMergingWithDisk.
    const publishedAdded = new Set<string>(this.added);
    const publishedRemoved = new Set<string>(this.removed);
    const serialized = serializeHashIndex(this.hashes);
    await writeMaybeEncryptedFile(this.filePath, serialized, this.secureStoreWriteKeyProvider(), {}, this.memoryDir);
    this.formatMigrationRequired = false;
    // Consume ONLY the deltas this overwrite published; anything that arrived
    // during the awaits above remains pending for the next save.
    for (const h of publishedAdded) this.added.delete(h);
    for (const h of publishedRemoved) this.removed.delete(h);
    // Honest dirty state: true iff late deltas remain unpersisted.
    this.dirty = this.added.size > 0 || this.removed.size > 0;
    // This overwrite is now the on-disk state — re-baseline the freshness
    // fingerprint so our own write is not later mistaken for a peer's (PR #2016).
    await this.captureSyncedFingerprint();
    if (this.dirty) {
      // Late deltas landed mid-save: arm a bounded durable retry so they reach
      // disk even without a further batch save — never a silent in-memory-only
      // hash. The locked reconcile republishes only OUR delta onto the overwrite.
      this.scheduleReconcileRetry();
    } else {
      // Clean overwrite supersedes any pending deferred reconcile work.
      this.cancelReconcileRetry();
    }
    log.debug(`content-hash index: saved ${this.hashes.size} hashes`);
  }

  /**
   * Persist the index by RECONCILING with the latest on-disk state under a
   * cross-process lock (issue #1909). Used by the extraction-persist batch save
   * for BOTH append and removal batches, so appends and removals to the same
   * index serialize against each other:
   *   final = (on-disk \ this.removed) ∪ this.added
   * Note it re-applies only OUR local additions (`added`), NOT the loaded
   * snapshot (review round 9 finding 3): seeding from `this.hashes` would
   * resurrect a hash a peer removed on disk while we held a stale snapshot. This
   * preserves a concurrent writer's appended hashes (a blind overwrite would
   * drop them), never resurrects a removed hash, and never loses our additions.
   *
   * Hardening:
   *  - Dirty short-circuit (round 7 finding 3): when this instance neither added
   *    nor removed anything this run, skip the O(file) read+rewrite entirely.
   *  - Cross-process lock (round 7 finding 2): serialize the read→reconcile→write
   *    window on a per-file advisory lock. If the lock is NOT acquired (timeout),
   *    do NOT publish (round 9 finding 2): keep `dirty` set AND schedule a bounded
   *    durable background retry (PR #2016) that keeps re-attempting the locked
   *    publish until the deferred additions land — never an unlocked write that
   *    could clobber a peer, and never a silent "batch save complete" that leaves
   *    the addition in this process's memory only.
   */
  async saveMergingWithDisk(): Promise<void> {
    if (!this.dirty) return;
    // The advisory lock file lives beside the index — ensure the dir exists
    // before acquiring it (the index dir may not exist on a first write).
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const publish = async (): Promise<void> => {
      // Snapshot the deltas this publish is responsible for. The read+rewrite
      // below yields the event loop, so a concurrent add()/remove() can land
      // new deltas while we await disk (PR #2016 thread SD7Tj). Consuming the
      // LIVE sets afterward would drop those late deltas AND clear `dirty`,
      // stranding them in no save at all. We consume only what we published;
      // anything that arrived meanwhile stays pending for the next save.
      const publishedAdded = new Set<string>(this.added);
      const publishedRemoved = new Set<string>(this.removed);
      const merged = new Set<string>(publishedAdded);
      try {
        const raw = await readMaybeEncryptedFile(this.filePath, this.secureStoreKeyProvider(), this.memoryDir);
        const parsed = parseHashIndex(raw);
        if (parsed.versioned) {
          for (const hash of parsed.hashes) {
            // Keep prior/concurrent on-disk hashes EXCEPT the ones we removed.
            if (!publishedRemoved.has(hash)) merged.add(hash);
          }
        } else {
          // Do not carry hashes from the pre-NFC format into a v2 write.
          log.warn(`content-hash index: discarded legacy unversioned entries from ${this.filePath}`);
        }
      } catch (err) {
        if (err instanceof SecureStoreLockedError) throw err;
        if (!isErrnoCode(err, "ENOENT")) throw err;
        // ENOENT → no on-disk index yet; write our additions as-is.
      }
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeMaybeEncryptedFile(
        this.filePath,
        serializeHashIndex(merged),
        this.secureStoreWriteKeyProvider(),
        {},
        this.memoryDir
      );
      this.formatMigrationRequired = false;
      // Consume ONLY the deltas we just published; deltas that arrived during
      // the awaits above remain pending.
      for (const h of publishedAdded) this.added.delete(h);
      for (const h of publishedRemoved) this.removed.delete(h);
      // Fold any still-pending deltas onto the reconciled set so the in-memory
      // view stays consistent with what the next save will publish.
      for (const h of this.added) merged.add(h);
      for (const h of this.removed) merged.delete(h);
      this.hashes = merged;
      // Honest dirty state: true iff late deltas remain to be persisted. A
      // subsequent batch save or the shutdown flush drains them.
      this.dirty = this.added.size > 0 || this.removed.size > 0;
      // The reconciled set is now the on-disk state — re-baseline the freshness
      // fingerprint (captured under the held lock) so our own publish is not
      // later mistaken for a peer's advance (PR #2016 review).
      await this.captureSyncedFingerprint();
    };
    await withHeldFileLock(
      `${this.filePath}.lock`,
      {
        staleMs: CONTENT_HASH_INDEX_LOCK_STALE_MS,
        ...(this.lockOptions.maxWaitMs !== undefined ? { maxWaitMs: this.lockOptions.maxWaitMs } : {}),
        ...(this.lockOptions.pollMs !== undefined ? { pollMs: this.lockOptions.pollMs } : {}),
      },
      async (acquired) => {
        if (!acquired) {
          // Never publish unlocked (round 9 finding 2): keep dirty AND schedule a
          // durable background retry (PR #2016). Relying on an unguaranteed later
          // batch save silently left the addition in this process's memory only;
          // the retry keeps re-attempting the locked publish until the addition
          // lands on disk.
          log.warn(
            `content-hash index: lock not acquired for ${this.filePath}; deferring reconcile save (dirty retained, scheduling durable retry)`
          );
          this.scheduleReconcileRetry();
          return;
        }
        await publish();
        if (this.dirty) {
          // A concurrent add()/remove() landed during publish's disk awaits, so
          // deltas remain unpersisted (PR #2016 thread SD7Tj). Arm a bounded
          // durable retry so they reach disk even if no further batch save comes
          // — never leave a settled barrier over pending work.
          this.scheduleReconcileRetry();
        } else {
          // Published cleanly: any pending deferred retry is now satisfied.
          this.cancelReconcileRetry();
        }
      }
    );
    log.debug(`content-hash index: reconcile-saved ${this.hashes.size} hashes`);
  }

  /**
   * Rebuild-and-publish the index from an authoritative source (the durable
   * corpus) under the SAME per-file cross-process lock the reconciling
   * append/removal saves (`saveMergingWithDisk`) use (issue #1909 / PR #2016).
   * The `populate` callback runs WHILE the lock is held and MUST repopulate this
   * index from the corpus (`clear()` then `addByHash(...)` for every corpus
   * hash); the rebuilt set is then published with a plain overwrite that is now
   * serialized against every locked writer.
   *
   * This closes the finding where the previous unlocked clear→scan→save() could
   * overwrite a peer's newer lock-merged or deferred additions: a locked writer
   * that committed BEFORE the rebuild acquired the lock has its memory `.md` on
   * disk and is re-scanned; one that commits AFTER the rebuild releases
   * reconciles its additions on top of the freshly-published set. No union with
   * the raw on-disk file is performed, so the rebuild keeps its
   * garbage-collection property (orphaned hashes for deleted memories drop).
   *
   * Lock-acquisition failure is explicit and non-destructive: `populate` is NOT
   * run and nothing is written (never an unlocked overwrite). Returns true when
   * the rebuild was published under the lock, false when the lock timed out —
   * the caller keeps the index non-authoritative and retries on next use. Uses
   * the same non-reentrant file lock as the reconcile path, so it can never
   * deadlock with the deferred reconcile-retry: a concurrent locked writer (or a
   * fired retry) simply yields `acquired=false` after the bounded wait.
   */
  async rebuildUnderLock(populate: () => Promise<void>): Promise<boolean> {
    // The advisory lock file lives beside the index — ensure the dir exists
    // before acquiring it (the index dir may not exist on a first rebuild).
    await mkdir(path.dirname(this.filePath), { recursive: true });
    let published = false;
    await withHeldFileLock(
      `${this.filePath}.lock`,
      {
        staleMs: CONTENT_HASH_INDEX_LOCK_STALE_MS,
        ...(this.lockOptions.maxWaitMs !== undefined ? { maxWaitMs: this.lockOptions.maxWaitMs } : {}),
        ...(this.lockOptions.pollMs !== undefined ? { pollMs: this.lockOptions.pollMs } : {}),
      },
      async (acquired) => {
        if (!acquired) {
          // Never publish unlocked: a concurrent locked writer holds the lock,
          // so overwriting now could clobber its addition. Leave the index as-is
          // and let the caller retry the authoritative rebuild on next use.
          log.warn(
            `content-hash index: lock not acquired for ${this.filePath}; deferring authoritative rebuild (index left non-authoritative, retried on next use)`
          );
          return;
        }
        await populate();
        // Publish under the held lock. save() takes no lock (no re-entrancy) and
        // is a full overwrite that supersedes any pending add/remove deltas.
        await this.save();
        published = true;
      }
    );
    return published;
  }

  /**
   * True while a background durable reconcile-save retry is armed (PR #2016).
   * Test/introspection hook.
   */
  get hasPendingReconcileRetry(): boolean {
    return this.reconcileRetryTimer !== null;
  }

  /** True while this index has in-memory changes not yet published to disk. */
  get hasPendingChanges(): boolean {
    return this.dirty;
  }

  /**
   * Resolve once any armed background reconcile-save retry chain has settled —
   * either it published the deferred additions, or it exhausted its bounded
   * attempts and fell back to the corpus-rebuild safety net. Resolves
   * immediately when nothing is armed. Lets a caller (or a test) await the
   * eventual durability outcome of a lock-timed-out save.
   */
  async whenReconcileRetrySettled(): Promise<void> {
    await (this.reconcileRetryBarrier ?? Promise.resolve());
  }

  /**
   * Drive any deferred lock-timeout reconcile save to completion INLINE at a
   * lifecycle boundary (PR #2016 finding 3). The background retry timer is
   * `unref`'d so it never keeps a long-lived daemon alive — but a short-lived
   * writer (a one-shot CLI) can exit before it fires, leaving a durable fact
   * `.md` whose hash never reached `fact-hashes.txt` for peers that already
   * built their in-memory index. `orchestrator.destroy()` calls this so the
   * addition publishes before the process exits; long-lived hosts only reach it
   * at their own shutdown, so their in-flight retries keep running in the
   * background until then. Bounded by the same attempt ceiling as the background
   * retry; a permanently contended lock falls back to the corpus-rebuild-on-
   * restart safety net (the fact `.md` is already durable). No deadlock: each
   * attempt is the same non-reentrant, bounded-wait file lock.
   */
  async flushReconcileRetry(): Promise<void> {
    if (!this.dirty) return;
    const maxAttempts = this.lockOptions.retryMaxAttempts ?? CONTENT_HASH_INDEX_RETRY_MAX_ATTEMPTS;
    const baseMs = this.lockOptions.retryBaseMs ?? CONTENT_HASH_INDEX_RETRY_BASE_MS;
    for (let attempt = 0; this.dirty && attempt < maxAttempts; attempt += 1) {
      // Cancel the unref'd background timer — we drive the locked publish inline.
      if (this.reconcileRetryTimer) {
        clearTimeout(this.reconcileRetryTimer);
        this.reconcileRetryTimer = null;
      }
      await this.saveMergingWithDisk();
      if (!this.dirty) break;
      if (attempt < maxAttempts - 1) {
        const wait = Math.min(baseMs * 2 ** attempt, CONTENT_HASH_INDEX_RETRY_MAX_DELAY_MS);
        await new Promise<void>((resolve) => setTimeout(resolve, wait));
      }
    }
    // Clear any timer the final saveMergingWithDisk armed and settle the barrier
    // so awaiters unblock — the bounded inline drain has done its best.
    if (this.reconcileRetryTimer) {
      clearTimeout(this.reconcileRetryTimer);
      this.reconcileRetryTimer = null;
    }
    this.reconcileRetryAttempts = 0;
    this.settleReconcileRetry();
  }

  /**
   * Schedule ONE bounded, exponentially-backed-off background retry of the
   * deferred reconcile save (PR #2016). Reentrant-safe: an already-armed timer
   * short-circuits, so successive timed-out saves never stack duplicate retries.
   * When attempts are exhausted the chain settles without publishing — the
   * durable fact `.md` is on disk and a process restart rebuilds the index from
   * the corpus, so this degrades to that safety net, never a fatal failure.
   */
  private scheduleReconcileRetry(): void {
    if (this.reconcileRetryTimer) return; // one retry in flight — no duplicate/reentrant retries
    const maxAttempts = this.lockOptions.retryMaxAttempts ?? CONTENT_HASH_INDEX_RETRY_MAX_ATTEMPTS;
    if (this.reconcileRetryAttempts >= maxAttempts) {
      log.warn(
        `content-hash index: exhausted ${maxAttempts} deferred reconcile-save retries for ${this.filePath}; ` +
          `${this.added.size} addition(s) remain dirty in-memory (a process restart rebuilds the index from the durable corpus)`
      );
      this.reconcileRetryAttempts = 0;
      this.settleReconcileRetry();
      return;
    }
    if (!this.reconcileRetryBarrier) {
      this.reconcileRetryBarrier = new Promise<void>((resolve) => {
        this.reconcileRetryResolve = resolve;
      });
    }
    const attempt = this.reconcileRetryAttempts + 1;
    const baseMs = this.lockOptions.retryBaseMs ?? CONTENT_HASH_INDEX_RETRY_BASE_MS;
    const delay = Math.min(baseMs * 2 ** (attempt - 1), CONTENT_HASH_INDEX_RETRY_MAX_DELAY_MS);
    this.reconcileRetryTimer = setTimeout(() => {
      this.reconcileRetryTimer = null;
      this.reconcileRetryAttempts = attempt;
      void this.saveMergingWithDisk()
        .catch((err) => {
          // A publish-time I/O/encryption error (not a lock timeout) is best-effort:
          // log and let the corpus-rebuild safety net cover it rather than loop.
          log.warn(`content-hash index: deferred reconcile-save retry failed for ${this.filePath}: ${err}`);
        })
        .finally(() => {
          // If the attempt neither published (dirty cleared → cancelReconcileRetry)
          // nor re-armed a further retry, the chain has ended — settle the barrier.
          if (this.dirty && !this.reconcileRetryTimer) this.settleReconcileRetry();
        });
    }, delay);
    this.reconcileRetryTimer.unref?.();
  }

  /** Cancel any armed reconcile-save retry and settle the barrier (a publish landed). */
  private cancelReconcileRetry(): void {
    if (this.reconcileRetryTimer) {
      clearTimeout(this.reconcileRetryTimer);
      this.reconcileRetryTimer = null;
    }
    this.reconcileRetryAttempts = 0;
    this.settleReconcileRetry();
  }

  /** Resolve and clear the retry barrier if one is outstanding. */
  private settleReconcileRetry(): void {
    const resolve = this.reconcileRetryResolve;
    this.reconcileRetryBarrier = null;
    this.reconcileRetryResolve = null;
    resolve?.();
  }

  /** Remove a hash from the index (used when archiving/deleting). */
  remove(content: string): void {
    const hash = ContentHashIndex.computeHash(content);
    // Record the removal (round 8 thread 3) even when the hash is not in our
    // in-memory set — a reconciling save must still drop it from the latest
    // on-disk state. A removal supersedes a pending add. Always mark dirty.
    this.added.delete(hash);
    this.removed.add(hash);
    this.hashes.delete(hash);
    this.dirty = true;
  }

  /**
   * Remove a pre-computed SHA-256 hash directly from the index without
   * re-hashing.  Use this when the caller already holds the stored hash
   * (e.g. `memory.frontmatter.contentHash`) to avoid the double-hash bug
   * where `remove(hash)` would compute `hash(hash)` and never match the
   * entry.
   */
  removeByHash(hash: string): void {
    this.added.delete(hash);
    this.removed.add(hash);
    this.hashes.delete(hash);
    this.dirty = true;
  }

  /**
   * Add a pre-computed SHA-256 hash directly to the index without re-hashing.
   * Use this when the caller already holds the stored hash
   * (e.g. `memory.frontmatter.contentHash`) so that the index records the raw
   * content hash rather than re-hashing the citation-annotated body.
   *
   * @internal Only called from `StorageManager.ensureFactHashIndexAuthoritative`.
   * Not part of the public API — prefer `add(content)` for external callers.
   */
  addByHash(hash: string): void {
    // A re-add supersedes a pending removal of the same hash.
    this.removed.delete(hash);
    // Record OUR durable delta even when the local snapshot already holds the
    // hash (PR #2016 thread PRRT_kwDORJXyws6SEHve). Outside a rebuild
    // (StorageManager.addActiveFactContentHash on reactivation) local
    // membership can be STALE: a peer removed this hash on disk while this
    // instance kept it in memory. Skipping added/dirty on that path let the
    // reconciling save compute (on-disk \ removed) ∪ added and silently drop
    // the reintroduced hash, so the peer never saw it again. Set semantics keep
    // this idempotent (no duplicate entries) and the removed.delete above
    // preserves remove/add ordering. Mirrors add().
    this.hashes.add(hash);
    this.added.add(hash);
    this.dirty = true;
  }

  /**
   * Resolve a pre-computed semantic hash to one deterministic corpus path.
   *
   * This lookup is separate from durable hash membership: `this.hashes` stays
   * one hash per line and `has(content)` keeps its existing raw-content contract.
   * Reconciliation supplies short-lived manifest rows where hash and path coexist.
   */
  static resolvePathByHash(hash: string, entries: Iterable<ContentHashPathEntry>): string | undefined {
    const canonicalHash = hash.toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(canonicalHash)) return undefined;
    let canonicalPath: string | undefined;
    for (const entry of entries) {
      if (entry.contentHash.toLowerCase() !== canonicalHash || entry.path.length === 0) continue;
      if (canonicalPath === undefined || entry.path < canonicalPath) canonicalPath = entry.path;
    }
    return canonicalPath;
  }

  /** Normalize content (delegates to content-hash.ts for a single source of truth). */
  static normalizeContent(content: string): string {
    return normalizeContent(content);
  }

  /** Compute SHA-256 hash (delegates to content-hash.ts for a single source of truth). */
  static computeHash(content: string): string {
    return computeContentHash(content);
  }
}
