export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

export function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return value.trim();
}

export function assertSafePathSegment(value: string, field: string): string {
  if (value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
    throw new Error(`${field} must be a safe path segment`);
  }
  return value;
}

export function assertIsoRecordedAt(value: string, field = "recordedAt"): string {
  const parsed = parseIsoRecordedAt(value);
  if (!parsed) {
    throw new Error(`${field} must be an ISO timestamp`);
  }
  return value;
}

export function recordStoreDay(recordedAt: string): string {
  assertIsoRecordedAt(recordedAt);
  return recordedAt.slice(0, 10);
}

const ISO_RECORDED_AT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function parseIsoRecordedAt(value: string): boolean {
  const match = value.match(ISO_RECORDED_AT_RE);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (
    !Number.isInteger(year) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== month - 1 ||
    calendarDate.getUTCDate() !== day
  ) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

export function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of strings`);
  const items = value.map((item, index) => assertString(item, `${field}[${index}]`));
  return items.length > 0 ? items : undefined;
}

export function validateStringRecord(raw: unknown, field = "metadata"): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new Error(`${field} must be an object of strings`);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") throw new Error(`${field} must be an object of strings`);
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
