/**
 * Meeting memory generation (issue #1900, Phase 4).
 *
 * Layer 1 — the deterministic meeting EPISODE: one recall-anchor memory per
 * meeting ("what meetings did I have Tuesday?"), always written when
 * `meetings.enabled`, no LLM. Title, time span, attendees, and source list are
 * a pure function of the record, so an unchanged meeting is skipped by content
 * hash. Reuses the shared sealed-envelope composer + secure write path
 * (`composeMemoryEnvelope` / `writeSealedMemory`) — no bespoke memory format.
 *
 * The LLM summary/facts layer (decisions + commitments through the existing
 * trust pipeline) builds on this module in the trust-gated slice; it reuses the
 * same writer interface and the wearables judge/trust machinery rather than
 * forking it.
 */

import { scoreImportance } from "../importance.js";
import type { MemoryWriteResult } from "../index.js";
import {
  composeMemoryEnvelope,
  type SealedMemoryEnvelope,
} from "../write-envelope.js";
import { log } from "../logger.js";
import type { ImportanceScore, MemoryCategory, MemoryStatus } from "../types.js";
import { computeTrustScore, decideSmart, type TrustEvidence } from "../wearables/trust.js";
import type { MeetingRecord, MeetingsConfig } from "./types.js";

/** Frontmatter `source` prefix for meeting-derived memories. */
export const MEETING_SOURCE_PREFIX = "meeting";
/** `source: meeting:<id>` — walks memory → record → day transcripts. */
export function meetingSourceLabel(id: string): string {
  return `${MEETING_SOURCE_PREFIX}:${id}`;
}
/** `meeting-day:<date>` tag for day-scoped recall ("meetings on Tuesday"). */
export function meetingDayTag(date: string): string {
  return `meeting-day:${date}`;
}

/**
 * Narrow writer interface satisfied by `StorageManager` — the same sealed
 * write entry point the wearables generator uses, so meeting memories inherit
 * encrypted-at-rest + atomic write + dedup without this module knowing the key.
 */
export interface MeetingMemoryWriter {
  writeSealedMemory(
    envelope: SealedMemoryEnvelope,
    extras: {
      importance?: ImportanceScore;
      contentHashSource?: string;
      status?: MemoryStatus;
      memoryKind?: "episode" | "note" | "box" | "dream" | "procedural";
    },
  ): Promise<MemoryWriteResult>;
  /** True when a memory with this exact content already exists (idempotency). */
  hasFactContentHash(content: string): Promise<boolean>;
}

/** Render the deterministic episode content for a meeting. Pure. */
export function composeMeetingEpisodeContent(record: MeetingRecord): string {
  const clock = (iso: string): string => {
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? iso : new Date(ms).toISOString().slice(11, 16);
  };
  const app = record.app !== undefined && record.app.length > 0 ? ` (${record.app})` : "";
  const title = record.title !== undefined && record.title.length > 0 ? ` · ${record.title}` : "";
  const attendees = record.attendees.length > 0 ? record.attendees.join(", ") : "no attendees resolved";
  const sources = record.sources.length > 0 ? record.sources.join(", ") : "none";
  return (
    `Meeting ${record.id}${title} — ${record.date} ${clock(record.startUtc)}–${clock(record.endUtc)} UTC${app}.\n` +
    `Attendees: ${attendees}.\n` +
    `Transcript sources: ${sources}.`
  );
}

/**
 * Write the deterministic episode memory for one meeting. Idempotent: skips
 * when an identical episode already exists. Returns true when a new episode was
 * written. The episode is `active` (a recall anchor, not a trust-gated claim).
 */
export async function writeMeetingEpisodeMemory(
  record: MeetingRecord,
  writer: MeetingMemoryWriter,
): Promise<boolean> {
  const content = composeMeetingEpisodeContent(record);
  if (await writer.hasFactContentHash(content)) return false;

  const structuredAttributes: Record<string, string> = {
    meetingId: record.id,
    meetingDate: record.date,
    transcriptSources: record.sources.join(","),
  };
  if (record.app !== undefined) structuredAttributes.meetingApp = record.app;

  const envelope = composeMemoryEnvelope(
    {
      content,
      category: "moment",
      confidence: 0.9,
      tags: [MEETING_SOURCE_PREFIX, meetingDayTag(record.date)],
      validAt: record.startUtc,
      structuredAttributes,
    },
    { source: meetingSourceLabel(record.id) },
    { salvage: true },
  );
  if (envelope.salvageNotes.length > 0) {
    log.warn(`meeting episode write salvaged invalid fields: ${envelope.salvageNotes.join("; ")}`);
  }
  await writer.writeSealedMemory(envelope, {
    importance: scoreImportance(content, "moment", [MEETING_SOURCE_PREFIX]),
    contentHashSource: content,
    status: "active",
    memoryKind: "episode",
  });
  return true;
}

/** Result of generating episode memories for a day's meetings. */
export interface MeetingEpisodeGenResult {
  /** Episodes newly written. */
  written: number;
  /** Episodes skipped because an identical one already existed. */
  skipped: number;
}

/** Write one deterministic episode per record, idempotently. */
export async function generateMeetingEpisodes(
  records: readonly MeetingRecord[],
  writer: MeetingMemoryWriter,
): Promise<MeetingEpisodeGenResult> {
  let written = 0;
  let skipped = 0;
  for (const record of records) {
    if (await writeMeetingEpisodeMemory(record, writer)) written++;
    else skipped++;
  }
  return { written, skipped };
}

// ---------------------------------------------------------------------------
// Layer 2 — trust-gated LLM summary + facts (decisions, commitments, questions)
// ---------------------------------------------------------------------------

/** One LLM-extracted meeting claim. */
export interface MeetingFactCandidate {
  /** Claim text (a decision, commitment, or open question). */
  content: string;
  /** Memory category — commitments carry the decay-aware `commitment` category. */
  category: Extract<MemoryCategory, "fact" | "decision" | "commitment">;
  /** Extractor confidence (0..1); defaults to 0.7 downstream when absent. */
  confidence?: number;
}

/** LLM extractor over a meeting's fused transcript + screen context. Injected so
 *  `off` mode provably never invokes it and tests stay deterministic. */
export interface MeetingSummaryExtractor {
  extract(input: {
    record: MeetingRecord;
    transcriptText: string;
    screenContextText: string;
  }): Promise<{ summary: string; candidates: MeetingFactCandidate[] }>;
}

/** Optional durability judge; verdicts align with the shared trust pipeline. */
export interface MeetingSummaryJudge {
  judge(candidates: readonly MeetingFactCandidate[]): Promise<Array<"accept" | "reject" | "defer">>;
}

export interface MeetingSummaryDeps {
  extractor: MeetingSummaryExtractor;
  judge?: MeetingSummaryJudge;
  writer: MeetingMemoryWriter;
}

export interface MeetingSummaryResult {
  /** False when summaryMode is `off` (the extractor is never called). */
  llmInvoked: boolean;
  /** Facts written active. */
  active: number;
  /** Facts written to the review queue (pending_review). */
  review: number;
  /** Candidates dropped below the trust bar or judge-rejected. */
  dropped: number;
  /** True when a non-empty summary memory was written. */
  summaryWritten: boolean;
}

/** Render the fused transcript as `**Speaker** [HH:MM]: text` for the prompt. */
function renderTranscriptText(record: MeetingRecord): string {
  return record.transcript
    .map((seg) => {
      const ms = seg.startIso === undefined ? NaN : Date.parse(seg.startIso);
      const clock = Number.isNaN(ms) ? "--:--" : new Date(ms).toISOString().slice(11, 16);
      return `**${seg.speaker}** [${clock}]: ${seg.text}`;
    })
    .join("\n");
}

/** Render the screen-context timeline + excerpts for the prompt. */
function renderScreenContextText(record: MeetingRecord): string {
  const lines = record.screenContext.map((e) => `[${e.clock}] ${e.label}`);
  if (record.contextExcerpts.length > 0) lines.push(...record.contextExcerpts);
  return lines.join("\n");
}

async function writeMeetingFact(
  record: MeetingRecord,
  candidate: MeetingFactCandidate,
  status: Extract<MemoryStatus, "active" | "pending_review">,
  writer: MeetingMemoryWriter,
): Promise<void> {
  const structuredAttributes: Record<string, string> = {
    meetingId: record.id,
    meetingDate: record.date,
    transcriptSources: record.sources.join(","),
  };
  if (record.app !== undefined) structuredAttributes.meetingApp = record.app;
  const envelope = composeMemoryEnvelope(
    {
      content: candidate.content,
      category: candidate.category,
      confidence: candidate.confidence,
      tags: [MEETING_SOURCE_PREFIX, meetingDayTag(record.date), candidate.category],
      validAt: record.startUtc,
      structuredAttributes,
    },
    { source: meetingSourceLabel(record.id) },
    { salvage: true },
  );
  if (envelope.salvageNotes.length > 0) {
    log.warn(`meeting fact write salvaged invalid fields: ${envelope.salvageNotes.join("; ")}`);
  }
  await writer.writeSealedMemory(envelope, {
    importance: scoreImportance(candidate.content, candidate.category, [MEETING_SOURCE_PREFIX]),
    contentHashSource: candidate.content,
    status,
    memoryKind: "note",
  });
}

/**
 * Layer 2: extract a trust-gated summary + facts (decisions/commitments/open
 * questions) for one meeting and persist the survivors. Reuses the shared trust
 * pipeline (`computeTrustScore` + `decideSmart`), NOT a parallel scorer.
 *
 * - `off`   → returns immediately; the extractor is NEVER invoked (episode-only).
 * - `review`→ every candidate lands in the review queue (pending_review).
 * - `smart` → judge verdict + trust bands route each candidate to active /
 *   review / drop; corroboration (>= 2 transcript sources) boosts trust.
 */
export async function generateMeetingSummaryFacts(
  record: MeetingRecord,
  config: MeetingsConfig,
  deps: MeetingSummaryDeps,
): Promise<MeetingSummaryResult> {
  const empty: MeetingSummaryResult = {
    llmInvoked: false,
    active: 0,
    review: 0,
    dropped: 0,
    summaryWritten: false,
  };
  if (config.summaryMode === "off") return empty;
  if (record.transcript.length === 0) return empty; // nothing to summarize (no audio)

  const { summary, candidates } = await deps.extractor.extract({
    record,
    transcriptText: renderTranscriptText(record),
    screenContextText: renderScreenContextText(record),
  });
  const result: MeetingSummaryResult = { ...empty, llmInvoked: true };

  const verdicts = deps.judge ? await deps.judge.judge(candidates) : undefined;
  // Corroboration: a meeting covered by >= 2 transcript sources corroborates its
  // claims (record.corroboratedBy already lists the out-voted sources).
  const evidence: TrustEvidence = { corroboratedBySources: [...record.corroboratedBy] };

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const judgeVerdict = verdicts?.[i];
    const trust = computeTrustScore({
      extractionConfidence: candidate.confidence,
      sourceTrust: config.sourceTrust,
      judgeVerdict,
      evidence,
    });
    // review mode: everything to the queue (never auto-active). smart mode: the
    // shared band decision. A judge reject drops in both.
    const decision =
      config.summaryMode === "review"
        ? judgeVerdict === "reject"
          ? { outcome: "drop" as const }
          : { outcome: "review" as const }
        : decideSmart(trust, judgeVerdict, {
            autoApproveTrust: config.autoApproveTrust,
            reviewTrust: config.reviewTrust,
          });
    if (decision.outcome === "drop") {
      result.dropped++;
      continue;
    }
    const status = decision.outcome === "active" ? "active" : "pending_review";
    await writeMeetingFact(record, candidate, status, deps.writer);
    if (status === "active") result.active++;
    else result.review++;
  }

  const summaryText = summary.trim();
  if (summaryText.length > 0 && !(await deps.writer.hasFactContentHash(summaryText))) {
    const status = config.summaryMode === "review" ? "pending_review" : "active";
    await writeMeetingFact(
      record,
      { content: summaryText, category: "fact", confidence: 0.8 },
      status,
      deps.writer,
    );
    result.summaryWritten = true;
  }
  return result;
}
