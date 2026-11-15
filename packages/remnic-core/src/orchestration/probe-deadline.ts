import type { ExtractionResult } from "../types.js";
import { HALF_OPEN_PROBE_TIMEOUT_MS } from "./provider-breaker.js";

export interface ProbeDeadline {
  /** The caller's signal, plus the probe timer's when this attempt owns the probe. */
  readonly signal: AbortSignal | undefined;
  /** True only when the probe timer fired (not when the caller aborted). */
  timedOut(): boolean;
  stop(): void;
}

/** Bounds the single half-open probe; any other attempt keeps the caller's signal and no timer. */
export function startProbeDeadline(
  probeOwned: boolean,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number = HALF_OPEN_PROBE_TIMEOUT_MS,
): ProbeDeadline {
  if (!probeOwned) return { signal: callerSignal, timedOut: () => false, stop: () => undefined };
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  return {
    signal: callerSignal ? AbortSignal.any([callerSignal, timeout.signal]) : timeout.signal,
    timedOut: () => timeout.signal.aborted,
    stop: () => clearTimeout(timer),
  };
}

/** What a probe that got no answer in time reports: the ordinary retryable provider failure. */
export function probeTimedOutResult(): ExtractionResult {
  return {
    facts: [],
    profileUpdates: [],
    entities: [],
    questions: [],
    extractionFailure: "local_llm_unavailable",
    extractionFailureClass: "provider_retryable",
  };
}
