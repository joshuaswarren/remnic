/**
 * Deterministic weekly time/activity summary over timeline cards (issue #2052).
 *
 * Pure: cards + week bounds + category registry in, snapshot out. Half-open
 * UTC [weekStart, weekEnd). Previous-period comparison is omitted in this
 * slice and marked unavailable, never a silent zero. Later surfaces
 * (CLI/MCP/HTTP/UI) consume this shape; they are not built here.
 */
import { parseFlexibleIsoTimestamp } from "../../utils/iso-timestamp.js";
import { activityDayWindow, assertValidTimezone } from "../digest.js";
import type { WeeklyPreviousPeriod } from "./week-previous.js";
import type { TimelineCard, TimelineCardKind, TimelineCategory } from "./types.js";

export const WEEKLY_ACTIVITY_FORMAT_VERSION = 1;

export interface WeeklyActivityOptions {
  timezone: string;
  weekStartUtc: string;
  weekEndUtc: string;
  categories: readonly TimelineCategory[];
}

export interface WeeklyCategoryTotal {
  categoryId: string;
  durationMs: number;
}

export interface WeeklyKindTotals {
  activeMs: number;
  idleMs: number;
  pauseMs: number;
  gapMs: number;
  unclassifiedMs: number;
}

export interface WeeklyDayTotal extends WeeklyKindTotals {
  date: string;
  startUtc: string;
  endUtc: string;
  categories: WeeklyCategoryTotal[];
}

/** First slice never computes a prior week; the field is present so callers cannot treat absence as zero. */
export interface WeeklyPreviousPeriodUnavailable {
  available: false;
}

export interface WeeklyActivitySummary extends WeeklyKindTotals {
  formatVersion: number;
  timezone: string;
  weekStartUtc: string;
  weekEndUtc: string;
  categories: WeeklyCategoryTotal[];
  days: WeeklyDayTotal[];
  previousPeriod: WeeklyPreviousPeriod;
}

interface Acc extends WeeklyKindTotals {
  byCategory: Map<string, number>;
  intervals: Array<[number, number]>;
}

function parseBound(value: string, label: string): number {
  const ms = parseFlexibleIsoTimestamp(value);
  if (ms === null) {
    throw new RangeError(`${label} is not a valid ISO timestamp`);
  }
  return ms;
}

function clip(start: number, end: number, winStart: number, winEnd: number): [number, number] | null {
  const clippedStart = Math.max(start, winStart);
  const clippedEnd = Math.min(end, winEnd);
  return clippedEnd > clippedStart ? [clippedStart, clippedEnd] : null;
}

function unionDuration(intervals: readonly (readonly [number, number])[]): number {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let total = 0;
  let curStart = Number.NaN;
  let curEnd = Number.NaN;
  for (const [start, end] of sorted) {
    if (!Number.isFinite(curStart)) {
      curStart = start;
      curEnd = end;
      continue;
    }
    if (start <= curEnd) {
      curEnd = Math.max(curEnd, end);
      continue;
    }
    total += curEnd - curStart;
    curStart = start;
    curEnd = end;
  }
  if (Number.isFinite(curStart)) total += curEnd - curStart;
  return total;
}

function localDateOf(ms: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function shiftIsoDate(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function daysOverlappingWeek(
  weekStartMs: number,
  weekEndMs: number,
  timezone: string,
): Array<{ date: string; startMs: number; endMs: number }> {
  if (weekEndMs <= weekStartMs) return [];
  let date = localDateOf(weekStartMs, timezone);
  let window = activityDayWindow(date, timezone);
  if (Date.parse(window.startUtc) > weekStartMs) {
    date = shiftIsoDate(date, -1);
    window = activityDayWindow(date, timezone);
  }
  const days: Array<{ date: string; startMs: number; endMs: number }> = [];
  while (Date.parse(window.startUtc) < weekEndMs) {
    const startMs = Math.max(Date.parse(window.startUtc), weekStartMs);
    const endMs = Math.min(Date.parse(window.endUtc), weekEndMs);
    if (endMs > startMs) days.push({ date, startMs, endMs });
    date = shiftIsoDate(date, 1);
    window = activityDayWindow(date, timezone);
  }
  return days;
}

function emptyAcc(categoryIds: readonly string[]): Acc {
  return {
    activeMs: 0,
    idleMs: 0,
    pauseMs: 0,
    gapMs: 0,
    unclassifiedMs: 0,
    byCategory: new Map(categoryIds.map((id) => [id, 0])),
    intervals: [],
  };
}

function addClipped(acc: Acc, kind: TimelineCardKind, categoryId: string, known: ReadonlySet<string>, start: number, end: number): void {
  const duration = end - start;
  acc.intervals.push([start, end]);
  if (kind === "idle") acc.idleMs += duration;
  else if (kind === "pause") acc.pauseMs += duration;
  else acc.activeMs += duration;
  if (known.has(categoryId)) {
    acc.byCategory.set(categoryId, (acc.byCategory.get(categoryId) ?? 0) + duration);
  } else {
    acc.unclassifiedMs += duration;
  }
}

function sortCategoryTotals(byCategory: Map<string, number>): WeeklyCategoryTotal[] {
  return [...byCategory.entries()]
    .map(([categoryId, durationMs]) => ({ categoryId, durationMs }))
    .sort((a, b) => b.durationMs - a.durationMs || (a.categoryId < b.categoryId ? -1 : a.categoryId > b.categoryId ? 1 : 0));
}

function finish(acc: Acc, windowMs: number): WeeklyKindTotals & { categories: WeeklyCategoryTotal[] } {
  const covered = unionDuration(acc.intervals);
  return {
    activeMs: acc.activeMs,
    idleMs: acc.idleMs,
    pauseMs: acc.pauseMs,
    gapMs: Math.max(0, windowMs - covered),
    unclassifiedMs: acc.unclassifiedMs,
    categories: sortCategoryTotals(acc.byCategory),
  };
}

/** Build a time/activity summary for one half-open week. Pure. */
export function buildWeeklyActivitySummary(
  cards: readonly TimelineCard[],
  options: WeeklyActivityOptions,
): WeeklyActivitySummary {
  assertValidTimezone(options.timezone);
  const weekStartMs = parseBound(options.weekStartUtc, "weekStartUtc");
  const weekEndMs = parseBound(options.weekEndUtc, "weekEndUtc");
  if (weekStartMs > weekEndMs) {
    throw new RangeError("reversed range: weekStartUtc must be <= weekEndUtc");
  }

  const categoryIds = options.categories.map((category) => category.id);
  const known = new Set(categoryIds);
  const week = emptyAcc(categoryIds);
  const dayWindows = daysOverlappingWeek(weekStartMs, weekEndMs, options.timezone);
  const dayAccs = dayWindows.map(() => emptyAcc(categoryIds));

  for (const card of cards) {
    const start = Date.parse(card.startUtc);
    const end = Date.parse(card.endUtc);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const weekClip = clip(start, end, weekStartMs, weekEndMs);
    if (!weekClip) continue;
    addClipped(week, card.kind, card.categoryId, known, weekClip[0], weekClip[1]);
    for (let i = 0; i < dayWindows.length; i++) {
      const day = dayWindows[i];
      const dayClip = clip(start, end, day.startMs, day.endMs);
      if (dayClip) addClipped(dayAccs[i], card.kind, card.categoryId, known, dayClip[0], dayClip[1]);
    }
  }

  const weekTotals = finish(week, weekEndMs - weekStartMs);
  const days: WeeklyDayTotal[] = dayWindows.map((day, i) => {
    const totals = finish(dayAccs[i], day.endMs - day.startMs);
    return {
      date: day.date,
      startUtc: new Date(day.startMs).toISOString(),
      endUtc: new Date(day.endMs).toISOString(),
      ...totals,
    };
  });

  return {
    formatVersion: WEEKLY_ACTIVITY_FORMAT_VERSION,
    timezone: options.timezone,
    weekStartUtc: new Date(weekStartMs).toISOString(),
    weekEndUtc: new Date(weekEndMs).toISOString(),
    ...weekTotals,
    days,
    previousPeriod: { available: false },
  };
}
