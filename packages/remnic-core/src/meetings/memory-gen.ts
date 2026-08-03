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
import { composeMemoryEnvelope } from "../write-envelope.js";
import { log } from "../logger.js";
import { stripAttributesSuffix } from "../structured-attributes.js";
import type { MemoryWriteResult } from "../index.js";
import type { MemoryCategory, MemoryStatus } from "../types.js";
import {
  type MeetingEpisodeGenResult,
  type MeetingMemoryGenerator,
  type MeetingMemoryOutcome,
  type MeetingMemoryWriter,
  type MeetingsDayFactGenResult,
} from "./memory-generator.js";
import { computeTrustScore, decideSmart, type TrustEvidence } from "../wearables/trust.js";
import { isHighImpactPersonalFact } from "../ambient-provenance.js";
import { describeErrorForOperator } from "../wearables/errors.js";
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
 * written. The episode is `active` (a recall anchor, not a trust-gated claim)
 * UNLESS its provider-derived title is itself a personal claim — that title
 * comes from the same ambient audio the summary layer already guards, so it
 * gets the same treatment rather than riding in on the anchor (#2294).
 */
export async function writeMeetingEpisodeMemory(
  record: MeetingRecord,
  writer: MeetingMemoryWriter,
): Promise<boolean> {
  const content = composeMeetingEpisodeContent(record);
  if (await writer.hasMemoryFromSource(meetingSourceLabel(record.id), content)) return false;

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
  // Only the title is provider-derived; the rest of the episode is our own
  // deterministic rendering (id, clock, attendees, sources), so the classifier
  // reads the title alone and does not trip on our own wording.
  const titleIsPersonalClaim =
    record.title !== undefined &&
    record.title.length > 0 &&
    isHighImpactPersonalFact({ category: "fact", content: record.title });
  await writer.writeSealedMemory(envelope, {
    importance: scoreImportance(content, "moment", [MEETING_SOURCE_PREFIX]),
    contentHashSource: content,
    status: titleIsPersonalClaim ? "pending_review" : "active",
    memoryKind: "episode",
  });
  return true;
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
  /** Candidates/summary skipped because an identical memory already existed
   *  for this meeting (idempotent rebuild). */
  skipped: number;
  /** True when a non-empty summary memory was written. */
  summaryWritten: boolean;
  /** Facts the #1579 tombstone chokepoint downgraded to pending_review (no
   *  active copy). Counted here, NOT in `active`/`review`, so callers never
   *  report a blocked write as a successfully written fact (#1645). */
  tombstoneBlocked: number;
  /** Non-fatal degradation notes (e.g. the durability judge threw and the
   *  pass continued on trust bands alone). */
  warnings: readonly string[];
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
): Promise<MemoryWriteResult> {
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
  return writer.writeSealedMemory(envelope, {
    importance: scoreImportance(candidate.content, candidate.category, [MEETING_SOURCE_PREFIX]),
    contentHashSource: candidate.content,
    status,
    memoryKind: "note",
  });
}

/** Confidence assigned to the synthesized meeting-summary fact. */
const SUMMARY_FACT_CONFIDENCE = 0.8;

/**
 * Route one meeting claim (candidate or the synthesized summary) to active /
 * review / drop through the SAME trust decision. `review` mode never
 * auto-actives (queue everything survivable); `smart` mode uses the shared
 * band decision. A judge reject drops in both. Used for BOTH the extracted
 * candidates and the summary text so a rejected/low-trust meeting can never
 * push its summary active behind the gate's back.
 */
function resolveMeetingFactOutcome(
  config: MeetingsConfig,
  trust: number,
  judgeVerdict: "accept" | "reject" | "defer" | undefined,
  claim: { category: string; content: string },
): "active" | "review" | "drop" {
  if (config.summaryMode === "review") {
    return judgeVerdict === "reject" ? "drop" : "review";
  }
  // A meeting transcript is the same always-on capture audio a wearable
  // records, so it carries the same contamination risk — and the extractor
  // hands decisions and commitments a fixed 0.8 confidence, which clears the
  // default band on a judge accept alone. A high-impact personal claim tops
  // out in the review queue here too (#2294).
  return decideSmart(
    trust,
    judgeVerdict,
    { autoApproveTrust: config.autoApproveTrust, reviewTrust: config.reviewTrust },
    { capAtReview: isHighImpactPersonalFact(claim) },
  ).outcome;
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
    skipped: 0,
    summaryWritten: false,
    tombstoneBlocked: 0,
    warnings: [],
  };
  if (config.summaryMode === "off") return empty;
  if (record.transcript.length === 0) return empty; // nothing to summarize (no audio)

  const { summary, candidates } = await deps.extractor.extract({
    record,
    transcriptText: renderTranscriptText(record),
    screenContextText: renderScreenContextText(record),
  });
  const warnings: string[] = [];
  const result: MeetingSummaryResult = { ...empty, llmInvoked: true, warnings };

  // The durability judge is optional and external — a throw (provider outage,
  // timeout, malformed response) must DEGRADE this pass, not abort the whole day
  // build. Fall back to no verdicts so the trust bands still route each candidate
  // (review mode → review; smart mode → trust-band decision) (#1900 round 2).
  let verdicts: Array<"accept" | "reject" | "defer"> | undefined;
  if (deps.judge) {
    try {
      verdicts = await deps.judge.judge(candidates);
    } catch (err) {
      warnings.push(
        `meeting summary judge unavailable: ${describeErrorForOperator(err)} — trust scoring continued without judge verdicts`,
      );
    }
  }
  // Corroboration: a meeting covered by >= 2 transcript sources corroborates its
  // claims (record.corroboratedBy already lists the out-voted sources).
  const evidence: TrustEvidence = { corroboratedBySources: [...record.corroboratedBy] };

  const source = meetingSourceLabel(record.id);
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const judgeVerdict = verdicts?.[i];
    // Idempotent rebuild: an identical claim already persisted for THIS meeting
    // must not be written a second time (facts are not in the fact-hash index).
    if (await deps.writer.hasMemoryFromSource(source, candidate.content)) {
      result.skipped++;
      continue;
    }
    const trust = computeTrustScore({
      extractionConfidence: candidate.confidence,
      sourceTrust: config.sourceTrust,
      judgeVerdict,
      evidence,
    });
    const outcome = resolveMeetingFactOutcome(config, trust, judgeVerdict, candidate);
    if (outcome === "drop") {
      result.dropped++;
      continue;
    }
    const status = outcome === "active" ? "active" : "pending_review";
    const write = await writeMeetingFact(record, candidate, status, deps.writer);
    if (write.tombstoneBlocked) {
      // #1645: the tombstone chokepoint downgraded this fact to pending_review
      // (no active copy). Count it as blocked, NEVER as the active/review write
      // we requested, so the day summary never overstates persisted facts.
      result.tombstoneBlocked++;
    } else if (status === "active") {
      result.active++;
    } else {
      result.review++;
    }
  }

  // The synthesized summary is a meeting claim too: gate it through the SAME
  // trust decision so a meeting whose candidates were all rejected / below the
  // bar cannot slip its summary in as an active fact (it was force-active before).
  const summaryText = summary.trim();
  if (summaryText.length > 0) {
    if (await deps.writer.hasMemoryFromSource(source, summaryText)) {
      result.skipped++;
    } else {
      const summaryTrust = computeTrustScore({
        extractionConfidence: SUMMARY_FACT_CONFIDENCE,
        sourceTrust: config.sourceTrust,
        evidence,
      });
      const outcome = resolveMeetingFactOutcome(config, summaryTrust, undefined, {
        category: "fact",
        content: summaryText,
      });
      if (outcome === "drop") {
        result.dropped++;
      } else {
        const write = await writeMeetingFact(
          record,
          { content: summaryText, category: "fact", confidence: SUMMARY_FACT_CONFIDENCE },
          outcome === "active" ? "active" : "pending_review",
          deps.writer,
        );
        // #1645: a tombstone-blocked summary landed pending_review (no active
        // copy) — record it as blocked, not as a written summary, so the day
        // aggregate never reports a summary that was actually gated out.
        if (write.tombstoneBlocked) result.tombstoneBlocked++;
        else result.summaryWritten = true;
      }
    }
  }
  return result;
}

/**
 * Storage capabilities `createMeetingMemoryWriter` needs, satisfied structurally
 * by `StorageManager`. Kept narrow (the same rationale as the wearables writer)
 * so this module performs NO direct fs and never touches the secure-store key.
 */
export interface MeetingMemoryStorageIo {
  writeSealedMemory: MeetingMemoryWriter["writeSealedMemory"];
  readAllMemories(): Promise<
    Array<{
      path: string;
      frontmatter: { id: string; source: string; status?: string };
      content: string;
    }>
  >;
  invalidateMemory(id: string): Promise<boolean>;
}

/**
 * Build the meeting memory writer used by production builds. Mirrors
 * `createWearableMemoryWriter`: the storage fact-hash index only covers
 * category "fact", so meeting episodes (`moment`) and decisions/commitments
 * dedup by a bounded, source-scoped content scan over `meeting:<id>`-tagged
 * memories — without it, a forced/retried day re-writes identical episodes and
 * facts (issue #1900).
 */
export function createMeetingMemoryWriter(storage: MeetingMemoryStorageIo): MeetingMemoryWriter {
  return {
    writeSealedMemory: storage.writeSealedMemory.bind(storage),
    hasMemoryFromSource: async (source: string, content: string): Promise<boolean> => {
      // Stored bodies carry the "[Attributes: ...]" enrichment suffix; callers
      // pass raw text — strip on BOTH sides so attribute-bearing memories match.
      const needle = stripAttributesSuffix(content);
      const memories = await storage.readAllMemories();
      return memories.some(
        (memory) =>
          memory.frontmatter.source === source &&
          memory.frontmatter.status !== "rejected" &&
          stripAttributesSuffix(memory.content) === needle,
      );
    },
    retireMemoriesFromSource: async (source: string): Promise<number> => {
      const memories = await storage.readAllMemories();
      let retired = 0;
      for (const memory of memories) {
        if (memory.frontmatter.source !== source) continue;
        if (await storage.invalidateMemory(memory.frontmatter.id)) retired++;
      }
      return retired;
    },
  };
}

/**
 * Fold the per-record trust-gated summary/fact results into one day aggregate.
 * The deterministic builder used to own this loop; it now lives behind the
 * memory seam so the engine never calls `generateMeetingSummaryFacts`.
 */
async function generateMeetingDayFacts(
  records: readonly MeetingRecord[],
  config: MeetingsConfig,
  writer: MeetingMemoryWriter,
  summaryDeps: { extractor: MeetingSummaryExtractor; judge?: MeetingSummaryJudge },
  warnings: string[],
): Promise<MeetingsDayFactGenResult> {
  const agg: MeetingsDayFactGenResult = {
    llmInvoked: false,
    active: 0,
    review: 0,
    dropped: 0,
    skipped: 0,
    summariesWritten: 0,
  };
  for (const record of records) {
    const result = await generateMeetingSummaryFacts(record, config, {
      extractor: summaryDeps.extractor,
      ...(summaryDeps.judge !== undefined ? { judge: summaryDeps.judge } : {}),
      writer,
    });
    if (result.llmInvoked) agg.llmInvoked = true;
    agg.active += result.active;
    agg.review += result.review;
    agg.dropped += result.dropped;
    agg.skipped += result.skipped;
    if (result.summaryWritten) agg.summariesWritten++;
    if (result.tombstoneBlocked > 0) {
      agg.tombstoneBlocked = (agg.tombstoneBlocked ?? 0) + result.tombstoneBlocked;
    }
    if (result.warnings.length > 0) warnings.push(...result.warnings);
  }
  return agg;
}

/**
 * Concrete `MeetingMemoryGenerator` for the builder's memory seam (issue #1900
 * decouple). Implements `onRecordsBuilt` by driving the EXISTING episode/fact/
 * retract logic behind the interface the deterministic engine depends on, and
 * routes each built id by the partition the engine computed from the store's
 * per-record write result (round 2):
 *
 * - `removedIds` — retire the deleted meetings' memories so recall never
 *   surfaces a meeting `show <id>` can no longer load;
 * - `updatedIds` — the record changed under a kept id: retract the prior
 *   episode/summary for `meeting:<id>` FIRST, then regenerate from the new
 *   record, so recall is refreshed (not duplicated, not left stale);
 * - `unchangedIds` — the stored record was byte-identical this rebuild: SKIP
 *   all generation for it (no episode probe, no extractor call, no rewrite) so
 *   an idempotent rebuild fires zero LLM calls and writes nothing;
 * - new ids (built minus unchanged minus updated) — generate fresh.
 *
 * `reindexNeeded` fires when the regenerated records wrote new episodes/facts;
 * the builder additionally reindexes on removed/built counts, so a retract-only
 * rebuild still reindexes.
 *
 * `config` is captured here (not passed through `onRecordsBuilt`) because the
 * seam input carries record partitions, while the summary/facts layer needs
 * `summaryMode` and the trust bands.
 */
export function createMeetingMemoryGenerator(
  writer: MeetingMemoryWriter,
  config: MeetingsConfig,
  summaryDeps?: { extractor: MeetingSummaryExtractor; judge?: MeetingSummaryJudge },
): MeetingMemoryGenerator {
  return {
    async onRecordsBuilt({ built, removedIds, unchangedIds, updatedIds }): Promise<MeetingMemoryOutcome> {
      // Retract deleted meetings' memories (stale removals).
      for (const removedId of removedIds) {
        await writer.retireMemoriesFromSource(meetingSourceLabel(removedId));
      }
      // Retract the prior memories of records that changed under a kept id, so the
      // regeneration below REFRESHES the meeting (never leaves stale episodes/facts
      // beside the new ones). The updated records are still in `built` and regenerate.
      for (const updatedId of updatedIds) {
        await writer.retireMemoriesFromSource(meetingSourceLabel(updatedId));
      }
      // Generate changed + new records always. An unchanged record regenerates ONLY
      // when its deterministic episode memory is ABSENT: a prior build persisted the
      // record but its generation threw before the memories landed, so the store now
      // reports the record in unchangedIds (contentHash identical) and a plain skip
      // would strand the meeting with zero memories forever. "Unchanged" means skip
      // only when the memories already exist. The episode is the sentinel — it is
      // always written first (deterministic, no LLM), so an absent episode means the
      // source is unwritten. Unchanged records whose episode already exists still skip,
      // so an idempotent rebuild fires zero LLM calls and writes nothing.
      const unchanged = new Set(unchangedIds);
      const toGenerate: MeetingRecord[] = [];
      for (const record of built) {
        if (!unchanged.has(record.id)) {
          toGenerate.push(record);
          continue;
        }
        const episodePresent = await writer.hasMemoryFromSource(
          meetingSourceLabel(record.id),
          composeMeetingEpisodeContent(record),
        );
        if (!episodePresent) toGenerate.push(record);
      }
      const warnings: string[] = [];
      const outcome: MeetingMemoryOutcome = { reindexNeeded: false, warnings };
      if (toGenerate.length > 0) {
        outcome.episodes = await generateMeetingEpisodes(toGenerate, writer);
        if (summaryDeps !== undefined && config.summaryMode !== "off") {
          outcome.facts = await generateMeetingDayFacts(toGenerate, config, writer, summaryDeps, warnings);
        }
      }
      const episodesWrote = (outcome.episodes?.written ?? 0) > 0;
      const factsWrote =
        outcome.facts !== undefined &&
        outcome.facts.active + outcome.facts.review + outcome.facts.summariesWritten > 0;
      outcome.reindexNeeded = episodesWrote || factsWrote;
      return outcome;
    },
  };
}
