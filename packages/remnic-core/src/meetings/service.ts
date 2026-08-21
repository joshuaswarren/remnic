/**
 * Meetings service (issue #1900) — the orchestrator-owned facade every meeting
 * surface (CLI, MCP tools, HTTP routes) shares, so behavior + validation never
 * fork across hosts (the same rule the wearables service follows). It owns the
 * record store, the store-backed builder, and the debounced post-sync build
 * scheduler.
 *
 * `meetings.enabled` is honored at every entrypoint: `meetingsList`/`meetingsGet`
 * short-circuit to an empty/absent result when disabled, `meetingsBuild`
 * delegates to the builder (which already reports `enabled: false` and writes
 * nothing), and the tail-step `requestBuild` is a no-op. Caller-correctable
 * faults (bad dates/ids) throw `MeetingsInputError`, which the transports map to
 * 400-class responses; the CLI reuses the store + builder directly through the
 * shared `runMeetingsCliCommand` runner.
 */

import { isValidTranscriptDate } from "../wearables/day-store.js";
import { formatDateInTimeZone } from "../orchestration/orchestrator-helpers.js";
import { MeetingsBuildScheduler } from "./build-scheduler.js";
import type { MeetingsBuilder, MeetingsDayBuildSummary } from "./build.js";
import { MeetingsInputError } from "./errors.js";
import { meetingIdDate, type MeetingRecordStore, type MeetingRecordSummary } from "./store.js";
import type { MeetingsConfig } from "./types.js";

/** One day's stored meeting summaries in a list result. */
export interface MeetingsListDay {
  date: string;
  meetings: MeetingRecordSummary[];
}

/** Structured result of a meetings list query (all days, or one day). */
export interface MeetingsListResult {
  /** False when `meetings.enabled` is off (zero behavior). */
  enabled: boolean;
  days: MeetingsListDay[];
}

/** Structured result of fetching one stored meeting record. */
export interface MeetingsGetResult {
  /** False when `meetings.enabled` is off (zero behavior). */
  enabled: boolean;
  found: boolean;
  id: string;
  /** Raw persisted markdown, or null when disabled/absent. */
  record: string | null;
}

export interface MeetingsServiceDeps {
  config: MeetingsConfig;
  store: MeetingRecordStore;
  builder: MeetingsBuilder;
  /** Trailing-edge coalescing window for post-sync rebuilds (ms). */
  buildDebounceMs: number;
  /** Observe a tail-step build failure (logging); never called on success. */
  onBuildError?(date: string, err: unknown): void;
}

export class MeetingsService {
  readonly store: MeetingRecordStore;
  readonly builder: MeetingsBuilder;
  readonly config: MeetingsConfig;
  private readonly scheduler: MeetingsBuildScheduler;

  constructor(deps: MeetingsServiceDeps) {
    this.config = deps.config;
    this.store = deps.store;
    this.builder = deps.builder;
    this.scheduler = new MeetingsBuildScheduler({
      debounceMs: deps.buildDebounceMs,
      build: (date) => this.builder.buildDay(date),
      ...(deps.onBuildError ? { onError: deps.onBuildError } : {}),
    });
  }

  /** List stored meetings for one day, or across all days when no date given. */
  async meetingsList(date?: string): Promise<MeetingsListResult> {
    if (!this.config.enabled) return { enabled: false, days: [] };
    if (date !== undefined) {
      if (!isValidTranscriptDate(date)) {
        throw new MeetingsInputError(`date must be a real YYYY-MM-DD; got '${date}'`);
      }
      return { enabled: true, days: [{ date, meetings: await this.store.listMeetingSummaries(date) }] };
    }
    const dates = await this.store.listMeetingDates();
    const days: MeetingsListDay[] = [];
    for (const day of dates) {
      days.push({ date: day, meetings: await this.store.listMeetingSummaries(day) });
    }
    return { enabled: true, days };
  }

  /** Fetch one stored meeting record's raw markdown by id. */
  async meetingsGet(id: string): Promise<MeetingsGetResult> {
    if (!this.config.enabled) return { enabled: false, found: false, id, record: null };
    const date = meetingIdDate(id);
    if (date === null) {
      throw new MeetingsInputError(`invalid meeting id '${id}' — expected mtg-YYYY-MM-DD-<hash>`);
    }
    // A syntactically valid id can still embed an impossible calendar date
    // (mtg-2026-13-40-...); surface that as a clean input error, not a 500 from
    // the store's path validator.
    if (!isValidTranscriptDate(date)) {
      throw new MeetingsInputError(`invalid meeting id '${id}' — '${date}' is not a real calendar date`);
    }
    const record = await this.store.readMeetingRecord(date, id);
    return { enabled: true, found: record !== null, id, record };
  }

  /** Detect + fuse + store the day's meetings. Gated inside the builder. */
  async meetingsBuild(date: string): Promise<MeetingsDayBuildSummary> {
    if (!isValidTranscriptDate(date)) {
      throw new MeetingsInputError(`date must be a real YYYY-MM-DD; got '${date}'`);
    }
    return this.builder.buildDay(date);
  }

  /**
   * Tail-step after a sync touched a day: schedule a debounced (re)build. A
   * no-op when the subsystem is disabled, so a sync of other signals never
   * spins up meeting building behind the master gate.
   */
  requestBuild(date: string): void {
    if (!this.config.enabled) return;
    this.scheduler.requestBuild(date);
  }

  /**
   * Activity tail-step (issue #1900): schedule a debounced (re)build for every
   * local day the sync touched. The tick's own local day (from `ranAtIso`, in
   * the activity timezone) is always eligible; `touchedDates` adds any OTHER
   * days a rolling/backfill sync changed, so a change to yesterday's activity
   * rebuilds yesterday's meetings rather than only today's. No-op when disabled,
   * so a sync of other signals never spins up meeting building behind the gate.
   */
  requestBuildForActivitySync(
    ranAtIso: string,
    timezone: string,
    touchedDates: readonly string[] = [],
  ): void {
    if (!this.config.enabled) return;
    const days = new Set<string>([formatDateInTimeZone(new Date(ranAtIso), timezone)]);
    for (const date of touchedDates) {
      if (isValidTranscriptDate(date)) days.add(date);
    }
    for (const date of days) this.scheduler.requestBuild(date);
  }

  /** Force any pending debounced builds to run now (teardown/tests). */
  flushBuilds(): Promise<void> {
    return this.scheduler.flush();
  }

  /** Cancel armed build timers (orchestrator teardown). */
  dispose(): void {
    this.scheduler.dispose();
  }
}
