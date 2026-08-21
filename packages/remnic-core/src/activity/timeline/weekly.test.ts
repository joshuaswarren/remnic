import assert from "node:assert/strict";
import test from "node:test";

import type { TimelineCard, TimelineCategory } from "./types.js";
import { buildWeeklyActivitySummary } from "./weekly.js";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK_START = "2026-07-13T00:00:00.000Z";
const WEEK_END = "2026-07-20T00:00:00.000Z";
const WEEK_MS = 7 * DAY;

const CATEGORIES: TimelineCategory[] = [
  { id: "alpha", name: "Alpha", color: "#111111", description: "a", order: 1 },
  { id: "beta", name: "Beta", color: "#222222", description: "b", order: 2 },
  { id: "development", name: "Development", color: "#333333", description: "d", order: 3 },
];

function card(
  overrides: Partial<TimelineCard> & Pick<TimelineCard, "id" | "startUtc" | "endUtc">,
): TimelineCard {
  return {
    kind: "activity",
    title: "Untitled",
    summary: "none",
    categoryId: "development",
    confidence: 1,
    dayKey: overrides.startUtc.slice(0, 10),
    timezone: "UTC",
    machine: "ws-a",
    evidenceIds: [],
    evidenceRange: null,
    ...overrides,
  };
}

function options(overrides: Partial<Parameters<typeof buildWeeklyActivitySummary>[1]> = {}) {
  return {
    timezone: "UTC",
    weekStartUtc: WEEK_START,
    weekEndUtc: WEEK_END,
    categories: CATEGORIES,
    ...overrides,
  };
}

test("empty week reports zeros, full gap, and previous period unavailable", () => {
  const summary = buildWeeklyActivitySummary([], options());
  assert.equal(summary.formatVersion, 1);
  assert.equal(summary.activeMs, 0);
  assert.equal(summary.idleMs, 0);
  assert.equal(summary.pauseMs, 0);
  assert.equal(summary.unclassifiedMs, 0);
  assert.equal(summary.gapMs, WEEK_MS);
  assert.deepEqual(
    summary.categories.map((row) => row.durationMs),
    [0, 0, 0],
  );
  assert.equal(summary.days.length, 7);
  assert.ok(summary.days.every((day) => day.gapMs === DAY && day.activeMs === 0));
  assert.deepEqual(summary.previousPeriod, { available: false });
  assert.equal("durationMs" in summary.previousPeriod, false);
  const blob = JSON.stringify(summary);
  assert.equal(/productivity|mood|intent|score/i.test(blob), false);
});

test("exact midnight boundary is not double-counted", () => {
  const summary = buildWeeklyActivitySummary(
    [
      card({
        id: "ends-at-midnight",
        categoryId: "alpha",
        startUtc: "2026-07-13T23:00:00.000Z",
        endUtc: "2026-07-14T00:00:00.000Z",
      }),
      card({
        id: "starts-at-midnight",
        categoryId: "beta",
        startUtc: "2026-07-14T00:00:00.000Z",
        endUtc: "2026-07-14T01:00:00.000Z",
      }),
      card({
        id: "before-week",
        categoryId: "development",
        startUtc: "2026-07-12T23:00:00.000Z",
        endUtc: WEEK_START,
      }),
      card({
        id: "after-week",
        categoryId: "development",
        startUtc: WEEK_END,
        endUtc: "2026-07-20T01:00:00.000Z",
      }),
    ],
    options(),
  );
  assert.equal(summary.categories.find((row) => row.categoryId === "alpha")?.durationMs, HOUR);
  assert.equal(summary.categories.find((row) => row.categoryId === "beta")?.durationMs, HOUR);
  assert.equal(summary.categories.find((row) => row.categoryId === "development")?.durationMs, 0);
  assert.equal(summary.activeMs, 2 * HOUR);

  const day13 = summary.days.find((day) => day.date === "2026-07-13");
  const day14 = summary.days.find((day) => day.date === "2026-07-14");
  assert.equal(day13?.categories.find((row) => row.categoryId === "alpha")?.durationMs, HOUR);
  assert.equal(day13?.categories.find((row) => row.categoryId === "beta")?.durationMs, 0);
  assert.equal(day14?.categories.find((row) => row.categoryId === "beta")?.durationMs, HOUR);
  assert.equal(day14?.categories.find((row) => row.categoryId === "alpha")?.durationMs, 0);
});

test("idle and pause kinds are distinct from active", () => {
  const summary = buildWeeklyActivitySummary(
    [
      card({
        id: "work",
        startUtc: "2026-07-13T10:00:00.000Z",
        endUtc: "2026-07-13T11:00:00.000Z",
      }),
      card({
        id: "idle",
        kind: "idle",
        categoryId: "alpha",
        startUtc: "2026-07-13T11:00:00.000Z",
        endUtc: "2026-07-13T11:30:00.000Z",
      }),
      card({
        id: "pause",
        kind: "pause",
        categoryId: "beta",
        startUtc: "2026-07-13T11:30:00.000Z",
        endUtc: "2026-07-13T11:45:00.000Z",
      }),
    ],
    options(),
  );
  assert.equal(summary.activeMs, HOUR);
  assert.equal(summary.idleMs, 30 * 60_000);
  assert.equal(summary.pauseMs, 15 * 60_000);
  assert.equal(summary.gapMs, WEEK_MS - HOUR - 30 * 60_000 - 15 * 60_000);
});

test("unknown category is unclassified, not a silent zero row", () => {
  const summary = buildWeeklyActivitySummary(
    [
      card({
        id: "mystery",
        categoryId: "not-configured",
        startUtc: "2026-07-15T08:00:00.000Z",
        endUtc: "2026-07-15T09:00:00.000Z",
      }),
    ],
    options(),
  );
  assert.equal(summary.unclassifiedMs, HOUR);
  assert.equal(summary.activeMs, HOUR);
  assert.equal(summary.categories.some((row) => row.categoryId === "not-configured"), false);
  assert.ok(summary.categories.every((row) => row.durationMs === 0));
});

test("configured category with no cards stays at zero", () => {
  const summary = buildWeeklyActivitySummary(
    [
      card({
        id: "only-dev",
        categoryId: "development",
        startUtc: "2026-07-16T12:00:00.000Z",
        endUtc: "2026-07-16T13:00:00.000Z",
      }),
    ],
    options(),
  );
  const byId = Object.fromEntries(summary.categories.map((row) => [row.categoryId, row.durationMs]));
  assert.equal(byId.development, HOUR);
  assert.equal(byId.alpha, 0);
  assert.equal(byId.beta, 0);
  assert.equal(summary.categories.length, 3);
});

test("equal durations sort by categoryId ascending", () => {
  const summary = buildWeeklyActivitySummary(
    [
      card({
        id: "a",
        categoryId: "alpha",
        startUtc: "2026-07-13T09:00:00.000Z",
        endUtc: "2026-07-13T10:00:00.000Z",
      }),
      card({
        id: "b",
        categoryId: "beta",
        startUtc: "2026-07-13T10:00:00.000Z",
        endUtc: "2026-07-13T12:00:00.000Z",
      }),
      card({
        id: "d",
        categoryId: "development",
        startUtc: "2026-07-13T12:00:00.000Z",
        endUtc: "2026-07-13T14:00:00.000Z",
      }),
    ],
    options(),
  );
  assert.deepEqual(
    summary.categories.map((row) => row.categoryId),
    ["beta", "development", "alpha"],
  );
  assert.deepEqual(
    summary.categories.map((row) => row.durationMs),
    [2 * HOUR, 2 * HOUR, HOUR],
  );
  const day13 = summary.days.find((day) => day.date === "2026-07-13");
  assert.deepEqual(
    day13?.categories.map((row) => row.categoryId),
    ["beta", "development", "alpha"],
  );
});
