import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";

import { writeFileAtomically } from "@remnic/core/maintenance/atomic-file";
import { withHeldFileLock } from "@remnic/core/utils/serialize-mutations";

import { RemnicHttpError, RemnicRequestTimeoutError, isTransientNetworkError } from "./client.js";
import type { ObserveMessage } from "./client.js";
import { boundedReplayMessages } from "./messages.js";

/**
 * Durable local queue for observe batches that the daemon could not accept:
 * capacity backpressure (atomic 503) or ambiguous failures (timeout, dropped
 * connection) where the request MAY have been processed. Entries are replayed
 * under a stable replay-nonce idempotency key (see client.observe), so a
 * replay after response loss is deduplicated server-side instead of ingesting
 * twice. Storage is JSONL rewritten atomically (unique temp file + rename) on
 * every mutation. Every pi process on a machine shares one default path, so each
 * mutation takes a file lock, re-reads the file and applies its change to what is
 * on disk (never to a stale in-memory copy); a torn or corrupt line is skipped on
 * load with a visible notification rather than silently discarding the rest.
 */

export type ObserveOutboxEntryInput = {
  sessionKey: string;
  cwd: string;
  messages: ObserveMessage[];
  /** Per-message dedupe keys parallel to `messages` (null where un-hashable). */
  messageHashes: Array<string | null>;
  /** Replay identity of the original attempt; every replay reuses it so keys and bodies match. */
  replayNonce?: string;
  /**
   * Writer identity captured at enqueue. The default outbox file is shared by
   * every pi process on a machine, so a DIFFERENT pane may drain the entry;
   * replaying under the drainer's principal would stamp the wrong owner on
   * the turn (#3461 review). Absent on entries written before this field
   * existed — those replay under the drainer's principal, same as today.
   */
  principal?: string;
  /**
   * The daemon URL this capture was enqueued for (#3381): the outbox file is
   * shared per machine, so a pane repointed at a second daemon must not replay
   * another destination's conversations to it. Absent on pre-field entries —
   * those replay under any destination, same as today.
   */
  destination?: string;
};

export type ObserveOutboxEntry = ObserveOutboxEntryInput & {
  id: string;
  queuedAt: string;
  /**
   * Failed delivery attempts, persisted so a deterministic retry-ambiguous
   * failure still leaves the FIFO once it crosses MAX_ENTRY_FAILURES (#3381).
   */
  failedAttempts?: number;
};

export type OutboxNotify = (message: string, level: "info" | "warning" | "error") => void;

/**
 * retry-capacity: the daemon asked us to come back (503 backpressure, 429 rate limit,
 *   408/502/504 transient gateway). retry-ambiguous: the request may have been
 *   processed. blocked: credentials rejected (401/403); no retry helps until the
 *   token is fixed, so keep the whole queue. permanent: a semantic rejection.
 */
export type ObserveFailureClass = "retry-capacity" | "retry-ambiguous" | "blocked" | "permanent";

const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 502, 503, 504]);
const AUTH_HTTP_STATUSES = new Set([401, 403]);

export function classifyObserveFailure(err: Error): ObserveFailureClass {
  if (err instanceof RemnicHttpError) {
    // 503 is server backpressure (capacity admission or not-ready) and 429 a write
    // quota (observe counts against it); the capture was never executed, so a keyed
    // retry is safe. 401/403 park the queue. Any other HTTP answer is a semantic
    // rejection (bad payload, storage-target 400) that no retry can fix — except
    // an unrecognized 5xx, which is far more often a transient internal_error
    // than a verdict on the payload (#3381): it is retry-ambiguous, and the
    // per-entry failure cap is what keeps a deterministic 5xx from pinning the FIFO.
    if (RETRYABLE_HTTP_STATUSES.has(err.status)) return "retry-capacity";
    if (AUTH_HTTP_STATUSES.has(err.status)) return "blocked";
    if (err.status >= 500) return "retry-ambiguous";
    return "permanent";
  }
  if (err instanceof RemnicRequestTimeoutError) return "retry-ambiguous";
  if (isTransientNetworkError(err)) return "retry-ambiguous";
  // Unknown failure shapes are treated as ambiguous: the request may have been
  // processed, and the stable idempotency key makes a bounded retry safe.
  return "retry-ambiguous";
}

export type DrainOptions = {
  /** Total send attempts per drain across all entries (default 4). */
  maxAttempts?: number;
  /** No-header backoff base, doubled per attempt (default 500ms). */
  backoffBaseMs?: number;
  /** Upper bound applied to Retry-After hints and computed backoff (default 30s). */
  maxRetryAfterMs?: number;
  /** Fraction of delay jittered ±(default 0.2). */
  jitterRatio?: number;
  sleep?: (ms: number) => Promise<void>;
  notify?: OutboxNotify;
  /** Clock seam for the stale-replay warning (default Date.now). */
  now?: () => number;
  /**
   * Only entries enqueued for this daemon URL are delivered; entries bound to
   * another destination stay queued for their own drainer (#3381). Absent:
   * every entry is eligible, same as before the field existed.
   */
  destination?: string;
};

/** The daemon remembers observe idempotency keys for about this long (512-entry record). */
const SERVER_IDEMPOTENCY_WINDOW_MS = 15 * 60_000;

/**
 * Whether a drain on `destination` would deliver `entry`. An omitted caller
 * destination makes every entry eligible (the DrainOptions contract); an
 * unbound (pre-field) entry runs on any drainer; a bound entry only on its own.
 * Shared by drain selection, the foreign count and live-capture suppression so
 * all three agree on which captures a destination covers (#3381, #3504).
 */
function entryEligibleForDestination(entry: ObserveOutboxEntry, destination: string | undefined): boolean {
  return destination === undefined || entry.destination === undefined || entry.destination === destination;
}

export type OutboxStatus = {
  pending: number;
  /** Captures parked in the durable spill file; omitted when the file cannot be read. */
  spilled?: number;
  /** Age of the oldest queued entry, or null when empty. */
  oldestAgeMs: number | null;
  queued: number;
  retried: number;
  delivered: number;
  dropped: number;
};

export type DrainResult = {
  delivered: number;
  dropped: number;
  pending: number;
  /** Queued entries bound to another daemon destination; never sent here, so they must not count as saturation. */
  foreign?: number;
  /** True when this call did nothing because another drain on this instance was already running. */
  skipped?: boolean;
};

const DEFAULT_MAX_ENTRIES = 200;
/**
 * Entries evicted from the hot queue are parked in `<file>.spill` (same lock,
 * same durability) instead of being lost, and refill the queue as it drains
 * (#3520). The spill is bounded too — only captures pushed past the disk bound
 * actually drop, with a loud counted notice.
 */
const DEFAULT_MAX_SPILL_ENTRIES = 5_000;
const DEFAULT_MAX_ATTEMPTS = 4;
/** Failed deliveries after which a retry-ambiguous entry is dropped so a deterministic failure cannot pin the FIFO (#3381). */
const MAX_ENTRY_FAILURES = 8;
const DEFAULT_BACKOFF_BASE_MS = 500;
const DEFAULT_MAX_RETRY_AFTER_MS = 30_000;
const DEFAULT_JITTER_RATIO = 0.2;

function parseOutboxEntry(line: string): ObserveOutboxEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || Array.isArray(parsed)) return null;
  // SAFETY: JSON.parse produced a non-null, non-array value; this class is the
  // only writer of the outbox file, and the checks below reject every shape it
  // cannot re-serialize and replay (messages/messageHashes arrays, identity
  // fields present). Anything else is treated as a corrupt line and skipped.
  const entry = parsed as ObserveOutboxEntry;
  if (!Array.isArray(entry.messages) || !Array.isArray(entry.messageHashes)) return null;
  if (!entry.id || !entry.sessionKey || !entry.cwd) return null;
  // Entries from before the nonce existed replay under a nonce derived from their
  // persisted id: stable across restarts, never shared with another entry.
  entry.replayNonce = String(entry.replayNonce || entry.id);
  return entry;
}

/** Never equal to a real ino:size:mtime signature, so an unreadable file is retried on the next refresh. */
const UNREADABLE_SIGNATURE = "unreadable";
const LOCK_STALE_MS = 30_000;
const LOCK_MAX_WAIT_MS = 5_000;

export class ObserveOutbox {
  readonly filePath: string;
  private readonly lockPath: string;
  private readonly spillPath: string;
  private readonly maxEntries: number;
  private readonly maxSpillEntries: number;
  private readonly lockMaxWaitMs: number;
  private entries: ObserveOutboxEntry[] = [];
  /** ino:size:mtime of the file as last read or written by this instance. */
  private diskSignature: string | null = null;
  /** ino:size:mtime of the spill file at the last count this instance took. */
  private spillSignature: string | null = null;
  private spillCount: number | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private drainInProgress = false;
  private counters = { queued: 0, retried: 0, delivered: 0, dropped: 0 };

  constructor(
    filePath: string,
    options: { maxEntries?: number; maxSpillEntries?: number; lockMaxWaitMs?: number } = {}
  ) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this.spillPath = `${filePath}.spill`;
    this.lockMaxWaitMs = options.lockMaxWaitMs ?? LOCK_MAX_WAIT_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxSpillEntries = options.maxSpillEntries ?? DEFAULT_MAX_SPILL_ENTRIES;
  }

  private async signature(): Promise<string | null> {
    const info = await stat(this.filePath).catch(() => null);
    return info ? `${info.ino}:${info.size}:${info.mtimeMs}` : null;
  }

  /** Read-only callers keep the last known entries when the file cannot be read. */
  private async refreshOrKeepLastKnown(notify?: OutboxNotify): Promise<void> {
    try {
      await this.refresh(notify);
    } catch {
      // Unreadable file: stay on the last known view; mutations still fail closed.
    }
  }

  /** Re-read the shared file when another process (or this one) changed it. */
  private async refresh(notify?: OutboxNotify, force = false): Promise<void> {
    const signature = await this.signature();
    if (!force && signature === this.diskSignature) return;
    if (signature === null) {
      // No file: an empty queue.
      this.diskSignature = null;
      this.entries = [];
      return;
    }
    // Recorded before the read: a write that lands mid-read changes the signature,
    // so the next refresh sees it and re-reads.
    this.diskSignature = signature;
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (err) {
      // An existing but unreadable file is NOT an empty queue: the next write would replace it
      // and drop every queued capture. Keep the last known entries, force a re-read next time,
      // and let the caller decide (writes fail closed, read-only views keep what they knew).
      this.diskSignature = UNREADABLE_SIGNATURE;
      throw err;
    }
    this.entries = [];
    let skipped = 0;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const entry = parseOutboxEntry(trimmed);
      if (entry) this.entries.push(entry);
      else skipped += 1;
    }
    if (skipped > 0) {
      notify?.(
        `Remnic observe outbox: skipped ${skipped} unreadable line(s) in ${path.basename(this.filePath)}; the remaining entries were preserved`,
        "warning"
      );
    }
  }

  private async persist(): Promise<void> {
    const data = this.entries.map((entry) => JSON.stringify(entry)).join("\n");
    // Atomic replace with fsync of the temp file and the directory, so an OS crash or
    // power loss cannot commit the rename ahead of the data and leave a short queue.
    // Entries carry raw tool output, so the queue file is owner-only (#3381); the
    // temp file is created 0600 and the rename keeps that mode on every rewrite.
    await writeFileAtomically(this.filePath, data ? `${data}\n` : "", undefined, 0o600);
  }

  private async spillSig(): Promise<string | null> {
    const info = await stat(this.spillPath).catch(() => null);
    return info ? `${info.ino}:${info.size}:${info.mtimeMs}` : null;
  }

  /**
   * Parse the spill file: the parked captures and how many corrupt lines were
   * skipped. Null when no spill exists. A present-but-unreadable file throws —
   * the next append or refill would otherwise write over captures it cannot see,
   * the same fail-closed rule as the queue file itself.
   */
  private async readSpill(): Promise<{ entries: ObserveOutboxEntry[]; skipped: number } | null> {
    let raw: string;
    try {
      raw = await readFile(this.spillPath, "utf8");
    } catch (err) {
      // SAFETY: readFile rejects with a Node system error carrying `.code`;
      // ENOENT is the only absence treated as an empty spill.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const entries: ObserveOutboxEntry[] = [];
    let skipped = 0;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const entry = parseOutboxEntry(trimmed);
      if (entry) entries.push(entry);
      else skipped += 1;
    }
    return { entries, skipped };
  }

  /**
   * Parsed entries parked in the spill, signature-cached like the queue's
   * diskSignature: a matching signature means no process touched the file since
   * this instance last counted, so the cached count is authoritative. Runs
   * inside the file lock on every mutating path, so the count and the write it
   * guards cannot race another writer.
   */
  private async countSpill(): Promise<number> {
    const signature = await this.spillSig();
    if (signature === null) {
      this.spillSignature = null;
      this.spillCount = 0;
      return 0;
    }
    if (signature !== this.spillSignature || this.spillCount === null) {
      const spill = await this.readSpill();
      this.spillCount = spill?.entries.length ?? 0;
      this.spillSignature = signature;
    }
    return this.spillCount;
  }

  /** Replace the spill file atomically (0600); an empty remainder removes it. */
  private async writeSpill(entries: ObserveOutboxEntry[]): Promise<void> {
    if (entries.length === 0) {
      await unlink(this.spillPath).catch(() => undefined);
      this.spillSignature = null;
      this.spillCount = 0;
      return;
    }
    const data = entries.map((entry) => JSON.stringify(entry)).join("\n");
    await writeFileAtomically(this.spillPath, `${data}\n`, undefined, 0o600);
    this.spillSignature = await this.spillSig();
    this.spillCount = entries.length;
  }

  /**
   * Park incoming captures that cannot join the hot queue in the durable spill
   * file instead of losing them (#3520). Spill entries are always NEWER than
   * everything in the queue — arrivals spill whenever the queue is full or the
   * spill is already non-empty — so a tail refill keeps global FIFO. The append
   * happens under the same lock as every other mutation. Past maxSpillEntries
   * the incoming capture itself drops — loudly, with the count.
   */
  private async appendToSpill(overflow: ObserveOutboxEntry[], notify?: OutboxNotify): Promise<void> {
    if (overflow.length === 0) return;
    const before = await this.countSpill();
    const fits = Math.max(0, this.maxSpillEntries - before);
    const parked = overflow.slice(0, fits);
    const lost = overflow.length - parked.length;
    if (parked.length > 0) {
      const lines = parked.map((entry) => JSON.stringify(entry)).join("\n");
      await appendFile(this.spillPath, `${lines}\n`, { mode: 0o600 });
      this.spillCount = before + parked.length;
      this.spillSignature = await this.spillSig();
      notify?.(
        `Remnic observe outbox full: parked ${parked.length} incoming capture(s) in the durable spill file ${path.basename(this.spillPath)}; they replay once the older backlog drains`,
        "warning"
      );
    }
    if (lost > 0) {
      this.counters.dropped += lost;
      notify?.(
        `Remnic observe outbox spill bound exceeded: permanently dropped ${lost} incoming capture(s) to stay under the ${this.maxSpillEntries}-entry spill bound (${path.basename(this.spillPath)}); these captures are LOST`,
        "error"
      );
    }
  }

  /**
   * Pull parked captures back onto the hot queue's tail when it has room
   * (#3520). Spilled entries are the arrivals that came AFTER the queued ones,
   * so appending them preserves global FIFO. The queue file is persisted
   * BEFORE the spill is rewritten: a crash between the two writes leaves the
   * moved entries in both files (nonce-deduplicated) instead of dropping them.
   */
  private async refillFromSpill(notify?: OutboxNotify): Promise<void> {
    if (this.entries.length >= this.maxEntries) return;
    if ((await this.spillSig()) === null) return;
    await this.mutate(async () => {
      const room = this.maxEntries - this.entries.length;
      if (room <= 0) return;
      const spill = await this.readSpill();
      if (!spill || spill.entries.length === 0) {
        // A spill of only corrupt lines would otherwise linger forever: clear it
        // under the lock and say so, matching the queue file's visible skip.
        if (spill && spill.skipped > 0) {
          await this.writeSpill([]);
          notify?.(
            `Remnic observe outbox: dropped ${spill.skipped} unreadable line(s) in ${path.basename(this.spillPath)}; the spill file held no valid captures`,
            "warning"
          );
        }
        return;
      }
      const moved = spill.entries.slice(0, room);
      this.entries.push(...moved);
      await this.persist();
      await this.writeSpill(spill.entries.slice(room));
      if (spill.skipped > 0) {
        notify?.(
          `Remnic observe outbox: skipped ${spill.skipped} unreadable line(s) in ${path.basename(this.spillPath)}; the remaining spilled captures were preserved`,
          "warning"
        );
      }
    }, notify);
  }

  /**
   * Serialize in-process, then take the cross-process file lock, re-read what is on
   * disk and apply `update` to THAT before the atomic rewrite. A lock that cannot be
   * acquired fails the mutation rather than writing over another process's entries.
   */
  private mutate(update: () => void | Promise<void>, notify?: OutboxNotify): Promise<void> {
    const run = this.writeChain.then(async () => {
      // New parents are private from creation (#3381). A PRE-EXISTING directory keeps
      // its mode: observeOutboxPath may point into a shared directory, and chmod'ing it
      // would remove other users' access to every sibling (Codex P2 on #3503).
      await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      await withHeldFileLock(
        this.lockPath,
        { staleMs: LOCK_STALE_MS, maxWaitMs: this.lockMaxWaitMs },
        async (acquired) => {
          if (!acquired) throw new Error(`observe outbox is locked by another process (${this.lockPath})`);
          // The FILE needs no chmod: persist() replaces it through a 0600 temp on
          // every write, so a looser file is tightened by the write itself - and
          // an unreadable one keeps failing closed below instead of being repaired
          // into a silent empty.
          await this.refresh(notify, true);
          await update();
          await this.persist();
          this.diskSignature = await this.signature();
        },
      );
    });
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  async size(): Promise<number> {
    await this.refreshOrKeepLastKnown();
    return this.entries.length;
  }

  /**
   * Dedupe keys of everything currently queued that a drain on `destination`
   * would deliver. Entries bound to another daemon do not suppress the live
   * capture for this one — they are never delivered here (#3504 review).
   * Entries parked in the spill file are not counted: reading the whole spill
   * on every call is not worth it when the bound keeps any live duplicate of
   * a spilled capture bounded too (#3520).
   */
  async pendingHashes(destination?: string): Promise<Set<string>> {
    await this.refreshOrKeepLastKnown();
    return new Set(
      this.entries
        .filter((entry) => entryEligibleForDestination(entry, destination))
        .flatMap((entry) => entry.messageHashes.filter((hash): hash is string => hash !== null))
    );
  }

  /** Counters since process start plus the oldest queued entry age. */
  async status(now: () => number = Date.now): Promise<OutboxStatus> {
    await this.refreshOrKeepLastKnown();
    const oldest = this.entries[0] ? Date.parse(this.entries[0].queuedAt) : Number.NaN;
    const spilled = await this.countSpill().catch(() => undefined);
    const status: OutboxStatus = {
      pending: this.entries.length,
      oldestAgeMs: Number.isFinite(oldest) ? Math.max(0, now() - oldest) : null,
      ...this.counters,
    };
    if (spilled !== undefined) status.spilled = spilled;
    return status;
  }

  async enqueue(input: ObserveOutboxEntryInput, notify?: OutboxNotify): Promise<void> {
    await this.mutate(async () => {
      const id = randomUUID();
      this.counters.queued += 1;
      const entry: ObserveOutboxEntry = {
        id,
        queuedAt: new Date().toISOString(),
        ...input,
        messages: boundedReplayMessages(input.messages, notify),
        replayNonce: input.replayNonce ?? id,
      };
      // FIFO across both files: a hot queue at bound, or any parked spill,
      // means this capture is newer than the backlog — it must not jump ahead.
      if (this.entries.length >= this.maxEntries || (await this.countSpill()) > 0) {
        await this.appendToSpill([entry], notify);
      } else {
        this.entries.push(entry);
      }
    }, notify);
  }

  private async remove(id: string): Promise<void> {
    await this.mutate(() => {
      this.entries = this.entries.filter((entry) => entry.id !== id);
    });
  }

  /** Bump the entry's persisted ambiguous-failure count; 0 when another process already removed it. */
  private async recordFailure(id: string): Promise<number> {
    let attempts = 0;
    await this.mutate(() => {
      const entry = this.entries.find((e) => e.id === id);
      if (entry) {
        entry.failedAttempts = (entry.failedAttempts ?? 0) + 1;
        attempts = entry.failedAttempts;
      }
    });
    return attempts;
  }

  /**
   * Deliver queued entries strictly in order. Capacity/rate-limit/ambiguous failures
   * retry the same entry with Retry-After-aware backoff, at most `maxAttempts`
   * FAILED attempts per drain (successful sends are free), then leave the queue
   * intact for the next drain trigger. Rejected credentials (401/403) stop the drain
   * and keep the whole queue. Permanent rejections are dropped with a visible
   * notification and never retried. The file is re-read before every send, so
   * entries queued by another process meanwhile are delivered or kept, never lost.
   *
   * Two additions for the process-global file (#3520): entries that overflow the
   * hot bound are refilled from the durable spill as room appears, and a session
   * whose entry fails retryably is skipped for the rest of that drain pass — one
   * pinned session keeps its own retry budget (the passes still add up to
   * `maxAttempts`) but can no longer starve every other session behind it.
   */
  async drain(send: (entry: ObserveOutboxEntry) => Promise<void>, options: DrainOptions = {}): Promise<DrainResult> {
    const notify = options.notify;
    await this.refreshOrKeepLastKnown(notify);
    if (this.drainInProgress) {
      return { delivered: 0, dropped: 0, pending: this.entries.length, skipped: true };
    }
    this.drainInProgress = true;
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    const maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
    const requestedJitter = options.jitterRatio ?? DEFAULT_JITTER_RATIO;
    // A NaN/negative ratio would make the sleep NaN (a hot retry loop); fall back to the default.
    const jitterRatio = Number.isFinite(requestedJitter) && requestedJitter >= 0 ? requestedJitter : DEFAULT_JITTER_RATIO;
    const sleep =
      options.sleep ??
      ((ms: number) => {
        const { promise, resolve } = Promise.withResolvers<void>();
        // unref: a background drain's backoff must not keep the host process alive.
        setTimeout(resolve, ms).unref();
        return promise;
      });
    const now = options.now ?? Date.now;
    const warnedStale = new Set<string>();
    /** Sessions whose head entry already failed this pass; retried on the next pass (#3520). */
    const skippedSessions = new Set<string>();
    let delivered = 0;
    let dropped = 0;
    let failures = 0;
    // An omitted destination makes every entry eligible per the DrainOptions
    // contract; a destination-bound entry only runs on its own drainer (#3381).
    const eligible = (entry: ObserveOutboxEntry): boolean =>
      entryEligibleForDestination(entry, options.destination);
    try {
      while (failures < maxAttempts) {
        await this.refreshOrKeepLastKnown(notify);
        await this.refillFromSpill(notify);
        // Entries bound to another daemon are skipped, never sent: the file is
        // shared per machine and a pane repointed elsewhere must not replay
        // someone else's conversations to the wrong destination (#3381). An
        // entry whose session already failed this pass is skipped too, so a
        // pinned session cannot starve the others (#3520).
        const entry = this.entries.find((candidate) => eligible(candidate) && !skippedSessions.has(candidate.sessionKey));
        if (!entry) {
          // Nothing else to try this pass. If every remaining entry belongs to a
          // session that already failed, a new pass gives each of them one more
          // attempt — the per-drain budget still bounds the total.
          if (skippedSessions.size === 0) break;
          skippedSessions.clear();
          continue;
        }
        const queuedAtMs = Date.parse(entry.queuedAt);
        if (Number.isFinite(queuedAtMs) && now() - queuedAtMs > SERVER_IDEMPOTENCY_WINDOW_MS && !warnedStale.has(entry.id)) {
          warnedStale.add(entry.id);
          notify?.(
            `Remnic observe outbox: replaying a capture queued ${Math.round((now() - queuedAtMs) / 60_000)} minutes ago; the daemon only remembers its most recent 512 observe idempotency keys (roughly 15 minutes at typical load), so a duplicate is possible if the original request was already accepted`,
            "warning"
          );
        }
        try {
          await send(entry);
        } catch (err) {
          const failureClass = err instanceof Error ? classifyObserveFailure(err) : "retry-ambiguous";
          if (failureClass === "permanent") {
            dropped += 1;
            this.counters.dropped += 1;
            await this.remove(entry.id);
            const reason = err instanceof Error ? err.message : String(err);
            const status = err instanceof RemnicHttpError ? `HTTP ${err.status}: ` : "";
            notify?.(
              `Remnic observe outbox: dropped 1 capture the daemon permanently rejected (${status}${reason}; entry ${entry.id}, replay key ${entry.replayNonce ?? entry.id}); it will not be retried`,
              "warning"
            );
            continue;
          }
          if (failureClass === "blocked") {
            const status = err instanceof RemnicHttpError ? err.status : "auth";
            notify?.(
              `Remnic observe outbox: the daemon rejected the request credentials (HTTP ${status}); ${this.entries.length} queued capture(s) were kept and will replay once the token is fixed`,
              "warning"
            );
            break;
          }
          failures += 1;
          this.counters.retried += 1;
          // A retryable refusal parks this SESSION for the rest of the pass —
          // the file is process-global, so one session pinned at the daemon's
          // cap must not starve the entries queued behind it (#3520). The entry
          // stays queued and gets another attempt on the next pass.
          skippedSessions.add(entry.sessionKey);
          // Ambiguous failures accrue a persisted per-entry count: a daemon
          // that fails the same capture every time (a deterministic 500) must
          // not pin the FIFO forever, so the entry leaves the queue at the cap
          // with a visible reason (#3381). Capacity refusals are the daemon
          // asking us to come back, so they are not counted.
          if (failureClass === "retry-ambiguous") {
            const attempts = await this.recordFailure(entry.id);
            if (attempts >= MAX_ENTRY_FAILURES) {
              dropped += 1;
              this.counters.dropped += 1;
              await this.remove(entry.id);
              const status = err instanceof RemnicHttpError ? `HTTP ${err.status}: ` : "";
              notify?.(
                `Remnic observe outbox: gave up on a queued capture after ${attempts} failed attempts (${status}${err instanceof Error ? err.message : String(err)}; entry ${entry.id}, replay key ${entry.replayNonce ?? entry.id}); the daemon kept failing it, so it was dropped rather than blocking the queue`,
                "warning"
              );
              continue;
            }
          }
          if (failures >= maxAttempts) break;
          const hint = err instanceof RemnicHttpError ? err.retryAfterMs : undefined;
          const hinted = hint !== undefined && Number.isFinite(hint) ? hint : undefined;
          const base = Math.min(hinted ?? backoffBaseMs * 2 ** (failures - 1), maxRetryAfterMs);
          const jitter = 1 + (Math.random() * 2 - 1) * jitterRatio;
          // Clamp AFTER jitter so the sleep never exceeds the documented cap.
          await sleep(Math.min(maxRetryAfterMs, Math.max(0, Math.round(base * jitter))));
          continue;
        }
        await this.remove(entry.id);
        delivered += 1;
        this.counters.delivered += 1;
      }
    } finally {
      this.drainInProgress = false;
    }
    const foreign = this.entries.filter((entry) => !eligible(entry)).length;
    const summary = { delivered, dropped, pending: this.entries.length };
    return foreign > 0 ? { ...summary, foreign } : summary;
  }
}
