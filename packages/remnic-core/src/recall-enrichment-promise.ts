export type DeferredEnrichmentOutcome<T> =
  | { status: "resolved"; value: T }
  | { status: "rejected"; error: unknown };

export type ObservedDeferredEnrichmentPromise<T> =
  Promise<DeferredEnrichmentOutcome<T>> & {
    getSettledOutcome: () => DeferredEnrichmentOutcome<T> | undefined;
    cancel: () => void;
  };

/** Cancelable child abort signal owned by one enrichment promise. */
export interface EnrichmentAbortHandle {
  signal: AbortSignal;
  cancel: () => void;
  dispose: () => void;
}

/** Child abort controller that follows `parentSignal`; `dispose` detaches the listener. */
export function createEnrichmentAbortHandle(parentSignal?: AbortSignal): EnrichmentAbortHandle {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (parentSignal?.aborted) {
    controller.abort();
  } else if (parentSignal) {
    parentSignal.addEventListener("abort", onAbort, { once: true });
  }
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    parentSignal?.removeEventListener("abort", onAbort);
  };
  return {
    signal: controller.signal,
    cancel: () => {
      controller.abort();
      dispose();
    },
    dispose,
  };
}

/** Never-rejecting view of `promise` that also exposes its settled outcome and a cancel hook. */
export function observeEnrichmentPromise<T>(
  promise: Promise<T>,
  cancel: () => void = () => {},
): ObservedDeferredEnrichmentPromise<T> {
  let settledOutcome: DeferredEnrichmentOutcome<T> | undefined;
  const settled = promise
    .then<DeferredEnrichmentOutcome<T>, DeferredEnrichmentOutcome<T>>(
      (value) => ({ status: "resolved", value }),
      (error) => ({ status: "rejected", error }),
    )
    .then((outcome) => {
      settledOutcome = outcome;
      return outcome;
    });
  return Object.assign(settled, {
    getSettledOutcome: () => settledOutcome,
    cancel,
  });
}
