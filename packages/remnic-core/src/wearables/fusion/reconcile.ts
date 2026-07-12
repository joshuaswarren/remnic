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
  /** The anchor member's ORIGINAL start ISO — the canonical utterance
   * time the fused segment is emitted at (groups are sorted by anchorMs,
   * so the emitted startIso must come from here, not from the chosen
   * higher-trust source's later clock, or pre-sorted chronology breaks).
   * Undefined for untimestamped (missing-start) groups. */
  anchorStartIso?: string;
  /** The anchor member's ORIGINAL end ISO, when known. */
  anchorEndIso?: string;
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
  // source (so two sequential same-source utterances never collapse). A
  // segment joins an existing group when their time windows match (or both
  // are untimestamped) AND the text corroborates the SAME utterance.
  // Speaker is matched in two tiers: first an exact same-speaker group;
  // only when none exists does a segment join a group whose utterance
  // corroborates but whose speaker label DISAGREES. That is a speaker
  // conflict on the same utterance — fused into one segment and recorded
  // as a disagreement (see reconcileGroup) rather than emitted as two
  // separate segments. This does NOT collapse distinct utterances: the
  // text must corroborate, so different-worded same-window segments
  // (the r2 separation) still stay apart.
  const groups: AlignGroup[] = [];
  for (const seg of tagged) {
    const key = speakerKey(seg.speakerLabel, seg.isSelf);
    const segMissing = !Number.isFinite(seg.startMs);
    const segWords = normalizeWords(seg.text);

    // True when `group` has room for `seg`'s source and corroborates the
    // same utterance (matching time window + corroborating text). Speaker
    // is intentionally NOT tested here — the caller decides whether a
    // same-speaker match or a speaker-conflict match is acceptable.
    const corroborates = (group: AlignGroup): boolean => {
      if (group.members.some((member) => member.source === seg.source)) {
        return false;
      }
      // Missing-start segments only align with other missing-start groups.
      const groupMissing = !Number.isFinite(group.anchorMs);
      if (groupMissing !== segMissing) return false;
      if (!groupMissing && Math.abs(seg.startMs - group.anchorMs) > toleranceMs) {
        return false;
      }
      // Cross-source corroboration gate: distinct utterances that merely
      // share a speaker and a time window (timestamped) — or a speaker key
      // alone (untimed) — must NOT collapse. Timestamped alignment accepts
      // an exact word match OR a leading-word prefix (truncation) so the
      // more-complete-wins override can reunite a clipped transcript with
      // its full wording; untimed alignment has no anchor, so exact only.
      return group.members.some((member) =>
        wordsCorroborate(normalizeWords(member.text), segWords, !groupMissing),
      );
    };

    // Choose the CLOSEST corroborating group instead of the first match
    // (issue #1849). Within windowToleranceMs several groups can corroborate
    // the same short utterance — e.g. a speaker repeating "yes" at 10:00 and
    // 10:20 with a 30s window — so a later source segment at 10:21
    // corroborates BOTH. First-match would attach it to the earliest (10:00)
    // group even though 10:20 is nearer, misattributing provenance and
    // potentially reordering the fused timeline. Scan every candidate and
    // keep the one whose anchor is nearest to this segment by
    // |anchorMs - startMs|; ties break on the smaller anchor, then on the
    // order the group was created (stable, never dependent on key order).
    // Single-occurrence behavior is unchanged: the lone corroborating group
    // is trivially the closest.
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

    // Prefer an exact same-speaker corroborating group.
    let chosen = closestCorroborating(true);
    if (chosen === undefined) {
      // Fall back: same utterance (time+text corroborate) but a different
      // speaker label -> speaker conflict, aligned into one segment.
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
        // The creating segment is the EARLIEST member (tagged is
        // time-sorted), so its clock IS the group anchor that groups are
        // sorted by and that the fused segment must be emitted at.
        anchorStartIso: seg.startIso,
        anchorEndIso: seg.endIso,
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
    disagreements.push(...reconciled.disagreements);
  }
  // Belt-and-suspenders: segments are built from anchor-sorted groups with
  // each segment's startIso pinned to its group anchor, so the array is
  // already chronological. This explicit, STABLE re-sort guarantees that
  // invariant end to end — no trust-based text/content swap can ever
  // reorder the timeline, even if a future change alters how a fused
  // segment's timestamp is derived. Stability contract:
  //   - timestamped segments sort by startMs ascending;
  //   - missing/invalid timestamps keep their position (timestamped before
  //     missing, preserving original relative order among missing ones);
  //   - equal timestamps preserve prior order via a deterministic secondary
  //     key (the pre-sort index), never reordering by source/speaker — so
  //     cross-source clock skew does not scramble same-anchor utterances.
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
    // Equal timestamp (or both missing): preserve prior order — never let
    // a naive ts-only comparator scramble equal/missing-time entries.
    return (preSortOrder.get(a) ?? 0) - (preSortOrder.get(b) ?? 0);
  });
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
  disagreements: FusedDisagreement[];
}

function reconcileGroup(group: AlignGroup): ReconciledGroup {
  const members = group.members;
  // Rank: higher trust, then more-complete (longer), then stable source
  // order, finally the original transcript index — a total order so the
  // comparator returns 0 only for an identical item (never nonzero on a
  // tie), keeping the sort stable and contract-compliant.
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

  // Speaker-attribution conflict: members of the same utterance disagree
  // on who spoke (same time window + corroborating text, different label).
  // Detected from member labels — not the group key — so a group that
  // absorbed a conflicting speaker is handled identically. The chosen
  // (top-ranked) member's attribution wins the segment provisionally;
  // every source's label is surfaced as a disagreement with full
  // provenance so no attribution is silently lost.
  const distinctSpeakerKeys = new Set(
    members.map((m) => speakerKey(m.speakerLabel, m.isSelf)),
  );
  const speakerConflict = distinctSpeakerKeys.size > 1;

  const alternatives = others.map((candidate) => ({
    source: candidate.source,
    text: candidate.text,
  }));

  // Confidence: single source -> its trust; corroboration boosts; a
  // recorded text OR speaker conflict lowers it.
  const confidence =
    conflict || speakerConflict
      ? clamp01(chosen.sourceTrust * 0.7)
      : members.length > 1
        ? clamp01(chosen.sourceTrust + 0.1 * (members.length - 1))
        : clamp01(chosen.sourceTrust);

  // TIMELINE POSITION (startIso/endIso) comes from the group/window ANCHOR
  // — the canonical utterance time the groups are sorted by — NOT from the
  // chosen (higher-trust) source's clock. The chosen source may be LATER
  // than the anchor (a low-trust utterance at 10:00 corroborated by a
  // high-trust source at 10:25 within tolerance); emitting chosen.startIso
  // would print the fused segment at 10:25 even though the group sits at
  // the 10:00 anchor, jumping it past an intervening 10:10 utterance and
  // corrupting the chronology. The chosen source still provides the TEXT;
  // only the timeline position is anchored. Its original clock is kept in
  // provenance so the source's recording time stays traceable.
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
  // The disagreement subject is the EMITTED timeline position (the group
  // anchor), coherent with segment.startIso — not the chosen source's
  // possibly-later clock.
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
    // One candidate per source (a group holds one member per source),
    // sorted by source for determinism; the chosen source is provisional.
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
    // Stable secondary key: each involved segment's position in the
    // reconciled segment array (clusterIdx is ascending). Two cands can
    // share a source, so source alone is NOT a total order here; the
    // position tie-break makes the comparator return 0 only for an
    // identical item and keeps the ranking deterministic — mirroring
    // reconcileGroup's originalIndex tie-break.
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
