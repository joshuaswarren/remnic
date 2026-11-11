import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { withHeldFileLock } from "@remnic/core/utils/serialize-mutations";

import { RemnicHttpError, RemnicRequestTimeoutError, isTransientNetworkError } from "./client.js";
import type { ObserveMessage } from "./client.js";

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
};

export type ObserveOutboxEntry = ObserveOutboxEntryInput & {
  id: string;
  queuedAt: string;
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
    // rejection (bad payload, storage-target 400) that no retry can fix.
    if (RETRYABLE_HTTP_STATUSES.has(err.status)) return "retry-capacity";
    if (AUTH_HTTP_STATUSES.has(err.status)) return "blocked";
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
};

/** The daemon remembers observe idempotency keys for about this long (512-entry record). */
const SERVER_IDEMPOTENCY_WINDOW_MS = 15 * 60_000;

export type OutboxStatus = {
  pending: number;
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
};

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_ATTEMPTS = 4;
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

const LOCK_STALE_MS = 30_000;
const LOCK_MAX_WAIT_MS = 5_000;

export class ObserveOutbox {
  readonly filePath: string;
  private readonly lockPath: string;
  private readonly maxEntries: number;
  private entries: ObserveOutboxEntry[] = [];
  /** ino:size:mtime of the file as last read or written by this instance. */
  private diskSignature: string | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private drainInProgress = false;
  private counters = { queued: 0, retried: 0, delivered: 0, dropped: 0 };

  constructor(filePath: string, options: { maxEntries?: number } = {}) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  private async signature(): Promise<string | null> {
    const info = await stat(this.filePath).catch(() => null);
    return info ? `${info.ino}:${info.size}:${info.mtimeMs}` : null;
  }

  /** Re-read the shared file when another process (or this one) changed it. */
  private async refresh(notify?: OutboxNotify, force = false): Promise<void> {
    const signature = await this.signature();
    if (!force && signature === this.diskSignature) return;
    // Recorded before the read: a write that lands mid-read changes the signature,
    // so the next refresh sees it and re-reads.
    this.diskSignature = signature;
    this.entries = [];
    const raw = signature === null ? null : await readFile(this.filePath, "utf8").catch(() => null);
    if (raw === null) return;
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
    // Unique per write: two processes must never share a temp file.
    const tmp = `${this.filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await writeFile(tmp, data ? `${data}\n` : "", "utf8");
      await rename(tmp, this.filePath);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Serialize in-process, then take the cross-process file lock, re-read what is on
   * disk and apply `update` to THAT before the atomic rewrite. A lock that cannot be
   * acquired fails the mutation rather than writing over another process's entries.
   */
  private mutate(update: () => void, notify?: OutboxNotify): Promise<void> {
    const run = this.writeChain.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await withHeldFileLock(
        this.lockPath,
        { staleMs: LOCK_STALE_MS, maxWaitMs: LOCK_MAX_WAIT_MS },
        async (acquired) => {
          if (!acquired) throw new Error(`observe outbox is locked by another process (${this.lockPath})`);
          await this.refresh(notify, true);
          update();
          await this.persist();
          this.diskSignature = await this.signature();
        },
      );
    });
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  async size(): Promise<number> {
    await this.refresh();
    return this.entries.length;
  }

  /** Dedupe keys of everything currently queued (used to avoid double-delivery channels). */
  async pendingHashes(): Promise<Set<string>> {
    await this.refresh();
    return new Set(
      this.entries.flatMap((entry) => entry.messageHashes.filter((hash): hash is string => hash !== null))
    );
  }

  /** Counters since process start plus the oldest queued entry age. */
  async status(now: () => number = Date.now): Promise<OutboxStatus> {
    await this.refresh();
    const oldest = this.entries[0] ? Date.parse(this.entries[0].queuedAt) : Number.NaN;
    return {
      pending: this.entries.length,
      oldestAgeMs: Number.isFinite(oldest) ? Math.max(0, now() - oldest) : null,
      ...this.counters,
    };
  }

  async enqueue(input: ObserveOutboxEntryInput, notify?: OutboxNotify): Promise<void> {
    await this.mutate(() => {
      const id = randomUUID();
      this.counters.queued += 1;
      this.entries.push({
        id,
        queuedAt: new Date().toISOString(),
        ...input,
        replayNonce: input.replayNonce ?? id,
      });
      if (this.entries.length > this.maxEntries) {
        const evicted = this.entries.splice(0, this.entries.length - this.maxEntries).length;
        notify?.(
          `Remnic observe outbox full: dropped ${evicted} oldest queued capture(s) to stay under the ${this.maxEntries}-entry bound`,
          "warning"
        );
      }
    }, notify);
  }

  private async remove(id: string): Promise<void> {
    await this.mutate(() => {
      this.entries = this.entries.filter((entry) => entry.id !== id);
    });
  }

  /**
   * Deliver queued entries strictly in order. Capacity/rate-limit/ambiguous failures
   * retry the same entry with Retry-After-aware backoff, at most `maxAttempts`
   * FAILED attempts per drain (successful sends are free), then leave the queue
   * intact for the next drain trigger. Rejected credentials (401/403) stop the drain
   * and keep the whole queue. Permanent rejections are dropped with a visible
   * notification and never retried. The file is re-read before every send, so
   * entries queued by another process meanwhile are delivered or kept, never lost.
   */
  async drain(send: (entry: ObserveOutboxEntry) => Promise<void>, options: DrainOptions = {}): Promise<DrainResult> {
    const notify = options.notify;
    await this.refresh(notify);
    if (this.drainInProgress) {
      return { delivered: 0, dropped: 0, pending: this.entries.length };
    }
    this.drainInProgress = true;
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    const maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
    const jitterRatio = options.jitterRatio ?? DEFAULT_JITTER_RATIO;
    const sleep =
      options.sleep ??
      ((ms: number) => {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, ms);
        return promise;
      });
    const now = options.now ?? Date.now;
    const warnedStale = new Set<string>();
    let delivered = 0;
    let dropped = 0;
    let failures = 0;
    try {
      while (failures < maxAttempts) {
        await this.refresh(notify);
        const entry = this.entries[0];
        if (!entry) break;
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
            notify?.(
              `Remnic observe outbox: dropped 1 capture the daemon permanently rejected (${reason}); it will not be retried`,
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
          if (failures >= maxAttempts) break;
          const hint = err instanceof RemnicHttpError ? err.retryAfterMs : undefined;
          const hinted = hint !== undefined && Number.isFinite(hint) ? hint : undefined;
          const base = Math.min(hinted ?? backoffBaseMs * 2 ** (failures - 1), maxRetryAfterMs);
          const jitter = 1 + (Math.random() * 2 - 1) * jitterRatio;
          await sleep(Math.max(0, Math.round(base * jitter)));
          continue;
        }
        await this.remove(entry.id);
        delivered += 1;
        this.counters.delivered += 1;
      }
    } finally {
      this.drainInProgress = false;
    }
    return { delivered, dropped, pending: this.entries.length };
  }
}
