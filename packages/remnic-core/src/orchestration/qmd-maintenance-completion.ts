/**
 * Callers that must know the re-index actually ran (the entity-migration
 * pending marker, issue #3286) cannot rely on arming the debounced timer: a
 * crash or dispose() inside the debounce window would lose the request. They
 * wait here instead; the scheduler claims the waiters when a pass starts and
 * settles them with the pass outcome, and abandons them on dispose().
 */
export class QmdMaintenanceCompletion {
  private waiters: Array<{ resolve: (served: boolean) => void; namespace?: string }> = [];

  /**
   * Resolves true when a pass that started after this call completed successfully. With a
   * `namespace` the request is served as soon as a pass ran that namespace, whatever else it skipped.
   */
  wait(namespace?: string): Promise<boolean> {
    return new Promise((resolve) => this.waiters.push({ resolve, namespace }));
  }

  /**
   * A pass is starting: take every waiter it will serve and return their settle function.
   * `ran` lists the namespaces a namespace-aware pass ran (absent when namespaces are disabled:
   * one corpus is maintained and the pass outcome applies to every waiter); `defer` keeps the
   * waiters it did not serve waiting for a later pass (a pass that covered only part of the selection).
   */
  claim(): (served: boolean, defer?: boolean, ran?: ReadonlySet<string>) => void {
    const claimed = this.waiters.splice(0);
    return (served, defer = false, ran) => {
      const requeue: typeof claimed = [];
      for (const waiter of claimed) {
        // A scoped waiter needs its own namespace to have run; the pass outcome alone is not enough.
        const own = waiter.namespace !== undefined && ran !== undefined ? ran.has(waiter.namespace) : served;
        if (own) waiter.resolve(true);
        else if (defer) requeue.push(waiter);
        else waiter.resolve(false);
      }
      this.waiters.unshift(...requeue);
    };
  }

  /** The scheduler stopped: nothing will serve the waiters. */
  abandon(): void {
    this.claim()(false);
  }
}
