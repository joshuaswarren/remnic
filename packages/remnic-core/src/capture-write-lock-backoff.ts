/**
 * Backoff for the tombstone-blocked capture write lock (COS-392).
 *
 * A converge cycle used to give up after three probes about 25ms apart while
 * the daemon still held the lock for an ordinary write. Waiters now sleep
 * outside every lock: equal-jitter exponential backoff, capped per wait, with
 * one overall deadline. The numbers are the production defaults; converge
 * config and env can override them.
 */

export const CAPTURE_WRITE_LOCK_BUSY_MESSAGE = "tombstone-blocked capture write lock remained busy";

export function isTombstoneBlockedCaptureWriteLockBusy(error: unknown): boolean {
  return error instanceof Error && error.message === CAPTURE_WRITE_LOCK_BUSY_MESSAGE;
}

export const DEFAULT_CAPTURE_WRITE_LOCK_INITIAL_DELAY_MS = 50;
export const DEFAULT_CAPTURE_WRITE_LOCK_MAX_DELAY_MS = 2_000;
export const DEFAULT_CAPTURE_WRITE_LOCK_DEADLINE_MS = 60_000;
/** Same hour ceiling as the converge peer HTTP timeout. */
export const MAX_CAPTURE_WRITE_LOCK_WAIT_MS = 3_600_000;

const MAX_BACKOFF_EXPONENT = 16;

export type CaptureWriteLockBackoffLimits = {
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly deadlineMs: number;
};

export type CaptureWriteLockLimitSource = {
  readonly captureWriteLockInitialDelayMs?: number;
  readonly captureWriteLockMaxDelayMs?: number;
  readonly captureWriteLockDeadlineMs?: number;
  /**
   * Read when an acquire starts. Converge installs the apply abort signal
   * here so a SIGINT during backoff never reaches the guarded write.
   */
  readonly captureWriteLockSignal?: AbortSignal;
};

/**
 * One backoff wait. Attempt 0 is uniform in `[ceil(initial/2), initial]`
 * (25–50ms at the defaults). Each later attempt doubles that window until
 * `maxDelayMs`. `random` returns a finite number in `[0, 1]`.
 */
export function captureWriteLockDelayMs(
  attempt: number,
  limits: Pick<CaptureWriteLockBackoffLimits, "initialDelayMs" | "maxDelayMs">,
  random: () => number = Math.random
): number {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new TypeError("capture write lock backoff attempt must be a non-negative integer");
  }
  if (!Number.isInteger(limits.initialDelayMs) || limits.initialDelayMs <= 0) {
    throw new TypeError("capture write lock initialDelayMs must be a positive integer");
  }
  if (!Number.isInteger(limits.maxDelayMs) || limits.maxDelayMs <= 0) {
    throw new TypeError("capture write lock maxDelayMs must be a positive integer");
  }
  if (limits.initialDelayMs > limits.maxDelayMs) {
    throw new TypeError("capture write lock initialDelayMs must be <= maxDelayMs");
  }
  const unit = random();
  if (typeof unit !== "number" || !Number.isFinite(unit) || unit < 0 || unit > 1) {
    throw new TypeError("capture write lock jitter source must return a finite number in [0, 1]");
  }
  const exponent = Math.min(attempt, MAX_BACKOFF_EXPONENT);
  const ceiling = Math.min(limits.maxDelayMs, limits.initialDelayMs * 2 ** exponent);
  const floor = Math.ceil(ceiling / 2);
  if (ceiling <= floor) return ceiling;
  const span = ceiling - floor;
  const offset = Math.min(span, Math.floor(unit * (span + 1)));
  return floor + offset;
}

export function normalizeCaptureWriteLockWaitMs(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer number of milliseconds; got ${JSON.stringify(value)}`);
  }
  return Math.min(value, MAX_CAPTURE_WRITE_LOCK_WAIT_MS);
}

function pickWaitMs(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  return normalizeCaptureWriteLockWaitMs(value, label);
}

/**
 * Limits for a capture with no lock-options source — the plain daemon or an
 * inline capture. These preserve the pre-backoff behavior (three probes
 * about 25ms apart) so ordinary capture contention still fails fast instead
 * of blocking for the converge-scale deadline.
 */
export const LEGACY_CAPTURE_WRITE_LOCK_INITIAL_DELAY_MS = 25;
export const LEGACY_CAPTURE_WRITE_LOCK_MAX_DELAY_MS = 25;
export const LEGACY_CAPTURE_WRITE_LOCK_DEADLINE_MS = 75;

/** Fill omitted knobs from the defaults and reject an inverted schedule. */
export function resolveCaptureWriteLockBackoffLimits(
  source: CaptureWriteLockLimitSource | undefined
): CaptureWriteLockBackoffLimits {
  // No source means a non-converge capture: keep the short legacy bounds.
  const defaults =
    source === undefined
      ? {
          initialDelayMs: LEGACY_CAPTURE_WRITE_LOCK_INITIAL_DELAY_MS,
          maxDelayMs: LEGACY_CAPTURE_WRITE_LOCK_MAX_DELAY_MS,
          deadlineMs: LEGACY_CAPTURE_WRITE_LOCK_DEADLINE_MS,
        }
      : {
          initialDelayMs: DEFAULT_CAPTURE_WRITE_LOCK_INITIAL_DELAY_MS,
          maxDelayMs: DEFAULT_CAPTURE_WRITE_LOCK_MAX_DELAY_MS,
          deadlineMs: DEFAULT_CAPTURE_WRITE_LOCK_DEADLINE_MS,
        };
  const initialDelayMs = pickWaitMs(
    source?.captureWriteLockInitialDelayMs,
    defaults.initialDelayMs,
    "captureWriteLockInitialDelayMs"
  );
  const maxDelayMs = pickWaitMs(
    source?.captureWriteLockMaxDelayMs,
    defaults.maxDelayMs,
    "captureWriteLockMaxDelayMs"
  );
  const deadlineMs = pickWaitMs(
    source?.captureWriteLockDeadlineMs,
    defaults.deadlineMs,
    "captureWriteLockDeadlineMs"
  );
  if (initialDelayMs > maxDelayMs) {
    throw new Error(
      `captureWriteLockInitialDelayMs (${initialDelayMs}) must be <= captureWriteLockMaxDelayMs (${maxDelayMs})`
    );
  }
  if (maxDelayMs > deadlineMs) {
    throw new Error(`captureWriteLockMaxDelayMs (${maxDelayMs}) must be <= captureWriteLockDeadlineMs (${deadlineMs})`);
  }
  return { initialDelayMs, maxDelayMs, deadlineMs };
}
