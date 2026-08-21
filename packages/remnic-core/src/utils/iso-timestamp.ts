// ---------------------------------------------------------------------------
// Shared ISO-8601 / RFC 3339 timestamp validation helpers.
//
// Two public entry points — a strict UTC-only parser used by the replay
// pipeline, and a more permissive parser used by bulk-import adapters that
// need to preserve source timezone offsets. Both share date-component,
// offset-range, and round-trip validation so they cannot silently diverge.
// ---------------------------------------------------------------------------

// UTC-only: `...Z`, 0 or 3 fractional digits (replay canonical form).
const ISO_UTC_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

// Lenient: variable-precision fractional seconds and `Z` or `[+-]HH:MM` offset.
const ISO_OFFSET_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const FLEXIBLE_ISO_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:[Zz]|([+-])(\d{2}):(\d{2}))?)?$/;

function isoDaysInMonth(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

/**
 * Validate the date/time components of an ISO timestamp string.
 * Catches overflowed dates like Feb 31 that `Date.parse` silently normalizes.
 */
function validateDateComponents(isoString: string): boolean {
  const match = isoString.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/,
  );
  if (!match) return false;
  const [, yStr, mStr, dStr, hStr, minStr, sStr] = match;
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  const h = Number(hStr);
  const min = Number(minStr);
  const s = Number(sStr);
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  if (h > 23 || min > 59 || s > 59) return false;
  if (d > isoDaysInMonth(y, m)) return false;
  return true;
}

/**
 * Validate the timezone offset range if present.
 * Max offset is +/-14:00 per ISO 8601; minute part must be 0-59.
 */
function validateOffset(isoString: string): boolean {
  const offsetMatch = isoString.match(/([+-])(\d{2}):(\d{2})$/);
  if (!offsetMatch) return true; // `Z` form, no offset to validate.
  const oh = Number(offsetMatch[2]);
  const om = Number(offsetMatch[3]);
  if (oh > 14 || om > 59) return false;
  // +14:00 is max; offsets like +14:30 are invalid.
  if (oh === 14 && om > 0) return false;
  return true;
}

/**
 * Normalize a `Z`-suffixed ISO timestamp to exactly three fractional digits so
 * the round-trip comparison against `Date.prototype.toISOString()` succeeds
 * regardless of input precision (or absence of a fractional part).
 */
function normalizeUtcForComparison(value: string): string {
  const fracMatch = value.match(/\.(\d+)Z$/);
  if (fracMatch) {
    const ms = (fracMatch[1] + "000").slice(0, 3);
    return value.replace(/\.\d+Z$/, `.${ms}Z`);
  }
  return value.replace(/Z$/, ".000Z");
}

/**
 * Strict UTC-only parser — accepts `YYYY-MM-DDTHH:MM:SS[.sss]Z`.
 * Returns milliseconds since epoch, or `null` if invalid.
 */
export function parseIsoUtcTimestamp(value: string): number | null {
  if (typeof value !== "string" || !ISO_UTC_TIMESTAMP_RE.test(value)) {
    return null;
  }
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return null;
  if (!validateDateComponents(value)) return null;
  const roundTrip = new Date(ts).toISOString();
  if (roundTrip !== normalizeUtcForComparison(value)) return null;
  return ts;
}

/**
 * Lenient parser — accepts variable-precision fractional seconds and either
 * a `Z` suffix or a `[+-]HH:MM` offset. Returns milliseconds since epoch, or
 * `null` if the string is not a well-formed RFC 3339 timestamp.
 */
export function parseIsoOffsetTimestamp(value: string): number | null {
  if (typeof value !== "string" || !ISO_OFFSET_TIMESTAMP_RE.test(value)) {
    return null;
  }
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return null;
  if (!validateDateComponents(value)) return null;
  if (!validateOffset(value)) return null;
  // For UTC timestamps (ending in `Z`), verify with a round-trip so that
  // overflowed UTC calendar dates cannot slip through.
  if (value.endsWith("Z")) {
    const roundTrip = new Date(ts).toISOString();
    if (roundTrip !== normalizeUtcForComparison(value)) return null;
  }
  return ts;
}

/**
 * Benchmark/adapter parser — accepts ISO date-only values plus reduced
 * precision date-times used by public benchmark fixtures. Returns milliseconds
 * since epoch, or `null` if invalid.
 */
export function parseFlexibleIsoTimestamp(value: string): number | null {
  const match = typeof value === "string"
    ? value.match(FLEXIBLE_ISO_TIMESTAMP_RE)
    : null;
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = match[4] === undefined ? 0 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const offsetHour = match[8] === undefined ? undefined : Number(match[8]);
  const offsetMinute = match[9] === undefined ? undefined : Number(match[9]);
  const hasTime = match[4] !== undefined;
  const hasOffset = offsetHour !== undefined && offsetMinute !== undefined;
  const hasTimezone = /(?:[Zz]|[+-]\d{2}:\d{2})$/.test(value);

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > isoDaysInMonth(year, month) ||
    (hasTime && !hasTimezone)
  ) {
    return null;
  }
  if (hasTime && (hour > 23 || minute > 59 || second > 59)) {
    return null;
  }
  if (
    hasOffset &&
    (offsetMinute > 59 ||
      offsetHour > 14 ||
      (offsetHour === 14 && offsetMinute > 0))
  ) {
    return null;
  }

  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}
