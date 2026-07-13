/**
 * Wearable cross-source fusion — reconstruct inputs from stored transcripts.
 *
 * The on-demand service path fuses from already-synced day transcripts
 * (offline, no connector calls). Those files store a human-readable
 * markdown body, so this module parses it back into the normalized
 * `FusionConversationInput[]` shape the fusion engine consumes.
 *
 * Precision caveat (documented, accepted for this foundational PR):
 * the rendered body carries minute-precision clock times in the
 * configured timezone. We reconstruct them as `${date}T${HH}:${MM}:00Z`
 * — every source for a given day is rendered in the SAME timezone, so
 * relative within-day comparisons and time-window alignment stay
 * correct even though the absolute ISO is timezone-normalized. Full
 * segment-level alignment with sub-minute precision is a deferred
 * follow-up (see PR body).
 */

import {
  isValidTranscriptDate,
  TRANSCRIPT_SEGMENT_LINE,
  unescapeSegmentText,
  unescapeSpeakerLabel,
} from "../day-store.js";
import { hasSelfMarker } from "../speakers.js";
import type {
  FusionConversationInput,
  FusionSegmentInput,
} from "./types.js";

const CONVERSATION_HEADING =
  /^## (.+?)\u2013(.+?)(?:\s\u00b7\s(.*))?\s\(conversation (.+)\)$/;
const LOCATION_LINE = /^\*Location: (.+)\*$/;
const CLOCK_PATTERN = /^(\d{2}):(\d{2})$/;

/** Minutes in a 24-hour day. */
const MINUTES_PER_DAY = 24 * 60;

/**
 * Upper bound on a plausible single-conversation duration, used to decide
 * whether an earlier heading end clock (or segment clock) is a genuine
 * midnight wrap (start -> midnight -> end/segment within this bound)
 * versus a malformed/ordinary earlier clock that should stay on the same
 * date and be clamped downstream. Generous enough that any legitimate
 * overnight wrap a wearable source would emit still rolls forward; tight
 * enough that a near-24h implied span (e.g. 14:00 -> 13:00) is treated as
 * the error it almost certainly is instead of producing a day-spanning
 * window that broadly clusters unrelated neighbors (#1849).
 */
const MAX_PLAUSIBLE_WRAP_MINUTES = 12 * 60;

/** Rendered clock ("HH:MM") -> timezone-normalized ISO; "--:--" -> undefined. */
function clockToIso(clock: string, date: string): string | undefined {
  const match = CLOCK_PATTERN.exec(clock.trim());
  if (match === null) return undefined;
  // en-US hour12:false renders the first wall-clock hour (00:xx) as 24:xx
  // on some ICU builds. CLOCK_PATTERN matches "24", which would build an
  // invalid ISO (24:01-24:59 => NaN) or a next-day instant (24:00 => start
  // of next day). Normalize to 00:xx on the SAME rendered date; cross-
  // midnight conversation windows are rolled forward by the caller.
  const hour = match[1] === "24" ? "00" : match[1];
  return `${date}T${hour}:${match[2]}:00.000Z`;
}

/**
 * Minutes-of-day for a rendered clock (24:xx normalized to 0), or
 * undefined when the clock is not parseable (e.g. "--:--"). Used to
 * detect conversations that wrap past midnight.
 */
function clockMinutesOfDay(clock: string): number | undefined {
  const match = CLOCK_PATTERN.exec(clock.trim());
  if (match === null) return undefined;
  const hour = match[1] === "24" ? 0 : Number.parseInt(match[1], 10);
  return hour * 60 + Number.parseInt(match[2], 10);
}

/** Increment a YYYY-MM-DD date string by one calendar day (UTC arithmetic). */
function nextCalendarDay(date: string): string {
  const [y, m, d] = date.split("-").map((part) => Number.parseInt(part, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * Reconstruct fusion inputs for a day from one or more sources' stored
 * transcript bodies. Each body is the markdown produced by
 * `composeDayTranscriptBody` (frontmatter already stripped by the
 * caller via `parseDayTranscript`).
 */
export function reconstructFusionInputs(
  date: string,
  dayTranscripts: ReadonlyArray<{ source: string; body: string }>,
): FusionConversationInput[] {
  if (!isValidTranscriptDate(date)) return [];
  const inputs: FusionConversationInput[] = [];

  for (const { source, body } of dayTranscripts) {
    let current: {
      conversationId: string;
      title?: string;
      startIso?: string;
      endIso?: string;
      segments: FusionSegmentInput[];
      /** True when the heading end clock precedes the start clock (the
       * conversation window wrapped past midnight); rolls `endIso` forward.
       * Post-midnight SEGMENTS roll independently via `wrapStartMin`. */
      wrapped: boolean;
      wrapStartMin?: number;
    } | null = null;

    const flushCurrent = () => {
      if (current === null) return;
      const startIso =
        current.startIso ??
        current.segments.find((segment) => segment.startIso !== undefined)?.startIso ??
        `${date}T00:00:00.000Z`;
      const input: FusionConversationInput = {
        source,
        conversationId: current.conversationId,
        startIso,
        segments: current.segments,
      };
      if (current.endIso !== undefined) input.endIso = current.endIso;
      if (current.title !== undefined) input.title = current.title;
      inputs.push(input);
      current = null;
    };

    for (const rawLine of body.split("\n")) {
      const line = rawLine.trimEnd();
      if (line.length === 0) continue;

      const heading = CONVERSATION_HEADING.exec(line);
      if (heading !== null) {
        flushCurrent();
        const [, startClock, endClock, title, id] = heading;
        const startMin = clockMinutesOfDay(startClock);
        const endMin = clockMinutesOfDay(endClock);
        // A conversation whose end clock reads EARLIER than its start
        // clock MAY have wrapped past midnight. Roll its end to the next
        // calendar day ONLY when the implied wrap duration (start ->
        // midnight -> end) is within a plausible single-conversation
        // bound; a near-24h implied span (e.g. start 14:00, end 13:00)
        // is almost certainly a malformed/ordinary earlier clock, not a
        // midnight crossing. Leaving that end on the SAME date keeps
        // endIso < startIso so the downstream cluster clamp collapses it
        // to the start instead of stretching the window across most of
        // the day and broadly clustering unrelated neighbors (#1849).
        // Post-midnight SEGMENTS roll independently below under the SAME
        // plausibility bound: a segment whose clock precedes the start
        // clock is rolled only when the implied wrap is plausible.
        const wrapped =
          startMin !== undefined && endMin !== undefined && endMin < startMin;
        const wrapDuration =
          startMin !== undefined && endMin !== undefined
            ? MINUTES_PER_DAY - startMin + endMin
            : undefined;
        const plausibleWrap =
          wrapped &&
          wrapDuration !== undefined &&
          wrapDuration <= MAX_PLAUSIBLE_WRAP_MINUTES;
        const startIso = clockToIso(startClock, date);
        const endIso = plausibleWrap
          ? clockToIso(endClock, nextCalendarDay(date))
          : clockToIso(endClock, date);
        current = {
          conversationId: id,
          segments: [],
          wrapped,
          ...(startMin !== undefined ? { wrapStartMin: startMin } : {}),
          ...(startIso !== undefined ? { startIso } : {}),
          ...(endIso !== undefined ? { endIso } : {}),
          ...(title !== undefined && title.length > 0 ? { title } : {}),
        };
        continue;
      }

      if (LOCATION_LINE.exec(line) !== null) continue;

      const segmentMatch = TRANSCRIPT_SEGMENT_LINE.exec(line);
      if (segmentMatch !== null) {
        if (current === null) continue; // segment outside any conversation
        const [, label, clock, rawText] = segmentMatch;
        const text = unescapeSegmentText(rawText);
        const segMin = clockMinutesOfDay(clock);
        // A segment clock EARLIER than the conversation start clock MAY
        // have crossed midnight. Roll it to the next calendar day ONLY
        // when the implied wrap duration (start -> midnight -> segment)
        // is within the SAME plausible single-conversation bound as the
        // heading end; a near-24h implied span (e.g. start 14:00,
        // segment 13:00) is almost certainly a malformed/provider-skew
        // earlier clock, not a midnight crossing. Leaving it on the SAME
        // date keeps segIso < startIso so the downstream cluster clamp
        // collapses it instead of stretching the interval across most of
        // the day and broadly clustering unrelated neighbors (#1849).
        // Driven by the segment-vs-start comparison directly — NOT gated
        // on `wrapped` — so a heading whose end is missing/unparseable
        // (e.g. `## 23:55–--:--`) still rolls a plausible `[00:05]`
        // segment forward.
        const segWrapDuration =
          current.wrapStartMin !== undefined && segMin !== undefined
            ? MINUTES_PER_DAY - current.wrapStartMin + segMin
            : undefined;
        const plausibleSegWrap =
          current.wrapStartMin !== undefined &&
          segMin !== undefined &&
          segMin < current.wrapStartMin &&
          segWrapDuration !== undefined &&
          segWrapDuration <= MAX_PLAUSIBLE_WRAP_MINUTES;
        const segDate = plausibleSegWrap ? nextCalendarDay(date) : date;
        const startIso = clockToIso(clock, segDate);
        // Decode the safely-serialized speaker label back to its original
        // form; legacy raw labels (no escape sequences) round-trip
        // verbatim (#1849).
        const speaker = unescapeSpeakerLabel(label.trim());
        const segment: FusionSegmentInput = {
          speaker,
          // Self status is read from the RESERVED `(you)` marker, which the
          // renderer guarantees can only appear on the wearer's label -
          // never on a non-self display name (issue #1849).
          isSelf: hasSelfMarker(speaker),
          text,
          ...(startIso !== undefined ? { startIso } : {}),
        };
        current.segments.push(segment);
      }
      // Unrecognized lines (e.g. the H1 source header) are ignored.
    }
    flushCurrent();
  }

  return inputs;
}
