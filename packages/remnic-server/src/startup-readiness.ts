/**
 * @remnic/server — standalone startup readiness gate.
 *
 * Extracted from index.ts (issue #2215): owns the search warm-up loop that
 * drives `/engram/v1/health` readiness, including the degraded-mode transition
 * that keeps a functional daemon from reporting itself offline forever when
 * warm-up cannot complete. Keeps index.ts under its structural size ceiling.
 */

import { log } from "@remnic/core";

interface PromiseResolvers<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

type PromiseConstructorWithResolvers = PromiseConstructor & {
  withResolvers<T>(): PromiseResolvers<T>;
};

/**
 * Like `setTimeout` wrapped in a Promise, but respects an `AbortSignal`.
 * Resolves immediately (without throwing) when the signal fires so the
 * caller can check `signal.aborted` and exit cleanly.
 */
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  const { promise, resolve } = (Promise as PromiseConstructorWithResolvers).withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  const onAbort = () => {
    clearTimeout(timer);
    resolve();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return promise.finally(() => signal.removeEventListener("abort", onAbort));
}

const STARTUP_WARMUP_TIMEOUT_MS = 20_000;
const STARTUP_WARMUP_RETRY_INTERVAL_MS = 30_000;
/**
 * Failed warm-up attempts before the init gate opens in degraded mode
 * (issue #2215). The daemon keeps serving recall via fallback retrieval while
 * search warm-up cannot complete (e.g. `qmd` missing from the service PATH),
 * so a permanently-closed gate reports a working service as offline. After
 * this many failed attempts the gate opens with `degraded: true` and warm-up
 * retries continue in the background until they succeed.
 */
export const STARTUP_DEGRADED_AFTER_ATTEMPTS = 3;

export interface StartupReadinessState {
  ready: boolean;
  warmupAttempts: number;
  lastError?: string | null;
  /** True when the gate opened before search warm-up completed (issue #2215). */
  degraded?: boolean;
}

export type StartupReadinessOutcome = "warmed" | "cancelled" | "overridden" | "search-disabled";

class StartupWarmupDegradationError extends Error {
  constructor(code: string) {
    super(`startup search degraded: ${code}`);
    this.name = "StartupWarmupDegradationError";
  }
}

class StartupSyncPendingError extends Error {
  constructor() {
    super("startup search sync is not complete");
    this.name = "StartupSyncPendingError";
  }
}

export async function runStartupSearchWarmup(options: {
  signal: AbortSignal;
  isAvailable: () => boolean;
  search: (onDegradation: (code: string) => void) => Promise<unknown>;
}): Promise<void> {
  let degradationCode: string | undefined;
  await options.search((code) => {
    degradationCode = code;
  });
  if (options.signal.aborted) return;
  if (degradationCode) throw new StartupWarmupDegradationError(degradationCode);
  if (!options.isAvailable()) {
    throw new StartupWarmupDegradationError("backend_unavailable");
  }
}

export async function completeStartupReadiness(options: {
  deferredReady: Promise<void>;
  warmup: (signal: AbortSignal) => Promise<unknown>;
  prepareWarmup?: (signal: AbortSignal) => Promise<boolean>;
  state: StartupReadinessState;
  timeoutMs?: number;
  retryIntervalMs?: number;
  /** Failed attempts before the gate opens degraded; 0 disables (strict gate). */
  degradedAfterAttempts?: number;
  override?: boolean;
  skipWarmup?: () => boolean;
  openGate: () => void;
  shutdownSignal?: AbortSignal;
  warn?: (message: string) => void;
  info?: (message: string) => void;
  error?: (message: string) => void;
}): Promise<StartupReadinessOutcome> {
  const timeoutMs = options.timeoutMs ?? STARTUP_WARMUP_TIMEOUT_MS;
  const retryIntervalMs = options.retryIntervalMs ?? STARTUP_WARMUP_RETRY_INTERVAL_MS;
  const degradedAfterAttempts = options.degradedAfterAttempts ?? STARTUP_DEGRADED_AFTER_ATTEMPTS;
  const warn = options.warn ?? ((message: string) => log.warn(message));
  const info = options.info ?? ((message: string) => log.info(message));
  const error = options.error ?? ((message: string) => log.error(message));

  options.state.ready = false;
  options.state.lastError = null;
  options.state.degraded = false;
  if (options.override) {
    options.openGate();
    options.state.ready = true;
    error(
      "CRITICAL: emergency readiness override enabled; exposing a cold search backend to traffic",
    );
    return "overridden";
  }
  if (options.skipWarmup?.()) {
    options.openGate();
    options.state.ready = true;
    info("Standalone init gate opened without search warm-up (search intentionally disabled)");
    return "search-disabled";
  }

  let removeDeferredShutdownListener: () => void = () => undefined;
  const deferredShutdown = new Promise<"shutdown">((resolve) => {
    if (options.shutdownSignal?.aborted) {
      resolve("shutdown");
      return;
    }
    const onDeferredShutdown = () => resolve("shutdown");
    options.shutdownSignal?.addEventListener("abort", onDeferredShutdown, { once: true });
    removeDeferredShutdownListener = () =>
      options.shutdownSignal?.removeEventListener("abort", onDeferredShutdown);
  });
  try {
    const deferredOutcome = await Promise.race([
      options.deferredReady.then(() => "ready" as const),
      deferredShutdown,
    ]);
    if (deferredOutcome === "shutdown") return "cancelled";
  } catch (err) {
    if (options.shutdownSignal?.aborted) return "cancelled";
    options.state.lastError = err instanceof Error ? err.name : typeof err;
    warn(`Standalone deferred initialization failed; warm-up retries will continue: ${err}`);
  } finally {
    removeDeferredShutdownListener();
  }
  if (options.shutdownSignal?.aborted) return "cancelled";

  const lifecycleAbort = new AbortController();
  const onShutdown = () => lifecycleAbort.abort(options.shutdownSignal?.reason);
  options.shutdownSignal?.addEventListener("abort", onShutdown, { once: true });

  try {
    while (!lifecycleAbort.signal.aborted) {
      if (options.skipWarmup?.()) {
        options.state.degraded = false;
        options.openGate();
        options.state.ready = true;
        info("Standalone init gate opened without search warm-up (search intentionally disabled)");
        return "search-disabled";
      }
      options.state.warmupAttempts += 1;
      const warmupAbort = new AbortController();
      const onLifecycleAbort = () => warmupAbort.abort(lifecycleAbort.signal.reason);
      lifecycleAbort.signal.addEventListener("abort", onLifecycleAbort, { once: true });
      const timeout = (Promise as PromiseConstructorWithResolvers).withResolvers<never>();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        warmupAbort.abort();
        timeout.reject(new Error(`startup warm-up timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();

      try {
        const attempt = async () => {
          if (options.prepareWarmup && !await options.prepareWarmup(warmupAbort.signal)) {
            throw new StartupSyncPendingError();
          }
          return options.warmup(warmupAbort.signal);
        };
        await Promise.race([attempt(), timeout.promise]);
        if (lifecycleAbort.signal.aborted) return "cancelled";
        const recovered = options.state.degraded === true;
        options.state.lastError = null;
        options.state.degraded = false;
        options.openGate();
        options.state.ready = true;
        info(
          `Standalone init gate opened after search warm-up attempt ${options.state.warmupAttempts}${recovered ? " (recovered from degraded mode)" : ""}`,
        );
        return "warmed";
      } catch (err) {
        if (lifecycleAbort.signal.aborted) return "cancelled";
        options.state.lastError = timedOut
          ? "TimeoutError"
          : err instanceof Error
            ? err.name
            : typeof err;
        warn(
          timedOut
            ? `Standalone startup warm-up attempt ${options.state.warmupAttempts} timed out after ${timeoutMs}ms; retrying in ${retryIntervalMs}ms`
            : `Standalone startup warm-up attempt ${options.state.warmupAttempts} failed (${options.state.lastError}); retrying in ${retryIntervalMs}ms`,
        );
        if (
          degradedAfterAttempts > 0 &&
          !options.state.ready &&
          options.state.warmupAttempts >= degradedAfterAttempts
        ) {
          options.state.degraded = true;
          options.openGate();
          options.state.ready = true;
          warn(
            `Standalone init gate opened in DEGRADED mode after ${options.state.warmupAttempts} failed search warm-up attempts (${options.state.lastError}); recall keeps serving via fallback retrieval and warm-up retries continue in the background`,
          );
        }
      } finally {
        clearTimeout(timer);
        lifecycleAbort.signal.removeEventListener("abort", onLifecycleAbort);
      }

      await abortableDelay(retryIntervalMs, lifecycleAbort.signal);
    }
    return "cancelled";
  } finally {
    options.shutdownSignal?.removeEventListener("abort", onShutdown);
  }
}
