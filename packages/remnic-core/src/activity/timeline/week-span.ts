/**
 * Half-open day span between two YYYY-MM-DD dates (issue #2052 leftover).
 *
 * Inclusive start, exclusive end. Invalid dates throw. end<=start throws.
 */
import { isValidActivityDate } from "../digest.js";

export function daysBetweenIso(startIso: string, endIso: string): number {
  if (!isValidActivityDate(startIso) || !isValidActivityDate(endIso)) {
    throw new RangeError(`Invalid date; expected YYYY-MM-DD.`);
  }
  const start = Date.parse(`${startIso}T00:00:00Z`);
  const end = Date.parse(`${endIso}T00:00:00Z`);
  if (end <= start) {
    throw new RangeError("end must be after start");
  }
  return (end - start) / 86_400_000;
}
