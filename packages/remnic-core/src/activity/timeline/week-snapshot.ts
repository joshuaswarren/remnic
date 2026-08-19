/**
 * Deterministic markdown week snapshot from daily totals (issue #2052 leftover).
 *
 * Pure: weekStart + timezone + days in, stable markdown out. No LLM, no I/O, no
 * persistence. Days are sorted by date. Empty days print heading + (empty).
 */

export interface WeekSnapshotDay {
  date: string;
}

export interface WeekSnapshotOptions {
  weekStart: string;
  timezone: string;
  days: readonly WeekSnapshotDay[];
}

function compareDates(a: WeekSnapshotDay, b: WeekSnapshotDay): number {
  if (a.date < b.date) return -1;
  if (a.date > b.date) return 1;
  return 0;
}

/** Render a byte-stable Markdown week snapshot. */
export function renderWeekSnapshot(options: WeekSnapshotOptions): string {
  const days = [...options.days].sort(compareDates);
  const body =
    days.length === 0
      ? ["## Days", "(empty)"]
      : days.flatMap((day) => [`## ${day.date}`, "(empty)", ""]);
  return [
    "# Week snapshot",
    "",
    `- weekStart: ${options.weekStart}`,
    `- timezone: ${options.timezone}`,
    "",
    ...body,
    "",
  ].join("\n");
}
