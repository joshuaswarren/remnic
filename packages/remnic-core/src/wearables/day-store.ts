/**
 * Wearable day-transcript composition and parsing.
 *
 * One markdown file per source per day, stored under
 * `<memoryDir>/wearables/<source>/<YYYY-MM-DD>.md` with YAML
 * frontmatter. The location is deliberate:
 *
 *  - it is OUTSIDE the memory scan roots (facts/, procedures/,
 *    reasoning-traces/, corrections/), so transcripts never appear as
 *    memories in recall or governance passes;
 *  - it is INSIDE the QMD collection root (the memory dir), so day
 *    transcripts are full-text searchable after the next index update.
 *
 * Files are rebuilt idempotently from provider data on every sync; the
 * body hash in frontmatter lets the pipeline skip rewriting (and
 * re-extracting) unchanged days.
 *
 * This module is pure composition/parsing — file IO lives in
 * `StorageManager` so encrypted-at-rest deployments and atomic write
 * semantics are inherited from the same code paths memories use.
 */

import { createHash } from "node:crypto";

import type { SpeakerRegistry } from "./speakers.js";
import { distinctSpeakerLabels, resolveSpeaker } from "./speakers.js";
import type {
  WearableConversation,
  WearableDayTranscript,
  WearableDayTranscriptMeta,
} from "./types.js";

export const WEARABLES_DIR_NAME = "wearables";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A rendered transcript segment line: `**label** [clock]: text`. Shared
 * by the composer (escape), the display/search decoder
 * (`decodeTranscriptBody`), and the fusion reconstruct parser so all
 * three agree on what a segment line is — no divergent parsing across
 * the view/search/index surfaces (#1849).
 */
export const TRANSCRIPT_SEGMENT_LINE = /^\*\*(.+?)\*\*\s\[(.+?)\]:\s(.*)$/;

export function isValidTranscriptDate(date: string): boolean {
  if (!DATE_PATTERN.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

export function hashTranscriptBody(body: string): string {
  return createHash("sha256").update(body, "utf-8").digest("hex");
}

function formatClockTime(iso: string | undefined, timezone: string): string {
  if (!iso) return "--:--";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "--:--";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(ms));
  } catch {
    // Unknown timezone identifiers fall back to UTC rather than
    // crashing a sync that already fetched data.
    return new Date(ms).toISOString().slice(11, 16);
  }
}

function conversationDurationMinutes(conversation: WearableConversation): number {
  const start = Date.parse(conversation.startIso);
  const end = conversation.endIso ? Date.parse(conversation.endIso) : NaN;
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return 0;
  return (end - start) / 60_000;
}

/**
 * Escape segment text for the line-based markdown format so that embedded
 * newlines, carriage returns, and backslashes survive the serialize →
 * reconstruct round-trip losslessly.  Reversed by `unescapeSegmentText`
 * (this module — the single decode primitive shared with the fusion
 * reconstruct path and every view/search/index surface).
 *
 * Without this, a segment whose text contains a newline is split across
 * multiple physical lines; the reconstruct path treats each line
 * independently and the continuation is silently dropped (or worse, a
 * continuation line that looks like a heading/clock is mis-parsed).
 */
function escapeSegmentText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

/**
 * Reverse `escapeSegmentText`. Unknown escape sequences (a lone
 * backslash followed by a character the escaper never emits) are passed
 * through literally so legacy transcripts that never went through the
 * escaper still round-trip their original text. This is the SINGLE
 * decode primitive: the fusion reconstruct path and every user-facing
 * view/search/index surface call it so escaped storage never leaks to
 * display (#1849).
 */
export function unescapeSegmentText(text: string): string {
  return text.replace(/\\(.)/g, (_match, ch: string) => {
    if (ch === "n") return "\n";
    if (ch === "r") return "\r";
    if (ch === "\\") return "\\";
    return "\\" + ch;
  });
}

/**
 * Decode the escaped segment text of a stored transcript body into the
 * ORIGINAL text for user-facing view/search/index surfaces. Only the
 * text portion of segment lines is decoded; headings, locations, and
 * the H1 header are NOT escaped on write and pass through unchanged, so
 * a title or location containing a literal backslash is never altered.
 * The fusion reconstruct path does NOT use this — it decodes each
 * segment once during parse — so callers feeding bodies back into
 * reconstruct must pass the RAW stored body, not a decoded one, to
 * avoid double-decoding.
 */
export function decodeTranscriptBody(body: string): string {
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = TRANSCRIPT_SEGMENT_LINE.exec(lines[i]);
    if (match === null) continue;
    const [, label, clock, rawText] = match;
    const decoded = unescapeSegmentText(rawText);
    if (decoded === rawText) continue;
    lines[i] = `**${label}** [${clock}]: ${decoded}`;
  }
  return lines.join("\n");
}

/** Compose the markdown body (no frontmatter) for one source/day. */
export function composeDayTranscriptBody(
  sourceId: string,
  date: string,
  timezone: string,
  conversations: WearableConversation[],
  registry: SpeakerRegistry,
): string {
  const lines: string[] = [];
  lines.push(`# ${sourceId} transcript — ${date}`);
  lines.push("");
  const ordered = [...conversations].sort((a, b) => {
    const aMs = Date.parse(a.startIso);
    const bMs = Date.parse(b.startIso);
    if (aMs < bMs) return -1;
    if (aMs > bMs) return 1;
    // Stable secondary key so equal start times order deterministically.
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  for (const conversation of ordered) {
    const start = formatClockTime(conversation.startIso, timezone);
    const end = formatClockTime(conversation.endIso, timezone);
    const title = conversation.title?.trim();
    const heading = title && title.length > 0 ? ` · ${title}` : "";
    lines.push(`## ${start}–${end}${heading} (conversation ${conversation.id})`);
    if (conversation.location) {
      lines.push(`*Location: ${conversation.location}*`);
    }
    lines.push("");
    for (const segment of conversation.segments) {
      const { label } = resolveSpeaker(sourceId, segment, registry);
      const at = formatClockTime(segment.startIso, timezone);
      lines.push(`**${label}** [${at}]: ${escapeSegmentText(segment.text)}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function composeDayTranscriptMeta(
  sourceId: string,
  date: string,
  timezone: string,
  conversations: WearableConversation[],
  registry: SpeakerRegistry,
  body: string,
  syncedAt: string,
): WearableDayTranscriptMeta {
  const allSegments = conversations.flatMap((c) => c.segments);
  const durationMinutes = Math.round(
    conversations.reduce((sum, c) => sum + conversationDurationMinutes(c), 0),
  );
  return {
    kind: "wearable-transcript",
    source: sourceId,
    date,
    timezone,
    conversationCount: conversations.length,
    segmentCount: allSegments.length,
    speakers: distinctSpeakerLabels(sourceId, allSegments, registry),
    durationMinutes,
    contentHash: hashTranscriptBody(body),
    syncedAt,
  };
}

/** Serialize meta + body into the persisted file format. */
export function serializeDayTranscript(
  meta: WearableDayTranscriptMeta,
  body: string,
): string {
  const lines: string[] = ["---"];
  lines.push(`kind: ${meta.kind}`);
  lines.push(`source: ${JSON.stringify(meta.source)}`);
  lines.push(`date: ${JSON.stringify(meta.date)}`);
  lines.push(`timezone: ${JSON.stringify(meta.timezone)}`);
  lines.push(`conversationCount: ${meta.conversationCount}`);
  lines.push(`segmentCount: ${meta.segmentCount}`);
  if (meta.speakers.length === 0) {
    lines.push("speakers: []");
  } else {
    lines.push("speakers:");
    for (const speaker of meta.speakers) {
      lines.push(`  - ${JSON.stringify(speaker)}`);
    }
  }
  lines.push(`durationMinutes: ${meta.durationMinutes}`);
  lines.push(`contentHash: ${JSON.stringify(meta.contentHash)}`);
  lines.push(`syncedAt: ${JSON.stringify(meta.syncedAt)}`);
  lines.push("---");
  lines.push("");
  return `${lines.join("\n")}${body}`;
}

/**
 * Parse a persisted day-transcript file. Returns null when the content
 * does not look like a wearable transcript (wrong kind, missing
 * frontmatter) so callers can distinguish "not a transcript" from a
 * read error.
 */
export function parseDayTranscript(raw: string): WearableDayTranscript | null {
  if (!raw.startsWith("---\n")) return null;
  const closeIndex = raw.indexOf("\n---\n", 4);
  if (closeIndex === -1) return null;
  const header = raw.slice(4, closeIndex);
  const body = raw.slice(closeIndex + 5).replace(/^\n/, "");

  const scalars = new Map<string, string>();
  const speakers: string[] = [];
  let inSpeakers = false;
  for (const line of header.split("\n")) {
    if (inSpeakers) {
      const item = line.match(/^ {2}- (.*)$/);
      if (item) {
        speakers.push(parseYamlScalar(item[1]));
        continue;
      }
      inSpeakers = false;
    }
    if (line === "speakers:") {
      inSpeakers = true;
      continue;
    }
    if (line === "speakers: []") continue;
    const match = line.match(/^([A-Za-z][A-Za-z0-9]*): (.*)$/);
    if (match) scalars.set(match[1], parseYamlScalar(match[2]));
  }

  if (scalars.get("kind") !== "wearable-transcript") return null;
  const source = scalars.get("source");
  const date = scalars.get("date");
  if (!source || !date) return null;

  const meta: WearableDayTranscriptMeta = {
    kind: "wearable-transcript",
    source,
    date,
    // Preserve a missing timezone field as "" rather than coercing to a
    // default: the fusion identity guard must see "no resolvable tz id"
    // and skip, never silently match a known zone.
    timezone: scalars.get("timezone") ?? "",
    conversationCount: parseNonNegativeInt(scalars.get("conversationCount")),
    segmentCount: parseNonNegativeInt(scalars.get("segmentCount")),
    speakers,
    durationMinutes: parseNonNegativeInt(scalars.get("durationMinutes")),
    contentHash: scalars.get("contentHash") ?? "",
    syncedAt: scalars.get("syncedAt") ?? "",
  };
  return { meta, body };
}

function parseYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
    } catch {
      // Fall through to the raw value below.
    }
  }
  return trimmed;
}

function parseNonNegativeInt(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}
