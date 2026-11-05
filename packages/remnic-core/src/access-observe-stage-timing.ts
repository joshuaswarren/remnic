/**
 * Noncontent stage timing for the observe surface.
 *
 * Durations only — never message content, session keys, namespaces or
 * principals. A monotonic clock (`performance.now`) keeps phase durations
 * sane under wall-clock corrections.
 *
 * A slow observe logs `access-observe-slow`; a failed observe always logs
 * `access-observe-failed`, so a 25s-class stall attributes to a phase
 * instead of a guess.
 */
import { log } from "./logger.js";

/** Observes slower than this log `access-observe-slow` with per-stage durations. */
const OBSERVE_SLOW_LOG_MS = 10_000;

export interface ObserveStageTimer {
  /** Run one stage, recording its duration even when the stage rejects. */
  timed<T>(stage: string, fn: () => Promise<T>): Promise<T>;
  /** Log a slow successful observe with per-stage durations. */
  logSlow(messages: number): void;
  /** Log a failed observe with per-stage durations. */
  logFailed(messages: number): void;
}

/** Timer for one observe request. */
export function createObserveStageTimer(): ObserveStageTimer {
  const startedAtMs = performance.now();
  const stageMs: Record<string, number> = {};

  const formatStages = (): string =>
    Object.entries(stageMs)
      .map(([stage, ms]) => `${stage}Ms=${Math.round(ms)}`)
      .join(" ");

  return {
    async timed<T>(stage: string, fn: () => Promise<T>): Promise<T> {
      const stageStartMs = performance.now();
      try {
        return await fn();
      } finally {
        stageMs[stage] = (stageMs[stage] ?? 0) + (performance.now() - stageStartMs);
      }
    },
    logSlow(messages: number): void {
      const totalMs = Math.round(performance.now() - startedAtMs);
      if (totalMs < OBSERVE_SLOW_LOG_MS) return;
      log.warn(
        `access-observe-slow totalMs=${totalMs} messages=${messages} ${formatStages()}`,
      );
    },
    logFailed(messages: number): void {
      log.warn(
        `access-observe-failed totalMs=${Math.round(performance.now() - startedAtMs)} messages=${messages} ${formatStages()}`,
      );
    },
  };
}
