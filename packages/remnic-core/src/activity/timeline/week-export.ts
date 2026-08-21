/**
 * Deterministic machine-readable week export from daily totals (issue #2052).
 *
 * Pure: weekStart + timezone + days in, stable JSON out. No LLM, no I/O, no
 * persistence. Same days always serialize to the same bytes, regardless of
 * input array order: days are sorted by date before serialization.
 */

export interface DeterministicWeekDay {
  date: string;
}

export interface DeterministicWeekOptions {
  weekStart: string;
  timezone: string;
  days: readonly DeterministicWeekDay[];
}

export interface DeterministicWeek {
  weekStart: string;
  timezone: string;
  days: DeterministicWeekDay[];
}

function compareDates(a: DeterministicWeekDay, b: DeterministicWeekDay): number {
  if (a.date < b.date) return -1;
  if (a.date > b.date) return 1;
  return 0;
}

/**
 * Build the byte-stable JSON week document.
 * Callers may `JSON.stringify` the returned object; construction order
 * (weekStart, timezone, days) is fixed, so serialization is deterministic.
 */
export function exportDeterministicWeek(
  options: DeterministicWeekOptions,
): DeterministicWeek {
  return {
    weekStart: options.weekStart,
    timezone: options.timezone,
    days: [...options.days].sort(compareDates),
  };
}
