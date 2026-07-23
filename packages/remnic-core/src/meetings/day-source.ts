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

import { activityDayWindow, isValidActivityDate, timezoneOffsetIso } from "../activity/digest.js";
import type { ActivitySnapshot } from "../activity/types.js";
import { bodyIsEscaped, parseDayTranscript } from "../wearables/day-store.js";
import { reconstructFusionInputs } from "../wearables/fusion/index.js";
import type { FusionConversationInput, FusionSegmentInput } from "../wearables/fusion/types.js";
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
  /**
   * IANA timezone the body's `HH:MM` clocks were rendered in (from the
   * transcript frontmatter). Empty when the transcript stored no timezone —
   * the clocks are then treated as UTC, matching the fusion identity guard.
   */
  timezone?: string;
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
          timezone: parsed?.meta.timezone ?? "",
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
 * maximal run of consecutive (time-ordered) snapshots on ONE capture machine
 * whose app/title/url matches any configured pattern; the next non-matching
 * snapshot ends the run AND bounds its end (so a lone matching snapshot still
 * yields a non-zero span). Brief app switches during a call surface as adjacent
 * spans and the detector's `mergeGapMinutes` re-merges them.
 */
export function deriveAppSpans(
  snapshots: readonly ActivitySnapshot[],
  appPatterns: readonly string[],
): MeetingAppSpan[] {
  const patterns = appPatterns.map((p) => p.toLowerCase()).filter((p) => p.length > 0);
  if (patterns.length === 0) return [];
  const byCaptureTime = (a: ActivitySnapshot, b: ActivitySnapshot): number => {
    const at = Date.parse(a.capturedAtUtc);
    const bt = Date.parse(b.capturedAtUtc);
    if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at < bt ? -1 : 1;
    return a.capturedAtUtc < b.capturedAtUtc ? -1 : a.capturedAtUtc > b.capturedAtUtc ? 1 : 0;
  };
  // Group by capture machine: a global time sort otherwise lets a non-matching
  // snapshot from ANOTHER machine (a desktop's Chrome tick) close a run on THIS
  // machine (a laptop in Zoom), splitting one call into fragments. Runs are
  // derived per-machine and merged into one span list.
  const byMachine = new Map<string, ActivitySnapshot[]>();
  for (const snapshot of snapshots) {
    const list = byMachine.get(snapshot.machine);
    if (list === undefined) byMachine.set(snapshot.machine, [snapshot]);
    else list.push(snapshot);
  }
  const spans: MeetingAppSpan[] = [];
  for (const machineSnaps of byMachine.values()) {
    const sorted = [...machineSnaps].sort(byCaptureTime);
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
        // End at this next (non-matching) snapshot rather than the last matching
        // one: a single matching snapshot then yields a real [start, next) span
        // instead of a zero-length point the detector's isFinitePair rejects.
        run.endUtc = snapshot.capturedAtUtc;
        spans.push(run);
        run = null;
      }
    }
    if (run !== null) spans.push(run);
  }
  spans.sort((a, b) =>
    a.startUtc < b.startUtc ? -1 : a.startUtc > b.startUtc ? 1
    : a.app < b.app ? -1 : a.app > b.app ? 1
    : a.endUtc < b.endUtc ? -1 : a.endUtc > b.endUtc ? 1 : 0,
  );
  return spans;
}

/**
 * Convert an instant the transcript renderer wrote as `...Z` — whose `HH:MM`
 * clock is really local to `timezone`, but which reconstruct labelled UTC —
 * into the true UTC instant. An empty/UTC zone or an unresolvable offset
 * returns the input unchanged, so a transcript with no stored zone keeps UTC
 * semantics (matching the fusion identity guard).
 */
function wallClockZToUtc(iso: string, timezone: string): string {
  if (timezone === "" || timezone === "UTC") return iso;
  const assumedMs = Date.parse(iso);
  if (!Number.isFinite(assumedMs)) return iso;
  let offset: string;
  try {
    offset = timezoneOffsetIso(new Date(assumedMs), timezone);
  } catch {
    return iso;
  }
  if (offset === "+00:00") return iso;
  const wall = iso.endsWith("Z") ? iso.slice(0, -1) : iso;
  const trueMs = Date.parse(`${wall}${offset}`);
  return Number.isFinite(trueMs) ? new Date(trueMs).toISOString() : iso;
}

/**
 * Re-anchor reconstructed conversations from their rendered (assumed-UTC) clocks
 * to true UTC using each source's transcript timezone, so audio windows line up
 * with the true-UTC screen snapshots instead of drifting by the zone offset
 * (a 09:00 America/Chicago call must land at 14:00Z, not 09:00Z).
 */
function shiftFusionInputsToUtc(
  conversations: readonly FusionConversationInput[],
  tzBySource: ReadonlyMap<string, string>,
): FusionConversationInput[] {
  return conversations.map((conversation) => {
    const tz = tzBySource.get(conversation.source) ?? "";
    if (tz === "" || tz === "UTC") return conversation;
    const shifted: FusionConversationInput = {
      ...conversation,
      startIso: wallClockZToUtc(conversation.startIso, tz),
      segments: conversation.segments.map((segment) => {
        const out: FusionSegmentInput = { ...segment };
        if (segment.startIso !== undefined) out.startIso = wallClockZToUtc(segment.startIso, tz);
        if (segment.endIso !== undefined) out.endIso = wallClockZToUtc(segment.endIso, tz);
        return out;
      }),
    };
    if (conversation.endIso !== undefined) shifted.endIso = wallClockZToUtc(conversation.endIso, tz);
    return shifted;
  });
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
    const tzBySource = new Map(bodies.map((b) => [b.source, b.timezone ?? ""] as const));
    const conversations = shiftFusionInputsToUtc(reconstructFusionInputs(date, bodies), tzBySource);
    const audioWindows = buildAudioWindows(conversations);
    return { detection: { date, appSpans, audioWindows }, conversations, activity };
  }
}
