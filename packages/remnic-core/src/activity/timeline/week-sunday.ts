/**
 * UTC Sunday predicate for a YYYY-MM-DD date (issue #2052).
 */
import { isValidActivityDate } from "../digest.js";

/** Parse `dateIso` as YYYY-MM-DD. Sunday UTC → true. */
export function isSundayIso(dateIso: string): boolean {
  if (!isValidActivityDate(dateIso)) {
    throw new RangeError(`Invalid date "${dateIso}"; expected YYYY-MM-DD.`);
  }
  return new Date(`${dateIso}T00:00:00Z`).getUTCDay() === 0;
}
