
import { isAbortError, preemptedExtractionError } from "../abort-error.js";
import { log } from "../logger.js";

/** Preemption registration for ONE running task. Armed work can be aborted
 *  by a fail-closed flush; disarmed work (past persist) cannot. */
export interface ExtractionPreemptHandle {
  arm(abort: () => void): void;
  disarm(): void;
}

export type ExtractionQueueTask = (preempt?: ExtractionPreemptHandle) => Promise<void>;

export interface ExtractionQueueEnqueueOptions {
  front?: boolean;
  key?: string;
}

interface QueueEntry {
  run: ExtractionQueueTask;
  key?: string;
}

interface PreemptSlot {
  key?: string;
  armed?: { abort: () => void; seq: number };
}

export class ExtractionQueueCoordinator {
  /** Maximum tasks that run at the same time (config `extractionQueueConcurrency`). */
  private readonly concurrency: number;
  private readonly queue: QueueEntry[] = [];
  private processing = false;
  private accepting = true;
  private readonly activeKeys = new Set<string>();
  private readonly reservedKeys = new Set<string>();
  private readonly preemptSlots = new Map<object, PreemptSlot>();
  private preemptSeq = 0;
  /** Resolves the processor's park while a new task arrives mid-drain. */
  private wake?: () => void;

  constructor(concurrency = 2) {
    this.concurrency = Number.isInteger(concurrency) && concurrency >= 1 ? concurrency : 1;
  }

  get length(): number {
    return this.queue.length;
  }

  get isProcessing(): boolean {
    return this.processing;
  }

  get maxConcurrency(): number {
    return this.concurrency;
  }

  /**
   * Enqueue a task and start the processor when capacity is free. Each task
   * keeps its own captured work and settlement; keyed tasks serialize behind
   * other tasks for that key. A front task may jump the queue but does not
   * discard queued work.
   */
  enqueue(task: ExtractionQueueTask, options?: ExtractionQueueEnqueueOptions): boolean {
    if (!this.accepting) return false;
    const key = options?.key;
    const entry: QueueEntry = { run: task, key };
    if (options?.front) {
      this.preemptRunning(options.key);
      this.queue.unshift(entry);
    } else {
      this.queue.push(entry);
    }
    if (!this.processing) {
      this.processing = true;
      this.processQueue().catch((err) => {
        this.logExtractionQueueFailure(err, "processor");
        this.processing = false;
      });
    } else {
      this.wake?.();
    }
    return true;
  }

  tryReserveKey(key: string): boolean {
    if (this.activeKeys.has(key) || this.reservedKeys.has(key)) return false;
    if (this.queue.some((entry) => entry.key === key)) return false;
    this.reservedKeys.add(key);
    if (!this.processing && this.queue.length > 0) {
      this.processing = true;
      this.processQueue().catch((err) => {
        this.logExtractionQueueFailure(err, "processor");
        this.processing = false;
      });
    }
    return true;
  }

  releaseKeyReservation(key: string): void {
    if (!this.reservedKeys.delete(key)) return;
    if (this.queue.length > 0 && !this.processing) {
      this.processing = true;
      this.processQueue().catch((err) => {
        this.logExtractionQueueFailure(err, "processor");
        this.processing = false;
      });
    } else {
      this.wake?.();
    }
  }

  preemptRunning(preferredKey?: string): void {
    const armed = Array.from(this.preemptSlots.values()).filter((slot) => slot.armed !== undefined);
    if (armed.length === 0) return;
    const preferred = preferredKey !== undefined ? armed.find((slot) => slot.key === preferredKey) : undefined;
    const chosen =
      preferred ??
      armed.reduce((a, b) => ((b.armed?.seq ?? -1) > (a.armed?.seq ?? -1) ? b : a));
    const abort = chosen.armed?.abort;
    chosen.armed = undefined;
    abort?.();
  }

  runPreemptable<T>(
    preempt: ExtractionPreemptHandle | undefined,
    preemptable: boolean,
    parent: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const preemptController = new AbortController();
    if (preemptable && preempt) {
      preempt.arm(() => preemptController.abort(preemptedExtractionError()));
    }
    const signal = parent ? AbortSignal.any([parent, preemptController.signal]) : preemptController.signal;
    return Promise.resolve(run(signal)).finally(() => {
      if (preemptable && preempt) preempt.disarm();
    });
  }

  stopAccepting(): void {
    this.accepting = false;
  }

  resumeAccepting(): void {
    this.accepting = true;
  }

  async pauseAndDrain(timeoutMs: number = 60_000, tailBudgetMs: number = 15_000): Promise<boolean> {
    this.stopAccepting();
    const startedMs = Date.now();
    if (await this.waitForIdle(timeoutMs)) return true;
    log.warn(
      `extraction queue drain exceeded ${timeoutMs}ms; waiting up to ` +
        `${tailBudgetMs}ms more for accepted work to settle (${this.describeOutstanding()})`,
    );
    if (await this.waitForIdle(tailBudgetMs)) return true;
    log.warn(
      `extraction queue drain abandoned after ${Date.now() - startedMs}ms; ` +
        `${this.describeOutstanding()} still outstanding`,
    );
    return false;
  }

  /** Name what the drain is still waiting on, for timeout diagnostics. */
  private describeOutstanding(): string {
    const names = [
      ...[...this.preemptSlots.values()].map((s) => `in-flight '${s.key ?? "(unkeyed)"}'`),
      ...this.queue.map((e) => `queued '${e.key ?? "(unkeyed)"}'`),
    ];
    return names.length > 0 ? `outstanding: ${names.join(", ")}` : "outstanding: (none)";
  }

  async processQueue(): Promise<void> {
    const inFlight = new Set<Promise<void>>();
    try {
      while (this.queue.length > 0 || inFlight.size > 0) {
        while (inFlight.size < this.concurrency) {
          const entry = this.takeRunnable();
          if (!entry) break;
          const running = this.runEntry(entry).finally(() => {
            inFlight.delete(running);
          });
          inFlight.add(running);
        }
        if (inFlight.size === 0) break;
        const { promise: wakePromise, resolve: wake } = Promise.withResolvers<void>();
        this.wake = wake;
        try {
          await Promise.race([wakePromise, ...inFlight]);
        } finally {
          this.wake = undefined;
        }
      }
    } finally {
      this.processing = false;
    }
  }

  /** Take the next queue entry whose key is not already running or reserved (FIFO within a key). */
  private takeRunnable(): QueueEntry | undefined {
    for (let index = 0; index < this.queue.length; index += 1) {
      const entry = this.queue[index];
      if (entry.key !== undefined && (this.activeKeys.has(entry.key) || this.reservedKeys.has(entry.key))) continue;
      this.queue.splice(index, 1);
      if (entry.key !== undefined) this.activeKeys.add(entry.key);
      return entry;
    }
    return undefined;
  }

  private async runEntry(entry: QueueEntry): Promise<void> {
    const slot: PreemptSlot = {};
    this.preemptSlots.set(slot, { key: entry.key });
    try {
      await entry.run(this.createPreemptHandle(slot));
    } catch (err) {
      this.logExtractionQueueFailure(err, "task");
    } finally {
      this.preemptSlots.delete(slot);
      if (entry.key !== undefined) this.activeKeys.delete(entry.key);
    }
  }

  /** Test + force-flush observability: register a keyed preempt slot the way
   *  `runEntry` does for a queued task, so callers can exercise the keyed
   *  preemption path without a full queue. */
  registerPreemptSlot(key: string): ExtractionPreemptHandle {
    const slot: PreemptSlot = {};
    this.preemptSlots.set(slot, { key });
    return this.createPreemptHandle(slot);
  }

  preemptKeyed(key: string): void {
    for (const state of this.preemptSlots.values()) {
      if (state.key !== key || state.armed === undefined) continue;
      const abort = state.armed.abort;
      state.armed = undefined;
      abort();
    }
  }

  private createPreemptHandle(slot: PreemptSlot): ExtractionPreemptHandle {
    return {
      arm: (abort: () => void) => {
        const state = this.preemptSlots.get(slot);
        if (state) state.armed = { abort, seq: this.preemptSeq++ };
      },
      disarm: () => {
        const state = this.preemptSlots.get(slot);
        if (state) state.armed = undefined;
      },
    };
  }

  logExtractionQueueFailure(
    err: unknown,
    source: "task" | "processor",
  ): void {
    const aborted =
      source === "task"
        ? "background extraction task aborted (session transition)"
        : "background extraction queue processor aborted (session transition)";
    const failed =
      source === "task"
        ? "background extraction task failed"
        : "background extraction queue processor failed";
    if (isAbortError(err)) {
      log.debug(aborted);
    } else {
      log.error(failed, err);
    }
  }

  /**
   * Wait until the extraction queue is fully drained (no tasks queued, no
   * drain in flight) or `timeoutMs` elapses. Used by bootstrap (after a
   * dry-run import) and by tests that need to assert extraction settled.
   * Returns false on timeout, true once idle.
   */
  async waitForIdle(timeoutMs: number = 60_000): Promise<boolean> {
    const started = Date.now();
    while (this.processing || this.queue.length > 0) {
      if (Date.now() - started > timeoutMs) {
        log.warn(`waitForExtractionIdle timed out after ${timeoutMs}ms`);
        return false;
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 50);
      await promise;
    }
    return true;
  }

  // Mirror the pre-extraction `orchestrator.extractionQueue` /
  // `orchestrator.queueProcessing` direct-field access the characterization
  // and flush deadline tests relied on. Each is a thin, well-named handle
  // onto the coordinator's private state — no behavior change.

  /**
   * Push a raw task WITHOUT auto-starting the processor, matching the
   * pre-extraction `this.extractionQueue.push(...)` used by the
   * characterization tests that drive the drain manually via `processQueue`.
   */
  pushRaw(task: ExtractionQueueTask, options?: { key?: string }): void {
    this.queue.push({ run: task, key: options?.key });
    this.wake?.();
  }

  /** Remove + return the front task (test seam for the flush deadline tests). */
  shift(): ExtractionQueueTask | undefined {
    return this.queue.shift()?.run;
  }

  /**
   * Force the processor-busy flag so `enqueue` does not auto-start the
   * drain — used by the flush deadline test to simulate a busy queue and
   * assert a queued task's deadline expires while it waits.
   */
  setProcessingForTest(value: boolean): void {
    this.processing = value;
  }
}
