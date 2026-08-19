/**
 * Bounded overlapping observation batches for timeline analysis (issue #2050).
 */
import type { TimelineObservation } from "./types.js";

export type TimelineBatchObservation = Pick<TimelineObservation, "id" | "capturedAtUtc">;

export interface BatchObservationsOptions {
  maxBatch: number;
  overlap: number;
}

function compareObservations(a: TimelineBatchObservation, b: TimelineBatchObservation): number {
  const time = Date.parse(a.capturedAtUtc) - Date.parse(b.capturedAtUtc);
  if (time !== 0) return time;
  return a.id - b.id;
}

/** Split observations into overlapping windows. Order is capturedAtUtc, then id. */
export function batchObservations<T extends TimelineBatchObservation>(
  observations: readonly T[],
  options: BatchObservationsOptions,
): T[][] {
  const { maxBatch, overlap } = options;
  if (!Number.isInteger(overlap) || overlap < 0) {
    throw new RangeError("overlap must be a non-negative integer");
  }
  if (maxBatch === 0) return [];
  if (!Number.isInteger(maxBatch) || maxBatch < 1) {
    throw new RangeError("maxBatch must be 0 or a positive integer");
  }
  if (overlap >= maxBatch) {
    throw new RangeError("overlap must be less than maxBatch");
  }
  if (observations.length === 0) return [];

  const ordered = [...observations].sort(compareObservations);
  const step = maxBatch - overlap;
  const batches: T[][] = [];
  for (let start = 0; start < ordered.length; start += step) {
    batches.push(ordered.slice(start, start + maxBatch));
    if (start + maxBatch >= ordered.length) break;
  }
  return batches;
}
