/**
 * UTC ISO-8601 week ids (`YYYY-Www`) shared by compounding reports and the
 * daemon weekly run. Week boundaries follow the Thursday rule: the week
 * belongs to the year that contains its Thursday.
 */

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** ISO week id for `d`, evaluated in UTC. */
export function isoWeekId(d: Date): string {
  // ISO week based on Thursday.
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((dt.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  const yyyy = dt.getUTCFullYear();
  return `${yyyy}-W${String(week).padStart(2, "0")}`;
}

/** The ISO week that ended before the week containing `d`. */
export function previousIsoWeekId(d: Date): string {
  const dt = new Date(d.getTime());
  dt.setUTCDate(dt.getUTCDate() - 7);
  return isoWeekId(dt);
}

/**
 * Milliseconds until the next Monday 00:00 UTC. Exactly on a Monday boundary
 * the next run is one week out, so a tick that fires on the boundary does not
 * schedule a zero-delay follow-up.
 */
export function msUntilNextIsoWeek(d: Date): number {
  const utcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const day = new Date(utcMidnight).getUTCDay() || 7;
  const daysFromMonday = day - 1;
  const thisMonday = utcMidnight - daysFromMonday * DAY_MS;
  const nextMonday = thisMonday + WEEK_MS;
  const delta = nextMonday - d.getTime();
  if (delta <= 0) return WEEK_MS;
  return delta;
}

/** True for the `YYYY-Www` ids this module produces (week 01 through 53). */
export function isIsoWeekId(weekId: string): boolean {
  if (weekId.length !== 8 || weekId[4] !== "-" || weekId[5] !== "W") return false;
  const year = weekId.slice(0, 4);
  const week = weekId.slice(6);
  for (let i = 0; i < year.length; i += 1) {
    const code = year.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  for (let i = 0; i < week.length; i += 1) {
    const code = week.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  const weekNum = Number(week);
  return weekNum >= 1 && weekNum <= 53;
}

/** How long a rubric cadence may go unreviewed before it counts as stale. */
export function cadenceStaleWindowMs(cadence: "daily" | "weekly" | "monthly" | "quarterly"): number {
  switch (cadence) {
    case "daily":
      return 2 * 24 * 60 * 60 * 1000;
    case "weekly":
      return 10 * 24 * 60 * 60 * 1000;
    case "monthly":
      return 45 * 24 * 60 * 60 * 1000;
    case "quarterly":
      return 120 * 24 * 60 * 60 * 1000;
    default:
      return 45 * 24 * 60 * 60 * 1000;
  }
}
