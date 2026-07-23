/**
 * Event-driven live capture loop (#1899 Part 1).
 *
 * Each poll fetches the frontmost AX snapshot. A change in the foreground
 * identity (app, windowTitle, browserUrl) opens a settle window; once the
 * foreground has been stable for `settleMs` the snapshot is run through the
 * pipeline and stored. A foreground that never changes is re-sampled at least
 * every `idleFallbackSeconds` (dedup drops it when unchanged). This is pure
 * orchestration — the native macOS helper supplies the snapshots, and the same
 * pipeline (deny-list, redaction, dedup, supersession) that `--replay` uses is
 * applied here, so behaviour is fully testable off-macOS with a fake helper.
 */

import type { CaptureProcessor } from "./capture.js";
import type { DaemonConfig } from "./config.js";
import type { NativeHelper } from "./helper.js";
import { captureFromSnapshot } from "./live.js";
import type { Spool } from "./spool.js";

/** Injectable clock/timer so the loop is deterministically testable. */
export interface SchedulerClock {
  now(): number;
  setInterval(fn: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

const systemClock: SchedulerClock = {
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle),
};

export interface SchedulerHooks {
  /** Called when a poll cycle throws (helper failure); the loop keeps running. */
  onError?: (err: unknown) => void;
  /** Called after a snapshot is stored. */
  onStore?: (app: string, windowTitle: string) => void;
}

export class CaptureScheduler {
  readonly #helper: NativeHelper;
  readonly #processor: CaptureProcessor;
  readonly #spool: Spool;
  readonly #config: DaemonConfig;
  readonly #hooks: SchedulerHooks;
  readonly #clock: SchedulerClock;
  #timer: ReturnType<typeof setInterval> | null = null;
  #inflight = false;
  #lastKey: string | null = null;
  #changeAt = 0;
  #pending = false;
  #lastCaptureAt = Number.NEGATIVE_INFINITY;

  constructor(
    helper: NativeHelper,
    processor: CaptureProcessor,
    spool: Spool,
    config: DaemonConfig,
    hooks: SchedulerHooks = {},
    clock: SchedulerClock = systemClock,
  ) {
    this.#helper = helper;
    this.#processor = processor;
    this.#spool = spool;
    this.#config = config;
    this.#hooks = hooks;
    this.#clock = clock;
  }

  /** Begin polling. Idempotent; stops automatically when `signal` aborts. */
  start(signal?: AbortSignal): void {
    if (this.#timer !== null) return;
    this.#timer = this.#clock.setInterval(() => void this.tick(), this.#config.pollIntervalMs);
    signal?.addEventListener("abort", () => this.stop(), { once: true });
  }

  stop(): void {
    if (this.#timer !== null) {
      this.#clock.clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * One poll cycle. Exposed (not private) so tests can drive the loop
   * deterministically with a fake clock instead of real timers. Overlapping
   * ticks are skipped so a slow helper never runs two captures at once.
   */
  async tick(): Promise<void> {
    if (this.#inflight) return;
    this.#inflight = true;
    try {
      const snap = await this.#helper.axSnapshot({ frontmost: true, maxNodes: this.#config.maxNodes });
      const key = `${snap.app}\u0000${snap.windowTitle}\u0000${snap.browserUrl ?? ""}`;
      const now = this.#clock.now();
      // Anchor the idle heartbeat to the first poll so the fallback measures from
      // startup, not since epoch — otherwise it would preempt the settle window.
      if (this.#lastCaptureAt === Number.NEGATIVE_INFINITY) {
        this.#lastCaptureAt = now;
      }

      if (key !== this.#lastKey) {
        // Foreground changed — open a settle window; capture only once stable.
        this.#lastKey = key;
        this.#changeAt = now;
        this.#pending = true;
        return;
      }

      const settled = this.#pending && now - this.#changeAt >= this.#config.settleMs;
      const idle = now - this.#lastCaptureAt >= this.#config.idleFallbackSeconds * 1000;
      if (!settled && !idle) return;

      const decision = await captureFromSnapshot(
        snap,
        this.#helper,
        this.#processor,
        this.#config,
        new Date(now).toISOString(),
      );
      this.#pending = false;
      this.#lastCaptureAt = now;
      if (decision.action === "store") {
        this.#spool.insertSnapshot(decision.snapshot, this.#config.sessionGapSeconds);
        this.#hooks.onStore?.(snap.app, snap.windowTitle);
      }
    } catch (err) {
      this.#hooks.onError?.(err);
    } finally {
      this.#inflight = false;
    }
  }
}
