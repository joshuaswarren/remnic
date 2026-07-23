/**
 * Debounced meetings build scheduler (issue #1900) — the tail step after a
 * sync. A completed activity or wearable sync for a day calls
 * `requestBuild(date)`; this coalesces bursts (a wearable window sync touches
 * several days; an activity tick and a wearable tick can land together) onto a
 * per-day trailing-edge timer so the day is (re)built at most once per debounce
 * window instead of once per sync signal.
 *
 * Single-flight per day: a build in flight for a date defers a fresh request to
 * a follow-up build after it settles, so a late sync signal is never dropped.
 * `debounceMs: 0` builds on the next tick (no coalescing window). Errors are
 * isolated per day and routed to `onError` — a failed build must never reject
 * the sync path that requested it.
 */

export interface MeetingsBuildSchedulerOptions {
  /** Trailing-edge coalescing window (ms). 0 = build on the next tick. */
  debounceMs: number;
  /** Build one day. Rejections are caught and routed to `onError`. */
  build(date: string): Promise<unknown>;
  /** Observe a build failure (logging). Never called for success. */
  onError?(date: string, err: unknown): void;
}

export class MeetingsBuildScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Days whose timer has fired and are running (single-flight promise). */
  private readonly running = new Map<string, Promise<void>>();
  /** Days requested again while their build was in flight (trailing rebuild). */
  private readonly rerun = new Set<string>();
  private disposed = false;

  constructor(private readonly opts: MeetingsBuildSchedulerOptions) {}

  /** Request a (debounced) build for a day. Idempotent within the window. */
  requestBuild(date: string): void {
    if (this.disposed) return;
    clearTimeout(this.timers.get(date));
    const timer = setTimeout(() => {
      this.timers.delete(date);
      void this.fire(date);
    }, Math.max(0, this.opts.debounceMs));
    // Do not keep the event loop alive for a pending trailing build.
    timer.unref();
    this.timers.set(date, timer);
  }

  /** Run every armed timer's build now and await completion (teardown/tests). */
  async flush(): Promise<void> {
    for (const [date, timer] of this.timers) {
      clearTimeout(timer);
      this.timers.delete(date);
      void this.fire(date);
    }
    // Drain in-flight builds (and any trailing reruns they spawn).
    while (this.running.size > 0) {
      await Promise.allSettled([...this.running.values()]);
    }
  }

  /** Cancel all armed timers without running them. */
  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** True while any day has an armed timer or an in-flight build. */
  get pending(): boolean {
    return this.timers.size > 0 || this.running.size > 0;
  }

  private fire(date: string): Promise<void> {
    // Single-flight: fold a concurrent request into a trailing rebuild.
    const inflight = this.running.get(date);
    if (inflight !== undefined) {
      this.rerun.add(date);
      return inflight;
    }
    const run = this.runBuild(date).then(() => {
      this.running.delete(date);
      if (this.rerun.delete(date) && !this.disposed) return this.fire(date);
      return undefined;
    });
    this.running.set(date, run);
    return run;
  }

  private async runBuild(date: string): Promise<void> {
    try {
      await this.opts.build(date);
    } catch (err) {
      this.opts.onError?.(date, err);
    }
  }
}
