/**
 * Previous-week duration comparison (issue #2052).
 *
 * The prior week is explicit when unavailable. It is never silently treated
 * as zero.
 */

export interface WeeklyDurationTotals {
  activeMs: number;
  idleMs: number;
  pauseMs: number;
  gapMs: number;
  unclassifiedMs: number;
}

export type WeeklyPreviousPeriod =
  | { available: false }
  | {
      available: true;
      previousStartUtc: string;
      previousEndUtc: string;
      deltaActiveMs: number;
      deltaIdleMs: number;
      deltaPauseMs: number;
      deltaGapMs: number;
      deltaUnclassifiedMs: number;
    };

const DURATION_FIELDS = [
  "activeMs",
  "idleMs",
  "pauseMs",
  "gapMs",
  "unclassifiedMs",
] as const;

function assertFiniteTotals(totals: WeeklyDurationTotals, label: string): void {
  for (const field of DURATION_FIELDS) {
    const value = totals[field];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError(`${label}.${field} must be a finite number; got ${String(value)}.`);
    }
  }
}

/**
 * Compare this week's duration totals against the previous week's.
 *
 * `previous` absent (null/undefined) or lacking trimmed start/end timestamps
 * returns `{ available: false }` — never zero deltas. Otherwise returns the
 * per-field deltas (`current - previous`, may be negative). Pure.
 */
export function compareWeeklyPreviousPeriod(input: {
  previous: WeeklyDurationTotals | null | undefined;
  current: WeeklyDurationTotals;
  previousStartUtc?: string;
  previousEndUtc?: string;
}): WeeklyPreviousPeriod {
  const { previous, current, previousStartUtc, previousEndUtc } = input;
  assertFiniteTotals(current, "current");

  if (previous === null || previous === undefined) {
    return { available: false };
  }
  assertFiniteTotals(previous, "previous");

  const start = previousStartUtc?.trim() ?? "";
  const end = previousEndUtc?.trim() ?? "";
  if (start === "" || end === "") {
    return { available: false };
  }

  return {
    available: true,
    previousStartUtc: start,
    previousEndUtc: end,
    deltaActiveMs: current.activeMs - previous.activeMs,
    deltaIdleMs: current.idleMs - previous.idleMs,
    deltaPauseMs: current.pauseMs - previous.pauseMs,
    deltaGapMs: current.gapMs - previous.gapMs,
    deltaUnclassifiedMs: current.unclassifiedMs - previous.unclassifiedMs,
  };
}
