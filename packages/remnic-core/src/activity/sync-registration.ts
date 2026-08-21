/**
 * Activity (screen-capture) sync lifecycle owner (issue #1900).
 *
 * The MaintenanceScheduler used to inline the arm / re-arm / teardown wiring
 * for the periodic activity sync, which made the lifecycle invariants easy to
 * break one edit at a time. This module centralizes them in one testable place:
 *
 *  - Re-arm and teardown BOTH stop any prior scheduler first, so a repeated
 *    registration never orphans a running interval.
 *  - An aborted deferred-init signal means teardown began. `destroy()` aborts
 *    the init signal *before* it disposes, so an aborted signal here also
 *    implies `dispose()` may already have latched teardown. `register()` never
 *    arms nor clears the latch while aborted — even when the abort lands
 *    mid-drain — so a late re-init cannot resurrect a torn-down instance.
 *  - The teardown latch gates the reindex-failure retry, so a draining tick's
 *    `onRun` cannot queue QMD maintenance after teardown.
 *  - Activity digests + SQLite are written in the clear, so the registrar
 *    refuses to arm under a secure store rather than silently bypass opted-in
 *    at-rest encryption.
 *
 * Host-agnostic: the scheduler factory is injectable, so tests drive the whole
 * lifecycle against a fake scheduler without real timers.
 */

import { refreshActivityIndex, type ActivityIndexRefresher } from "./reindex.js";
import type { ActivitySyncRunSummary } from "./runner.js";
import { ActivitySyncScheduler, type ActivitySyncSchedulerOptions } from "./scheduler.js";
import type { ActivityConfig } from "./types.js";
import { log } from "../logger.js";

/** The scheduler surface the registrar drives (injectable for tests). */
export interface ActivitySyncSchedulerLike {
  start(): unknown;
  stop(): Promise<void>;
}

export interface ActivitySyncRegistrarDeps {
  /** Activity sync settings; the master default-off flag lives here. */
  readonly config: ActivityConfig;
  /** Memory root the digests + SQLite store live under. */
  readonly memoryDir: string;
  /** QMD collection the day digest is (strictly) reindexed into. */
  readonly qmdCollection: string;
  /**
   * True when at-rest encryption is configured. Activity writes are not yet
   * encrypted, so the registrar refuses to arm rather than leak plaintext.
   */
  readonly secureStoreEnabled: boolean;
  /** Live QMD accessor — the host may swap backends after construction. */
  readonly getQmd: () => ActivityIndexRefresher;
  /** Debounced/singleflighted QMD retry used when a tick's reindex fails. */
  readonly requestReindexRetry: () => void;
  /**
   * Tail step (issue #1900): observe a completed sync tick so a dependent
   * subsystem (meeting building) can rebuild the affected day(s). Fired only
   * after a durable tick and never after teardown. Optional; omitted by hosts
   * that do not build meetings.
   */
  readonly onSynced?: (summary: ActivitySyncRunSummary) => void;
  /** Scheduler factory (injectable for tests); defaults to the real scheduler. */
  readonly createScheduler?: (options: ActivitySyncSchedulerOptions) => ActivitySyncSchedulerLike;
}

export class ActivitySyncRegistrar {
  private scheduler: ActivitySyncSchedulerLike | null = null;
  /** Latched by dispose() so a draining tick's onRun cannot re-arm maintenance. */
  private disposed = false;
  private readonly createScheduler: (options: ActivitySyncSchedulerOptions) => ActivitySyncSchedulerLike;

  constructor(private readonly deps: ActivitySyncRegistrarDeps) {
    this.createScheduler = deps.createScheduler ?? ((options) => new ActivitySyncScheduler(options));
  }

  /** True while a scheduler is armed (test/telemetry observability). */
  get armed(): boolean {
    return this.scheduler !== null;
  }

  /**
   * Arm (or re-arm) the periodic sync for the current lifecycle. Idempotent and
   * safe to call repeatedly; always stops a prior scheduler first.
   */
  async register(signal: AbortSignal): Promise<void> {
    // Re-arm or teardown: stop any prior scheduler before anything else, so a
    // repeated registration never orphans a running interval.
    const prior = this.scheduler;
    this.scheduler = null;
    await prior?.stop();
    // Teardown began (possibly during the drain above). Never arm nor clear the
    // latch: dispose() may already have set it, and it must stay set.
    if (signal.aborted) return;
    // Opted-in at-rest encryption must not be silently bypassed: activity
    // digests + SQLite are written in the clear, so refuse to run under it.
    if (this.deps.secureStoreEnabled && this.deps.config.enabled) {
      log.warn(
        "activity sync disabled: secure store is enabled but activity digests/SQLite are not encrypted at rest",
      );
      return;
    }
    // Committed to a fresh lifecycle: clear the latch so this scheduler's
    // reindex retries fire again.
    this.disposed = false;
    try {
      const scheduler = this.createScheduler({
        config: this.deps.config,
        memoryDir: this.deps.memoryDir,
        intervalMs: this.deps.config.autoSyncIntervalMinutes * 60_000,
        // Strict refresh after each digest write (rule 31): bypasses the
        // min-interval gate and throws on a real failure.
        reindexSearch: (sig) => refreshActivityIndex(this.deps.getQmd(), this.deps.qmdCollection, sig),
        // A failed reindex (QMD down) leaves the next unchanged-digest tick
        // skipping afterWrites, so route the retry through the durable,
        // throttled QMD path — but never after teardown.
        onRun: (summary: ActivitySyncRunSummary) => {
          if (summary.reindexErrorCount > 0 && !this.disposed) {
            log.warn(
              `activity sync: ${summary.reindexErrorCount} source(s) had a failed reindex; queuing a maintenance retry`,
            );
            this.deps.requestReindexRetry();
          }
          // Tail step: a durable tick that ingested snapshots may have changed a
          // meeting's screen context; notify the dependent builder. Never after
          // teardown.
          if (summary.enabled && summary.totalInserted > 0 && !this.disposed) {
            this.deps.onSynced?.(summary);
          }
        },
      });
      this.scheduler = scheduler;
      scheduler.start();
      // Close the race where abort fires between the guard above and start().
      if (signal.aborted) {
        await scheduler.stop();
        this.scheduler = null;
      }
    } catch (err) {
      log.debug(`activity sync scheduler start failed (non-fatal): ${err}`);
    }
  }

  /**
   * Latch teardown and drain the scheduler. Latching first ensures a draining
   * tick's onRun cannot queue a retry; the drain is awaited so no in-flight
   * tick keeps writing after teardown.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    const drain = this.scheduler?.stop();
    this.scheduler = null;
    await drain;
  }
}
