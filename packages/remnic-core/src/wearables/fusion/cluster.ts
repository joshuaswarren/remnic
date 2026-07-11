/**
 * Wearable cross-source fusion — deterministic conversation clustering.
 *
 * Conversations from multiple sources recording the same real-world
 * event overlap or sit within a proximity gap. This module groups them
 * into clusters using a classic interval-merge-with-gap sweep, which is
 * fully deterministic: the only inputs are start/end times, source ids,
 * and conversation ids (no randomness, no LLM).
 *
 * Partial overlap is tolerated: a conversation that begins before the
 * current cluster's end (+ gap) joins it even if it extends well past.
 */

import type { FusionConversationInput } from "./types.js";

/** Default max gap (ms) between two conversations to merge into one cluster. */
export const DEFAULT_PROXIMITY_GAP_MS = 5 * 60_000;

interface Interval {
  start: number;
  end: number;
}

/**
 * Resolve a conversation's effective [start, end] window in epoch ms.
 * Falls back to the latest segment end, then to the start, so a
 * conversation with no end still contributes a (possibly point) interval
 * rather than being dropped.
 */
function effectiveInterval(conversation: FusionConversationInput): Interval {
  const start = Date.parse(conversation.startIso);
  const endRaw =
    conversation.endIso !== undefined ? Date.parse(conversation.endIso) : NaN;
  if (Number.isFinite(endRaw)) {
    return { start, end: endRaw as number };
  }
  let maxSegEnd = NaN;
  for (const segment of conversation.segments) {
    if (segment.endIso !== undefined) {
      const ms = Date.parse(segment.endIso);
      if (Number.isFinite(ms) && (Number.isNaN(maxSegEnd) || ms > maxSegEnd)) {
        maxSegEnd = ms;
      }
    }
  }
  return { start, end: Number.isFinite(maxSegEnd) ? (maxSegEnd as number) : start };
}

function compareConversation(
  a: FusionConversationInput,
  b: FusionConversationInput,
): number {
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  if (a.conversationId !== b.conversationId) {
    return a.conversationId < b.conversationId ? -1 : 1;
  }
  return 0;
}

/**
 * Cluster conversations across sources for one day. Returns clusters in
 * chronological order; each cluster is sorted by (start, source, id).
 * Conversations whose start time is unparseable are emitted as
 * single-element clusters at the tail (sorted by source then id) so no
 * data is lost.
 */
export function clusterConversations(
  inputs: readonly FusionConversationInput[],
  proximityGapMs: number = DEFAULT_PROXIMITY_GAP_MS,
): FusionConversationInput[][] {
  const finite: Array<{ conv: FusionConversationInput; interval: Interval }> = [];
  const noStart: FusionConversationInput[] = [];
  for (const conv of inputs) {
    const interval = effectiveInterval(conv);
    if (Number.isFinite(interval.start)) {
      finite.push({ conv, interval });
    } else {
      noStart.push(conv);
    }
  }

  finite.sort((a, b) => {
    if (a.interval.start !== b.interval.start) {
      return a.interval.start - b.interval.start;
    }
    return compareConversation(a.conv, b.conv);
  });

  const clusters: FusionConversationInput[][] = [];
  let current: FusionConversationInput[] = [];
  let currentEnd = NaN;
  const flush = () => {
    if (current.length > 0) {
      clusters.push(current);
      current = [];
    }
  };

  for (const { conv, interval } of finite) {
    if (current.length === 0) {
      current = [conv];
      currentEnd = interval.end;
      continue;
    }
    // Overlap or within-gap adjacency -> join the cluster.
    const joins =
      interval.start <= currentEnd + proximityGapMs ||
      Number.isNaN(currentEnd);
    if (joins) {
      current.push(conv);
      if (Number.isNaN(currentEnd) || interval.end > currentEnd) {
        currentEnd = interval.end;
      }
    } else {
      flush();
      current = [conv];
      currentEnd = interval.end;
    }
  }
  flush();

  // Conversations with no parseable start can't be ordered in time, so
  // each becomes its own cluster, appended after the time-ordered ones.
  // Sort for determinism (source, id).
  noStart.sort(compareConversation);
  for (const conv of noStart) {
    clusters.push([conv]);
  }

  return clusters;
}
