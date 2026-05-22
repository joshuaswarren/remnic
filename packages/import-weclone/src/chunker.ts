// ---------------------------------------------------------------------------
// Thread chunker — splits long threads into extraction-sized batches
// ---------------------------------------------------------------------------

import type { ImportTurn } from "@remnic/core";
import type { ThreadGroup } from "./threader.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChunkOptions {
  /** Maximum turns per chunk. Default: 20. */
  maxTurnsPerChunk?: number;
  /** Number of overlapping turns between consecutive chunks. Default: 2. */
  overlapTurns?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TURNS = 20;
const DEFAULT_OVERLAP = 2;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Split thread groups into extraction-sized chunks.
 *
 * - Threads shorter than `maxTurnsPerChunk` stay as a single chunk.
 * - Longer threads are split with `overlapTurns` overlap at boundaries
 *   to preserve conversational context.
 */
export function chunkThreads(
  threads: ThreadGroup[],
  options?: ChunkOptions,
): ImportTurn[][] {
  if (!threads || threads.length === 0) return [];

  const maxTurns = options?.maxTurnsPerChunk ?? DEFAULT_MAX_TURNS;
  const overlap = options?.overlapTurns ?? DEFAULT_OVERLAP;

  if (options?.maxTurnsPerChunk !== undefined && (!Number.isFinite(maxTurns) || !Number.isInteger(maxTurns))) {
    throw new Error(
      `maxTurnsPerChunk must be a finite integer, received ${maxTurns}`,
    );
  }

  if (maxTurns <= 0) {
    throw new Error(
      `maxTurnsPerChunk must be positive, received ${maxTurns}`,
    );
  }

  if (options?.overlapTurns !== undefined && (!Number.isFinite(overlap) || !Number.isInteger(overlap))) {
    throw new Error(
      `overlapTurns must be a finite integer, received ${overlap}`,
    );
  }

  if (overlap < 0) {
    throw new Error(
      `overlapTurns must be non-negative, received ${overlap}`,
    );
  }

  if (overlap >= maxTurns) {
    throw new Error(
      `overlapTurns (${overlap}) must be less than maxTurnsPerChunk ` +
        `(${maxTurns}); otherwise chunks would either never advance ` +
        `or silently clamp step to 1 and massively inflate work`,
    );
  }

  // Effective step: how many new turns each chunk advances by
  const step = Math.max(1, maxTurns - overlap);

  const chunks: ImportTurn[][] = [];

  for (const thread of threads) {
    const turns = thread.turns;
    if (turns.length === 0) continue;

    if (turns.length <= maxTurns) {
      chunks.push([...turns]);
      continue;
    }

    // Sliding window with overlap
    for (let start = 0; start < turns.length; start += step) {
      const end = Math.min(start + maxTurns, turns.length);
      chunks.push(turns.slice(start, end));
      // If we've reached the end, stop
      if (end === turns.length) break;
    }
  }

  return chunks;
}
