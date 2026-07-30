/**
 * Shared abort-error helpers.
 *
 * Consolidates the `throwIfAborted` / `abortError` / `isAbortError`
 * patterns that were independently implemented across
 * `direct-answer-wiring.ts`, `harmonic-retrieval.ts`, and `qmd.ts`
 * (plus a private pair in `orchestrator.ts`).  A single helper
 * means future changes to the abort-error convention are applied
 * consistently across the codebase.
 *
 * The convention (matching Web / Node): throw a standard `Error`
 * with `name === "AbortError"`.  Callers dispatch on name rather
 * than a specific class so error propagation across async
 * boundaries continues to classify correctly.
 */

/**
 * Build an Error whose `name` is `"AbortError"`.  Uses
 * `Object.defineProperty` so the name is non-enumerable and
 * mirrors the shape of `DOMException("AbortError")` where that
 * is available.
 */
export function abortError(message: string): Error {
  const err = new Error(message);
  Object.defineProperty(err, "name", { value: "AbortError" });
  return err;
}

/** Return true iff `err` is an Error whose `name` is `"AbortError"`. */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/**
 * Throw an AbortError when the given signal has fired.  No-op
 * when the signal is absent or not yet aborted.  The default
 * message matches the prior in-module implementations.
 */
export function throwIfAborted(
  signal?: AbortSignal,
  message = "operation aborted",
): void {
  if (signal?.aborted) {
    throw abortError(message);
  }
}

export function raceAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  message = "operation aborted",
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(message));
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError(message));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  });
}
