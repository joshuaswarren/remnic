/** Wait without cancellation; keep the timer referenced so awaited polling can finish. */
export function sleep(ms: number): Promise<void> {
  // Constructor form keeps this reachable utility compatible with ES2022 adapter type graphs.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import { abortError } from "../abort-error.js";

/**
 * Wait until `ms` elapses, or reject with `AbortError` when `signal` fires.
 * The timer is cleared on abort so a cancelled wait holds no Timeout handle.
 * Executor form: this module targets ES2022 type graphs (no withResolvers).
 */
export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError("operation aborted"));
      return;
    }
    const timer = setTimeout(() => {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    let onAbort: (() => void) | null = null;
    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        reject(abortError("operation aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
