/**
 * Extraction queue coordinator — extracted from the orchestrator (issue #1526).
 *
 * Owns the background bounded-parallel queue that drains extraction tasks
 * while avoiding races between concurrent flush/heartbeat/bulk-import
 * triggers:
 *   - queue state (`queue` + `processing` + per-task preempt slots)
 *   - the scheduling trigger (start the drain when the first task lands and
 *     capacity is free)
 *   - the drain loop itself (`processQueue`): up to `concurrency` tasks run
 *     at once; tasks sharing an entry `key` (a buffer/session) never run
 *     concurrently, so the same buffer is never extracted twice in parallel
 *   - failure classification (`logExtractionQueueFailure`) — issue #549:
 *     AbortError from session transitions logs at debug, real failures at
 *     error
 *   - the idle wait (`waitForIdle`) used by bootstrap and tests
 *
 * Does NOT own the WHAT — `runExtraction`, the dedupe fingerprint check,
 * the deadline timer, and the buffer-clear policy remain on the
 * orchestrator (they need the full extraction dependency surface). The
 * orchestrator builds each task closure and hands it to `enqueue`; the
 * coordinator owns only the queue mechanics.
 *
 * Preemption is per task: each running task receives an
 * `ExtractionPreemptHandle` at run time and registers its own abort, so two
 * concurrent automatic extractions cannot clobber each other's registration
 * (the previous single-slot `runningPreempt` could only hold one).
 * `preemptRunning` aborts at most ONE armed task — the requested key's own
 * running work when it is armed, else the most recently armed task — which
 * is exactly the single-slot semantics generalized from one worker to N.
 */

import { isAbortError, preemptedExtractionError } from "../abort-error.js";
import { log } from "../logger.js";

/** Preemption registration for ONE running task. Armed work can be aborted
 *  by a fail-closed flush; disarmed work (past persist) cannot. */
export interface ExtractionPreemptHandle {
  /** Register the task's abort (replacing any previous registration). */
  arm(abort: () => void): void;
  /** Remove the task's registration (idempotent). */
  disarm(): void;
}

/** A queued task; the coordinator passes the task's own preempt handle. */
export type ExtractionQueueTask = (preempt?: ExtractionPreemptHandle) => Promise<void>;

export interface ExtractionQueueEnqueueOptions {
  /** Jump the queue and preempt the running automatic work (force flush). */
  front?: boolean;
  /** Buffer/session key. Tasks sharing a key never run concurrently. */
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

/**
 * Coordinates the background bounded-parallel extraction queue. Owns the
 * queue array, the per-key in-flight guard, and the per-task preempt slots.
 */
export class ExtractionQueueCoordinator {
  /** Maximum tasks that run at the same time (config `extractionQueueConcurrency`). */
  private readonly concurrency: number;
  /**
   * Background queue for extractions (agent_end optimization). Queue stores
   * tasks that resolve when extraction should run.
   */
  private readonly queue: QueueEntry[] = [];
  /** Whether the drain loop is currently running. */
  private processing = false;
  private accepting = true;
  /** Buffer keys with a task currently running (per-key exclusion). */
  private readonly activeKeys = new Set<string>();
  /** Preempt slots of the currently running tasks, keyed by slot identity. */
  private readonly preemptSlots = new Map<object, PreemptSlot>();
  private preemptSeq = 0;
  /** Resolves the processor's park while a new task arrives mid-drain. */
  private wake?: () => void;

  constructor(concurrency = 1) {
    this.concurrency = Number.isInteger(concurrency) && concurrency >= 1 ? concurrency : 1;
  }

  /** Current queue depth (idle-wait + test seam). */
  get length(): number {
    return this.queue.length;
  }

  /** Whether the drain loop is currently running (idle-wait + test seam). */
  get isProcessing(): boolean {
    return this.processing;
  }

  /** How many tasks may run at once (test seam + diagnostics). */
  get maxConcurrency(): number {
    return this.concurrency;
  }

  /**
   * Enqueue a task and start the processor when capacity is free. This is
   * the production entry point — the orchestrator's `queueBufferedExtraction`
   * builds each task closure and hands it here with its buffer key.
   */
  enqueue(task: ExtractionQueueTask, options?: ExtractionQueueEnqueueOptions): boolean {
    if (!this.accepting) return false;
    const entry: QueueEntry = { run: task, key: options?.key };
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
      // The processor may be parked waiting for an in-flight task while a
      // slot is free; wake it so the new task starts instead of waiting
      // behind work it could overlap with.
      this.wake?.();
    }
    return true;
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

  /** Stop new producers from entering the queue. */
  stopAccepting(): void {
    this.accepting = false;
  }

  /** Resume producer acceptance after an orchestrator re-initializes. */
  resumeAccepting(): void {
    this.accepting = true;
  }

  /** Stop new producers and wait for all accepted work to finish. */
  async pauseAndDrain(timeoutMs: number = 60_000): Promise<boolean> {
    this.stopAccepting();
    if (await this.waitForIdle(timeoutMs)) return true;
    log.warn("extraction queue drain exceeded timeout; waiting for accepted work to settle");
    await this.waitForIdle(Number.POSITIVE_INFINITY);
    return true;
  }

  /**
   * Background queue processor. Runs up to `concurrency` tasks at a time,
   * never two tasks with the same entry key. Called automatically when items
   * are queued via `enqueue`; also exposed for the characterization tests
   * that push raw tasks and assert drain semantics directly.
   */
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
        // Park until a task settles OR a new task is enqueued. A queued task
        // whose key is still held always implies an in-flight task holding
        // it, so inFlight is non-empty here whenever the loop must wait.
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

  /** Take the next queue entry whose key is not already running (FIFO within a key). */
  private takeRunnable(): QueueEntry | undefined {
    for (let index = 0; index < this.queue.length; index += 1) {
      const entry = this.queue[index];
      if (entry.key !== undefined && this.activeKeys.has(entry.key)) continue;
      this.queue.splice(index, 1);
      if (entry.key !== undefined) this.activeKeys.add(entry.key);
      return entry;
    }
    return undefined;
  }

  /** Run one entry with its own preempt slot; failures are classified + logged. */
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

  /**
   * Classify + log a failure from either the per-task catch inside
   * `runEntry` or the outer `processQueue().catch(...)` in
   * `enqueue()`.  Issue #549: `throwIfRecallAborted`
   * (used throughout `runExtraction`) raises an Error whose `name` is
   * `"AbortError"`.  That path fires when `before_reset` aborts a
   * queued task to avoid duplicate extraction — it is intentional
   * cancellation, not a failure.  Downgrading the log to debug
   * prevents spurious `error`-level lines that routinely appear
   * right next to a successful `persisted: N facts, M entities` log
   * and that confuse operators into thinking extraction is broken.
   * Genuine extraction failures (network, parse, I/O) still log at
   * `error`.
   *
   * Source differentiates the two call sites so the log message
   * names the right layer (`task` vs `processor`).
   */
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

  // ── Test seams ─────────────────────────────────────────────────────────
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
