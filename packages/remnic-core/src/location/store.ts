/**
 * Location day-file + sync-state store (issue #2044).
 *
 * Day documents live at `<memoryDir>/locations/<YYYY-MM-DD>.md` — OUTSIDE the
 * memory scan roots (facts/, entities/, …) so raw location history never
 * surfaces as a memory in recall or governance passes, and INSIDE the QMD
 * collection root so the markdown stays full-text searchable once an index
 * update runs. Per-source sync state lives at
 * `<memoryDir>/state/locations/sync.json` and is written only after the day
 * document is durable (see pipeline.ts).
 *
 * Both writes are atomic (temp file + rename) and containment-checked: a
 * symlinked `locations/` root or day file is rejected even when it resolves
 * inside the memory dir (AGENTS.md pattern #3), and a path that escapes the
 * memory dir is refused outright.
 */

import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { writeFileAtomically } from "../maintenance/atomic-file.js";
import { pathIsInside } from "../utils/path-containment.js";
import { isValidLocationDate, placeDurations } from "./intervals.js";
import type { LocationSegment } from "./types.js";

export const LOCATIONS_DIR_NAME = "locations";
export const LOCATION_DAY_KIND = "location-day";
export const LOCATION_DAY_FORMAT_VERSION = 1;

/** Cap on remembered day payloads per source (~3 months of days). */
const MAX_TRACKED_LOCATION_DAYS = 90;

const DAY_FILE_NAME_PATTERN = /^\d{4}-\d{2}-\d{2}\.md$/;

// Serializes state load→mutate→save sections per state file so two sources
// syncing concurrently cannot lose-update each other's entries.
const stateLocks = new Map<string, Promise<unknown>>();

function withStateLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = stateLocks.get(key) ?? Promise.resolve();
  const next = prior.then(fn, fn);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  stateLocks.set(key, tail);
  void tail.then(() => {
    if (stateLocks.get(key) === tail) stateLocks.delete(key);
  });
  return next;
}

export function locationDayFilePath(memoryDir: string, date: string): string {
  if (!isValidLocationDate(date)) {
    // Never interpolate an unvalidated date into a filesystem path (a `../`
    // would escape <memoryDir>/locations/). Reject loudly.
    throw new RangeError(`Invalid location date "${date}"; expected a real YYYY-MM-DD day.`);
  }
  return path.join(memoryDir, LOCATIONS_DIR_NAME, `${date}.md`);
}

export function locationSyncStateFilePath(memoryDir: string): string {
  return path.join(memoryDir, "state", "locations", "sync.json");
}

/** A source's derived day payload, kept in sync state for multi-source merges. */
export interface LocationSourceDayPayload {
  observationCount: number;
  segments: LocationSegment[];
  providerDisplayName?: string;
}

export interface LocationSourceSyncState {
  lastSyncedAtUtc?: string;
  days?: Record<string, LocationSourceDayPayload>;
}

export interface LocationSyncStateFile {
  version: 1;
  sources: Record<string, LocationSourceSyncState>;
}

export function emptyLocationSyncState(): LocationSyncStateFile {
  return { version: 1, sources: {} };
}

export async function loadLocationSyncState(memoryDir: string): Promise<LocationSyncStateFile> {
  let raw: string;
  try {
    raw = await readFile(locationSyncStateFilePath(memoryDir), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyLocationSyncState();
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A corrupt state file must not brick syncing forever; treat it as a cold
    // start. The worst case is re-syncing days already on disk, and the day
    // file's contentHash makes that rewrite idempotent.
    return emptyLocationSyncState();
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    typeof (parsed as LocationSyncStateFile).sources !== "object" ||
    (parsed as LocationSyncStateFile).sources === null
  ) {
    return emptyLocationSyncState();
  }
  return { version: 1, sources: (parsed as LocationSyncStateFile).sources };
}

export async function saveLocationSyncState(
  memoryDir: string,
  state: LocationSyncStateFile,
): Promise<void> {
  await mkdir(path.dirname(locationSyncStateFilePath(memoryDir)), { recursive: true, mode: 0o700 });
  await writeFileAtomically(
    locationSyncStateFilePath(memoryDir),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

function pruneSourceDays(source: LocationSourceSyncState): void {
  const days = source.days;
  if (days === undefined) return;
  const keys = Object.keys(days).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_TRACKED_LOCATION_DAYS))) {
    delete days[key];
  }
}

/**
 * Record one source's completed day sync. Runs the whole read-modify-write
 * under the per-directory state lock so concurrent sources cannot clobber
 * each other, and prunes day payloads beyond the retention cap.
 */
export async function updateLocationSourceDay(
  memoryDir: string,
  sourceId: string,
  date: string,
  payload: LocationSourceDayPayload,
  completedAtUtc: string,
): Promise<LocationSyncStateFile> {
  if (!isValidLocationDate(date)) {
    throw new RangeError(`Invalid location date "${date}"; expected a real YYYY-MM-DD day.`);
  }
  return withStateLock(locationSyncStateFilePath(memoryDir), async () => {
    const state = await loadLocationSyncState(memoryDir);
    const source = state.sources[sourceId] ?? {};
    const days = source.days ?? {};
    days[date] = payload;
    source.days = days;
    source.lastSyncedAtUtc = completedAtUtc;
    state.sources[sourceId] = source;
    for (const candidate of Object.values(state.sources)) pruneSourceDays(candidate);
    await saveLocationSyncState(memoryDir, state);
    return state;
  });
}
/** Frontmatter persisted on a rendered day document. */
export interface LocationDayMeta {
  kind: typeof LOCATION_DAY_KIND;
  date: string;
  timezone: string;
  formatVersion: number;
  sources: string[];
  observationCount: number;
  /** SHA-256 of the rendered body (rebuild idempotency). */
  contentHash: string;
}

/** A parsed day document (frontmatter + rendered body). */
export interface LocationDayDocument {
  meta: LocationDayMeta;
  body: string;
}

/** The per-source view a day document is composed from. */
export interface LocationDaySourceEntry extends LocationSourceDayPayload {
  /** Provider display name for the timeline heading; falls back to the id. */
  providerDisplayName?: string;
}

export function hashLocationBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function clockHhMm(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m`;
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

/** Collapse whitespace and strip markdown emphasis/backticks from a label. */
function safeLabel(label: string): string {
  return label.replace(/\s+/g, " ").replace(/[`*_]/g, "").trim();
}

function formatPlaceLabel(segment: LocationSegment): string {
  const label = safeLabel(segment.place.label);
  return segment.place.kind === undefined ? label : `${label} (${segment.place.kind})`;
}

function formatCoordinates(segment: LocationSegment): string {
  if (segment.place.latitude === undefined || segment.place.longitude === undefined) return "";
  return ` @ ${segment.place.latitude.toFixed(4)},${segment.place.longitude.toFixed(4)}`;
}

export function composeLocationDayBody(
  date: string,
  timezone: string,
  sources: Record<string, LocationDaySourceEntry>,
): string {
  const lines: string[] = [`# Location day — ${date} (${timezone})`, ""];
  const allSegments: LocationSegment[] = [];
  let observationCount = 0;
  for (const entry of Object.values(sources)) {
    allSegments.push(...entry.segments);
    observationCount += entry.observationCount;
  }

  lines.push("## Summary", "");
  if (observationCount === 0) {
    lines.push("No location observations recorded.", "");
  } else {
    const durations = placeDurations(allSegments).sort((a, b) => b.totalMs - a.totalMs);
    lines.push(
      `- Places visited: ${durations.length}`,
      ...durations.map(
        (duration) => `- ${safeLabel(duration.place.label)}: ${formatDuration(duration.totalMs)}`,
      ),
      "",
    );
  }

  const sourceIds = Object.keys(sources).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const sourceId of sourceIds) {
    const entry = sources[sourceId]!;
    lines.push(`## Timeline — ${safeLabel(entry.providerDisplayName ?? sourceId)}`, "");
    if (entry.segments.length === 0) {
      lines.push("No observations.", "");
      continue;
    }
    for (const segment of entry.segments) {
      lines.push(
        `- ${clockHhMm(segment.startUtc, timezone)}–${clockHhMm(segment.endUtc, timezone)} — ${formatPlaceLabel(segment)}${formatCoordinates(segment)}`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function composeLocationDayMeta(
  date: string,
  timezone: string,
  sources: Record<string, LocationDaySourceEntry>,
  body: string,
): LocationDayMeta {
  let observationCount = 0;
  for (const entry of Object.values(sources)) observationCount += entry.observationCount;
  return {
    kind: LOCATION_DAY_KIND,
    date,
    timezone,
    formatVersion: LOCATION_DAY_FORMAT_VERSION,
    sources: Object.keys(sources).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    observationCount,
    contentHash: hashLocationBody(body),
  };
}

function frontmatterScalar(key: string, value: string | number): string {
  return `${key}: ${typeof value === "number" ? value : JSON.stringify(value)}`;
}

function frontmatterList(key: string, values: readonly string[]): string[] {
  if (values.length === 0) return [`${key}: []`];
  const lines = [`${key}:`];
  for (const value of values) lines.push(`  - ${JSON.stringify(value)}`);
  return lines;
}

export function serializeLocationDay(meta: LocationDayMeta, body: string): string {
  const lines: string[] = ["---"];
  lines.push(frontmatterScalar("kind", meta.kind));
  lines.push(frontmatterScalar("date", meta.date));
  lines.push(frontmatterScalar("timezone", meta.timezone));
  lines.push(frontmatterScalar("formatVersion", meta.formatVersion));
  lines.push(...frontmatterList("sources", meta.sources));
  lines.push(frontmatterScalar("observationCount", meta.observationCount));
  lines.push(frontmatterScalar("contentHash", meta.contentHash));
  lines.push("---", "", body);
  return lines.join("\n");
}

function parseScalar(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : raw;
  } catch {
    return raw;
  }
}

/** A day document's frontmatter, parsed for idempotency checks and status. */
export interface LocationDaySummary {
  date: string;
  timezone: string;
  sources: string[];
  observationCount: number;
  contentHash: string;
}

/**
 * Parse a day document's frontmatter. Returns null when the content is not a
 * location day document (wrong kind, missing frontmatter) so callers can
 * distinguish a foreign file from a corrupt one.
 */
export function parseLocationDaySummary(raw: string): LocationDaySummary | null {
  if (!raw.startsWith("---\n")) return null;
  const closeIndex = raw.indexOf("\n---\n", 4);
  if (closeIndex === -1) return null;
  const scalars: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  let currentList: string | null = null;
  for (const line of raw.slice(4, closeIndex).split("\n")) {
    const listItem = /^ {2}- (.*)$/.exec(line);
    if (listItem !== null && currentList !== null) {
      lists[currentList]!.push(parseScalar(listItem[1]!));
      continue;
    }
    currentList = null;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    if (value === "" || value === "[]") {
      lists[key] = [];
      currentList = key;
      continue;
    }
    if (value.startsWith("[")) {
      lists[key] = [parseScalar(value)];
      currentList = key;
      continue;
    }
    scalars[key] = value;
  }
  if (scalars.kind === undefined || parseScalar(scalars.kind) !== LOCATION_DAY_KIND) return null;
  if (scalars.date === undefined || scalars.contentHash === undefined) return null;
  return {
    date: parseScalar(scalars.date),
    timezone: scalars.timezone === undefined ? "UTC" : parseScalar(scalars.timezone),
    sources: lists.sources ?? [],
    observationCount: scalars.observationCount === undefined ? 0 : Number(scalars.observationCount) || 0,
    contentHash: parseScalar(scalars.contentHash),
  };
}

// ── Containment-checked day-file IO ─────────────────────────────────────────

function isErrnoCode(err: unknown, code: string): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === code;
}

async function assertNotSymlink(target: string, kind: "directory" | "day file"): Promise<void> {
  let stat: { isSymbolicLink(): boolean };
  try {
    stat = await lstat(target);
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return;
    throw err;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(
      `locations ${kind} '${path.basename(target)}' is a symbolic link — refusing to follow it even when it resolves inside the memory dir (AGENTS.md pattern #3)`,
    );
  }
}

async function assertNoEscape(rootReal: string, candidate: string): Promise<void> {
  let candidateReal: string;
  try {
    candidateReal = await realpath(candidate);
  } catch {
    return;
  }
  if (!pathIsInside(rootReal, candidateReal)) {
    throw new Error(
      "location day path resolves outside the memory dir — refusing to follow a symlink/traversal (AGENTS.md pattern #3)",
    );
  }
}

async function assertDayPathContained(memoryDir: string, targetPath: string): Promise<void> {
  let rootReal: string;
  try {
    rootReal = await realpath(memoryDir);
  } catch {
    rootReal = path.resolve(memoryDir);
  }
  const locationsDir = path.join(memoryDir, LOCATIONS_DIR_NAME);
  await assertNoEscape(rootReal, locationsDir);
  await assertNoEscape(rootReal, targetPath);
  // Reject a symlinked locations root or day file outright — even when the
  // link resolves inside the memory dir (aliasing / tampering) — before IO.
  await assertNotSymlink(locationsDir, "directory");
  await assertNotSymlink(targetPath, "day file");
}

/**
 * Idempotently persist a day document: skip the write when the on-disk
 * contentHash already matches. The write is atomic and containment-checked;
 * the caller (pipeline) advances sync state only after this resolves.
 */
export async function writeLocationDay(
  memoryDir: string,
  date: string,
  serialized: string,
): Promise<boolean> {
  const target = locationDayFilePath(memoryDir, date);
  await assertDayPathContained(memoryDir, target);
  try {
    if ((await readFile(target, "utf-8")) === serialized) return false;
  } catch (err) {
    if (!isErrnoCode(err, "ENOENT")) throw err;
  }
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFileAtomically(target, serialized);
  return true;
}

/** Read a stored day document's raw markdown; null when absent. */
export async function readLocationDay(memoryDir: string, date: string): Promise<string | null> {
  const target = locationDayFilePath(memoryDir, date);
  await assertDayPathContained(memoryDir, target);
  try {
    return await readFile(target, "utf-8");
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return null;
    throw err;
  }
}

/** List dates that have a stored day document, newest first. */
export async function listLocationDayDates(memoryDir: string): Promise<string[]> {
  const locationsDir = path.join(memoryDir, LOCATIONS_DIR_NAME);
  await assertDayPathContained(memoryDir, locationsDir);
  let entries: string[];
  try {
    entries = await readdir(locationsDir);
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return [];
    throw err;
  }
  const dates = entries
    .filter((entry) => DAY_FILE_NAME_PATTERN.test(entry))
    .map((entry) => entry.slice(0, -3));
  dates.sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  return dates;
}
