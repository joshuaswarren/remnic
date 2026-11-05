import type { Orchestrator } from "@remnic/core";
import { wireBacklogScheduler, type BacklogScheduler } from "@remnic/core/orchestration/backlog-scheduler.js";

/** Start the daemon-owned extraction backlog scheduler AFTER the listener is
 *  up, so accepted work is never blocked by startup. */
export function startBacklogScheduler(orchestrator: Orchestrator): BacklogScheduler {
  const scheduler = wireBacklogScheduler(orchestrator);
  scheduler.start();
  return scheduler;
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
    await scheduler?.stop();
  } finally {
    try {
      await destroy();
    } finally {
      finish();
    }
  }
}
