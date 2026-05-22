// ---------------------------------------------------------------------------
// Conversation threader — groups flat message lists into threads
// ---------------------------------------------------------------------------

import type { ImportTurn } from "@remnic/core";
import { parseIsoTimestamp } from "@remnic/core";
import type { WeCloneImportTurn } from "./parser.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ThreadGroup {
  turns: ImportTurn[];
  threadId: string;
  startTime: string;
  endTime: string;
}

export interface ThreaderOptions {
  /** Maximum time gap (ms) before starting a new thread. Default: 30 minutes. */
  gapThresholdMs?: number;
  /** Minimum number of messages for a thread to be kept. Default: 2. */
  minThreadSize?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_GAP_THRESHOLD_MS = 1_800_000; // 30 minutes
const DEFAULT_MIN_THREAD_SIZE = 2;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Group an array of import turns into conversation threads.
 *
 * Algorithm (two-pass):
 * 1. Sort turns by timestamp.
 * 2. Split into initial thread segments by time gap.
 * 3. Merge segments linked by reply chains (if a turn's `replyToId`
 *    references a `participantId` in a different segment, merge them).
 * 4. Filter out threads smaller than `minThreadSize`.
 * 5. Assign sequential thread IDs.
 */
export function groupIntoThreads(
  turns: ImportTurn[],
  options?: ThreaderOptions,
): ThreadGroup[] {
  if (!turns || turns.length === 0) return [];

  const gapMs = options?.gapThresholdMs ?? DEFAULT_GAP_THRESHOLD_MS;
  const minSize = options?.minThreadSize ?? DEFAULT_MIN_THREAD_SIZE;

  if (options?.gapThresholdMs !== undefined && gapMs <= 0) {
    throw new Error(
      `gapThresholdMs must be positive, received ${gapMs}`,
    );
  }
  if (options?.gapThresholdMs !== undefined && (!Number.isFinite(gapMs) || !Number.isInteger(gapMs))) {
    throw new Error(
      `gapThresholdMs must be a finite integer, received ${gapMs}`,
    );
  }
  if (options?.minThreadSize !== undefined && (!Number.isFinite(minSize) || !Number.isInteger(minSize))) {
    throw new Error(
      `minThreadSize must be a finite integer, received ${minSize}`,
    );
  }
  if (options?.minThreadSize !== undefined && minSize <= 0) {
    throw new Error(
      `minThreadSize must be positive, received ${minSize}`,
    );
  }

  // Sort by timestamp (stable)
  const sorted = [...turns].sort((a, b) => {
    const tsA = parseIsoTimestamp(a.timestamp) ?? 0;
    const tsB = parseIsoTimestamp(b.timestamp) ?? 0;
    if (tsA !== tsB) return tsA - tsB;
    return 0;
  });

  // Pass 1: split into segments by time gap
  const segments: ImportTurn[][] = [];
  let currentSegment: ImportTurn[] = [];
  let prevTs: number | null = null;

  for (const turn of sorted) {
    const ts = parseIsoTimestamp(turn.timestamp) ?? 0;

    if (prevTs !== null && (ts - prevTs) > gapMs) {
      if (currentSegment.length > 0) {
        segments.push(currentSegment);
        currentSegment = [];
      }
    }

    currentSegment.push(turn);
    prevTs = ts;
  }
  if (currentSegment.length > 0) {
    segments.push(currentSegment);
  }

  // Pass 2: merge segments linked by reply chains.
  // Build a map from messageId -> segment index for turns that carry a
  // WeClone message_id.  Then for turns with replyToId, if the referenced
  // messageId is in a different segment, merge them via union-find.

  // Union-find helpers
  const parent: number[] = segments.map((_, i) => i);

  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]; // path compression
      x = parent[x];
    }
    return x;
  }

  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      // Always merge into the lower index (earlier segment)
      if (ra < rb) {
        parent[rb] = ra;
      } else {
        parent[ra] = rb;
      }
    }
  }

  // Map messageId -> segment index.
  // WeCloneImportTurn carries `messageId` from the source export.  When
  // present we key by messageId so that `replyToId` lookups resolve correctly.
  // Falls back to a stringified turn index within the segment as a last resort.
  const idToSegment = new Map<string, number>();
  for (let segIdx = 0; segIdx < segments.length; segIdx += 1) {
    for (let turnIdx = 0; turnIdx < segments[segIdx].length; turnIdx += 1) {
      const turn = segments[segIdx][turnIdx] as WeCloneImportTurn;
      if (turn.messageId) {
        idToSegment.set(turn.messageId, segIdx);
      }
    }
  }

  // Merge segments linked by reply chains
  for (let segIdx = 0; segIdx < segments.length; segIdx += 1) {
    for (const turn of segments[segIdx]) {
      if (turn.replyToId != null) {
        const targetSeg = idToSegment.get(turn.replyToId);
        if (targetSeg !== undefined) {
          union(segIdx, targetSeg);
        }
      }
    }
  }

  // Collect merged segments
  const mergedMap = new Map<number, ImportTurn[]>();
  for (let segIdx = 0; segIdx < segments.length; segIdx += 1) {
    const root = find(segIdx);
    const existing = mergedMap.get(root);
    if (existing) {
      existing.push(...segments[segIdx]);
    } else {
      mergedMap.set(root, [...segments[segIdx]]);
    }
  }

  // Sort each merged thread by timestamp, filter by min size, assign IDs
  const result: ThreadGroup[] = [];
  let threadSeq = 1;

  // Process in segment order (keys are root indices, already ordered)
  const sortedRoots = [...mergedMap.keys()].sort((a, b) => a - b);
  for (const root of sortedRoots) {
    const threadTurns = mergedMap.get(root)!;
    if (threadTurns.length < minSize) continue;

    threadTurns.sort((a, b) => {
      const tsA = parseIsoTimestamp(a.timestamp) ?? 0;
      const tsB = parseIsoTimestamp(b.timestamp) ?? 0;
      return tsA - tsB;
    });

    result.push({
      turns: threadTurns,
      threadId: `thread-${String(threadSeq).padStart(4, "0")}`,
      startTime: threadTurns[0].timestamp,
      endTime: threadTurns[threadTurns.length - 1].timestamp,
    });
    threadSeq += 1;
  }

  return result;
}
