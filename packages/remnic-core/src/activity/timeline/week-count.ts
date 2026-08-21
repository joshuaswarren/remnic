/**
 * Week-day counter (issue #2052 leftover).
 *
 * Unique YYYY-MM-DD strings after dropping empty strings. Does not mutate input.
 */

export function countWeekDays(dates: readonly string[]): number {
  const unique = new Set<string>();
  for (const date of dates) {
    if (date !== "") unique.add(date);
  }
  return unique.size;
}
