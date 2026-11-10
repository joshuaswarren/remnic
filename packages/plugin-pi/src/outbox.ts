import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { RemnicHttpError, RemnicRequestTimeoutError, isTransientNetworkError } from "./client.js";
import type { ObserveMessage } from "./client.js";

/**
 * Durable local queue for observe batches that the daemon could not accept:
 * capacity backpressure (atomic 503) or ambiguous failures (timeout, dropped
 * connection) where the request MAY have been processed. Entries are replayed
 * under a stable content-derived idempotency key (see client.observe), so a
 * replay after response loss is deduplicated server-side instead of ingesting
 * twice. Storage is JSONL rewritten atomically (temp file + rename) on every
 * mutation; a torn or corrupt line is skipped on load with a visible
 * notification rather than silently discarding the remaining entries.
 */

export type ObserveOutboxEntryInput = {
  sessionKey: string;
  cwd: string;
  messages: ObserveMessage[];
  /** Per-message dedupe keys parallel to `messages` (null where un-hashable). */
  messageHashes: Array<string | null>;
};

export type ObserveOutboxEntry = ObserveOutboxEntryInput & {
  id: string;
  queuedAt: string;
};

export type OutboxNotify = (message: string, level: "info" | "warning" | "error") => void;

export type ObserveFailureClass = "retry-capacity" | "retry-ambiguous" | "permanent";

export function classifyObserveFailure(err: Error): ObserveFailureClass {
  if (err instanceof RemnicHttpError) {
    // 503 is server backpressure (capacity admission or not-ready); the body
    // was refused atomically, so a keyed retry is safe. Any other HTTP answer
    // is a semantic rejection (bad payload, auth, storage-target 400) that no
    // retry can fix.
    return err.status === 503 ? "retry-capacity" : "permanent";
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
  return entry;
}

export class ObserveOutbox {
  readonly filePath: string;
  private readonly maxEntries: number;
  private entries: ObserveOutboxEntry[] = [];
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();
  private drainInProgress = false;

  constructor(filePath: string, options: { maxEntries?: number } = {}) {
    this.filePath = filePath;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  private async load(notify?: OutboxNotify): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const raw = await readFile(this.filePath, "utf8").catch(() => null);
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
    if (this.entries.length > this.maxEntries) {
      const evicted = this.entries.splice(0, this.entries.length - this.maxEntries).length;
      notify?.(
        `Remnic observe outbox full: dropped ${evicted} oldest queued capture(s) to stay under the ${this.maxEntries}-entry bound`,
        "warning"
      );
    }
  }

  private async persist(): Promise<void> {
    const data = this.entries.map((entry) => JSON.stringify(entry)).join("\n");
    const tmp = `${this.filePath}.tmp`;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(tmp, data ? `${data}\n` : "", "utf8");
    await rename(tmp, this.filePath);
  }

  private mutate(update: () => Promise<void> | void): Promise<void> {
    const run = this.writeChain.then(update);
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  async size(): Promise<number> {
    await this.load();
    return this.entries.length;
  }

  /** Dedupe keys of everything currently queued (used to avoid double-delivery channels). */
  async pendingHashes(): Promise<Set<string>> {
    await this.load();
    return new Set(
      this.entries.flatMap((entry) => entry.messageHashes.filter((hash): hash is string => hash !== null))
    );
  }

  async enqueue(input: ObserveOutboxEntryInput, notify?: OutboxNotify): Promise<void> {
    await this.load(notify);
    await this.mutate(async () => {
      this.entries.push({
        id: randomUUID(),
        queuedAt: new Date().toISOString(),
        ...input,
      });
      if (this.entries.length > this.maxEntries) {
        const evicted = this.entries.splice(0, this.entries.length - this.maxEntries).length;
        notify?.(
          `Remnic observe outbox full: dropped ${evicted} oldest queued capture(s) to stay under the ${this.maxEntries}-entry bound`,
          "warning"
        );
      }
      await this.persist();
    });
  }

  /**
   * Deliver queued entries strictly in order. Capacity/ambiguous failures
   * retry the same entry with Retry-After-aware backoff up to `maxAttempts`
   * total attempts per drain, then leave the queue intact for the next drain
   * trigger. Permanent rejections are dropped with a visible notification and
   * never retried.
   */
  async drain(send: (entry: ObserveOutboxEntry) => Promise<void>, options: DrainOptions = {}): Promise<DrainResult> {
    const notify = options.notify;
    await this.load(notify);
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
    let delivered = 0;
    let dropped = 0;
    let attempts = 0;
    try {
      while (this.entries.length > 0 && attempts < maxAttempts) {
        const entry = this.entries[0];
        attempts += 1;
        try {
          await send(entry);
        } catch (err) {
          const failureClass = err instanceof Error ? classifyObserveFailure(err) : "retry-ambiguous";
          if (failureClass === "permanent") {
            // Permanent drop does not consume the retry budget; later entries
            // still get their attempts.
            attempts -= 1;
            dropped += 1;
            await this.mutate(async () => {
              this.entries.shift();
              await this.persist();
            });
            const reason = err instanceof Error ? err.message : String(err);
            notify?.(
              `Remnic observe outbox: dropped 1 capture the daemon permanently rejected (${reason}); it will not be retried`,
              "warning"
            );
            continue;
          }
          const hint = err instanceof RemnicHttpError ? err.retryAfterMs : undefined;
          const hinted = hint !== undefined && Number.isFinite(hint) ? hint : undefined;
          const base = Math.min(hinted ?? backoffBaseMs * 2 ** (attempts - 1), maxRetryAfterMs);
          const jitter = 1 + (Math.random() * 2 - 1) * jitterRatio;
          await sleep(Math.max(0, Math.round(base * jitter)));
          continue;
        }
        await this.mutate(async () => {
          this.entries.shift();
          await this.persist();
        });
        delivered += 1;
      }
    } finally {
      this.drainInProgress = false;
    }
    return { delivered, dropped, pending: this.entries.length };
  }
}
