import { AsyncLocalStorage } from "node:async_hooks";

// Server-generated per-request correlation id for the access HTTP transport.
// Scoped per request in EngramAccessHttpServer and read downstream (recall
// timings, MCP dispatch, logs) without threading the id through every call.
// The id never derives from client input: clients may echo it back, but a
// client-supplied value can never install a correlation context.
const correlationIdStore = new AsyncLocalStorage<string>();

export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
  return correlationIdStore.run(correlationId, fn);
}

/** The current HTTP request's server-generated correlation id; undefined outside HTTP dispatch. */
export function currentCorrelationId(): string | undefined {
  return correlationIdStore.getStore();
}
