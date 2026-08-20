/**
 * Recurring weekly pattern gate (issue #2052).
 *
 * A category/application key counts as recurring only when it appeared on at
 * least `minDays` DISTINCT days of the analyzed week, so a one-off blip is
 * never reported as a pattern. Pure: no I/O, no clock, no input mutation.
 * Validation happens on the exact occurrence values before any key trimming
 * (AGENTS.md: validate before normalizing; reject non-finite numbers
 * explicitly instead of letting NaN fall through a comparison).
 */
import { isValidActivityDate } from "../digest.js";

export const DEFAULT_RECURRENCE_MIN_DAYS = 3;

export interface WeekDayOccurrence {
  /** YYYY-MM-DD inside the analyzed week. */
  date: string;
  /** Category id or application/domain label. */
  key: string;
  durationMs: number;
}

export interface RecurringPattern {
  key: string;
  /** Count of DISTINCT days the key appeared on. */
  dayCount: number;
  totalDurationMs: number;
}

export function findRecurringPatterns(input: {
  occurrences: readonly WeekDayOccurrence[];
  minDays?: number;
}): RecurringPattern[] {
  const minDays = input.minDays ?? DEFAULT_RECURRENCE_MIN_DAYS;
  if (!Number.isInteger(minDays) || minDays < 1) {
    throw new RangeError(`Invalid minDays ${minDays}; expected an integer >= 1.`);
  }

  const daysByKey = new Map<string, Set<string>>();
  const totalsByKey = new Map<string, number>();

  for (const occurrence of input.occurrences) {
    if (!isValidActivityDate(occurrence.date)) {
      throw new RangeError(`Invalid date "${occurrence.date}"; expected YYYY-MM-DD.`);
    }
    if (
      typeof occurrence.durationMs !== "number" ||
      !Number.isFinite(occurrence.durationMs) ||
      occurrence.durationMs < 0
    ) {
      throw new RangeError(`Invalid durationMs ${occurrence.durationMs}; expected a finite number >= 0.`);
    }
    const key = occurrence.key.trim();
    if (key === "") continue;
    let days = daysByKey.get(key);
    if (!days) {
      days = new Set<string>();
      daysByKey.set(key, days);
      totalsByKey.set(key, 0);
    }
    days.add(occurrence.date);
    totalsByKey.set(key, totalsByKey.get(key)! + occurrence.durationMs);
  }

  const patterns: RecurringPattern[] = [];
  for (const [key, days] of daysByKey) {
    if (days.size < minDays) continue;
    patterns.push({ key, dayCount: days.size, totalDurationMs: totalsByKey.get(key)! });
  }

  patterns.sort((a, b) => {
    if (a.dayCount !== b.dayCount) return b.dayCount - a.dayCount;
    if (a.totalDurationMs !== b.totalDurationMs) return b.totalDurationMs - a.totalDurationMs;
    if (a.key < b.key) return -1;
    if (a.key > b.key) return 1;
    return 0;
  });
  return patterns;
}
