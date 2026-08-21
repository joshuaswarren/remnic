/**
 * Strict ISO 8601 date parsing for training-export CLI flags.
 *
 * Extracted from `cli.ts` so that both the canonical CLI (in
 * `@remnic/core`) and the thin front-end CLI (in `@remnic/cli`) can share
 * the same validator without duplicating the overflow/timezone rules.
 *
 * The parser rejects:
 *   - Non-ISO strings (e.g. "12/25/2026", "Dec 25 2026")
 *   - Calendar overflows (Feb 30, Feb 29 in non-leap years, Apr 31, etc.)
 *     regardless of timezone suffix
 *   - Out-of-range time components (hour >= 24, minute >= 60, second >= 60)
 *   - Out-of-range timezone offsets (beyond ±14:00, or offset minute >= 60)
 *
 * Calendar overflow is validated structurally on the Y-M-D components, so
 * results are independent of the host's local timezone.
 */

/**
 * Days in each month (1-indexed). February is 28 here; leap-year handling
 * is applied by `isCalendarDateValid` below.
 */
const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * True iff `year-month-day` is a valid Gregorian calendar date. Input
 * numbers must be integer-valued; month is 1-12, day is 1-31 nominally.
 */
export function isCalendarDateValid(
  year: number,
  month: number,
  day: number,
): boolean {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return false;
  }
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  const maxDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month];
  return day <= maxDay;
}

/**
 * Parse a strict ISO 8601 date string, rejecting malformed inputs, calendar
 * overflows, and out-of-range time components with a descriptive error.
 *
 * Accepted forms:
 *   YYYY-MM-DD
 *   YYYY-MM-DDTHH:mm:ss                (naive / local time)
 *   YYYY-MM-DDTHH:mm:ss.sssZ           (UTC)
 *   YYYY-MM-DDTHH:mm:ss+HH:MM          (with timezone offset)
 *   YYYY-MM-DDTHH:mm:ss.sss-HH:MM      (with timezone offset)
 *
 * `flagName` is included in the error message so users can identify which
 * input failed (e.g. `--since` vs. `--until`).
 */
export function parseStrictCliDate(value: string, flagName: string): Date {
  // 1. Shape check: must begin YYYY-MM-DD and use ISO 8601 structure.
  //    This rejects "12/25/2026", "December 25, 2026", RFC 2822, etc.
  const shape =
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:Z|([+-])(\d{2}):(\d{2}))?)?$/;
  const match = value.match(shape);
  if (!match) {
    throw new Error(
      `Invalid ${flagName} value "${value}": expected ISO 8601 format (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss[.sss][Z|±HH:MM]).`,
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  // 2. Structural calendar validation. This rejects Feb 31, Feb 29 in
  //    non-leap years, Apr 31, etc. regardless of the timezone suffix, so
  //    "2026-02-31T00:00:00+05:30" is rejected the same way as "2026-02-31Z".
  if (!isCalendarDateValid(year, month, day)) {
    throw new Error(
      `Invalid ${flagName} value "${value}": date components overflow (e.g. month has fewer days). Provide a valid calendar date.`,
    );
  }

  // 3. Optional time-component validation.
  //    JavaScript's Date cannot represent a leap second: `:60` is silently
  //    normalised to `:00` of the following minute, which would make a
  //    "strict" validator return a different timestamp than the user
  //    requested. Reject second == 60 outright so a strict parse cannot
  //    round-trip to a different clock value.
  if (match[4] !== undefined) {
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = match[6] !== undefined ? Number(match[6]) : 0;
    if (hour > 23 || minute > 59 || second > 59) {
      throw new Error(
        `Invalid ${flagName} value "${value}": time components out of range.`,
      );
    }
  }

  // 4. Timezone offset validation.
  //    Date accepts offset hours beyond the real-world UTC offset range and
  //    normalizes impossible offsets into a shifted instant. Reject those
  //    before constructing the Date so the CLI cannot silently apply them.
  if (match[8] !== undefined) {
    const offsetHour = Number(match[9]);
    const offsetMinute = Number(match[10]);
    if (
      offsetHour > 14 ||
      offsetMinute > 59 ||
      (offsetHour === 14 && offsetMinute !== 0)
    ) {
      throw new Error(
        `Invalid ${flagName} value "${value}": timezone offset out of range.`,
      );
    }
  }

  // 5. Finally parse via Date for the actual timestamp value. At this point
  //    we've already validated structure and calendar correctness, so any
  //    remaining NaN (extremely unlikely) still fails closed.
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) {
    throw new Error(
      `Invalid ${flagName} value "${value}". Provide an ISO 8601 date string (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss).`,
    );
  }

  return d;
}
