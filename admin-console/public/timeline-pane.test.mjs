/**
 * Timeline pane state-machine tests (issue #1986).
 *
 * Drives `timeline-pane.js` directly with a fake transport and a fake clock —
 * no browser, no DOM, no network. Fixtures mirror a `GET /engram/v1/timeline/day`
 * payload: startUtc/endUtc, title, categoryId.
 *
 * Run it with: node admin-console/public/timeline-pane.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(path.join(here, "timeline-pane.js")).href);
const { createTimelinePane, EMPTY_STATE, WEEK_HEADING } = globalThis.RemnicTimelinePane;

const TODAY_MS = Date.parse("2026-06-01T12:00:00.000Z");

function fixtureDay(date = "2026-06-01") {
  return {
    formatVersion: 1,
    date,
    timezone: "UTC",
    startUtc: `${date}T00:00:00.000Z`,
    endUtc: `${date.slice(0, 8)}${String(Number(date.slice(8, 10)) + 1).padStart(2, "0")}T00:00:00.000Z`,
    cards: [
      {
        id: "tlc_fixture_standup",
        kind: "activity",
        title: "Morning standup",
        summary: "Team sync",
        categoryId: "communication",
        startUtc: `${date}T09:00:00.000Z`,
        endUtc: `${date}T09:30:00.000Z`,
      },
      {
        id: "tlc_fixture_focus",
        kind: "activity",
        title: "Deep work",
        summary: "Focused writing",
        categoryId: "focus",
        startUtc: `${date}T10:00:00.000Z`,
        endUtc: `${date}T12:00:00.000Z`,
      },
    ],
  };
}

function createTransport({ enabled = true, getDay } = {}) {
  const calls = { getDay: [] };
  return {
    calls,
    enabled: () => enabled,
    getDay(date) {
      calls.getDay.push(date);
      return Promise.resolve(getDay ? getDay(date) : fixtureDay(date));
    },
  };
}

function paneWith(transportOptions = {}, paneOptions = {}) {
  const transport = createTransport(transportOptions);
  const pane = createTimelinePane({
    transport,
    now: () => TODAY_MS,
    ...paneOptions,
  });
  return { pane, transport };
}

test("disabled gate is one empty-state string and does not fetch", async () => {
  const { pane, transport } = paneWith({ enabled: false });

  const state = await pane.load();

  assert.deepEqual(state, { emptyState: EMPTY_STATE });
  assert.equal(transport.calls.getDay.length, 0);
  await pane.next();
  assert.deepEqual(pane.getState(), { emptyState: EMPTY_STATE });
  assert.equal(transport.calls.getDay.length, 0);
});

test("enabled day lists fixture cards with start end title category duration", async () => {
  const { pane, transport } = paneWith();

  const state = await pane.load();

  assert.equal(state.emptyState, undefined);
  assert.equal(state.date, "2026-06-01");
  assert.equal(state.weekHeading, WEEK_HEADING);
  assert.equal(state.cards.length, 2);
  assert.deepEqual(state.cards[0], {
    start: "2026-06-01T09:00:00.000Z",
    end: "2026-06-01T09:30:00.000Z",
    title: "Morning standup",
    category: "communication",
    duration: 30,
  });
  assert.deepEqual(state.cards[1], {
    start: "2026-06-01T10:00:00.000Z",
    end: "2026-06-01T12:00:00.000Z",
    title: "Deep work",
    category: "focus",
    duration: 120,
  });
  assert.deepEqual(transport.calls.getDay, ["2026-06-01"]);
});

test("date nav prev next today and setDate refetch the selected day", async () => {
  const { pane, transport } = paneWith();
  await pane.load();

  const next = await pane.next();
  assert.equal(next.date, "2026-06-02");
  assert.equal(next.cards[0].start, "2026-06-02T09:00:00.000Z");

  const prev = await pane.prev();
  assert.equal(prev.date, "2026-06-01");

  const jumped = await pane.setDate("2026-05-20");
  assert.equal(jumped.date, "2026-05-20");
  assert.equal(jumped.cards[0].title, "Morning standup");

  const today = await pane.today();
  assert.equal(today.date, "2026-06-01");

  assert.deepEqual(transport.calls.getDay, [
    "2026-06-01",
    "2026-06-02",
    "2026-06-01",
    "2026-05-20",
    "2026-06-01",
  ]);
});

test("setDate ignores a non date key", async () => {
  const { pane, transport } = paneWith();
  await pane.load();

  const state = await pane.setDate("not-a-date");
  assert.equal(state.date, "2026-06-01");
  assert.deepEqual(transport.calls.getDay, ["2026-06-01"]);
});
