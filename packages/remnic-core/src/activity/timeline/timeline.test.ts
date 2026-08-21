import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { activityDayWindow } from "../digest.js";
import { parseActivityConfig } from "../config.js";
import {
  DEFAULT_TIMELINE_CATEGORIES,
  TIMELINE_RESERVED_IDLE,
  TIMELINE_RESERVED_PAUSE,
  TIMELINE_RESERVED_UNKNOWN,
  sortTimelineCategories,
  validateTimelineCategories,
} from "./categories.js";
import { classifyTimelineObservation } from "./classify.js";
import { buildTimelineDay, serializeTimelineDay, TIMELINE_MERGE_GAP_MS } from "./build.js";
import { applyTimelineCorrections, TimelineCorrectionStore } from "./corrections.js";
import type { TimelineCategory, TimelineObservation } from "./types.js";

function obs(overrides: Partial<TimelineObservation> & { id: number; capturedAtUtc: string }): TimelineObservation {
  return {
    machine: "workstation-a",
    app: "Code",
    windowTitle: "main.ts — editor",
    contentHash: `hash-${overrides.id}`,
    ...overrides,
  };
}

const BASE_INPUT = {
  date: "2026-06-01",
  timezone: "UTC",
  observations: [
    obs({ id: 1, capturedAtUtc: "2026-06-01T09:00:00.000Z" }),
    obs({ id: 2, capturedAtUtc: "2026-06-01T09:01:00.000Z" }),
    obs({ id: 3, capturedAtUtc: "2026-06-01T09:02:00.000Z" }),
    obs({ id: 4, capturedAtUtc: "2026-06-01T09:40:00.000Z" }),
  ],
};

test("synthetic observations replay into byte-stable cards regardless of input order", () => {
  const first = buildTimelineDay(BASE_INPUT);
  const second = buildTimelineDay({ ...BASE_INPUT, observations: [...BASE_INPUT.observations].reverse() });
  assert.equal(serializeTimelineDay(second), serializeTimelineDay(first));
  // "Restart" isolation: a completely fresh call over equal content matches.
  const third = buildTimelineDay(JSON.parse(JSON.stringify(BASE_INPUT)));
  assert.equal(serializeTimelineDay(third), serializeTimelineDay(first));
  assert.ok(first.cards.every((card) => card.id.startsWith("tlc_")));
});

test("adjacent compatible observations merge; key changes and long gaps split cards", () => {
  const day = buildTimelineDay(BASE_INPUT);
  const activity = day.cards.filter((card) => card.kind === "activity");
  assert.equal(activity.length, 2, "2-min gaps merge, a 38-min gap splits");
  assert.deepEqual(activity[0].evidenceIds, [1, 2, 3]);
  // Dwell caps at 15 min past the LAST observation: [09:00, 09:17), [09:40, 09:55).
  assert.equal(activity[0].startUtc, "2026-06-01T09:00:00.000Z");
  assert.equal(activity[0].endUtc, "2026-06-01T09:17:00.000Z");
  assert.equal(activity[1].startUtc, "2026-06-01T09:40:00.000Z");
  assert.equal(activity[1].endUtc, "2026-06-01T09:55:00.000Z");
  // The >15-min remainder is a derived idle card with no evidence.
  const idle = day.cards.filter((card) => card.kind === "idle");
  assert.equal(idle.length, 1);
  assert.equal(idle[0].categoryId, TIMELINE_RESERVED_IDLE);
  assert.deepEqual(idle[0].evidenceIds, []);
  assert.equal(idle[0].startUtc, "2026-06-01T09:17:00.000Z");
  assert.equal(idle[0].endUtc, "2026-06-01T09:40:00.000Z");

  // Same cadence but a different window title: two cards, contiguous, no idle.
  const keyed = buildTimelineDay({
    ...BASE_INPUT,
    observations: [
      obs({ id: 1, capturedAtUtc: "2026-06-01T09:00:00.000Z" }),
      obs({ id: 2, capturedAtUtc: "2026-06-01T09:01:00.000Z", windowTitle: "other.ts — editor" }),
    ],
  });
  const cards = keyed.cards.filter((card) => card.kind === "activity");
  assert.equal(cards.length, 2);
  assert.equal(cards[0].endUtc, cards[1].startUtc, "dwell stops at the next observation");
  assert.equal(keyed.cards.filter((card) => card.kind === "idle").length, 0);
  assert.equal(TIMELINE_MERGE_GAP_MS, 120_000, "merge gap contract");
});

test("card dwell is clipped at the local day end (midnight)", () => {
  const day = buildTimelineDay({
    date: "2026-06-01",
    timezone: "UTC",
    observations: [obs({ id: 7, capturedAtUtc: "2026-06-01T23:59:00.000Z" })],
  });
  const card = day.cards[0];
  assert.equal(card.startUtc, "2026-06-01T23:59:00.000Z");
  assert.equal(card.endUtc, "2026-06-02T00:00:00.000Z", "15-min dwell must not cross midnight");
  assert.equal(card.dayKey, "2026-06-01");
});

test("DST transition days bucket observations through the shifted window", () => {
  // America/New_York springs forward 2026-03-08: the local day is 23 hours.
  const window = activityDayWindow("2026-03-08", "America/New_York");
  assert.equal(Date.parse(window.endUtc) - Date.parse(window.startUtc), 23 * 3_600_000);
  const day = buildTimelineDay({
    date: "2026-03-08",
    timezone: "America/New_York",
    observations: [
      obs({ id: 11, capturedAtUtc: "2026-03-08T06:30:00.000Z" }),
      obs({ id: 12, capturedAtUtc: "2026-03-08T06:31:00.000Z" }),
    ],
  });
  assert.equal(day.cards.length, 1);
  assert.equal(day.cards[0].dayKey, "2026-03-08");
  assert.equal(day.startUtc, window.startUtc);
  // Fall-back day is 25 hours.
  const fallWindow = activityDayWindow("2026-11-01", "America/New_York");
  assert.equal(Date.parse(fallWindow.endUtc) - Date.parse(fallWindow.startUtc), 25 * 3_600_000);
});
test("user pause closes cards, is emitted as its own kind, and wins over idle", () => {
  const day = buildTimelineDay({
    ...BASE_INPUT,
    observations: [
      obs({ id: 1, capturedAtUtc: "2026-06-01T10:00:00.000Z" }),
      obs({ id: 2, capturedAtUtc: "2026-06-01T10:01:30.000Z" }),
      obs({ id: 3, capturedAtUtc: "2026-06-01T11:00:00.000Z" }),
    ],
    pauses: [{ startUtc: "2026-06-01T10:30:00.000Z", endUtc: "2026-06-01T11:00:00.000Z", reason: "lunch" }],
  });
  const pause = day.cards.filter((card) => card.kind === "pause");
  assert.equal(pause.length, 1);
  assert.equal(pause[0].categoryId, TIMELINE_RESERVED_PAUSE);
  assert.deepEqual(pause[0].evidenceIds, []);
  assert.ok(pause[0].summary.includes("lunch"));
  const before = day.cards.find((card) => card.kind === "activity" && card.evidenceIds.includes(1));
  assert.equal(before?.endUtc, "2026-06-01T10:16:30.000Z", "dwell (15m from last obs) ends before the pause");
  // Dwell stops short of the pause, so the 13.5-min remainder is one idle
  // card; the pause wins over idle covering the same minutes.
  const idle = day.cards.filter((card) => card.kind === "idle");
  assert.equal(idle.length, 1);
  assert.equal(idle[0].startUtc, "2026-06-01T10:16:30.000Z");
  assert.equal(idle[0].endUtc, "2026-06-01T10:30:00.000Z");
  // No idle overlaps the pause interval itself.
  assert.ok(idle.every((card) => card.endUtc <= pause[0].startUtc || card.startUtc >= pause[0].endUtc));
  // Overlapping pauses union into one interval.
  const unioned = buildTimelineDay({
    date: "2026-06-01",
    timezone: "UTC",
    pauses: [
      { startUtc: "2026-06-01T10:00:00.000Z", endUtc: "2026-06-01T10:30:00.000Z" },
      { startUtc: "2026-06-01T10:20:00.000Z", endUtc: "2026-06-01T11:00:00.000Z" },
    ],
    observations: [],
  });
  assert.equal(unioned.cards.length, 1);
  assert.equal(unioned.cards[0].endUtc, "2026-06-01T11:00:00.000Z");
  // A pause between two compatible observations still closes the card.
  const split = buildTimelineDay({
    date: "2026-06-01",
    timezone: "UTC",
    observations: [
      obs({ id: 1, capturedAtUtc: "2026-06-01T09:00:00.000Z" }),
      obs({ id: 2, capturedAtUtc: "2026-06-01T09:00:30.000Z" }),
    ],
    pauses: [{ startUtc: "2026-06-01T09:00:10.000Z", endUtc: "2026-06-01T09:00:20.000Z" }],
  });
  assert.equal(split.cards.filter((card) => card.kind === "activity").length, 2);
});

test("overlapping multi-machine tracks never merge across machines", () => {
  const day = buildTimelineDay({
    ...BASE_INPUT,
    observations: [
      obs({ id: 1, machine: "ws-a", capturedAtUtc: "2026-06-01T09:00:00.000Z", app: "Chrome", windowTitle: "Docs" }),
      obs({ id: 2, machine: "ws-b", capturedAtUtc: "2026-06-01T09:00:30.000Z", app: "Chrome", windowTitle: "Docs" }),
      obs({ id: 3, machine: "ws-a", capturedAtUtc: "2026-06-01T09:01:00.000Z", app: "Chrome", windowTitle: "Docs" }),
    ],
  });
  const activity = day.cards.filter((card) => card.kind === "activity");
  assert.equal(activity.length, 2);
  assert.deepEqual(new Set(activity.map((card) => card.machine)), new Set(["ws-a", "ws-b"]));
  // Global order is start-time first with a stable machine tie-break.
  assert.ok(activity[0].startUtc <= activity[1].startUtc);
  assert.equal(activity.find((card) => card.machine === "ws-a")?.evidenceIds.length, 2);
});

test("unclassified activity stays visible in system.unknown; domains outrank app names", () => {
  const unknown = classifyTimelineObservation({ app: "MysteryTool", windowTitle: "untitled" }, DEFAULT_TIMELINE_CATEGORIES);
  assert.deepEqual(unknown, { categoryId: TIMELINE_RESERVED_UNKNOWN, confidence: 0 });
  const day = buildTimelineDay({
    date: "2026-06-01",
    timezone: "UTC",
    observations: [obs({ id: 1, capturedAtUtc: "2026-06-01T09:00:00.000Z", app: "MysteryTool", windowTitle: "untitled" })],
  });
  assert.equal(day.cards[0].categoryId, TIMELINE_RESERVED_UNKNOWN);
  assert.equal(day.cards[0].confidence, 0);
  // A browser on github.com is development (domain signal) even though the
  // app rule alone would say browsing.
  const classified = classifyTimelineObservation(
    { app: "Chrome", windowTitle: "feat: timeline", browserUrl: "https://github.com/org/repo" },
    DEFAULT_TIMELINE_CATEGORIES,
  );
  assert.equal(classified.categoryId, "development");
  assert.equal(classified.confidence, 0.85);
});

test("categories validate reserved/system rules and sort with equal-order tie-breaks", () => {
  assert.throws(
    () => validateTimelineCategories([{ id: "development", name: "x", color: "#3b82f6", description: "d", order: 1 }]),
    /system\.unknown/,
  );
  assert.throws(
    () =>
      validateTimelineCategories([
        ...DEFAULT_TIMELINE_CATEGORIES,
        { id: "development", name: "dup", color: "#000000", description: "d", order: 5 },
      ]),
    /unique/,
  );
  assert.throws(
    () => validateTimelineCategories(DEFAULT_TIMELINE_CATEGORIES.map((c) => (c.id === "development" ? { ...c, color: "blue" } : c))),
    /#RRGGBB/,
  );
  assert.throws(
    () => validateTimelineCategories(DEFAULT_TIMELINE_CATEGORIES.map((c) => (c.id === "development" ? { ...c, system: true } : c))),
    /only reserved categories/,
  );
  const equalOrder: TimelineCategory[] = [
    { id: "beta", name: "B", color: "#000001", description: "d", order: 50 },
    { id: "alpha", name: "A", color: "#000002", description: "d", order: 50 },
    ...DEFAULT_TIMELINE_CATEGORIES,
  ];
  validateTimelineCategories(equalOrder);
  const sorted = sortTimelineCategories(equalOrder);
  assert.ok(sorted.findIndex((c) => c.id === "alpha") < sorted.findIndex((c) => c.id === "beta"), "equal order tie-breaks by id");
});

test("manual corrections survive a rebuild and reset reverts the card", () => {
  const memoryDir = mkdtempSync(path.join(tmpdir(), "remnic-timeline-test-"));
  try {
    const store = TimelineCorrectionStore.open(memoryDir);
    const day = buildTimelineDay(BASE_INPUT);
    const target = day.cards[0];
    store.upsert({ cardId: target.id, categoryId: "communication", title: "Morning standup", editedAtUtc: "2026-06-01T12:00:00.000Z" });
    assert.throws(() => store.upsert({ cardId: target.id, categoryId: "nope", editedAtUtc: "2026-06-01T12:00:00.000Z" }), /unknown category/);

    // "Rebuild" — same evidence, fresh build call, corrections reapplied.
    const rebuiltDay = buildTimelineDay(BASE_INPUT);
    const rebuilt = applyTimelineCorrections(rebuiltDay.cards, store.list());
    const corrected = rebuilt.find((card) => card.id === target.id);
    assert.equal(corrected?.title, "Morning standup");
    assert.equal(corrected?.categoryId, "communication");
    assert.equal(corrected?.confidence, 1);
    assert.equal(corrected?.manualEdit?.editedAtUtc, "2026-06-01T12:00:00.000Z");
    const untouched = rebuilt.find((card) => card.id !== target.id);
    assert.deepEqual(untouched, rebuiltDay.cards.find((card) => card.id === untouched?.id));

    // Explicit reset restores the derived card byte-for-byte.
    assert.equal(store.reset(target.id), true);
    assert.equal(store.reset(target.id), false);
    const afterReset = applyTimelineCorrections(buildTimelineDay(BASE_INPUT).cards, store.list());
    assert.deepEqual(afterReset.find((card) => card.id === target.id), target);

    // Corrections persist across close/reopen (process restart).
    store.close();
    const reopened = TimelineCorrectionStore.open(memoryDir);
    assert.equal(reopened.list().length, 0);
    reopened.close();
  } finally {
    rmSync(memoryDir, { recursive: true, force: true });
  }
});

test("activity.timeline config gate defaults off and parses explicitly", () => {
  assert.equal(parseActivityConfig(undefined).timeline.enabled, false);
  assert.equal(parseActivityConfig({ timeline: { enabled: true } }).timeline.enabled, true);
  assert.equal(parseActivityConfig({ timeline: { enabled: "false" } }).timeline.enabled, false);
  assert.throws(() => parseActivityConfig({ timeline: "on" }), /activity\.timeline must be an object/);
  assert.throws(() => parseActivityConfig({ timeline: { enabled: "maybe" } }), /activity\.timeline\.enabled must be a boolean/);
});
