/**
 * Durable drain claims for the extraction buffer (`remnic buffer drain`).
 *
 * A claim is the atomic handover of one session's buffered turns from the
 * live buffer (daemon or CLI process) to a drain worker, so extraction can
 * run out of process without a live buffer owner resurrecting or losing the
 * turns. Files under `<stateDir>/buffer/drain/`:
 *
 *   s-<sha256(key)>.json        claim content: { key, entry, claimedAt }
 *                               — the turns NOT yet extracted. Renamed into
 *                               place from the session file (atomic on one
 *                               filesystem), rewritten atomically as chunks
 *                               drain.
 *   s-<sha256(key)>.lease.json  { ownerId, pid, acquiredAt, heartbeatAt,
 *                               leaseMs } — created with exclusive-create so
 *                               exactly one drainer holds a key.
 *   s-<sha256(key)>.json.inbox.jsonl
 *                               append-only hand-ins from a live buffer owner,
 *                               one `\n`-prefixed JSON record per line:
 *                               { id, key, ...entry }. mergeIntoClaim only
 *                               appends here (O(incoming)); the claim a reader
 *                               sees is the body with every record folded in
 *                               by the identity-aware merge. The drainer's
 *                               progress write (and ack) folds the inbox into
 *                               the body, lists the folded ids in the body's
 *                               `foldedRecords`, and only then deletes the
 *                               inbox, so a kill between the two replays
 *                               nothing. A torn last line is skipped: its
 *                               owner never saw the append succeed.
 *   s-<sha256(key)>.json.count  cached { pending, drained } turn counts of the
 *                               body, valid while the body's size and mtime
 *                               match, so listings and the hand-over gate
 *                               never parse a body.
 *
 * Rolling back to a build that predates the inbox: run `foldAllInboxes()` (CLI:
 * `remnic buffer drain --fold-inboxes`) first; that build never reads an inbox.
 *
 * Invariants (see the buffer-drain PR for the full protocol):
 *   - At every instant the claim (body plus unfolded inbox) holds exactly the
 *     turns whose extraction is not durably finished, so a kill at any point
 *     loses nothing and the next run resumes.
 *   - A live buffer owner that must persist a claimed session hands its
 *     in-memory entry INTO the claim (identity-aware, occurrence-preserving
 *     merge) instead of writing a session file — it can never resurrect
 *     turns the drain already finished.
 *   - Claims are idempotent: re-claiming, double-draining, and two
 *     concurrent drainers are all safe (per-key mutation lock + exclusive
 *     lease; the lock also fences lease takeover and progress writes).
 *
 * All content reads/writes go through the storage's secure file I/O
 * (`BufferFileIo`); only lease/existence checks and the count summary touch
 * raw paths, and claim rewrites and inbox appends serialize on a cross-process
 * held file lock.
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { z } from "zod";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { bufferSessionFileName, type BufferFileIo } from "./buffer-session-files.js";
import { bufferTurnIdentityKey, subtractBufferTurns, type DrainedTurnSets } from "../buffer-turn-helpers.js";
import { log } from "../logger.js";
import { isErrnoCode } from "../utils/errno.js";
import { withHeldFileLock } from "../utils/serialize-mutations.js";
import type { BufferEntryState, BufferTurn } from "../types.js";

/** Result of persisting one session's entry. */
export interface BufferSessionSaveOutcome {
  /** "saved": the session file holds the entry. "handed_over": the entry moved into a drain claim. */
  status: "saved" | "handed_over";
  /** Tombstoned turn identities by their original active/retained list. */
  drainedTurns?: DrainedTurnSets;
}

export interface DrainLease {
  /** Unique fencing token for one scheduler/process identity; never reuse it after restart. */
  ownerId: string;
  pid: number;
  /** Host the owner runs on: a takeover may only judge liveness on that host. */
  host: string;
  acquiredAt: string;
  heartbeatAt: string;
  leaseMs: number;
}

export interface DrainClaimFile {
  key: string;
  entry: BufferEntryState;
  claimedAt: string;
  /**
   * Turns the drain already extracted. Non-empty means the session was
   * drained and the claim is a TOMBSTONE: a live buffer owner subtracts
   * these from its (possibly stale) copy instead of writing them back, so
   * drained turns can never be resurrected.
   */
  drained?: BufferTurn[];
  /** Same tombstone for turns the drain extracted from `retainedTurns`. */
  drainedRetained?: BufferTurn[];
  /**
   * Pending turns whose only copy sits in the other list than the one they
   * were claimed into (active to retained or back). When such a turn is
   * extracted, its tombstone goes to BOTH lists: a live owner still holds
   * the stale copy in the list the turn started in.
   */
  movedTurns?: BufferTurn[];
  /**
   * Ids of the inbox records the latest compaction folded into this body. The
   * inbox file is deleted AFTER the body write, so a kill in between leaves
   * records that are already in the body; readers skip exactly these ids.
   */
  foldedRecords?: string[];
}

/** One hand-in appended to the claim's inbox by a live buffer owner. */
interface InboxRecord {
  id: string;
  entry: BufferEntryState;
}

/** A claim's turn counts, cached beside the body so listings never parse it. */
interface ClaimSummary {
  key: string;
  /** Identity of the body the counts describe; any rewrite invalidates them. */
  size: number;
  mtimeMs: number;
  pending: number;
  drained: number;
}

export type ClaimFromSessionOutcome = "claimed" | "empty" | "already_claimed";
export type AdoptOutcome = "adopted" | "busy";
export type AckOutcome = "acked" | "not_empty" | "busy";

export interface DrainClaimListing {
  key: string;
  turnCount: number;
  leased: boolean;
  leaseExpired: boolean;
}

/** Lock while a claim is read-modify-written; released on settle. */
const CLAIM_LOCK_STALE_MS = 120_000;
const CLAIM_LOCK_MAX_WAIT_MS = 120_000;

function emptyEntry(): BufferEntryState {
  return { turns: [], lastExtractionAt: null, extractionCount: 0 };
}

function turnCounts(turns: readonly BufferTurn[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const turn of turns) {
    const key = bufferTurnIdentityKey(turn);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Append the incoming occurrences the claim does not hold yet. `counts` is the
 * claim's per-identity occurrence count at the START of this merge (it is
 * updated after, not during, so two equal incoming turns can both land) and
 * stays in step across successive merges, so folding N records costs one pass
 * over the claim instead of N.
 */
function appendNewOccurrences(target: BufferTurn[], counts: Map<string, number>, incoming: readonly BufferTurn[]): void {
  const incomingCounts = new Map<string, number>();
  const added: string[] = [];
  for (const turn of incoming) {
    const key = bufferTurnIdentityKey(turn);
    const count = (incomingCounts.get(key) ?? 0) + 1;
    incomingCounts.set(key, count);
    if (count > (counts.get(key) ?? 0)) {
      target.push(turn);
      added.push(key);
    }
  }
  for (const key of added) counts.set(key, (counts.get(key) ?? 0) + 1);
}

function preserveSourceOccurrences(
  target: BufferTurn[],
  source: readonly BufferTurn[],
  identity: string,
): void {
  const targetCount = turnCounts(target).get(identity) ?? 0;
  let sourceCount = 0;
  for (const turn of source) {
    if (bufferTurnIdentityKey(turn) !== identity) continue;
    sourceCount += 1;
    if (sourceCount > targetCount) target.push(turn);
  }
}

function appendUnmatched(
  snapshot: readonly BufferTurn[],
  matchedCounts: ReadonlyMap<string, number>,
  unmatched: BufferTurn[],
): void {
  const remaining = new Map(matchedCounts);
  for (const turn of snapshot) {
    const key = bufferTurnIdentityKey(turn);
    const matched = remaining.get(key) ?? 0;
    if (matched > 0) remaining.set(key, matched - 1);
    else unmatched.push(turn);
  }
}

function removeOneByIdentity(turns: BufferTurn[], identity: string): boolean {
  const index = turns.findIndex((turn) => bufferTurnIdentityKey(turn) === identity);
  if (index < 0) return false;
  turns.splice(index, 1);
  return true;
}

function takeByIdentity(source: readonly BufferTurn[], identity: string, count: number): BufferTurn[] {
  return source.filter((turn) => bufferTurnIdentityKey(turn) === identity).slice(0, count);
}

/**
 * The claim a reader sees: the body with every not-yet-compacted inbox record
 * merged in order. A record whose id the body already lists (`foldedRecords`)
 * was consumed by a compaction whose inbox delete never ran, so it is skipped
 * exactly. The claim's own lists already exclude what was extracted; each
 * tombstone applies only to the incoming copy in the list the turn was
 * extracted from.
 */
function foldRecords(claim: DrainClaimFile, records: readonly InboxRecord[]): DrainClaimFile {
  const consumed = new Set(claim.foldedRecords);
  const fresh = records.filter((record) => !consumed.has(record.id));
  if (fresh.length === 0) return claim;
  const turns = [...claim.entry.turns];
  const retainedTurns = [...(claim.entry.retainedTurns ?? [])];
  const activeCounts = turnCounts(turns);
  const retainedCounts = turnCounts(retainedTurns);
  const entry = emptyEntry();
  entry.lastExtractionAt = claim.entry.lastExtractionAt;
  entry.extractionCount = claim.entry.extractionCount;
  for (const { entry: incoming } of fresh) {
    appendNewOccurrences(turns, activeCounts, subtractBufferTurns(incoming.turns, claim.drained ?? []));
    appendNewOccurrences(retainedTurns, retainedCounts, subtractBufferTurns(incoming.retainedTurns ?? [], claim.drainedRetained ?? []));
    const stamps = [entry.lastExtractionAt, incoming.lastExtractionAt].filter(
      (value): value is string => value !== null && value !== undefined,
    );
    entry.lastExtractionAt = stamps.sort().at(-1) ?? null;
    entry.extractionCount = Math.max(entry.extractionCount, incoming.extractionCount);
  }
  entry.turns = turns;
  if (retainedTurns.length > 0) entry.retainedTurns = retainedTurns;
  return { ...claim, entry };
}

/**
 * Is the lease owner still running? Only decidable on the owner's host; a
 * lease from another host counts as alive (its expiry decides).
 */
function isOwnerAlive(lease: DrainLease): boolean {
  if (lease.host !== hostname()) return true;
  if (!Number.isInteger(lease.pid) || lease.pid <= 0) return true;
  try {
    process.kill(lease.pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user.
    // SAFETY: the value comes from this module's own write path; the shape is checked above.
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function isLeaseExpired(lease: DrainLease, now = Date.now()): boolean {
  const heartbeat = Date.parse(lease.heartbeatAt);
  return !Number.isFinite(heartbeat) || now - heartbeat > lease.leaseMs;
}

const claimBodySchema = z.object({
  key: z.string().min(1),
  entry: z.object({
    turns: z.array(z.unknown()),
    retainedTurns: z.array(z.unknown()).optional(),
    lastExtractionAt: z.string().nullable().optional(),
    extractionCount: z.number().optional(),
  }).optional(),
  turns: z.array(z.unknown()).optional(),
  retainedTurns: z.array(z.unknown()).optional(),
  lastExtractionAt: z.string().nullable().optional(),
  extractionCount: z.number().optional(),
  claimedAt: z.string().optional(),
  drained: z.array(z.unknown()).optional(),
  drainedRetained: z.array(z.unknown()).optional(),
  movedTurns: z.array(z.unknown()).optional(),
  foldedRecords: z.array(z.string()).optional(),
});

function parseBody(raw: string): DrainClaimFile | null {
  let body: z.infer<typeof claimBodySchema>;
  try {
    body = claimBodySchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
  // Two on-disk shapes, one format: a claim born from rename keeps the flat
  // session-file shape ({key, turns, ...}) until its first rewrite, which
  // nests under `entry`. Accept both.
  const source = body.entry && Array.isArray(body.entry.turns) ? body.entry : body;
  if (!Array.isArray(source.turns)) return null;
  const entry = emptyEntry();
  // SAFETY: the schema parsed these as an array of unknown; the claim file
  // is written only by this module (BufferSessionFiles.save), so the entries
  // are BufferTurn values.
  // SAFETY: the claim file is written only by this module, so the parsed
  // turn arrays hold BufferTurn values.
  // SAFETY: the value comes from this module's own write path; the shape is checked above.
  entry.turns = source.turns as BufferTurn[];
  if (source.retainedTurns) {
    // SAFETY: same boundary as the turns above (this module writes the file).
    entry.retainedTurns = source.retainedTurns as BufferTurn[];
  }
  entry.lastExtractionAt = source.lastExtractionAt ?? null;
  entry.extractionCount = Number.isFinite(source.extractionCount) ? Number(source.extractionCount) : 0;
  const claim: DrainClaimFile = {
    key: body.key,
    entry,
    claimedAt: body.claimedAt ?? new Date().toISOString(),
  };
  if (Array.isArray(body.drained)) {
    // SAFETY: same boundary as the turns above (this module writes the file).
    claim.drained = body.drained as BufferTurn[];
  }
  if (Array.isArray(body.drainedRetained)) {
    // SAFETY: same boundary as the turns above (this module writes the file).
    claim.drainedRetained = body.drainedRetained as BufferTurn[];
  }
  if (Array.isArray(body.movedTurns)) {
    // SAFETY: same boundary as the turns above (this module writes the file).
    claim.movedTurns = body.movedTurns as BufferTurn[];
  }
  if (body.foldedRecords) claim.foldedRecords = body.foldedRecords;
  return claim;
}

const inboxRecordSchema = z.object({
  id: z.string().min(1),
  turns: z.array(z.unknown()),
  retainedTurns: z.array(z.unknown()).optional(),
  lastExtractionAt: z.string().nullable().optional(),
  extractionCount: z.number().optional(),
});

/**
 * Parse an inbox file: one JSON record per line. A record that does not parse
 * (a torn tail from a kill mid-append) is skipped: its owner never saw the
 * append succeed and keeps the save pending. Records are newline-PREFIXED, so
 * a torn tail can never fuse with the next record.
 */
function parseInbox(raw: string): InboxRecord[] {
  const records: InboxRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    let record: z.infer<typeof inboxRecordSchema>;
    try {
      record = inboxRecordSchema.parse(JSON.parse(line));
    } catch {
      continue;
    }
    // SAFETY: the inbox is written only by mergeIntoClaim from a BufferEntryState, same boundary as claim bodies.
    const turns = record.turns as BufferTurn[];
    const entry: BufferEntryState = {
      turns,
      lastExtractionAt: record.lastExtractionAt ?? null,
      extractionCount: Number.isFinite(record.extractionCount) ? Number(record.extractionCount) : 0,
    };
    if (record.retainedTurns) {
      // SAFETY: same boundary as the turns above.
      entry.retainedTurns = record.retainedTurns as BufferTurn[];
    }
    records.push({ id: record.id, entry });
  }
  return records;
}

function pendingTurns(entry: BufferEntryState): number {
  return entry.turns.length + (entry.retainedTurns?.length ?? 0);
}

const summarySchema = z.object({
  key: z.string().min(1),
  size: z.number(),
  mtimeMs: z.number(),
  pending: z.number(),
  drained: z.number(),
});

const leaseSchema = z.object({
  ownerId: z.string().min(1),
  pid: z.number().optional(),
  host: z.string().optional(),
  acquiredAt: z.string().optional(),
  heartbeatAt: z.string(),
  leaseMs: z.number(),
});

function parseLease(raw: string): DrainLease | null {
  let lease: z.infer<typeof leaseSchema>;
  try {
    lease = leaseSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
  return {
    ownerId: lease.ownerId,
    pid: lease.pid ?? 0,
    host: lease.host ?? "",
    acquiredAt: lease.acquiredAt ?? lease.heartbeatAt,
    heartbeatAt: lease.heartbeatAt,
    leaseMs: lease.leaseMs,
  };
}
function leaseBelongsToProcess(lease: DrainLease | null, ownerId: string): boolean {
  return lease !== null && lease.ownerId === ownerId && lease.pid === process.pid && lease.host === hostname();
}


/** Hand-in log beside a claim body; `.jsonl`, so claim-directory scans (`.json`) never mistake it for a claim. */
const INBOX_SUFFIX = ".inbox.jsonl";
/** Cached turn counts beside a claim body (see `ClaimSummary`). */
const COUNT_SUFFIX = ".count";

/** Claim bodies `listPage` may read per requested entry: bounds one scan's
 *  I/O even when the directory is mostly empty tombstones. */
const LIST_PAGE_SCAN_FACTOR = 8;

export class BufferDrainClaims {
  constructor(
    private readonly stateDir: string,
    private readonly io: BufferFileIo,
  ) {}

  private get dir(): string {
    return path.join(this.stateDir, "buffer", "drain");
  }

  private fileFor(key: string): string {
    return path.join(this.dir, bufferSessionFileName(key));
  }

  private leaseFileFor(key: string): string {
    return `${this.fileFor(key)}.lease.json`;
  }

  private lockFileFor(key: string): string {
    return `${this.fileFor(key)}.lock`;
  }

  /** Append-only hand-in log next to the body (see the file header). */
  private inboxFor(key: string): string {
    return `${this.fileFor(key)}${INBOX_SUFFIX}`;
  }

  /** Sync existence check for hot-path gates (`SmartBuffer.isSessionClaimed`). */
  isClaimed(key: string): boolean {
    return existsSync(this.fileFor(key));
  }

  /** Test + CLI seam: the lease file path for direct inspection. */
  leasePathForTest(key: string): string {
    return this.leaseFileFor(key);
  }

  private async readClaimBody(key: string): Promise<DrainClaimFile | null> {
    try {
      return parseBody(await this.io.read(this.fileFor(key)));
    } catch {
      return null;
    }
  }

  /**
   * Every inbox record, oldest first. Only "no inbox" reads as empty: any
   * other failure (a locked or undecryptable store) propagates, because a
   * compaction that mistook an unreadable inbox for an empty one would delete
   * the handed-in turns.
   */
  private async readInbox(key: string): Promise<InboxRecord[]> {
    try {
      return parseInbox(await this.io.read(this.inboxFor(key)));
    } catch (err) {
      if (isErrnoCode(err, "ENOENT")) return [];
      throw err;
    }
  }

  /**
   * The body with its inbox folded in, plus the ids of every record the inbox
   * holds (what a compaction must list as consumed). The inbox is read BEFORE
   * the body: a compaction landing between the two reads leaves records the
   * newer body already lists, which the fold skips by id, whereas the reverse
   * order could pair an old body with a deleted inbox and lose their turns.
   */
  private async readFolded(key: string): Promise<{ claim: DrainClaimFile; consumed: string[] } | null> {
    const records = await this.readInbox(key);
    const body = await this.readClaimBody(key);
    if (!body) return null;
    return { claim: foldRecords(body, records), consumed: records.map((record) => record.id) };
  }

  /** The claim content for `key` (body plus inbox), or null when it is not claimed. */
  async load(key: string): Promise<DrainClaimFile | null> {
    return (await this.readFolded(key))?.claim ?? null;
  }

  /**
   * Rewrite the body from a folded claim and consume the inbox it folded.
   * Order is the crash contract: body first (it lists `consumed` so a replay
   * skips them), then the summary, then the inbox delete. Callers hold the
   * claim lock, so no append can land between the read and the delete.
   */
  private async writeClaimBody(key: string, claim: DrainClaimFile, consumed: readonly string[] = []): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const bodyPath = this.fileFor(key);
    const foldedRecords = consumed.length > 0 ? [...consumed] : undefined;
    await this.io.write(bodyPath, JSON.stringify({ ...claim, key, foldedRecords }));
    await stat(bodyPath).then((identity) => this.writeSummary(bodyPath, claim, identity), () => {});
    await unlink(this.inboxFor(key)).catch(() => {});
  }

  /**
   * Best-effort: a missing or stale summary only costs one body parse.
   * `identity` MUST come from a stat taken before `claim` was read (or while
   * the lock holds the body still), never after, or the counts could be
   * tagged with a newer body's identity.
   */
  private async writeSummary(bodyPath: string, claim: DrainClaimFile, identity: { size: number; mtimeMs: number }): Promise<ClaimSummary> {
    const summary: ClaimSummary = {
      key: claim.key,
      size: identity.size,
      mtimeMs: identity.mtimeMs,
      pending: pendingTurns(claim.entry),
      drained: (claim.drained?.length ?? 0) + (claim.drainedRetained?.length ?? 0),
    };
    try {
      await writeFile(`${bodyPath}${COUNT_SUFFIX}`, JSON.stringify(summary));
    } catch (err) {
      log.debug(`buffer drain: claim summary write skipped for ${claim.key}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return summary;
  }

  /**
   * Turn counts of the BODY at `bodyPath` without parsing it: the summary file
   * is trusted only while the body's size and mtime still match the ones it
   * was written against; otherwise the body is parsed once and the summary
   * refreshed. Null when the claim body is absent or unreadable.
   */
  private async readSummary(bodyPath: string): Promise<ClaimSummary | null> {
    let identity;
    try {
      identity = await stat(bodyPath);
    } catch {
      return null;
    }
    try {
      const cached = summarySchema.parse(JSON.parse(await readFile(`${bodyPath}${COUNT_SUFFIX}`, "utf8")));
      if (cached.size === identity.size && cached.mtimeMs === identity.mtimeMs) return cached;
    } catch {
      // No usable summary: fall through to the body.
    }
    let claim: DrainClaimFile | null;
    try {
      claim = parseBody(await this.io.read(bodyPath));
    } catch (err) {
      log.debug(`buffer drain: skipping unreadable claim file ${path.basename(bodyPath)}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    return claim ? await this.writeSummary(bodyPath, claim, identity) : null;
  }

  private async readLease(key: string): Promise<DrainLease | null> {
    try {
      return parseLease(await this.io.read(this.leaseFileFor(key)));
    } catch {
      return null;
    }
  }

  private async writeLease(key: string, lease: DrainLease): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await this.io.write(this.leaseFileFor(key), JSON.stringify(lease));
  }

  /**
   * Atomically move a session's persisted file into a claim. The rename is
   * the handover: after it settles the turns exist ONLY as a claim, so no
   * crash window can lose them or leave them in both places. Callers that
   * lose the race (`already_claimed`) simply skip the key.
   *
   * The whole handover runs under the claim's mutation lock, so a claim
   * create can never land on top of an existing claim (POSIX rename would
   * silently replace it) and the lease write cannot race an adopter.
   */
  async claimFromSessionFile(key: string, lease: DrainLease): Promise<ClaimFromSessionOutcome> {
    await mkdir(this.dir, { recursive: true });
    const sessionPath = path.join(this.stateDir, "buffer", bufferSessionFileName(key));
    if (existsSync(sessionPath)) {
      // Advisory pre-read: an empty live session belongs to its owner, not
      // the drain. A turn landing between this read and the rename is fine —
      // the rename moves whatever is there and the claim drains it.
      try {
        const seeded = parseBody(await this.io.read(sessionPath));
        if (seeded && seeded.entry.turns.length === 0 && (seeded.entry.retainedTurns?.length ?? 0) === 0) {
          return "empty";
        }
      } catch {
        // Unreadable live file: proceed with the rename and let the claim
        // path report it loudly, like the loader skips corrupt files.
      }
    }
    return await withHeldFileLock(
      this.lockFileFor(key),
      { staleMs: CLAIM_LOCK_STALE_MS, maxWaitMs: CLAIM_LOCK_MAX_WAIT_MS },
      async (acquired) => {
        if (!acquired) return "already_claimed";
        // Under the lock the claim check is authoritative: an existing claim
        // keeps its content and its lease; the session file stays with its
        // owner (their next save merges into the claim).
        if (this.isClaimed(key)) return "already_claimed";
        // No claim exists, so an inbox here is an orphan from a crash between
        // a release's deletes: the new claim must not replay it.
        await unlink(this.inboxFor(key)).catch(() => {});
        try {
          await rename(sessionPath, this.fileFor(key));
        } catch (err) {
          // The session file is gone: either it never existed, or another
          // drainer claimed it first.
          if (!existsSync(sessionPath)) {
            if (this.isClaimed(key)) return "already_claimed";
            return "empty";
          }
          throw err;
        }
        const claim = await this.readClaimBody(key);
        if (!claim || pendingTurns(claim.entry) === 0) {
          // Empty content: nothing to drain. Delete the moved file so the
          // empty entry keeps living with its owner, not as a stale claim.
          await unlink(this.fileFor(key)).catch(() => {});
          return "empty";
        }
        await stat(this.fileFor(key)).then((identity) => this.writeSummary(this.fileFor(key), claim, identity), () => {});
        await this.writeLease(key, lease);
        return "claimed";
      },
    );
  }

  /**
   * Take over a claim whose lease is missing, expired, or whose owner died.
   * The whole judgement runs under the claim's mutation lock and re-reads
   * the lease inside it, so exactly one concurrent adopter wins: the loser
   * re-reads the winner's fresh lease and reports "busy" instead of
   * unlinking it. A lease whose owner died is taken over in the same call.
   */
  async adopt(key: string, lease: DrainLease): Promise<AdoptOutcome> {
    if (!this.isClaimed(key)) return "busy";
    return await withHeldFileLock(
      this.lockFileFor(key),
      { staleMs: CLAIM_LOCK_STALE_MS, maxWaitMs: CLAIM_LOCK_MAX_WAIT_MS },
      async (acquired) => {
        if (!acquired) return "busy";
        const existing = await this.readLease(key);
        if (existing?.ownerId === lease.ownerId && existing.pid === lease.pid && existing.host === lease.host) {
          // Reuse the token only from the same process identity.
          await this.writeLease(key, { ...existing, heartbeatAt: new Date().toISOString(), leaseMs: lease.leaseMs });
          return "adopted";
        }
        if (existing && !isLeaseExpired(existing)) {
          if (isOwnerAlive(existing)) return "busy";
          // The owner died without releasing the claim (killed worker):
          // take it over now instead of waiting for the lease to expire.
          await unlink(this.leaseFileFor(key)).catch(() => {});
        } else if (existing) {
          // Expired lease: clear it before the exclusive create. We hold the
          // lock, so no concurrent adopter can interleave its own unlink/create.
          await unlink(this.leaseFileFor(key)).catch(() => {});
        }
        try {
          await writeFile(this.leaseFileFor(key), JSON.stringify(lease), { flag: "wx" });
        } catch (err) {
          // The lease file exists: another drainer took it first.
          if (existsSync(this.leaseFileFor(key))) return "busy";
          throw err;
        }
        return "adopted";
      },
    );
  }

  /**
   * Hand a live owner's in-memory entry to the claim (the path a buffer owner
   * takes instead of persisting a claimed session): ONE append to the inbox,
   * O(incoming), never a read or rewrite of the claim body. Readers fold the
   * inbox over the body with the identity-aware merge and the drainer's next
   * progress write compacts it. The lock serializes the append against that
   * compaction, so a record can never land between its read and its delete.
   */
  async mergeIntoClaim(key: string, incoming: BufferEntryState): Promise<void> {
    await withHeldFileLock(this.lockFileFor(key), { staleMs: CLAIM_LOCK_STALE_MS, maxWaitMs: CLAIM_LOCK_MAX_WAIT_MS }, async (acquired) => {
      if (!acquired) {
        // Never fall back to a session-file write behind a held claim lock:
        // that would resurrect claimed turns. Fail so the owner's save stays
        // pending and retries (SmartBuffer keeps pending state on failure).
        throw new Error(`buffer drain claim for ${key} is busy; retrying the save later`);
      }
      // The claim vanished (acked between the isClaimed check and now):
      // nothing to hand over; the drain already owns everything.
      if (!this.isClaimed(key)) return;
      // Leading newline: a torn tail from a kill mid-append ends at this
      // record's newline instead of fusing into it.
      await this.io.append(this.inboxFor(key), `\n${JSON.stringify({ id: randomUUID(), key, ...incoming })}`);
    });
  }

  /** Drainer progress: replace the claim content with what is left to do.
   *
   * Fenced: `ownerId` must still match the claim's lease (checked under the
   * same lock), so a drainer that lost its lease cannot write progress that
   * would restore turns the new owner already extracted.
   *
   * `seen` is the entry the drainer LOADED (its snapshot of the claim). Only
   * turns that were in that snapshot and are absent from BOTH of the
   * drainer's lists were actually extracted and move to the tombstones — a
   * turn the drainer moved into `entry.retainedTurns` is retained for retry,
   * not extracted. Turns a live owner merged into the claim afterwards stay
   * pending. Without `seen` the pre-existing behavior is kept (every claim
   * turn missing from `entry` counts as extracted).
   */
  async writeEntry(key: string, ownerId: string, entry: BufferEntryState, seen?: BufferEntryState): Promise<void> {
    await withHeldFileLock(this.lockFileFor(key), { staleMs: CLAIM_LOCK_STALE_MS, maxWaitMs: CLAIM_LOCK_MAX_WAIT_MS }, async (acquired) => {
      if (!acquired) throw new Error(`buffer drain claim for ${key} is busy; progress write skipped`);
      const lease = await this.readLease(key);
      if (!leaseBelongsToProcess(lease, ownerId)) {
        throw new Error(`buffer drain claim for ${key} is no longer owned by ${ownerId}; progress write skipped`);
      }
      const folded = await this.readFolded(key);
      if (!folded) return;
      const { claim, consumed } = folded;
      const seenTurns = seen?.turns ?? claim.entry.turns;
      const seenRetained = seen?.retainedTurns ?? claim.entry.retainedTurns ?? [];
      const entryRetained = entry.retainedTurns ?? [];
      const seenActiveCounts = turnCounts(seenTurns);
      const seenRetainedCounts = turnCounts(seenRetained);
      const activeOutputCounts = turnCounts(entry.turns);
      const retainedOutputCounts = turnCounts(entryRetained);
      const matchedActiveCounts = new Map<string, number>();
      const matchedRetainedCounts = new Map<string, number>();
      const ambiguousIdentities = new Set<string>();
      const identityKeys = new Set([
        ...seenActiveCounts.keys(),
        ...seenRetainedCounts.keys(),
      ]);
      const crossedCounts = new Map<string, number>();
      for (const identity of identityKeys) {
        const seenActive = seenActiveCounts.get(identity) ?? 0;
        const seenRetainedCount = seenRetainedCounts.get(identity) ?? 0;
        const activeOutput = activeOutputCounts.get(identity) ?? 0;
        const retainedOutput = retainedOutputCounts.get(identity) ?? 0;
        if (seenActive > 0 && seenRetainedCount > 0 && activeOutput + retainedOutput > 0) {
          // Equal identities across source lists cannot reveal which original
          // occurrence survived a cross-list move. Keep both source lists
          // pending until a later progress write removes every copy.
          matchedActiveCounts.set(identity, seenActive);
          matchedRetainedCounts.set(identity, seenRetainedCount);
          ambiguousIdentities.add(identity);
          continue;
        }
        const matchedActive = Math.min(seenActive, activeOutput);
        const matchedRetained = Math.min(seenRetainedCount, retainedOutput);
        const activeMovedToRetained = Math.min(
          seenActive - matchedActive,
          retainedOutput - matchedRetained,
        );
        const retainedMovedToActive = Math.min(
          seenRetainedCount - matchedRetained,
          activeOutput - matchedActive,
        );
        matchedActiveCounts.set(identity, matchedActive + activeMovedToRetained);
        matchedRetainedCounts.set(identity, matchedRetained + retainedMovedToActive);
        const crossed = activeMovedToRetained + retainedMovedToActive;
        if (crossed > 0) crossedCounts.set(identity, crossed);
      }
      // A pending copy that crossed lists stays tombstoned in its ORIGINAL
      // list too once it is extracted. A copy that crosses back is home again.
      const moved = [...(claim.movedTurns ?? [])];
      for (const [identity, crossed] of crossedCounts) {
        let returned = 0;
        while (returned < crossed && removeOneByIdentity(moved, identity)) returned += 1;
        moved.push(...takeByIdentity([...seenTurns, ...seenRetained], identity, crossed - returned));
      }
      const extractedActive: BufferTurn[] = [];
      appendUnmatched(seenTurns, matchedActiveCounts, extractedActive);
      const extractedRetained: BufferTurn[] = [];
      appendUnmatched(seenRetained, matchedRetainedCounts, extractedRetained);
      const drained = [...(claim.drained ?? []), ...extractedActive];
      const drainedRetained = [...(claim.drainedRetained ?? []), ...extractedRetained];
      for (const turn of extractedActive) {
        if (removeOneByIdentity(moved, bufferTurnIdentityKey(turn))) drainedRetained.push(turn);
      }
      for (const turn of extractedRetained) {
        if (removeOneByIdentity(moved, bufferTurnIdentityKey(turn))) drained.push(turn);
      }
      // Source occurrences of an ambiguous identity are restored BEFORE late
      // arrivals are appended, so a late equal turn cannot stand in for them.
      const keptTurns = [...entry.turns];
      const keptRetained = [...entryRetained];
      for (const identity of ambiguousIdentities) {
        preserveSourceOccurrences(keptTurns, seenTurns, identity);
        preserveSourceOccurrences(keptRetained, seenRetained, identity);
      }
      const late = subtractBufferTurns(claim.entry.turns, seenTurns);
      const lateRetained = subtractBufferTurns(claim.entry.retainedTurns ?? [], seenRetained);
      const next: BufferEntryState = { ...entry, turns: [...keptTurns, ...late] };
      const nextRetained = [...keptRetained, ...lateRetained];
      if (nextRetained.length > 0) next.retainedTurns = nextRetained;
      await this.writeClaimBody(key, {
        ...claim,
        entry: next,
        drained,
        drainedRetained,
        movedTurns: moved.length > 0 ? moved : undefined,
      }, consumed);
    });
  }

  /** Extend the lease. "lost" means another drainer took the claim over.
   * Serialized on the claim lock so a stale heartbeat can never overwrite a
   * new owner's lease mid-takeover; a contended lock just skips this tick
   * (usually the drainer's own progress write holds it). */
  async heartbeat(key: string, ownerId: string, leaseMs: number): Promise<"ok" | "lost"> {
    return await withHeldFileLock(this.lockFileFor(key), { staleMs: CLAIM_LOCK_STALE_MS, maxWaitMs: CLAIM_LOCK_MAX_WAIT_MS }, async (acquired) => {
      if (!acquired) return "ok";
      const lease = await this.readLease(key);
      if (!lease || !leaseBelongsToProcess(lease, ownerId)) return "lost";
      await this.writeLease(key, { ...lease, heartbeatAt: new Date().toISOString(), leaseMs });
      return "ok";
    });
  }

  /** Give the key back (content stays; the next run resumes it). */
  async releaseLease(key: string, ownerId: string): Promise<void> {
    await withHeldFileLock(
      this.lockFileFor(key),
      { staleMs: CLAIM_LOCK_STALE_MS, maxWaitMs: CLAIM_LOCK_MAX_WAIT_MS },
      async (acquired) => {
        if (!acquired) return;
        const lease = await this.readLease(key);
        if (!leaseBelongsToProcess(lease, ownerId)) return;
        await unlink(this.leaseFileFor(key)).catch(() => {});
      },
    );
  }

  /**
   * Finish a claim: only its owner may ack, and only when nothing is left to
   * extract. Non-empty claims stay (deferred content is never dropped here).
   */
  async ack(key: string, ownerId: string): Promise<AckOutcome> {
    return await withHeldFileLock(
      this.lockFileFor(key),
      { staleMs: CLAIM_LOCK_STALE_MS, maxWaitMs: CLAIM_LOCK_MAX_WAIT_MS },
      async (acquired) => {
        if (!acquired) return "busy";
        const lease = await this.readLease(key);
        if (!leaseBelongsToProcess(lease, ownerId)) return "busy";
        const folded = await this.readFolded(key);
        if (!folded) {
          await unlink(this.leaseFileFor(key)).catch(() => {});
          return "acked";
        }
        // Compact here too: a claim whose inbox only repeats drained turns
        // would otherwise keep reading as unfinished forever.
        if (folded.consumed.length > 0) await this.writeClaimBody(key, folded.claim, folded.consumed);
        if (pendingTurns(folded.claim.entry) > 0) return "not_empty";
        // Keep the empty claim as a tombstone until its live owner consumes it.
        await unlink(this.leaseFileFor(key)).catch(() => {});
        return "acked";
      },
    );
  }

  /** Return extracted identities with their active/retained provenance intact. */
  async drainedTurns(key: string): Promise<DrainedTurnSets> {
    const claim = await this.readClaimBody(key);
    return {
      turns: claim?.drained ?? [],
      retainedTurns: claim?.drainedRetained ?? [],
    };
  }

  /** Return this lease owner's progress, fenced against claim takeover. */
  async drainedTurnsForOwner(key: string, ownerId: string): Promise<DrainedTurnSets | null> {
    return await withHeldFileLock(
      this.lockFileFor(key),
      { staleMs: CLAIM_LOCK_STALE_MS, maxWaitMs: CLAIM_LOCK_MAX_WAIT_MS },
      async (acquired) => {
        if (!acquired) throw new Error(`buffer drain claim for ${key} is busy; cannot reconcile progress`);
        const lease = await this.readLease(key);
        if (!leaseBelongsToProcess(lease, ownerId)) return null;
        const claim = await this.readClaimBody(key);
        return claim ? { turns: claim.drained ?? [], retainedTurns: claim.drainedRetained ?? [] } : null;
      }
    );
  }

  /**
   * Is the drain for `key` FINISHED (acked): the claim holds extracted turns
   * and nothing pending, and the drainer dropped its lease. A claim with
   * partial progress or a live lease is still being drained — its owner must
   * merge into it, never release it.
   */
  async isDrained(key: string): Promise<boolean> {
    if ((await this.readLease(key)) !== null) return false;
    // This runs on every hand-over save. The cached counts may only answer
    // FALSE (pending turns, nothing drained): a stale cache in that direction
    // costs a deferred tombstone. They must never answer TRUE, because the
    // caller then releases the claim and unlinks whatever is still pending, and
    // a same-size rewrite inside one mtime tick can leave a stale cache that
    // says "nothing pending". So a TRUE is verified by one real fold, once per
    // finished drain.
    const summary = await this.readSummary(this.fileFor(key));
    if (!summary || summary.drained === 0 || summary.pending > 0) return false;
    const claim = await this.load(key);
    return claim !== null && (claim.drained?.length ?? 0) + (claim.drainedRetained?.length ?? 0) > 0 && pendingTurns(claim.entry) === 0;
  }

  /** Drop the claim entirely (its owner consumed the tombstone), inbox and summary included. */
  async release(key: string): Promise<void> {
    const bodyPath = this.fileFor(key);
    for (const file of [this.inboxFor(key), bodyPath, `${bodyPath}${COUNT_SUFFIX}`, this.leaseFileFor(key)]) {
      await unlink(file).catch(() => {});
    }
  }

  /** Claim body file names in the drain directory (no leases, inboxes, summaries or locks). */
  private async claimNames(): Promise<string[] | null> {
    try {
      return (await readdir(this.dir)).filter((name) => name.endsWith(".json") && !name.endsWith(".lease.json")).sort();
    } catch (err) {
      // SAFETY: readdir rejects with NodeJS system errors; only the ENOENT
      // (no claims directory yet) case maps to an empty listing.
      if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null;
      throw err;
    }
  }

  /**
   * One claim's listing from its summary plus its inbox: the body is never
   * parsed for a count. While an inbox is unfolded the turn count is an UPPER
   * bound (records can repeat turns the body holds or already drained); the
   * drain that picks the claim up folds exactly and its ack compacts the
   * inbox, so an over-count costs one cheap drain run, never a lost turn.
   */
  private async describeClaim(name: string): Promise<DrainClaimListing | null> {
    const summary = await this.readSummary(path.join(this.dir, name));
    if (!summary) return null;
    let inboxTurns = 0;
    try {
      for (const record of await this.readInbox(summary.key)) inboxTurns += pendingTurns(record.entry);
    } catch (err) {
      log.debug(`buffer drain: skipping claim ${name} with an unreadable inbox: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    const lease = await this.readLease(summary.key);
    return {
      key: summary.key,
      turnCount: summary.pending + inboxTurns,
      leased: lease !== null,
      leaseExpired: lease !== null ? isLeaseExpired(lease) : true,
    };
  }

  /** Every claim with its lease state (CLI scan + summaries). */
  async list(): Promise<DrainClaimListing[]> {
    const out: DrainClaimListing[] = [];
    for (const name of (await this.claimNames()) ?? []) {
      const listing = await this.describeClaim(name);
      if (listing) out.push(listing);
    }
    return out;
  }

  /**
   * Paged listing for bounded periodic scans: at most `limit` claims with
   * pending turns, starting AFTER `afterName` (a raw entry name returned as
   * `nextCursor` by a previous page — file-name order is stable, so a
   * rotating cursor visits every claim fairly without ever materializing
   * the whole directory's bodies). Empty tombstones never count toward the
   * limit; the number of claims examined per call is bounded separately
   * (`LIST_PAGE_SCAN_FACTOR` per requested entry), and the cursor advances
   * past every scanned name so a long tombstone run is crossed over several
   * pages instead of starving the pending claims behind it.
   */
  async listPage(afterName: string | undefined, limit: number): Promise<{ entries: DrainClaimListing[]; nextCursor?: string }> {
    const names = await this.claimNames();
    if (names === null) return { entries: [] };
    const start = afterName === undefined ? 0 : names.findIndex((name) => name > afterName);
    const out: DrainClaimListing[] = [];
    // The cursor is the LAST CONSUMED entry name: the next page starts
    // strictly after it, so the first unconsumed name is never skipped.
    // Returning the first unconsumed name instead would make every page
    // boundary permanently skip one claim.
    let cursor: string | undefined;
    const scanBudget = Math.max(limit, 1) * LIST_PAGE_SCAN_FACTOR;
    let scanned = 0;
    for (let index = start < 0 ? names.length : start; index < names.length; index += 1) {
      if (out.length >= limit || scanned >= scanBudget) break;
      const name = names[index]!;
      scanned += 1;
      cursor = name;
      const listing = await this.describeClaim(name);
      if (listing && listing.turnCount > 0) out.push(listing);
    }
    return { entries: out, nextCursor: cursor };
  }

  /**
   * Rollback helper: fold every claim's inbox into its body and delete the
   * inboxes, so a build that predates the inbox (it never reads one) sees every
   * handed-in turn. Run it with the daemon stopped, BEFORE downgrading; the
   * same fold is what compaction does, so it is safe to run on a live store.
   * Returns how many inboxes were folded.
   */
  async foldAllInboxes(): Promise<number> {
    let names: string[];
    try {
      names = (await readdir(this.dir)).filter((name) => name.endsWith(INBOX_SUFFIX));
    } catch (err) {
      if (isErrnoCode(err, "ENOENT")) return 0;
      throw err;
    }
    let folded = 0;
    for (const name of names) {
      const claim = await this.readClaimBodyByName(name.slice(0, -INBOX_SUFFIX.length));
      if (!claim) continue;
      folded += await withHeldFileLock(
        this.lockFileFor(claim.key),
        { staleMs: CLAIM_LOCK_STALE_MS, maxWaitMs: CLAIM_LOCK_MAX_WAIT_MS },
        async (acquired) => {
          if (!acquired) throw new Error(`buffer drain claim for ${claim.key} is busy; its inbox was not folded`);
          const current = await this.readFolded(claim.key);
          if (!current) return 0;
          if (current.consumed.length === 0) {
            await unlink(this.inboxFor(claim.key)).catch(() => {});
            return 0;
          }
          await this.writeClaimBody(claim.key, current.claim, current.consumed);
          return 1;
        },
      );
    }
    return folded;
  }

  private async readClaimBodyByName(name: string): Promise<DrainClaimFile | null> {
    try {
      return parseBody(await this.io.read(path.join(this.dir, name)));
    } catch (err) {
      log.debug(`buffer drain: skipping unreadable claim file ${name}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}
