/**
 * Deterministic recap export over a bounded date range (issue #2051).
 *
 * Pure: cards + inclusive [startDate, endDate] + timezone in, stable JSON or
 * Markdown out. No LLM, no I/O. Every date in the range gets a day entry —
 * empty days included — and cards land on their stored `dayKey`, so reruns
 * with the same inputs always produce the same bytes regardless of input
 * card order. Cards whose `dayKey` falls outside the range are not exported.
 *
 * The range is bounded: at most `maxDays` days (default 366) per call, so a
 * swapped start/end or a multi-year span fails with a typed error instead of
 * producing an unbounded document.
 */
import { isValidActivityDate } from "../digest.js";
import { parseRecapDate } from "./recap-date.js";
import { renderDeterministicJournal } from "./journal-recap.js";
import {
  projectCardForRecapExport,
  type RecapExportCard,
} from "./recap-export.js";
import type { TimelineCard } from "./types.js";

export const DEFAULT_RECAP_RANGE_MAX_DAYS = 366;

export interface DeterministicRecapRangeOptions {
  /** Inclusive first local day, YYYY-MM-DD. */
  startDate: string;
  /** Inclusive last local day, YYYY-MM-DD. */
  endDate: string;
  timezone: string;
  cards: readonly TimelineCard[];
  /** Include observation-derived card content (`title`). Default false. */
  includeObservations?: boolean;
  /** Hard upper bound on exported days; default 366. */
  maxDays?: number;
}

export interface DeterministicRecapDay {
  date: string;
  timezone: string;
  cards: RecapExportCard[];
}

export interface DeterministicRecapRange {
  startDate: string;
  endDate: string;
  timezone: string;
  days: DeterministicRecapDay[];
}

export type DeterministicRecapRangeResult =
  | { ok: true; range: DeterministicRecapRange }
  | {
      ok: false;
      error:
        | "invalid_start_date"
        | "invalid_end_date"
        | "end_before_start"
        | "range_too_large";
      /** The enforced day bound, present on range_too_large. */
      limit?: number;
    };

export type DeterministicRecapRangeMarkdownResult =
  | { ok: true; markdown: string; dayCount: number }
  | Extract<DeterministicRecapRangeResult, { ok: false }>;

function compareCardIds(a: RecapExportCard, b: RecapExportCard): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/** UTC-midnight stepping over validated real calendar dates. */
function* isoDays(startDate: string, endDate: string): Generator<string> {
  const endMs = Date.parse(`${endDate}T00:00:00Z`);
  let cursor = new Date(`${startDate}T00:00:00Z`);
  while (cursor.getTime() <= endMs) {
    yield cursor.toISOString().slice(0, 10);
    cursor = new Date(cursor.getTime() + 86_400_000);
  }
}

function dayCount(startDate: string, endDate: string): number {
  return (
    (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) /
      86_400_000 +
    1
  );
}

/**
 * Build the byte-stable JSON recap document for an inclusive local-day
 * range. Day entries are ascending; day cards are sorted by id; per-card
 * key order is fixed by `projectCardForRecapExport`.
 */
export function exportDeterministicRecapRange(
  options: DeterministicRecapRangeOptions,
): DeterministicRecapRangeResult {
  const start = parseRecapDate(options.startDate);
  if (!start.ok || !isValidActivityDate(start.date)) {
    return { ok: false, error: "invalid_start_date" };
  }
  const end = parseRecapDate(options.endDate);
  if (!end.ok || !isValidActivityDate(end.date)) {
    return { ok: false, error: "invalid_end_date" };
  }
  if (Date.parse(`${end.date}T00:00:00Z`) < Date.parse(`${start.date}T00:00:00Z`)) {
    return { ok: false, error: "end_before_start" };
  }
  const limit = options.maxDays ?? DEFAULT_RECAP_RANGE_MAX_DAYS;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`maxDays must be a positive integer; got ${options.maxDays}`);
  }
  if (dayCount(start.date, end.date) > limit) {
    return { ok: false, error: "range_too_large", limit };
  }

  const includeObservations = options.includeObservations === true;
  const byDay = new Map<string, RecapExportCard[]>();
  for (const card of options.cards) {
    if (card.dayKey < start.date || card.dayKey > end.date) continue;
    const bucket = byDay.get(card.dayKey);
    const projected = projectCardForRecapExport(card, includeObservations);
    if (bucket === undefined) byDay.set(card.dayKey, [projected]);
    else bucket.push(projected);
  }

  const days: DeterministicRecapDay[] = [];
  for (const date of isoDays(start.date, end.date)) {
    days.push({
      date,
      timezone: options.timezone,
      cards: (byDay.get(date) ?? []).sort(compareCardIds),
    });
  }
  return {
    ok: true,
    range: {
      startDate: start.date,
      endDate: end.date,
      timezone: options.timezone,
      days,
    },
  };
}

/**
 * Render the byte-stable Markdown recap for an inclusive local-day range:
 * one `renderDeterministicJournal` section per day, ascending. Validation
 * and bounds match `exportDeterministicRecapRange`.
 */
export function renderDeterministicJournalRange(
  options: DeterministicRecapRangeOptions,
): DeterministicRecapRangeMarkdownResult {
  const exported = exportDeterministicRecapRange(options);
  if (!exported.ok) return exported;
  const sections = exported.range.days.map((day) =>
    renderDeterministicJournal(day.cards, {
      date: day.date,
      timezone: day.timezone,
    }),
  );
  return {
    ok: true,
    markdown: sections.join("\n"),
    dayCount: exported.range.days.length,
  };
}
