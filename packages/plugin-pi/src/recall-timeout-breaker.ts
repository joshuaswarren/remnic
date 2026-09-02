import { RemnicRequestTimeoutError } from "./client.js";

/**
 * In-memory rolling-window circuit breaker for automatic Pi context recalls.
 *
 * Only explicit Remnic request timeouts (the abort-to-timeout conversion from
 * {@link RemnicClient.request}) count toward the trip threshold. Other recall
 * failures (HTTP responses, auth errors, transient network failures) are still
 * recorded in the rolling window so they age out older timeouts, but they do
 * not increment the timeout counter.
 *
 * Once tripped, the breaker pauses recall for a cooldown (default 5 minutes,
 * tunable via {@link RecallTimeoutBreakerOptions.resetAfterMs}) and then
 * re-arms itself: the rolling window clears, a fresh abort controller is
 * installed, and the next recall acts as the probe. Sustained saturation
 * simply re-trips it; a recovered daemon resumes recall without a process
 * restart.
 */
export type RecallResult = "success" | "timeout" | "failure";

/**
 * True when an error is the explicit abort-to-timeout error produced by the
 * HTTP request layer. This deliberately excludes budget-exceeded, network,
 * HTTP/auth failures, and lookalike server-controlled messages.
 */
export function isRecallTimeoutError(err: unknown): boolean {
  return err instanceof RemnicRequestTimeoutError;
}

export interface RecallTimeoutBreakerOptions {
  /** Number of timeouts in the last {@link window} recall calls that trips the breaker. */
  threshold: number;
  /** Number of recent recall calls kept in the rolling window. */
  window: number;
  /**
   * Cooldown in milliseconds after a trip before the breaker re-arms itself.
   * Defaults to 300000 (5 minutes).
   */
  resetAfterMs?: number;
}

export class RecallTimeoutBreaker {
  private tripped = false;
  private trippedAt = 0;
  private readonly results: boolean[] = [];
  private readonly threshold: number;
  private readonly windowSize: number;
  private readonly resetAfterMs: number;
  private abortController = new AbortController();

  constructor(options: RecallTimeoutBreakerOptions) {
    const { threshold, window, resetAfterMs } = options;
    if (
      typeof threshold !== "number" ||
      !Number.isInteger(threshold) ||
      threshold <= 0 ||
      typeof window !== "number" ||
      !Number.isInteger(window) ||
      window <= 0 ||
      threshold > window
    ) {
      throw new Error(
        `Invalid RecallTimeoutBreaker options: threshold and window must be positive integers with threshold <= window (got threshold=${threshold}, window=${window})`,
      );
    }
    this.threshold = threshold;
    this.windowSize = window;
    if (
      resetAfterMs !== undefined &&
      (typeof resetAfterMs !== "number" || !Number.isInteger(resetAfterMs) || resetAfterMs <= 0)
    ) {
      throw new Error(
        `Invalid RecallTimeoutBreaker options: resetAfterMs must be a positive integer (got ${resetAfterMs})`,
      );
    }
    this.resetAfterMs = resetAfterMs ?? 300000;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  isTripped(): boolean {
    if (this.tripped && Date.now() - this.trippedAt >= this.resetAfterMs) {
      this.tripped = false;
      this.trippedAt = 0;
      this.results.length = 0;
      this.abortController = new AbortController();
      return false;
    }
    return this.tripped;
  }

  recordSuccess(): void {
    this.record("success");
  }

  recordTimeout(): boolean {
    return this.record("timeout");
  }

  recordFailure(): void {
    this.record("failure");
  }

  record(result: RecallResult): boolean {
    if (this.tripped) return false;

    this.results.push(result === "timeout");
    if (this.results.length > this.windowSize) this.results.shift();

    if (this.timeoutCount() >= this.threshold) {
      this.tripped = true;
      this.trippedAt = Date.now();
      this.abortController.abort();
      return true;
    }

    return false;
  }

  timeoutCount(): number {
    let count = 0;
    for (const timedOut of this.results) {
      if (timedOut) count += 1;
    }
    return count;
  }
}

