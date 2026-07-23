/**
 * Meeting memory generation (issue #1900, Phase 4).
 *
 * Layer 1 — the deterministic meeting EPISODE: one recall-anchor memory per
 * meeting ("what meetings did I have Tuesday?"), always written when
 * `meetings.enabled`, no LLM. Title, time span, attendees, and source list are
 * a pure function of the record, so an unchanged meeting is skipped by content
 * hash. Reuses the shared sealed-envelope composer + secure write path
 * (`composeMemoryEnvelope` / `writeSealedMemory`) — no bespoke memory format.
 *
 * The LLM summary/facts layer (decisions + commitments through the existing
 * trust pipeline) builds on this module in the trust-gated slice; it reuses the
 * same writer interface and the wearables judge/trust machinery rather than
 * forking it.
 */

import { scoreImportance } from "../importance.js";
import type { MemoryWriteResult } from "../storage.js";
import {
  composeMemoryEnvelope,
  type SealedMemoryEnvelope,
} from "../write-envelope.js";
import { log } from "../logger.js";
import type { ImportanceScore, MemoryStatus } from "../types.js";
import type { MeetingRecord } from "./types.js";

/** Frontmatter `source` prefix for meeting-derived memories. */
export const MEETING_SOURCE_PREFIX = "meeting";
/** `source: meeting:<id>` — walks memory → record → day transcripts. */
export function meetingSourceLabel(id: string): string {
  return `${MEETING_SOURCE_PREFIX}:${id}`;
}
/** `meeting-day:<date>` tag for day-scoped recall ("meetings on Tuesday"). */
export function meetingDayTag(date: string): string {
  return `meeting-day:${date}`;
}

/**
 * Narrow writer interface satisfied by `StorageManager` — the same sealed
 * write entry point the wearables generator uses, so meeting memories inherit
 * encrypted-at-rest + atomic write + dedup without this module knowing the key.
 */
export interface MeetingMemoryWriter {
  writeSealedMemory(
    envelope: SealedMemoryEnvelope,
    extras: {
      importance?: ImportanceScore;
      contentHashSource?: string;
      status?: MemoryStatus;
      memoryKind?: "episode" | "note" | "box" | "dream" | "procedural";
    },
  ): Promise<MemoryWriteResult>;
  /** True when a memory with this exact content already exists (idempotency). */
  hasFactContentHash(content: string): Promise<boolean>;
}

/** Render the deterministic episode content for a meeting. Pure. */
export function composeMeetingEpisodeContent(record: MeetingRecord): string {
  const clock = (iso: string): string => {
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? iso : new Date(ms).toISOString().slice(11, 16);
  };
  const app = record.app !== undefined && record.app.length > 0 ? ` (${record.app})` : "";
  const title = record.title !== undefined && record.title.length > 0 ? ` · ${record.title}` : "";
  const attendees = record.attendees.length > 0 ? record.attendees.join(", ") : "no attendees resolved";
  const sources = record.sources.length > 0 ? record.sources.join(", ") : "none";
  return (
    `Meeting ${record.id}${title} — ${record.date} ${clock(record.startUtc)}–${clock(record.endUtc)} UTC${app}.\n` +
    `Attendees: ${attendees}.\n` +
    `Transcript sources: ${sources}.`
  );
}

/**
 * Write the deterministic episode memory for one meeting. Idempotent: skips
 * when an identical episode already exists. Returns true when a new episode was
 * written. The episode is `active` (a recall anchor, not a trust-gated claim).
 */
export async function writeMeetingEpisodeMemory(
  record: MeetingRecord,
  writer: MeetingMemoryWriter,
): Promise<boolean> {
  const content = composeMeetingEpisodeContent(record);
  if (await writer.hasFactContentHash(content)) return false;

  const structuredAttributes: Record<string, string> = {
    meetingId: record.id,
    meetingDate: record.date,
    transcriptSources: record.sources.join(","),
  };
  if (record.app !== undefined) structuredAttributes.meetingApp = record.app;

  const envelope = composeMemoryEnvelope(
    {
      content,
      category: "moment",
      confidence: 0.9,
      tags: [MEETING_SOURCE_PREFIX, meetingDayTag(record.date)],
      validAt: record.startUtc,
      structuredAttributes,
    },
    { source: meetingSourceLabel(record.id) },
    { salvage: true },
  );
  if (envelope.salvageNotes.length > 0) {
    log.warn(`meeting episode write salvaged invalid fields: ${envelope.salvageNotes.join("; ")}`);
  }
  await writer.writeSealedMemory(envelope, {
    importance: scoreImportance(content, "moment", [MEETING_SOURCE_PREFIX]),
    contentHashSource: content,
    status: "active",
    memoryKind: "episode",
  });
  return true;
}

/** Result of generating episode memories for a day's meetings. */
export interface MeetingEpisodeGenResult {
  /** Episodes newly written. */
  written: number;
  /** Episodes skipped because an identical one already existed. */
  skipped: number;
}

/** Write one deterministic episode per record, idempotently. */
export async function generateMeetingEpisodes(
  records: readonly MeetingRecord[],
  writer: MeetingMemoryWriter,
): Promise<MeetingEpisodeGenResult> {
  let written = 0;
  let skipped = 0;
  for (const record of records) {
    if (await writeMeetingEpisodeMemory(record, writer)) written++;
    else skipped++;
  }
  return { written, skipped };
}
