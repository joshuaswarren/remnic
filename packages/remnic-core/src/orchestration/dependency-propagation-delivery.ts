import { createHash, randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";

import type { ExtractionEngine } from "../extraction.js";
import { log } from "../logger.js";
import { resolveSafeStoragePath } from "../storage-paths.js";
import type { MemoryFile, PluginConfig } from "../types.js";
import { sanitizeMemoryContent } from "../sanitize.js";
import { listJsonFilesStrict, withJsonStoreMutationLock, writeJsonFileAtomic } from "../json-store.js";
import {
  applyTemporalSupersessionPrimaryMutation,
  type TemporalSupersessionStorage,
} from "../temporal-supersession.js";
import {
  isDependencyPropagationEnabled,
  propagateInvalidation,
  type DependencyPropagationStorage,
  type PropagationEvent,
} from "./dependency-propagation.js";
import {
  canonicalEvent,
  canonicalize,
  compareByteStable,
  eventJobId,
  isNotFound,
  isPropagationEvent,
  JOB_STATES,
  matchesPreparedSource,
  validateJob,
} from "./dependency-propagation-queue-state.js";
export type DependencyPropagationJobStatus =
  | "prepared"
  | "ready"
  | "leased"
  | "retryable"
  | "completed"
  | "dead_letter"
  | "canceled";

export interface DependencyPropagationJob {
  jobId: string;
  namespace: string;
  sourceId: string;
  event: PropagationEvent;
  status: DependencyPropagationJobStatus;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  reservations?: number;
  revision: number;
  reservationIds?: string[];
  nextAttemptAt?: number;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  lastError?: string;
  preparedReplacementFingerprint?: string;
}
export interface DependencyPropagationPreparationToken {
  jobId: string;
  revision: number;
  ownsPreparedJob: boolean;
  reservationId: string;
}

export interface DependencyPropagationDeliveryPort {
  prepare(event: PropagationEvent): Promise<DependencyPropagationPreparationToken | null>;
  afterMutation(
    token: DependencyPropagationPreparationToken | null,
    event: PropagationEvent,
  ): Promise<void>;
  cancel(token: DependencyPropagationPreparationToken | null): Promise<void>;
  deferPrepared(token: DependencyPropagationPreparationToken | null): Promise<void>;
}

export interface DependencyPropagationDeliveryOptions {
  queueRoot: string;
  config: PluginConfig;
  extraction: ExtractionEngine;
  getStorage: (namespace: string) => Promise<DependencyPropagationStorage>;
  workerId?: string;
  clock?: () => number;
  retryDelayMs?: number;
  leaseMs?: number;
  maxAttempts?: number;
  autoStart?: boolean;
  schedule?: (run: () => Promise<void>, delayMs: number) => void;
  readQueueFile?: (filePath: string) => Promise<string>;
  writeQueueFile?: (filePath: string, content: string) => Promise<void>;
}

type JobEntry = {
  job: DependencyPropagationJob;
  filePath: string;
};
type DependencyPropagationRecoveryStorage = DependencyPropagationStorage & {
  readAllColdMemories?: () => Promise<MemoryFile[]>;
  readArchivedMemories?: () => Promise<MemoryFile[]>;
  hasCommittedInvalidation?: (memory: Pick<MemoryFile, "content" | "frontmatter">) => Promise<boolean>;
  clearCommittedInvalidation?: (
    memory: Pick<MemoryFile, "content" | "frontmatter">,
  ) => Promise<void>;
  invalidateMemory?: (
    id: string,
    snapshot?: Pick<MemoryFile, "content" | "frontmatter"> & Partial<Pick<MemoryFile, "path">>,
    options?: { recordCommitProof?: boolean },
  ) => Promise<boolean>;
  updateMemoryIfUnchanged?: (
    expected: MemoryFile,
    content: string,
    options?: {
      supersedes?: string;
      lineage?: string[];
      actor?: string;
      sourceConnector?: string;
    },
  ) => Promise<boolean>;
};
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const TERMINAL_RETENTION_COUNT = 32;
const MAX_SERIALIZED_QUEUE_JOB_BYTES = 64 * 1024;
const MAX_STORED_ERROR_LENGTH = 1_024;

class QueueJobTooLargeError extends Error {
  constructor(bytes: number) {
    super(`dependency propagation queue job exceeds ${MAX_SERIALIZED_QUEUE_JOB_BYTES} bytes (${bytes})`);
    this.name = "QueueJobTooLargeError";
  }
}

function formatStoredError(error: unknown): string {
  const text = String(error);
  return text.length > MAX_STORED_ERROR_LENGTH ? text.slice(0, MAX_STORED_ERROR_LENGTH) : text;
}
function memoryFingerprint(memory: Pick<MemoryFile, "content" | "frontmatter">): string {
  const { accessCount: _accessCount, lastAccessed: _lastAccessed, ...frontmatter } = memory.frontmatter;
  return createHash("sha256").update(JSON.stringify(canonicalize({ content: memory.content, frontmatter }))).digest("hex");
}

function chooseEntry(entries: JobEntry[]): JobEntry | undefined {
  return [...entries].sort((left, right) => {
    if (left.job.revision !== right.job.revision) return right.job.revision - left.job.revision;
    if (left.job.updatedAt !== right.job.updatedAt) return right.job.updatedAt - left.job.updatedAt;
    return left.filePath < right.filePath ? -1 : left.filePath > right.filePath ? 1 : 0;
  })[0];
}

export class DependencyPropagationDelivery {
  private readonly queueRoot: string;
  private readonly getStorage: (namespace: string) => Promise<DependencyPropagationStorage>;
  private readonly config: PluginConfig;
  private readonly extraction: ExtractionEngine;
  private readonly workerId: string;
  private readonly clock: () => number;
  private readonly retryDelayMs: number;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly autoStart: boolean;
  private readonly schedule: (run: () => Promise<void>, delayMs: number) => void;
  private readonly readQueueFile: (filePath: string) => Promise<string>;
  private readonly writeQueueFile: (filePath: string, content: string) => Promise<void>;
  private backgroundScheduled = false;
  private recoveryScheduled = false;
  private backgroundRun: Promise<number> | null = null;
  private readonly activeRuns = new Set<Promise<unknown>>();
  private stopped = false;

  constructor(options: DependencyPropagationDeliveryOptions) {
    this.queueRoot = options.queueRoot;
    this.config = options.config;
    this.extraction = options.extraction;
    this.getStorage = options.getStorage;
    this.workerId = options.workerId ?? `worker-${process.pid}-${randomUUID()}`;
    this.clock = options.clock ?? Date.now;
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    this.leaseMs = Math.max(1, options.leaseMs ?? DEFAULT_LEASE_MS);
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
    this.autoStart = options.autoStart ?? false;
    this.schedule =
      options.schedule ??
      ((run, delayMs) => {
        const timer = setTimeout(() => {
          void run().catch((error: unknown) => {
            log.warn(`dependency propagation scheduled run failed: ${error}`);
          });
        }, delayMs);
        timer.unref();
      });
    this.readQueueFile = options.readQueueFile ?? ((filePath) => readFile(filePath, "utf8"));
    this.writeQueueFile =
      options.writeQueueFile ??
      ((filePath, content) => writeJsonFileAtomic(filePath, JSON.parse(content) as unknown));
  }
  async prepare(event: PropagationEvent): Promise<DependencyPropagationPreparationToken | null> {
    if (this.stopped) return null;
    if (!isDependencyPropagationEnabled(this.config)) return null;
    const reservationId = randomUUID();
    try {
      if (!isPropagationEvent(event)) throw new Error("invalid dependency propagation event");
      const snapshot = canonicalEvent(event);
      const jobId = eventJobId(snapshot);
      let preparedReplacementFingerprint: string | undefined;
      if (snapshot.cause === "consolidation_merge" && snapshot.replacementId !== null) {
        try {
          const storage = await this.getStorage(snapshot.namespaceScope);
          const replacement = await storage.getMemoryById(snapshot.replacementId);
          if (replacement) preparedReplacementFingerprint = memoryFingerprint(replacement);
        } catch (error) {
          log.warn(`dependency propagation survivor fingerprint capture failed: ${error}`);
        }
      }
      let token: DependencyPropagationPreparationToken | null = null;
      await withJsonStoreMutationLock(this.queueRoot, async () => {
        const entries = await this.readEntries();
        const existing = chooseEntry(entries.filter((entry) => entry.job.jobId === jobId));
        if (existing && existing.job.status === "canceled") {
          const reopened: DependencyPropagationJob = {
            ...existing.job,
            status: "prepared",
            attempts: 0,
            reservations: 1,
            reservationIds: [reservationId],
            nextAttemptAt: undefined,
            leaseOwner: undefined,
            leaseExpiresAt: undefined,
            lastError: undefined,
            updatedAt: this.clock(),
            revision: existing.job.revision + 1,
          };
          await this.writeQueueJob(await this.jobPath("prepared", jobId), reopened);
          await unlink(existing.filePath).catch((error: unknown) => {
            if (!isNotFound(error)) throw error;
          });
          token = {
            jobId,
            revision: reopened.revision,
            ownsPreparedJob: true,
            reservationId,
          };
          return;
        }
        if (existing && existing.job.status === "prepared") {
          const reservationIds = existing.job.reservationIds ?? [];
          const next = {
            ...existing.job,
            reservations: reservationIds.length + 1,
            reservationIds: [...reservationIds, reservationId],
            updatedAt: this.clock(),
          };
          await this.writeQueueJob(existing.filePath, next);
          token = {
            jobId,
            revision: existing.job.revision,
            ownsPreparedJob: true,
            reservationId,
          };
          return;
        }
        if (existing) {
          token = {
            jobId,
            revision: existing.job.revision,
            ownsPreparedJob: false,
            reservationId,
          };
          return;
        }
        const now = this.clock();
        const job: DependencyPropagationJob = {
          jobId,
          namespace: snapshot.namespaceScope,
          sourceId: snapshot.oldMemory.frontmatter.id,
          event: snapshot,
          status: "prepared",
          attempts: 0,
          createdAt: now,
          updatedAt: now,
          reservations: 1,
          reservationIds: [reservationId],
          revision: 0,
          ...(preparedReplacementFingerprint ? { preparedReplacementFingerprint } : {}),
        };
        await this.writeQueueJob(await this.jobPath(job.status, job.jobId), job);
        token = {
          jobId,
          revision: job.revision,
          ownsPreparedJob: true,
          reservationId,
        };
      });
      return token;
    } catch (error) {
      log.warn(`dependency propagation queue preparation failed: ${error}`);
      if (error instanceof QueueJobTooLargeError) return null;
      try {
        if (isPropagationEvent(event)) {
          const snapshot = canonicalEvent(event);
          const jobId = eventJobId(snapshot);
          return await withJsonStoreMutationLock(this.queueRoot, async () => {
            const existing = chooseEntry(
              (await this.readEntries()).filter((entry) => entry.job.jobId === jobId),
            );
            if (!existing || existing.job.status !== "prepared") return null;
            const reservationIds = existing.job.reservationIds ?? [];
            if (!reservationIds.includes(reservationId)) {
              reservationIds.push(reservationId);
              await this.writeQueueJob(existing.filePath, {
                ...existing.job,
                reservationIds,
                reservations: reservationIds.length,
                updatedAt: this.clock(),
              });
            }
            return {
              jobId,
              revision: existing.job.revision,
              ownsPreparedJob: true,
              reservationId,
            };
          });
        }
      } catch (readbackError) {
        log.warn(`dependency propagation queue preparation readback failed: ${readbackError}`);
      }
      return null;
    }
  }

  async afterMutation(
    token: DependencyPropagationPreparationToken | null,
    event: PropagationEvent,
  ): Promise<void> {
    if (this.stopped) return;
    if (token !== null) {
      try {
        await withJsonStoreMutationLock(this.queueRoot, async () => {
          const entries = await this.readEntries();
          const matching = entries.filter((entry) => entry.job.jobId === token.jobId);
          const current = chooseEntry(matching);
          if (!current) throw new Error(`dependency propagation job ${token.jobId} is missing`);
          if (current.job.status === "prepared" && current.job.revision === token.revision) {
            const reservationIds = current.job.reservationIds;
            if (reservationIds && !reservationIds.includes(token.reservationId)) return;
            await this.transitionUnlocked(matching, current.job, "ready", {
              ...(reservationIds
                ? {
                    reservationIds: reservationIds.filter((id) => id !== token.reservationId),
                    reservations: Math.max(0, reservationIds.length - 1),
                  }
                : {}),
            });
          }
        });
        this.scheduleBackgroundRun();
        return;
      } catch (error) {
        log.warn(`dependency propagation ready transition failed: ${error}`);
        this.scheduleBackgroundRecovery();
        return;
      }
    }
    await this.propagateDirect(event);
  }

  async cancel(token: DependencyPropagationPreparationToken | null): Promise<void> {
    if (token === null) return;
    try {
      let terminalJob: DependencyPropagationJob | null = null;
      await withJsonStoreMutationLock(this.queueRoot, async () => {
        const entries = await this.readEntries();
        const matching = entries.filter((entry) => entry.job.jobId === token.jobId);
        const current = chooseEntry(matching);
        if (
          !current ||
          current.job.status !== "prepared" ||
          current.job.revision !== token.revision
        ) {
          return;
        }
        const reservationIds = current.job.reservationIds;
        if (reservationIds && !reservationIds.includes(token.reservationId)) return;
        if (reservationIds && reservationIds.length > 1) {
          const remaining = reservationIds.filter((id) => id !== token.reservationId);
          await this.writeQueueJob(current.filePath, {
            ...current.job,
            reservationIds: remaining,
            reservations: remaining.length,
            updatedAt: this.clock(),
          });
          return;
        }
        terminalJob = await this.transitionUnlocked(matching, current.job, "canceled", {
          reservationIds: [],
          reservations: 0,
          lastError: undefined,
        });
      });
      if (terminalJob !== null && !(await this.finalizeTerminalJob(terminalJob))) {
        this.scheduleBackgroundRecovery();
      }
    } catch (error) {
      log.warn(`dependency propagation cancellation failed for ${token.jobId}: ${error}`);
    }
  }

  async deferPrepared(token: DependencyPropagationPreparationToken | null): Promise<void> {
    if (this.stopped || token === null) return;
    try {
      const shouldSchedule = await withJsonStoreMutationLock(this.queueRoot, async () => {
        const entries = await this.readEntries();
        const current = chooseEntry(
          entries.filter((entry) => entry.job.jobId === token.jobId),
        );
        if (
          !current ||
          current.job.status !== "prepared" ||
          current.job.revision !== token.revision
        ) {
          return false;
        }
        const reservationIds = current.job.reservationIds;
        return !reservationIds || reservationIds.includes(token.reservationId);
      });
      if (shouldSchedule) this.scheduleBackgroundRecovery();
    } catch (error) {
      log.warn(`dependency propagation prepared-job deferral failed for ${token.jobId}: ${error}`);
    }
  }
  private trackRun<T>(run: Promise<T>): Promise<T> {
    this.activeRuns.add(run);
    void run.finally(() => this.activeRuns.delete(run)).catch(() => undefined);
    return run;
  }
  recover(): Promise<void> {
    return this.trackRun(this.recoverInternal());
  }

  private async recoverInternal(): Promise<void> {
    let jobs: DependencyPropagationJob[];
    try {
      jobs = await this.listJobs();
    } catch (error) {
      log.warn(`dependency propagation recovery scan failed: ${error}`);
      this.scheduleBackgroundRecovery();
      return;
    }
    let retryPreparedRecovery = false;
    for (const job of jobs) {
      if (
        job.status === "completed" ||
        job.status === "dead_letter" ||
        job.status === "canceled"
      ) {
        retryPreparedRecovery ||= !(await this.finalizeTerminalJob(job));
      }
    }
    for (const job of jobs) {
      if (job.status !== "prepared") continue;
      let claimed: DependencyPropagationJob | null;
      try {
        claimed = await this.claimPrepared(job);
      } catch (error) {
        retryPreparedRecovery = true;
        log.warn(`dependency propagation prepared-job claim failed: ${error}`);
        continue;
      }
      if (!claimed) continue;
      try {
        const storage = await this.getStorage(claimed.event.namespaceScope);
        const replayed = await this.withCurrentLease(claimed, () =>
          this.replayPrimaryMutation(
            storage,
            claimed.event,
            claimed.preparedReplacementFingerprint,
          ),
        );
        if (replayed !== true) {
          retryPreparedRecovery ||= await this.retainPreparedJob(
            claimed,
            new Error("primary mutation replay incomplete"),
          );
          continue;
        }
        await withJsonStoreMutationLock(this.queueRoot, async () => {
          const entries = await this.readEntries();
          const matching = entries.filter((entry) => entry.job.jobId === claimed.jobId);
          const current = chooseEntry(matching);
          if (
            current &&
            current.job.status === "leased" &&
            current.job.leaseOwner === claimed.leaseOwner &&
            (current.job.leaseExpiresAt ?? Number.NEGATIVE_INFINITY) > this.clock()
          ) {
            await this.transitionUnlocked(matching, current.job, "ready", {
              leaseOwner: undefined,
              leaseExpiresAt: undefined,
            });
          }
        });
      } catch (error) {
        retryPreparedRecovery ||= await this.retainPreparedJob(claimed, error);
        log.warn(`dependency propagation prepared-job recovery failed: ${error}`);
      }
    }
    if (retryPreparedRecovery) this.scheduleBackgroundRecovery();
    await this.scheduleNextPendingRun();
  }

  private async claimPrepared(job: DependencyPropagationJob): Promise<DependencyPropagationJob | null> {
    return withJsonStoreMutationLock(this.queueRoot, async () => {
      const entries = await this.readEntries();
      const matching = entries.filter((entry) => entry.job.jobId === job.jobId);
      const current = chooseEntry(matching);
      if (!current || current.job.status !== "prepared" || current.job.revision !== job.revision) {
        return null;
      }
      return this.transitionUnlocked(matching, current.job, "leased", {
        leaseOwner: `${this.workerId}:recovery:${randomUUID()}`,
        leaseExpiresAt: this.clock() + this.leaseMs,
        nextAttemptAt: undefined,
        lastError: undefined,
      });
    });
  }

  runUntilIdle(): Promise<number> {
    return this.trackRun(this.runUntilIdleInternal());
  }

  private async runUntilIdleInternal(): Promise<number> {
    let processed = 0;
    while (true) {
      let claimed: DependencyPropagationJob | null;
      try {
        claimed = await this.claimNext();
      } catch (error) {
        log.warn(`dependency propagation claim failed: ${error}`);
        this.scheduleBackgroundRecovery();
        break;
      }
      if (!claimed) break;
      processed += 1;
      await this.processClaimed(claimed);
    }
    return processed;
  }
  private scheduleBackgroundRun(delayMs = 0): void {
    if (!this.autoStart || this.stopped || this.backgroundScheduled) return;
    this.backgroundScheduled = true;
    this.schedule(async () => {
      this.backgroundScheduled = false;
      if (this.stopped) return;
      if (this.backgroundRun !== null) {
        await this.backgroundRun.catch(() => undefined);
        this.scheduleBackgroundRun();
        return;
      }
      const run = this.runUntilIdle();
      this.backgroundRun = run;
      try {
        await run;
      } finally {
        this.backgroundRun = null;
      }
      await this.scheduleNextPendingRun();
    }, delayMs);
  }

  private scheduleBackgroundRecovery(delayMs = this.retryDelayMs): void {
    if (!this.autoStart || this.stopped || this.recoveryScheduled) return;
    this.recoveryScheduled = true;
    this.schedule(async () => {
      this.recoveryScheduled = false;
      if (this.stopped) return;
      await this.recover();
    }, delayMs);
  }

  private async scheduleNextPendingRun(): Promise<void> {
    if (!this.autoStart || this.stopped || this.backgroundScheduled) return;
    let jobs: DependencyPropagationJob[];
    try {
      jobs = await this.listJobs();
    } catch (error) {
      log.warn(`dependency propagation scheduling scan failed: ${error}`);
      this.scheduleBackgroundRecovery();
      return;
    }
    const now = this.clock();
    let nextDelayMs = Number.POSITIVE_INFINITY;
    for (const job of jobs) {
      if (job.status === "ready") {
        nextDelayMs = 0;
        break;
      }
      if (job.status === "retryable" && job.nextAttemptAt !== undefined) {
        nextDelayMs = Math.min(nextDelayMs, Math.max(0, job.nextAttemptAt - now));
      }
      if (job.status === "leased" && job.leaseExpiresAt !== undefined) {
        nextDelayMs = Math.min(nextDelayMs, Math.max(0, job.leaseExpiresAt - now));
      }
    }
    if (Number.isFinite(nextDelayMs)) this.scheduleBackgroundRun(nextDelayMs);
  }


  async listJobs(): Promise<DependencyPropagationJob[]> {
    const entries = await this.readEntries();
    const grouped = new Map<string, JobEntry[]>();
    for (const entry of entries) {
      const group = grouped.get(entry.job.jobId) ?? [];
      group.push(entry);
      grouped.set(entry.job.jobId, group);
    }
    return [...grouped.values()]
      .map((group) => chooseEntry(group)?.job)
      .filter((job): job is DependencyPropagationJob => job !== undefined)
      .sort((left, right) => compareByteStable(left.jobId, right.jobId));
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    while (true) {
      const activeRuns = [...this.activeRuns];
      if (activeRuns.length > 0) {
        await Promise.all(activeRuns.map((run) => run.catch(() => 0)));
        continue;
      }
      if (this.backgroundScheduled) {
        this.backgroundScheduled = false;
        await this.runUntilIdle();
        continue;
      }
      break;
    }

    for (let pass = 0; pass <= this.maxAttempts; pass += 1) {
      await this.recover();
      await this.runUntilIdle();
      const jobs = await this.listJobs();
      const now = this.clock();
      const actionable = jobs.some(
        (job) =>
          job.status === "prepared" ||
          job.status === "ready" ||
          (job.status === "retryable" &&
            (job.nextAttemptAt === undefined || job.nextAttemptAt <= now)) ||
          (job.status === "leased" &&
            job.leaseExpiresAt !== undefined &&
            job.leaseExpiresAt <= now),
      );
      if (!actionable) return;
    }
  }

  private async stateDir(status: DependencyPropagationJobStatus): Promise<string> {
    return resolveSafeStoragePath(this.queueRoot, status);
  }

  private async jobPath(status: DependencyPropagationJobStatus, jobId: string): Promise<string> {
    return resolveSafeStoragePath(this.queueRoot, status, `${jobId}.json`);
  }

  private async writeQueueJob(filePath: string, job: DependencyPropagationJob): Promise<void> {
    const serialized = JSON.stringify(job, null, 2);
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > MAX_SERIALIZED_QUEUE_JOB_BYTES) throw new QueueJobTooLargeError(bytes);
    await this.writeQueueFile(filePath, serialized);
  }

  private async readEntries(): Promise<JobEntry[]> {
    const entries: JobEntry[] = [];
    for (const status of JOB_STATES) {
      let files: string[];
      try {
        files = await listJsonFilesStrict(await this.stateDir(status), { allowMissingDirectory: true });
      } catch (error) {
        log.warn(`dependency propagation state scan failed for ${status}: ${error}`);
        throw error;
      }
      for (const filePath of files) {
        try {
          const job = validateJob(JSON.parse(await this.readQueueFile(filePath)) as unknown, status);
          if (!job) {
            log.warn(`dependency propagation ignored invalid job file ${path.basename(filePath)}`);
            continue;
          }
          entries.push({ job, filePath });
        } catch (error) {
          if (error instanceof SyntaxError || isNotFound(error)) {
            log.warn(`dependency propagation ignored unreadable job file ${path.basename(filePath)}: ${error}`);
            continue;
          }
          throw error;
        }
      }
    }
    return entries;
  }

  private async findRecoverySource(
    storage: DependencyPropagationRecoveryStorage,
    sourceId: string,
  ): Promise<MemoryFile | null> {
    const hot = await storage.getMemoryById(sourceId);
    if (hot?.frontmatter.id === sourceId) return hot;
    if (storage.readAllColdMemories) {
      const cold = await storage.readAllColdMemories();
      const coldMatch = cold.find((memory) => memory.frontmatter.id === sourceId);
      if (coldMatch) return coldMatch;
    }
    if (storage.readArchivedMemories) {
      const archived = await storage.readArchivedMemories();
      const archivedMatch = archived.find((memory) => memory.frontmatter.id === sourceId);
      if (archivedMatch) return archivedMatch;
    }
    return null;
  }
  private async readCurrentReplacementEvent(
    storage: DependencyPropagationStorage,
    event: PropagationEvent,
  ): Promise<PropagationEvent | null> {
    if (event.replacementId === null) return event;
    const replacement = await this.findRecoverySource(
      storage as DependencyPropagationRecoveryStorage,
      event.replacementId,
    );
    if (!replacement) return null;
    return {
      ...event,
      replacementContent: replacement.content,
    };
  }


  private async clearCommittedInvalidationProof(job: DependencyPropagationJob): Promise<boolean> {
    if (
      job.event.cause !== "consolidation_invalidate" &&
      job.event.cause !== "consolidation_merge"
    ) {
      return true;
    }
    try {
      const storage = (await this.getStorage(job.event.namespaceScope)) as DependencyPropagationRecoveryStorage;
      if (!storage.clearCommittedInvalidation) {
        log.warn("dependency propagation invalidation proof cleanup capability missing");
        return false;
      }
      await storage.clearCommittedInvalidation(job.event.oldMemory);
      return true;
    } catch (error) {
      log.warn(`dependency propagation invalidation proof cleanup failed: ${error}`);
      return false;
    }
  }

  private async replayPrimaryMutation(
    sourceStorage: DependencyPropagationStorage,
    event: PropagationEvent,
    preparedReplacementFingerprint?: string,
  ): Promise<boolean> {
    const storage = sourceStorage as DependencyPropagationRecoveryStorage;
    const source = await this.findRecoverySource(storage, event.oldMemory.frontmatter.id);
    const primaryApplied =
      source?.frontmatter.status === "superseded" &&
      source.frontmatter.supersededBy === event.replacementId;

    if (event.cause === "temporal_supersession") {
      if (!event.replacementId || !event.temporalMutation || !source) return false;
      const temporalPrimaryApplied =
        primaryApplied &&
        source.frontmatter.supersededAt === event.temporalMutation.supersededAt &&
        (event.temporalMutation.invalidAt === undefined ||
          source.frontmatter.invalid_at === event.temporalMutation.invalidAt);
      if (!temporalPrimaryApplied) {
        const replacement = await this.findRecoverySource(storage, event.replacementId);
        if (
          event.replacementContent === null ||
          !replacement ||
          replacement.frontmatter.id !== event.replacementId ||
          replacement.content !== event.replacementContent
        ) return false;
        if (!matchesPreparedSource(source, event.oldMemory)) return false;
      }
      return await applyTemporalSupersessionPrimaryMutation({
        storage: sourceStorage as unknown as TemporalSupersessionStorage,
        oldMemory: source,
        replacementId: event.replacementId,
        mutation: event.temporalMutation,
      });
    }

    if (event.cause === "contradiction") {
      if (!event.replacementId || !source) return false;
      if (primaryApplied) return true;
      const replacement = await this.findRecoverySource(storage, event.replacementId);
      if (
        event.replacementContent === null ||
        !replacement ||
        replacement.frontmatter.id !== event.replacementId ||
        replacement.content !== event.replacementContent
      ) return false;
      if (!matchesPreparedSource(source, event.oldMemory)) return false;
      return await storage.supersedeMemory(
        event.oldMemory.frontmatter.id,
        event.replacementId,
        `dependency_propagation:${event.cause}`,
        undefined,
        { requireActive: true, acceptExactReplay: true, expectedSnapshot: source },
      );
    }

    if (event.cause === "consolidation_invalidate") {
      if (!source) {
        return storage.hasCommittedInvalidation
          ? await storage.hasCommittedInvalidation(event.oldMemory)
          : false;
      }
      if (!storage.invalidateMemory || !matchesPreparedSource(source, event.oldMemory)) return false;
      return await storage.invalidateMemory(source.frontmatter.id, source, {
        recordCommitProof: true,
      });
    }

    if (
      !event.replacementId ||
      event.replacementContent === null ||
      !storage.updateMemoryIfUnchanged
    ) {
      return false;
    }
    const replacement = await this.findRecoverySource(storage, event.replacementId);
    const persistedReplacementContent = sanitizeMemoryContent(event.replacementContent).text;
    if (
      replacement &&
      replacement.frontmatter.supersedes === event.oldMemory.frontmatter.id &&
      replacement.content !== persistedReplacementContent
    ) {
      return false;
    }
    const mergeAlreadyApplied =
      replacement !== null &&
      replacement.frontmatter.supersedes === event.oldMemory.frontmatter.id &&
      replacement.content === persistedReplacementContent;
    if (!source) {
      if (!storage.hasCommittedInvalidation) return false;
      return await storage.hasCommittedInvalidation(event.oldMemory);
    }
    if (
      preparedReplacementFingerprint &&
      source &&
      !mergeAlreadyApplied &&
      (!replacement || memoryFingerprint(replacement) !== preparedReplacementFingerprint)
    ) {
      return false;
    }
    if (!replacement || !matchesPreparedSource(source, event.oldMemory)) return false;
    if (!mergeAlreadyApplied) {
      const updated = await storage.updateMemoryIfUnchanged(
        replacement,
        event.replacementContent,
        {
          supersedes: event.oldMemory.frontmatter.id,
          lineage: [event.replacementId, event.oldMemory.frontmatter.id],
        },
      );
      if (!updated) return false;
    }
    if (!storage.invalidateMemory) return false;
    return await storage.invalidateMemory(source.frontmatter.id, source, {
      recordCommitProof: true,
    });
  }

  private async retainPreparedJob(job: DependencyPropagationJob, error: unknown): Promise<boolean> {
    try {
      let terminalJob: DependencyPropagationJob | null = null;
      const retained = await withJsonStoreMutationLock(this.queueRoot, async () => {
        const entries = await this.readEntries();
        const matching = entries.filter((entry) => entry.job.jobId === job.jobId);
        const current = chooseEntry(matching);
        if (
          !current ||
          current.job.status !== "leased" ||
          current.job.leaseOwner !== job.leaseOwner
        ) {
          return false;
        }
        const attempts = current.job.attempts + 1;
        if (attempts >= this.maxAttempts) {
          terminalJob = await this.transitionUnlocked(matching, current.job, "dead_letter", {
            attempts,
            lastError: formatStoredError(error),
          });
          return false;
        }
        await this.transitionUnlocked(matching, current.job, "prepared", {
          attempts,
          lastError: formatStoredError(error),
        });
        return true;
      });
      if (terminalJob !== null && !(await this.finalizeTerminalJob(terminalJob))) {
        this.scheduleBackgroundRecovery();
      }
      return retained;
    } catch (retainError) {
      log.warn(`dependency propagation prepared-job retention failed: ${retainError}`);
      return true;
    }
  }

  private async transitionUnlocked(
    entries: JobEntry[],
    job: DependencyPropagationJob,
    status: DependencyPropagationJobStatus,
    patch: Partial<DependencyPropagationJob> = {},
  ): Promise<DependencyPropagationJob> {
    const next: DependencyPropagationJob = {
      ...job,
      ...patch,
      status,
      updatedAt: this.clock(),
      revision: job.revision + 1,
    };
    const targetPath = await this.jobPath(status, next.jobId);
    await this.writeQueueJob(targetPath, next);
    const terminal =
      status === "completed" || status === "dead_letter" || status === "canceled";
    for (const entry of entries) {
      if (path.resolve(entry.filePath) === path.resolve(targetPath)) continue;
      await unlink(entry.filePath).catch((error: unknown) => {
        if (isNotFound(error)) return;
        if (terminal) {
          log.warn(`dependency propagation old terminal state unlink failed: ${error}`);
          return;
        }
        throw error;
      });
    }
    return next;
  }

  private async finalizeTerminalJob(job: DependencyPropagationJob): Promise<boolean> {
    if (!(await this.clearCommittedInvalidationProof(job))) return false;
    try {
      return await withJsonStoreMutationLock(this.queueRoot, () =>
        this.pruneTerminalStatusUnlocked(job.status),
      );
    } catch (error) {
      log.warn(`dependency propagation terminal finalization failed: ${error}`);
      return false;
    }
  }
  private async pruneTerminalStatusUnlocked(status: DependencyPropagationJobStatus): Promise<boolean> {
    try {
      const latestByJobId = new Map<string, JobEntry>();
      for (const entry of (await this.readEntries()).filter((item) => item.job.status === status)) {
        const current = latestByJobId.get(entry.job.jobId);
        if (!current || chooseEntry([current, entry]) === entry) {
          latestByJobId.set(entry.job.jobId, entry);
        }
      }
      const entries = [...latestByJobId.values()].sort((left, right) => {
        if (left.job.updatedAt !== right.job.updatedAt) return right.job.updatedAt - left.job.updatedAt;
        if (left.job.revision !== right.job.revision) return right.job.revision - left.job.revision;
        return compareByteStable(left.filePath, right.filePath);
      });
      const oldJobs = entries.slice(TERMINAL_RETENTION_COUNT);
      for (const entry of oldJobs) {
        if (!(await this.clearCommittedInvalidationProof(entry.job))) return false;
      }
      let removed = true;
      for (const entry of oldJobs) {
        const jobRemoved = await this.removeAllQueueFilesForJobUnlocked(entry.job.jobId);
        removed = jobRemoved && removed;
      }
      return removed;
    } catch (error) {
      log.warn(`dependency propagation terminal retention failed: ${error}`);
      return false;
    }
  }

  private async removeAllQueueFilesForJobUnlocked(jobId: string): Promise<boolean> {
    let removed = true;
    for (const status of JOB_STATES) {
      const files = await listJsonFilesStrict(await this.stateDir(status), {
        allowMissingDirectory: true,
      });
      for (const filePath of files) {
        if (path.basename(filePath, ".json") !== jobId) continue;
        try {
          await unlink(filePath);
        } catch (error) {
          if (!isNotFound(error)) {
            removed = false;
            log.warn(`dependency propagation queue cleanup unlink failed: ${error}`);
          }
        }
      }
    }
    return removed;
  }


  private async claimNext(): Promise<DependencyPropagationJob | null> {
    return withJsonStoreMutationLock(this.queueRoot, async () => {
      const now = this.clock();
      const entries = await this.readEntries();
      const candidates = new Map<string, JobEntry[]>();
      for (const entry of entries) {
        const group = candidates.get(entry.job.jobId) ?? [];
        group.push(entry);
        candidates.set(entry.job.jobId, group);
      }
      const jobs = [...candidates.values()]
        .map((group) => ({ group, current: chooseEntry(group) }))
        .filter((item): item is { group: JobEntry[]; current: JobEntry } => item.current !== undefined)
        .sort((left, right) => compareByteStable(left.current.job.jobId, right.current.job.jobId));
      for (const item of jobs) {
        const current = item.current.job;
        const expiredLease =
          current.status === "leased" &&
          (current.leaseExpiresAt ?? Number.POSITIVE_INFINITY) <= now;
        const ready = current.status === "ready";
        const retryable =
          current.status === "retryable" &&
          (current.nextAttemptAt ?? Number.POSITIVE_INFINITY) <= now;
        if (!ready && !retryable && !expiredLease) continue;
        return this.transitionUnlocked(item.group, current, "leased", {
          attempts: current.attempts + 1,
          leaseOwner: `${this.workerId}:${randomUUID()}`,
          leaseExpiresAt: now + this.leaseMs,
          nextAttemptAt: undefined,
          lastError: undefined,
        });
      }
      return null;
    });
  }

  private async processClaimed(job: DependencyPropagationJob): Promise<void> {
    let renewal = Promise.resolve();
    const heartbeatMs = Math.max(1, Math.floor(this.leaseMs / 3));
    const heartbeat = setInterval(() => {
      renewal = renewal
        .then(() => this.renewLease(job))
        .catch((error: unknown) => {
          log.warn(`dependency propagation lease renewal failed: ${error}`);
        });
    }, heartbeatMs);
    heartbeat.unref();
    try {
      const storage = await this.getStorage(job.event.namespaceScope);
      const currentEvent = await this.readCurrentReplacementEvent(storage, job.event);
      if (currentEvent === null) {
        await this.finishAttempt(job, new Error("persisted replacement is missing"));
        return;
      }
      const result = await propagateInvalidation(
        {
          storage,
          extraction: this.extraction,
          config: this.config,
          writeFence: <T>(write: () => Promise<T>) => this.withCurrentLease(job, write),
        },
        currentEvent,
      );
      const accountedDependents = result.invalidated + result.stillValid + result.uncertain;
      if (result.skipped === "timeout" || result.skipped === "llm_error") {
        await this.finishAttempt(job, new Error(`propagation skipped: ${result.skipped}`));
      } else if (accountedDependents < result.dependentsFound) {
        await this.finishAttempt(job, new Error("one or more dependent writes did not commit"));
      } else {
        await this.finishAttempt(job, null);
      }
    } catch (error) {
      await this.finishAttempt(job, error);
    } finally {
      clearInterval(heartbeat);
      await renewal;
    }
  }

  private async withCurrentLease<T>(
    job: DependencyPropagationJob,
    write: () => Promise<T>,
  ): Promise<T | undefined> {
    return withJsonStoreMutationLock(this.queueRoot, async () => {
      const entries = await this.readEntries();
      const current = chooseEntry(entries.filter((entry) => entry.job.jobId === job.jobId));
      if (
        current?.job.status !== "leased" ||
        current.job.leaseOwner !== job.leaseOwner ||
        (current.job.leaseExpiresAt ?? Number.NEGATIVE_INFINITY) <= this.clock()
      ) {
        return undefined;
      }
      const result = await write();
      const renewedEntries = await this.readEntries();
      const renewedMatching = renewedEntries.filter((entry) => entry.job.jobId === job.jobId);
      const renewedCurrent = chooseEntry(renewedMatching);
      if (
        renewedCurrent &&
        renewedCurrent.job.status === "leased" &&
        renewedCurrent.job.leaseOwner === job.leaseOwner
      ) {
        await this.transitionUnlocked(renewedMatching, renewedCurrent.job, "leased", {
          leaseExpiresAt: this.clock() + this.leaseMs,
        });
      }
      return result;
    });
  }
  private async renewLease(job: DependencyPropagationJob): Promise<void> {
    await withJsonStoreMutationLock(this.queueRoot, async () => {
      const entries = await this.readEntries();
      const matching = entries.filter((entry) => entry.job.jobId === job.jobId);
      const current = chooseEntry(matching);
      if (
        !current ||
        current.job.status !== "leased" ||
        current.job.leaseOwner !== job.leaseOwner ||
        (current.job.leaseExpiresAt ?? Number.NEGATIVE_INFINITY) <= this.clock()
      ) {
        return;
      }
      await this.transitionUnlocked(matching, current.job, "leased", {
        leaseExpiresAt: this.clock() + this.leaseMs,
      });
    });
  }

  private async finishAttempt(job: DependencyPropagationJob, error: unknown): Promise<void> {
    let retryDelayMs: number | null = null;
    let terminalJob: DependencyPropagationJob | null = null;
    try {
      await withJsonStoreMutationLock(this.queueRoot, async () => {
        const entries = await this.readEntries();
        const matching = entries.filter((entry) => entry.job.jobId === job.jobId);
        const current = chooseEntry(matching);
        if (
          !current ||
          current.job.status !== "leased" ||
          current.job.leaseOwner !== job.leaseOwner ||
          (current.job.leaseExpiresAt ?? Number.NEGATIVE_INFINITY) <= this.clock()
        ) {
          return;
        }
        if (error === null) {
          terminalJob = await this.transitionUnlocked(matching, current.job, "completed", {
            leaseOwner: undefined,
            leaseExpiresAt: undefined,
            nextAttemptAt: undefined,
            lastError: undefined,
          });
          return;
        }
        if (current.job.attempts >= this.maxAttempts) {
          terminalJob = await this.transitionUnlocked(matching, current.job, "dead_letter", {
            leaseOwner: undefined,
            leaseExpiresAt: undefined,
            nextAttemptAt: undefined,
            lastError: formatStoredError(error),
          });
          return;
        }
        retryDelayMs = this.retryDelayMs * 2 ** Math.max(0, current.job.attempts - 1);
        await this.transitionUnlocked(matching, current.job, "retryable", {
          leaseOwner: undefined,
          leaseExpiresAt: undefined,
          nextAttemptAt: this.clock() + retryDelayMs,
          lastError: formatStoredError(error),
        });
      });
      if (terminalJob !== null && !(await this.finalizeTerminalJob(terminalJob))) {
        this.scheduleBackgroundRecovery();
      }
      if (retryDelayMs !== null) this.scheduleBackgroundRun(retryDelayMs);
    } catch (finishError) {
      log.warn(`dependency propagation attempt finalization failed: ${finishError}`);
    }
  }

  private async propagateDirect(event: PropagationEvent): Promise<void> {
    try {
      const storage = await this.getStorage(event.namespaceScope);
      await propagateInvalidation(
        { storage, extraction: this.extraction, config: this.config },
        event,
      );
    } catch (error) {
      log.warn(`dependency propagation direct fallback failed: ${error}`);
    }
  }
}
