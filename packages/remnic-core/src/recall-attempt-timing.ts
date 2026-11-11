import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import { isAbortError } from "./abort-error.js";
import { currentCorrelationId } from "./access-correlation.js";
import {
  recordRecallTiming,
  type RecallTimingEmission,
  type RecallTimingOutcome,
} from "./recall-timings.js";
import type { PluginConfig } from "./types.js";

// Receives the recall pipeline's per-phase timing payload for the attempt in
// flight, so the attempt's single record (requestId + outcome + httpTotalMs +
// phases) is pushed once, from recordRecallAttempt's `finally`. Scoped per
// attempt via AsyncLocalStorage: no recall option or signature carries it.
const attemptSinkStore = new AsyncLocalStorage<(payload: RecallTimingEmission) => void>();

/**
 * Pipeline side. Inside a recorded attempt the payload folds into that
 * attempt's record; outside one (x-ray, daemon hooks, direct orchestrator
 * callers) it keeps the legacy success-only push.
 */
export function emitRecallTiming(config: PluginConfig, payload: RecallTimingEmission): void {
  const sink = attemptSinkStore.getStore();
  if (sink) {
    sink(payload);
    return;
  }
  recordRecallTiming(config, payload);
}

/**
 * Run one executed recall and leave exactly one timing record for it, pushed
 * in `finally` so denials, disconnects and assembly failures carry the same
 * trail as successes. `requestId` is the HTTP request's server-generated
 * correlation id (x-request-id); outside HTTP dispatch it falls back to a
 * generated `local:<uuid>` id in the same field, so a record says whether it
 * has an HTTP request behind it. Never derived from client input.
 */
export async function recordRecallAttempt<T>(
  config: PluginConfig,
  abortSignal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const requestId = currentCorrelationId() ?? `local:${randomUUID()}`;
  const startedMs = performance.now();
  const emitted: RecallTimingEmission[] = [];
  let failure: { abortError: boolean } | undefined;
  try {
    return await attemptSinkStore.run((payload) => {
      emitted.push(payload);
    }, run);
  } catch (err) {
    failure = { abortError: isAbortError(err) };
    throw err;
  } finally {
    const phases = emitted.at(-1);
    // aborted: the request/flight signal fired, or an abort error was thrown
    // (the pipeline's soft abort returns normally with the signal already
    // aborted). error: any other throw, or a normal return from a pipeline
    // that never reached its timing emit (the entry coordinator swallows
    // outer timeouts, init-gate aborts and internal failures into a degraded
    // context). ok: the pipeline ran to completion.
    const outcome: RecallTimingOutcome =
      abortSignal?.aborted === true || failure?.abortError === true
        ? "aborted"
        : failure !== undefined || phases === undefined
          ? "error"
          : "ok";
    recordRecallTiming(config, {
      ...phases,
      requestId,
      outcome,
      httpTotalMs: performance.now() - startedMs,
    });
  }
}
