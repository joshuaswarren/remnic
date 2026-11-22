import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { writeFileAtomically } from "@remnic/core/maintenance/atomic-file";
import { withHeldFileLock } from "@remnic/core/utils/serialize-mutations";

import { RemnicHttpError, RemnicRequestTimeoutError, isTransientNetworkError } from "./client.js";
import type { ObserveMessage } from "./client.js";
import { boundedReplayMessages } from "./messages.js";

/**
 * Durable local queue for observe batches that the daemon could not accept:
 * capacity backpressure or ambiguous failures where the request MAY have been
 * processed. Stable replay-nonce keys deduplicate retries server-side. The hot
 * JSONL file is capped; older entries live in private, atomic spill segments.
 * All mutations share a file lock and re-read disk before changing either store.
 * Spill segments are committed before hot-file rewrites, so a crash during a
 * spill leaves recoverable duplicate IDs rather than losing accepted captures.
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
  /** Failed delivery attempts retained from earlier outbox versions. */
  failedAttempts?: number;
};

export type OutboxNotify = (message: string, level: "info" | "warning" | "error") => void;

/**
 * retry-capacity: the daemon asked us to come back (503 backpressure, 429 rate limit,
 *   408/502/504 transient gateway). retry-ambiguous: the request may have been
 *   processed. blocked: credentials rejected (401/403); keep the queue until fixed.
 *   permanent: semantic rejection; retain the FIFO head and retry after correction.
 */
export type ObserveFailureClass = "retry-capacity" | "retry-ambiguous" | "blocked" | "permanent";

const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 502, 503, 504]);
const AUTH_HTTP_STATUSES = new Set([401, 403]);

export function classifyObserveFailure(err: Error): ObserveFailureClass {
  if (err instanceof RemnicHttpError) {
    // retry is safe. 401/403 park the queue. Other 4xx responses are semantic
    // rejections, but remain queued so an operator can fix the cause and retry.
    // Unrecognized 5xx responses are ambiguous and use the same stable key.
    if (RETRYABLE_HTTP_STATUSES.has(err.status)) return "retry-capacity";
    if (AUTH_HTTP_STATUSES.has(err.status)) return "blocked";
    if (err.status >= 500) return "retry-ambiguous";
    return "permanent";
  }
  if (err instanceof RemnicRequestTimeoutError) return "retry-ambiguous";
  if (isTransientNetworkError(err)) return "retry-ambiguous";
  return "retry-ambiguous";
}

export type DrainOptions = {
  /** Total send attempts per drain across all entries (default 4). */
  maxAttempts?: number;
  /** Successful entries per drain; omitted means no delivery-count bound. */
  maxSends?: number;
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

async function* readLines(filePath: string): AsyncGenerator<string> {
  let remainder = "";
  try {
    for await (const chunk of createReadStream(filePath, { encoding: "utf8" })) {
      remainder += chunk;
      let newline = remainder.indexOf("\n");
      while (newline !== -1) {
        yield remainder.slice(0, newline);
        remainder = remainder.slice(newline + 1);
        newline = remainder.indexOf("\n");
      }
    }
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return;
    throw err;
  }
  if (remainder) yield remainder;
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // Directory fsync is best-effort on filesystems that do not support it.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export class ObserveOutbox {
  readonly filePath: string;
  private readonly lockPath: string;
  private readonly spillDirectory: string;
  private readonly maxEntries: number;
  private readonly lockMaxWaitMs: number;
  /** The hot file is bounded; spilled entry bodies stay on disk. */
  private entries: ObserveOutboxEntry[] = [];
  private spillCount = 0;
  private spillOldestQueuedAt: string | undefined;
  /** Signatures of the hot file and spill segments, shared across processes. */
  private diskSignature: string | null = null;
  private operationChain: Promise<void> = Promise.resolve();
  private drainInProgress = false;
  private counters = { queued: 0, retried: 0, delivered: 0, dropped: 0 };
  constructor(filePath: string, options: { maxEntries?: number; lockMaxWaitMs?: number } = {}) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this.spillDirectory = `${filePath}.spill`;
    this.lockMaxWaitMs = options.lockMaxWaitMs ?? LOCK_MAX_WAIT_MS;
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  }

  private async fileSignature(filePath: string): Promise<string | null> {
    try {
      const info = await stat(filePath);
      return `${info.ino}:${info.size}:${info.mtimeMs}`;
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
      throw err;
    }
  }

  private async spillFiles(): Promise<string[]> {
    let names: string[];
    try {
      // AGENTS.md spill policy: a symlinked spill root is rejected entirely so
      // no read or write can follow it outside the outbox's own directory.
      if (!(await lstat(this.spillDirectory)).isDirectory()) return [];
      names = await readdir(this.spillDirectory);
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") return [];
      throw err;
    }
    const candidates = names
      .filter((name) => /^segment-\d{20}\.jsonl$/.test(name))
      .sort();
    const files: string[] = [];
    for (const name of candidates) {
      // Only regular files are read; a symlink segment is ignored, never followed.
      if (!(await lstat(path.join(this.spillDirectory, name))).isFile()) continue;
      files.push(path.join(this.spillDirectory, name));
    }
    return files;
  }

  private async signature(): Promise<string | null> {
    const [main, directory, files] = await Promise.all([
      this.fileSignature(this.filePath),
      this.fileSignature(this.spillDirectory),
      this.spillFiles(),
    ]);
    if (main === null && directory === null) return null;
    const segments = await Promise.all(files.map((file) => this.fileSignature(file)));
    return [main ?? "absent", directory ?? "absent", ...segments.map((value) => value ?? "absent")].join("|");
  }

  /** Read-only callers keep the last known entries when either file cannot be read. */
  private async refreshOrKeepLastKnown(notify?: OutboxNotify): Promise<void> {
    const run = this.operationChain.then(async () => {
      try {
        await this.refresh(notify);
      } catch {
        // Unreadable files keep the last known view; mutations still fail closed.
      }
    });
    this.operationChain = run;
    await run;
  }

  /** Re-read both files when another process (or this one) changed either one. */
  private async refresh(notify?: OutboxNotify, force = false): Promise<void> {
    const signature = await this.signature();
    if (!force && signature === this.diskSignature) return;
    if (signature === null) {
      this.diskSignature = null;
      this.entries = [];
      this.spillCount = 0;
      this.spillOldestQueuedAt = undefined;
      return;
    }
    this.diskSignature = signature;
    const entries: ObserveOutboxEntry[] = [];
    const hotIds = new Set<string>();
    let spillCount = 0;
    let spillOldestQueuedAt: string | undefined;
    let skipped = 0;
    try {
      const raw = await readFile(this.filePath, "utf8").catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return "";
        throw err;
      });
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const entry = parseOutboxEntry(trimmed);
        if (entry) {
          entries.push(entry);
          hotIds.add(entry.id);
        } else skipped += 1;
      }
      for (const file of await this.spillFiles()) {
        for await (const line of readLines(file)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const entry = parseOutboxEntry(trimmed);
          if (!entry) {
            skipped += 1;
            continue;
          }
          spillCount += 1;
          spillOldestQueuedAt ??= entry.queuedAt;
          if (hotIds.has(entry.id)) {
            for (let i = entries.length - 1; i >= 0; i -= 1) {
              if (entries[i].id === entry.id) entries.splice(i, 1);
            }
            hotIds.delete(entry.id);
          }
        }
      }
    } catch (err) {
      this.diskSignature = UNREADABLE_SIGNATURE;
      throw err;
    }
    this.entries = entries;
    this.spillCount = spillCount;
    this.spillOldestQueuedAt = spillOldestQueuedAt;
    if (skipped > 0) {
      notify?.(
        `Remnic observe outbox: skipped ${skipped} unreadable line(s) in ${path.basename(this.filePath)} or its spill file; the remaining entries were preserved`,
        "warning"
      );
    }
  }

  private async persist(): Promise<void> {
    const data = this.entries.map((entry) => JSON.stringify(entry)).join("\n");
    // Atomic replace with fsync of the temp file and directory; raw tool output
    // stays owner-only, and a rewrite tightens any pre-existing file to 0600.
    await writeFileAtomically(this.filePath, data ? `${data}\n` : "", undefined, 0o600);
  }

  private async spillSegmentEntries(file: string): Promise<ObserveOutboxEntry[]> {
    const raw = await readFile(file, "utf8");
    return raw
      .split("\n")
      .map((line) => parseOutboxEntry(line.trim()))
      .filter((entry): entry is ObserveOutboxEntry => entry !== null);
  }

  private async appendSpill(entries: ObserveOutboxEntry[]): Promise<void> {
    await mkdir(this.spillDirectory, { recursive: true, mode: 0o700 });
    // Before any chmod or write: a pre-existing symlinked spill root would make
    // chmod follow it and mode an external directory as a side effect.
    if ((await lstat(this.spillDirectory)).isSymbolicLink()) {
      throw new Error(`observe outbox spill directory is a symlink (${this.spillDirectory}); refusing to follow it`);
    }
    await chmod(this.spillDirectory, 0o700);
    await syncDirectory(path.dirname(this.spillDirectory));
    const files = await this.spillFiles();
    for (const file of files) await chmod(file, 0o600);
    const lastFile = files.at(-1);
    let nextNumber = lastFile ? BigInt(path.basename(lastFile).slice(8, -6)) : 0n;
    let current = lastFile ? await this.spillSegmentEntries(lastFile) : [];
    for (let offset = 0; offset < entries.length;) {
      if (current.length >= this.maxEntries) {
        nextNumber += 1n;
        current = [];
      }
      const count = Math.min(this.maxEntries - current.length, entries.length - offset);
      current.push(...entries.slice(offset, offset + count));
      const name = `segment-${nextNumber.toString().padStart(20, "0")}.jsonl`;
      const file = path.join(this.spillDirectory, name);
      const data = current.map((entry) => JSON.stringify(entry)).join("\n");
      await writeFileAtomically(file, `${data}\n`, undefined, 0o600);
      offset += count;
    }
  }

  private async hasSpillEntry(id: string): Promise<boolean> {
    for (const file of await this.spillFiles()) {
      for (const entry of await this.spillSegmentEntries(file)) {
        if (entry.id === id) return true;
      }
    }
    return false;
  }

  private async removeSpillEntry(id: string): Promise<void> {
    for (const file of await this.spillFiles()) {
      const entries = await this.spillSegmentEntries(file);
      if (!entries.some((entry) => entry.id === id)) continue;
      const remaining = entries.filter((entry) => entry.id !== id);
      if (remaining.length > 0) {
        const data = remaining.map((entry) => JSON.stringify(entry)).join("\n");
        await writeFileAtomically(file, `${data}\n`, undefined, 0o600);
      } else {
        await rm(file);
        await syncDirectory(this.spillDirectory);
      }
      return;
    }
  }

  private async firstSpillEntry(
    eligible: (entry: ObserveOutboxEntry) => boolean
  ): Promise<ObserveOutboxEntry | undefined> {
    for (const file of await this.spillFiles()) {
      for await (const line of readLines(file)) {
        const entry = parseOutboxEntry(line.trim());
        if (entry && eligible(entry)) return entry;
      }
    }
    return undefined;
  }

  private async spillForeignCount(eligible: (entry: ObserveOutboxEntry) => boolean): Promise<number> {
    let foreign = 0;
    for (const file of await this.spillFiles()) {
      for await (const line of readLines(file)) {
        const entry = parseOutboxEntry(line.trim());
        if (entry && !eligible(entry)) foreign += 1;
      }
    }
    return foreign;
  }

  /**
   * Serialize in-process, then take the cross-process lock and re-read the files
   * before applying a mutation. A lock failure never overwrites another writer.
   */
  private mutate(update: () => void | Promise<void>, persistMain = true, notify?: OutboxNotify): Promise<void> {
    const run = this.operationChain.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      await withHeldFileLock(
        this.lockPath,
        { staleMs: LOCK_STALE_MS, maxWaitMs: this.lockMaxWaitMs },
        async (acquired) => {
          if (!acquired) throw new Error(`observe outbox is locked by another process (${this.lockPath})`);
          await this.refresh(notify, true);
          if (this.entries.length > this.maxEntries) {
            const count = this.entries.length - this.maxEntries;
            await this.appendSpill(this.entries.slice(0, count));
            this.entries.splice(0, count);
          }
          await update();
          if (persistMain) await this.persist();
          await this.refresh(notify, true);
        },
      );
    });
    this.operationChain = run.catch(() => {
      this.diskSignature = UNREADABLE_SIGNATURE;
    });
    return run;
  }


  async size(): Promise<number> {
    await this.refreshOrKeepLastKnown();
    return this.spillCount + this.entries.length;
  }

  /**
   * Dedupe keys of everything currently queued that a drain on `destination`
   * would deliver. Entries bound to another daemon do not suppress the live
   * capture for this one — they are never delivered here (#3504 review).
   */
  async pendingHashes(destination?: string): Promise<Set<string>> {
    // One consistent state: the refresh, the spill scan and the hot-entry
    // snapshot all run inside the operation chain, so no concurrent spill or
    // write can interleave between them. Read-only — no mutation, no lock — and
    // the chain stays resolved when the scan fails.
    const run = this.operationChain.then(async () => {
      try {
        await this.refresh();
      } catch {
        // Unreadable files keep the last known view; read-only caller.
      }
      const hashes = new Set<string>();
      try {
        for (const file of await this.spillFiles()) {
          for await (const line of readLines(file)) {
            const entry = parseOutboxEntry(line.trim());
            if (entry && entryEligibleForDestination(entry, destination)) {
              for (const hash of entry.messageHashes) if (hash !== null) hashes.add(hash);
            }
          }
        }
      } catch {
        // Keep the live hook usable when the spill store is unreadable; hot entries remain available.
      }
      for (const entry of this.entries) {
        if (entryEligibleForDestination(entry, destination)) {
          for (const hash of entry.messageHashes) if (hash !== null) hashes.add(hash);
        }
      }
      return hashes;
    });
    this.operationChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** Counters since process start plus the oldest queued entry age. */
  async status(now: () => number = Date.now): Promise<OutboxStatus> {
    await this.refreshOrKeepLastKnown();
    const oldestAt = this.spillOldestQueuedAt ?? this.entries[0]?.queuedAt;
    const oldest = oldestAt ? Date.parse(oldestAt) : Number.NaN;
    return {
      pending: this.spillCount + this.entries.length,
      oldestAgeMs: Number.isFinite(oldest) ? Math.max(0, now() - oldest) : null,
      ...this.counters,
    };
  }

  async enqueue(input: ObserveOutboxEntryInput, notify?: OutboxNotify): Promise<void> {
    await this.mutate(async () => {
      const id = randomUUID();
      this.counters.queued += 1;
      const entry = {
        id,
        queuedAt: new Date().toISOString(),
        ...input,
        messages: boundedReplayMessages(input.messages, notify),
        replayNonce: input.replayNonce ?? id,
      };
      this.entries.push(entry);
      if (this.entries.length > this.maxEntries) {
        const count = this.entries.length - this.maxEntries;
        try {
          await this.appendSpill(this.entries.slice(0, count));
        } catch (err) {
          this.entries.pop();
          throw err;
        }
        this.entries.splice(0, count);
        notify?.(
          `Remnic observe outbox full: spilled ${count} oldest queued capture(s) to disk to stay under the ${this.maxEntries}-entry in-memory bound`,
          "info"
        );
      }
    }, true, notify);
  }

  private async remove(id: string): Promise<void> {
    await this.mutate(async () => {
      const inSpill = await this.hasSpillEntry(id);
      this.entries = this.entries.filter((entry) => entry.id !== id);
      // Keep the durable spill copy until the hot-file rewrite is committed.
      await this.persist();
      if (inSpill) await this.removeSpillEntry(id);
    }, false);
  }
  /**
   * Deliver queued entries in FIFO order, scanning the disk-backed spill before
   * the bounded hot file. Retryable failures keep the head queued; permanent
   * rejections stay queued and set that session aside for the rest of this
   * drain, so a refused capture cannot block later captures from other sessions.
   */
  async drain(send: (entry: ObserveOutboxEntry) => Promise<void>, options: DrainOptions = {}): Promise<DrainResult> {
    const notify = options.notify;
    await this.refreshOrKeepLastKnown(notify);
    if (this.drainInProgress) {
      return { delivered: 0, dropped: 0, pending: this.spillCount + this.entries.length, skipped: true };
    }
    this.drainInProgress = true;
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    const maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
    const requestedJitter = options.jitterRatio ?? DEFAULT_JITTER_RATIO;
    const jitterRatio = Number.isFinite(requestedJitter) && requestedJitter >= 0 ? requestedJitter : DEFAULT_JITTER_RATIO;
    const sleep =
      options.sleep ??
      ((ms: number) => {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, ms).unref();
        return promise;
      });
    const now = options.now ?? Date.now;
    const warnedStale = new Set<string>();
    let delivered = 0;
    let failures = 0;
    const maxSends = options.maxSends ?? Number.POSITIVE_INFINITY;
    const eligible = (entry: ObserveOutboxEntry): boolean =>
      entryEligibleForDestination(entry, options.destination);
    /**
     * A session whose head capture was permanently rejected is set aside for
     * the rest of this drain: its entries stay queued in order, but captures
     * from other sessions are still attempted (#3520).
     */
    const refusedSessions = new Set<string>();
    const deliverable = (entry: ObserveOutboxEntry): boolean => eligible(entry) && !refusedSessions.has(entry.sessionKey);
    try {
      while (failures < maxAttempts && delivered < maxSends) {
        await this.refreshOrKeepLastKnown(notify);
        const spilled = await this.firstSpillEntry(deliverable);
        const entry = spilled ?? this.entries.find(deliverable);
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
            const reason = err instanceof Error ? err.message : String(err);
            const status = err instanceof RemnicHttpError ? `HTTP ${err.status}: ` : "";
            notify?.(
              `Remnic observe outbox: the daemon permanently rejected the head capture (${status}${reason}; entry ${entry.id}, replay key ${entry.replayNonce ?? entry.id}); it remains queued for retry on the next successful daemon contact after the cause is fixed, and captures from other sessions still run this drain`,
              "warning"
            );
            refusedSessions.add(entry.sessionKey);
            continue;
          }
          if (failureClass === "blocked") {
            const status = err instanceof RemnicHttpError ? err.status : "auth";
            notify?.(
              `Remnic observe outbox: the daemon rejected the request credentials (HTTP ${status}); ${this.spillCount + this.entries.length} queued capture(s) were kept and will replay once the token is fixed`,
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
    const foreign =
      (await this.spillForeignCount(eligible)) + this.entries.filter((entry) => !eligible(entry)).length;
    const summary = { delivered, dropped: 0, pending: this.spillCount + this.entries.length };
    return foreign > 0 ? { ...summary, foreign } : summary;
  }
}
