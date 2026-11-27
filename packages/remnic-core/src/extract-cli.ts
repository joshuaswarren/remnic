/**
 * Force-extraction helper for the CLI `extract` command (issue #3555).
 *
 * The handler used to print an informational message instead of triggering
 * extraction ("For now, inform the user" — removed by the COS-743 sweep).
 * Extracted from cli.ts so the trigger is testable without commander.
 *
 * Real captures buffer under their session key, not "default" (PR #3668
 * review), so the helper enumerates the buffer's per-key pending counts (the
 * backlog scheduler's liveBufferCounts convention) and drains each key with
 * runExtraction({ bufferKey: key }) — the flush convention
 * (clearAfterExtraction targets the passed bufferKey).
 */

import type { BufferEntryCounts } from "./buffer-turn-helpers.js";
import type { BufferTurn } from "./types.js";

/** Narrow structural view of the orchestrator surface the CLI needs. */
export interface ExtractCliOrchestrator {
  buffer: {
    load(): Promise<void>;
    entryCounts(): Map<string, BufferEntryCounts>;
    getTurns(bufferKey?: string): BufferTurn[];
  };
  runExtraction(
    turns: BufferTurn[],
    options?: {
      bufferKey?: string;
      forceExtractionAttempt?: boolean;
      skipCharThreshold?: boolean;
      skipUserTurnThreshold?: boolean;
    },
  ): Promise<{ status: string; persistedCount: number; reason?: string }>;
}

export interface ForceExtractEntryResult {
  key: string;
  status: string;
  persistedCount: number;
  reason?: string;
  error?: string;
}

export interface ForceExtractOutcome {
  kind: "empty" | "run";
  /** Keys whose extraction ran to "completed". */
  drained: number;
  /** Total turns submitted for extraction across all keys. */
  turns: number;
  persistedCount: number;
  entries: ForceExtractEntryResult[];
  /** Entries that were skipped or threw — the CLI exits nonzero on these. */
  failed: ForceExtractEntryResult[];
}

/**
 * Load the buffer and force extraction of every buffered key's turns. Uses
 * the explicit flush-path options (forceExtractionAttempt + skip thresholds)
 * so each run bypasses the char/user-turn gates and the retry backoff,
 * matching the turn-ingestion force-flush convention. A key whose extraction
 * throws is contained: later keys still drain, and the failure is reported.
 */
export async function forceExtractBufferedTurns(
  orchestrator: ExtractCliOrchestrator,
): Promise<ForceExtractOutcome> {
  await orchestrator.buffer.load();
  const keys = [...orchestrator.buffer.entryCounts().keys()];
  const entries: ForceExtractEntryResult[] = [];
  let drained = 0;
  let turns = 0;
  let persistedCount = 0;
  for (const key of keys) {
    const keyTurns = orchestrator.buffer.getTurns(key);
    if (keyTurns.length === 0) continue;
    turns += keyTurns.length;
    try {
      const result = await orchestrator.runExtraction(keyTurns, {
        bufferKey: key,
        forceExtractionAttempt: true,
        skipCharThreshold: true,
        skipUserTurnThreshold: true,
      });
      persistedCount += result.persistedCount;
      if (result.status === "completed") drained++;
      entries.push({
        key,
        status: result.status,
        persistedCount: result.persistedCount,
        reason: result.reason,
      });
    } catch (err) {
      entries.push({ key, status: "failed", persistedCount: 0, error: String(err) });
    }
  }
  if (entries.length === 0) {
    return { kind: "empty", drained: 0, turns: 0, persistedCount: 0, entries: [], failed: [] };
  }
  return {
    kind: "run",
    drained,
    turns,
    persistedCount,
    entries,
    failed: entries.filter((e) => e.status !== "completed"),
  };
}
