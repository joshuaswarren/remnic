
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { log } from "./logger.js";
import { isAbortError, throwIfAborted } from "./abort-error.js";
import { withBriefingDeadline } from "./briefing-deadline.js";
import { withBriefingFollowupTimeout } from "./briefing-followup-timeout.js";
import { extractJsonCandidates } from "./json-extract.js";
import { drainPassiveCorrectionNotifications } from "./correction/passive-correction-notifications.js";
import { excludeSupportPassportPrivateMemories } from "./support-passport/card-projection.js";
import { normalizeEntityName, StorageManager } from "./storage.js";
import { safeReadEntities, safeReadMemories } from "./briefing-window.js";
import { readEnvVar, resolveHomeDir } from "./runtime/env.js";
import type {
  BriefingActiveThread,
  BriefingCalendarSourceError,
  BriefingFocus,
  BriefingFollowup,
  BriefingOpenCommitment,
  BriefingRecentEntity,
  BriefingResult,
  BriefingSections,
  CalendarEvent,
  CalendarSource,
  EntityFile,
  MemoryFile,
} from "./types.js";


export const BRIEFING_FORMAT_ALLOWED = ["markdown", "json"] as const;

/**
 * Default model used for the Responses API follow-up generation call.
 * Mirrors the extraction engine default in config.ts — keep in sync.
 */
export const BRIEFING_FOLLOWUP_DEFAULT_MODEL = "gpt-5.5";
export type BriefingFormatValue = typeof BRIEFING_FORMAT_ALLOWED[number];

/**
 * Validate a user-supplied `--format` flag value.
 * Returns `null` when the value is valid (or `undefined`, meaning the flag
 * was not supplied and the caller should fall back to the configured default).
 * Returns an error message string when the value is explicitly invalid.
 */
export function validateBriefingFormat(value: string | undefined): string | null {
  if (value === undefined) return null;
  if ((BRIEFING_FORMAT_ALLOWED as readonly string[]).includes(value)) return null;
  return `Invalid --format value: "${value}". Accepted: ${BRIEFING_FORMAT_ALLOWED.join(", ")}.`;
}

export interface ParsedBriefingWindow {
  /** Start of the window (inclusive). */
  from: Date;
  /** End of the window (exclusive). */
  to: Date;
  label: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const MAX_WINDOW_MS = 100 * 365 * DAY_MS;

/**
 * Parse a CLI-friendly window token into a concrete date range.
 *
 * Accepted forms (case-insensitive):
 *   - `yesterday` — the previous UTC calendar day.
 *   - `today`    — the current UTC calendar day so far.
 *   - `NNh`      — last N hours (e.g. `24h`, `48h`).
 *   - `NNd`      — last N calendar days (e.g. `3d`, `7d`).
 *   - `NNw`      — last N weeks (e.g. `1w`, `2w`).
 *
 * Returns `null` for invalid tokens so callers can surface a clean error.
 */
export function parseBriefingWindow(
  token: string,
  now: Date = new Date(),
): ParsedBriefingWindow | null {
  const raw = typeof token === "string" ? token.trim().toLowerCase() : "";
  if (raw.length === 0) return null;

  if (raw === "yesterday") {
    const startOfToday = startOfUtcDay(now);
    const from = new Date(startOfToday.getTime() - DAY_MS);
    return { from, to: startOfToday, label: "yesterday" };
  }

  if (raw === "today") {
    return { from: startOfUtcDay(now), to: now, label: "today" };
  }

  const match = raw.match(/^(\d+)\s*(h|d|w)$/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = match[2];
  let ms = 0;
  if (unit === "h") ms = value * 60 * 60 * 1000;
  else if (unit === "d") ms = value * DAY_MS;
  else if (unit === "w") ms = value * 7 * DAY_MS;
  if (ms === 0) return null;
  if (ms > MAX_WINDOW_MS || !Number.isFinite(ms)) return null;
  const from = new Date(now.getTime() - ms);
  if (!Number.isFinite(from.getTime())) return null;
  return {
    from,
    to: now,
    label: `last ${value}${unit}`,
  };
}

function startOfUtcDay(date: Date): Date {
  const d = new Date(date.getTime());
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

/**
 * Parse a CLI `--focus` string into a structured focus filter.
 *
 * Accepted forms:
 *   - `person:Jane Doe`
 *   - `project:remnic-core`
 *   - `topic:retrieval`
 *
 * If no prefix is supplied, falls back to `topic:<value>`.
 */
export function parseBriefingFocus(token: string | undefined): BriefingFocus | null {
  if (typeof token !== "string") return null;
  const trimmed = token.trim();
  if (trimmed.length === 0) return null;
  const [maybeType, ...rest] = trimmed.split(":");
  if (rest.length === 0) {
    return { type: "topic", value: maybeType };
  }
  const rawType = maybeType.toLowerCase();
  if (rawType === "person" || rawType === "project" || rawType === "topic") {
    const value = rest.join(":").trim();
    if (value.length === 0) return null;
    return { type: rawType, value };
  }
  return { type: "topic", value: trimmed };
}

export function focusMatchesMemory(
  memory: MemoryFile,
  focus: BriefingFocus,
  entityAliases?: Readonly<Record<string, string>>,
): boolean {
  const needle = focus.value.toLowerCase();
  const entityRef = (memory.frontmatter.entityRef ?? "").toLowerCase();

  const rawHaystackParts = [
    memory.content,
    ...(memory.frontmatter.tags ?? []),
  ];
  if (focus.type === "topic" && entityRef) {
    rawHaystackParts.push(entityRef);
  }
  const rawHaystack = rawHaystackParts.join(" ").toLowerCase();
  if (rawHaystack.includes(needle)) return true;

  if (!entityRef) return false;
  const focusCanonical = normalizeEntityName(focus.value, focus.type, entityAliases);
  let refForNormalize = entityRef;
  const typeDelimMatch = refForNormalize.match(
    new RegExp(`^${focus.type}[^a-z0-9]+`, "i"),
  );
  if (typeDelimMatch) {
    refForNormalize = refForNormalize.slice(typeDelimMatch[0].length);
  }
  const refCanonical = normalizeEntityName(refForNormalize, focus.type, entityAliases);
  return refCanonical === focusCanonical;
}

export function focusMatchesEntity(entity: EntityFile, focus: BriefingFocus): boolean {
  const needle = focus.value.toLowerCase();
  if (focus.type === "person" && entity.type.toLowerCase() !== "person") return false;
  if (focus.type === "project" && entity.type.toLowerCase() !== "project") return false;
  const haystack = [
    entity.name,
    entity.synthesis || entity.summary || "",
    ...entity.facts,
    ...(entity.aliases ?? []),
    ...(entity.structuredSections ?? []).flatMap((section) => [section.title, ...section.facts]),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

/**
 * Stub `CalendarSource` backed by a single local file. Supports:
 *   - JSON files containing an array of `CalendarEvent` records, OR a wrapper
 *     `{ events: CalendarEvent[] }` object.
 *   - Minimal ICS (`.ics`) files — extracts `VEVENT` blocks with `SUMMARY`,
 *     `DTSTART`, `DTEND`, `LOCATION`, `DESCRIPTION`, `UID`.
 *
 * Real calendar integrations (Google, iCloud, Microsoft) can plug into the
 * same `CalendarSource` interface later.
 */
export class FileCalendarSource implements CalendarSource {
  constructor(private readonly filePath: string) {}

  async eventsForDate(dateIso: string): Promise<CalendarEvent[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf-8");
    } catch (err) {
      log.warn(`briefing: calendar source unreadable at ${this.filePath}: ${err}`);
      return [];
    }

    const events = this.filePath.toLowerCase().endsWith(".ics")
      ? parseIcsEvents(raw)
      : parseJsonEvents(raw);

    return events.filter((event) => eventFallsOnDate(event, dateIso));
  }
}

function parseJsonEvents(raw: string): CalendarEvent[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const arr = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { events?: unknown }).events)
        ? ((parsed as { events: unknown[] }).events)
        : [];
    const events: CalendarEvent[] = [];
    for (const entry of arr) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const id = typeof e.id === "string" ? e.id : typeof e.uid === "string" ? e.uid : cryptoRandomId();
      const title = typeof e.title === "string" ? e.title : typeof e.summary === "string" ? e.summary : "";
      const start = typeof e.start === "string" ? e.start : typeof e.dtstart === "string" ? e.dtstart : "";
      if (!title || !start) continue;
      events.push({
        id,
        title,
        start,
        end: typeof e.end === "string" ? e.end : typeof e.dtend === "string" ? e.dtend : undefined,
        location: typeof e.location === "string" ? e.location : undefined,
        notes: typeof e.notes === "string" ? e.notes : typeof e.description === "string" ? e.description : undefined,
      });
    }
    return events;
  } catch (err) {
    log.warn(`briefing: calendar JSON parse failed: ${err}`);
    return [];
  }
}

interface IcsParsedLine {
  property: string;
  params: Record<string, string>;
  value: string;
}

/**
 * Parse a single ICS content line into its property, parameters, and value.
 * Returns null if the line is not a well-formed property line.
 *
 * Example:
 *   `DTSTART;TZID=America/New_York:20260411T233000`
 *   → { property: "DTSTART", params: { TZID: "America/New_York" }, value: "20260411T233000" }
 */
function parseIcsLine(line: string): IcsParsedLine | null {
  // Find the first `:` outside of any parameter value. Per RFC 5545 parameter
  // values may be quoted, but the minimal-parser use case here only needs to
  // handle unquoted TZID values.
  const colonIdx = line.indexOf(":");
  if (colonIdx <= 0) return null;
  const head = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1).trim();
  const headParts = head.split(";");
  const property = headParts[0]!.toUpperCase();
  if (!/^[A-Z0-9-]+$/.test(property)) return null;
  const params: Record<string, string> = {};
  for (let i = 1; i < headParts.length; i++) {
    const segment = headParts[i]!;
    const eqIdx = segment.indexOf("=");
    if (eqIdx <= 0) continue;
    const name = segment.slice(0, eqIdx).toUpperCase();
    let val = segment.slice(eqIdx + 1);
    // Strip surrounding quotes if present (RFC 5545 §3.1).
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      val = val.slice(1, -1);
    }
    params[name] = val;
  }
  return { property, params, value };
}

interface IcsDateField {
  raw: string;
  params: Record<string, string>;
}

/** @internal — exported for testing only. */
export function parseIcsEvents(raw: string): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  // RFC 5545 §3.1 line unfolding: a CRLF (now \n) followed by a single
  // whitespace character (space or tab) is a fold — remove both characters
  // to join the continuation onto the preceding logical line.  This MUST
  // happen after normalising CRLF → \n and BEFORE splitting on \n.
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
  const blocks = normalized.split(/BEGIN:VEVENT/i).slice(1);
  for (const block of blocks) {
    const endIdx = block.search(/END:VEVENT/i);
    const body = endIdx === -1 ? block : block.slice(0, endIdx);
    const simpleFields: Record<string, string> = {};
    const dateFields: Record<string, IcsDateField> = {};
    for (const line of body.split("\n")) {
      const parsed = parseIcsLine(line);
      if (!parsed) continue;
      const { property, params, value } = parsed;
      if (property === "DTSTART" || property === "DTEND") {
        if (dateFields[property] === undefined) {
          dateFields[property] = { raw: value, params };
        }
      } else if (simpleFields[property] === undefined) {
        simpleFields[property] = value;
      }
    }
    const title = simpleFields.SUMMARY;
    const dtstart = dateFields.DTSTART;
    if (!title || !dtstart) continue;
    const dtend = dateFields.DTEND;
    events.push({
      id: simpleFields.UID ?? cryptoRandomId(),
      title,
      start: normalizeIcsDate(dtstart.raw, dtstart.params),
      end: dtend ? normalizeIcsDate(dtend.raw, dtend.params) : undefined,
      location: simpleFields.LOCATION,
      notes: simpleFields.DESCRIPTION,
    });
  }
  return events;
}

/**
 * Normalise an ICS date/datetime value (optionally with a `TZID` parameter)
 * into an ISO 8601 string that downstream code can compare unambiguously.
 *
 * Behaviour:
 *   - `20260411T150000Z` → `2026-04-11T15:00:00Z`
 *   - `20260411` → `2026-04-11T00:00:00Z` (date-only events are day-boundaries)
 *   - `20260411T150000` (floating, no Z, no TZID) → `2026-04-11T15:00:00` (floating)
 *   - `20260411T233000` with `TZID=America/New_York` → `2026-04-12T03:30:00Z`
 *     (applies the zone offset at that wallclock time; DST-aware via Intl)
 *   - Unknown TZID falls back to UTC with a logged warning (conservative:
 *     the event still appears, but on the UTC date).
 */
function normalizeIcsDate(value: string, params: Record<string, string> = {}): string {
  if (/^\d{8}T\d{6}Z$/.test(value)) {
    const y = value.slice(0, 4);
    const m = value.slice(4, 6);
    const d = value.slice(6, 8);
    const hh = value.slice(9, 11);
    const mm = value.slice(11, 13);
    const ss = value.slice(13, 15);
    return `${y}-${m}-${d}T${hh}:${mm}:${ss}Z`;
  }
  if (/^\d{8}T\d{6}$/.test(value)) {
    const y = value.slice(0, 4);
    const m = value.slice(4, 6);
    const d = value.slice(6, 8);
    const hh = value.slice(9, 11);
    const mm = value.slice(11, 13);
    const ss = value.slice(13, 15);
    const local = `${y}-${m}-${d}T${hh}:${mm}:${ss}`;
    const tzid = params.TZID;
    if (tzid) {
      const utcIso = icsWallclockToUtc(local, tzid);
      if (utcIso) return utcIso;
      log.warn(
        `briefing: unsupported TZID "${tzid}" — treating as UTC for ${local}`,
      );
      return `${local}Z`;
    }
    // No TZID → floating. Downstream compares the date slice directly.
    return local;
  }
  // Date-only (all-day event). Date-only values carry no TZID per RFC 5545.
  if (/^\d{8}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00Z`;
  }
  return value;
}

/**
 * Convert a wallclock local datetime in a named IANA timezone to a UTC ISO
 * string. Returns null if the timezone is unsupported by the runtime.
 *
 * Implementation note: this is the standard "invert the formatter" technique.
 * We treat the local wallclock as though it were UTC, ask the runtime what
 * time that instant shows in the target zone, and the delta is the zone's
 * offset at that wallclock moment (DST-aware).
 */
function icsWallclockToUtc(local: string, tzid: string): string | null {
  const match = local.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, y, mo, d, hh, mm, ss] = match;
  const naiveUtcMs = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(hh),
    Number(mm),
    Number(ss),
  );
  if (!Number.isFinite(naiveUtcMs)) return null;

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tzid,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return null;
  }

  const zonedMs = zonedFormatToMs(formatter, new Date(naiveUtcMs));
  if (zonedMs === null) return null;
  const offsetMs = naiveUtcMs - zonedMs;
  const realUtcMs = naiveUtcMs + offsetMs;
  const zonedMs2 = zonedFormatToMs(formatter, new Date(realUtcMs));
  if (zonedMs2 !== null) {
    const offsetMs2 = realUtcMs - zonedMs2;
    if (offsetMs2 !== offsetMs) {
      return new Date(naiveUtcMs + offsetMs2).toISOString();
    }
  }
  return new Date(realUtcMs).toISOString();
}

/**
 * Format a Date in the given timezone and return the absolute ms timestamp
 * of that wallclock time interpreted as if it were UTC. Used only by
 * `icsWallclockToUtc` to compute zone offsets.
 */
function zonedFormatToMs(formatter: Intl.DateTimeFormat, date: Date): number | null {
  const parts = formatter.formatToParts(date);
  const get = (type: string): string | undefined =>
    parts.find((p) => p.type === type)?.value;
  const y = get("year");
  const mo = get("month");
  const d = get("day");
  const hh = get("hour");
  const mm = get("minute");
  const ss = get("second");
  if (!y || !mo || !d || !hh || !mm || !ss) return null;
  // RFC 5545 / Intl edge-case: some runtimes return `hour: "24"` for midnight
  // while keeping the same calendar day (instead of returning hour=0 with the
  // next day).  Passing 24 straight to Date.UTC would roll the date forward by
  // one day, producing a 24-hour-skewed offset in icsWallclockToUtc and
  // shifting TZID midnight events to the wrong briefing day.  Normalise to 0
  // and leave the date component unchanged.
  const normalizedHour = Number(hh) === 24 ? 0 : Number(hh);
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), normalizedHour, Number(mm), Number(ss));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Returns true when `isoStr` has an explicit UTC or numeric offset suffix
 * (Z, ±HH:MM, or ±HHMM).  Floating datetimes produced by `normalizeIcsDate`
 * have no such suffix.
 */
function isoHasTimezone(isoStr: string): boolean {
  return /(Z|[+-]\d{2}:?\d{2})$/.test(isoStr);
}

/**
 * Parse an ISO datetime string (UTC-aware or floating) to milliseconds since
 * epoch, or `null` if the string is not a valid datetime.
 *
 * - UTC / offset-aware strings are passed directly to `new Date()`.
 * - Floating strings (no timezone suffix) are interpreted as UTC so that
 *   interval arithmetic uses the same epoch base as UTC-aware strings.
 *   The caller is responsible for using the correct date-boundary constants.
 */
function isoToMs(isoStr: string): number | null {
  if (!isoStr) return null;
  let src = isoStr;
  if (!isoHasTimezone(src)) {
    src = src + "Z";
  }
  const ms = new Date(src).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** @internal — exported for testing only. */
export function eventFallsOnDate(event: CalendarEvent, dateIso: string): boolean {
  const target = dateIso.slice(0, 10);
  const start = event.start;

  // Floating ICS datetime (no Z, no offset): `normalizeIcsDate` produces
  // "YYYY-MM-DDTHH:MM:SS" with no timezone. Passing this to `new Date()`
  // causes ECMAScript to parse it as local time, which then round-trips
  // through UTC via `toISOString()` and can shift the calendar date.
  // For floating times we compare date portions directly (no epoch arithmetic).
  const startIsFloating = !isoHasTimezone(start);

  if (startIsFloating) {
    const startShapeOk =
      typeof start === "string" &&
      /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/.test(start);
    if (!startShapeOk) {
      log.debug(`briefing: skipping calendar event with invalid start value: ${JSON.stringify(start)}`);
      return false;
    }
    const startDateStr = start.slice(0, 10);
    const startDateProbe = new Date(startDateStr + "T00:00:00Z");
    if (
      Number.isNaN(startDateProbe.getTime()) ||
      startDateProbe.toISOString().slice(0, 10) !== startDateStr
    ) {
      log.warn(
        `briefing: skipping calendar event "${event.title}" with impossible start date ${JSON.stringify(startDateStr)}`,
      );
      return false;
    }
    const startRawTime = start.indexOf("T") !== -1 ? start.slice(start.indexOf("T") + 1) : "";
    if (startRawTime !== "") {
      const startTimeParts = startRawTime.split(":").map(Number);
      const shh = startTimeParts[0] ?? 0;
      const smm = startTimeParts[1] ?? 0;
      const sss = Math.floor(startTimeParts[2] ?? 0);
      if (shh > 23 || smm > 59 || sss > 59) {
        log.warn(
          `briefing: skipping calendar event "${event.title}" with out-of-range start time ${JSON.stringify(startRawTime)}`,
        );
        return false;
      }
    }

    const startDate = startDateStr;
    const end = event.end;

    if (!end) return startDate === target;

    const endIsValid =
      typeof end === "string" &&
      /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/.test(end);
    if (!endIsValid) {
      log.warn(
        `briefing: event "${event.title}" has malformed end timestamp ${JSON.stringify(end)}; treating as single-day event at ${startDate}`,
      );
      return startDate === target;
    }

    const endDate = end.slice(0, 10);
    const endDateProbe = new Date(endDate + "T00:00:00Z");
    if (
      Number.isNaN(endDateProbe.getTime()) ||
      endDateProbe.toISOString().slice(0, 10) !== endDate
    ) {
      log.warn(
        `briefing: event "${event.title}" has impossible end date ${JSON.stringify(endDate)}; treating as single-day event at ${startDate}`,
      );
      return startDate === target;
    }

    const rawTime = end.indexOf("T") !== -1 ? end.slice(end.indexOf("T") + 1) : "";
    if (rawTime !== "") {
      const timeParts = rawTime.split(":").map(Number);
      const hh = timeParts[0] ?? 0;
      const mm = timeParts[1] ?? 0;
      const ss = Math.floor(timeParts[2] ?? 0);
      const timeIsValid = hh <= 23 && mm <= 59 && ss <= 59;
      if (!timeIsValid) {
        log.warn(
          `briefing: event "${event.title}" has out-of-range end time ${JSON.stringify(rawTime)}; treating as single-day event at ${startDate}`,
        );
        return startDate === target;
      }
    }

    //
    //
    //
    const endTime = end.slice(11); // "HH:MM", "HH:MM:SS", "HH:MM:SS.mmm", or "" (date-only)
    const endIsDateOnly = endTime === "";
    const endAtExactMidnight = endIsDateOnly || /^00(:00){1,2}(\.0+)?$/.test(endTime);
    const endActiveOnEndDay = !endAtExactMidnight;
    if (endActiveOnEndDay) {
      return startDate <= target && target <= endDate;
    }
    return startDate <= target && target < endDate;
  }

  const startMs = isoToMs(start);
  if (startMs === null) {
    log.debug(`briefing: skipping calendar event with invalid start value: ${JSON.stringify(start)}`);
    return false;
  }

  const dayStart = Date.UTC(
    Number(target.slice(0, 4)),
    Number(target.slice(5, 7)) - 1,
    Number(target.slice(8, 10)),
  );
  const dayEnd = dayStart + 86_400_000; // +24 h

  const end = event.end;
  if (!end) {
    return startMs >= dayStart && startMs < dayEnd;
  }

  const endMs = isoToMs(end);
  if (endMs === null) {
    return startMs >= dayStart && startMs < dayEnd;
  }

  return startMs < dayEnd && endMs > dayStart;
}

function cryptoRandomId(): string {
  return `evt-${Math.random().toString(36).slice(2, 10)}`;
}

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

/** Dependency-injection hook for LLM follow-up generation (used in tests). */
export type BriefingFollowupGenerator = (
  prompt: {
    sections: BriefingSections;
    windowLabel: string;
    maxFollowups: number;
  },
) => Promise<BriefingFollowup[]>;

export interface BuildBriefingOptions {
  /** Workspace-scoped storage. Tests pass a temp dir. */
  storage: StorageManager;
  /** Parsed window. If omitted, a default 1-day window is used. */
  window?: ParsedBriefingWindow;
  /** Optional focus filter. */
  focus?: BriefingFocus | null;
  /** Optional namespace hint for logging. */
  namespace?: string;
  /** Calendar source. Section omitted entirely when undefined. */
  calendarSource?: CalendarSource;
  /** Maximum LLM follow-ups (0 to disable the section). */
  maxFollowups?: number;
  /** Whether the module is allowed to invoke the Responses API. */
  allowLlm?: boolean;
  /** OpenAI API key. If absent the follow-up section is gracefully omitted. */
  openaiApiKey?: string;
  /** OpenAI-compatible base URL (for Azure or proxied endpoints). */
  openaiBaseUrl?: string;
  /** Model id for the Responses call. */
  model?: string;
  /** Injected follow-up generator. Overrides real LLM call (tests). */
  followupGenerator?: BriefingFollowupGenerator;
  /** Injected "now" — makes tests deterministic. */
  now?: Date;
  /** Caller cancellation must not consume correction notifications. */
  abortSignal?: AbortSignal;
}

const MAX_ACTIVE_THREADS = 8;
const MAX_RECENT_ENTITIES = 8;
const MAX_OPEN_COMMITMENTS = 8;

/**
 * Build the daily context briefing.
 *
 * Never throws on LLM failures — the suggested follow-ups section is simply
 * omitted and `followupsUnavailableReason` is set.
 */
export async function buildBriefing(options: BuildBriefingOptions): Promise<BriefingResult> {
  return withBriefingDeadline(
    (signal) => buildBriefingWithSignal(options, signal),
    options.abortSignal,
  );
}

async function buildBriefingWithSignal(options: BuildBriefingOptions, signal: AbortSignal): Promise<BriefingResult> {
  const now = options.now ?? new Date();
  const window = options.window ?? defaultWindow(now);
  const maxFollowups = clampFollowups(options.maxFollowups);
  const focus = options.focus ?? null;

  const [allMemories, allEntities] = await Promise.all([
    safeReadMemories(options.storage, window, { signal }).then(excludeSupportPassportPrivateMemories),
    safeReadEntities(options.storage, signal),
  ]);
  throwIfAborted(signal, "briefing aborted");

  const memoriesInWindow = filterMemoriesByWindow(allMemories, window);
  const focusedMemories = focus
    ? memoriesInWindow.filter((m) => focusMatchesMemory(m, focus, options.storage.entityAliases))
    : memoriesInWindow;

  const activeThreads = buildActiveThreads(focusedMemories);
  const recentEntities = buildRecentEntities(allEntities, window, focus);
  const openCommitments = buildOpenCommitments(focusedMemories);

  const calendarLoadResult = options.calendarSource
    ? await loadTodayCalendar(options.calendarSource, now)
    : undefined;
  throwIfAborted(signal, "briefing aborted");

  const calendarSourceErrors: BriefingCalendarSourceError[] =
    calendarLoadResult?.error ? [calendarLoadResult.error] : [];

  const sectionsBase: BriefingSections = {
    activeThreads,
    recentEntities,
    openCommitments,
    suggestedFollowups: [],
    todayCalendar: calendarLoadResult?.events,
  };

  let followups: BriefingFollowup[] = [];
  let followupsUnavailableReason: string | undefined;

  if (maxFollowups === 0 || options.allowLlm === false) {
    followupsUnavailableReason = "LLM follow-ups disabled by configuration";
  } else if (!options.openaiApiKey && !options.followupGenerator) {
    followupsUnavailableReason =
      'no LLM configured for follow-ups (set OPENAI_API_KEY, enable a local LLM, or use modelSource "gateway")';
  } else {
    try {
      const generator = options.followupGenerator ?? buildOpenAiFollowupGenerator({
        apiKey: options.openaiApiKey!,
        model: options.model ?? BRIEFING_FOLLOWUP_DEFAULT_MODEL,
        baseURL: options.openaiBaseUrl,
      });
      const generated = await withBriefingFollowupTimeout(
        generator({
          sections: sectionsBase,
          windowLabel: window.label,
          maxFollowups,
        }),
      );
      followups = generated.slice(0, maxFollowups);
    } catch (err) {
      const errMsg = stringifyError(err);
      const modelName = options.model ?? BRIEFING_FOLLOWUP_DEFAULT_MODEL;
      if (
        /model/i.test(errMsg) &&
        (/not found/i.test(errMsg) || /does not exist/i.test(errMsg) || /invalid/i.test(errMsg))
      ) {
        followupsUnavailableReason =
          `configured follow-up model '${modelName}' is not available in the Responses API`;
      } else {
        followupsUnavailableReason = `LLM follow-ups failed: ${errMsg}`;
      }
      log.warn(`briefing: ${followupsUnavailableReason}`);
    }
  }
  throwIfAborted(signal, "briefing aborted");

  const sections: BriefingSections = {
    ...sectionsBase,
    suggestedFollowups: followups,
  };

  throwIfAborted(signal, "briefing aborted");
  let correctionNotifications: BriefingResult["correctionNotifications"];
  try {
    const drained = await drainPassiveCorrectionNotifications(options.storage.dir, signal);
    if (drained.length > 0) {
      correctionNotifications = drained.map((n) => ({
        planId: n.planId,
        summary: n.summary,
        undoCommand: n.undoCommand,
        createdAt: n.createdAt,
      }));
    }
  } catch (err) {
    if (isAbortError(err)) throw err;
    log.debug(`briefing: correction notification drain failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }

  const windowIso = { from: window.from.toISOString(), to: window.to.toISOString() };
  const markdown = renderBriefingMarkdown({
    sections,
    windowLabel: window.label,
    focus,
    followupsUnavailableReason,
    generatedAt: now,
    namespace: options.namespace,
    correctionNotifications,
  });

  const json: Record<string, unknown> = {
    generatedAt: now.toISOString(),
    window: windowIso,
    focus,
    namespace: options.namespace ?? null,
    correctionNotifications: correctionNotifications ?? null,
    sections,
    followupsUnavailableReason: followupsUnavailableReason ?? null,
    calendarSourceErrors: calendarSourceErrors.length > 0 ? calendarSourceErrors : null,
  };

  const result: BriefingResult = {
    markdown,
    json,
    sections,
    followupsUnavailableReason,
    window: windowIso,
    ...(correctionNotifications ? { correctionNotifications } : {}),
  };

  if (calendarSourceErrors.length > 0) {
    result.calendarSourceErrors = calendarSourceErrors;
  }

  return result;
}

function clampFollowups(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 5;
  return Math.max(0, Math.min(10, Math.floor(value)));
}

function defaultWindow(now: Date): ParsedBriefingWindow {
  const parsed = parseBriefingWindow("yesterday", now);
  if (parsed) return parsed;
  return { from: new Date(now.getTime() - DAY_MS), to: now, label: "yesterday" };
}

function memoryTimestamp(memory: MemoryFile): number {
  const raw = memory.frontmatter.updated || memory.frontmatter.created;
  if (!raw) return 0;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : 0;
}

/** @internal — exported for testing only. */
export function filterMemoriesByWindow(memories: MemoryFile[], window: ParsedBriefingWindow): MemoryFile[] {
  const fromMs = window.from.getTime();
  const toMs = window.to.getTime();
  return memories.filter((m) => {
    //
    const status = m.frontmatter.status;
    if (
      status === "superseded" ||
      status === "archived" ||
      status === "rejected" ||
      status === "quarantined" ||
      status === "forgotten"
    ) {
      return false;
    }
    const ts = memoryTimestamp(m);
    return ts >= fromMs && ts < toMs;
  });
}

/** @internal — exported for testing only. */
export function buildActiveThreads(memories: MemoryFile[]): BriefingActiveThread[] {
  const buckets = new Map<string, BriefingActiveThread>();
  for (const memory of memories) {
    const threadKey = extractThreadKey(memory);
    const updatedAt = memory.frontmatter.updated || memory.frontmatter.created || "";
    const existing = buckets.get(threadKey);
    if (!existing || updatedAt > existing.updatedAt) {
      buckets.set(threadKey, {
        id: threadKey,
        title: summarizeContentTitle(memory),
        updatedAt,
        reason: describeReason(memory),
      });
    }
  }
  return Array.from(buckets.values())
    .sort((a, b) => {
      if (a.updatedAt > b.updatedAt) return -1;
      if (a.updatedAt < b.updatedAt) return 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, MAX_ACTIVE_THREADS);
}

function extractThreadKey(memory: MemoryFile): string {
  const entityRef = memory.frontmatter.entityRef?.trim();
  if (entityRef) return `entity:${entityRef}`;
  const tags = memory.frontmatter.tags ?? [];
  const topicTag = tags.find((t) => t.startsWith("topic:"));
  if (topicTag) return topicTag;
  if (tags.length > 0) return `tag:${tags[0]}`;
  return `memory:${memory.frontmatter.id}`;
}

function summarizeContentTitle(memory: MemoryFile): string {
  const firstLine = (memory.content || "").split("\n").find((line) => line.trim().length > 0) ?? "";
  const trimmed = firstLine.trim();
  if (trimmed.length === 0) return memory.frontmatter.id;
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
}

function describeReason(memory: MemoryFile): string {
  const cat = memory.frontmatter.category;
  if (cat === "commitment") return "open commitment";
  if (cat === "decision") return "recent decision";
  if (cat === "correction") return "recent correction";
  return "recent activity";
}

/** @internal — exported for testing only. */
export function buildRecentEntities(
  entities: EntityFile[],
  window: ParsedBriefingWindow,
  focus: BriefingFocus | null,
): BriefingRecentEntity[] {
  const fromMs = window.from.getTime();
  const scored: BriefingRecentEntity[] = [];
  const now = window.to;
  for (const entity of entities) {
    if (focus && !focusMatchesEntity(entity, focus)) continue;
    const toMs = window.to.getTime();
    const updatedMs = entity.updated ? Date.parse(entity.updated) : 0;
    if (!Number.isFinite(updatedMs) || updatedMs < fromMs || updatedMs >= toMs) continue;
    const score = StorageManager.scoreEntity(entity, now);
    scored.push({
      name: entity.name,
      type: entity.type,
      updatedAt: entity.updated,
      score: Number(score.toFixed(4)),
      summary: entity.synthesis || entity.summary,
    });
  }
  return scored
    .sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (scoreDiff !== 0) return scoreDiff;
      if (a.updatedAt > b.updatedAt) return -1;
      if (a.updatedAt < b.updatedAt) return 1;
      return 0;
    })
    .slice(0, MAX_RECENT_ENTITIES);
}

/** @internal — exported for testing only. */
export function buildOpenCommitments(memories: MemoryFile[]): BriefingOpenCommitment[] {
  const commitments: BriefingOpenCommitment[] = [];

  for (const memory of memories) {
    const tags = memory.frontmatter.tags ?? [];
    const isPending = tags.some((t) => t.toLowerCase() === "pending");
    const isCommitment = memory.frontmatter.category === "commitment";
    const isUnresolvedQuestion = /(?:[?？؟]$|\bfollow[- ]up\b|\btodo\b)/i.test(memory.content);

    if (isPending || isCommitment || isUnresolvedQuestion) {
      const kind: BriefingOpenCommitment["kind"] = isCommitment
        ? "commitment"
        : isUnresolvedQuestion
          ? "question"
          : "pending_memory";
      commitments.push({
        id: memory.frontmatter.id,
        kind,
        text: summarizeContentTitle(memory),
        source: memory.frontmatter.source,
        createdAt: memory.frontmatter.created,
      });
    }
  }

  return commitments
    .sort((a, b) => {
      if (!a.createdAt && !b.createdAt) return 0;
      if (!a.createdAt) return 1;
      if (!b.createdAt) return -1;
      if (a.createdAt > b.createdAt) return -1;
      if (a.createdAt < b.createdAt) return 1;
      return 0;
    })
    .slice(0, MAX_OPEN_COMMITMENTS);
}

interface CalendarLoadResult {
  events: CalendarEvent[] | undefined;
  error: BriefingCalendarSourceError | undefined;
}

async function loadTodayCalendar(
  source: CalendarSource,
  now: Date,
): Promise<CalendarLoadResult> {
  const sourceLabel = (source as { filePath?: string }).filePath ?? "calendar";
  try {
    const dateIso = now.toISOString().slice(0, 10);
    const events = await source.eventsForDate(dateIso);
    return { events, error: undefined };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`briefing: calendar source error (${sourceLabel}): ${message}`);
    return {
      events: undefined,
      error: { source: sourceLabel, error: message },
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

function buildOpenAiFollowupGenerator(cfg: {
  apiKey: string;
  model: string;
  baseURL?: string;
}): BriefingFollowupGenerator {
  return async ({ sections, windowLabel, maxFollowups }) => {
    const { OpenAI } = (await import("openai")) as {
      OpenAI: new (opts: { apiKey: string; baseURL?: string }) => unknown;
    };
    const clientOpts: { apiKey: string; baseURL?: string } = { apiKey: cfg.apiKey };
    if (cfg.baseURL) clientOpts.baseURL = cfg.baseURL;
    const client = new OpenAI(clientOpts) as {
      responses: {
        create: (args: {
          model: string;
          instructions: string;
          input: string;
          max_output_tokens?: number;
        }) => Promise<{ output_text?: string }>;
      };
    };

    const prompt = buildFollowupPrompt(sections, windowLabel, maxFollowups);
    const response = await client.responses.create({
      model: cfg.model,
      instructions: FOLLOWUP_INSTRUCTIONS,
      input: prompt,
      max_output_tokens: 512,
    });

    const text = typeof response.output_text === "string" ? response.output_text : "";
    return parseFollowupResponse(text, maxFollowups);
  };
}

/**
 * Minimal chat-completion surface shared by `FallbackLlmClient` (gateway
 * model chain) and `LocalLlmClient` (Ollama / OpenAI-compatible local
 * endpoints). Matches `Orchestrator.fastLlmForRerank` so briefing
 * follow-ups can ride the same routing as other fast-tier operations.
 */
export interface BriefingChainLlmClient {
  chatCompletion(
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    options?: {
      temperature?: number;
      maxTokens?: number;
      timeoutMs?: number;
      operation?: string;
      priority?: "background" | "recall-critical";
    },
  ): Promise<{ content: string } | null>;
}

/**
 * Build a follow-up generator backed by the configured LLM chain
 * (gateway model source or local LLM) instead of a direct OpenAI key.
 *
 * Local models frequently wrap JSON in code fences or prose, so the
 * response is run through `extractJsonCandidates` and the first candidate
 * that parses into a valid `{ followups: [...] }` shape wins. Throws when
 * the chain returns nothing or no candidate parses — `buildBriefing`
 * catches and surfaces the message via `followupsUnavailableReason`.
 */
export function buildChainFollowupGenerator(
  client: BriefingChainLlmClient,
): BriefingFollowupGenerator {
  return async ({ sections, windowLabel, maxFollowups }) => {
    const prompt = buildFollowupPrompt(sections, windowLabel, maxFollowups);
    const response = await client.chatCompletion(
      [
        { role: "system", content: FOLLOWUP_INSTRUCTIONS },
        { role: "user", content: prompt },
      ],
      {
        temperature: 0.2,
        maxTokens: 512,
        operation: "briefing-followups",
        priority: "background",
      },
    );
    if (!response?.content) {
      throw new Error("LLM chain returned no response");
    }
    const candidates = extractJsonCandidates(response.content);
    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        return parseFollowupResponse(candidate, maxFollowups);
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(
      `LLM chain response contained no valid followups JSON: ${stringifyError(lastError ?? "no JSON candidates found")}`,
    );
  };
}

const FOLLOWUP_INSTRUCTIONS = `You suggest short follow-up prompts for a daily context briefing.
Return strict JSON of the form { "followups": [{ "text": "...", "rationale": "..." }] }.
Rules:
- Never invent facts absent from the input.
- Keep each "text" under 140 characters.
- Prefer concrete, action-oriented phrasing.
- Omit duplicates. Avoid filler.`;

function buildFollowupPrompt(
  sections: BriefingSections,
  windowLabel: string,
  maxFollowups: number,
): string {
  const lines: string[] = [];
  lines.push(`Window: ${windowLabel}`);
  lines.push(`Desired follow-ups: ${maxFollowups}`);
  lines.push("");
  lines.push("Active threads:");
  for (const t of sections.activeThreads) lines.push(`- ${t.title} (${t.reason})`);
  lines.push("");
  lines.push("Recent entities:");
  for (const e of sections.recentEntities) lines.push(`- ${e.name} [${e.type}]`);
  lines.push("");
  lines.push("Open commitments:");
  for (const c of sections.openCommitments) lines.push(`- [${c.kind}] ${c.text}`);
  return lines.join("\n");
}

function parseFollowupResponse(raw: string, max: number): BriefingFollowup[] {
  const candidates = extractJsonCandidates(raw);
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!parsed || typeof parsed !== "object") {
        throw new Error(`LLM returned non-object JSON: ${typeof parsed}`);
      }
      const arr = (parsed as { followups?: unknown }).followups;
      if (!Array.isArray(arr)) {
        throw new Error(`LLM response missing "followups" array`);
      }
      const out: BriefingFollowup[] = [];
      for (const entry of arr) {
        if (!entry || typeof entry !== "object") continue;
        const text = (entry as Record<string, unknown>).text;
        if (typeof text !== "string" || text.trim().length === 0) continue;
        const rationale = (entry as Record<string, unknown>).rationale;
        out.push({
          text: text.trim(),
          rationale: typeof rationale === "string" ? rationale.trim() : undefined,
        });
        if (out.length >= max) break;
      }
      return out;
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) throw lastError;
  throw new Error("LLM response contained no JSON candidates");
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

interface RenderContext {
  sections: BriefingSections;
  windowLabel: string;
  focus: BriefingFocus | null;
  followupsUnavailableReason?: string;
  generatedAt: Date;
  namespace?: string;
  correctionNotifications?: BriefingResult["correctionNotifications"];
}

export function renderBriefingMarkdown(ctx: RenderContext): string {
  const lines: string[] = [];
  lines.push(`# Daily Context Briefing`);
  lines.push("");
  lines.push(`_Generated ${ctx.generatedAt.toISOString()} (window: ${ctx.windowLabel})_`);
  if (ctx.focus) {
    lines.push(`_Focus: ${ctx.focus.type}:${ctx.focus.value}_`);
  }
  if (ctx.namespace) {
    lines.push(`_Namespace: ${ctx.namespace}_`);
  }
  lines.push("");

  if (ctx.correctionNotifications && ctx.correctionNotifications.length > 0) {
    lines.push(`## Memory updates`);
    for (const n of ctx.correctionNotifications) {
      lines.push(`- ✎ ${n.summary} (undo: ${n.undoCommand})`);
    }
    lines.push("");
  }

  lines.push(`## Active threads`);
  if (ctx.sections.activeThreads.length === 0) {
    lines.push(`_No active threads in window._`);
  } else {
    for (const t of ctx.sections.activeThreads) {
      lines.push(`- **${t.title}** — ${t.reason} (updated ${t.updatedAt})`);
    }
  }
  lines.push("");

  lines.push(`## Recent entities`);
  if (ctx.sections.recentEntities.length === 0) {
    lines.push(`_No entities updated in window._`);
  } else {
    for (const e of ctx.sections.recentEntities) {
      const summary = e.summary ? ` — ${e.summary}` : "";
      lines.push(`- **${e.name}** (${e.type}, score ${e.score})${summary}`);
    }
  }
  lines.push("");

  lines.push(`## Open commitments`);
  if (ctx.sections.openCommitments.length === 0) {
    lines.push(`_No open commitments detected._`);
  } else {
    for (const c of ctx.sections.openCommitments) {
      lines.push(`- [${c.kind}] ${c.text}`);
    }
  }
  lines.push("");

  lines.push(`## Suggested follow-ups`);
  if (ctx.followupsUnavailableReason) {
    lines.push(`_Unavailable: ${ctx.followupsUnavailableReason}_`);
  } else if (ctx.sections.suggestedFollowups.length === 0) {
    lines.push(`_No follow-ups suggested._`);
  } else {
    for (const f of ctx.sections.suggestedFollowups) {
      const rationale = f.rationale ? ` _(${f.rationale})_` : "";
      lines.push(`- ${f.text}${rationale}`);
    }
  }
  lines.push("");

  if (ctx.sections.todayCalendar !== undefined) {
    lines.push(`## Today's calendar`);
    if (ctx.sections.todayCalendar.length === 0) {
      lines.push(`_No events on the calendar today._`);
    } else {
      for (const ev of ctx.sections.todayCalendar) {
        const end = ev.end ? ` → ${ev.end}` : "";
        const loc = ev.location ? ` @ ${ev.location}` : "";
        lines.push(`- **${ev.title}** (${ev.start}${end})${loc}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

/**
 * Resolve the directory where `--save` writes dated briefings.
 * Respects the following precedence:
 *   1. explicit `configOverride` argument
 *   2. `$REMNIC_HOME/briefings/`
 *   3. `$HOME/.remnic/briefings/`
 */
export function resolveBriefingSaveDir(
  configOverride: string | null | undefined,
  env?: NodeJS.ProcessEnv,
): string {
  if (typeof configOverride === "string" && configOverride.trim().length > 0) {
    return path.resolve(configOverride.trim());
  }
  const remnicHome = (env === undefined ? readEnvVar("REMNIC_HOME") : env.REMNIC_HOME)?.trim();
  if (remnicHome && remnicHome.length > 0) {
    return path.join(remnicHome, "briefings");
  }
  const home = env === undefined
    ? resolveHomeDir()
    : env.HOME ?? env.USERPROFILE ?? os.homedir();
  return path.join(home, ".remnic", "briefings");
}

export function briefingFilename(date: Date, format: "markdown" | "json" = "markdown"): string {
  const day = date.toISOString().slice(0, 10);
  return format === "json" ? `${day}.json` : `${day}.md`;
}
