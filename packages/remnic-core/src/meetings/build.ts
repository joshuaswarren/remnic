
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
import type { ActivitySnapshot } from "../activity/types.js";
import type { FusionConversationInput } from "../wearables/fusion/types.js";
import type {
  DetectedMeeting,
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
  activity?: ActivitySnapshot[];
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
   * persisted, OR when a successful generation returned non-fatal warnings. Like
   * `reindexWarning`, the record writes still succeeded, so the build is reported
   * successful with this warning; on rejection the next build (or scheduled
   * maintenance) regenerates the missing memories. Carries no raw exception text —
   * only the generic rejection message or the generator's own warning strings.
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
    if (data.detection.date !== date) {
      throw new RangeError(
        `meetings: day source returned detection.date "${data.detection.date}" for requested day "${date}".`,
      );
    }
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
    const priorIds = new Set(existing.map((summary) => summary.id));
    const unchangedIds: string[] = [];
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
    const removed: string[] = [];
    for (const existingId of await this.opts.store.listMeetingIds(date)) {
      if (builtIds.has(existingId)) continue;
      await this.opts.store.deleteMeetingRecord(date, existingId);
      removed.push(existingId);
    }
    const summary: MeetingsDayBuildSummary = { date, enabled: true, meetings, built, skipped, removed };
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
    if (outcome?.warnings !== undefined && outcome.warnings.length > 0) {
      summary.memoryWarning = outcome.warnings.join("; ");
    }
    if (built > 0 || removed.length > 0 || (outcome?.reindexNeeded ?? false)) {
      try {
        await this.opts.hooks?.reindex?.(summary);
      } catch (err) {
        log.error("meetings: reindex hook failed after records were persisted", err);
        summary.reindexWarning = "reindex hook failed after records were persisted; see logs for detail";
      }
    }
    return summary;
  }

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
    const shorterWindowMs = Math.min(dEnd - dStart, best.existingDurationMs);
    if (shorterWindowMs <= 0) return meeting.id;
    const substantial = best.overlap * 2 >= shorterWindowMs;
    const sharedSource = meeting.sources.some((source) => best!.record.sources.includes(source));
    const sameApp =
      meeting.app !== undefined &&
      best.record.app !== undefined &&
      meeting.app.toLowerCase() === best.record.app.toLowerCase();
    const meetingTitle = meeting.title?.trim() ?? "";
    const sameTitle = meetingTitle.length > 0 && meetingTitle === (best.record.title?.trim() ?? "");
    const hasIdentitySignal = sharedSource || sameApp || sameTitle;
    const nonMarginalOverlap = best.overlap * 4 >= shorterWindowMs;
    if (!substantial && !(hasIdentitySignal && nonMarginalOverlap)) return meeting.id;
    claimed.add(best.record.id);
    return best.record.id;
  }
}
