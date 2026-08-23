/**
 * Deterministic screen-activity day-digest renderer (issue #1899).
 *
 * Renders a day's snapshots into markdown with YAML frontmatter, placed at
 * `<memoryDir>/activity/<date>.md` — outside the memory scan roots but inside
 * the QMD collection root (searchable, never auto-recalled). No LLM: the body
 * is a pure, byte-identical function of its inputs so an unchanged day skips
 * rewrite by contentHash. Day bucketing is DST-aware and half-open
 * [start, end) (AGENTS.md §23); sort keys are total with stable tiebreakers
 * (§12).
 */

import { createHash } from "node:crypto";
import path from "node:path";

import type { ActivityDayDigest, ActivityDayMeta, ActivitySnapshot } from "./types.js";

export const ACTIVITY_DIGEST_FORMAT_VERSION = 1;
export const ACTIVITY_DIR_NAME = "activity";

/** Attribute at most this much dwell to a single snapshot (idle gaps capped). */
const MAX_DWELL_MS = 15 * 60_000;
/** Notable-excerpt caps. */
const NOTABLE_MAX_WINDOWS = 10;
const NOTABLE_EXCERPT_CHARS = 280;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidActivityDate(date: string): boolean {
  if (typeof date !== "string" || !DATE_PATTERN.test(date)) return false;
  // Reject impossible calendar days (e.g. 2026-02-30, 2026-13-01): the UTC
  // round-trip must reproduce the same Y-M-D, else Date normalized an overflow.
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

export function activityDigestPath(memoryDir: string, date: string): string {
  if (!isValidActivityDate(date)) {
    // Never interpolate an unvalidated date into a filesystem path (a `../`
    // would escape <memoryDir>/activity/). Reject loudly.
    throw new RangeError(`Invalid activity date "${date}"; expected YYYY-MM-DD.`);
  }
  return path.join(memoryDir, ACTIVITY_DIR_NAME, `${date}.md`);
}

// ── DST-aware local-day window ──────────────────────────────────────────────

export function timezoneOffsetIso(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "longOffset",
  }).formatToParts(instant);
  const name = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = name.match(/GMT([+-]\d{2}:\d{2})?/);
  return match?.[1] ?? "+00:00";
}

export function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new RangeError(`Invalid IANA timezone "${timezone}".`);
  }
}

function zonedDayStartIso(date: string, timezone: string): string {
  // The first UTC instant whose local wall-clock is this date at 00:00. Probe
  // several instants across the day to collect every offset in play, keep an
  // offset only if constructing local midnight with it lands on an exact
  // local midnight, then take the EARLIEST such instant — the FIRST 00:00
  // across a DST fall-back that repeats local midnight.
  // Probe the previous UTC day too: for zones east of UTC the requested date's
  // UTC instants all fall after local midnight, so the pre-transition offset
  // valid at the real local 00:00 is only observable on the prior UTC day.
  const wall = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const localStamp = (ms: number): string => {
    const parts = wall.formatToParts(new Date(ms));
    const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
    // Intl formats pre-1000 years unpadded ("999" for 0999). Pad back to the
    // four-digit form the equality and ordering comparisons below assume,
    // or "998-12-31" compares greater than "0999-01-01".
    const year = get("year").padStart(4, "0");
    return `${year}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
  };
  const localDate = (ms: number): string => localStamp(ms).slice(0, 10);
  const prevDate = shiftIsoDate(date, -1);
  const probeOffsets = new Set(
    [
      `${prevDate}T12:00:00Z`,
      `${prevDate}T23:00:00Z`,
      `${date}T00:00:00Z`,
      `${date}T12:00:00Z`,
      `${date}T23:00:00Z`,
    ].map((iso) => timezoneOffsetIso(new Date(iso), timezone)),
  );
  let best: number | null = null;
  for (const offset of probeOffsets) {
    const candidate = Date.parse(`${date}T00:00:00${offset}`);
    if (!Number.isFinite(candidate)) continue;
    // Accept only an EXACT local midnight. This rejects a wall-clock midnight
    // that never occurred (spring-forward at 00:00), and — because offset
    // strings truncate to whole minutes while historical LMT offsets carry
    // seconds (Asia/Manila was −15:56:08 until 1844) — a candidate built from
    // the truncated offset, which lands off the true midnight instant.
    if (localStamp(candidate) !== `${date}T00:00:00`) continue;
    if (best === null || candidate < best) best = candidate;
  }
  if (best === null) {
    // No exact local midnight: either local midnight was skipped by a
    // spring-forward (00:00 → 01:00) or the ENTIRE civil date never existed
    // (Pacific/Apia 2011-12-30; Asia/Manila 1844-12-31). Extending the
    // never-backdate convention, resolve the day start to the first instant
    // whose local calendar date reaches `date`. Local date is monotone
    // non-decreasing in the UTC instant (a fall-back never crosses local
    // midnight backwards), so binary-search a 48h bracket down to the
    // millisecond — transitions can carry seconds (Manila's landed at
    // :56:08, not on a minute boundary), so minute granularity mis-resolves
    // by up to 59s and hands the skipped date a window of its own. The
    // bracket is safe: `<date>T00:00Z − 24h` is always locally before
    // `date`, and `<date>T00:00Z + 24h` is always locally on/after it.
    let lo = Date.parse(`${date}T00:00:00Z`) - 24 * 3_600_000;
    let hi = lo + 48 * 3_600_000;
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (localDate(mid) >= date) hi = mid;
      else lo = mid + 1;
    }
    best = lo;
  }
  if (best === null || !Number.isFinite(best)) {
    throw new RangeError(`activity: could not resolve a local day start for "${date}" in "${timezone}".`);
  }
  return new Date(best).toISOString();
}

function shiftIsoDate(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function nextIsoDate(date: string): string {
  return shiftIsoDate(date, 1);
}

/**
 * Half-open [start, end) UTC ISO bounds of a local day. A civil date the
 * zone skipped entirely owns no interval: the window is zero-width
 * `[transition, transition)`.
 */
export function activityDayWindow(date: string, timezone: string): { startUtc: string; endUtc: string } {
  if (!isValidActivityDate(date)) {
    throw new RangeError(`Invalid activity date "${date}"; expected a real YYYY-MM-DD day.`);
  }
  assertValidTimezone(timezone);
  const startUtc = zonedDayStartIso(date, timezone);
  const endUtc = zonedDayStartIso(nextIsoDate(date), timezone);
  // Skipped-date semantics (Pacific/Apia 2011-12-30 class): the skipped
  // date's start and the following date's start both resolve to the
  // transition instant, so the window is naturally zero-width. Keep it
  // that way: a date that never occurred contributes to no daily total
  // (daysOverlappingWeek drops zero-width days) and a connector sync for
  // it fetches nothing. Pushing the end forward to stay non-degenerate
  // would alias the next real day's interval and double-attribute every
  // card in it to two daily totals.
  return { startUtc, endUtc };
}

/**
 * The local calendar day (YYYY-MM-DD) an instant falls in for an IANA
 * timezone — the day key `activityDayWindow` buckets on. Callers that need
 * "today" for activity artifacts MUST use this rather than the host-local
 * date, which drifts a day near either timezone's midnight.
 */
export function activityDateInTimezone(instant: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(instant);
    const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    return instant.toISOString().slice(0, 10);
  }
}

// ── Rendering ───────────────────────────────────────────────────────────────

function sortedByTime(snapshots: ActivitySnapshot[]): ActivitySnapshot[] {
  return [...snapshots].sort((a, b) => {
    // Compare by parsed instant, not raw string, so mixed valid ISO forms
    // (Z vs offset, varying precision) still order chronologically.
    const at = Date.parse(a.capturedAtUtc);
    const bt = Date.parse(b.capturedAtUtc);
    if (at !== bt && Number.isFinite(at) && Number.isFinite(bt)) return at < bt ? -1 : 1;
    const aid = a.id ?? 0;
    const bid = b.id ?? 0;
    if (aid < bid) return -1;
    if (aid > bid) return 1;
    // Unsaved snapshots (pre-store) both default to id 0; fall back to the
    // content hash (their dedup identity), then app/window, for a total order.
    if (a.contentHash !== b.contentHash) return a.contentHash < b.contentHash ? -1 : 1;
    if (a.app !== b.app) return a.app < b.app ? -1 : 1;
    if (a.windowTitle !== b.windowTitle) return a.windowTitle < b.windowTitle ? -1 : 1;
    return 0;
  });
}

/**
 * Per-snapshot dwell (gap to that machine's next snapshot, capped), scoped per
 * capture machine so an interleaved snapshot from another machine can't steal
 * or truncate a snapshot's dwell (multi-machine days).
 */
function computeDwell(snapshots: ActivitySnapshot[]): Map<ActivitySnapshot, number> {
  const byMachine = new Map<string, ActivitySnapshot[]>();
  for (const snapshot of snapshots) {
    const list = byMachine.get(snapshot.machine);
    if (list === undefined) byMachine.set(snapshot.machine, [snapshot]);
    else list.push(snapshot);
  }
  const dwell = new Map<ActivitySnapshot, number>();
  for (const list of byMachine.values()) {
    const ordered = sortedByTime(list);
    for (let index = 0; index < ordered.length; index++) {
      const current = ordered[index];
      if (current === undefined) continue;
      const next = ordered[index + 1];
      let value = 0;
      if (next !== undefined) {
        const delta = Date.parse(next.capturedAtUtc) - Date.parse(current.capturedAtUtc);
        if (Number.isFinite(delta) && delta > 0) value = Math.min(delta, MAX_DWELL_MS);
      }
      dwell.set(current, value);
    }
  }
  return dwell;
}

function formatDurationMinutes(ms: number): string {
  return `${Math.round(ms / 60_000)}m`;
}

function clockHhMm(iso: string, timezone: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "??:??";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${hour}:${minute}`;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function perAppSection(ordered: ActivitySnapshot[], dwell: Map<ActivitySnapshot, number>): string {
  const totals = new Map<string, number>();
  for (const snapshot of ordered) {
    totals.set(snapshot.app, (totals.get(snapshot.app) ?? 0) + (dwell.get(snapshot) ?? 0));
  }
  const rows = [...totals.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    if (a[0] < b[0]) return -1;
    if (a[0] > b[0]) return 1;
    return 0;
  });
  const lines = ["## Per-app time", ""];
  if (rows.length === 0) {
    lines.push("_No activity recorded._");
  } else {
    for (const [app, ms] of rows) {
      lines.push(`- ${app}: ${formatDurationMinutes(ms)}`);
    }
  }
  return lines.join("\n");
}

interface TimelineSpan {
  startIso: string;
  machine: string;
  app: string;
  windowTitle: string;
  browserUrl?: string;
}

function timelineSpans(ordered: ActivitySnapshot[]): TimelineSpan[] {
  const spans: TimelineSpan[] = [];
  for (const snapshot of ordered) {
    const last = spans[spans.length - 1];
    if (
      last !== undefined &&
      last.machine === snapshot.machine &&
      last.app === snapshot.app &&
      last.windowTitle === snapshot.windowTitle &&
      last.browserUrl === snapshot.browserUrl
    ) {
      continue;
    }
    spans.push({
      startIso: snapshot.capturedAtUtc,
      machine: snapshot.machine,
      app: snapshot.app,
      windowTitle: snapshot.windowTitle,
      ...(snapshot.browserUrl !== undefined ? { browserUrl: snapshot.browserUrl } : {}),
    });
  }
  return spans;
}

function timelineSection(ordered: ActivitySnapshot[], timezone: string): string {
  const lines = ["## Timeline", ""];
  const spans = timelineSpans(ordered);
  if (spans.length === 0) {
    lines.push("_No activity recorded._");
    return lines.join("\n");
  }
  for (const span of spans) {
    const clock = clockHhMm(span.startIso, timezone);
    const window = collapseWhitespace(span.windowTitle);
    const url = span.browserUrl !== undefined ? ` (${collapseWhitespace(span.browserUrl)})` : "";
    lines.push(`- [${clock}] ${span.app}${window.length > 0 ? ` — ${window}` : ""}${url}`);
  }
  return lines.join("\n");
}

function notableSection(ordered: ActivitySnapshot[], dwell: Map<ActivitySnapshot, number>): string {
  const withDwell = ordered.map((snapshot) => ({ snapshot, dwell: dwell.get(snapshot) ?? 0 }));
  const ranked = withDwell
    .filter((entry) => collapseWhitespace(entry.snapshot.text).length > 0)
    .sort((a, b) => {
      if (b.dwell !== a.dwell) return b.dwell - a.dwell;
      const at = Date.parse(a.snapshot.capturedAtUtc);
      const bt = Date.parse(b.snapshot.capturedAtUtc);
      if (at !== bt && Number.isFinite(at) && Number.isFinite(bt)) return at < bt ? -1 : 1;
      const idDelta = (a.snapshot.id ?? 0) - (b.snapshot.id ?? 0);
      if (idDelta !== 0) return idDelta;
      if (a.snapshot.contentHash !== b.snapshot.contentHash) {
        return a.snapshot.contentHash < b.snapshot.contentHash ? -1 : 1;
      }
      return 0;
    })
    .slice(0, NOTABLE_MAX_WINDOWS);
  const lines = ["## Notable", ""];
  if (ranked.length === 0) {
    lines.push("_No notable text captured._");
    return lines.join("\n");
  }
  for (const { snapshot } of ranked) {
    const excerpt = collapseWhitespace(snapshot.text).slice(0, NOTABLE_EXCERPT_CHARS);
    lines.push(`- **${snapshot.app}** — ${excerpt}`);
  }
  return lines.join("\n");
}

export function composeActivityDigestBody(
  date: string,
  timezone: string,
  snapshots: ActivitySnapshot[],
): string {
  assertValidTimezone(timezone);
  const ordered = sortedByTime(snapshots);
  const dwell = computeDwell(ordered);
  return [
    `# Activity — ${date}`,
    "",
    perAppSection(ordered, dwell),
    "",
    timelineSection(ordered, timezone),
    "",
    notableSection(ordered, dwell),
    "",
  ].join("\n");
}

export function hashActivityBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function composeActivityDigestMeta(
  date: string,
  machines: string[],
  snapshots: ActivitySnapshot[],
  body: string,
): ActivityDayMeta {
  const uniqueMachines = [...new Set(machines)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    kind: "activity-digest",
    date,
    machines: uniqueMachines,
    snapshotCount: snapshots.length,
    contentHash: hashActivityBody(body),
    formatVersion: ACTIVITY_DIGEST_FORMAT_VERSION,
  };
}

export function serializeActivityDigest(meta: ActivityDayMeta, body: string): string {
  const frontmatter = [
    "---",
    `kind: ${meta.kind}`,
    `date: ${meta.date}`,
    `machines: ${JSON.stringify(meta.machines)}`,
    `snapshotCount: ${meta.snapshotCount}`,
    `contentHash: ${meta.contentHash}`,
    `formatVersion: ${meta.formatVersion}`,
    "---",
    "",
  ].join("\n");
  return `${frontmatter}${body}`;
}

export function parseActivityDigest(raw: string): ActivityDayDigest | null {
  if (typeof raw !== "string" || !raw.startsWith("---\n")) return null;
  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) return null;
  const frontmatter = raw.slice(4, end);
  const body = raw.slice(end + 5).replace(/^\n/, "");
  const fields = new Map<string, string>();
  for (const line of frontmatter.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    fields.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }
  const date = fields.get("date");
  const contentHash = fields.get("contentHash");
  if (date === undefined || !isValidActivityDate(date) || contentHash === undefined) return null;
  if (fields.get("kind") !== "activity-digest") return null;
  const machines = parseMachinesList(fields.get("machines") ?? "[]");
  const snapshotCount = parseNonNegativeInt(fields.get("snapshotCount"));
  const formatVersion = parseNonNegativeInt(fields.get("formatVersion"));
  if (snapshotCount === null || formatVersion === null) return null;
  return {
    meta: {
      kind: "activity-digest",
      date,
      machines,
      snapshotCount,
      contentHash,
      formatVersion,
    },
    body,
  };
}

function parseNonNegativeInt(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseMachinesList(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((entry): entry is string => typeof entry === "string");
    }
  } catch {
    // Legacy unquoted inline form (`[a, b]`) — fall through to the split parse.
  }
  return raw
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
