import { log, type Orchestrator } from "@remnic/core";
import { wireBacklogScheduler, type BacklogScheduler } from "@remnic/core/orchestration/backlog-scheduler.js";

/** Start the daemon-owned extraction backlog scheduler AFTER the listener is
 *  up, so accepted work is never blocked by startup. */
export function startBacklogScheduler(orchestrator: Orchestrator): BacklogScheduler {
  const scheduler = wireBacklogScheduler(orchestrator);
  scheduler.start();
  return scheduler;
}

/** Monotonic, non-content shutdown phase markers, in the
 *  access-observe-stage-timing style: durations only — never session keys,
 *  content, or error payloads. Start logs before the await, end logs the
 *  duration after, failure logs on rejection without the error detail; the
 *  phase's result and error propagate untouched so existing finally chains
 *  keep running even when a prior phase throws. */
export async function logShutdownPhase<T>(phase: string, run: () => Promise<T>): Promise<T> {
  const startedMs = performance.now();
  log.info(`shutdown-phase-start phase=${phase}`);
  try {
    const result = await run();
    log.info(`shutdown-phase-end phase=${phase} durationMs=${Math.round(performance.now() - startedMs)}`);
    return result;
  } catch (err) {
    log.warn(`shutdown-phase-failure phase=${phase} durationMs=${Math.round(performance.now() - startedMs)}`);
    throw err;
  }
}

/** Teardown chain for the backlog drain: stop the scheduler, then destroy the
 *  orchestrator, then finish the Codex runner — every step runs even when an
 *  earlier one throws. */
export async function shutdownBacklogDrain(
  scheduler: BacklogScheduler | undefined,
  destroy: () => Promise<void>,
  finish: () => void,
): Promise<void> {
  try {
    await logShutdownPhase("scheduler-abort-settle", () => scheduler?.stop() ?? Promise.resolve());
  } finally {
    try {
      await logShutdownPhase("orchestrator-drain-flush-dispose", destroy);
    } finally {
      finish();
    }
  }
}
