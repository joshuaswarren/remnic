/**
 * Meeting record composition, serialization, and the on-disk store (#1900).
 *
 * One markdown file per meeting under `<memoryDir>/meetings/<YYYY-MM-DD>/<id>.md`
 * with YAML frontmatter. Placement mirrors the wearables day-store rationale:
 *
 *   - OUTSIDE the memory scan roots (facts/, procedures/, …) so meeting
 *     transcripts never surface as memories in recall or governance passes;
 *   - INSIDE the QMD collection root (the memory dir) so records are full-text
 *     searchable after the next index update — but never auto-recalled raw.
 *
 * Records rebuild idempotently on `contentHash`: an unchanged meeting re-writes
 * nothing. The transcript body reuses the wearables day-store line grammar
 * (`**Name** [HH:MM]: text`, escape-aware) so existing parsers apply. File IO is
 * injected (like the fusion artifact store) so encrypted-at-rest + atomic-write
 * semantics are inherited without this module touching the secure-store key.
 */

import { createHash } from "node:crypto";
import * as path from "node:path";

import { pathIsInside } from "../utils/path-containment.js";
import { escapeSegmentText, escapeSpeakerLabel, isValidTranscriptDate } from "../wearables/day-store.js";
import type { FusedSegment } from "../wearables/fusion/types.js";
import type { FusedMeeting, MeetingDetectionSource, MeetingRecord } from "./types.js";

export const MEETINGS_DIR_NAME = "meetings";
export const MEETING_KIND = "meeting" as const;
export const MEETING_FORMAT_VERSION = 1;

/** `mtg-YYYY-MM-DD-<8 hex>` — the id shape derived by `meetingId`. */
const MEETING_ID_PATTERN = /^mtg-(\d{4}-\d{2}-\d{2})-[0-9a-f]{8}$/;

/** The detection-source label from a meeting id would be ambiguous, so validate
 *  an id AND confirm its embedded date matches the directory it lives under. */
export function meetingIdDate(id: string): string | null {
  const match = MEETING_ID_PATTERN.exec(id);
  return match === null ? null : match[1]!;
}

/** Base fields (identity + detection) a fused meeting is composed with. */
export interface MeetingRecordBase {
  id: string;
  date: string;
  startUtc: string;
  endUtc: string;
  app?: string;
  detectionSource: MeetingDetectionSource;
  title?: string;
}

/** Canonical semantic content hashed for idempotency (excludes contentHash). */
function canonicalContent(base: MeetingRecordBase, fused: FusedMeeting): string {
  return JSON.stringify({
    formatVersion: MEETING_FORMAT_VERSION,
    id: base.id,
    date: base.date,
    startUtc: base.startUtc,
    endUtc: base.endUtc,
    app: base.app ?? null,
    detectionSource: base.detectionSource,
    title: base.title ?? null,
    attendees: fused.attendees,
    sources: fused.sources,
    corroboratedBy: fused.corroboratedBy,
    screenContext: fused.screenContext,
    contextExcerpts: fused.contextExcerpts,
    transcript: fused.transcript,
    speakers: fused.speakers,
    snapshotCount: fused.snapshotCount,
  });
}

/** Compose a full meeting record (with contentHash) from its base + fused view. */
export function composeMeetingRecord(base: MeetingRecordBase, fused: FusedMeeting): MeetingRecord {
  const contentHash = createHash("sha256").update(canonicalContent(base, fused), "utf-8").digest("hex");
  return {
    ...base,
    ...fused,
    contentHash,
    formatVersion: MEETING_FORMAT_VERSION,
  };
}

function formatClockUtc(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "--:--";
  return new Date(ms).toISOString().slice(11, 16);
}

function renderTranscriptLine(segment: FusedSegment): string {
  const clock = formatClockUtc(segment.startIso ?? "");
  return `**${escapeSpeakerLabel(segment.speaker)}** [${clock}]: ${escapeSegmentText(segment.text)}`;
}

function frontmatterList(key: string, values: readonly string[]): string[] {
  if (values.length === 0) return [`${key}: []`];
  const lines = [`${key}:`];
  for (const value of values) lines.push(`  - ${JSON.stringify(value)}`);
  return lines;
}

/** Serialize a meeting record into its persisted markdown form. */
export function serializeMeetingRecord(record: MeetingRecord): string {
  const lines: string[] = ["---"];
  lines.push(`kind: ${MEETING_KIND}`);
  lines.push(`formatVersion: ${record.formatVersion}`);
  lines.push(`id: ${JSON.stringify(record.id)}`);
  lines.push(`date: ${JSON.stringify(record.date)}`);
  lines.push(`startUtc: ${JSON.stringify(record.startUtc)}`);
  lines.push(`endUtc: ${JSON.stringify(record.endUtc)}`);
  if (record.app !== undefined) lines.push(`app: ${JSON.stringify(record.app)}`);
  lines.push(`detectionSource: ${JSON.stringify(record.detectionSource)}`);
  if (record.title !== undefined) lines.push(`title: ${JSON.stringify(record.title)}`);
  lines.push(...frontmatterList("attendees", record.attendees));
  lines.push(...frontmatterList("sources", record.sources));
  lines.push(...frontmatterList("corroboratedBy", record.corroboratedBy));
  lines.push(`snapshotCount: ${record.snapshotCount}`);
  lines.push(`contentHash: ${JSON.stringify(record.contentHash)}`);
  lines.push("---");
  lines.push("");

  const heading = record.title !== undefined && record.title.length > 0 ? ` · ${record.title}` : "";
  lines.push(`# Meeting ${record.id}${heading}`);
  lines.push("");

  lines.push("## Attendees");
  lines.push("");
  if (record.attendees.length === 0) {
    lines.push("_None resolved._");
  } else {
    for (const attendee of record.attendees) lines.push(`- ${attendee}`);
  }
  lines.push("");

  if (record.screenContext.length > 0 || record.contextExcerpts.length > 0) {
    lines.push("## Screen context");
    lines.push("");
    for (const event of record.screenContext) {
      lines.push(`- [${event.clock}] ${event.label}`);
    }
    if (record.contextExcerpts.length > 0) {
      if (record.screenContext.length > 0) lines.push("");
      lines.push("Notable excerpts:");
      lines.push("");
      for (const excerpt of record.contextExcerpts) lines.push(`> ${excerpt.replace(/\n/g, " ")}`);
    }
    lines.push("");
  }

  lines.push("## Transcript");
  lines.push("");
  if (record.transcript.length === 0) {
    lines.push("_No transcript segments in this window._");
  } else {
    for (const segment of record.transcript) lines.push(renderTranscriptLine(segment));
  }
  lines.push("");

  return `${lines.join("\n")}`;
}

/** A meeting record's frontmatter, parsed for listing + idempotency checks. */
export interface MeetingRecordSummary {
  id: string;
  date: string;
  startUtc: string;
  endUtc: string;
  app?: string;
  detectionSource: string;
  title?: string;
  attendees: string[];
  sources: string[];
  corroboratedBy: string[];
  snapshotCount: number;
  contentHash: string;
}

function parseScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

/** Parse a meeting record's frontmatter. Returns null when the content is not a
 *  meeting record (wrong kind, missing frontmatter) so callers distinguish a
 *  non-record from a corrupt one. */
export function parseMeetingRecordSummary(raw: string): MeetingRecordSummary | null {
  if (!raw.startsWith("---\n")) return null;
  const closeIndex = raw.indexOf("\n---\n", 4);
  if (closeIndex === -1) return null;
  const frontmatter = raw.slice(4, closeIndex).split("\n");

  const scalars: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  let currentList: string | null = null;
  for (const line of frontmatter) {
    const listItem = /^ {2}- (.*)$/.exec(line);
    if (listItem !== null && currentList !== null) {
      lists[currentList]!.push(parseScalar(listItem[1]!));
      continue;
    }
    const kv = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line);
    if (kv === null) continue;
    const key = kv[1]!;
    const value = kv[2]!;
    if (value === "") {
      currentList = key;
      lists[key] = [];
    } else if (value === "[]") {
      currentList = null;
      lists[key] = [];
    } else {
      currentList = null;
      scalars[key] = value;
    }
  }

  if (scalars.kind !== undefined && parseScalar(scalars.kind) !== MEETING_KIND) return null;
  const id = scalars.id !== undefined ? parseScalar(scalars.id) : undefined;
  const contentHash = scalars.contentHash !== undefined ? parseScalar(scalars.contentHash) : undefined;
  if (id === undefined || contentHash === undefined) return null;

  return {
    id,
    date: scalars.date !== undefined ? parseScalar(scalars.date) : "",
    startUtc: scalars.startUtc !== undefined ? parseScalar(scalars.startUtc) : "",
    endUtc: scalars.endUtc !== undefined ? parseScalar(scalars.endUtc) : "",
    ...(scalars.app !== undefined ? { app: parseScalar(scalars.app) } : {}),
    detectionSource: scalars.detectionSource !== undefined ? parseScalar(scalars.detectionSource) : "",
    ...(scalars.title !== undefined ? { title: parseScalar(scalars.title) } : {}),
    attendees: lists.attendees ?? [],
    sources: lists.sources ?? [],
    corroboratedBy: lists.corroboratedBy ?? [],
    snapshotCount: scalars.snapshotCount !== undefined ? Number(scalars.snapshotCount) || 0 : 0,
    contentHash,
  };
}

/**
 * Encrypted-at-rest + atomic file IO the meeting record store needs. Satisfied
 * by StorageManager (which owns the secure-store key + atomic write path) and
 * injected so this module performs NO direct fs — records inherit the same
 * encrypted-at-rest + atomic-write semantics as memories. Same shape as the
 * fusion artifact store's IO port (kept per-module, not shared, so each store's
 * boundary stays explicit).
 */
export interface MeetingRecordFileIo {
  writeFile(filePath: string, content: string): Promise<void>;
  readFile(filePath: string): Promise<string>;
  readDir(dirPath: string): Promise<string[]>;
  deleteFile(filePath: string): Promise<void>;
  realpath(filePath: string): Promise<string>;
  lstat(filePath: string): Promise<{ isSymbolicLink: boolean }>;
}

/** Result of an idempotent record save. */
export interface MeetingSaveResult {
  path: string;
  /** False when the on-disk contentHash already matched (nothing rewritten). */
  written: boolean;
  contentHash: string;
}

/**
 * Owns the meeting record files under `<memoryDir>/meetings/<date>/<id>.md`.
 * Path construction, date/id validation, and symlink containment live here; the
 * bytes flow through the injected secure IO. Containment is anchored to the real
 * memory-dir root and mirrors the fusion artifact store (AGENTS.md pattern #3).
 */
export class MeetingRecordStore {
  private readonly meetingsDir: string;

  constructor(
    private readonly memoryDir: string,
    private readonly io: MeetingRecordFileIo,
  ) {
    this.meetingsDir = path.join(memoryDir, MEETINGS_DIR_NAME);
  }

  recordPath(date: string, id: string): string {
    if (!isValidTranscriptDate(date)) {
      throw new Error(`invalid meeting date '${String(date)}' — expected YYYY-MM-DD`);
    }
    const idDate = meetingIdDate(id);
    if (idDate === null) {
      throw new Error(`invalid meeting id '${String(id)}' — expected mtg-YYYY-MM-DD-<hash>`);
    }
    if (idDate !== date) {
      throw new Error(`meeting id '${id}' does not belong to date '${date}'`);
    }
    return path.join(this.meetingsDir, date, `${id}.md`);
  }

  /** Idempotently persist a record: skip the write when contentHash is unchanged. */
  async saveMeetingRecord(record: MeetingRecord): Promise<MeetingSaveResult> {
    const filePath = this.recordPath(record.date, record.id);
    await this.assertPathContained(filePath);
    const existing = await this.readRaw(filePath);
    if (existing !== null) {
      const summary = parseMeetingRecordSummary(existing);
      if (summary !== null && summary.contentHash === record.contentHash) {
        return { path: filePath, written: false, contentHash: record.contentHash };
      }
    }
    await this.io.writeFile(filePath, serializeMeetingRecord(record));
    return { path: filePath, written: true, contentHash: record.contentHash };
  }

  /** Read a stored record's raw markdown; null when absent. */
  async readMeetingRecord(date: string, id: string): Promise<string | null> {
    const filePath = this.recordPath(date, id);
    await this.assertPathContained(filePath);
    return this.readRaw(filePath);
  }

  /**
   * Read + parse every stored record for a day exactly ONCE, sorted by start
   * time (ascending, id tiebreak). The single day-read path both `listMeetingIds`
   * and `listMeetingSummaries` derive from — no record is read twice.
   */
  private async readDaySummaries(date: string): Promise<MeetingRecordSummary[]> {
    if (!isValidTranscriptDate(date)) {
      throw new Error(`invalid meeting date '${String(date)}' — expected YYYY-MM-DD`);
    }
    const dayDir = path.join(this.meetingsDir, date);
    await this.assertPathContained(dayDir);
    let entries: string[];
    try {
      entries = await this.io.readDir(dayDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const summaries: MeetingRecordSummary[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const id = entry.slice(0, -3);
      if (meetingIdDate(id) !== date) continue;
      const raw = await this.readMeetingRecord(date, id);
      if (raw === null) continue;
      const summary = parseMeetingRecordSummary(raw);
      if (summary !== null) summaries.push(summary);
    }
    summaries.sort((a, b) => (a.startUtc < b.startUtc ? -1 : a.startUtc > b.startUtc ? 1 : SORT_STR(a.id, b.id)));
    return summaries;
  }

  /** List meeting ids stored for a day, sorted by start time (ascending). */
  async listMeetingIds(date: string): Promise<string[]> {
    return (await this.readDaySummaries(date)).map((summary) => summary.id);
  }

  /** Read parsed summaries for a day, sorted by start time. */
  async listMeetingSummaries(date: string): Promise<MeetingRecordSummary[]> {
    return this.readDaySummaries(date);
  }

  /** List dates that have at least one stored meeting record, newest first. */
  async listMeetingDates(): Promise<string[]> {
    await this.assertPathContained(this.meetingsDir);
    let entries: string[];
    try {
      entries = await this.io.readDir(this.meetingsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const dates = entries.filter((entry) => isValidTranscriptDate(entry));
    dates.sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
    return dates;
  }

  /** Remove a stored record. Idempotent: a no-op when already absent. */
  async deleteMeetingRecord(date: string, id: string): Promise<void> {
    const filePath = this.recordPath(date, id);
    await this.assertPathContained(filePath);
    try {
      await this.io.deleteFile(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }

  private async readRaw(filePath: string): Promise<string | null> {
    try {
      return await this.io.readFile(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  private async assertPathContained(targetPath: string): Promise<void> {
    let rootReal: string;
    try {
      rootReal = await this.io.realpath(this.memoryDir);
    } catch {
      rootReal = path.resolve(this.memoryDir);
    }
    await this.assertNoEscape(rootReal, this.meetingsDir);
    await this.assertNoEscape(rootReal, path.dirname(targetPath));
    await this.assertNoEscape(rootReal, targetPath);
    // Reject a symlinked meetings root OR a symlinked intermediate day directory
    // outright — even when the link resolves inside the memory dir (aliasing /
    // tampering) — before any read/write (AGENTS.md pattern #3).
    await this.assertDirNotSymlinked(this.meetingsDir);
    const dayDir = this.dayDirWithin(targetPath);
    if (dayDir !== null) await this.assertDirNotSymlinked(dayDir);
  }

  /** The `<meetings>/<date>` directory on the path to `targetPath`, or null when
   *  `targetPath` is the meetings root itself. */
  private dayDirWithin(targetPath: string): string | null {
    const rel = path.relative(this.meetingsDir, targetPath);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    const first = rel.split(path.sep)[0];
    if (first === undefined || first.length === 0) return null;
    return path.join(this.meetingsDir, first);
  }

  private async assertDirNotSymlinked(dir: string): Promise<void> {
    let stat: { isSymbolicLink: boolean };
    try {
      stat = await this.io.lstat(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    if (stat.isSymbolicLink) {
      const label = path.relative(this.memoryDir, dir) || MEETINGS_DIR_NAME;
      throw new Error(
        `meetings directory '${label}' is a symbolic link — refusing to follow it even when it resolves inside the memory dir (AGENTS.md pattern #3)`,
      );
    }
  }

  private async assertNoEscape(rootReal: string, candidate: string): Promise<void> {
    let candidateReal: string;
    try {
      candidateReal = await this.io.realpath(candidate);
    } catch {
      return;
    }
    if (!pathIsInside(rootReal, candidateReal)) {
      throw new Error(
        "meeting record path resolves outside the memory dir — refusing to follow a symlink/traversal (AGENTS.md pattern #3)",
      );
    }
  }
}

const SORT_STR = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
