import { log, type Orchestrator } from "@remnic/core";
import { wireBacklogScheduler, type BacklogScheduler } from "@remnic/core/orchestration/backlog-scheduler.js";

export function startBacklogScheduler(orchestrator: Orchestrator): BacklogScheduler {
  const scheduler = wireBacklogScheduler(orchestrator);
  scheduler.start();
  return scheduler;
}

export const ORCHESTRATOR_DESTROY_DEADLINE_MS = 60_000;

function emitMarker(level: "info" | "warn", message: string): void {
  try {
    log[level](message);
  } catch { /* diagnostics only — never control shutdown */ }
}

async function destroyWithDeadline(
  run: () => Promise<void>,
  deadlineMs: number,
): Promise<void> {
  const timedOut = Symbol("destroy-deadline-expired");
  const bounded = run();
  bounded.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<symbol>((resolve) => {
    timer = setTimeout(() => resolve(timedOut), deadlineMs);
  });
  const outcome = await Promise.race([bounded, deadline]).finally(() => clearTimeout(timer));
  if (outcome === timedOut) {
    emitMarker(
      "warn",
      `shutdown-phase-timeout phase=orchestrator-drain-flush-dispose durationMs=${deadlineMs}`,
    );
    return;
  }
  return await bounded;
}

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
