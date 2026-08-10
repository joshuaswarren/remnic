/**
 * Extraction queue coordinator — extracted from the orchestrator (issue #1526).
 *
 * Owns the background serial queue that drains extraction tasks one at a
 * time to avoid races between concurrent flush/heartbeat/bulk-import
 * triggers:
 *   - queue state (`extractionQueue` + `queueProcessing`)
 *   - the scheduling trigger (start the drain when the first task lands and
 *     the processor is idle)
 *   - the serial drain loop itself (`processQueue`)
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
 * Behavior-preserving move from orchestrator.ts. No logic changes — the
 * orchestrator keeps a thin delegating `waitForExtractionIdle` and the
 * `queueBufferedExtraction` builder delegates push+scheduling here.
 */

import { isAbortError } from "../abort-error.js";
import { log } from "../logger.js";

/**
 * Coordinates the background serial extraction queue. Owns the in-flight
 * guard + queue array that previously lived as private orchestrator fields.
 */
export class ExtractionQueueCoordinator {
  /**
   * Background serial queue for extractions (agent_end optimization).
   * Queue stores tasks that resolve when extraction should run.
   */
  private readonly queue: Array<() => Promise<void>> = [];
  /** Whether the serial drain loop is currently running. */
  private processing = false;
  private accepting = true;

  /** Current queue depth (idle-wait + test seam). */
  get length(): number {
    return this.queue.length;
  }

  /** Whether the serial drain loop is currently running (idle-wait + test seam). */
  get isProcessing(): boolean {
    return this.processing;
  }

  /**
   * Enqueue a task and start the serial processor if it is idle. This is
   * the production entry point — the orchestrator's `queueBufferedExtraction`
   * builds each task closure and hands it here.
   */
  enqueue(task: () => Promise<void>): boolean {
    if (!this.accepting) return false;
    this.queue.push(task);
    if (!this.processing) {
      this.processing = true;
      this.processQueue().catch((err) => {
        this.logExtractionQueueFailure(err, "processor");
        this.processing = false;
      });
    }
    return true;
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
    return this.waitForIdle(timeoutMs);
  }

  /**
   * Background serial queue processor.
   * Processes extractions one at a time to avoid race conditions.
   * Called automatically when items are queued via `enqueue`; also exposed
   * for the characterization tests that push raw tasks and assert drain
   * semantics directly.
   */
  async processQueue(): Promise<void> {
    while (this.queue.length > 0) {
      const task = this.queue.shift();
      if (task) {
        try {
          await task();
        } catch (err) {
          this.logExtractionQueueFailure(err, "task");
        }
      }
    }

    this.processing = false;
  }

  /**
   * Classify + log a failure from either the per-task catch inside
   * `processQueue()` or the outer `processQueue().catch(...)` in
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
  pushRaw(task: () => Promise<void>): void {
    this.queue.push(task);
  }

  /** Remove + return the front task (test seam for the flush deadline tests). */
  shift(): (() => Promise<void>) | undefined {
    return this.queue.shift();
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
