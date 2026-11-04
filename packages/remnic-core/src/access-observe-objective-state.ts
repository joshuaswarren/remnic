/**
 * Objective-state snapshots written from observed messages.
 *
 * Best-effort like the transcript write: a snapshot failure must not fail
 * the observe, so it is logged and swallowed here.
 */
import { log } from "./logger.js";
import { recordObjectiveStateSnapshotsFromObservedMessages } from "./objective-state-writers.js";
import { resolveObjectiveStateCapabilities } from "./capabilities.js";
import type { Orchestrator } from "./orchestrator.js";
import type { EngramAccessObserveRequest, MemoryScopePlan } from "./access-service.js";

/** Write the objective-state snapshots for one accepted observe. */
export async function recordObserveObjectiveState(
  orchestrator: Orchestrator,
  objectiveStateStoreLocationForNamespace: (
    namespace: string,
  ) => Promise<{ memoryDir: string; objectiveStateStoreDir?: string }>,
  scope: MemoryScopePlan,
  request: EngramAccessObserveRequest,
): Promise<void> {
  try {
    const objectiveStateLocation = await objectiveStateStoreLocationForNamespace(
      scope.objectiveStateNamespace,
    );
    await recordObjectiveStateSnapshotsFromObservedMessages({
      memoryDir: objectiveStateLocation.memoryDir,
      objectiveStateStoreDir: objectiveStateLocation.objectiveStateStoreDir,
      objectiveStateMemoryEnabled:
        resolveObjectiveStateCapabilities(orchestrator.config).objectiveStateMemory,
      objectiveStateSnapshotWritesEnabled:
        resolveObjectiveStateCapabilities(orchestrator.config).objectiveStateSnapshotWrites,
      sessionKey: request.sessionKey,
      recordedAt: new Date().toISOString(),
      messages: request.messages,
    });
  } catch (err) {
    log.error(`access-observe objective-state snapshot write failed: ${err}`);
  }
}
