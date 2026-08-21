import type { ChunkEvent } from "./native.js";

/** Ceiling on chunks held in the reorder buffer. */
export const MAX_BUFFERED_CHUNKS = 512;

/** Consecutive apply failures before a chunk is parked. */
export const QUARANTINE_AFTER_FAILURES = 3;

/** Oldest quarantined rows are dropped once this many are stored. */
export const MAX_QUARANTINED_CHUNKS = 64;

export type PendingChunkReason = "evicted" | "quarantined";

export interface PendingChunkInput {
  id: string;
  wavPath: string;
  startedAtUtc: string;
  endedAtUtc: string;
  channel: ChunkEvent["channel"];
  device: string | null;
  reason: PendingChunkReason;
}

export interface PendingChunkRecord extends PendingChunkInput {
  createdAtUtc: string;
}

export class ChunkApplyError extends Error {
  readonly chunkId: string;

  constructor(chunkId: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "ChunkApplyError";
    this.chunkId = chunkId;
    if (cause instanceof Error) this.cause = cause;
  }
}

export function spansOverlap(
  left: { startMs: number; endMs: number },
  right: { startMs: number; endMs: number },
): boolean {
  return left.startMs < right.endMs && right.startMs < left.endMs;
}

/**
 * A chunk may leave the buffer only when the watermark has passed its end
 * and no still-held chunk overlaps it (issue #2379).
 */
export function isReleaseEligible(
  candidate: { startMs: number; endMs: number },
  threshold: number,
  held: readonly { startMs: number; endMs: number }[],
): boolean {
  if (candidate.endMs > threshold) return false;
  for (const other of held) {
    if (spansOverlap(candidate, other)) return false;
  }
  return true;
}
