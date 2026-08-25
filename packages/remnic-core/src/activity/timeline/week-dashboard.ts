/**
 * Weekly dashboard snapshot composition (issue #2052).
 *
 * Composes the #2052 helpers into one machine-readable week document:
 * duration/category/day totals (`weekly.ts`), an explicit previous-period
 * comparison (`week-previous.ts`), threshold-gated recurrence
 * (`week-recurring.ts`), top application/domain summaries, source
 * card/evidence counts, and uncertainty flags. Pure: no I/O, no clock, no
 * LLM. This is a time/activity summary, never a score; it makes no claim
 * about mood, productivity, intent, presence, or quality of work.
 *
 * The result extends `WeeklyActivitySummary`, so `persistWeeklySnapshot`
 * accepts it unchanged: identical inputs rewrite nothing, and a new
 * sourceRevision or configHash keys a new snapshot file instead of mutating
 * an unrelated period. Application/domain attribution arrives as structured
 * per-card metadata (from the observations that built the cards), never
 * parsed back out of card prose.
 */
import type { TimelineCard } from "./types.js";
import { compareWeeklyPreviousPeriod, type WeeklyPreviousPeriod } from "./week-previous.js";
import {
  findRecurringPatterns,
  type RecurringPattern,
  type WeekDayOccurrence,
} from "./week-recurring.js";
import {
  buildWeeklyActivitySummary,
  type WeeklyActivityOptions,
  type WeeklyActivitySummary,
} from "./weekly.js";

export const WEEKLY_DASHBOARD_FORMAT_VERSION = 1;
export const DEFAULT_TOP_SOURCE_LIMIT = 10;
const DAY_MS = 86_400_000;
const WEEK_DAYS_MS = 7 * DAY_MS;

/** Structured activity metadata for one card, keyed by card id. */
export interface WeekSourceAttribution {
  /** Application name from the card's source observations. */
  app: string;
  /** Lowercased browser hostname, when the frontmost window was a browser. */
  domain?: string;
}

export interface WeeklySourceTotal {
  key: string;
  durationMs: number;
}

export interface WeeklyEvidenceStats {
  activityCardCount: number;
  idleCardCount: number;
  pauseCardCount: number;
  /** Evidence ids summed across in-week activity cards; repeats possible. */
  evidenceCount: number;
  /** Distinct evidence ids across in-week activity cards. */
  distinctEvidenceCount: number;
}

export interface WeeklyUncertainty {
  /** In-week cards clipped at a week bound: the week sees only part of them. */
  clippedCardCount: number;
  /** In-week cards carrying a manual edit; totals may not match raw captures. */
  manualEditCount: number;
  /** In-week cards classified with confidence 0 (unclassified signal). */
  unclassifiedCardCount: number;
}

export interface WeeklyDashboardSources {
  applications: WeeklySourceTotal[];
  domains: WeeklySourceTotal[];
}

export interface WeeklyDashboardRecurring {
  categories: RecurringPattern[];
  applications: RecurringPattern[];
}

export interface WeeklyDashboard extends WeeklyActivitySummary {
  dashboardFormatVersion: number;
  sources: WeeklyDashboardSources;
  recurring: WeeklyDashboardRecurring;
  evidence: WeeklyEvidenceStats;
  uncertainty: WeeklyUncertainty;
}

export interface WeeklyDashboardOptions extends WeeklyActivityOptions {
  /** Per-card application/domain metadata; cards without an entry are skipped in `sources`. */
  attributions?: ReadonlyMap<string, WeekSourceAttribution>;
  /** Cards of the immediately preceding week; absent keeps `previousPeriod` explicitly unavailable. */
  previousWeekCards?: readonly TimelineCard[];
  /** Distinct-day threshold passed to `findRecurringPatterns`. */
  recurrenceMinDays?: number;
  /** Max entries per source list; >= 1. */
  topSourceLimit?: number;
}

interface ClippedCard {
  card: TimelineCard;
  startMs: number;
  endMs: number;
  clipStartMs: number;
  clipEndMs: number;
}

function clippedInWeek(
  cards: readonly TimelineCard[],
  weekStartMs: number,
  weekEndMs: number,
): ClippedCard[] {
  const clipped: ClippedCard[] = [];
  for (const card of cards) {
    const startMs = Date.parse(card.startUtc);
    const endMs = Date.parse(card.endUtc);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    const clipStartMs = Math.max(startMs, weekStartMs);
    const clipEndMs = Math.min(endMs, weekEndMs);
    if (clipEndMs > clipStartMs) {
      clipped.push({ card, startMs, endMs, clipStartMs, clipEndMs });
    }
  }
  return clipped;
}

function normalizedAttribution(
  cardId: string,
  attributions: ReadonlyMap<string, WeekSourceAttribution> | undefined,
): { app: string; domain?: string } | null {
  const attribution = attributions?.get(cardId);
  if (attribution === undefined) return null;
  if (typeof attribution.app !== "string" || attribution.app.trim() === "") {
    throw new RangeError(`attribution for card ${cardId} must have a non-blank app`);
  }
  const app = attribution.app.trim();
  if (attribution.domain === undefined) return { app };
  if (typeof attribution.domain !== "string" || attribution.domain.trim() === "") {
    throw new RangeError(`attribution for card ${cardId} must have a non-blank domain when present`);
  }
  return { app, domain: attribution.domain.trim().toLowerCase() };
}

function rankTotals(totals: Map<string, number>, limit: number): WeeklySourceTotal[] {
  return [...totals.entries()]
    .map(([key, durationMs]) => ({ key, durationMs }))
    .sort(
      (a, b) =>
        b.durationMs - a.durationMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    )
    .slice(0, limit);
}

/** Build the full dashboard snapshot for one half-open week. Pure. */
export function buildWeeklyDashboard(
  cards: readonly TimelineCard[],
  options: WeeklyDashboardOptions,
): WeeklyDashboard {
  const summary = buildWeeklyActivitySummary(cards, options);
  const topSourceLimit = options.topSourceLimit ?? DEFAULT_TOP_SOURCE_LIMIT;
  if (!Number.isInteger(topSourceLimit) || topSourceLimit < 1) {
    throw new RangeError(`topSourceLimit must be an integer >= 1; got ${topSourceLimit}`);
  }

  // Canonical bounds from the summary: identical clipping arithmetic to
  // weekly.ts regardless of how the caller spelled the input timestamps.
  const weekStartMs = Date.parse(summary.weekStartUtc);
  const weekEndMs = Date.parse(summary.weekEndUtc);
  const inWeek = clippedInWeek(cards, weekStartMs, weekEndMs);

  const applicationTotals = new Map<string, number>();
  const domainTotals = new Map<string, number>();
  const applicationOccurrences: WeekDayOccurrence[] = [];
  const categoryOccurrences: WeekDayOccurrence[] = [];
  const evidence: WeeklyEvidenceStats = {
    activityCardCount: 0,
    idleCardCount: 0,
    pauseCardCount: 0,
    evidenceCount: 0,
    distinctEvidenceCount: 0,
  };
  const uncertainty: WeeklyUncertainty = {
    clippedCardCount: 0,
    manualEditCount: 0,
    unclassifiedCardCount: 0,
  };
  const distinctEvidence = new Set<number>();
  const dayWindows = summary.days.map((day) => ({
    date: day.date,
    startMs: Date.parse(day.startUtc),
    endMs: Date.parse(day.endUtc),
  }));

  for (const day of summary.days) {
    for (const total of day.categories) {
      if (total.durationMs > 0) {
        categoryOccurrences.push({ date: day.date, key: total.categoryId, durationMs: total.durationMs });
      }
    }
  }

  for (const { card, startMs, endMs, clipStartMs, clipEndMs } of inWeek) {
    if (startMs < weekStartMs || endMs > weekEndMs) {
      uncertainty.clippedCardCount++;
    }
    if (card.kind === "idle") {
      evidence.idleCardCount++;
      continue;
    }
    if (card.kind === "pause") {
      evidence.pauseCardCount++;
      continue;
    }
    evidence.activityCardCount++;
    for (const id of card.evidenceIds) {
      evidence.evidenceCount++;
      distinctEvidence.add(id);
    }
    if (card.manualEdit !== undefined) uncertainty.manualEditCount++;
    if (card.confidence === 0) uncertainty.unclassifiedCardCount++;

    const attribution = normalizedAttribution(card.id, options.attributions);
    if (attribution === null) continue;
    const durationMs = clipEndMs - clipStartMs;
    applicationTotals.set(attribution.app, (applicationTotals.get(attribution.app) ?? 0) + durationMs);
    if (attribution.domain !== undefined) {
      domainTotals.set(attribution.domain, (domainTotals.get(attribution.domain) ?? 0) + durationMs);
    }
    for (const day of dayWindows) {
      const dayStartMs = Math.max(clipStartMs, day.startMs);
      const dayEndMs = Math.min(clipEndMs, day.endMs);
      if (dayEndMs > dayStartMs) {
        applicationOccurrences.push({ date: day.date, key: attribution.app, durationMs: dayEndMs - dayStartMs });
      }
    }
  }
  evidence.distinctEvidenceCount = distinctEvidence.size;

  let previousPeriod: WeeklyPreviousPeriod = { available: false };
  if (options.previousWeekCards !== undefined) {
    const previousSummary = buildWeeklyActivitySummary(options.previousWeekCards, {
      ...options,
      weekStartUtc: new Date(weekStartMs - WEEK_DAYS_MS).toISOString(),
      weekEndUtc: summary.weekStartUtc,
    });
    previousPeriod = compareWeeklyPreviousPeriod({
      previous: previousSummary,
      current: summary,
      previousStartUtc: previousSummary.weekStartUtc,
      previousEndUtc: previousSummary.weekEndUtc,
    });
  }

  return {
    ...summary,
    previousPeriod,
    dashboardFormatVersion: WEEKLY_DASHBOARD_FORMAT_VERSION,
    sources: {
      applications: rankTotals(applicationTotals, topSourceLimit),
      domains: rankTotals(domainTotals, topSourceLimit),
    },
    recurring: {
      categories: findRecurringPatterns({
        occurrences: categoryOccurrences,
        minDays: options.recurrenceMinDays,
      }),
      applications: findRecurringPatterns({
        occurrences: applicationOccurrences,
        minDays: options.recurrenceMinDays,
      }),
    },
    evidence,
    uncertainty,
  };
}
