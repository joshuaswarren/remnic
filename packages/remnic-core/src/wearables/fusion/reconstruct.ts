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
  return `${date}T${match[1]}:${match[2]}:00.000Z`;
}

function isSelfLabel(label: string): boolean {
  return /\(you\)\s*$/.test(label.trim());
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
        current = {
          conversationId: id,
          segments: [],
          ...(clockToIso(startClock, date) !== undefined
            ? { startIso: clockToIso(startClock, date) }
            : {}),
          ...(clockToIso(endClock, date) !== undefined
            ? { endIso: clockToIso(endClock, date) }
            : {}),
          ...(title !== undefined && title.length > 0 ? { title } : {}),
        };
        continue;
      }

      if (LOCATION_LINE.exec(line) !== null) continue;

      const segmentMatch = SEGMENT_LINE.exec(line);
      if (segmentMatch !== null) {
        if (current === null) continue; // segment outside any conversation
        const [, label, clock, text] = segmentMatch;
        const segment: FusionSegmentInput = {
          speaker: label.trim(),
          isSelf: isSelfLabel(label),
          text,
          ...(clockToIso(clock, date) !== undefined
            ? { startIso: clockToIso(clock, date) }
            : {}),
        };
        current.segments.push(segment);
      }
      // Unrecognized lines (e.g. the H1 source header) are ignored.
    }
    flushCurrent();
  }

  return inputs;
}
