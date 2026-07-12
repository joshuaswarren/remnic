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

import { isValidTranscriptDate } from "../day-store.js";
import type {
  FusionConversationInput,
  FusionSegmentInput,
} from "./types.js";

const CONVERSATION_HEADING =
  /^## (.+?)\u2013(.+?)(?:\s\u00b7\s(.*))?\s\(conversation (.+)\)$/;
const LOCATION_LINE = /^\*Location: (.+)\*$/;
const SEGMENT_LINE = /^\*\*(.+?)\*\*\s\[(.+?)\]:\s(.*)$/;
const CLOCK_PATTERN = /^(\d{2}):(\d{2})$/;

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

function isSelfLabel(label: string): boolean {
  return /\(you\)\s*$/.test(label.trim());
}

/**
 * Reverse `escapeSegmentText` (day-store.ts).  Unknown escape sequences
 * (a lone backslash followed by a character we don't emit) are passed
 * through literally so legacy transcripts that never went through the
 * escaper still round-trip their original text.
 */
function unescapeSegmentText(text: string): string {
  return text.replace(/\\(.)/g, (_match, ch: string) => {
    if (ch === "n") return "\n";
    if (ch === "r") return "\r";
    if (ch === "\\") return "\\";
    return ch;
  });
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
        // clock wrapped past midnight; roll its end to the next calendar
        // day so endIso >= startIso and the timeline sorts correctly.
        // Post-midnight SEGMENTS roll independently below: a segment whose
        // clock precedes the start clock crossed midnight regardless of
        // whether the heading end clock was parseable.
        const wrapped =
          startMin !== undefined && endMin !== undefined && endMin < startMin;
        const startIso = clockToIso(startClock, date);
        const endIso = wrapped
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

      const segmentMatch = SEGMENT_LINE.exec(line);
      if (segmentMatch !== null) {
        if (current === null) continue; // segment outside any conversation
        const [, label, clock, rawText] = segmentMatch;
        const text = unescapeSegmentText(rawText);
        const segMin = clockMinutesOfDay(clock);
        // A segment clock EARLIER than the conversation start clock crossed
        // midnight; roll it to the next calendar day. Driven by the
        // segment-vs-start comparison directly — NOT gated on `wrapped` —
        // so a heading whose end is missing/unparseable (e.g.
        // `## 23:55–--:--`) still rolls its `[00:05]` segment forward.
        const segDate =
          current.wrapStartMin !== undefined &&
          segMin !== undefined &&
          segMin < current.wrapStartMin
            ? nextCalendarDay(date)
            : date;
        const startIso = clockToIso(clock, segDate);
        const segment: FusionSegmentInput = {
          speaker: label.trim(),
          isSelf: isSelfLabel(label),
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
