
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
    timer.unref();
    this.timers.set(date, timer);
  }

  async flush(): Promise<void> {
    for (const [date, timer] of this.timers) {
      clearTimeout(timer);
      this.timers.delete(date);
      void this.fire(date);
    }
    while (this.running.size > 0) {
      await Promise.allSettled([...this.running.values()]);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  get pending(): boolean {
    return this.timers.size > 0 || this.running.size > 0;
  }

  private fire(date: string): Promise<void> {
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
