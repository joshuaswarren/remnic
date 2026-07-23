/**
 * Meeting fusion (issue #1900, Phase 4 slice 2).
 *
 * For a detected meeting window `[startUtc, endUtc)` (half-open, AGENTS.md §23),
 * fuse the concurrent signals into a screen-aware `FusedMeeting`:
 *
 *   1. Transcript — clip every wearable source's segments to the window and run
 *      them through the SHARED wearables reconciliation (`fuseCluster`). Higher-
 *      `sourceTrust` text wins overlapping regions and the out-voted sources are
 *      recorded per segment; this module never re-implements alignment/dedup —
 *      the repo rule is "extend the shared fusion module, never fork it".
 *   2. Screen context — other-app foreground dwell within the window, kept only
 *      when it lasts `contextDwellSeconds`, plus deduped on-screen text excerpts
 *      capped at `maxContextChars`.
 *   3. Attendees — distinct non-wearer speaker labels from the fused transcript
 *      (already resolved through the wearables speaker registry upstream).
 *
 * Pure and deterministic: same inputs ⇒ same `FusedMeeting`.
 */

import { fuseCluster } from "../wearables/fusion/reconcile.js";
import type {
  FusionConversationInput,
  FusionSegmentInput,
} from "../wearables/fusion/types.js";
import type {
  FusedMeeting,
  MeetingActivitySnapshot,
  MeetingBuildInput,
  MeetingScreenContextEvent,
  MeetingsConfig,
} from "./types.js";

/** Per-run tuning that mirrors the wearables fusion knobs. */
export interface MeetingFusionOptions {
  /** Per-source trust priors handed to reconciliation. */
  sourceTrust?: Record<string, number>;
  /** Max drift (ms) for two segments to align across sources. */
  windowToleranceMs?: number;
}

const SORT_STR = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** `HH:MM` in UTC for a parseable ISO instant (mirrors the day-store fallback). */
function formatClockUtc(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

/** Overlap of two half-open [start,end) windows in ms (0 when disjoint). */
function overlapMs(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/** Whether a segment falls in the half-open window; null when it carries no
 *  parseable start (the caller decides via the conversation-level overlap). */
function segmentInWindow(
  seg: FusionSegmentInput,
  windowStartMs: number,
  windowEndMs: number,
): boolean | null {
  const startMs = seg.startIso === undefined ? NaN : Date.parse(seg.startIso);
  if (Number.isNaN(startMs)) return null;
  const endParsed = seg.endIso === undefined ? NaN : Date.parse(seg.endIso);
  const endMs = Number.isNaN(endParsed) ? startMs : endParsed;
  if (endMs === startMs) return startMs >= windowStartMs && startMs < windowEndMs;
  return overlapMs(startMs, endMs, windowStartMs, windowEndMs) > 0;
}

/** Clip one conversation to the window, keeping only in-window segments. */
function clipConversation(
  conv: FusionConversationInput,
  windowStartMs: number,
  windowEndMs: number,
): FusionConversationInput | null {
  const convStart = Date.parse(conv.startIso);
  const convEnd = conv.endIso === undefined ? convStart : Date.parse(conv.endIso);
  const convOverlaps =
    Number.isFinite(convStart) &&
    overlapMs(convStart, Number.isFinite(convEnd) ? convEnd : convStart, windowStartMs, windowEndMs) > 0;

  const kept: FusionSegmentInput[] = [];
  let earliestStart: number | undefined;
  let earliestIso: string | undefined;
  let latestEnd: number | undefined;
  let latestIso: string | undefined;
  for (const seg of conv.segments) {
    const decision = segmentInWindow(seg, windowStartMs, windowEndMs);
    // Untimed segments ride along only when the conversation itself overlaps.
    if (decision === false || (decision === null && !convOverlaps)) continue;
    kept.push(seg);
    if (seg.startIso !== undefined) {
      const s = Date.parse(seg.startIso);
      if (Number.isFinite(s) && (earliestStart === undefined || s < earliestStart)) {
        earliestStart = s;
        earliestIso = seg.startIso;
      }
      const endIso = seg.endIso ?? seg.startIso;
      const e = Date.parse(endIso);
      if (Number.isFinite(e) && (latestEnd === undefined || e > latestEnd)) {
        latestEnd = e;
        latestIso = endIso;
      }
    }
  }
  if (kept.length === 0) return null;
  return {
    source: conv.source,
    conversationId: conv.conversationId,
    ...(conv.title !== undefined ? { title: conv.title } : {}),
    ...(conv.summary !== undefined ? { summary: conv.summary } : {}),
    startIso: earliestIso ?? conv.startIso,
    ...(latestIso !== undefined ? { endIso: latestIso } : conv.endIso !== undefined ? { endIso: conv.endIso } : {}),
    segments: kept,
  };
}

/** Strip the URL scheme for a compact screen-context label. */
function shortenUrl(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, "");
}

function contextLabel(snap: MeetingActivitySnapshot): string {
  if (snap.url !== undefined && snap.url.length > 0) return `${snap.app}: ${shortenUrl(snap.url)}`;
  if (snap.title !== undefined && snap.title.length > 0) return `${snap.app}: ${snap.title}`;
  return snap.app;
}

/** True when a snapshot is the meeting app itself (captions/chat/participants),
 *  not other context. Matches the meeting's app or any configured app pattern. */
function isMeetingAppSnapshot(
  snap: MeetingActivitySnapshot,
  meetingApp: string | undefined,
  appPatterns: readonly string[],
): boolean {
  const hay = `${snap.app} ${snap.title ?? ""} ${snap.url ?? ""}`.toLowerCase();
  if (meetingApp !== undefined && meetingApp.length > 0 && hay.includes(meetingApp.toLowerCase())) {
    return true;
  }
  for (const pattern of appPatterns) {
    if (pattern.length > 0 && hay.includes(pattern.toLowerCase())) return true;
  }
  return false;
}

const MEETING_APP_KEY = "\u0000meeting-app";

interface ScreenContextResult {
  events: MeetingScreenContextEvent[];
  excerpts: string[];
  snapshotCount: number;
}

/**
 * Build the screen-context timeline + excerpts from the day's activity clipped
 * to the meeting window. Consecutive snapshots sharing a foreground key form a
 * dwell run whose length is bounded by the NEXT foreground change (or the
 * window end); other-app runs are emitted only when the dwell clears
 * `contextDwellSeconds`, so a brief alt-tab is dropped and a lingered doc is
 * kept. Meeting-app snapshots never enter the timeline but feed excerpts.
 */
function buildScreenContext(
  activity: readonly MeetingActivitySnapshot[],
  windowStartMs: number,
  windowEndMs: number,
  meetingApp: string | undefined,
  config: MeetingsConfig,
): ScreenContextResult {
  const win = activity
    .map((snap) => ({ snap, ms: Date.parse(snap.tsUtc) }))
    .filter((entry) => Number.isFinite(entry.ms) && entry.ms >= windowStartMs && entry.ms < windowEndMs)
    .sort((a, b) => a.ms - b.ms || SORT_STR(a.snap.app, b.snap.app));

  const keyOf = (snap: MeetingActivitySnapshot): string =>
    isMeetingAppSnapshot(snap, meetingApp, config.appPatterns)
      ? MEETING_APP_KEY
      : `${snap.app}\u0000${snap.url ?? snap.title ?? ""}`;

  const events: MeetingScreenContextEvent[] = [];
  const includedText: string[] = [];

  let runStartIdx = 0;
  while (runStartIdx < win.length) {
    const key = keyOf(win[runStartIdx]!.snap);
    let runEndIdx = runStartIdx + 1;
    while (runEndIdx < win.length && keyOf(win[runEndIdx]!.snap) === key) runEndIdx++;
    const runStartMs = win[runStartIdx]!.ms;
    // A run's dwell ends at the NEXT foreground change (next different-key
    // snapshot). The trailing run has no observed switch-away, so bound it by the
    // LAST snapshot in the run — never inflate to the meeting end (a lone trailing
    // alt-tab would otherwise look like it dwelled until the meeting ended).
    const runEndMs = runEndIdx < win.length ? win[runEndIdx]!.ms : win[runEndIdx - 1]!.ms;
    const dwellSeconds = Math.floor((runEndMs - runStartMs) / 1000);
    const head = win[runStartIdx]!.snap;

    const isMeetingApp = key === MEETING_APP_KEY;
    if (isMeetingApp) {
      // Captions / chat / participant text visible on the meeting app itself.
      for (let i = runStartIdx; i < runEndIdx; i++) {
        const text = win[i]!.snap.text;
        if (text !== undefined && text.trim().length > 0) includedText.push(text.trim());
      }
    } else if (dwellSeconds >= config.contextDwellSeconds) {
      events.push({
        tsUtc: new Date(runStartMs).toISOString(),
        clock: formatClockUtc(runStartMs),
        app: head.app,
        label: contextLabel(head),
        dwellSeconds,
      });
      for (let i = runStartIdx; i < runEndIdx; i++) {
        const text = win[i]!.snap.text;
        if (text !== undefined && text.trim().length > 0) includedText.push(text.trim());
      }
    }
    runStartIdx = runEndIdx;
  }

  // Dedup excerpts (first occurrence wins) and cap total characters.
  const excerpts: string[] = [];
  const seen = new Set<string>();
  let used = 0;
  for (const text of includedText) {
    if (seen.has(text)) continue;
    if (used + text.length > config.maxContextChars) break;
    seen.add(text);
    excerpts.push(text);
    used += text.length;
  }

  return { events, excerpts, snapshotCount: win.length };
}

/** Fuse one detected meeting's transcript + screen context into a FusedMeeting. */
export function fuseMeeting(
  input: MeetingBuildInput,
  config: MeetingsConfig,
  options: MeetingFusionOptions = {},
): FusedMeeting {
  const windowStartMs = Date.parse(input.meeting.startUtc);
  const windowEndMs = Date.parse(input.meeting.endUtc);
  if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs) || windowEndMs <= windowStartMs) {
    throw new RangeError(
      `meetings: meeting ${input.meeting.id} has an invalid window [${input.meeting.startUtc}, ${input.meeting.endUtc}).`,
    );
  }

  const clipped: FusionConversationInput[] = [];
  for (const conv of input.conversations) {
    const clip = clipConversation(conv, windowStartMs, windowEndMs);
    if (clip !== null) clipped.push(clip);
  }

  const fused =
    clipped.length > 0
      ? fuseCluster(clipped, {
          ...(options.sourceTrust !== undefined ? { sourceTrust: options.sourceTrust } : {}),
          ...(options.windowToleranceMs !== undefined ? { windowToleranceMs: options.windowToleranceMs } : {}),
        })
      : { sources: [], speakers: [], segments: [], disagreements: [], startIso: input.meeting.startUtc };

  const corroborated = new Set<string>();
  for (const segment of fused.segments) {
    for (const alt of segment.provenance.alternatives) {
      // Suppress a source only as corroborator of the SAME segment it won
      // (a winner is never its own alternative, so this is a guard). A source
      // that WON one segment but lost another still corroborates the one it
      // lost — deleting it globally erased legitimate multi-device corroboration
      // and dropped the summary/fact trust boost.
      if (alt.source === segment.provenance.source) continue;
      corroborated.add(alt.source);
    }
  }

  const attendees = new Set<string>();
  for (const speaker of fused.speakers) {
    if (!speaker.isSelf) attendees.add(speaker.label);
  }

  const screen = buildScreenContext(
    input.activity ?? [],
    windowStartMs,
    windowEndMs,
    input.meeting.app,
    config,
  );

  return {
    attendees: [...attendees].sort(SORT_STR),
    sources: [...fused.sources].sort(SORT_STR),
    corroboratedBy: [...corroborated].sort(SORT_STR),
    screenContext: screen.events,
    contextExcerpts: screen.excerpts,
    transcript: fused.segments,
    speakers: fused.speakers,
    snapshotCount: screen.snapshotCount,
  };
}
