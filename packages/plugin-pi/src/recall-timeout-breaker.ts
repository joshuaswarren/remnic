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
 * Once tripped, the breaker stays open for the lifetime of the process; it is
 * intentionally not reset by later successes.
 */
export type RecallResult = "success" | "timeout" | "failure";

/**
 * True when an error is the explicit abort-to-timeout error produced by the
 * HTTP request layer. This deliberately excludes budget-exceeded, network,
 * HTTP/auth failures, and lookalike server-controlled messages.
 */
export function isRecallTimeoutError(err: unknown): boolean {
  if (err instanceof RemnicRequestTimeoutError) return true;
  return err instanceof Error && /^Remnic request timed out after \d+ms$/.test(err.message);
}

export interface RecallTimeoutBreakerOptions {
  /** Number of timeouts in the last {@link window} recall calls that trips the breaker. */
  threshold: number;
  /** Number of recent recall calls kept in the rolling window. */
  window: number;
}

export class RecallTimeoutBreaker {
  private tripped = false;
  private readonly results: boolean[] = [];
  private readonly threshold: number;
  private readonly windowSize: number;
  private readonly abortController = new AbortController();

  constructor(options: RecallTimeoutBreakerOptions) {
    const { threshold, window } = options;
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
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  isTripped(): boolean {
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

