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

/** Compose every meeting record for a day from already-loaded day data. Pure. */
export function buildMeetingRecordsForDay(
  data: MeetingDayData,
  config: MeetingsConfig,
  options: MeetingFusionOptions = {},
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
        id: meeting.id,
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
}

/** Orchestrates a store-backed build of a day's meetings. */
export class MeetingsBuilder {
  constructor(
    private readonly opts: {
      source: MeetingsDaySource;
      store: MeetingRecordStore;
      config: MeetingsConfig;
      fusionOptions?: MeetingFusionOptions;
    },
  ) {}

  async buildDay(date: string): Promise<MeetingsDayBuildSummary> {
    if (!this.opts.config.enabled) {
      return { date, enabled: false, meetings: [], built: 0, skipped: 0 };
    }
    const data = await this.opts.source.loadDayData(date);
    const records = buildMeetingRecordsForDay(data, this.opts.config, this.opts.fusionOptions ?? {});
    const meetings: MeetingBuildOutcome[] = [];
    let built = 0;
    let skipped = 0;
    for (const record of records) {
      const save = await this.opts.store.saveMeetingRecord(record);
      if (save.written) built++;
      else skipped++;
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
    return { date, enabled: true, meetings, built, skipped };
  }
}
