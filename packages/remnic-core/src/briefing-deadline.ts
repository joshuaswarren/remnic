import { isAbortError, raceAbort } from "./abort-error.js";

export const BRIEFING_DEADLINE_MS = 30_000;

export class BriefingTimeoutError extends Error {
  constructor(readonly deadlineMs: number, label = "briefing") {
    super(`${label} timed out after ${deadlineMs}ms`);
    this.name = "TimeoutError";
  }
}

export async function withBriefingDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  abortSignal?: AbortSignal,
  label = "briefing",
): Promise<T> {
  const controller = new AbortController();
  const signal = abortSignal ? AbortSignal.any([abortSignal, controller.signal]) : controller.signal;
  const timer = setTimeout(
    () => controller.abort(new BriefingTimeoutError(BRIEFING_DEADLINE_MS, label)),
    BRIEFING_DEADLINE_MS
  );
  try {
    signal.throwIfAborted();
    return await raceAbort(run(signal), signal, "briefing aborted");
  } catch (err) {
    // raceAbort normalizes cancellation; retain the distinct deadline reason.
    const reason: unknown = signal.reason;
    if (signal.aborted && (reason instanceof BriefingTimeoutError || isAbortError(reason))) throw reason;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
