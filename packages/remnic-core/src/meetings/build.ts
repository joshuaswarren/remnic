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
import { composeMeetingRecord, type MeetingRecordStore } from "./store.js";
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
   * successful with this warning, and the next scheduled index catches up.
   */
  reindexWarning?: string;
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
    for (const record of records) {
      const save = await this.opts.store.saveMeetingRecord(record);
      if (save.written) built++;
      else skipped++;
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
    if (built > 0 || removed.length > 0) {
      // The store mutation already succeeded; a reindex-hook rejection must not
      // fail the whole build. Surface it as a warning so the caller can log it,
      // and let the next scheduled index update catch up.
      try {
        await this.opts.hooks?.reindex?.(summary);
      } catch (err) {
        summary.reindexWarning = `reindex hook failed after records were persisted: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    }
    return summary;
  }

  /**
   * Pick the existing same-day record whose window best overlaps `meeting` and
   * reuse its id (one-to-one, deterministic: max overlap, then earliest start,
   * then id). Preserves stable `show <id>` links when a resync shifts a
   * meeting's start. Returns the detector's fresh id when nothing overlaps — a
   * genuinely new meeting.
   */
  private adoptExistingId(
    meeting: DetectedMeeting,
    existing: readonly { id: string; startUtc: string; endUtc: string }[],
    claimed: Set<string>,
  ): string {
    const dStart = Date.parse(meeting.startUtc);
    const dEnd = Date.parse(meeting.endUtc);
    if (!Number.isFinite(dStart) || !Number.isFinite(dEnd)) return meeting.id;
    let best: { id: string; overlap: number; startUtc: string } | undefined;
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
          (record.startUtc < best.startUtc ||
            (record.startUtc === best.startUtc && record.id < best.id)));
      if (better) best = { id: record.id, overlap, startUtc: record.startUtc };
    }
    if (best === undefined) return meeting.id;
    claimed.add(best.id);
    return best.id;
  }
}
