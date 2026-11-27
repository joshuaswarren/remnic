
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { z } from "zod";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { bufferSessionFileName, type BufferFileIo } from "./buffer-session-files.js";
import { HandInMemo } from "./buffer-drain-handin-memo.js";
import { readDrainClaimTotals, type DrainClaimTotals } from "./drain-claim-totals.js";
import { bufferTurnIdentityKey, subtractBufferTurns, type DrainedTurnSets } from "../buffer-turn-helpers.js";
import { log } from "../logger.js";
import { isErrnoCode } from "../utils/errno.js";
import { withHeldFileLock } from "../utils/serialize-mutations.js";
import type { BufferEntryState, BufferTurn } from "../types.js";

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
  /**
   * Oldest pending turn timestamp (ISO) across active + retained turns.
   * Absent in pre-#3442 sidecars; readers must treat that as "unknown", not
   * "fresh" (issue #3442: an invisible backlog must not hide behind a
   * missing field).
   */
  oldestTurnAt?: string;
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

/** Oldest ISO timestamp among `turns`; undefined when none parses (counts stay authoritative regardless). */
function oldestTurnTimestamp(turns: readonly BufferTurn[]): string | undefined {
  let oldest: string | undefined;
  let oldestMs = Number.POSITIVE_INFINITY;
  for (const turn of turns) {
    const parsed = Date.parse(turn.timestamp);
    if (!Number.isFinite(parsed) || parsed >= oldestMs) continue;
    oldestMs = parsed;
    oldest = turn.timestamp;
  }
  return oldest;
}

const summarySchema = z.object({
  key: z.string().min(1),
  size: z.number(),
  mtimeMs: z.number(),
  pending: z.number(),
  drained: z.number(),
  oldestTurnAt: z.string().optional(),
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


const INBOX_SUFFIX = ".inbox.jsonl";
const COUNT_SUFFIX = ".count";
const INBOX_LISTING_PARSE_LIMIT = 1_048_576;
/** Node cannot build a string longer than this; an inbox this big can never be read. */
const INBOX_UNREADABLE_BYTES = 0x1fffffe8;

/** Claim bodies `listPage` may read per requested entry: bounds one scan's
 *  I/O even when the directory is mostly empty tombstones. */
const LIST_PAGE_SCAN_FACTOR = 8;

/** How long `claimTotals` may serve a cached scan to the health path. */
const CLAIM_TOTALS_TTL_MS = 30_000;

export class BufferDrainClaims {
  constructor(
    private readonly stateDir: string,
    private readonly io: BufferFileIo,
  ) {}

  private readonly handIns = new HandInMemo();

  /** Last `claimTotals` scan; the /health path polls per request (#3442). */
  private totalsCache: { atMs: number; totals: DrainClaimTotals } | null = null;

  /**
   * Claimed-backlog totals for liveness surfaces (#3442): sidecars only, no
   * claim-body parse, bounded scan, cached for `ttlMs` (default 30s) so a
   * health poll per request cannot turn into a directory storm. `ttlMs: 0`
   * forces a rescan; `nowMs`/`maxClaims` are test/bounds seams.
   */
  async claimTotals(opts: { ttlMs?: number; maxClaims?: number; nowMs?: number } = {}): Promise<DrainClaimTotals> {
    const nowMs = opts.nowMs ?? Date.now();
    const cached = this.totalsCache;
    if (cached !== null && nowMs - cached.atMs < (opts.ttlMs ?? CLAIM_TOTALS_TTL_MS)) return cached.totals;
    const totals = await readDrainClaimTotals(this.dir, { maxClaims: opts.maxClaims });
    this.totalsCache = { atMs: nowMs, totals };
    return totals;
  }

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

  private async readInbox(key: string): Promise<InboxRecord[]> {
    try {
      return parseInbox(await this.io.read(this.inboxFor(key)));
    } catch (err) {
      if (isErrnoCode(err, "ENOENT")) return [];
      throw err;
    }
  }

  private async readFolded(key: string): Promise<{ claim: DrainClaimFile; consumed: string[] } | null> {
    const records = await this.readInbox(key);
    const body = await this.readClaimBody(key);
    if (!body) return null;
    return { claim: foldRecords(body, records), consumed: records.map((record) => record.id) };
  }

  async load(key: string): Promise<DrainClaimFile | null> {
    return (await this.readFolded(key))?.claim ?? null;
  }

  private async writeClaimBody(key: string, claim: DrainClaimFile, consumed: readonly string[] = []): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const bodyPath = this.fileFor(key);
    const foldedRecords = consumed.length > 0 ? [...consumed] : undefined;
    await this.io.write(bodyPath, JSON.stringify({ ...claim, key, foldedRecords }));
    await stat(bodyPath).then((identity) => this.writeSummary(bodyPath, claim, identity), () => {});
    await unlink(this.inboxFor(key)).catch(() => {});
  }

  private async writeSummary(bodyPath: string, claim: DrainClaimFile, identity: { size: number; mtimeMs: number }): Promise<ClaimSummary> {
    const summary: ClaimSummary = {
      key: claim.key,
      size: identity.size,
      mtimeMs: identity.mtimeMs,
      pending: pendingTurns(claim.entry),
      drained: (claim.drained?.length ?? 0) + (claim.drainedRetained?.length ?? 0),
      oldestTurnAt: oldestTurnTimestamp([...claim.entry.turns, ...(claim.entry.retainedTurns ?? [])]),
    };
    try {
      await writeFile(`${bodyPath}${COUNT_SUFFIX}`, JSON.stringify(summary));
    } catch (err) {
      log.debug(`buffer drain: claim summary write skipped for ${claim.key}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return summary;
  }

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

  async claimFromSessionFile(key: string, lease: DrainLease): Promise<ClaimFromSessionOutcome> {
    await mkdir(this.dir, { recursive: true });
    const sessionPath = path.join(this.stateDir, "buffer", bufferSessionFileName(key));
    if (existsSync(sessionPath)) {
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
        if (this.isClaimed(key)) return "already_claimed";
        await unlink(this.inboxFor(key)).catch(() => {});
        try {
          await rename(sessionPath, this.fileFor(key));
        } catch (err) {
          if (!existsSync(sessionPath)) {
            if (this.isClaimed(key)) return "already_claimed";
            return "empty";
          }
          throw err;
        }
        const claim = await this.readClaimBody(key);
        if (!claim || pendingTurns(claim.entry) === 0) {
          await unlink(this.fileFor(key)).catch(() => {});
          return "empty";
        }
        await stat(this.fileFor(key)).then((identity) => this.writeSummary(this.fileFor(key), claim, identity), () => {});
        await this.writeLease(key, lease);
        return "claimed";
      },
    );
  }

  async adopt(key: string, lease: DrainLease): Promise<AdoptOutcome> {
    if (!this.isClaimed(key)) return "busy";
    return await withHeldFileLock(
      this.lockFileFor(key),
      { staleMs: CLAIM_LOCK_STALE_MS, maxWaitMs: CLAIM_LOCK_MAX_WAIT_MS },
      async (acquired) => {
        if (!acquired) return "busy";
        const existing = await this.readLease(key);
        if (existing?.ownerId === lease.ownerId && existing.pid === lease.pid && existing.host === lease.host) {
          await this.writeLease(key, { ...existing, heartbeatAt: new Date().toISOString(), leaseMs: lease.leaseMs });
          return "adopted";
        }
        if (existing && !isLeaseExpired(existing)) {
          if (isOwnerAlive(existing)) return "busy";
          await unlink(this.leaseFileFor(key)).catch(() => {});
        } else if (existing) {
          await unlink(this.leaseFileFor(key)).catch(() => {});
        }
        try {
          await writeFile(this.leaseFileFor(key), JSON.stringify(lease), { flag: "wx" });
        } catch (err) {
          if (existsSync(this.leaseFileFor(key))) return "busy";
          throw err;
        }
        return "adopted";
      },
    );
  }

  /** The inbox as this process last left it (identity, size, mtime); "absent" when there is none, null when unknown. */
  private async handInStamp(key: string): Promise<string | null> {
    try {
      const inbox = await stat(this.inboxFor(key));
      return `${inbox.ino}:${inbox.size}:${inbox.mtimeMs}`;
    } catch (err) {
      return isErrnoCode(err, "ENOENT") ? "absent" : null;
    }
  }

  async mergeIntoClaim(key: string, incoming: BufferEntryState): Promise<void> {
    await withHeldFileLock(this.lockFileFor(key), { staleMs: CLAIM_LOCK_STALE_MS, maxWaitMs: CLAIM_LOCK_MAX_WAIT_MS }, async (acquired) => {
      if (!acquired) {
        throw new Error(`buffer drain claim for ${key} is busy; retrying the save later`);
      }
      if (!this.isClaimed(key)) return;
      const plan = this.handIns.plan(key, await this.handInStamp(key), incoming);
      if (plan === null) return;
      await this.io.append(this.inboxFor(key), `\n${JSON.stringify({ id: randomUUID(), key, ...plan.record })}`);
      plan.remember(await this.handInStamp(key));
    });
  }

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
        if (folded.consumed.length > 0) await this.writeClaimBody(key, folded.claim, folded.consumed);
        if (pendingTurns(folded.claim.entry) > 0) return "not_empty";
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

  private async describeClaim(name: string): Promise<DrainClaimListing | null> {
    const summary = await this.readSummary(path.join(this.dir, name));
    if (!summary) return null;
    let inboxTurns = 0;
    try {
      const inboxBytes = (await stat(this.inboxFor(summary.key)).catch(() => null))?.size ?? 0;
      if (inboxBytes > INBOX_UNREADABLE_BYTES) throw new Error(`inbox is ${inboxBytes} bytes, too long to read`);
      if (inboxBytes <= INBOX_LISTING_PARSE_LIMIT) {
        for (const record of await this.readInbox(summary.key)) inboxTurns += pendingTurns(record.entry);
      } else if (summary.pending === 0) {
        inboxTurns = 1;
      }
      // A large inbox beside a pending body adds nothing here: the body already makes the claim a candidate.
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

  async list(): Promise<DrainClaimListing[]> {
    const out: DrainClaimListing[] = [];
    for (const name of (await this.claimNames()) ?? []) {
      const listing = await this.describeClaim(name);
      if (listing) out.push(listing);
    }
    return out;
  }

  async listPage(afterName: string | undefined, limit: number): Promise<{ entries: DrainClaimListing[]; nextCursor?: string }> {
    const names = await this.claimNames();
    if (names === null) return { entries: [] };
    const start = afterName === undefined ? 0 : names.findIndex((name) => name > afterName);
    const out: DrainClaimListing[] = [];
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
