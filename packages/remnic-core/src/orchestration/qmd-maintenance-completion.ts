/**
 * Callers that must know the re-index actually ran (the entity-migration
 * pending marker, issue #3286) cannot rely on arming the debounced timer: a
 * crash or dispose() inside the debounce window would lose the request. They
 * wait here instead; the scheduler claims the waiters when a pass starts and
 * settles them with the pass outcome, and abandons them on dispose().
 */
export class QmdMaintenanceCompletion {
  private waiters: Array<(served: boolean) => void> = [];

  /** Resolves true when a pass that started after this call completed successfully. */
  wait(): Promise<boolean> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /**
   * A pass is starting: take every waiter it will serve and return their settle function.
   * `defer` keeps them waiting for a later pass (a pass that covered only part of the selection).
   */
  claim(): (served: boolean, defer?: boolean) => void {
    const claimed = this.waiters.splice(0);
    return (served, defer = false) => {
      if (defer) this.waiters.unshift(...claimed);
      else claimed.forEach((resolve) => resolve(served));
    };
  }

  /** The scheduler stopped: nothing will serve the waiters. */
  abandon(): void {
    this.claim()(false);
  }
}
