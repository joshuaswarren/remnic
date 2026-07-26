type PendingObservePreparation = {
  cancelled: boolean;
  released: Promise<void>;
  release: () => void;
};

export type PendingObservePreparationHandle = {
  isCancelled(): boolean;
  release(): void;
};

type PendingObserveExtraction = {
  promise: Promise<void>;
  controllers: Set<AbortController>;
};

export class PendingObserveExtractionTracker {
  private readonly entries = new Map<string, PendingObserveExtraction>();
  private readonly preparations = new Map<string, Set<PendingObservePreparation>>();

  reserve(sessionKey: string): PendingObservePreparationHandle {
    let released = false;
    let resolveReleased: () => void = () => {};
    const reservation: PendingObservePreparation = {
      cancelled: false,
      released: new Promise<void>((resolve) => {
        resolveReleased = resolve;
      }),
      release: () => {
        if (released) return;
        released = true;
        const entries = this.preparations.get(sessionKey);
        entries?.delete(reservation);
        if (entries?.size === 0) this.preparations.delete(sessionKey);
        resolveReleased();
      },
    };
    const entries = this.preparations.get(sessionKey) ?? new Set<PendingObservePreparation>();
    entries.add(reservation);
    this.preparations.set(sessionKey, entries);
    return {
      isCancelled: () => reservation.cancelled,
      release: reservation.release,
    };
  }

  private async waitForPreparations(sessionKey: string): Promise<void> {
    while (true) {
      const pending = [...(this.preparations.get(sessionKey) ?? [])].filter(
        (reservation) => !reservation.cancelled,
      );
      if (pending.length === 0) return;
      await Promise.all(pending.map((reservation) => reservation.released));
    }
  }


  key(sessionKey: string, principal: string | undefined, namespace: string | undefined): string {
    return `${sessionKey}\u0000${principal ?? ""}\u0000${namespace ?? ""}`;
  }

  track(key: string, extraction: Promise<void>, controller: AbortController): void {
    const previous = this.entries.get(key);
    const promise = previous
      ? Promise.allSettled([previous.promise, extraction]).then((results) => {
          const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
          if (rejected) throw rejected.reason;
        })
      : extraction;
    const entry = {
      promise,
      controllers: new Set(previous ? [...previous.controllers, controller] : [controller]),
    };
    this.entries.set(key, entry);
    void promise
      .then(() => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      })
      .catch(() => {
        // Keep a failed barrier visible to the next lifecycle flush.
      });
  }

  cancel(sessionKey: string, principal?: string, namespace?: string): void {
    for (const reservation of this.preparations.get(sessionKey) ?? []) {
      reservation.cancelled = true;
    }

    for (const [key, entry] of this.entries) {
      const [entrySessionKey, entryPrincipal, entryNamespace] = key.split("\u0000");
      if (
        entrySessionKey !== sessionKey ||
        (principal !== undefined && entryPrincipal !== (principal ?? "")) ||
        (namespace !== undefined && entryNamespace !== (namespace ?? ""))
      )
        continue;
      for (const controller of entry.controllers) controller.abort();
    }
  }

  async wait(
    sessionKey: string,
    principal: string | undefined,
    namespace: string | undefined,
    abortSignal?: AbortSignal,
    registerCancellation?: (cancel: () => void) => void
  ): Promise<void> {
    const key = this.key(sessionKey, principal, namespace);
    const abortTracked = (): void => {
      this.cancel(sessionKey, principal, namespace);
    };
    registerCancellation?.(abortTracked);
    abortSignal?.addEventListener("abort", abortTracked, { once: true });
    try {
      await this.waitForPreparations(sessionKey);
      while (true) {
        const entry = this.entries.get(key);
        if (!entry) return;
        try {
          await entry.promise;
        } catch (error) {
          if (this.entries.get(key) !== entry) continue;
          this.entries.delete(key);
          throw error;
        }
        if (this.entries.get(key) !== entry) continue;
        this.entries.delete(key);
        return;
      }
    } finally {
      abortSignal?.removeEventListener("abort", abortTracked);
    }
  }
}
