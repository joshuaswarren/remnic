/**
 * Force-extraction helper for the CLI `extract` command (issue #3555).
 *
 * The handler used to print an informational message instead of triggering
 * extraction ("For now, inform the user" — removed by the COS-743 sweep).
 * Extracted from cli.ts so the trigger is testable without commander.
 */

import type { BufferTurn } from "./types.js";

/** Narrow structural view of the orchestrator surface the CLI needs. */
export interface ExtractCliOrchestrator {
  buffer: {
    load(): Promise<void>;
    getTurns(): BufferTurn[];
  };
  runExtraction(
    turns: BufferTurn[],
    options?: {
      forceExtractionAttempt?: boolean;
      skipCharThreshold?: boolean;
      skipUserTurnThreshold?: boolean;
    },
  ): Promise<{ status: string; persistedCount: number; reason?: string }>;
}

export interface ForceExtractOutcome {
  kind: "empty" | "run";
  turns: number;
  persistedCount: number;
  status?: string;
  reason?: string;
}

/**
 * Load the buffer and force extraction of its turns. Uses the explicit
 * flush-path options (forceExtractionAttempt + skip thresholds) so the run
 * bypasses the char/user-turn gates and the retry backoff, matching the
 * turn-ingestion force-flush convention.
 */
export async function forceExtractBufferedTurns(
  orchestrator: ExtractCliOrchestrator,
): Promise<ForceExtractOutcome> {
  await orchestrator.buffer.load();
  const turns = orchestrator.buffer.getTurns();
  if (turns.length === 0) {
    return { kind: "empty", turns: 0, persistedCount: 0 };
  }
  const result = await orchestrator.runExtraction(turns, {
    forceExtractionAttempt: true,
    skipCharThreshold: true,
    skipUserTurnThreshold: true,
  });
  return {
    kind: "run",
    turns: turns.length,
    persistedCount: result.persistedCount,
    status: result.status,
    reason: result.reason,
  };
}
