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

/** The latest extent of a set of segments as an epoch-ms value + its ISO.
 * Each segment contributes its OWN extent — its `endIso` when known,
 * otherwise its `startIso` — and the result is the maximum. Reconstructed
 * `--:--` transcripts rebuild segments with only a start, so this reaches
 * the last segment start; segment ISOs are already cross-midnight-rolled by
 * the reconstruct layer, so the derived end is consistent with the segment
 * timeline. Returns undefined when no segment carries a parseable extent.
 *
 * This is the SINGLE shared primitive behind every end/interval derivation
 * in the fusion pipeline (cluster interval, fused conversation end): when a
 * conversation-level end is missing, the window falls back to the latest
 * segment extent instead of collapsing to a zero-length point at the start.
 */
export interface SegmentExtent {
  /** Epoch ms of the latest extent. */
  ms: number;
  /** ISO string that produced `ms` (a segment endIso, else its startIso). */
  iso: string;
}

export function maxSegmentExtent(
  segments: readonly { endIso?: string; startIso?: string }[],
): SegmentExtent | undefined {
  let best: SegmentExtent | undefined;
  for (const seg of segments) {
    const iso = seg.endIso ?? seg.startIso;
    if (iso === undefined) continue;
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) continue;
    if (best === undefined || ms > best.ms) {
      best = { ms, iso };
    }
  }
  return best;
}

/**
 * Resolve a conversation's effective [start, end] window in epoch ms.
 *
 * When the conversation carries no explicit end (`endIso` undefined — the
 * reconstructed form of a stored transcript whose heading end renders as
 * `--:--`), the window is derived from the segments so it spans the actual
 * utterances instead of collapsing to a zero-length point at the start:
 *
 *   1. conversation `endIso`, when known;
 *   2. the latest segment END (`segment.endIso`);
 *   3. the latest segment START (`segment.startIso`) — reconstructed
 *      transcripts rebuild segments with only a start, so the window must
 *      reach the last segment start;
 *   4. the conversation start itself (no segments at all).
 *
 * Each segment contributes its own extent (end when known, otherwise its
 * start); the window end is the maximum extent. Segment ISOs are already
 * rolled for cross-midnight by the reconstruct layer, so the derived end is
 * consistent with the segment timeline. The end is clamped to `>= start` so
 * the window is always valid regardless of input anomalies.
 */
function effectiveInterval(conversation: FusionConversationInput): Interval {
  const start = Date.parse(conversation.startIso);
  const endRaw =
    conversation.endIso !== undefined ? Date.parse(conversation.endIso) : NaN;
  // No conversation-level end ("--:--"): derive the window from the latest
  // SEGMENT extent via the shared primitive, so every end/interval derivation
  // in the pipeline uses ONE coherent implementation. Falling back only to
  // `start` would produce a zero/negative-length window that drops or
  // mis-clusters the conversation (issue #1810).
  const end = Number.isFinite(endRaw)
    ? (endRaw as number)
    : (maxSegmentExtent(conversation.segments)?.ms ?? start);
  // Clamp universally so the window is always non-negative. An explicit
  // conversation end that precedes the start (malformed/cross-day input)
  // would otherwise yield a negative-length window that shrinks the merge
  // horizon and can split a within-gap cluster.
  return { start, end: Math.max(end, start) };
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
