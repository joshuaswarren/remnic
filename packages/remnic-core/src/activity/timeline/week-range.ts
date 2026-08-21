/**
 * Half-open week range from a YYYY-MM-DD start (issue #2052).
 */
import { isValidActivityDate } from "../digest.js";

export interface WeekRangeInput {
  weekStartIso: string;
}

export interface WeekRange {
  start: string;
  endExclusive: string;
}

/** Parse `weekStartIso` as YYYY-MM-DD. Return `[start, start+7)`. */
export function weekRange({ weekStartIso }: WeekRangeInput): WeekRange {
  if (!isValidActivityDate(weekStartIso)) {
    throw new RangeError(`Invalid week start "${weekStartIso}"; expected YYYY-MM-DD.`);
  }
  const parsed = new Date(`${weekStartIso}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + 7);
  return {
    start: weekStartIso,
    endExclusive: parsed.toISOString().slice(0, 10),
  };
}
