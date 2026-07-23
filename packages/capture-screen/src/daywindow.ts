/**
 * DST-aware local-day window. Inlined from @remnic/core's activity digest
 * (capture-screen is à-la-carte and depends on nothing at runtime). Returns the
 * half-open [startUtc, endUtc) UTC instants bounding a local calendar day in an
 * IANA timezone, correct across spring-forward (skipped midnight) and fall-back
 * (repeated midnight) transitions.
 */

import { CaptureInputError } from "./errors.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(date: string): boolean {
  if (typeof date !== "string" || !DATE_PATTERN.test(date)) return false;
  // Reject impossible calendar days (2026-02-30, 2026-13-01): the UTC round-trip
  // must reproduce the same Y-M-D, else Date normalized an overflow.
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function timezoneOffsetIso(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "longOffset",
  }).formatToParts(instant);
  const name = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = name.match(/GMT([+-]\d{2}:\d{2})?/);
  return match?.[1] ?? "+00:00";
}

function shiftIsoDate(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

/**
 * First UTC instant whose local wall-clock is `date` at 00:00. Probe several
 * instants across the day (and the prior UTC day, for zones east of UTC) to
 * collect every offset in play; keep an offset only if constructing local
 * midnight with it lands back on that same offset, then take the EARLIEST such
 * instant — the FIRST 00:00 across a fall-back that repeats local midnight.
 */
function zonedDayStartIso(date: string, timezone: string): string {
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
    // Reject an offset whose local midnight does not actually occur (spring
    // forward skipped the wall clock): the offset in effect at the candidate
    // instant must equal the offset we used to build it.
    if (timezoneOffsetIso(new Date(candidate), timezone) !== offset) continue;
    if (best === null || candidate < best) best = candidate;
  }
  if (best === null) {
    // Local midnight was skipped by a spring-forward at 00:00. Advance to the
    // first local wall-clock minute on this date that actually exists, scanning
    // forward up to 3h.
    for (let minute = 1; minute <= 180 && best === null; minute++) {
      const hh = String(Math.floor(minute / 60)).padStart(2, "0");
      const mm = String(minute % 60).padStart(2, "0");
      for (const offset of probeOffsets) {
        const candidate = Date.parse(`${date}T${hh}:${mm}:00${offset}`);
        if (!Number.isFinite(candidate)) continue;
        if (timezoneOffsetIso(new Date(candidate), timezone) !== offset) continue;
        if (best === null || candidate < best) best = candidate;
      }
    }
  }
  if (best === null) {
    const noon = timezoneOffsetIso(new Date(`${date}T12:00:00Z`), timezone);
    best = Date.parse(`${date}T00:00:00${noon}`);
  }
  if (best === null || !Number.isFinite(best)) {
    throw new CaptureInputError(`could not resolve a local day start for '${date}' in '${timezone}'`);
  }
  return new Date(best).toISOString();
}

/** Half-open [startUtc, endUtc) UTC ISO bounds of a local day. */
export function activityDayWindow(date: string, timezone: string): { startUtc: string; endUtc: string } {
  if (!isValidDate(date)) {
    throw new CaptureInputError(`invalid date '${date}' — expected a real YYYY-MM-DD day`);
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new CaptureInputError(`invalid timezone '${timezone}' — not a known IANA timezone`);
  }
  return {
    startUtc: new Date(zonedDayStartIso(date, timezone)).toISOString(),
    endUtc: new Date(zonedDayStartIso(shiftIsoDate(date, 1), timezone)).toISOString(),
  };
}
