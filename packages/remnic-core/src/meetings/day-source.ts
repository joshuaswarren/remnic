/**
 * Concrete meetings day source (issue #1900) — the wiring slice that feeds the
 * builder from the ESTABLISHED stores rather than fixtures:
 *   - screen activity snapshots (the activity SQLite store), and
 *   - wearable day transcripts (the wearable day-store), reconstructed into the
 *     shared fusion conversation shape via `reconstructFusionInputs`.
 *
 * All timestamps stay UTC and every day read is a half-open [start, end)
 * window resolved by `activityDayWindow(date, timezone)`, so the local day the
 * caller asked for maps to one deterministic UTC window shared by both signals.
 *
 * Fidelity caveat (inherited, documented): a wearable day transcript is stored
 * RENDERED at minute precision, so `reconstructFusionInputs` rebuilds each clock
 * as `${date}THH:MM:00Z` — the same reconstruction the fusion subsystem uses.
 * App spans come from true-UTC activity instants; the two frames coincide when
 * the activity timezone is UTC (the default). Under a non-UTC timezone the
 * app+audio overlap carries that reconstruction offset, exactly as wearable
 * fusion does; audio-only detection is unaffected. Provider-meeting boundaries
 * (Granola/Fireflies explicit titles) are a connector concern not present in the
 * reconstructed day transcript, so audio windows never fabricate a provider flag.
 */

import { activityDayWindow, isValidActivityDate } from "../activity/digest.js";
import type { ActivitySnapshot } from "../activity/types.js";
import { bodyIsEscaped, parseDayTranscript } from "../wearables/day-store.js";
import { reconstructFusionInputs } from "../wearables/fusion/index.js";
import type { FusionConversationInput } from "../wearables/fusion/types.js";
import type { MeetingDayData, MeetingsDaySource } from "./build.js";
import { MeetingsInputError } from "./errors.js";
import type {
  MeetingActivitySnapshot,
  MeetingAppSpan,
  MeetingAudioWindow,
  MeetingsConfig,
} from "./types.js";

/** Reads the day's screen-activity snapshots. Satisfied by `ActivityStore`. */
export interface MeetingsActivityReader {
  /** Snapshots whose capture instant is in the half-open [start, end) window. */
  listSnapshotsForDay(
    machine: string | null,
    startUtcInclusive: string,
    endUtcExclusive: string,
  ): ActivitySnapshot[] | Promise<ActivitySnapshot[]>;
}

/** One stored wearable day transcript body, ready for reconstruction. */
export interface WearableDayBody {
  source: string;
  body: string;
  escaped?: boolean;
}

/** Reads the day's rendered wearable transcript bodies (one per source). */
export interface MeetingsWearableReader {
  readDayBodies(date: string): Promise<WearableDayBody[]>;
}

/** Narrow slice of `StorageManager` the wearable reader needs. */
export interface WearableDayTranscriptStore {
  listWearableTranscriptDays(
    sourceId?: string,
  ): Promise<Array<{ source: string; date: string }>>;
  readWearableDayTranscript(sourceId: string, date: string): Promise<string | null>;
}

/**
 * Build a wearable reader over a storage manager: discover which sources stored
 * a transcript for the day (store-driven, not config-driven, so a day is read
 * exactly from what exists on disk), then read + parse each body.
 */
export function storageWearableDayReader(store: WearableDayTranscriptStore): MeetingsWearableReader {
  return {
    async readDayBodies(date: string): Promise<WearableDayBody[]> {
      const days = await store.listWearableTranscriptDays();
      const sources = [...new Set(days.filter((d) => d.date === date).map((d) => d.source))].sort();
      const bodies: WearableDayBody[] = [];
      for (const source of sources) {
        const raw = await store.readWearableDayTranscript(source, date);
        if (raw === null) continue;
        const parsed = parseDayTranscript(raw);
        bodies.push({
          source,
          body: parsed?.body ?? raw,
          escaped: bodyIsEscaped(parsed?.meta),
        });
      }
      return bodies;
    },
  };
}

/** Map an activity snapshot to the redaction-safe screen snapshot fusion sees. */
function toMeetingActivitySnapshot(snapshot: ActivitySnapshot): MeetingActivitySnapshot {
  const out: MeetingActivitySnapshot = { tsUtc: snapshot.capturedAtUtc, app: snapshot.app };
  if (snapshot.windowTitle.length > 0) out.title = snapshot.windowTitle;
  if (snapshot.browserUrl !== undefined && snapshot.browserUrl.length > 0) out.url = snapshot.browserUrl;
  if (snapshot.text.length > 0) out.text = snapshot.text;
  return out;
}

/**
 * Derive meeting-app foreground spans from the day's snapshots. A span is a
 * maximal run of consecutive (time-ordered) snapshots whose app/title/url
 * matches any configured pattern; a non-matching snapshot ends the run. Brief
 * app switches during a call surface as adjacent spans and the detector's
 * `mergeGapMinutes` re-merges them, so this stays deliberately simple.
 */
export function deriveAppSpans(
  snapshots: readonly ActivitySnapshot[],
  appPatterns: readonly string[],
): MeetingAppSpan[] {
  const patterns = appPatterns.map((p) => p.toLowerCase()).filter((p) => p.length > 0);
  if (patterns.length === 0) return [];
  const sorted = [...snapshots].sort((a, b) => {
    const at = Date.parse(a.capturedAtUtc);
    const bt = Date.parse(b.capturedAtUtc);
    if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at < bt ? -1 : 1;
    return a.capturedAtUtc < b.capturedAtUtc ? -1 : a.capturedAtUtc > b.capturedAtUtc ? 1 : 0;
  });
  const spans: MeetingAppSpan[] = [];
  let run: MeetingAppSpan | null = null;
  for (const snapshot of sorted) {
    const hay = `${snapshot.app}\n${snapshot.windowTitle}\n${snapshot.browserUrl ?? ""}`.toLowerCase();
    if (patterns.some((p) => hay.includes(p))) {
      if (run === null) {
        run = { app: snapshot.app, startUtc: snapshot.capturedAtUtc, endUtc: snapshot.capturedAtUtc };
      } else {
        run.endUtc = snapshot.capturedAtUtc;
      }
    } else if (run !== null) {
      spans.push(run);
      run = null;
    }
  }
  if (run !== null) spans.push(run);
  return spans;
}

/**
 * Derive audio windows from reconstructed conversations. Each conversation is
 * one window on its source; `distinctNonWearerSpeakers` counts distinct
 * non-self speaker labels (the audio-only detection rule), and the end is the
 * conversation end when known, else the latest segment instant, else the start.
 */
export function buildAudioWindows(
  conversations: readonly FusionConversationInput[],
): MeetingAudioWindow[] {
  return conversations.map((conversation) => {
    const speakers = new Set<string>();
    let maxEndMs = Date.parse(conversation.startIso);
    for (const segment of conversation.segments) {
      if (!segment.isSelf && segment.speaker.length > 0) speakers.add(segment.speaker);
      for (const iso of [segment.endIso, segment.startIso]) {
        if (iso === undefined) continue;
        const ms = Date.parse(iso);
        if (Number.isFinite(ms) && (!Number.isFinite(maxEndMs) || ms > maxEndMs)) maxEndMs = ms;
      }
    }
    const endUtc =
      conversation.endIso ??
      (Number.isFinite(maxEndMs) ? new Date(maxEndMs).toISOString() : conversation.startIso);
    return {
      source: conversation.source,
      startUtc: conversation.startIso,
      endUtc,
      distinctNonWearerSpeakers: speakers.size,
    };
  });
}

/**
 * Reads a day's real activity + wearable signals and assembles the
 * {@link MeetingDayData} the builder consumes. Injected readers keep this
 * testable against fixtures and free of direct filesystem access.
 */
export class ActivityWearablesMeetingsDaySource implements MeetingsDaySource {
  constructor(
    private readonly deps: {
      activity: MeetingsActivityReader;
      wearables: MeetingsWearableReader;
      config: MeetingsConfig;
      /** IANA timezone resolving the local day → UTC window (activity's zone). */
      timezone: string;
    },
  ) {}

  async loadDayData(date: string): Promise<MeetingDayData> {
    if (!isValidActivityDate(date)) {
      throw new MeetingsInputError(`invalid day '${date}' — expected a real YYYY-MM-DD`);
    }
    const { startUtc, endUtc } = activityDayWindow(date, this.deps.timezone);
    const snapshots = await this.deps.activity.listSnapshotsForDay(null, startUtc, endUtc);
    const activity = snapshots.map(toMeetingActivitySnapshot);
    const appSpans = deriveAppSpans(snapshots, this.deps.config.appPatterns);
    const bodies = await this.deps.wearables.readDayBodies(date);
    const conversations = reconstructFusionInputs(date, bodies);
    const audioWindows = buildAudioWindows(conversations);
    return { detection: { date, appSpans, audioWindows }, conversations, activity };
  }
}
