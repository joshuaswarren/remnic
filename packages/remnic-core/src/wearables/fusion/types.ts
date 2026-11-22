/**
 * Wearable cross-source fusion — shared types (issue #1810).
 *
 * Fusion merges same-day conversations from multiple enabled wearable
 * sources into `FusedWearableConversation` artifacts: one reconciled
 * timeline per real-world conversation, with per-segment source
 * provenance and unresolved conflicts surfaced as `disagreements[]`.
 *
 * Everything in this module is DETERMINISTIC — no LLM calls. LLM-assisted
 * reconciliation, memory-extraction over fused artifacts, and full
 * segment-level alignment are deferred follow-ups (see PR body).
 */

/**
 * One normalized segment fed into fusion. Speaker labels are already
 * resolved through the speaker registry (`resolveSpeaker`), and text is
 * post-cleanup + post-redaction — fusion consumes the same material day
 * transcripts store, never raw provider output.
 */
export interface FusionSegmentInput {
  /** Resolved speaker label (e.g. "Jane", "Me (you)", "Speaker 0"). */
  speaker: string;
  isSelf: boolean;
  text: string;
  /** ISO 8601 start, when known. */
  startIso?: string;
  /** ISO 8601 end, when known. */
  endIso?: string;
}

export interface FusionConversationInput {
  source: string;
  /** Provider-stable conversation id within that source. */
  conversationId: string;
  /** Provider title, when available. */
  title?: string;
  /** Provider summary, when available. */
  summary?: string;
  /** ISO 8601 conversation start. */
  startIso: string;
  /** ISO 8601 conversation end, when known. */
  endIso?: string;
  /** Ordered normalized segments. */
  segments: FusionSegmentInput[];
}

export type SegmentPickReason =
  | "only-source"
  | "higher-trust"
  | "more-complete"
  | "tie-break";

export type DisagreementKind = "asr-text" | "speaker" | "timestamp";

export interface FusedSegmentProvenance {
  source: string;
  conversationId: string;
  /** Trust weight of the chosen source at reconciliation time (0..1). */
  sourceTrust: number;
  reason: SegmentPickReason;
  /** Other sources that offered a candidate text for this window/speaker. */
  alternatives: Array<{ source: string; text: string }>;
  sourceStartIso?: string;
  sourceEndIso?: string;
}

export interface FusedSegment {
  speaker: string;
  /** Whether this speaker is the wearer. */
  isSelf: boolean;
  text: string;
  /** Window start (ISO), when known. */
  startIso?: string;
  /** Window end (ISO), when known. */
  endIso?: string;
  /** 0..1 confidence in this segment's text + attribution. */
  confidence: number;
  provenance: FusedSegmentProvenance;
}

export interface FusedDisagreement {
  kind: DisagreementKind;
  /**
   * What the disagreement concerns — an ISO window anchor, a speaker
   * label, or "(no timestamp)" for un-timestamped windows.
   */
  subject: string;
  candidates: Array<{ source: string; value: string }>;
  /** Best-effort provisional winner; marked uncertain, NOT authoritative. */
  provisional?: { source: string; value: string };
}

export interface FusedSpeaker {
  label: string;
  /** Whether this speaker is the wearer. */
  isSelf: boolean;
  /**
   * 0..1 — lowered when a speaker could not be confidently matched
   * across sources (e.g. a generic diarization label seen in one
   * source only).
   */
  confidence: number;
  sources: string[];
}

export interface FusedContribution {
  source: string;
  conversationId: string;
  startIso: string;
  endIso?: string;
  segmentCount: number;
}

export interface FusedConversationProvenance {
  contributions: FusedContribution[];
  /** Max gap (ms) two conversations could span and still merge. */
  proximityGapMs: number;
  /** Max drift (ms) for two segments to align across sources. */
  windowToleranceMs: number;
  method: "time-proximity";
}

export interface FusedWearableConversation {
  /** Stable content-hash id (deterministic from inputs; idempotent). */
  id: string;
  /** YYYY-MM-DD the conversation was recorded. */
  date: string;
  /** Earliest start across contributing sources. */
  startIso: string;
  /** Latest end across contributing sources, when known. */
  endIso?: string;
  /** Source ids that contributed at least one conversation. */
  sources: string[];
  /** Reconciled speakers (deduped across sources). */
  speakers: FusedSpeaker[];
  /** Provider title, when any source supplied one. */
  title?: string;
  /** Provider summary, when any source supplied one. */
  summary?: string;
  /** Aligned, reconciled segments in chronological order. */
  segments: FusedSegment[];
  disagreements: FusedDisagreement[];
  provenance: FusedConversationProvenance;
}

export interface FusionOptions {
  /** Max gap (ms) between conversations to merge into one cluster. */
  proximityGapMs?: number;
  /** Max drift (ms) for two segments to align across sources. */
  windowToleranceMs?: number;
  /** Per-source trust weights (unknown sources default to 0.8). */
  sourceTrust?: Record<string, number>;
}

export interface FusionDayResult {
  date: string;
  conversations: FusedWearableConversation[];
  /** Distinct source ids that contributed any conversation. */
  sources: string[];
  /** SHA-256 over the canonical input serialization + effective fusion config (idempotency key). */
  contentHash: string;
}

export interface FusedDayMeta {
  kind: "wearable-fusion";
  date: string;
  sourceCount: number;
  conversationCount: number;
  contentHash: string;
  bodyHash: string;
  fusedAt: string;
}

export interface FusedDayFile {
  meta: FusedDayMeta;
  conversations: FusedWearableConversation[];
  /**
   * False when the JSON body failed to parse (truncated/corrupt). A
   * legitimately empty (`[]`) body parses fine — parseOk stays true — so
   * callers can distinguish "nothing to fuse" from a broken file and force
   * a self-repair rewrite even when the frontmatter hash matches and the
   * parsed conversation count is also zero.
   */
  parseOk: boolean;
}
