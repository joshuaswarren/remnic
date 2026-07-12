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
/** Labels that cannot be confidently cross-matched between sources.
 * Raw provider diarization keys (e.g. Omi `SPEAKER_00`) are generic too:
 * they carry no cross-source identity, so they get the same lowered
 * confidence as bare "Speaker N". */
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
  /** Original position in the flattened input (sources in first-appearance
   * order, then segment order within each source). Carried through
   * alignment so equal-time segments keep their transcript sequence. */
  originalIndex: number;
}

interface AlignGroup {
  /** Match key: "self" for the wearer, else the resolved label. */
  key: string;
  speakerLabel: string;
  isSelf: boolean;
  members: TaggedSegment[];
  anchorMs: number;
  /** Earliest original sequence index among members — the secondary sort
   * key so equal-anchorMs groups keep transcript/source order. */
  originalIndex: number;
}

/** Match key that unifies the wearer across sources. */
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

/** True when `short` is an exact leading prefix of `long` (truncation). */
function isWordPrefix(short: string[], long: string[]): boolean {
  if (short.length === 0 || short.length > long.length) return false;
  for (let i = 0; i < short.length; i++) {
    if (short[i] !== long[i]) return false;
  }
  return true;
}

/** Whether two normalized word sequences corroborate the SAME utterance.
 * Exact match always corroborates; a leading-word-prefix (truncation)
 * corroborates only when `allowPrefix` is set (timestamped alignment),
 * so the more-complete-wins override can reunite a clipped transcript
 * with its full wording. Untimed alignment passes `allowPrefix = false`
 * and demands an exact word match. */
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

/**
 * Build fusion inputs from raw provider conversations + the shared
 * speaker registry. This is the precise connector path: full ISO
 * timestamps and resolved speaker labels. (The on-demand service path
 * instead reconstructs inputs from stored transcripts — see
 * `reconstruct.ts`.)
 */
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

/**
 * Fuse one cluster into a reconciled conversation (without id/date).
 */
export function fuseCluster(
  cluster: readonly FusionConversationInput[],
  options: FusionOptions = {},
): FuseClusterResult {
  const trustMap = options.sourceTrust;
  const toleranceMs = options.windowToleranceMs ?? DEFAULT_WINDOW_TOLERANCE_MS;

  // Sources in first-appearance order.
  const sources: string[] = [];
  const sourcesSeen = new Set<string>();
  for (const conv of cluster) {
    if (!sourcesSeen.has(conv.source)) {
      sourcesSeen.add(conv.source);
      sources.push(conv.source);
    }
  }

  // Earliest start / latest end across the cluster.
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
  if (startIso === undefined) {
    // No parseable start in the cluster — fall back to the first conv's
    // start string so the required field stays present downstream.
    startIso = cluster[0]?.startIso ?? new Date(0).toISOString();
  }

  // Title / summary: first non-empty in cluster order.
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

  // Flatten + tag every segment with its source provenance and trust.
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

  // Deterministic order: time first. Equal-time (and both-missing)
  // segments keep their ORIGINAL transcript/source sequence instead of
  // being scrambled by source or speaker label, so minute-precision and
  // untimestamped utterances are not reordered relative to their input.
  tagged.sort((a, b) => {
    const aFinite = Number.isFinite(a.startMs);
    const bFinite = Number.isFinite(b.startMs);
    if (aFinite && bFinite && a.startMs !== b.startMs) return a.startMs - b.startMs;
    if (aFinite !== bFinite) return aFinite ? -1 : 1;
    return a.originalIndex - b.originalIndex;
  });

  // Greedy cross-source alignment: a group holds at most one segment per
  // source (so two sequential same-source utterances never collapse),
  // and accepts a new segment only when speaker matches and the start is
  // within the tolerance window of the group anchor.
  const groups: AlignGroup[] = [];
  for (const seg of tagged) {
    const key = speakerKey(seg.speakerLabel, seg.isSelf);
    const segMissing = !Number.isFinite(seg.startMs);
    let chosen: AlignGroup | undefined;
    for (const group of groups) {
      if (group.key !== key) continue;
      if (group.members.some((member) => member.source === seg.source)) continue;
      // Missing-start segments only align with other missing-start groups.
      const groupMissing = !Number.isFinite(group.anchorMs);
      if (groupMissing !== segMissing) continue;
      if (!groupMissing && Math.abs(seg.startMs - group.anchorMs) > toleranceMs) {
        continue;
      }
      // Cross-source corroboration gate. A segment only joins an existing
      // group when it corroborates the SAME utterance as a member. Without
      // this, distinct utterances that merely share a speaker and a time
      // window (timestamped) — or a speaker key alone (untimed) — collapse
      // into one segment and silently lose a source's content. Timestamped
      // alignment accepts an exact word match OR a leading-word prefix
      // (truncation) so the more-complete-wins override can still reunite a
      // clipped transcript with its full wording; untimed alignment has no
      // time anchor, so it requires an exact word match.
      const segWords = normalizeWords(seg.text);
      const corroborated = group.members.some((member) =>
        wordsCorroborate(normalizeWords(member.text), segWords, !groupMissing),
      );
      if (!corroborated) continue;
      chosen = group;
      break;
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
        originalIndex: seg.originalIndex,
      });
    }
  }

  // Output groups in time order; missing-start groups last. Equal-anchorMs
  // (and all-missing) groups tie-break on original transcript/source
  // sequence — not source/speaker label — so equal-time utterances keep
  // the order they appeared in their input transcripts.
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
    if (reconciled.disagreement !== undefined) {
      disagreements.push(reconciled.disagreement);
    }
  }
  // Cross-segment ASR disagreements: distinct utterances kept as separate
  // segments (never collapsed) yet sharing a speaker + time window and
  // disagreeing on wording. Neither side's content is lost — both remain
  // visible segments — but the unresolved conflict is still surfaced for
  // review and each involved segment's confidence is lowered, matching
  // how an in-group conflict is flagged.
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
  disagreement?: FusedDisagreement;
}

function reconcileGroup(group: AlignGroup): ReconciledGroup {
  const members = group.members;
  // Rank: higher trust, then more-complete (longer), then stable source order.
  const ranked = [...members].sort((a, b) => {
    if (Math.abs(b.sourceTrust - a.sourceTrust) > TRUST_DECISION_EPSILON) {
      return b.sourceTrust - a.sourceTrust;
    }
    if (b.text.length !== a.text.length) return b.text.length - a.text.length;
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    return a.conversationId < b.conversationId ? -1 : 1;
  });
  const top = ranked[0];
  const topWords = normalizeWords(top.text);

  // Truncation override: the top-ranked (highest-trust) member may be a
  // CLIPPED version of a corroborating candidate — e.g. a summary source
  // clipped at "The deploy window opens at" while a verbatim source has
  // the full sentence. Trust dominates the rank, so without this the
  // truncated high-trust text would win despite the documented
  // "more-complete wins" rule. When the top's words are a strict prefix of
  // another member's words, adopt the LONGEST such more-complete member's
  // text + provenance.
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

  // Conflict detection: a candidate whose word sequence differs from the
  // chosen text AND is not a containment (one a prefix/truncation of the
  // other). Containment is "more-complete wins" with no disagreement.
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

  const alternatives = others.map((candidate) => ({
    source: candidate.source,
    text: candidate.text,
  }));

  // Confidence: single source -> its trust; corroboration boosts;
  // a recorded conflict lowers it.
  const confidence = conflict
    ? clamp01(chosen.sourceTrust * 0.7)
    : members.length > 1
      ? clamp01(chosen.sourceTrust + 0.1 * (members.length - 1))
      : clamp01(chosen.sourceTrust);

  const segment: FusedSegment = {
    speaker: group.speakerLabel,
    isSelf: group.isSelf,
    text: chosen.text,
    confidence,
    provenance: {
      source: chosen.source,
      conversationId: chosen.conversationId,
      sourceTrust: chosen.sourceTrust,
      reason,
      alternatives,
    },
    ...(chosen.startIso !== undefined ? { startIso: chosen.startIso } : {}),
    ...(chosen.endIso !== undefined ? { endIso: chosen.endIso } : {}),
  };

  let disagreement: FusedDisagreement | undefined;
  if (conflict) {
    const anchorIso =
      chosen.startIso ??
      (Number.isFinite(group.anchorMs)
        ? new Date(group.anchorMs).toISOString()
        : undefined);
    disagreement = {
      kind: "asr-text",
      subject: anchorIso ?? "(no timestamp)",
      candidates: [{ source: chosen.source, value: chosen.text }, ...disagree],
      provisional: { source: chosen.source, value: chosen.text },
    };
  }

  return { segment, disagreement };
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
      if (cand.isSelf !== seed.isSelf || cand.speaker !== seed.speaker) {
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
    // Rank the provisional winner: higher trust, then longer text, then
    // stable source order — mirrors reconcileGroup's member ranking.
    involved.sort((a, b) => {
      if (
        Math.abs(b.provenance.sourceTrust - a.provenance.sourceTrust) >
        TRUST_DECISION_EPSILON
      ) {
        return b.provenance.sourceTrust - a.provenance.sourceTrust;
      }
      if (b.text.length !== a.text.length) return b.text.length - a.text.length;
      return a.provenance.source < b.provenance.source ? -1 : 1;
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
