import { AsyncLocalStorage } from "node:async_hooks";

const correlationIdStore = new AsyncLocalStorage<string>();

export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
  return correlationIdStore.run(correlationId, fn);
}

/** The current HTTP request's server-generated correlation id; undefined outside HTTP dispatch. */
export function currentCorrelationId(): string | undefined {
  return correlationIdStore.getStore();
}
