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
 * Day-transcript body serialization format version. Folded into
 * `hashTranscriptBody` so a version bump invalidates files written by an
 * older serializer and forces an idempotent rewrite. Decoders gate on this:
 * only bodies whose parsed meta carries >= this version have escape
 * sequences decoded; legacy bodies (absent / older) are left byte-for-byte
 * unchanged so a literal two-character `\n`/`\r` in a pre-escaper
 * transcript is never altered (issue #1849).
 */
export const TRANSCRIPT_FORMAT_VERSION = 2;

/**
 * Result of parsing a rendered transcript segment line.
 */
export interface TranscriptSegmentMatch {
  /** Speaker label text between the `**` delimiters. */
  label: string;
  /** Clock text between the `[` `]` delimiters. */
  clock: string;
  /** Segment text after the colon. */
  text: string;
}

/**
 * Test a single character code point against the JavaScript regex `\s`
 * whitespace class without invoking a regex. Used by the linear segment
 * line parser so no quantified pattern is ever evaluated on untrusted
 * transcript content (CodeQL polynomial-redos, issue #1849).
 */
function isRegexWhitespace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/**
 * Parse a rendered transcript segment line (`**label** [clock]: text`)
 * into its three components using a linear, bounded scan — a CodeQL-safe
 * replacement for the polynomial-risk regex that previously matched this
 * format. Returns null when the line is not a segment line.
 *
 * The scan finds the FIRST occurrence of each structural delimiter
 * (`**` after the label, `]` after the clock) exactly as the original
 * non-greedy regex did, and verifies the fixed separator characters
 * (`\s`, `[`, `:`, `\s`) by single-character code-point comparison.
 * No quantified regex is evaluated on the line (#1849).
 *
 * Escaped labels (formatVersion >= 2) never contain an unescaped `**`,
 * `[`, or `]`, and rendered clocks are always `HH:MM` / `--:--`, so the
 * first delimiter is always the correct one for every well-formed
 * transcript. Legacy unescaped labels are used verbatim by the caller
 * and parsed identically here.
 */
export function parseTranscriptSegmentLine(
  line: string,
): TranscriptSegmentMatch | null {
  // Must start with '**'.
  if (!line.startsWith("**")) return null;

  // Find the closing '**' of the label: the first '**' at index >= 3
  // (label is at least 1 char) that is immediately followed by \s and
  // then '['. This mirrors the non-greedy regex: the engine tries the
  // shortest label first and extends only when the subsequent fixed
  // delimiters do not line up. An escaped label ending with '\*' is
  // correctly handled because the spurious '**' (escape-star + close-
  // star) is not followed by \s and the scan continues.
  let labelEnd = -1;
  for (let i = 3; i < line.length; i++) {
    if (
      line.charCodeAt(i) !== 0x2a /* '*' */ ||
      i + 3 >= line.length ||
      line.charCodeAt(i + 1) !== 0x2a /* '*' */ ||
      !isRegexWhitespace(line.charCodeAt(i + 2)) ||
      line.charCodeAt(i + 3) !== 0x5b /* '[' */
    ) {
      continue;
    }
    labelEnd = i;
    break;
  }
  if (labelEnd === -1) return null;

  const label = line.slice(2, labelEnd);
  // Clock content starts after the closing '**', the \s, and the '['.
  const clockStart = labelEnd + 4;

  // Find the closing ']' of the clock: the first ']' at index >=
  // clockStart + 1 (clock is at least 1 char) that is immediately
  // followed by ':' and \s — matching the non-greedy regex.
  let clockEnd = -1;
  for (let i = clockStart + 1; i < line.length; i++) {
    if (
      line.charCodeAt(i) !== 0x5d /* ']' */ ||
      i + 2 >= line.length ||
      line.charCodeAt(i + 1) !== 0x3a /* ':' */ ||
      !isRegexWhitespace(line.charCodeAt(i + 2))
    ) {
      continue;
    }
    clockEnd = i;
    break;
  }
  if (clockEnd === -1) return null;

  return {
    label,
    clock: line.slice(clockStart, clockEnd),
    text: line.slice(clockEnd + 3),
  };
}

export function isValidTranscriptDate(date: string): boolean {
  if (!DATE_PATTERN.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

export function hashTranscriptBody(body: string): string {
  // The version prefix makes the hash an idempotency key for the body AS
  // SERIALIZED under the current format: when the escape encoding changes
  // (version bump) every existing file's stored hash no longer matches and
  // the pipeline rewrites it with the new marker — no separate migration
  // pass needed (issue #1849).
  return createHash("sha256")
    .update(`v${TRANSCRIPT_FORMAT_VERSION}\n${body}`, "utf-8")
    .digest("hex");
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
export function escapeSegmentText(text: string): string {
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
 * Escape a speaker label for the line-based markdown format so that
 * markdown-delimiter characters in an arbitrary user/provider label
 * (`**`, `[`, `]`), the escape character (`\`), and embedded newlines/
 * carriage returns cannot break `parseTranscriptSegmentLine` parsing.
 * Without this, a label containing `**` (or `** [clock]:`) can make the
 * non-greedy delimiter match land on the wrong `**` and mis-parse the
 * clock/text — or fail to parse the line at all. Reversed by
 * `unescapeSpeakerLabel` (this module). Legacy transcripts whose labels
 * were never escaped still parse: `unescapeSpeakerLabel` is a no-op on
 * any label without a backslash escape sequence (#1849).
 */
export function escapeSpeakerLabel(label: string): string {
  return label
    .replace(/\\/g, "\\\\")
    .replace(/\*/g, "\\*")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

/**
 * Reverse `escapeSpeakerLabel`. Unknown escape sequences (a backslash
 * followed by a character the escaper never emits) are passed through
 * literally so legacy transcripts with raw labels still round-trip
 * their original text, mirroring `unescapeSegmentText` for segment text.
 */
export function unescapeSpeakerLabel(label: string): string {
  return label.replace(/\\(.)/g, (_match, ch: string) => {
    if (ch === "\\") return "\\";
    if (ch === "*") return "*";
    if (ch === "[") return "[";
    if (ch === "]") return "]";
    if (ch === "n") return "\n";
    if (ch === "r") return "\r";
    return "\\" + ch;
  });
}

/**
 * Whether a parsed day-transcript's body was written by the escape-aware
 * serializer (meta carries `formatVersion` >= `TRANSCRIPT_FORMAT_VERSION`).
 * Legacy bodies (no marker, or an older version) must NOT be decoded: their
 * literal two-character `\n`, `\r`, and lone backslashes are original
 * content, not escape sequences (issue #1849).
 */
export function bodyIsEscaped(
  meta: { formatVersion?: number } | null | undefined,
): boolean {
  return (
    meta !== null &&
    meta !== undefined &&
    typeof meta.formatVersion === "number" &&
    meta.formatVersion >= TRANSCRIPT_FORMAT_VERSION
  );
}

/**
 * Decode the escaped segment text AND speaker label of a stored
 * transcript body into the ORIGINAL forms for user-facing
 * view/search/index surfaces. Only segment lines are touched: the text
 * is decoded via `unescapeSegmentText` and the label via
 * `unescapeSpeakerLabel`; headings, locations, and the H1 header are
 * NOT escaped on write and pass through unchanged, so a title or
 * location containing a literal backslash is never altered. The fusion
 * reconstruct path does NOT use this — it decodes each segment once
 * during parse — so callers feeding bodies back into reconstruct must
 * pass the RAW stored body, not a decoded one, to avoid double-decoding.
 *
 * FORMAT-AWARE (issue #1849): when `escaped` is falsy (the default) the
 * body is returned byte-for-byte unchanged. Only bodies written by the
 * escape-aware serializer (`escaped = true`, derived from
 * `bodyIsEscaped(meta)`) are decoded, so a legacy transcript's literal
 * two-character `\n`/`\r` or lone backslash is never altered. Callers
 * that have the parsed meta should pass `bodyIsEscaped(meta)`.
 */
export function decodeTranscriptBody(body: string, escaped = false): string {
  if (!escaped) return body;
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = parseTranscriptSegmentLine(lines[i]);
    if (match === null) continue;
    const { label, clock, text: rawText } = match;
    const decodedText = unescapeSegmentText(rawText);
    const decodedLabel = unescapeSpeakerLabel(label);
    if (decodedText === rawText && decodedLabel === label) continue;
    lines[i] = `**${decodedLabel}** [${clock}]: ${decodedText}`;
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
      lines.push(
        `**${escapeSpeakerLabel(label)}** [${at}]: ${escapeSegmentText(segment.text)}`,
      );
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
    formatVersion: TRANSCRIPT_FORMAT_VERSION,
  };
}

/** Serialize meta + body into the persisted file format. */
export function serializeDayTranscript(
  meta: WearableDayTranscriptMeta,
  body: string,
): string {
  const lines: string[] = ["---"];
  lines.push(`kind: ${meta.kind}`);
  if (typeof meta.formatVersion === "number") {
    lines.push(`formatVersion: ${meta.formatVersion}`);
  }
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
    ...(scalars.has("formatVersion")
      ? { formatVersion: parseNonNegativeInt(scalars.get("formatVersion")) }
      : {}),
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
