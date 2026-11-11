import { log, type Orchestrator } from "@remnic/core";
import { wireBacklogScheduler, type BacklogScheduler } from "@remnic/core/orchestration/backlog-scheduler.js";

/** Start the daemon-owned extraction backlog scheduler AFTER the listener is
 *  up, so accepted work is never blocked by startup. */
export function startBacklogScheduler(orchestrator: Orchestrator): BacklogScheduler {
  const scheduler = wireBacklogScheduler(orchestrator);
  scheduler.start();
  return scheduler;
}

/** Backstop deadline for the orchestrator teardown phase: a wedged drain or
 *  an in-flight LLM call that ignores its abort signal must never hold the
 *  daemon past systemd's TimeoutStopSec. The buffer flush that persists
 *  unsent turns runs BEFORE slow teardown work inside destroy(), so this
 *  bound never costs durability. */
export const ORCHESTRATOR_DESTROY_DEADLINE_MS = 60_000;

/** Marker emission is best-effort: a throwing logger backend must not skip
 *  the phase, flip a success into a failure, or replace the phase error. */
function emitMarker(level: "info" | "warn", message: string): void {
  try {
    log[level](message);
  } catch { /* diagnostics only — never control shutdown */ }
}

/** Bounded wait: resolve when `run` settles, or when `deadlineMs` passes —
 *  whichever comes first. A deadline expiry logs the warn marker and leaves
 *  the losing promise behind with its rejection swallowed (an abandoned
 *  destroy must not surface as an unhandled rejection after exit). Within
 *  the deadline, the run's own result and error propagate untouched. */
async function destroyWithDeadline(
  run: () => Promise<void>,
  deadlineMs: number,
): Promise<void> {
  const timedOut = Symbol("destroy-deadline-expired");
  const bounded = run();
  // SAFETY: the deadline path abandons this promise on purpose; marking the
  // rejection handled keeps a late destroy failure from crashing exit while
  // `return await bounded` below still propagates in-time failures.
  bounded.catch(() => undefined);
  const deadline = new Promise<symbol>((resolve) => {
    // Ref'd on purpose: the timer IS the shutdown bound. Unref'ing it would
    // let the event loop drain before the deadline ever fires, leaving the
    // stop chain parked on a wedged drain instead of finishing.
    const timer = setTimeout(() => resolve(timedOut), deadlineMs);
  });
  const outcome = await Promise.race([bounded, deadline]);
  if (outcome === timedOut) {
    emitMarker(
      "warn",
      `shutdown-phase-timeout phase=orchestrator-drain-flush-dispose durationMs=${deadlineMs}`,
    );
    return;
  }
  return await bounded;
}

/** Monotonic, non-content shutdown phase markers, in the
 *  access-observe-stage-timing style: durations only — never session keys,
 *  content, or error payloads. Start logs before the await, end logs the
 *  duration after, failure logs on rejection without the error detail; the
 *  phase's result and error propagate untouched so existing finally chains
 *  keep running even when a prior phase throws. */
export async function logShutdownPhase<T>(phase: string, run: () => Promise<T>): Promise<T> {
  const startedMs = performance.now();
  emitMarker("info", `shutdown-phase-start phase=${phase}`);
  try {
    const result = await run();
    emitMarker("info", `shutdown-phase-end phase=${phase} durationMs=${Math.round(performance.now() - startedMs)}`);
    return result;
  } catch (err) {
    emitMarker("warn", `shutdown-phase-failure phase=${phase} durationMs=${Math.round(performance.now() - startedMs)}`);
    throw err;
  }
}

/** Teardown chain for the backlog drain: stop the scheduler, then destroy the
 *  orchestrator (bounded by the destroy deadline), then finish the Codex
 *  runner — every step runs even when an earlier one throws. */
export async function shutdownBacklogDrain(
  scheduler: BacklogScheduler | undefined,
  destroy: () => Promise<void>,
  finish: () => void,
  destroyDeadlineMs: number = ORCHESTRATOR_DESTROY_DEADLINE_MS,
): Promise<void> {
  try {
    await logShutdownPhase("scheduler-abort-settle", () => scheduler?.stop() ?? Promise.resolve());
  } finally {
    try {
      await logShutdownPhase("orchestrator-drain-flush-dispose", () => destroyWithDeadline(destroy, destroyDeadlineMs));
    } finally {
      finish();
    }
  }
}
