import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
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

/**
 * Marker records share the spill file with parked captures: "consumed" retires
 * an entry that was delivered, dropped, or moved to the hot queue; "failed"
 * carries its persisted ambiguous-failure count. Appending a short marker
 * keeps consumption O(1) instead of rewriting the whole file per send (#3522
 * review); markers are dropped by the next compaction.
 */
type SpillMarker = { kind: "consumed" | "failed"; id: string; failedAttempts?: number };

function parseSpillMarker(line: string): SpillMarker | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || Array.isArray(parsed)) return null;
  // SAFETY: JSON.parse produced a non-null, non-array value; the checks below
  // accept only the two literal marker forms this class writes — anything else
  // parses as an entry or counts as a skipped line.
  const marker = parsed as { $spill?: unknown; id?: unknown; failedAttempts?: unknown };
  if (!marker.id) return null;
  if (marker.$spill === "consumed") return { kind: "consumed", id: String(marker.id) };
  if (marker.$spill === "failed" && Number.isFinite(marker.failedAttempts)) {
    return { kind: "failed", id: String(marker.id), failedAttempts: Number(marker.failedAttempts) };
  }
  return null;
}

const spillConsumedLine = (id: string): string => JSON.stringify({ $spill: "consumed", id });
const spillFailedLine = (id: string, failedAttempts: number): string =>
  JSON.stringify({ $spill: "failed", id, failedAttempts });

/** Never equal to a real ino:size:mtime signature, so an unreadable file is retried on the next refresh. */
const UNREADABLE_SIGNATURE = "unreadable";
const LOCK_STALE_MS = 30_000;
const LOCK_MAX_WAIT_MS = 5_000;

/** Best-effort directory fsync, mirroring writeFileAtomically's post-rename step. */
async function syncDirectory(dir: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(dir, "r");
    await handle.sync();
  } catch {
    // Directory fsync is best-effort across platforms and filesystems.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

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
  /**
   * Live spill view, keyed by the file's ino:size:mtime signature: a match means
   * no process touched the file since the view was built, so it is authoritative
   * for count, drain consult and live-capture suppression (#3522 review).
   */
  private spillView: {
    signature: string | null;
    live: ObserveOutboxEntry[];
    skipped: number;
    markers: number;
  } | null = null;
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

  /**
   * Queue a read behind in-flight mutations on the same writeChain: a refresh
   * that resolves mid-mutation could overwrite the entries the write is about
   * to persist and lose them (#3522 review). Mutations never call this — they
   * use refresh() directly under the lock — so it cannot deadlock.
   */
  private withReadChain<T>(read: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(read);
    this.writeChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** Read-only callers keep the last known entries when the file cannot be read. */
  private refreshOrKeepLastKnown(notify?: OutboxNotify): Promise<void> {
    return this.withReadChain(async () => {
      try {
        await this.refresh(notify);
      } catch {
        // Unreadable file: stay on the last known view; mutations still fail closed.
      }
    });
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
  private async readSpill(): Promise<{
    entries: ObserveOutboxEntry[];
    skipped: number;
    markers: number;
  } | null> {
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
    const consumed = new Set<string>();
    const failed = new Map<string, number>();
    let skipped = 0;
    let markers = 0;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Marker lines retire entries or carry their failure counts; a line whose
      // content merely mentions "$spill" falls through and parses as an entry.
      if (trimmed.includes('"$spill"')) {
        const marker = parseSpillMarker(trimmed);
        if (marker) {
          markers += 1;
          if (marker.kind === "consumed") consumed.add(marker.id);
          else failed.set(marker.id, marker.failedAttempts ?? 0);
          continue;
        }
      }
      const entry = parseOutboxEntry(trimmed);
      if (entry) entries.push(entry);
      else skipped += 1;
    }
    const live = entries.filter((entry) => !consumed.has(entry.id));
    for (const entry of live) {
      const attempts = failed.get(entry.id);
      if (attempts !== undefined) entry.failedAttempts = attempts;
    }
    return { entries: live, skipped, markers };
  }

  /**
   * The spill's live entries, signature-cached like the queue's diskSignature:
   * a matching signature means no process touched the file since this instance
   * last read it, so the view is authoritative. This instance's own writes keep
   * it current; anything else invalidates it. A present-but-unreadable file
   * throws — the next append or refill would otherwise write over captures it
   * cannot see, the same fail-closed rule as the queue file itself.
   */
  private async liveSpillView(): Promise<{ live: ObserveOutboxEntry[]; skipped: number; markers: number }> {
    const signature = await this.spillSig();
    if (signature === null) {
      this.spillView = { signature: null, live: [], skipped: 0, markers: 0 };
      return this.spillView;
    }
    if (!this.spillView || this.spillView.signature !== signature) {
      const spill = await this.readSpill();
      this.spillView = {
        signature,
        live: spill?.entries ?? [],
        skipped: spill?.skipped ?? 0,
        markers: spill?.markers ?? 0,
      };
    }
    return this.spillView;
  }

  /** Live spill count, signature-cached. Runs under the lock on every mutating path. */
  private async countSpill(): Promise<number> {
    return (await this.liveSpillView()).live.length;
  }

  /**
   * Append records to the spill end durably: opened handle + fsync plus a
   * directory sync on first create — a plain appendFile is not durable (Codex
   * on #3522). An existing file is tightened to owner-only because the open
   * mode applies on create only. A torn tail from a crash or a failed earlier
   * append is delimited with a newline first, so the fragment cannot merge into
   * the next record and take it down as one unparseable line.
   */
  private async appendSpillLines(lines: string[]): Promise<void> {
    if (lines.length === 0) return;
    const existed = (await this.spillSig()) !== null;
    const handle = await open(this.spillPath, "a+", 0o600);
    try {
      await handle.chmod(0o600);
      const { size } = await handle.stat();
      if (size > 0) {
        const tail = Buffer.alloc(1);
        await handle.read(tail, 0, 1, size - 1);
        if (tail[0] !== 0x0a) await handle.appendFile("\n", "utf8");
      }
      await handle.appendFile(`${lines.join("\n")}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (!existed) await syncDirectory(path.dirname(this.spillPath));
    // The file changed under our own write: keep a live view truthful by
    // re-signing it. Callers then update the view's content to match.
    if (this.spillView) this.spillView.signature = await this.spillSig();
  }

  /**
   * Remove the spill file; ENOENT is the only tolerated failure — anything else
   * must reach the caller, or the file keeps entries the cache already forgot
   * and they replay again later (#3522 review).
   */
  private async removeSpillFile(): Promise<void> {
    try {
      await unlink(this.spillPath);
    } catch (err) {
      // SAFETY: unlink rejects with a Node system error carrying `.code`.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    this.spillView = { signature: null, live: [], skipped: 0, markers: 0 };
  }

  /**
   * Retire spill entries by id — delivered, dropped, or moved to the hot queue —
   * as appended markers instead of a full rewrite (#3522 review). The live view
   * loses them immediately; the markers are dropped by the next compaction.
   */
  private async consumeSpillIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.appendSpillLines(ids.map((id) => spillConsumedLine(id)));
    if (this.spillView) {
      const gone = new Set(ids);
      this.spillView.live = this.spillView.live.filter((entry) => !gone.has(entry.id));
      this.spillView.markers += ids.length;
    }
  }

  /**
   * Drop markers and unreadable lines by rewriting the live entries once —
   * called at drain end so the steady path never pays a rewrite per send
   * (#3522 review). An emptied or fully-invalid file is unlinked instead.
   */
  private async compactSpill(): Promise<void> {
    const view = await this.liveSpillView();
    if (view.markers === 0 && view.skipped === 0) return;
    if (view.live.length === 0) {
      await this.removeSpillFile();
      return;
    }
    const data = view.live.map((entry) => JSON.stringify(entry)).join("\n");
    await writeFileAtomically(this.spillPath, `${data}\n`, undefined, 0o600);
    this.spillView = { signature: await this.spillSig(), live: view.live, skipped: 0, markers: 0 };
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
      await this.appendSpillLines(parked.map((entry) => JSON.stringify(entry)));
      if (this.spillView) this.spillView.live.push(...parked);
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
   * BEFORE the moved ids are marked consumed in the spill: a crash between the
   * two leaves the entries in both files (nonce-deduplicated) instead of
   * dropping them. Markers keep the move O(1) — no rewrite per entry (#3522).
   */
  private async refillFromSpill(notify?: OutboxNotify): Promise<boolean> {
    if (this.entries.length >= this.maxEntries) return false;
    if ((await this.spillSig()) === null) return false;
    let movedCount = 0;
    await this.mutate(async () => {
      const room = this.maxEntries - this.entries.length;
      if (room <= 0) return;
      const view = await this.liveSpillView();
      if (view.live.length === 0) {
        // A spill of only markers or corrupt lines would linger forever: clear
        // it under the lock and say so, matching the queue file's visible skip.
        if (view.skipped > 0 || view.markers > 0) {
          await this.removeSpillFile();
          if (view.skipped > 0) {
            notify?.(
              `Remnic observe outbox: dropped ${view.skipped} unreadable line(s) in ${path.basename(this.spillPath)}; the spill file held no live captures`,
              "warning"
            );
          }
        }
        return;
      }
      const moved = view.live.slice(0, room);
      this.entries.push(...moved);
      await this.persist();
      await this.consumeSpillIds(moved.map((entry) => entry.id));
      movedCount = moved.length;
      if (view.skipped > 0) {
        notify?.(
          `Remnic observe outbox: skipped ${view.skipped} unreadable line(s) in ${path.basename(this.spillPath)}; the remaining spilled captures were preserved`,
          "warning"
        );
      }
    }, notify);
    return movedCount > 0;
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
   * would deliver — hot entries AND spilled ones: a capture parked in the spill
   * must still suppress its live twin, or it is sent live under a fresh nonce
   * and ingested twice when the spill replays (#3522 review). Entries bound to
   * another daemon do not suppress the live capture for this one — they are
   * never delivered here (#3504 review).
   */
  async pendingHashes(destination?: string): Promise<Set<string>> {
    await this.refreshOrKeepLastKnown();
    const spill = await this.withReadChain(() =>
      this.liveSpillView()
        .then((view) => view.live)
        .catch((): ObserveOutboxEntry[] => [])
    );
    return new Set(
      [...this.entries, ...spill]
        .filter((entry) => entryEligibleForDestination(entry, destination))
        .flatMap((entry) => entry.messageHashes.filter((hash): hash is string => hash !== null))
    );
  }

  /** Counters since process start plus the oldest queued entry age. */
  async status(now: () => number = Date.now): Promise<OutboxStatus> {
    await this.refreshOrKeepLastKnown();
    const oldest = this.entries[0] ? Date.parse(this.entries[0].queuedAt) : Number.NaN;
    const spilled = await this.withReadChain(() =>
      this.countSpill().catch((): undefined => undefined)
    );
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

  /**
   * Remove the entry from whichever file holds it — resolved by id inside the
   * lock because another drainer may have moved it between the files while this
   * one's send was in flight (#3522 review). Already gone from both is a no-op.
   */
  private async removeEntry(entry: ObserveOutboxEntry): Promise<void> {
    await this.mutate(async () => {
      this.entries = this.entries.filter((candidate) => candidate.id !== entry.id);
      const view = await this.liveSpillView();
      if (view.live.some((candidate) => candidate.id === entry.id)) {
        await this.consumeSpillIds([entry.id]);
      }
    });
  }

  /**
   * Bump the entry's persisted ambiguous-failure count in whichever file holds
   * it; 0 when another process already removed it. A spill entry's count is an
   * appended marker, not a rewrite (#3522 review).
   */
  private async recordEntryFailure(entry: ObserveOutboxEntry): Promise<number> {
    let attempts = 0;
    await this.mutate(async () => {
      const hot = this.entries.find((candidate) => candidate.id === entry.id);
      if (hot) {
        hot.failedAttempts = (hot.failedAttempts ?? 0) + 1;
        attempts = hot.failedAttempts;
        return;
      }
      const view = await this.liveSpillView();
      const parked = view.live.find((candidate) => candidate.id === entry.id);
      if (!parked) return;
      // The count must not lead the durable record: if the append or its fsync
      // fails, a bumped in-memory value would be re-signed with the file and
      // report a failure that never persisted (#3522 review).
      const recordedAttempts = (parked.failedAttempts ?? 0) + 1;
      await this.appendSpillLines([spillFailedLine(entry.id, recordedAttempts)]);
      parked.failedAttempts = recordedAttempts;
      attempts = recordedAttempts;
      if (this.spillView) this.spillView.markers += 1;
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
        let entry = this.entries.find((candidate) => eligible(candidate) && !skippedSessions.has(candidate.sessionKey));
        if (!entry) {
          // The signature-keyed live view is re-read whenever another writer
          // touched the file, so a snapshot can never resurrect an entry another
          // process already consumed (#3522 review). Consulted only when the
          // hot window has no eligible candidate, so a window full of foreign or
          // session-blocked entries cannot starve spilled captures (#3520).
          const parked = (
            await this.withReadChain(() =>
              this.liveSpillView()
                .then((view) => view.live)
                .catch((): ObserveOutboxEntry[] => [])
            )
          ).find((candidate) => eligible(candidate) && !skippedSessions.has(candidate.sessionKey));
          if (parked) entry = parked;
        }
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
            await this.removeEntry(entry);
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
            const attempts = await this.recordEntryFailure(entry);
            if (attempts >= MAX_ENTRY_FAILURES) {
              dropped += 1;
              this.counters.dropped += 1;
              await this.removeEntry(entry);
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
        await this.removeEntry(entry);
        delivered += 1;
        this.counters.delivered += 1;
      }
      // One rewrite at the end retires the markers the steady path appended —
      // consumption stays O(1) per send instead of O(file) per send (#3522).
      await this.mutate(async () => {
        await this.compactSpill();
      }).catch(() => undefined);
    } finally {
      this.drainInProgress = false;
    }
    // Pending and foreign counts span both files — a drain that leaves only
    // parked spill entries must still report them, or the caller believes the
    // outbox is empty while a backlog waits (#3522 review).
    const spillRest = await this.withReadChain(() =>
      this.liveSpillView()
        .then((view) => view.live)
        .catch((): ObserveOutboxEntry[] => [])
    );
    const foreign =
      this.entries.filter((entry) => !eligible(entry)).length +
      spillRest.filter((entry) => !eligible(entry)).length;
    const summary = { delivered, dropped, pending: this.entries.length + spillRest.length };
    return foreign > 0 ? { ...summary, foreign } : summary;
  }
}
