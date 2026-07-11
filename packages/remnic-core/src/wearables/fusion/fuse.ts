/**
 * Wearable cross-source fusion — day-level orchestrator.
 *
 * Takes every enabled source's normalized conversations for one day,
 * clusters them across sources, reconciles each cluster, and attaches a
 * stable content-hash id so re-running over unchanged inputs produces a
 * byte-identical artifact (idempotent — no duplicate files).
 *
 * Deterministic end to end: no timestamps from "now", no LLM, no
 * randomness. The only time-derived value is the `fusedAt` frontmatter
 * field added at storage time (excluded from the content hash).
 */

import { createHash } from "node:crypto";
import { clusterConversations } from "./cluster.js";
import {
  DEFAULT_WINDOW_TOLERANCE_MS,
  fuseCluster,
  type FuseClusterResult,
} from "./reconcile.js";
import { DEFAULT_PROXIMITY_GAP_MS } from "./cluster.js";
import type {
  FusionConversationInput,
  FusionDayResult,
  FusionOptions,
  FusedConversationProvenance,
  FusedWearableConversation,
} from "./types.js";

const FUSION_ID_PREFIX = "fusion";

/**
 * Canonical, stable serialization of a set of fusion inputs. Used both
 * for the per-conversation id and the day content hash — so identical
 * inputs always produce identical hashes regardless of input order.
 */
function canonicalInputsKey(
  date: string,
  inputs: readonly FusionConversationInput[],
): string {
  const sorted = [...inputs].sort((a, b) => {
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    if (a.conversationId !== b.conversationId) {
      return a.conversationId < b.conversationId ? -1 : 1;
    }
    return 0;
  });
  const lines: string[] = [`date:${date}`];
  for (const conv of sorted) {
    lines.push(
      `conv|${conv.source}|${conv.conversationId}|${conv.startIso}|${conv.endIso ?? ""}|${conv.title ?? ""}|${conv.summary ?? ""}`,
    );
    for (const segment of conv.segments) {
      lines.push(
        `seg|${segment.speaker}|${segment.isSelf ? "self" : "other"}|${segment.startIso ?? ""}|${segment.endIso ?? ""}|${segment.text}`,
      );
    }
  }
  return createHash("sha256").update(lines.join("\n"), "utf-8").digest("hex");
}

function buildProvenance(
  cluster: readonly FusionConversationInput[],
  proximityGapMs: number,
  windowToleranceMs: number,
): FusedConversationProvenance {
  return {
    contributions: cluster.map((conv) => ({
      source: conv.source,
      conversationId: conv.conversationId,
      startIso: conv.startIso,
      ...(conv.endIso !== undefined ? { endIso: conv.endIso } : {}),
      segmentCount: conv.segments.length,
    })),
    proximityGapMs,
    windowToleranceMs,
    method: "time-proximity",
  };
}

/**
 * Fuse every source's conversations for one day into a stable result.
 * Empty input yields an empty (but well-formed) result so callers can
 * treat "nothing to fuse" uniformly.
 */
export function fuseDay(
  date: string,
  inputs: readonly FusionConversationInput[],
  options: FusionOptions = {},
): FusionDayResult {
  const proximityGapMs = options.proximityGapMs ?? DEFAULT_PROXIMITY_GAP_MS;
  const windowToleranceMs =
    options.windowToleranceMs ?? DEFAULT_WINDOW_TOLERANCE_MS;

  const clusters = clusterConversations(inputs, proximityGapMs);
  const conversations: FusedWearableConversation[] = clusters.map((cluster) => {
    const fused: FuseClusterResult = fuseCluster(cluster, {
      ...options,
      windowToleranceMs,
    });
    const id = `${FUSION_ID_PREFIX}-${canonicalInputsKey(date, cluster).slice(0, 24)}`;
    const result: FusedWearableConversation = {
      id,
      date,
      startIso: fused.startIso,
      sources: fused.sources,
      speakers: fused.speakers,
      segments: fused.segments,
      disagreements: fused.disagreements,
      provenance: buildProvenance(cluster, proximityGapMs, windowToleranceMs),
    };
    if (fused.endIso !== undefined) result.endIso = fused.endIso;
    if (fused.title !== undefined) result.title = fused.title;
    if (fused.summary !== undefined) result.summary = fused.summary;
    return result;
  });

  const sourcesSeen = new Set<string>();
  const sources: string[] = [];
  for (const conv of conversations) {
    for (const source of conv.sources) {
      if (!sourcesSeen.has(source)) {
        sourcesSeen.add(source);
        sources.push(source);
      }
    }
  }

  return {
    date,
    conversations,
    sources,
    contentHash: canonicalInputsKey(date, inputs),
  };
}
