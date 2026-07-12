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
  DEFAULT_SOURCE_TRUST,
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
 * Canonical, stable serialization of a set of fusion inputs — the base
 * for the per-conversation id. Input-only so a conversation keeps a
 * stable identity across re-runs regardless of input order. The day
 * content hash additionally folds the effective fusion config (see
 * `canonicalDayKey`) so a config change invalidates the cached artifact.
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

/**
 * Effective-config fingerprint folded into the day content hash so a
 * change to any clustering/reconciliation knob (proximity gap, window
 * tolerance, or per-source trust) invalidates the cached artifact.
 * Defaults are resolved so an explicit default hashes identically to an
 * omission, keeping the skip-unchanged path deterministic. Only sources
 * that actually contribute to the day are included, so a trust change
 * for an absent source cannot spuriously trigger a rebuild.
 */
function configFingerprint(
  options: FusionOptions,
  sources: readonly string[],
): string {
  const proximityGapMs = options.proximityGapMs ?? DEFAULT_PROXIMITY_GAP_MS;
  const windowToleranceMs =
    options.windowToleranceMs ?? DEFAULT_WINDOW_TOLERANCE_MS;
  const lines: string[] = [
    `gap:${proximityGapMs}`,
    `tol:${windowToleranceMs}`,
  ];
  const trustMap = options.sourceTrust ?? {};
  for (const source of [...new Set(sources)].sort()) {
    const trust = trustMap[source] ?? DEFAULT_SOURCE_TRUST;
    lines.push(`trust|${source}|${trust}`);
  }
  return lines.join("\n");
}

/**
 * Day idempotency key: the input-only hash combined with the effective
 * fusion-config fingerprint. Same inputs + same config => same hash
 * (no duplicate rewrite); a config change => new hash => rebuild.
 */
function canonicalDayKey(
  date: string,
  inputs: readonly FusionConversationInput[],
  options: FusionOptions,
): string {
  const inputsKey = canonicalInputsKey(date, inputs);
  const fingerprint = configFingerprint(
    options,
    inputs.map((conv) => conv.source),
  );
  return createHash("sha256")
    .update(inputsKey)
    .update("\n")
    .update(fingerprint)
    .digest("hex");
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
    contentHash: canonicalDayKey(date, inputs, options),
  };
}
