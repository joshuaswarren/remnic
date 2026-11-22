
export type RecapTimezoneResult =
  | { ok: true; timezone: string }
  | { ok: false; error: "missing_timezone" | "invalid_timezone" };

const RECAP_TIMEZONE = /^[A-Za-z0-9_+/-]{1,64}$/;

export function normalizeRecapTimezone(value: string): RecapTimezoneResult {
  const timezone = value.trim();
  if (timezone.length === 0) return { ok: false, error: "missing_timezone" };
  if (!RECAP_TIMEZONE.test(timezone)) return { ok: false, error: "invalid_timezone" };
  return { ok: true, timezone };
}
