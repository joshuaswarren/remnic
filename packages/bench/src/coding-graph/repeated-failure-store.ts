import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readlinkSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { writeFileAtomically } from "@remnic/core/maintenance/atomic-file";
import { z } from "zod";
import { compareCodePoints } from "../codepoint-order.js";
import { resolveContainedPath } from "../filename-safety.js";
import { serializeJsonl } from "../leaderboard-export.js";
import {
  assertValidIdentity,
  assertValidTry,
  buildRepeatedFailureRowKey,
  canonicalJson,
  exhaustedEpisode,
  normalizeIdentity,
  normalizeTry,
  parseCheckpoint,
  projectTerminalRow,
  serializeCheckpoint,
} from "./repeated-failure-store-records.js";
import type {
  RepeatedFailureCheckpointLoadResult,
  RepeatedFailureEpisodeRow,
  RepeatedFailureRowCheckpoint,
  RepeatedFailureRowIdentity,
  RepeatedFailureTry,
} from "./repeated-failure-types.js";
export {
  buildRepeatedFailureRowKey,
  parseRepeatedFailureEpisodeRow,
  writeRepeatedFailureRunMetadata,
} from "./repeated-failure-store-records.js";

const DEFAULT_CLAIM_WAIT_TIMEOUT_MS = 30_000;
// Lease must outlast the worst-case row: six attempts at the 180s request
// timeout is 18 minutes of wall clock. The heartbeat timer is unref'd, so it
// cannot be relied on to refresh the lease while a request is hung — the lease
// itself has to cover the full retry budget or the row loses its claim
// mid-flight and the run dies with "Claim token does not own".
const DEFAULT_CLAIM_LEASE_MS = 30 * 60_000;
const DEFAULT_CLAIM_HEARTBEAT_MS = 5_000;
const DEFAULT_COMMIT_LEASE_MS = 30 * 60_000;
const DEFAULT_RECLAIM_GUARD_LEASE_MS = 30_000;
const PROCESS_HOST_HASH = createHash("sha256").update(hostname()).digest("hex");
const ClaimRowKeySchema = z.string().regex(/^h6-row-v1-[a-f0-9]{64}$/);
const ClaimOwnerTokenSchema = z.string().uuid();

interface ClaimLockEntry {
  canonical: boolean;
  rowKey: string;
}

function parseClaimLockEntryName(name: string): ClaimLockEntry | undefined {
  const lockMarker = ".lock";
  const markerIndex = name.indexOf(lockMarker);
  if (markerIndex < 0) return undefined;
  const rowKey = name.slice(0, markerIndex);
  if (!ClaimRowKeySchema.safeParse(rowKey).success) return undefined;
  const suffix = name.slice(markerIndex);
  if (suffix === lockMarker) return { canonical: true, rowKey };
  if (
    suffix === `${lockMarker}.stale`
    || suffix === `${lockMarker}.reclaiming`
    || suffix === `${lockMarker}.reclaiming.stale`
  ) {
    return { canonical: false, rowKey };
  }
  let releaseToken: string | undefined;
  if (suffix.startsWith(".lock.release-")) {
    releaseToken = suffix.slice(".lock.release-".length);
  } else if (suffix.startsWith(".lock.reclaiming.release-")) {
    releaseToken = suffix.slice(".lock.reclaiming.release-".length);
  }
  return releaseToken !== undefined && ClaimOwnerTokenSchema.safeParse(releaseToken).success
    ? { canonical: false, rowKey }
    : undefined;
}

function readProcessStartId(pid: number): string | undefined {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
    const startId = fields[19];
    return startId && /^\d+$/.test(startId) ? startId : undefined;
  } catch {
    return undefined;
  }
}

const PROCESS_START_ID = readProcessStartId(process.pid);
const PROCESS_PID_NAMESPACE_HASH = (() => {
  try {
    return createHash("sha256").update(readlinkSync("/proc/self/ns/pid")).digest("hex");
  } catch {
    return undefined;
  }
})();

const ClaimOwnerSchema = z.object({
  schemaVersion: z.literal(1),
  rowKey: ClaimRowKeySchema,
  ownerToken: ClaimOwnerTokenSchema,
  leaseMs: z.number().int().positive().max(24 * 60 * 60_000),
  pid: z.number().int().positive(),
  hostHash: z.string().regex(/^[a-f0-9]{64}$/),
  processStartId: z.string().regex(/^\d+$/).optional(),
  pidNamespaceHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

type ClaimOwner = z.infer<typeof ClaimOwnerSchema>;

export interface RepeatedFailureRowClaim {
  readonly schemaVersion: 1;
  readonly rowKey: string;
  readonly identity: RepeatedFailureRowIdentity;
  readonly ownerToken: string;
}

export interface RepeatedFailureRowStoreOptions {
  readonly claimWaitTimeoutMs?: number;
  readonly claimLeaseMs?: number;
  readonly claimHeartbeatMs?: number;
}

interface ActiveClaim {
  heartbeat: Promise<void>;
  heartbeatError?: Error;
  timer: NodeJS.Timeout;
}

const ClaimLockSnapshotSchema = z.object({
  commitMtimeMs: z.number().finite().nonnegative().optional(),
  dirMtimeMs: z.number().finite().nonnegative(),
  fallbackLeaseMs: z.number().int().positive(),
  ownerRaw: z.string().optional(),
  owner: ClaimOwnerSchema.optional(),
  heartbeatMtimeMs: z.number().finite().nonnegative().optional(),
}).strict();

const ReclaimJournalSchema = z.object({
  schemaVersion: z.literal(1),
  rowKey: ClaimRowKeySchema,
  snapshot: ClaimLockSnapshotSchema,
}).strict();

type ClaimLockSnapshot = z.infer<typeof ClaimLockSnapshotSchema>;

export class RepeatedFailureRowStore {
  readonly outputDir: string;
  readonly checkpointsDir: string;
  private readonly activeClaims = new Map<string, ActiveClaim>();
  private readonly claimHeartbeatMs: number;
  private readonly claimLeaseMs: number;
  private readonly claimWaitTimeoutMs: number;
  private commitTail: Promise<void> = Promise.resolve();

  constructor(outputDir: string, options: RepeatedFailureRowStoreOptions = {}) {
    this.outputDir = path.resolve(outputDir);
    this.checkpointsDir = resolveContainedPath(this.outputDir, "checkpoints");
    this.claimWaitTimeoutMs = options.claimWaitTimeoutMs ?? DEFAULT_CLAIM_WAIT_TIMEOUT_MS;
    this.claimLeaseMs = options.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS;
    this.claimHeartbeatMs = options.claimHeartbeatMs ?? DEFAULT_CLAIM_HEARTBEAT_MS;
    for (const [name, value] of [
      ["claimWaitTimeoutMs", this.claimWaitTimeoutMs],
      ["claimLeaseMs", this.claimLeaseMs],
      ["claimHeartbeatMs", this.claimHeartbeatMs],
    ] as const) {
      if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive finite integer`);
      }
    }
    if (this.claimLeaseMs > 24 * 60 * 60_000) {
      throw new Error("claimLeaseMs must not exceed 24 hours");
    }
  }

  checkpointPath(identity: RepeatedFailureRowIdentity): string {
    return resolveContainedPath(this.checkpointsDir, `${buildRepeatedFailureRowKey(identity)}.json`);
  }

  async load(identity: RepeatedFailureRowIdentity): Promise<RepeatedFailureCheckpointLoadResult> {
    const rowKey = buildRepeatedFailureRowKey(identity);
    let raw: string;
    try {
      raw = await readFile(this.checkpointPath(identity), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "MISSING" };
      return { kind: "MALFORMED", error: error instanceof Error ? error : new Error(String(error)) };
    }
    try {
      const checkpoint = parseCheckpoint(JSON.parse(raw), rowKey);
      if (canonicalJson(checkpoint.identity) !== canonicalJson(normalizeIdentity(identity))) {
        throw new Error("checkpoint identity does not exactly match requested identity");
      }
      return { kind: "VALID", checkpoint };
    } catch (error) {
      return { kind: "MALFORMED", error: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  async loadTerminalForResume(identity: RepeatedFailureRowIdentity): Promise<RepeatedFailureEpisodeRow | undefined> {
    const loaded = await this.load(identity);
    if (loaded.kind === "MALFORMED") throw loaded.error;
    return loaded.kind === "VALID" ? loaded.checkpoint.terminal : undefined;
  }

  async verifyAttemptTraceArtifacts(checkpoint: RepeatedFailureRowCheckpoint): Promise<void> {
    for (const entry of checkpoint.tries) {
      if (entry.outcome.kind !== "HOST_API_FAULT") continue;
      try {
        const traceBytes = await readFile(
          resolveContainedPath(this.outputDir, entry.outcome.traceArtifactPath),
        );
        const traceHash = createHash("sha256").update(traceBytes).digest("hex");
        if (traceHash !== entry.outcome.traceArtifactHash) {
          throw new Error("trace hash mismatch");
        }
      } catch (error) {
        throw new Error(
          `attempt trace artifact is missing or drifted: ${checkpoint.rowKey} attempt ${entry.attempt}`,
          { cause: error },
        );
      }
    }
  }

  async claimRow(identity: RepeatedFailureRowIdentity): Promise<RepeatedFailureRowClaim> {
    assertValidIdentity(identity);
    const normalizedIdentity = normalizeIdentity(identity);
    const rowKey = buildRepeatedFailureRowKey(normalizedIdentity);
    const ownerToken = randomUUID();
    const claim: RepeatedFailureRowClaim = Object.freeze({
      schemaVersion: 1,
      rowKey,
      identity: Object.freeze(normalizedIdentity),
      ownerToken,
    });
    const lockPath = this.claimLockPath(rowKey);
    const deadline = Date.now() + this.claimWaitTimeoutMs;
    await mkdir(this.checkpointsDir, { recursive: true });

    while (true) {
      try {
        await mkdir(lockPath);
        if (await this.reclaimInProgress(rowKey)) {
          await this.removeEmptyLockDirectory(lockPath);
          await this.recoverExpiredReclaimGuard(rowKey);
        } else {
          let activated = false;
          try {
            const owner: ClaimOwner = {
              schemaVersion: 1,
              rowKey,
              ownerToken,
              leaseMs: this.claimLeaseMs,
              pid: process.pid,
              hostHash: PROCESS_HOST_HASH,
              ...(PROCESS_START_ID ? { processStartId: PROCESS_START_ID } : {}),
              ...(PROCESS_PID_NAMESPACE_HASH
                ? { pidNamespaceHash: PROCESS_PID_NAMESPACE_HASH }
                : {}),
            };
            await writeFile(
              resolveContainedPath(lockPath, "owner.json"),
              `${JSON.stringify(owner)}\n`,
              { encoding: "utf8", flag: "wx" },
            );
            await writeFile(
              this.heartbeatPath(lockPath, ownerToken),
              ownerToken,
              { encoding: "utf8", flag: "wx" },
            );
            this.startHeartbeat(claim);
            activated = true;
            const loaded = await this.load(normalizedIdentity);
            if (loaded.kind === "MALFORMED") throw loaded.error;
            if (loaded.kind === "VALID" && loaded.checkpoint.terminal) {
              throw new Error(`Repeated-failure row ${rowKey} is terminal and immutable`);
            }
            return claim;
          } catch (error) {
            if (activated) {
              await this.releaseClaim(claim);
            } else {
              await this.removeEmptyLockDirectory(lockPath);
            }
            throw error;
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await this.tryReclaimExpired(rowKey)) continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for repeated-failure row claim ${rowKey}`);
      }
      await delay(Math.min(10, this.claimHeartbeatMs));
    }
  }

  commitTry(
    claim: RepeatedFailureRowClaim,
    entry: RepeatedFailureTry,
  ): Promise<RepeatedFailureRowCheckpoint> {
    const operation = this.commitTail.then(async () => {
      await this.refreshClaim(claim);
      const commitPath = this.commitPath(this.claimLockPath(claim.rowKey), claim.ownerToken);
      try {
        await writeFile(commitPath, claim.ownerToken, { encoding: "utf8", flag: "wx" });
        await this.refreshClaim(claim);
        const checkpoint = await this.commitTryUnlocked(claim, entry);
        await this.refreshClaim(claim);
        return checkpoint;
      } finally {
        await rm(commitPath, { force: true });
      }
    });
    this.commitTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  releaseClaim(claim: RepeatedFailureRowClaim): Promise<void> {
    const operation = this.commitTail.then(() => this.releaseClaimUnlocked(claim));
    this.commitTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async awaitClaimsReleased(): Promise<void> {
    const deadline = Date.now() + this.claimWaitTimeoutMs;
    while (true) {
      await this.commitTail;
      if (this.activeClaims.size === 0 && !(await this.hasOnDiskClaimLocks())) return;
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for repeated-failure claims to release");
      }
      await delay(Math.min(10, this.claimHeartbeatMs));
    }
  }

  private async hasOnDiskClaimLocks(): Promise<boolean> {
    let names: string[];
    try {
      names = await readdir(this.checkpointsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    for (const name of names) {
      const entry = parseClaimLockEntryName(name);
      if (!entry) continue;
      if (entry.canonical && await this.tryReclaimExpired(entry.rowKey)) continue;
      try {
        await stat(resolveContainedPath(this.checkpointsDir, name));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return false;
  }

  private async releaseClaimUnlocked(claim: RepeatedFailureRowClaim): Promise<void> {
    this.assertClaimShape(claim);
    const active = this.activeClaims.get(claim.ownerToken);
    if (!active) throw this.notOwnerError(claim.rowKey);
    clearInterval(active.timer);
    await active.heartbeat;
    this.activeClaims.delete(claim.ownerToken);

    const lockPath = this.claimLockPath(claim.rowKey);
    await this.assertDiskOwner(lockPath, claim);
    const releasePath = resolveContainedPath(
      this.checkpointsDir,
      `${claim.rowKey}.lock.release-${claim.ownerToken}`,
    );
    try {
      await rename(lockPath, releasePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw this.notOwnerError(claim.rowKey);
      }
      throw error;
    }
    try {
      await this.assertDiskOwner(releasePath, claim);
      await rm(releasePath, { recursive: true, force: true });
    } catch (error) {
      try {
        await rename(releasePath, lockPath);
      } catch {
        throw new Error(`Failed to restore repeated-failure row claim ${claim.rowKey}`, {
          cause: error,
        });
      }
      throw error;
    }
  }

  private startHeartbeat(claim: RepeatedFailureRowClaim): void {
    let active: ActiveClaim;
    const timer = setInterval(() => {
      if (active.heartbeatError) return;
      active.heartbeat = active.heartbeat
        .then(() => this.refreshClaimOnDisk(claim))
        .catch((error: unknown) => {
          active.heartbeatError = error instanceof Error ? error : new Error(String(error));
        });
    }, this.claimHeartbeatMs);
    timer.unref();
    active = { heartbeat: Promise.resolve(), timer };
    this.activeClaims.set(claim.ownerToken, active);
  }

  private async refreshClaim(claim: RepeatedFailureRowClaim): Promise<void> {
    this.assertClaimShape(claim);
    const active = this.activeClaims.get(claim.ownerToken);
    if (!active) throw this.notOwnerError(claim.rowKey);
    await active.heartbeat;
    if (active.heartbeatError) throw active.heartbeatError;
    await this.refreshClaimOnDisk(claim);
  }

  private async refreshClaimOnDisk(claim: RepeatedFailureRowClaim): Promise<void> {
    const lockPath = this.claimLockPath(claim.rowKey);
    await this.assertDiskOwner(lockPath, claim);
    const now = new Date();
    try {
      await utimes(this.heartbeatPath(lockPath, claim.ownerToken), now, now);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw this.notOwnerError(claim.rowKey);
      }
      throw error;
    }
    const activeCommitPath = this.commitPath(lockPath, claim.ownerToken);
    if (await stat(activeCommitPath).then(() => true, () => false)) {
      try {
        await utimes(activeCommitPath, now, now);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await this.assertDiskOwner(lockPath, claim);
  }

  private assertClaimShape(claim: RepeatedFailureRowClaim): void {
    assertValidIdentity(claim.identity);
    if (
      claim.schemaVersion !== 1
      || claim.rowKey !== buildRepeatedFailureRowKey(claim.identity)
      || !ClaimOwnerTokenSchema.safeParse(claim.ownerToken).success
    ) {
      throw this.notOwnerError(claim.rowKey);
    }
  }

  private async assertDiskOwner(
    lockPath: string,
    claim: RepeatedFailureRowClaim,
  ): Promise<ClaimOwner> {
    return this.assertOwnerToken(lockPath, claim.rowKey, claim.ownerToken);
  }

  private async assertOwnerToken(
    lockPath: string,
    rowKey: string,
    ownerToken: string,
  ): Promise<ClaimOwner> {
    let owner: ClaimOwner;
    try {
      owner = ClaimOwnerSchema.parse(
        JSON.parse(await readFile(resolveContainedPath(lockPath, "owner.json"), "utf8")),
      );
    } catch {
      throw this.notOwnerError(rowKey);
    }
    if (owner.rowKey !== rowKey || owner.ownerToken !== ownerToken) {
      throw this.notOwnerError(rowKey);
    }
    return owner;
  }

  private async refreshOwnerToken(
    lockPath: string,
    rowKey: string,
    ownerToken: string,
  ): Promise<void> {
    await this.assertOwnerToken(lockPath, rowKey, ownerToken);
    const now = new Date();
    try {
      await utimes(this.heartbeatPath(lockPath, ownerToken), now, now);
      await utimes(this.commitPath(lockPath, ownerToken), now, now);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw this.notOwnerError(rowKey);
      }
      throw error;
    }
    await this.assertOwnerToken(lockPath, rowKey, ownerToken);
  }

  private async tryReclaimExpired(rowKey: string): Promise<boolean> {
    const guard = await this.acquireReclaimGuard(rowKey);
    if (!guard) return false;
    try {
      await this.refreshOwnerToken(this.reclaimPath(rowKey), rowKey, guard.ownerToken);
      return await this.tryReclaimExpiredPath(rowKey);
    } finally {
      await this.releaseReclaimGuard(rowKey, guard);
    }
  }

  private async acquireReclaimGuard(rowKey: string): Promise<ClaimOwner | undefined> {
    const reclaimPath = this.reclaimPath(rowKey);
    const owner: ClaimOwner = {
      schemaVersion: 1,
      rowKey,
      ownerToken: randomUUID(),
      leaseMs: DEFAULT_RECLAIM_GUARD_LEASE_MS,
      pid: process.pid,
      hostHash: PROCESS_HOST_HASH,
      ...(PROCESS_START_ID ? { processStartId: PROCESS_START_ID } : {}),
      ...(PROCESS_PID_NAMESPACE_HASH
        ? { pidNamespaceHash: PROCESS_PID_NAMESPACE_HASH }
        : {}),
    };
    await this.recoverExpiredReclaimGuard(rowKey);
    if (await this.reclaimInProgress(rowKey)) return undefined;
    try {
      await mkdir(reclaimPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await this.recoverExpiredReclaimGuard(rowKey);
      return undefined;
    }
    try {
      await writeFile(
        resolveContainedPath(reclaimPath, "owner.json"),
        `${JSON.stringify(owner)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      await writeFile(
        this.heartbeatPath(reclaimPath, owner.ownerToken),
        owner.ownerToken,
        { encoding: "utf8", flag: "wx" },
      );
      await writeFile(
        this.commitPath(reclaimPath, owner.ownerToken),
        owner.ownerToken,
        { encoding: "utf8", flag: "wx" },
      );
      return owner;
    } catch (error) {
      await this.removeEmptyLockDirectory(reclaimPath);
      throw error;
    }
  }

  private async releaseReclaimGuard(rowKey: string, owner: ClaimOwner): Promise<void> {
    const reclaimPath = this.reclaimPath(rowKey);
    const releasePath = resolveContainedPath(
      this.checkpointsDir,
      `${rowKey}.lock.reclaiming.release-${owner.ownerToken}`,
    );
    await this.refreshOwnerToken(reclaimPath, rowKey, owner.ownerToken);
    await rename(reclaimPath, releasePath);
    try {
      await this.assertOwnerToken(releasePath, rowKey, owner.ownerToken);
      await rm(releasePath, { recursive: true, force: true });
    } catch (error) {
      await rename(releasePath, reclaimPath);
      throw error;
    }
  }

  private async reclaimInProgress(rowKey: string): Promise<boolean> {
    for (const candidate of [this.reclaimPath(rowKey), this.staleReclaimPath(rowKey)]) {
      try {
        await stat(candidate);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return false;
  }

  private async recoverExpiredReclaimGuard(rowKey: string): Promise<boolean> {
    const reclaimPath = this.reclaimPath(rowKey);
    const staleReclaimPath = this.staleReclaimPath(rowKey);
    const staleGuard = await this.readLockSnapshot(
      staleReclaimPath,
      DEFAULT_RECLAIM_GUARD_LEASE_MS,
    );
    if (staleGuard) {
      if (!this.isExpired(staleGuard)) {
        try {
          await rename(staleReclaimPath, reclaimPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        return false;
      }
      await this.recoverStrandedRowLock(rowKey, staleReclaimPath);
      await rm(staleReclaimPath, { recursive: true, force: true });
      return true;
    }

    const guard = await this.readLockSnapshot(reclaimPath, DEFAULT_RECLAIM_GUARD_LEASE_MS);
    if (!guard || !this.isExpired(guard)) return false;
    await this.recoverStrandedRowLock(rowKey, reclaimPath);
    try {
      await rename(reclaimPath, staleReclaimPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    const movedGuard = await this.readLockSnapshot(
      staleReclaimPath,
      DEFAULT_RECLAIM_GUARD_LEASE_MS,
    );
    if (!movedGuard || !this.sameLockSnapshot(guard, movedGuard) || !this.isExpired(movedGuard)) {
      await rename(staleReclaimPath, reclaimPath);
      return false;
    }
    await rm(staleReclaimPath, { recursive: true, force: true });
    return true;
  }

  private async recoverStrandedRowLock(rowKey: string, guardPath: string): Promise<void> {
    const journalPath = this.reclaimJournalPath(guardPath);
    const journalRaw = await readFile(journalPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    const journal = journalRaw === undefined
      ? undefined
      : ReclaimJournalSchema.parse(JSON.parse(journalRaw));
    if (journal && journal.rowKey !== rowKey) {
      throw new Error(`Reclaim journal does not match repeated-failure row ${rowKey}`);
    }

    const staleLockPath = this.staleLockPath(rowKey);
    const staleLock = await this.readLockSnapshot(staleLockPath);
    if (!staleLock) {
      await rm(journalPath, { force: true });
      return;
    }
    if (await stat(this.claimLockPath(rowKey)).then(() => true, () => false)) {
      throw new Error(`Cannot recover competing repeated-failure row claims ${rowKey}`);
    }
    if (journal && this.sameLockSnapshot(journal.snapshot, staleLock)) {
      await rm(staleLockPath, { recursive: true, force: true });
    } else if (!journal && this.isExpired(staleLock)) {
      await rm(staleLockPath, { recursive: true, force: true });
    } else {
      await rename(staleLockPath, this.claimLockPath(rowKey));
    }
    await rm(journalPath, { force: true });
  }

  private async tryReclaimExpiredPath(rowKey: string): Promise<boolean> {
    const lockPath = this.claimLockPath(rowKey);
    const stalePath = this.staleLockPath(rowKey);
    const snapshot = await this.readLockSnapshot(lockPath);
    if (!snapshot || !this.isExpired(snapshot)) return false;
    const journalPath = this.reclaimJournalPath(this.reclaimPath(rowKey));
    await writeFileAtomically(
      journalPath,
      `${JSON.stringify({ schemaVersion: 1, rowKey, snapshot })}\n`,
    );
    try {
      await rename(lockPath, stalePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await rm(journalPath, { force: true });
      return true;
    }
    const movedSnapshot = await this.readLockSnapshot(stalePath);
    if (!movedSnapshot || !this.sameLockSnapshot(snapshot, movedSnapshot) || !this.isExpired(movedSnapshot)) {
      await rename(stalePath, lockPath);
      await rm(journalPath, { force: true });
      return false;
    }
    await rm(stalePath, { recursive: true, force: true });
    await rm(journalPath, { force: true });
    return true;
  }

  private async removeEmptyLockDirectory(lockPath: string): Promise<void> {
    try {
      await rmdir(lockPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST") return;
      throw error;
    }
  }

  private async readLockSnapshot(
    lockPath: string,
    fallbackLeaseMs = DEFAULT_CLAIM_LEASE_MS,
  ): Promise<ClaimLockSnapshot | undefined> {
    const dirStat = await stat(lockPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!dirStat) return undefined;
    const ownerRaw = await readFile(resolveContainedPath(lockPath, "owner.json"), "utf8")
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
    let owner: ClaimOwner | undefined;
    if (ownerRaw !== undefined) {
      try {
        const parsedOwner = ClaimOwnerSchema.safeParse(JSON.parse(ownerRaw));
        if (parsedOwner.success) owner = parsedOwner.data;
      } catch {
        owner = undefined;
      }
    }
    const heartbeatMtimeMs = owner
      ? await stat(this.heartbeatPath(lockPath, owner.ownerToken))
          .then((heartbeatStat) => heartbeatStat.mtimeMs)
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          })
      : undefined;
    const commitMtimeMs = owner
      ? await stat(this.commitPath(lockPath, owner.ownerToken))
          .then((commitStat) => commitStat.mtimeMs)
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          })
      : undefined;
    return {
      dirMtimeMs: dirStat.mtimeMs,
      fallbackLeaseMs,
      ...(ownerRaw !== undefined ? { ownerRaw } : {}),
      ...(owner ? { owner } : {}),
      ...(heartbeatMtimeMs !== undefined ? { heartbeatMtimeMs } : {}),
      ...(commitMtimeMs !== undefined ? { commitMtimeMs } : {}),
    };
  }

  private isExpired(snapshot: ClaimLockSnapshot): boolean {
    const owner = snapshot.owner;
    if (
      owner?.hostHash === PROCESS_HOST_HASH
      && owner.pidNamespaceHash !== undefined
      && PROCESS_PID_NAMESPACE_HASH !== undefined
      && owner.pidNamespaceHash === PROCESS_PID_NAMESPACE_HASH
      && owner.processStartId !== undefined
      && snapshot.commitMtimeMs !== undefined
    ) {
      return readProcessStartId(owner.pid) !== owner.processStartId;
    }
    if (
      snapshot.commitMtimeMs !== undefined
      && Date.now() - snapshot.commitMtimeMs <= DEFAULT_COMMIT_LEASE_MS
    ) {
      return false;
    }
    const leaseMs = snapshot.owner?.leaseMs ?? snapshot.fallbackLeaseMs;
    const lastActivityMs = snapshot.heartbeatMtimeMs ?? snapshot.dirMtimeMs;
    return Date.now() - lastActivityMs > leaseMs;
  }

  private sameLockSnapshot(left: ClaimLockSnapshot, right: ClaimLockSnapshot): boolean {
    return left.commitMtimeMs === right.commitMtimeMs
      && left.dirMtimeMs === right.dirMtimeMs
      && left.ownerRaw === right.ownerRaw
      && left.heartbeatMtimeMs === right.heartbeatMtimeMs;
  }

  private claimLockPath(rowKey: string): string {
    return resolveContainedPath(this.checkpointsDir, `${rowKey}.lock`);
  }

  private reclaimPath(rowKey: string): string {
    return resolveContainedPath(this.checkpointsDir, `${rowKey}.lock.reclaiming`);
  }

  private staleLockPath(rowKey: string): string {
    return resolveContainedPath(this.checkpointsDir, `${rowKey}.lock.stale`);
  }

  private staleReclaimPath(rowKey: string): string {
    return resolveContainedPath(this.checkpointsDir, `${rowKey}.lock.reclaiming.stale`);
  }

  private reclaimJournalPath(guardPath: string): string {
    return resolveContainedPath(guardPath, "row-reclaim.json");
  }

  private commitPath(lockPath: string, ownerToken: string): string {
    return resolveContainedPath(lockPath, `commit-${ownerToken}`);
  }

  private heartbeatPath(lockPath: string, ownerToken: string): string {
    return resolveContainedPath(lockPath, `heartbeat-${ownerToken}`);
  }

  private notOwnerError(rowKey: string): Error {
    return new Error(`Claim token does not own repeated-failure row ${rowKey}`);
  }

  private async commitTryUnlocked(
    claim: RepeatedFailureRowClaim,
    entry: RepeatedFailureTry,
  ): Promise<RepeatedFailureRowCheckpoint> {
    const identity = claim.identity;
    assertValidIdentity(identity);
    assertValidTry(entry, entry.attempt - 1);
    const rowKey = buildRepeatedFailureRowKey(identity);
    const loaded = await this.load(identity);
    if (loaded.kind === "MALFORMED") throw loaded.error;

    const normalizedEntry = normalizeTry(entry);
    if (loaded.kind === "VALID") {
      const checkpoint = loaded.checkpoint;
      const existing = checkpoint.tries[entry.attempt - 1];
      if (existing && canonicalJson(existing) === canonicalJson(normalizedEntry)) return checkpoint;
      if (checkpoint.terminal) throw new Error(`Repeated-failure row ${rowKey} is terminal and immutable`);
      if (entry.attempt !== checkpoint.tries.length + 1) {
        throw new Error(`Expected attempt ${checkpoint.tries.length + 1}, received ${entry.attempt}`);
      }
    } else if (entry.attempt !== 1) {
      throw new Error(`Expected attempt 1, received ${entry.attempt}`);
    }

    const tries = [
      ...(loaded.kind === "VALID" ? loaded.checkpoint.tries : []),
      normalizedEntry,
    ];
    const episode =
      normalizedEntry.outcome.kind === "TASK_RESULT"
        ? normalizedEntry.outcome.episode
        : normalizedEntry.outcome.exhausted || tries.length === 6
          ? exhaustedEpisode(normalizedEntry.outcome)
          : undefined;
    const checkpoint: RepeatedFailureRowCheckpoint = {
      schemaVersion: 1,
      rowKey,
      identity: normalizeIdentity(identity),
      tries,
      ...(episode ? { terminal: projectTerminalRow(rowKey, identity, tries, episode) } : {}),
    };
    await mkdir(this.checkpointsDir, { recursive: true });
    await this.refreshClaim(claim);
    await writeFileAtomically(this.checkpointPath(identity), serializeCheckpoint(checkpoint));
    return checkpoint;
  }

  async compileRows(): Promise<RepeatedFailureEpisodeRow[]> {
    let names: string[];
    try {
      names = await readdir(this.checkpointsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const rows: RepeatedFailureEpisodeRow[] = [];
    for (const name of names.sort(compareCodePoints)) {
      if (!/^h6-row-v1-[a-f0-9]{64}\.json$/.test(name)) continue;
      const rowKey = name.slice(0, -".json".length);
      let checkpoint: RepeatedFailureRowCheckpoint;
      try {
        checkpoint = parseCheckpoint(JSON.parse(await readFile(resolveContainedPath(this.checkpointsDir, name), "utf8")), rowKey);
      } catch (error) {
        throw new Error(`Malformed repeated-failure checkpoint ${name}`, { cause: error });
      }
      await this.verifyAttemptTraceArtifacts(checkpoint);
      if (checkpoint.terminal) rows.push(checkpoint.terminal);
    }
    return rows.sort((left, right) => compareCodePoints(left.rowKey, right.rowKey));
  }

  async writeEpisodesJsonl(fileName = "episodes.jsonl"): Promise<string> {
    const filePath = resolveContainedPath(this.outputDir, fileName);
    await writeFileAtomically(filePath, serializeJsonl(await this.compileRows()));
    return filePath;
  }

}
