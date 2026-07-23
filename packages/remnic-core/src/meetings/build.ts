/**
 * Meeting building orchestration (issue #1900, Phase 4 slice 2).
 *
 * Ties the pure pieces together: detect the day's meetings, fuse each window's
 * transcript + screen context, and compose idempotent records. Day data is
 * supplied through an injected source so fixtures (and the later activity/
 * wearables wiring) share one code path — no hidden IO here.
 *
 * Gated on `meetings.enabled`: a disabled subsystem builds nothing on every
 * surface (degradation-matrix row). Degrades within an enabled build too — a
 * window with no audio yields an empty transcript, and no activity yields a
 * record with no screen-context section — because `fuseMeeting` handles both.
 */

import { detectMeetings } from "./detect.js";
import { fuseMeeting, type MeetingFusionOptions } from "./fuse.js";
import { composeMeetingRecord, type MeetingRecordStore, type MeetingRecordSummary } from "./store.js";
import { log } from "../logger.js";
import type {
  MeetingEpisodeGenResult,
  MeetingMemoryGenerator,
  MeetingMemoryOutcome,
  MeetingsDayFactGenResult,
} from "./memory-generator.js";
import type { FusionConversationInput } from "../wearables/fusion/types.js";
import type {
  DetectedMeeting,
  MeetingActivitySnapshot,
  MeetingRecord,
  MeetingsConfig,
  MeetingsDetectionInput,
} from "./types.js";

/** All of a day's already-loaded signals a build needs. */
export interface MeetingDayData {
  /** App spans + audio windows for the day (fed to the detector). */
  detection: MeetingsDetectionInput;
  /** Fusion conversation inputs across all wearable sources for the day. */
  conversations: FusionConversationInput[];
  /** Screen-activity snapshots for the day. */
  activity?: MeetingActivitySnapshot[];
}

/** Supplies a day's signals. Backed by fixtures in tests; by the activity +
 *  wearables stores in the wiring slice. */
export interface MeetingsDaySource {
  loadDayData(date: string): Promise<MeetingDayData> | MeetingDayData;
}

export function buildMeetingRecordsForDay(
  data: MeetingDayData,
  config: MeetingsConfig,
  options: MeetingFusionOptions = {},
  /** Map a detected meeting to the id its record should carry. Defaults to the
   *  detector's start-anchored id; the builder overrides this to preserve an
   *  existing overlapping record's id across shifted-start resyncs. */
  resolveMeetingId: (meeting: DetectedMeeting) => string = (meeting) => meeting.id,
): MeetingRecord[] {
  const meetings = detectMeetings(data.detection, {
    appPatterns: config.appPatterns,
    minOverlapMinutes: config.minOverlapMinutes,
    audioOnlyMinMinutes: config.audioOnlyMinMinutes,
    mergeGapMinutes: config.mergeGapMinutes,
  });
  return meetings.map((meeting) => {
    const fused = fuseMeeting(
      { meeting, conversations: data.conversations, ...(data.activity !== undefined ? { activity: data.activity } : {}) },
      config,
      options,
    );
    return composeMeetingRecord(
      {
        id: resolveMeetingId(meeting),
        date: meeting.date,
        startUtc: meeting.startUtc,
        endUtc: meeting.endUtc,
        ...(meeting.app !== undefined ? { app: meeting.app } : {}),
        detectionSource: meeting.detectionSource,
        ...(meeting.title !== undefined ? { title: meeting.title } : {}),
      },
      fused,
    );
  });
}

/** Per-meeting outcome of a day build. */
export interface MeetingBuildOutcome {
  id: string;
  startUtc: string;
  endUtc: string;
  detectionSource: string;
  sources: string[];
  attendees: string[];
  snapshotCount: number;
  /** False when the record's contentHash was unchanged (nothing rewritten). */
  written: boolean;
}

/** Result of building one day's meetings. */
export interface MeetingsDayBuildSummary {
  date: string;
  /** False when `meetings.enabled` is off (zero behavior). */
  enabled: boolean;
  meetings: MeetingBuildOutcome[];
  /** Records written (new or changed). */
  built: number;
  /** Records skipped (unchanged contentHash). */
  skipped: number;
  /** Ids of stale same-day records deleted because they no longer detect. */
  removed: string[];
  /**
   * Set when the optional reindex hook rejected AFTER records were already
   * persisted. The store mutation still succeeded — the build is reported as
   * successful with this generic warning, and the next scheduled index catches
   * up. Deliberately does NOT embed the raw error text: this string is printed
   * to the CLI's stdout, and internal error detail is logged separately.
   */
  reindexWarning?: string;
  /**
   * Set when the injected `memoryGenerator` rejected AFTER records were already
   * persisted. Like `reindexWarning`, the record writes still succeeded, so the
   * build is reported successful with this generic warning; the next build (or
   * scheduled maintenance) regenerates the missing memories. No raw error text.
   */
  memoryWarning?: string;
  /**
   * Deterministic episode-memory counts, present only when a `memoryGenerator`
   * was injected. One recall-anchor episode is written per built record (idempotent).
   */
  episodes?: MeetingEpisodeGenResult;
  /**
   * Trust-gated summary/fact counts (decisions, commitments, questions, and the
   * synthesized summary), present only when a `memoryGenerator` with summary deps
   * ran and `summaryMode !== "off"`. Aggregated across the day's records.
   */
  facts?: MeetingsDayFactGenResult;
}

/** Optional side effects the builder fires after a day build. */
export interface MeetingsBuilderHooks {
  /**
   * Invoked once per build when records changed (`built > 0 || removed > 0`).
   * Meeting records live inside the QMD collection root for full-text search,
   * so a host that wants them discoverable immediately (rather than at the next
   * scheduled reindex) supplies a reindex here. No-op when omitted — records are
   * still picked up by the next index update.
   */
  reindex?(summary: MeetingsDayBuildSummary): void | Promise<void>;
}

/** Orchestrates a store-backed build of a day's meetings. */
export class MeetingsBuilder {
  constructor(
    private readonly opts: {
      source: MeetingsDaySource;
      store: MeetingRecordStore;
      config: MeetingsConfig;
      fusionOptions?: MeetingFusionOptions;
      hooks?: MeetingsBuilderHooks;
      /**
       * When present, the memory-generation layer runs after the record-store
       * writes: deterministic recall-anchor episodes per built record, the
       * trust-gated summary/facts layer, and retract-on-removal — all behind the
       * `MeetingMemoryGenerator` seam (issue #1900). Omitted → pure
       * detect+fuse+store with no memory writes. The engine depends only on this
       * interface, never on the memory-gen module.
       */
      memoryGenerator?: MeetingMemoryGenerator;
    },
  ) {}

  async buildDay(date: string): Promise<MeetingsDayBuildSummary> {
    if (!this.opts.config.enabled) {
      return { date, enabled: false, meetings: [], built: 0, skipped: 0, removed: [] };
    }
    const data = await this.opts.source.loadDayData(date);
    // The source contract is loadDayData(date) → THAT day's signals. If the
    // returned detection day disagrees, records would be written under
    // data.detection.date while listing/adoption/reconciliation run on `date`,
    // orphaning records and mis-keying the summary — reject the desync loudly.
    if (data.detection.date !== date) {
      throw new RangeError(
        `meetings: day source returned detection.date "${data.detection.date}" for requested day "${date}".`,
      );
    }
    // Existing records for the day, so an overlapping shifted-start resync keeps
    // its original id instead of being deleted + re-created under a new one.
    const existing = await this.opts.store.listMeetingSummaries(date);
    const claimed = new Set<string>();
    const resolveMeetingId = (meeting: DetectedMeeting): string =>
      this.adoptExistingId(meeting, existing, claimed);
    const records = buildMeetingRecordsForDay(
      data,
      this.opts.config,
      this.opts.fusionOptions ?? {},
      resolveMeetingId,
    );
    const meetings: MeetingBuildOutcome[] = [];
    let built = 0;
    let skipped = 0;
    const builtIds = new Set<string>();
    // Ids that existed before THIS build, so a same-id rewrite (contentHash
    // changed) is distinguished from a brand-new record and from an untouched one.
    const priorIds = new Set(existing.map((summary) => summary.id));
    // Built ids whose stored record was IDENTICAL this build (nothing rewritten):
    // the generator must skip them so an idempotent rebuild triggers no LLM calls
    // and no duplicate memories.
    const unchangedIds: string[] = [];
    // Built ids that already existed and were rewritten this build (same id, new
    // contentHash): the generator must refresh (retract + regenerate) their stale
    // episode/summary memories.
    const updatedIds: string[] = [];
    for (const record of records) {
      const save = await this.opts.store.saveMeetingRecord(record);
      if (save.written) {
        built++;
        if (priorIds.has(record.id)) updatedIds.push(record.id);
      } else {
        skipped++;
        unchangedIds.push(record.id);
      }
      builtIds.add(record.id);
      meetings.push({
        id: record.id,
        startUtc: record.startUtc,
        endUtc: record.endUtc,
        detectionSource: record.detectionSource,
        sources: record.sources,
        attendees: record.attendees,
        snapshotCount: record.snapshotCount,
        written: save.written,
      });
    }
    // Reconcile genuinely stale records: a prior build's meeting the current
    // rebuild neither reproduced nor adopted (by overlap) is deleted so it does
    // not linger and orphan its provenance. Delete only within THIS day's dir.
    const removed: string[] = [];
    for (const existingId of await this.opts.store.listMeetingIds(date)) {
      if (builtIds.has(existingId)) continue;
      await this.opts.store.deleteMeetingRecord(date, existingId);
      removed.push(existingId);
    }
    const summary: MeetingsDayBuildSummary = { date, enabled: true, meetings, built, skipped, removed };
    // Memory generation runs behind the seam: the deterministic engine hands the
    // built records, removed ids, and the unchanged/updated id sets to the
    // injected generator and folds the returned counts + reindex signal into the
    // summary. The engine never imports the memory-gen module.
    //
    // The record writes above already succeeded; a generator rejection must NOT
    // fail the whole build and lose those persisted records. Isolate it exactly
    // like the reindex hook: surface a generic warning, log the detail, and let
    // the next build regenerate the missing memories.
    let outcome: MeetingMemoryOutcome | undefined;
    if (this.opts.memoryGenerator !== undefined) {
      try {
        outcome = await this.opts.memoryGenerator.onRecordsBuilt({
          built: records,
          removedIds: removed,
          unchangedIds,
          updatedIds,
        });
      } catch (err) {
        log.error("meetings: memory generation failed after records were persisted", err);
        summary.memoryWarning = "memory generation failed after records were persisted; see logs for detail";
      }
    }
    if (outcome?.episodes !== undefined) summary.episodes = outcome.episodes;
    if (outcome?.facts !== undefined) summary.facts = outcome.facts;
    // Meeting records AND their episode/summary memories live inside the QMD
    // collection root. Fire the isolated reindex whenever anything discoverable
    // changed — records written/removed (engine) OR newly written episodes/facts
    // (folded into outcome.reindexNeeded). A rebuild whose records were unchanged
    // (built == 0 && removed == 0) but whose prior episode write had failed still
    // creates active memories that must be indexed now, not left dark until the
    // next scheduled maintenance pass.
    if (built > 0 || removed.length > 0 || (outcome?.reindexNeeded ?? false)) {
      // The store mutation already succeeded; a reindex-hook rejection must not
      // fail the whole build. Log the detail and surface a GENERIC warning — the
      // raw error must not leak to the CLI's stdout — then let the next scheduled
      // index update catch up.
      try {
        await this.opts.hooks?.reindex?.(summary);
      } catch (err) {
        log.error("meetings: reindex hook failed after records were persisted", err);
        summary.reindexWarning = "reindex hook failed after records were persisted; see logs for detail";
      }
    }
    return summary;
  }

  /**
   * Pick the existing same-day record whose window best overlaps `meeting` and
   * reuse its id — but ONLY when adoption is safe: the windows substantially
   * coincide (overlap covers a majority of the shorter window), OR a corroborating
   * identity signal (same app, same title, or a shared transcript source) is
   * BACKED by a non-marginal overlap (>= a quarter of the shorter window). Coarse
   * identity signals alone never license adoption across a thin sliver of overlap,
   * or two genuinely different back-to-back same-app meetings would overwrite each
   * other's record and `show <old-id>` would point at the wrong meeting. Candidate
   * selection is deterministic (max overlap, then earliest start, then id).
   * Returns the detector's fresh id when nothing qualifies.
   */
  private adoptExistingId(
    meeting: DetectedMeeting,
    existing: readonly MeetingRecordSummary[],
    claimed: Set<string>,
  ): string {
    const dStart = Date.parse(meeting.startUtc);
    const dEnd = Date.parse(meeting.endUtc);
    if (!Number.isFinite(dStart) || !Number.isFinite(dEnd)) return meeting.id;
    let best: { record: MeetingRecordSummary; overlap: number; existingDurationMs: number } | undefined;
    for (const record of existing) {
      if (claimed.has(record.id)) continue;
      const eStart = Date.parse(record.startUtc);
      const eEnd = Date.parse(record.endUtc);
      if (!Number.isFinite(eStart) || !Number.isFinite(eEnd)) continue;
      const overlap = Math.min(dEnd, eEnd) - Math.max(dStart, eStart);
      if (overlap <= 0) continue;
      const better =
        best === undefined ||
        overlap > best.overlap ||
        (overlap === best.overlap &&
          (record.startUtc < best.record.startUtc ||
            (record.startUtc === best.record.startUtc && record.id < best.record.id)));
      if (better) best = { record, overlap, existingDurationMs: eEnd - eStart };
    }
    if (best === undefined) return meeting.id;
    // Adoption bar (issue #1900): substantial overlap OR a corroborating identity
    // signal that is BACKED by a non-marginal overlap — otherwise treat as
    // removed + new. App name and transcript-source label are COARSE (many
    // distinct meetings carry "Zoom"/"desktop"), so an identity match on its own
    // must not license adoption across a thin sliver of overlap, or two genuinely
    // different back-to-back same-app meetings would clobber each other's record.
    const shorterWindowMs = Math.min(dEnd - dStart, best.existingDurationMs);
    if (shorterWindowMs <= 0) return meeting.id;
    // A shifted-start resync of the SAME meeting: overlap covers a majority of the
    // shorter window. Adopts on its own.
    const substantial = best.overlap * 2 >= shorterWindowMs;
    const sharedSource = meeting.sources.some((source) => best!.record.sources.includes(source));
    const sameApp =
      meeting.app !== undefined &&
      best.record.app !== undefined &&
      meeting.app.toLowerCase() === best.record.app.toLowerCase();
    const meetingTitle = meeting.title?.trim() ?? "";
    const sameTitle = meetingTitle.length > 0 && meetingTitle === (best.record.title?.trim() ?? "");
    const hasIdentitySignal = sharedSource || sameApp || sameTitle;
    // Non-marginal overlap gate: an identity signal only corroborates when the
    // windows overlap by at least a quarter of the shorter window.
    const nonMarginalOverlap = best.overlap * 4 >= shorterWindowMs;
    if (!substantial && !(hasIdentitySignal && nonMarginalOverlap)) return meeting.id;
    claimed.add(best.record.id);
    return best.record.id;
  }
}
