/**
 * Wearable cross-source fusion — deterministic reconciliation.
 *
 * Given one cluster (conversations from N sources that overlapped in
 * time), produce a single reconciled timeline where each utterance
 * carries the best source's text plus per-segment provenance, and
 * conflicts that could not be settled deterministically are recorded as
 * disagreements.
 *
 * Reconciliation rules (all deterministic, no LLM):
 *  - text: prefer higher source trust, then the more-complete (longer)
 *    transcript over a truncated one; otherwise a stable tie-break.
 *  - disagreement: when two sources offer genuinely different text for
 *    the same window/speaker (neither contains the other), record every
 *    candidate and keep a provisional winner marked uncertain — we never
 *    silently pick.
 *  - speaker: resolved labels unify the wearer across sources; generic
 *    labels that cannot be cross-matched keep a lowered confidence.
 *
 * Full segment-level alignment beyond time windows is a deferred
 * follow-up (see PR body). This pass aligns by (speaker, time window).
 */

import { resolveSpeaker, type SpeakerRegistry } from "../speakers.js";
import { maxSegmentExtent } from "./cluster.js";
import type { WearableConversation } from "../types.js";
import type {
  FusionConversationInput,
  FusionOptions,
  FusionSegmentInput,
  FusedDisagreement,
  FusedSegment,
  FusedSpeaker,
  SegmentPickReason,
} from "./types.js";

/** Default max drift (ms) for two segments to align across sources. */
export const DEFAULT_WINDOW_TOLERANCE_MS = 30_000;
/** Default trust weight for a source with no configured prior. */
export const DEFAULT_SOURCE_TRUST = 0.8;
/** Trust prior at which a source is considered "more trusted" than another. */
const TRUST_DECISION_EPSILON = 1e-9;
const GENERIC_LABEL_PATTERN = /^(Speaker \d+|Unknown speaker|SPEAKER_\d+)$/i;

export interface FuseClusterResult {
  sources: string[];
  speakers: FusedSpeaker[];
  title?: string;
  summary?: string;
  startIso: string;
  endIso?: string;
  segments: FusedSegment[];
  disagreements: FusedDisagreement[];
}

interface TaggedSegment {
  source: string;
  conversationId: string;
  speakerLabel: string;
  isSelf: boolean;
  text: string;
  startMs: number;
  startIso?: string;
  endIso?: string;
  sourceTrust: number;
  originalIndex: number;
}

interface AlignGroup {
  /** Match key: "self" for the wearer, else the resolved label. */
  key: string;
  speakerLabel: string;
  isSelf: boolean;
  members: TaggedSegment[];
  anchorMs: number;
  anchorStartIso?: string;
  /** The anchor member's ORIGINAL end ISO, when known. */
  anchorEndIso?: string;
  originalIndex: number;
}

function speakerKey(label: string, isSelf: boolean): string {
  return isSelf ? "self" : label;
}

function resolveTrust(
  source: string,
  trustMap: Record<string, number> | undefined,
): number {
  const value = trustMap?.[source];
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(1, Math.max(0, value));
  }
  return DEFAULT_SOURCE_TRUST;
}

/** Lowercased, punctuation-stripped word sequence — order-sensitive. */
function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

function wordsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function isWordPrefix(short: string[], long: string[]): boolean {
  if (short.length === 0 || short.length > long.length) return false;
  for (let i = 0; i < short.length; i++) {
    if (short[i] !== long[i]) return false;
  }
  return true;
}

function wordsCorroborate(
  a: string[],
  b: string[],
  allowPrefix: boolean,
): boolean {
  if (wordsEqual(a, b)) return true;
  if (!allowPrefix) return false;
  return isWordPrefix(a, b) || isWordPrefix(b, a);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function fusionInputsFromConversations(
  sourceId: string,
  conversations: readonly WearableConversation[],
  registry: SpeakerRegistry,
): FusionConversationInput[] {
  return conversations.map((conversation) => {
    const segments: FusionSegmentInput[] = conversation.segments.map((raw) => {
      const resolved = resolveSpeaker(sourceId, raw, registry);
      return {
        speaker: resolved.label,
        isSelf: resolved.isSelf,
        text: raw.text,
        ...(raw.startIso !== undefined ? { startIso: raw.startIso } : {}),
        ...(raw.endIso !== undefined ? { endIso: raw.endIso } : {}),
      };
    });
    return {
      source: sourceId,
      conversationId: conversation.id,
      startIso: conversation.startIso,
      ...(conversation.endIso !== undefined ? { endIso: conversation.endIso } : {}),
      ...(conversation.title !== undefined ? { title: conversation.title } : {}),
      ...(conversation.summary !== undefined ? { summary: conversation.summary } : {}),
      segments,
    };
  });
}

export function fuseCluster(
  cluster: readonly FusionConversationInput[],
  options: FusionOptions = {},
): FuseClusterResult {
  const trustMap = options.sourceTrust;
  const toleranceMs = options.windowToleranceMs ?? DEFAULT_WINDOW_TOLERANCE_MS;

  const sources: string[] = [];
  const sourcesSeen = new Set<string>();
  for (const conv of cluster) {
    if (!sourcesSeen.has(conv.source)) {
      sourcesSeen.add(conv.source);
      sources.push(conv.source);
    }
  }

  let startMs = Number.POSITIVE_INFINITY;
  let endMs = Number.NEGATIVE_INFINITY;
  let startIso: string | undefined;
  let endIso: string | undefined;
  for (const conv of cluster) {
    const ms = Date.parse(conv.startIso);
    if (Number.isFinite(ms) && ms < startMs) {
      startMs = ms;
      startIso = conv.startIso;
    }
    if (conv.endIso !== undefined) {
      const endM = Date.parse(conv.endIso);
      if (Number.isFinite(endM) && endM > endMs) {
        endMs = endM;
        endIso = conv.endIso;
      }
    }
  }
  const segmentExtent = maxSegmentExtent(
    cluster.flatMap((conv) => conv.segments),
  );
  if (segmentExtent !== undefined && segmentExtent.ms > endMs) {
    endMs = segmentExtent.ms;
    endIso = segmentExtent.iso;
  }
  if (endIso !== undefined && Number.isFinite(startMs) && endMs < startMs) {
    endIso = startIso;
    endMs = startMs;
  }
  if (startIso === undefined) {
    startIso = cluster[0]?.startIso ?? new Date(0).toISOString();
  }

  let title: string | undefined;
  let summary: string | undefined;
  for (const conv of cluster) {
    if (title === undefined && conv.title !== undefined && conv.title.trim().length > 0) {
      title = conv.title.trim();
    }
    if (
      summary === undefined &&
      conv.summary !== undefined &&
      conv.summary.trim().length > 0
    ) {
      summary = conv.summary.trim();
    }
    if (title !== undefined && summary !== undefined) break;
  }

  const tagged: TaggedSegment[] = [];
  for (const conv of cluster) {
    const sourceTrust = resolveTrust(conv.source, trustMap);
    for (const segment of conv.segments) {
      const startMsValue =
        segment.startIso !== undefined ? Date.parse(segment.startIso) : NaN;
      tagged.push({
        source: conv.source,
        conversationId: conv.conversationId,
        speakerLabel: segment.speaker,
        isSelf: segment.isSelf,
        text: segment.text,
        startMs: Number.isFinite(startMsValue)
          ? (startMsValue as number)
          : Number.POSITIVE_INFINITY,
        ...(segment.startIso !== undefined ? { startIso: segment.startIso } : {}),
        ...(segment.endIso !== undefined ? { endIso: segment.endIso } : {}),
        sourceTrust,
        originalIndex: tagged.length,
      });
    }
  }

  tagged.sort((a, b) => {
    const aFinite = Number.isFinite(a.startMs);
    const bFinite = Number.isFinite(b.startMs);
    if (aFinite && bFinite && a.startMs !== b.startMs) return a.startMs - b.startMs;
    if (aFinite !== bFinite) return aFinite ? -1 : 1;
    return a.originalIndex - b.originalIndex;
  });

  const groups: AlignGroup[] = [];
  for (const seg of tagged) {
    const key = speakerKey(seg.speakerLabel, seg.isSelf);
    const segMissing = !Number.isFinite(seg.startMs);
    const segWords = normalizeWords(seg.text);

    const corroborates = (group: AlignGroup): boolean => {
      if (group.members.some((member) => member.source === seg.source)) {
        return false;
      }
      const groupMissing = !Number.isFinite(group.anchorMs);
      if (groupMissing !== segMissing) return false;
      if (!groupMissing && Math.abs(seg.startMs - group.anchorMs) > toleranceMs) {
        return false;
      }
      return group.members.some((member) =>
        wordsCorroborate(normalizeWords(member.text), segWords, !groupMissing),
      );
    };

    const closestCorroborating = (
      wantSameSpeaker: boolean,
    ): AlignGroup | undefined => {
      let best: AlignGroup | undefined;
      let bestDelta = Infinity;
      for (const group of groups) {
        if (
          (group.key === key) !== wantSameSpeaker ||
          !corroborates(group)
        ) {
          continue;
        }
        const delta =
          !segMissing && Number.isFinite(group.anchorMs)
            ? Math.abs(seg.startMs - group.anchorMs)
            : 0;
        if (
          best === undefined ||
          delta < bestDelta ||
          (delta === bestDelta && group.anchorMs < best.anchorMs)
        ) {
          best = group;
          bestDelta = delta;
        }
      }
      return best;
    };

    let chosen = closestCorroborating(true);
    if (chosen === undefined) {
      chosen = closestCorroborating(false);
    }

    if (chosen !== undefined) {
      chosen.members.push(seg);
      if (seg.originalIndex < chosen.originalIndex) {
        chosen.originalIndex = seg.originalIndex;
      }
    } else {
      groups.push({
        key,
        speakerLabel: seg.speakerLabel,
        isSelf: seg.isSelf,
        members: [seg],
        anchorMs: seg.startMs,
        anchorStartIso: seg.startIso,
        anchorEndIso: seg.endIso,
        originalIndex: seg.originalIndex,
      });
    }
  }

  groups.sort((a, b) => {
    const aMissing = !Number.isFinite(a.anchorMs);
    const bMissing = !Number.isFinite(b.anchorMs);
    if (aMissing !== bMissing) return aMissing ? 1 : -1;
    if (!aMissing && a.anchorMs !== b.anchorMs) return a.anchorMs - b.anchorMs;
    return a.originalIndex - b.originalIndex;
  });

  const segments: FusedSegment[] = [];
  const disagreements: FusedDisagreement[] = [];
  for (const group of groups) {
    const reconciled = reconcileGroup(group);
    segments.push(reconciled.segment);
    disagreements.push(...reconciled.disagreements);
  }
  const preSortOrder = new Map(segments.map((seg, i) => [seg, i]));
  segments.sort((a, b) => {
    const aMs = a.startIso !== undefined ? Date.parse(a.startIso) : Number.NaN;
    const bMs = b.startIso !== undefined ? Date.parse(b.startIso) : Number.NaN;
    const aFinite = Number.isFinite(aMs);
    const bFinite = Number.isFinite(bMs);
    if (aFinite && bFinite) {
      if (aMs !== bMs) return aMs - bMs;
    } else if (aFinite !== bFinite) {
      return aFinite ? -1 : 1;
    }
    return (preSortOrder.get(a) ?? 0) - (preSortOrder.get(b) ?? 0);
  });
  detectCrossSegmentDisagreements(segments, toleranceMs, disagreements);

  const result: FuseClusterResult = {
    sources,
    speakers: collectSpeakers(tagged),
    startIso,
    segments,
    disagreements,
  };
  if (endIso !== undefined) result.endIso = endIso;
  if (title !== undefined) result.title = title;
  if (summary !== undefined) result.summary = summary;
  return result;
}

interface ReconciledGroup {
  segment: FusedSegment;
  disagreements: FusedDisagreement[];
}

function reconcileGroup(group: AlignGroup): ReconciledGroup {
  const members = group.members;
  const ranked = [...members].sort((a, b) => {
    if (Math.abs(b.sourceTrust - a.sourceTrust) > TRUST_DECISION_EPSILON) {
      return b.sourceTrust - a.sourceTrust;
    }
    if (b.text.length !== a.text.length) return b.text.length - a.text.length;
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    if (a.conversationId !== b.conversationId) {
      return a.conversationId < b.conversationId ? -1 : 1;
    }
    return a.originalIndex - b.originalIndex;
  });
  const top = ranked[0];
  const topWords = normalizeWords(top.text);

  let chosen = top;
  if (topWords.length > 0) {
    let bestLen = -1;
    for (const candidate of ranked) {
      if (candidate === top) continue;
      const candidateWords = normalizeWords(candidate.text);
      if (
        isWordPrefix(topWords, candidateWords) &&
        candidateWords.length > topWords.length &&
        candidateWords.length > bestLen
      ) {
        chosen = candidate;
        bestLen = candidateWords.length;
      }
    }
  }
  const truncatedOverride = chosen !== top;
  const others = ranked.filter((member) => member !== chosen);

  const chosenWords = normalizeWords(chosen.text);

  const reason: SegmentPickReason =
    members.length === 1
      ? "only-source"
      : truncatedOverride
        ? "more-complete"
        : others.some(
            (r) => chosen.sourceTrust - r.sourceTrust > TRUST_DECISION_EPSILON,
          )
          ? "higher-trust"
          : others.some((r) => chosen.text.length - r.text.length > 0)
            ? "more-complete"
            : "tie-break";

  const disagree: Array<{ source: string; value: string }> = [];
  let conflict = false;
  for (const candidate of others) {
    const candidateWords = normalizeWords(candidate.text);
    if (chosenWords.length === 0 && candidateWords.length === 0) continue;
    if (wordsEqual(chosenWords, candidateWords)) continue;
    if (
      isWordPrefix(candidateWords, chosenWords) ||
      isWordPrefix(chosenWords, candidateWords)
    ) {
      continue;
    }
    conflict = true;
    disagree.push({ source: candidate.source, value: candidate.text });
  }

  const distinctSpeakerKeys = new Set(
    members.map((m) => speakerKey(m.speakerLabel, m.isSelf)),
  );
  const speakerConflict = distinctSpeakerKeys.size > 1;

  const alternatives = others.map((candidate) => ({
    source: candidate.source,
    text: candidate.text,
  }));

  const confidence =
    conflict || speakerConflict
      ? clamp01(chosen.sourceTrust * 0.7)
      : members.length > 1
        ? clamp01(chosen.sourceTrust + 0.1 * (members.length - 1))
        : clamp01(chosen.sourceTrust);

  const segment: FusedSegment = {
    speaker: chosen.speakerLabel,
    isSelf: chosen.isSelf,
    text: chosen.text,
    confidence,
    provenance: {
      source: chosen.source,
      conversationId: chosen.conversationId,
      sourceTrust: chosen.sourceTrust,
      reason,
      alternatives,
      ...(chosen.startIso !== undefined
        ? { sourceStartIso: chosen.startIso }
        : {}),
      ...(chosen.endIso !== undefined ? { sourceEndIso: chosen.endIso } : {}),
    },
    ...(group.anchorStartIso !== undefined
      ? { startIso: group.anchorStartIso }
      : {}),
    ...(group.anchorEndIso !== undefined ? { endIso: group.anchorEndIso } : {}),
  };

  const disagreements: FusedDisagreement[] = [];
  const anchorIso =
    group.anchorStartIso ??
    (Number.isFinite(group.anchorMs)
      ? new Date(group.anchorMs).toISOString()
      : undefined);
  if (conflict) {
    disagreements.push({
      kind: "asr-text",
      subject: anchorIso ?? "(no timestamp)",
      candidates: [{ source: chosen.source, value: chosen.text }, ...disagree],
      provisional: { source: chosen.source, value: chosen.text },
    });
  }
  if (speakerConflict) {
    const speakerCandidates = members
      .map((m) => ({ source: m.source, value: m.speakerLabel }))
      .sort((a, b) =>
        a.source < b.source ? -1 : a.source > b.source ? 1 : 0,
      );
    disagreements.push({
      kind: "speaker",
      subject: anchorIso ?? "(no timestamp)",
      candidates: speakerCandidates,
      provisional: { source: chosen.source, value: chosen.speakerLabel },
    });
  }

  return { segment, disagreements };
}

/**
 * Detect ASR-text disagreements BETWEEN segments that were intentionally
 * kept separate (distinct utterances) yet share a speaker and a time
 * window and disagree on wording. Unlike an in-group conflict (same
 * utterance bridged by a truncation), these never merged — so neither
 * side's content is lost — but the unresolved disagreement is still
 * surfaced for review and each involved segment's confidence is lowered.
 *
 * Timestamped only: untimestamped segments have no window anchor to compare
 * against. Mutates `confidence` on involved segments and appends to `out`.
 */
function detectCrossSegmentDisagreements(
  segments: FusedSegment[],
  toleranceMs: number,
  out: FusedDisagreement[],
): void {
  const n = segments.length;
  if (n < 2) return;
  const claimed = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (claimed[i]) continue;
    const seed = segments[i]!;
    const seedMs =
      seed.startIso !== undefined ? Date.parse(seed.startIso) : NaN;
    if (!Number.isFinite(seedMs)) continue;
    const seedWords = normalizeWords(seed.text);
    const clusterIdx: number[] = [];
    for (let j = i + 1; j < n; j++) {
      if (claimed[j]) continue;
      const cand = segments[j]!;
      if (
        speakerKey(cand.speaker, cand.isSelf) !==
        speakerKey(seed.speaker, seed.isSelf)
      ) {
        continue;
      }
      if (cand.provenance.source === seed.provenance.source) continue;
      const candMs =
        cand.startIso !== undefined ? Date.parse(cand.startIso) : NaN;
      if (!Number.isFinite(candMs)) continue;
      if (Math.abs(candMs - seedMs) > toleranceMs) continue;
      if (wordsCorroborate(seedWords, normalizeWords(cand.text), true)) {
        continue;
      }
      clusterIdx.push(j);
    }
    if (clusterIdx.length === 0) continue;
    clusterIdx.unshift(i);
    for (const idx of clusterIdx) claimed[idx] = true;

    const involved = clusterIdx.map((idx) => segments[idx]!);
    const involvedOrder = new Map(involved.map((seg, i) => [seg, i]));
    involved.sort((a, b) => {
      if (
        Math.abs(b.provenance.sourceTrust - a.provenance.sourceTrust) >
        TRUST_DECISION_EPSILON
      ) {
        return b.provenance.sourceTrust - a.provenance.sourceTrust;
      }
      if (b.text.length !== a.text.length) return b.text.length - a.text.length;
      if (a.provenance.source !== b.provenance.source) {
        return a.provenance.source < b.provenance.source ? -1 : 1;
      }
      return involvedOrder.get(a)! - involvedOrder.get(b)!;
    });
    const provisional = involved[0]!;
    const anchorIso = involved
      .map((s) => s.startIso)
      .filter((v): v is string => v !== undefined)
      .sort()[0];

    for (const seg of involved) {
      seg.confidence = clamp01(seg.provenance.sourceTrust * 0.7);
    }

    out.push({
      kind: "asr-text",
      subject: anchorIso ?? "(no timestamp)",
      candidates: involved.map((s) => ({
        source: s.provenance.source,
        value: s.text,
      })),
      provisional: {
        source: provisional.provenance.source,
        value: provisional.text,
      },
    });
  }
}

/**
 * Build the reconciled speaker list. The wearer unifies across all
 * sources; generic labels (bare "Speaker N" or a raw key) seen in only
 * one source get a lowered confidence since they could not be
 * confidently matched across sources.
 */
function collectSpeakers(tagged: readonly TaggedSegment[]): FusedSpeaker[] {
  interface Acc {
    label: string;
    isSelf: boolean;
    sources: Set<string>;
    generic: boolean;
  }
  const order: string[] = [];
  const acc = new Map<string, Acc>();
  for (const seg of tagged) {
    const key = speakerKey(seg.speakerLabel, seg.isSelf);
    let entry = acc.get(key);
    if (entry === undefined) {
      entry = {
        label: seg.speakerLabel,
        isSelf: seg.isSelf,
        sources: new Set<string>(),
        generic: GENERIC_LABEL_PATTERN.test(seg.speakerLabel),
      };
      acc.set(key, entry);
      order.push(key);
    }
    entry.sources.add(seg.source);
  }
  return order.map((key) => {
    const entry = acc.get(key);
    if (entry === undefined) throw new Error("fusion speaker accumulator miss");
    const sourceCount = entry.sources.size;
    const confidence = entry.isSelf
      ? sourceCount > 1
        ? 0.95
        : 0.85
      : entry.generic
        ? sourceCount > 1
          ? 0.7
          : 0.5
        : sourceCount > 1
          ? 0.9
          : 0.7;
    return {
      label: entry.label,
      isSelf: entry.isSelf,
      confidence,
      sources: [...entry.sources].sort(),
    };
  });
}
