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
 *
 * Invariants (see the buffer-drain PR for the full protocol):
 *   - At every instant the claim content file holds exactly the turns whose
 *     extraction is not durably finished, so a kill at any point loses
 *     nothing and the next run resumes.
 *   - A live buffer owner that must persist a claimed session hands its
 *     in-memory entry INTO the claim (merge, identity-deduped) instead of
 *     writing a session file — it can never resurrect claimed turns.
 *   - Claims are idempotent: re-claiming, double-draining, and two
 *     concurrent drainers are all safe (atomic rename + exclusive lease).
 *
 * All content reads/writes go through the storage's secure file I/O
 * (`BufferFileIo`); only lease/existence checks touch raw paths, and claim
 * rewrites serialize on a cross-process held file lock.
 */

import { hostname } from "node:os";
import { z } from "zod";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { bufferSessionFileName, type BufferFileIo } from "./buffer-session-files.js";
import { bufferTurnsEqual } from "../buffer-turn-helpers.js";
import { log } from "../logger.js";
import { withHeldFileLock } from "../utils/serialize-mutations.js";
import type { BufferEntryState, BufferTurn } from "../types.js";

/** Result of persisting one session's entry. */
export interface BufferSessionSaveOutcome {
  /** "saved": the session file holds the entry. "handed_over": the entry moved into a drain claim. */
  status: "saved" | "handed_over";
  /** Turns a drain already extracted (claim tombstone): the owner subtracts them from its copy. */
  drainedTurns?: BufferTurn[];
}

export interface DrainLease {
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

/** Identity-dedupe `incoming` turns into `existing` (they are the same turns a
 * live owner still held after claiming; only genuinely NEW turns append). */
function mergeTurns<T>(existing: T[], incoming: readonly T[], isEqual: (a: T, b: T) => boolean): T[] {
  const merged = [...existing];
  for (const turn of incoming) {
    if (merged.some((kept) => isEqual(kept, turn))) continue;
    merged.push(turn);
  }
  return merged;
}

function mergeEntries(claim: DrainClaimFile, incoming: BufferEntryState): DrainClaimFile {
  const entry = emptyEntry();
  entry.turns = mergeTurns(claim.entry.turns, incoming.turns, bufferTurnsEqual);
  const retained = [...(claim.entry.retainedTurns ?? []), ...(incoming.retainedTurns ?? [])];
  // SAFETY: an empty accumulator of the same element type.
  const dedupedRetained = mergeTurns([] as typeof retained, retained, bufferTurnsEqual);
  if (dedupedRetained.length > 0) entry.retainedTurns = dedupedRetained;
  const stamps = [claim.entry.lastExtractionAt, incoming.lastExtractionAt].filter(
    (value): value is string => value !== null && value !== undefined,
  );
  entry.lastExtractionAt = stamps.sort().at(-1) ?? null;
  entry.extractionCount = Math.max(claim.entry.extractionCount, incoming.extractionCount);
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
  return claim;
}

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

  /** The claim content for `key`, or null when the key is not claimed. */
  load(key: string): Promise<DrainClaimFile | null> {
    return this.readClaimBody(key);
  }

  private async writeClaimBody(key: string, claim: DrainClaimFile): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await this.io.write(this.fileFor(key), JSON.stringify({ ...claim, key }));
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
    if (this.isClaimed(key) && (await this.readLease(key)) !== null) {
      // A claim file already existed before this rename landed (a stale
      // session file reappeared beside an orphan claim): never stack a second
      // owner's lease on a claim another process may be draining.
      return "already_claimed";
    }
    const claim = await this.readClaimBody(key);
    if (!claim || claim.entry.turns.length === 0 && (claim.entry.retainedTurns?.length ?? 0) === 0) {
      // Empty content: nothing to drain. Delete the moved file so the empty
      // entry keeps living with its owner, not as a stale claim.
      await unlink(this.fileFor(key)).catch(() => {});
      return "empty";
    }
    await this.writeLease(key, lease);
    return "claimed";
  }

  /**
   * Take over a claim whose lease is missing or expired. The takeover is an
   * exclusive-create lease write, so concurrent adopters resolve atomically.
   */
  async adopt(key: string, lease: DrainLease): Promise<AdoptOutcome> {
    if (!this.isClaimed(key)) return "busy";
    const existing = await this.readLease(key);
    if (existing && !isLeaseExpired(existing) && !isOwnerAlive(existing)) {
      // The owner died without releasing the claim (killed worker): take it
      // over now instead of waiting for the lease to expire.
      await unlink(this.leaseFileFor(key)).catch(() => {});
    } else if (existing && existing.ownerId === lease.ownerId) {
      // The same drainer already holds it: renew the lease.
      await this.writeLease(key, { ...existing, heartbeatAt: new Date().toISOString(), leaseMs: lease.leaseMs });
      return "adopted";
    }
    if (existing && !isLeaseExpired(existing)) return "busy";
    if (existing) {
      // Expired lease: clear it, then exclusive-create decides the race
      // between concurrent adopters of the same stale claim.
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
  }

  /**
   * Merge a live owner's in-memory entry INTO the claim (the handover path a
   * buffer owner takes instead of persisting a claimed session). Serialized
   * against drainer progress writes on the same lock.
   */
  async mergeIntoClaim(key: string, incoming: BufferEntryState): Promise<void> {
    await withHeldFileLock(this.lockFileFor(key), { staleMs: CLAIM_LOCK_STALE_MS, maxWaitMs: CLAIM_LOCK_MAX_WAIT_MS }, async (acquired) => {
      if (!acquired) {
        // Never fall back to a session-file write behind a held claim lock:
        // that would resurrect claimed turns. Fail so the owner's save stays
        // pending and retries (SmartBuffer keeps pending state on failure).
        throw new Error(`buffer drain claim for ${key} is busy; retrying the save later`);
      }
      const claim = await this.readClaimBody(key);
      if (!claim) {
        // The claim vanished (acked between the isClaimed check and now):
        // nothing to hand over; the drain already owns everything.
        return;
      }
      await this.writeClaimBody(key, mergeEntries(claim, incoming));
    });
  }

  /** Drainer progress: replace the claim content with what is left to do. */
  async writeEntry(key: string, entry: BufferEntryState): Promise<void> {
    await withHeldFileLock(this.lockFileFor(key), { staleMs: CLAIM_LOCK_STALE_MS, maxWaitMs: CLAIM_LOCK_MAX_WAIT_MS }, async (acquired) => {
      if (!acquired) throw new Error(`buffer drain claim for ${key} is busy; progress write skipped`);
      const claim = await this.readClaimBody(key);
      if (!claim) return;
      // Progress: the turns that vanished from the entry were extracted.
      const drained = [...(claim.drained ?? [])];
      for (const turn of claim.entry.turns) {
        if (entry.turns.some((kept) => bufferTurnsEqual(kept, turn))) continue;
        if (drained.some((gone) => bufferTurnsEqual(gone, turn))) continue;
        drained.push(turn);
      }
      await this.writeClaimBody(key, { ...claim, entry, drained });
    });
  }

  /** Extend the lease. "lost" means another drainer took the claim over. */
  async heartbeat(key: string, ownerId: string, leaseMs: number): Promise<"ok" | "lost"> {
    const lease = await this.readLease(key);
    if (!lease || lease.ownerId !== ownerId) return "lost";
    await this.writeLease(key, { ...lease, heartbeatAt: new Date().toISOString(), leaseMs });
    return "ok";
  }

  /** Give the key back (content stays; the next run resumes it). */
  async releaseLease(key: string, ownerId: string): Promise<void> {
    const lease = await this.readLease(key);
    if (!lease || lease.ownerId !== ownerId) return;
    await unlink(this.leaseFileFor(key)).catch(() => {});
  }

  /**
   * Finish a claim: only its owner may ack, and only when nothing is left to
   * extract. Non-empty claims stay (deferred content is never dropped here).
   */
  async ack(key: string, ownerId: string): Promise<AckOutcome> {
    const lease = await this.readLease(key);
    if (!lease || lease.ownerId !== ownerId) return "busy";
    const claim = await this.readClaimBody(key);
    if (!claim) {
      await unlink(this.leaseFileFor(key)).catch(() => {});
      return "acked";
    }
    if (claim.entry.turns.length > 0 || (claim.entry.retainedTurns?.length ?? 0) > 0) return "not_empty";
    // Keep the (empty) claim file as a TOMBSTONE: a live buffer owner that
    // still holds a stale copy subtracts the drained turns instead of
    // writing them back. The owner consumes the tombstone on its next save.
    await unlink(this.leaseFileFor(key)).catch(() => {});
    return "acked";
  }

  /** The turns a drain already extracted for `key` (tombstone content). */
  async drainedTurns(key: string): Promise<BufferTurn[]> {
    const claim = await this.readClaimBody(key);
    return claim?.drained ?? [];
  }

  /** Drop the claim file entirely (its owner consumed the tombstone). */
  async release(key: string): Promise<void> {
    await unlink(this.fileFor(key)).catch(() => {});
    await unlink(this.leaseFileFor(key)).catch(() => {});
  }

  /** Every claim with its lease state (CLI scan + summaries). */
  async list(): Promise<DrainClaimListing[]> {
    let names: string[];
    try {
      names = (await readdir(this.dir)).filter((name) => name.endsWith(".json") && !name.endsWith(".lease.json"));
    } catch (err) {
      // SAFETY: the value comes from this module's own write path; the shape is checked above.
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
      throw err;
    }
    const out: DrainClaimListing[] = [];
    for (const name of names) {
      const claim = await this.readClaimBodyByKey(name);
      if (!claim) continue;
      const lease = await this.readLease(claim.key);
      out.push({
        key: claim.key,
        turnCount: claim.entry.turns.length + (claim.entry.retainedTurns?.length ?? 0),
        leased: lease !== null,
        leaseExpired: lease !== null ? isLeaseExpired(lease) : true,
      });
    }
    return out;
  }

  private async readClaimBodyByKey(name: string): Promise<DrainClaimFile | null> {
    try {
      return parseBody(await this.io.read(path.join(this.dir, name)));
    } catch (err) {
      log.debug(`buffer drain: skipping unreadable claim file ${name}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}
