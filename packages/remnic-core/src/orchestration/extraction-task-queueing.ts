/**
 * Extraction task queueing — the scope-group and execution-context pieces of
 * the turn-ingestion coordinator, split out to keep that module inside the
 * house source-size cap (issue #1995).
 */

import type { SmartBuffer } from "../buffer.js";
import { groupTurnsByExtractionScope } from "../buffer-turn-helpers.js";
import { log } from "../logger.js";
import type { ResolvedScopeProfilePlan } from "../namespaces/scope-profiles.js";
import type { BufferTurn, CodingContext } from "../types.js";
import type { ExtractionDrain } from "./extraction-drain.js";
import type { TurnIngestionDeps } from "./turn-ingestion.js";

/**
 * Isolated per-task execution context (claim-backed backlog drain).
 * Bound at enqueue time and read ONLY inside the enqueued closure, so the
 * task runs against its own buffer/extraction/drain no matter which async
 * context the coordinator's processor executes it from. Absent for live
 * work, which keeps the shared orchestrator state.
 */
export interface ExtractionTaskExecutionContext {
  /** The task's own buffer (a claim-backed SmartBuffer). */
  buffer: SmartBuffer;
  /**
   * The task's own chunked drain; its deps carry the isolated runExtraction +
   * buffer (claim tasks build one with `dropFailedChunks: false` — the
   * no-drop backlog policy).
   */
  drain: ExtractionDrain;
}

/** Queue options the capture-scope grouping forwards to the coordinator. */
export interface CaptureScopeGroupQueueOptions {
  deadlineMs?: number;
  abortSignal?: AbortSignal;
  writeNamespaceOverride?: string;
  principalOverride?: string;
  scopeProfileWritePlan?: ResolvedScopeProfilePlan | null;
  codingContext?: CodingContext;
  onExtractionQueued?: (extraction: Promise<void>) => void;
}

/**
 * Buffer-approved captures skip threshold/dedupe rechecks, not provider
 * retry cooldowns. Scope and staleness are enforced at the shared
 * queueBufferedExtraction boundary.
 */
export function queueBufferedCaptureScopeGroups(
  queueBufferedExtraction: TurnIngestionDeps["queueBufferedExtraction"],
  extractionTurns: BufferTurn[],
  bufferKey: string,
  options: CaptureScopeGroupQueueOptions,
): void {
  for (const group of groupTurnsByExtractionScope(extractionTurns)) {
    const groupIsAccepted = group.turns.some((turn) => turn.acceptedCapture === true);
    if (!groupIsAccepted) {
      // Native groups keep their own routing; skipped accepted prefixes require identity clearing.
      void queueBufferedExtraction(group.turns, "trigger_mode", {
        bufferKey,
        clearMatchingTurns: true,
        preemptable: true,
      }).catch((err) => log.error(`native trigger extraction failed: ${err}`));
      continue;
    }
    // Accepted groups use ONLY their own pins — no fallback to the
    // triggering observe's scope.
    const { promise: extraction, resolve, reject } = Promise.withResolvers<void>();
    void queueBufferedExtraction(group.turns, "trigger_mode", {
      bufferKey,
      clearBufferAfterExtraction: true,
      clearMatchingTurns: true,
      skipDedupeCheck: true,
      skipCharThreshold: true,
      skipUserTurnThreshold: true,
      abortSignal: options.abortSignal,
      extractionDeadlineMs: options.deadlineMs,
      writeNamespaceOverride: group.writeNamespaceOverride,
      principalOverride: group.principalOverride,
      scopeProfileWritePlan: group.scopeProfileWritePlan ?? null,
      preemptable: true,
      onTaskSettled: (err) => (err ? reject(err) : resolve()),
    }).catch(reject);
    if (options.onExtractionQueued) options.onExtractionQueued(extraction);
    else extraction.catch((err) => log.error(`buffered capture extraction failed: ${err}`));
  }
}
