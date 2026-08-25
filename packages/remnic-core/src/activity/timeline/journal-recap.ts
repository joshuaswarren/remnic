/**
 * Deterministic daily journal recap from timeline cards (issue #2051).
 *
 * Pure: cards + date + timezone in, Markdown out. No LLM, no I/O.
 * Same cards always produce the same bytes. Empty days still yield a
 * valid file body. Does not invent people, mood, or productivity claims.
 */
import { activityDayWindow } from "../digest.js";
import type { TimelineCardKind } from "./types.js";

/**
 * Minimal card shape the renderer reads. `TimelineCard` is assignable, and
 * so is the privacy-projected export card whose `title` is stripped
 * (issue #2051): a title-less card renders its stable id instead.
 */
export interface JournalRenderCard {
  id: string;
  kind: TimelineCardKind;
  title?: string;
  categoryId: string;
  startUtc: string;
  endUtc: string;
}
export interface DeterministicJournalOptions {
  date: string;
  timezone: string;
}

interface ClippedCard {
  card: JournalRenderCard;
  startMs: number;
  endMs: number;
  durationMs: number;
}

function formatMinutes(ms: number): string {
  return `${Math.round(ms / 60_000)}m`;
}

function clipToWindow(
  cards: readonly JournalRenderCard[],
  winStart: number,
  winEnd: number,
): ClippedCard[] {
  const clipped: ClippedCard[] = [];
  for (const card of cards) {
    const start = Date.parse(card.startUtc);
    const end = Date.parse(card.endUtc);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const startMs = Math.max(start, winStart);
    const endMs = Math.min(end, winEnd);
    if (endMs <= startMs) continue;
    clipped.push({ card, startMs, endMs, durationMs: endMs - startMs });
  }
  clipped.sort((left, right) => {
    const byStart = left.startMs - right.startMs;
    if (byStart !== 0) return byStart;
    const byTitle = (left.card.title ?? "").localeCompare(right.card.title ?? "");
    if (byTitle !== 0) return byTitle;
    return left.card.id.localeCompare(right.card.id);
  });
  return clipped;
}

function categoryLines(clipped: readonly ClippedCard[]): string[] {
  const totals = new Map<string, number>();
  for (const row of clipped) {
    totals.set(row.card.categoryId, (totals.get(row.card.categoryId) ?? 0) + row.durationMs);
  }
  const rows = [...totals.entries()].sort((left, right) => {
    const byDuration = right[1] - left[1];
    return byDuration !== 0 ? byDuration : left[0].localeCompare(right[0]);
  });
  if (rows.length === 0) return ["_No categories._"];
  return rows.map(([categoryId, durationMs]) => `- ${formatMinutes(durationMs)} ${categoryId}`);
}

function mergeIntervals(intervals: readonly (readonly [number, number])[]): Array<[number, number]> {
  const ordered = [...intervals].sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of ordered) {
    const last = merged[merged.length - 1];
    if (!last || start > last[1]) merged.push([start, end]);
    else last[1] = Math.max(last[1], end);
  }
  return merged;
}

function countGaps(
  winStart: number,
  winEnd: number,
  intervals: readonly (readonly [number, number])[],
): number {
  const merged = mergeIntervals(intervals);
  let gaps = 0;
  let cursor = winStart;
  for (const [start, end] of merged) {
    if (start > cursor) gaps += 1;
    cursor = Math.max(cursor, end);
  }
  if (cursor < winEnd) gaps += 1;
  return gaps;
}

/** Render a byte-stable Markdown journal for one local day. */
export function renderDeterministicJournal(
  cards: readonly JournalRenderCard[],
  options: DeterministicJournalOptions,
): string {
  const window = activityDayWindow(options.date, options.timezone);
  const winStart = Date.parse(window.startUtc);
  const winEnd = Date.parse(window.endUtc);
  const clipped = clipToWindow(cards, winStart, winEnd);
  const idle = clipped.filter((row) => row.card.kind === "idle").length;
  const pause = clipped.filter((row) => row.card.kind === "pause").length;
  const gaps = countGaps(
    winStart,
    winEnd,
    clipped.map((row) => [row.startMs, row.endMs]),
  );
  const cardLines =
    clipped.length === 0
      ? ["_No cards._"]
      : clipped.map((row) => `- ${formatMinutes(row.durationMs)} ${row.card.title ?? row.card.id}`);
  return [
    `# Journal — ${options.date} (${options.timezone})`,
    "",
    "## Categories",
    "",
    ...categoryLines(clipped),
    "",
    "## Cards",
    "",
    ...cardLines,
    "",
    "## Gaps / idle / pause",
    "",
    `- Gaps: ${gaps}`,
    `- Idle: ${idle}`,
    `- Pause: ${pause}`,
    "",
  ].join("\n");
}
