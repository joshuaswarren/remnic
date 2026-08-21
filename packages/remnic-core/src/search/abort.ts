import { throwIfAborted } from "../abort-error.js";
import type { SearchExecutionOptions } from "./port.js";

export function isSearchAborted(execution?: SearchExecutionOptions): boolean {
  return execution?.signal?.aborted === true;
}

export function throwIfSearchAborted(
  execution?: SearchExecutionOptions,
  message = "search operation aborted",
): void {
  throwIfAborted(execution?.signal, message);
}

export function withTimeoutSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}
