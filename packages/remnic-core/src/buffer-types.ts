/** Types split out of buffer.ts (structural ratchet, issue #1995). */

import type { BufferTurn } from "./types.js";

/**
 * Optional surprise probe injected into `SmartBuffer`.
 *
 * Computes a D-MEM-style novelty score in `[0, 1]` for an incoming turn.
 * The buffer treats the probe as purely additive: if it is not provided, if
 * the feature flag is off, or if the probe throws/times out, the buffer
 * falls back to the existing signal/turn-count/time triggers unchanged.
 *
 * Callers are responsible for sampling recent memories and passing them
 * through the embedding pipeline — the buffer does not want to know about
 * storage, embeddings, or QMD.
 *
 * @param bufferKey Identifier for the active buffer (session/thread).
 * @param turn      The incoming turn whose novelty is being scored.
 * @param recentTurns Turns already buffered for this key (most recent first
 *                    is NOT guaranteed — treat as unordered corpus).
 * @returns A surprise score in `[0, 1]`, or `null` if no score could be
 *          produced (e.g. empty corpus, probe declined to embed).
 */
export interface BufferSurpriseProbe {
  scoreTurn(
    bufferKey: string,
    turn: BufferTurn,
    recentTurns: readonly BufferTurn[],
  ): Promise<number | null>;
}

/**
 * Minimal data carried on the serialized telemetry write chain
 * (issue #563 PR 3).
 *
 * We intentionally do NOT capture the full `BufferTurn` here: under
 * slow filesystem latency the chain can back up, and retaining
 * `turn.content` for every pending append causes memory pressure on
 * large conversations. Only the fields the ledger row actually needs
 * cross the chain boundary.
 */
export interface SurpriseTelemetryQueueEntry {
  bufferKey: string;
  turnRole: "user" | "assistant";
  sessionKey: string | null;
  surpriseScore: number;
  triggered: boolean;
  turnCountInWindow: number;
  /**
   * ISO timestamp captured at the moment the turn was scored, NOT when
   * the ledger append eventually runs. Backpressure on the serialized
   * write chain could otherwise shift event timestamps away from the
   * real decision moment and distort the distribution report (p90
   * inflated, current-threshold row misidentified).
   */
  timestamp: string;
  /**
   * Threshold value in force when `triggered` was computed. Must be
   * snapshot here rather than read from `config` at emit time — a
   * concurrent config change between queue and write would otherwise
   * record `triggered=true` against a newer threshold the operator
   * never set, distorting precision/recall interpretation.
   */
  threshold: number;
}
