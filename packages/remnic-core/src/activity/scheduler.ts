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

  constructor(options: ActivitySyncSchedulerOptions) {
    this.config = options.config;
    this.memoryDir = options.memoryDir;
    this.intervalMs = options.intervalMs ?? ACTIVITY_SYNC_DEFAULT_INTERVAL_MS;
    this.invoke =
      options.invoke ?? ((signal) => runActivitySyncOnce({ config: this.config, memoryDir: this.memoryDir, signal }));
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

  /** Cancel the periodic sync; no later tick invokes. Idempotent. */
  stop(): void {
    this.stopped = true;
    if (this.handle !== null) {
      this.clearTimer(this.handle);
      this.handle = null;
    }
  }

  private tick(): void {
    // Latched-stop and overlap guards: a callback that fires after stop(), or
    // while a prior slow sync is still running, must not invoke.
    if (this.stopped || this.inFlight) return;
    this.inFlight = true;
    void this.invoke()
      .then((summary) => this.onRun?.(summary))
      .catch((error) => this.onError?.(error))
      .finally(() => {
        this.inFlight = false;
      });
  }
}
