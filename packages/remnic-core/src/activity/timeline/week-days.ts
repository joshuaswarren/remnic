/**
 * Inclusive 7-day week from a YYYY-MM-DD start (issue #2052).
 */
import { isValidActivityDate } from "../digest.js";

export interface WeekDaysInput {
  weekStartIso: string;
}

/** Parse `weekStartIso` as YYYY-MM-DD. Return `[start, start+6]`. */
export function listWeekDates({ weekStartIso }: WeekDaysInput): string[] {
  if (!isValidActivityDate(weekStartIso)) {
    throw new RangeError(`Invalid week start "${weekStartIso}"; expected YYYY-MM-DD.`);
  }
  const start = new Date(`${weekStartIso}T00:00:00Z`);
  const dates: string[] = [];
  for (let offset = 0; offset < 7; offset++) {
    const day = new Date(start);
    day.setUTCDate(start.getUTCDate() + offset);
    dates.push(day.toISOString().slice(0, 10));
  }
  return dates;
}
