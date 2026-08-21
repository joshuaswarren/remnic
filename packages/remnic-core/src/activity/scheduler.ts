/**
 * In-process periodic driver for activity (screen-capture) sync (issue #1900).
 *
 * The parser (config.ts) validates `config.activity` and the runner
 * (runner.ts) performs one durable sync pass, but nothing drove that pass on a
 * cadence — parsed config alone never synced. This scheduler is the missing
 * link: parser -> scheduler -> durable sync. It registers a repeating timer
 * that invokes the runner, and cancels it on stop.
 *
 * Master default-off: when `config.activity.enabled` is false, `start()`
 * registers no timer and never invokes — source config alone starts nothing.
 * `stop()` clears the timer and latches so no later tick invokes, which is what
 * a runtime teardown (or a config disable + restart) needs. Ticks are
 * overlap-guarded (a slow sync never stacks) and never throw out of the timer.
 *
 * Host-agnostic: the timer and clock are injectable, so a host schedules
 * through this without any OpenClaw import, and tests drive it deterministically.
 */

import { runActivitySyncOnce, type ActivitySyncRunSummary } from "./runner.js";
import type { ActivityConfig } from "./types.js";

/**
 * Default sync cadence: 15 minutes. Issue #1899 contracts
 * `activity.autoSyncIntervalMinutes` with a default of 15, so the effective
 * default interval is 15 * 60_000 = 900_000 ms. Overridable via `intervalMs`.
 */
export const ACTIVITY_SYNC_DEFAULT_INTERVAL_MS = 900_000;

/** An opaque timer handle from whichever timer implementation is injected. */
type TimerHandle = unknown;

export interface ActivitySyncSchedulerOptions {
  config: ActivityConfig;
  memoryDir: string;
  /** Cadence in ms; defaults to ACTIVITY_SYNC_DEFAULT_INTERVAL_MS. */
  intervalMs?: number;
  /** The sync pass to run each tick; defaults to the durable runner. */
  invoke?: (signal?: AbortSignal) => Promise<ActivitySyncRunSummary>;
  /** Search-index refresh forwarded to the default runner as `reindexSearch`. */
  reindexSearch?: (signal?: AbortSignal) => Promise<void>;
  /** Timer factory (injectable for tests); defaults to an unref'd setInterval. */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  /** Timer canceller matching setTimer; defaults to clearInterval. */
  clearTimer?: (handle: TimerHandle) => void;
  /** Called with each successful run's summary (telemetry/tests). */
  onRun?: (summary: ActivitySyncRunSummary) => void;
  /** Called when a tick's sync rejects; defaults to swallowing (best-effort). */
  onError?: (error: unknown) => void;
}

export interface ActivitySyncRegistration {
  /** True when a periodic timer was armed (feature enabled). */
  registered: boolean;
  /** The cadence the timer runs at (reported even when not registered). */
  intervalMs: number;
}

/**
 * Registers/cancels a periodic activity sync. One instance per memory dir;
 * `start()` and `stop()` are both idempotent.
 */
export class ActivitySyncScheduler {
  private readonly config: ActivityConfig;
  private readonly memoryDir: string;
  private readonly intervalMs: number;
  private readonly invoke: (signal?: AbortSignal) => Promise<ActivitySyncRunSummary>;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private readonly onRun: ((summary: ActivitySyncRunSummary) => void) | undefined;
  private readonly onError: ((error: unknown) => void) | undefined;

  private handle: TimerHandle = null;
  private stopped = false;
  private inFlight = false;
  private inFlightPromise: Promise<void> | null = null;
  private readonly abortController = new AbortController();

  constructor(options: ActivitySyncSchedulerOptions) {
    this.config = options.config;
    this.memoryDir = options.memoryDir;
    this.intervalMs = options.intervalMs ?? ACTIVITY_SYNC_DEFAULT_INTERVAL_MS;
    this.invoke =
      options.invoke ??
      ((signal) =>
        runActivitySyncOnce({
          config: this.config,
          memoryDir: this.memoryDir,
          signal,
          ...(options.reindexSearch === undefined ? {} : { reindexSearch: options.reindexSearch }),
        }));
    this.setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const timer = setInterval(fn, ms);
        // Never keep the host process alive solely for the sync cadence.
        timer.unref?.();
        return timer;
      });
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
    this.onRun = options.onRun;
    this.onError = options.onError;
  }

  /**
   * Arm the periodic sync. Disabled config (default-off) registers nothing.
   * Idempotent: a second call while running (or after stop) re-arms nothing.
   */
  start(): ActivitySyncRegistration {
    if (this.handle !== null || this.stopped || !this.config.enabled) {
      return { registered: this.handle !== null, intervalMs: this.intervalMs };
    }
    this.handle = this.setTimer(() => this.tick(), this.intervalMs);
    return { registered: true, intervalMs: this.intervalMs };
  }

  /**
   * Cancel the periodic sync and abort any in-flight tick, then resolve once it
   * has unwound. The abort + timer-clear + stop-latch happen synchronously, so
   * even a caller that cannot await (a sync teardown) still signals the running
   * sync to stop; async callers can await the returned drain. Idempotent.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.abortController.abort();
    if (this.handle !== null) {
      this.clearTimer(this.handle);
      this.handle = null;
    }
    await this.inFlightPromise?.catch(() => undefined);
  }

  private tick(): void {
    // Latched-stop and overlap guards: a callback that fires after stop(), or
    // while a prior slow sync is still running, must not invoke.
    if (this.stopped || this.inFlight) return;
    this.inFlight = true;
    this.inFlightPromise = this.invoke(this.abortController.signal)
      .then((summary) => this.onRun?.(summary))
      .catch((error) => this.onError?.(error))
      .finally(() => {
        this.inFlight = false;
        this.inFlightPromise = null;
      });
  }
}
