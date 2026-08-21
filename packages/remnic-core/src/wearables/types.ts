/**
 * Wearable transcript subsystem — shared types (issue: wearable connectors).
 *
 * A "wearable source" is an always-on recording device with a cloud or
 * local API that exposes diarized conversation transcripts (Limitless
 * Pendant, Bee, Omi, ...). Connectors for concrete providers live in
 * optional à-la-carte packages (`@remnic/connector-limitless`,
 * `@remnic/connector-bee`, `@remnic/connector-omi`) and implement
 * `WearableSourceConnector`; everything provider-agnostic — cleanup,
 * speaker labeling, user corrections, day-transcript storage, and
 * trust-gated memory creation — lives in this core subsystem.
 */

import type { ImportanceLevel } from "../types.js";

/** One diarized utterance from a wearable transcript. */
export interface WearableTranscriptSegment {
  /** Utterance text as supplied by the provider (pre-cleanup). */
  text: string;
  /**
   * Stable per-source speaker key. Connectors derive this from whatever
   * the provider exposes (a name, a diarization label like "SPEAKER_00"
   * or "0", or a person id). Used to look up overrides in the speaker
   * registry as `<sourceId>:<speakerKey>`.
   */
  speakerKey: string;
  /** Provider-supplied display name, when available. */
  speakerName?: string;
  /** True when the provider identified this utterance as the wearer. */
  isWearer?: boolean;
  /** ISO 8601 start of the utterance, when the provider supplies one. */
  startIso?: string;
  /** ISO 8601 end of the utterance, when the provider supplies one. */
  endIso?: string;
}

/** One conversation (recording session) from a wearable source. */
export interface WearableConversation {
  /** Provider-stable conversation id (string form). */
  id: string;
  /** Connector id this conversation came from (e.g. "limitless"). */
  source: string;
  /** Provider title / one-line summary, when available. */
  title?: string;
  /** Provider-generated long summary, when available. */
  summary?: string;
  /** ISO 8601 conversation start. */
  startIso: string;
  /** ISO 8601 conversation end, when known. */
  endIso?: string;
  /** Human-readable location, when the provider supplies one. */
  location?: string;
  /** Ordered diarized segments. */
  segments: WearableTranscriptSegment[];
}

/** Options for a single conversations fetch (one day window). */
export interface WearableFetchOptions {
  /** Day to fetch, formatted YYYY-MM-DD in `timezone`. */
  date: string;
  /** IANA timezone the date is interpreted in. */
  timezone: string;
  /** Opaque pagination cursor from a previous page, when paging. */
  cursor?: string | null;
  /** Abort signal for the underlying HTTP requests. */
  signal?: AbortSignal;
}

/** One page of conversations from a connector. */
export interface WearableFetchPage {
  conversations: WearableConversation[];
  /** Cursor for the next page, or null when exhausted. */
  nextCursor: string | null;
}

/**
 * A "native memory" is a fact the provider's own pipeline extracted
 * (Bee facts, Omi memories). Importing these is optional and always
 * lands them in the review queue — provider extraction quality is
 * outside Remnic's control.
 */
export interface WearableNativeMemory {
  id: string;
  content: string;
  createdIso?: string;
  tags?: string[];
}

export interface WearableNativeMemoryPage {
  memories: WearableNativeMemory[];
  nextCursor: string | null;
}

/** Result of a connector auth probe. */
export interface WearableAuthCheck {
  ok: boolean;
  /** Short human-readable detail (never includes credentials). */
  detail?: string;
}

/**
 * Contract implemented by provider connector packages.
 *
 * Connectors are pure API clients + normalizers: no file IO, no memory
 * writes, no config parsing beyond their own settings object. All
 * pipeline behavior stays in core so every source benefits from the
 * same cleanup, corrections, and trust gating.
 */
export interface WearableSourceConnector {
  /** Stable connector id ("limitless" | "bee" | "omi" | custom). */
  id: string;
  /** Human-readable provider name for status output. */
  displayName: string;
  /** Probe credentials/connectivity without mutating anything. */
  verifyAuth(signal?: AbortSignal): Promise<WearableAuthCheck>;
  /** Fetch one page of conversations for a single day window. */
  fetchConversations(opts: WearableFetchOptions): Promise<WearableFetchPage>;
  /**
   * Fetch one page of provider-extracted memories. Optional — only
   * connectors whose provider exposes such a surface implement it.
   */
  fetchNativeMemories?(opts: {
    cursor?: string | null;
    signal?: AbortSignal;
  }): Promise<WearableNativeMemoryPage>;
}

/** Per-source settings handed to a connector factory (parsed config). */
export interface WearableSourceSettings {
  /** Master gate for this source. */
  enabled: boolean;
  /**
   * Credential for the provider API. Prefer the per-connector
   * environment variable (see each connector's README); the config
   * value takes precedence when both are set.
   */
  apiKey?: string;
  /** Override the provider base URL (self-hosted / proxy setups). */
  baseUrl?: string;
  /** Omi: integration app id (the `{app_id}` path component). */
  appId?: string;
  /** Omi: target user id (`uid` query parameter). */
  userId?: string;
  /**
   * Memory creation mode (trust gate):
   *  - "smart":  DEFAULT. Fully automated trust pipeline: the
   *              extraction judge (LLM-as-judge) plus a per-source
   *              trust prior, cross-device corroboration, and
   *              existing-memory support combine into a trust score.
   *              High-trust facts are written active; borderline facts
   *              go to the review queue; low-trust/judge-rejected
   *              facts are dropped. See wearables/trust.ts.
   *  - "off":    transcripts only; never create memories.
   *  - "review": every extracted candidate is written
   *              "pending_review" — nothing enters active recall
   *              without operator approval.
   *  - "auto":   deterministic gates only; survivors written active
   *              (no judge, no trust scoring).
   */
  memoryMode: WearableMemoryMode;
  /**
   * Trust prior for this source's transcription quality (0..1).
   * Multiplies extraction confidence in smart mode — lower it for a
   * device that mis-transcribes often. Default 0.8.
   */
  sourceTrust: number;
  /** Smart mode: trust at/above which facts are written active. */
  autoApproveTrust: number;
  /**
   * Smart mode: trust at/above which borderline facts are queued for
   * review instead of dropped. Must be below autoApproveTrust.
   */
  reviewTrust: number;
  /** Drop extracted facts below this confidence (0–1). */
  minConfidence: number;
  /** Drop extracted facts scored below this importance level. */
  minImportance: ImportanceLevel;
  /**
   * Cap on memories created per source per day. 0 (the default)
   * disables the cap — the smart trust pipeline is the quality gate,
   * and a count cap would drop real memories on busy days.
   */
  maxMemoriesPerDay: number;
  /**
   * Import provider-extracted memories (Bee facts / Omi memories).
   *  - "smart": DEFAULT. Same trust pipeline as transcript facts
   *    (judge + trust prior + corroboration) with a slightly reduced
   *    prior — provider extraction quality is outside Remnic's
   *    control.
   *  - "review": always pending_review.
   *  - "off": skip.
   */
  importNativeMemories: "off" | "review" | "smart";
  /** Transcript cleanup toggles. */
  cleanup: WearableCleanupSettings;
}

export type WearableMemoryMode = "off" | "review" | "auto" | "smart";

export interface WearableCleanupSettings {
  /** Merge consecutive segments from the same speaker. */
  mergeSameSpeaker: boolean;
  /** Strip standalone filler tokens (um, uh, ...). */
  stripFillers: boolean;
  /** Collapse immediately repeated phrases (ASR stutter). */
  collapseRepeats: boolean;
  /**
   * Drop segments that look like ASR garbage (very low word ratio,
   * long single-character runs). Dropped segments are counted in the
   * sync summary and excluded from memory extraction.
   */
  dropLowQuality: boolean;
  /**
   * Keep utterance-level boundaries for segments whose speaker label
   * carries no real diarization signal (generic labels like "Unknown"
   * or empty). When `mergeSameSpeaker` is also on, such segments are
   * left distinct instead of collapsing into one block — a whole
   * conversation of per-utterance text under a single generic label
   * otherwise merges into one mega-segment (issue #1811). Sources whose
   * provider emits reliable per-utterance text but unreliable speaker
   * labels (Bee) default this on; others default off so existing merge
   * behavior is unchanged unless explicitly configured.
   */
  preserveUtteranceBoundaries?: boolean;
}

/** A single user-specific transcript correction rule. */
export interface WearableCorrectionRule {
  /** Text (or regex when `regex` is true) to match. */
  match: string;
  /** Replacement text. */
  replace: string;
  /** Treat `match` as a regular expression. Default false (literal). */
  regex?: boolean;
  /** Case-insensitive matching. Default true. */
  caseInsensitive?: boolean;
  /**
   * Restrict the rule to specific source ids. Omit to apply to all
   * sources.
   */
  sources?: string[];
}

/**
 * Off-the-record marker configuration (issue #2196). Matching is
 * case-insensitive and phrase-level. Built-in phrases stay active
 * unless `useBuiltIns` is false.
 */
export interface OffTheRecordMarkerSettings {
  /** Extra phrases that begin an off-the-record span. */
  start: string[];
  /** Extra phrases that end an off-the-record span. */
  end: string[];
  /** Include the built-in phrase lists. Default true. */
  useBuiltIns: boolean;
}

/** Top-level wearables configuration (parsed). */
export interface WearablesConfig {
  /** Master gate for the whole subsystem. Default false. */
  enabled: boolean;
  /**
   * IANA timezone used to bucket transcripts into days. Defaults to
   * the host timezone at runtime when unset.
   */
  timezone?: string;
  /** Built-in PII redaction (SSN / payment-card patterns). Default true. */
  redactionEnabled: boolean;
  /** Additional user-supplied redaction regexes (validated at parse). */
  redactionPatterns: string[];
  /**
   * Honor a spoken "off the record" marker by dropping segments until
   * "back on the record" (or conversation end). Default false.
   */
  offTheRecordEnabled: boolean;
  /**
   * Off-the-record marker phrases (issue #2196). Built-in phrases cover
   * a documented set of languages; `start`/`end` add more, and
   * `useBuiltIns: false` uses only the configured phrases.
   */
  offTheRecordMarkers: OffTheRecordMarkerSettings;
  /**
   * Extra filler tokens removed when a source enables
   * `cleanup.stripFillers`. Built-in tokens are selected per script; a
   * language outside that set is configured here.
   */
  fillerTokens: string[];
  /**
   * Write one compact daily-digest memory per synced source/day.
   * Default false.
   */
  digestEnabled: boolean;
  /**
   * Periodically refresh transcripts in-process (long-lived hosts).
   * Every tick re-syncs `autoSyncDays` ending today — existing day
   * files included, so the current day keeps growing while the
   * wearable records. Default true.
   */
  autoSyncEnabled: boolean;
  /** Minutes between auto-sync ticks (1-1440). Default 15. */
  autoSyncIntervalMinutes: number;
  /** Rolling window (days ending today) per tick (1-90). Default 2. */
  autoSyncDays: number;
  /**
   * Once-per-local-day deep pass window (days, 0-90) picking up late
   * uploads and provider re-processing. 0 disables; otherwise must be
   * >= autoSyncDays. Default 7.
   */
  autoSyncDeepDays: number;
  /** Correction rules from config (merged with CLI-managed rules). */
  corrections: WearableCorrectionRule[];
  /** Per-source settings, keyed by connector id. */
  sources: Record<string, WearableSourceSettings>;
  /**
   * Cross-source fusion settings (issue #1810). Default disabled —
   * enabling it is the only behavior change fusion introduces.
   */
  fusion: WearableFusionConfig;
}

/**
 * Cross-source fusion configuration (issue #1810). When disabled (the
 * default), no fusion artifacts are written and no behavior changes.
 */
export interface WearableFusionConfig {
  /** Master gate for fusion. Default false. */
  enabled: boolean;
  /**
   * Max gap (ms) between two conversations to merge into one fused
   * cluster. Default 300000 (5 minutes).
   */
  proximityGapMs: number;
  /**
   * Max drift (ms) for two segments to align across sources. Default
   * 30000 (30 seconds).
   */
  windowToleranceMs: number;
}

/** Summary returned by a sync run (one source). */
export interface WearableSyncSummary {
  source: string;
  /** Days that were synced (YYYY-MM-DD). */
  days: string[];
  conversations: number;
  segmentsKept: number;
  segmentsDropped: number;
  redactions: number;
  correctionsApplied: number;
  /** Day files written (skipped-unchanged days are not listed). */
  transcriptsWritten: string[];
  memoriesCreated: number;
  /** Earlier borderline writes promoted to active by new evidence. */
  memoriesPromoted: number;
  /** Earlier pending writes retired by a fresh judge-reject verdict. */
  memoriesDemoted: number;
  memoriesSkipped: number;
  /**
   * Writes the #1579 tombstone chokepoint downgraded to pending_review
   * (no active copy) — both wearable extraction and native imports.
   * Surfaced distinctly so sync summaries/CLI don't count blocked content
   * as successfully created (#1645).
   */
  memoriesBlocked: number;
  nativeMemoriesImported: number;
  /** Non-fatal warnings surfaced to the operator. */
  warnings: string[];
}

/** Frontmatter persisted on a day-transcript file. */
export interface WearableDayTranscriptMeta {
  kind: "wearable-transcript";
  source: string;
  date: string;
  timezone: string;
  conversationCount: number;
  segmentCount: number;
  speakers: string[];
  durationMinutes: number;
  /** SHA-256 of the body — used to skip unchanged rewrites. */
  contentHash: string;
  syncedAt: string;
  /**
   * Body serialization format version. Present (>= 2) only on bodies written
   * by the escape-aware serializer; absent on legacy transcripts. Decoders
   * gate on this so a legacy body's literal two-character `\n`/`\r` is never
   * altered (issue #1849).
   */
  formatVersion?: number;
}

/** A parsed day-transcript file. */
export interface WearableDayTranscript {
  meta: WearableDayTranscriptMeta;
  body: string;
}

/** Status snapshot for one configured source. */
export interface WearableSourceStatus {
  source: string;
  displayName: string;
  enabled: boolean;
  connectorInstalled: boolean;
  memoryMode: WearableMemoryMode;
  lastSyncAt: string | null;
  lastDateSynced: string | null;
  transcriptDays: number;
}
