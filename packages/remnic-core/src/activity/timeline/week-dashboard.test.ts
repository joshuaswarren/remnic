import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { planActivityDeletion } from "../privacy-delete-plan.js";
import type { TimelineCard, TimelineCategory } from "./types.js";
import {
  DEFAULT_TOP_SOURCE_LIMIT,
  WEEKLY_DASHBOARD_FORMAT_VERSION,
  buildWeeklyDashboard,
  type WeekSourceAttribution,
} from "./week-dashboard.js";
import { persistWeeklySnapshot } from "./weekly-persist.js";

const HOUR = 3_600_000;
const WEEK_START = "2026-07-13T00:00:00.000Z";
const WEEK_END = "2026-07-20T00:00:00.000Z";
const PREV_WEEK_START = "2026-07-06T00:00:00.000Z";

const CATEGORIES: TimelineCategory[] = [
  { id: "development", name: "Development", color: "#111111", description: "d", order: 1 },
  { id: "communication", name: "Communication", color: "#222222", description: "c", order: 2 },
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

function options(overrides: Partial<Parameters<typeof buildWeeklyDashboard>[1]> = {}) {
  return {
    timezone: "UTC",
    weekStartUtc: WEEK_START,
    weekEndUtc: WEEK_END,
    categories: CATEGORIES,
    ...overrides,
  };
}

function attributions(...entries: Array<[string, WeekSourceAttribution]>): Map<string, WeekSourceAttribution> {
  return new Map(entries);
}

test("empty week yields zero sources, no recurring patterns, zero evidence, unavailable previous period", () => {
  const dashboard = buildWeeklyDashboard([], options());
  assert.equal(dashboard.dashboardFormatVersion, WEEKLY_DASHBOARD_FORMAT_VERSION);
  assert.deepEqual(dashboard.sources, { applications: [], domains: [] });
  assert.deepEqual(dashboard.recurring, { categories: [], applications: [] });
  assert.deepEqual(dashboard.evidence, {
    activityCardCount: 0,
    idleCardCount: 0,
    pauseCardCount: 0,
    evidenceCount: 0,
    distinctEvidenceCount: 0,
  });
  assert.deepEqual(dashboard.uncertainty, {
    clippedCardCount: 0,
    manualEditCount: 0,
    unclassifiedCardCount: 0,
  });
  assert.deepEqual(dashboard.previousPeriod, { available: false });
});

test("top applications and domains aggregate clipped durations; equal totals tie-break by key", () => {
  const cards = [
    card({ id: "a", startUtc: "2026-07-13T10:00:00.000Z", endUtc: "2026-07-13T11:00:00.000Z" }),
    card({ id: "b", startUtc: "2026-07-13T11:00:00.000Z", endUtc: "2026-07-13T12:00:00.000Z" }),
    card({ id: "c", startUtc: "2026-07-15T09:00:00.000Z", endUtc: "2026-07-15T10:00:00.000Z" }),
    card({ id: "d", startUtc: "2026-07-17T09:00:00.000Z", endUtc: "2026-07-17T10:00:00.000Z" }),
    card({ id: "e", startUtc: "2026-07-17T10:00:00.000Z", endUtc: "2026-07-17T11:00:00.000Z" }),
  ];
  const dashboard = buildWeeklyDashboard(cards, {
    ...options(),
    attributions: attributions(
      ["a", { app: "  Code  " }],
      ["b", { app: "Chrome", domain: "GitHub.com" }],
      ["c", { app: "Chrome", domain: "github.com" }],
      ["d", { app: "Zed" }],
      ["e", { app: "Alpha" }],
    ),
  });
  // Chrome 2h, Code 1h; Zed and Alpha tie at 1h and sort by key ascending.
  assert.deepEqual(dashboard.sources.applications, [
    { key: "Chrome", durationMs: 2 * HOUR },
    { key: "Alpha", durationMs: HOUR },
    { key: "Code", durationMs: HOUR },
    { key: "Zed", durationMs: HOUR },
  ]);
  // Domains are normalized to lowercase; only attributed browser time counts.
  assert.deepEqual(dashboard.sources.domains, [{ key: "github.com", durationMs: 2 * HOUR }]);
});

test("a card crossing a week bound is clipped once and flagged as uncertain coverage", () => {
  const cards = [
    card({
      id: "spills-before",
      startUtc: "2026-07-12T23:00:00.000Z",
      endUtc: "2026-07-13T01:00:00.000Z",
    }),
  ];
  const dashboard = buildWeeklyDashboard(cards, {
    ...options(),
    attributions: attributions(["spills-before", { app: "Code" }]),
  });
  assert.equal(dashboard.sources.applications[0]?.durationMs, HOUR);
  assert.equal(dashboard.uncertainty.clippedCardCount, 1);
  // The in-week part lands on Monday only; Sunday belongs to the prior week.
  assert.equal(dashboard.days.find((day) => day.date === "2026-07-13")?.activeMs, HOUR);
});

test("topSourceLimit caps each source list; default limit is 10", () => {
  assert.equal(DEFAULT_TOP_SOURCE_LIMIT, 10);
  const cards = [
    card({ id: "a", startUtc: "2026-07-13T10:00:00.000Z", endUtc: "2026-07-13T11:00:00.000Z" }),
    card({ id: "b", startUtc: "2026-07-14T10:00:00.000Z", endUtc: "2026-07-14T11:00:00.000Z" }),
  ];
  const dashboard = buildWeeklyDashboard(cards, {
    ...options(),
    topSourceLimit: 1,
    attributions: attributions(["a", { app: "Beta" }], ["b", { app: "Alpha" }]),
  });
  assert.deepEqual(dashboard.sources.applications, [{ key: "Alpha", durationMs: HOUR }]);
});

test("recurring patterns gate on distinct days for categories and applications", () => {
  const cards = [
    // development on Mon/Tue/Wed -> recurring.
    card({ id: "d1", startUtc: "2026-07-13T10:00:00.000Z", endUtc: "2026-07-13T11:00:00.000Z" }),
    card({ id: "d2", startUtc: "2026-07-14T10:00:00.000Z", endUtc: "2026-07-14T11:00:00.000Z" }),
    card({ id: "d3", startUtc: "2026-07-15T10:00:00.000Z", endUtc: "2026-07-15T11:00:00.000Z" }),
    // communication on Mon/Tue only -> not recurring.
    card({
      id: "c1",
      categoryId: "communication",
      startUtc: "2026-07-13T12:00:00.000Z",
      endUtc: "2026-07-13T13:00:00.000Z",
    }),
    card({
      id: "c2",
      categoryId: "communication",
      startUtc: "2026-07-14T12:00:00.000Z",
      endUtc: "2026-07-14T13:00:00.000Z",
    }),
  ];
  const dashboard = buildWeeklyDashboard(cards, {
    ...options(),
    attributions: attributions(
      ["d1", { app: "Code" }],
      ["d2", { app: "Code" }],
      ["d3", { app: "Code" }],
      ["c1", { app: "Chat" }],
      ["c2", { app: "Chat" }],
    ),
  });
  assert.deepEqual(dashboard.recurring.categories, [
    { key: "development", dayCount: 3, totalDurationMs: 3 * HOUR },
  ]);
  assert.deepEqual(dashboard.recurring.applications, [
    { key: "Code", dayCount: 3, totalDurationMs: 3 * HOUR },
  ]);
});

test("previous week cards produce explicit deltas; absent stays explicitly unavailable", () => {
  const current = [
    card({ id: "now", startUtc: "2026-07-13T10:00:00.000Z", endUtc: "2026-07-13T12:00:00.000Z" }),
  ];
  const previous = [
    card({ id: "then", startUtc: "2026-07-06T10:00:00.000Z", endUtc: "2026-07-06T13:00:00.000Z" }),
  ];
  const compared = buildWeeklyDashboard(current, { ...options(), previousWeekCards: previous });
  assert.equal(compared.previousPeriod.available, true);
  if (compared.previousPeriod.available) {
    assert.equal(compared.previousPeriod.previousStartUtc, PREV_WEEK_START);
    assert.equal(compared.previousPeriod.previousEndUtc, WEEK_START);
    assert.equal(compared.previousPeriod.deltaActiveMs, -HOUR);
    assert.equal(compared.previousPeriod.deltaIdleMs, 0);
  }
  const first = buildWeeklyDashboard(current, options());
  assert.deepEqual(first.previousPeriod, { available: false });
});

test("evidence counts and uncertainty flags reflect only in-week activity", () => {
  const cards = [
    card({
      id: "plain",
      startUtc: "2026-07-13T10:00:00.000Z",
      endUtc: "2026-07-13T11:00:00.000Z",
      evidenceIds: [1, 2],
    }),
    card({
      id: "repeat",
      startUtc: "2026-07-14T10:00:00.000Z",
      endUtc: "2026-07-14T11:00:00.000Z",
      evidenceIds: [2, 3],
    }),
    card({
      id: "edited",
      startUtc: "2026-07-15T10:00:00.000Z",
      endUtc: "2026-07-15T11:00:00.000Z",
      manualEdit: { editedAtUtc: "2026-07-15T12:00:00.000Z" },
    }),
    card({
      id: "mystery",
      categoryId: "system.unknown",
      confidence: 0,
      startUtc: "2026-07-16T10:00:00.000Z",
      endUtc: "2026-07-16T11:00:00.000Z",
    }),
    card({
      id: "idle",
      kind: "idle",
      categoryId: "system.idle",
      startUtc: "2026-07-13T15:00:00.000Z",
      endUtc: "2026-07-13T16:00:00.000Z",
    }),
    card({
      id: "pause",
      kind: "pause",
      categoryId: "system.pause",
      startUtc: "2026-07-13T16:00:00.000Z",
      endUtc: "2026-07-13T17:00:00.000Z",
    }),
    // Fully outside the week: counted nowhere.
    card({ id: "outside", startUtc: "2026-08-01T10:00:00.000Z", endUtc: "2026-08-01T11:00:00.000Z" }),
  ];
  const dashboard = buildWeeklyDashboard(cards, options());
  assert.deepEqual(dashboard.evidence, {
    activityCardCount: 4,
    idleCardCount: 1,
    pauseCardCount: 1,
    evidenceCount: 4,
    distinctEvidenceCount: 3,
  });
  assert.deepEqual(dashboard.uncertainty, {
    clippedCardCount: 0,
    manualEditCount: 1,
    unclassifiedCardCount: 1,
  });
});

test("a deleted category flows to unclassified and never recurs as a pattern", () => {
  const cards = [
    card({ id: "g1", categoryId: "gone", startUtc: "2026-07-13T10:00:00.000Z", endUtc: "2026-07-13T11:00:00.000Z" }),
    card({ id: "g2", categoryId: "gone", startUtc: "2026-07-14T10:00:00.000Z", endUtc: "2026-07-14T11:00:00.000Z" }),
    card({ id: "g3", categoryId: "gone", startUtc: "2026-07-15T10:00:00.000Z", endUtc: "2026-07-15T11:00:00.000Z" }),
  ];
  const dashboard = buildWeeklyDashboard(cards, options());
  assert.equal(dashboard.unclassifiedMs, 3 * HOUR);
  assert.deepEqual(dashboard.recurring.categories, []);
  assert.ok(dashboard.categories.every((total) => total.categoryId !== "gone"));
});

test("card input order never changes the serialized snapshot bytes", () => {
  const cards = [
    card({ id: "a", startUtc: "2026-07-13T10:00:00.000Z", endUtc: "2026-07-13T11:00:00.000Z" }),
    card({ id: "b", startUtc: "2026-07-14T10:00:00.000Z", endUtc: "2026-07-14T11:00:00.000Z" }),
    card({ id: "c", startUtc: "2026-07-15T10:00:00.000Z", endUtc: "2026-07-15T11:00:00.000Z" }),
  ];
  const base = {
    ...options(),
    attributions: attributions(
      ["a", { app: "Code", domain: "github.com" }],
      ["b", { app: "Chat" }],
      ["c", { app: "Code", domain: "github.com" }],
    ),
  };
  const forward = JSON.stringify(buildWeeklyDashboard(cards, base));
  const reversed = JSON.stringify(buildWeeklyDashboard([...cards].reverse(), base));
  assert.equal(forward, reversed);
});

test("dashboard persists through the weekly snapshot store idempotently", () => {
  const memoryDir = mkdtempSync(path.join(tmpdir(), "remnic-week-dashboard-"));
  const cards = [
    card({ id: "a", startUtc: "2026-07-13T10:00:00.000Z", endUtc: "2026-07-13T11:00:00.000Z" }),
  ];
  const dashboard = buildWeeklyDashboard(cards, {
    ...options(),
    attributions: attributions(["a", { app: "Code", domain: "github.com" }]),
  });
  const shared = {
    memoryDir,
    namespace: "dash-1",
    summary: dashboard,
    sourceRevision: "rev-1",
    configHash: "cfg-1",
  };
  const first = persistWeeklySnapshot(shared);
  assert.equal(first.written, true);
  assert.ok(first.path.includes(path.join("activity", "weekly")));
  const bytes = readFileSync(first.path, "utf8");
  const parsed = JSON.parse(bytes);
  assert.equal(parsed.namespace, "dash-1");
  assert.equal(parsed.summary.sources.domains[0].key, "github.com");

  const again = persistWeeklySnapshot(shared);
  assert.equal(again.written, false);
  assert.equal(again.path, first.path);
  assert.equal(readFileSync(first.path, "utf8"), bytes);

  const reconfigured = persistWeeklySnapshot({ ...shared, configHash: "cfg-2" });
  assert.equal(reconfigured.written, true);
  assert.notEqual(reconfigured.path, first.path);
  assert.equal(readFileSync(first.path, "utf8"), bytes);
});

test("retention plans expired weekly snapshots for deletion and keeps fresh ones", () => {
  const now = Date.parse("2026-07-20T00:00:00.000Z");
  const DAY = 86_400_000;
  const expired = now - 40 * DAY;
  const plan = planActivityDeletion({
    candidates: [
      { scope: "weekly", relPath: "activity/weekly/dash-1/2026-06-08--abc.json", capturedAtMs: expired },
      { scope: "weekly", relPath: "activity/weekly/dash-1/2026-07-13--def.json", capturedAtMs: now - DAY },
    ],
    scopes: ["weekly"],
    retentionDays: 30,
    nowMs: now,
  });
  assert.deepEqual(plan.deletePaths, ["activity/weekly/dash-1/2026-06-08--abc.json"]);
});

test("invalid inputs throw RangeError without partial output", () => {
  const cards = [
    card({ id: "a", startUtc: "2026-07-13T10:00:00.000Z", endUtc: "2026-07-13T11:00:00.000Z" }),
  ];
  assert.throws(
    () => buildWeeklyDashboard(cards, { ...options(), topSourceLimit: 0 }),
    (err: unknown) => err instanceof RangeError && /topSourceLimit/.test((err as Error).message),
  );
  assert.throws(
    () =>
      buildWeeklyDashboard(cards, {
        ...options(),
        attributions: attributions(["a", { app: "   " }]),
      }),
    (err: unknown) => err instanceof RangeError && /app/.test((err as Error).message),
  );
  assert.throws(
    () =>
      buildWeeklyDashboard(cards, {
        ...options(),
        attributions: attributions(["a", { app: "Code", domain: "" }]),
      }),
    (err: unknown) => err instanceof RangeError && /domain/.test((err as Error).message),
  );
});
