type PendingObservePreparation = {
  cancelled: boolean;
  scopeHint?: string;
  principal?: string;
  namespace?: string;
  scopeResolved: boolean;
  resolvedScopeFences: Array<{ principal?: string; namespace?: string }>;
  released: Promise<void>;
  release: () => void;
};

function resolvedScopesMatch(
  left: { principal?: string; namespace?: string },
  right: { principal?: string; namespace?: string },
): boolean {
  return left.principal === right.principal && left.namespace === right.namespace;
}

function preparationMatchesScope(
  reservation: PendingObservePreparation,
  principal: string | undefined,
  namespace: string | undefined,
  scopeHint: string | undefined,
): boolean {
  if (reservation.scopeResolved) {
    return resolvedScopesMatch(reservation, { principal, namespace });
  }
  return reservation.scopeHint === undefined || scopeHint === undefined || reservation.scopeHint === scopeHint;
}

export type PendingObservePreparationHandle = {
  isCancelled(): boolean;
  setScope(principal?: string, namespace?: string): void;
  release(): void;
};

export function pendingObserveScopeHint(options: {
  namespace?: string;
  projectTag?: string;
  cwd?: string;
}): string | undefined {
  const namespace = options.namespace?.trim();
  if (namespace) return `namespace:${namespace}`;
  const projectTag = options.projectTag?.trim();
  if (projectTag) return `projectTag:${projectTag}`;
  const cwd = options.cwd?.trim();
  return cwd ? `cwd:${cwd}` : undefined;
}

type PendingObserveExtraction = {
  promise: Promise<void>;
  controllers: Set<AbortController>;
};

export class PendingObserveExtractionTracker {
  private readonly entries = new Map<string, PendingObserveExtraction>();
  private readonly preparations = new Map<string, Set<PendingObservePreparation>>();

  reserve(sessionKey: string, scopeHint?: string): PendingObservePreparationHandle {
    let released = false;
    let resolveReleased: () => void = () => {};
    const reservation: PendingObservePreparation = {
      cancelled: false,
      scopeResolved: false,
      resolvedScopeFences: [],
      scopeHint,
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
      setScope: (principal, namespace) => {
        reservation.principal = principal;
        reservation.namespace = namespace;
        reservation.scopeResolved = true;
        if (reservation.resolvedScopeFences.some((fence) => resolvedScopesMatch(reservation, fence))) {
          reservation.cancelled = true;
        }
      },
      release: reservation.release,
    };
  }

  private async waitForPreparations(
    sessionKey: string,
    principal: string | undefined,
    namespace: string | undefined,
    scopeHint: string | undefined,
  ): Promise<void> {
    while (true) {
      const reservations = [...(this.preparations.get(sessionKey) ?? [])];
      for (const reservation of reservations) {
        if (
          !reservation.cancelled &&
          !reservation.scopeResolved &&
          !preparationMatchesScope(reservation, principal, namespace, scopeHint) &&
          !reservation.resolvedScopeFences.some((fence) =>
            resolvedScopesMatch(fence, { principal, namespace }),
          )
        ) {
          reservation.resolvedScopeFences.push({ principal, namespace });
        }
      }
      const pending = reservations.filter(
        (reservation) =>
          !reservation.cancelled && preparationMatchesScope(reservation, principal, namespace, scopeHint),
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

  cancelPreparations(sessionKey: string, scopeHint?: string): void {
    for (const reservation of this.preparations.get(sessionKey) ?? []) {
      if (
        scopeHint !== undefined &&
        reservation.scopeHint !== undefined &&
        reservation.scopeHint !== scopeHint
      ) {
        continue;
      }
      reservation.cancelled = true;
    }
  }

  cancel(
    sessionKey: string,
    principal?: string,
    namespace?: string,
    scopeHint?: string,
  ): void {
    for (const reservation of this.preparations.get(sessionKey) ?? []) {
      if (!preparationMatchesScope(reservation, principal, namespace, scopeHint)) continue;
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
    registerCancellation?: (cancel: () => void) => void,
    scopeHint?: string,
  ): Promise<void> {
    const key = this.key(sessionKey, principal, namespace);
    const abortTracked = (): void => {
      this.cancel(sessionKey, principal, namespace, scopeHint);
    };
    registerCancellation?.(abortTracked);
    abortSignal?.addEventListener("abort", abortTracked, { once: true });
    try {
      await this.waitForPreparations(sessionKey, principal, namespace, scopeHint);
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
