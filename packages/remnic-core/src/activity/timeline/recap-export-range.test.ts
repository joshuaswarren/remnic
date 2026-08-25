import assert from "node:assert/strict";
import test from "node:test";

import type { TimelineCard } from "./types.js";
import {
  DEFAULT_RECAP_RANGE_MAX_DAYS,
  exportDeterministicRecapRange,
  renderDeterministicJournalRange,
} from "./recap-export-range.js";
import { renderDeterministicJournal } from "./journal-recap.js";

const TZ = "UTC";

function card(
  overrides: Partial<TimelineCard> & Pick<TimelineCard, "id" | "dayKey">,
): TimelineCard {
  return {
    kind: "activity",
    title: "Untitled",
    summary: "none",
    categoryId: "development",
    confidence: 1,
    startUtc: `${overrides.dayKey}T09:00:00.000Z`,
    endUtc: `${overrides.dayKey}T10:00:00.000Z`,
    timezone: TZ,
    machine: "ws-a",
    evidenceIds: [],
    evidenceRange: null,
    ...overrides,
  };
}

function okRange(options: Parameters<typeof exportDeterministicRecapRange>[0]) {
  const result = exportDeterministicRecapRange(options);
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  return result.range;
}

test("empty range days are exported with empty card lists", () => {
  const range = okRange({
    startDate: "2026-08-17",
    endDate: "2026-08-18",
    timezone: TZ,
    cards: [],
  });
  assert.deepEqual(
    range.days.map((d) => [d.date, d.cards.length]),
    [
      ["2026-08-17", 0],
      ["2026-08-18", 0],
    ],
  );
});

test("cards land on their dayKey; out-of-range cards are dropped", () => {
  const range = okRange({
    startDate: "2026-08-17",
    endDate: "2026-08-18",
    timezone: TZ,
    cards: [
      card({ id: "b", dayKey: "2026-08-18" }),
      card({ id: "a", dayKey: "2026-08-17" }),
      card({ id: "x", dayKey: "2026-08-16" }),
      card({ id: "y", dayKey: "2026-08-19" }),
    ],
  });
  assert.deepEqual(
    range.days.map((d) => d.cards.map((c) => c.id)),
    [["a"], ["b"]],
  );
});

test("determinism: same inputs, shuffled card order, identical JSON bytes", () => {
  const cards = [
    card({ id: "c2", dayKey: "2026-08-17" }),
    card({ id: "c1", dayKey: "2026-08-18" }),
    card({ id: "c3", dayKey: "2026-08-17" }),
  ];
  const first = JSON.stringify(
    exportDeterministicRecapRange({
      startDate: "2026-08-17",
      endDate: "2026-08-18",
      timezone: TZ,
      cards,
    }),
  );
  const second = JSON.stringify(
    exportDeterministicRecapRange({
      startDate: "2026-08-17",
      endDate: "2026-08-18",
      timezone: TZ,
      cards: [cards[1], cards[2], cards[0]],
    }),
  );
  assert.equal(first, second);
  assert.equal(
    first,
    JSON.stringify(
      exportDeterministicRecapRange({
        startDate: "2026-08-17",
        endDate: "2026-08-18",
        timezone: TZ,
        cards,
      }),
    ),
  );
});

test("privacy boundary: titles are omitted by default in range exports", () => {
  const range = okRange({
    startDate: "2026-08-17",
    endDate: "2026-08-17",
    timezone: TZ,
    cards: [card({ id: "a", dayKey: "2026-08-17", title: "Secret Window Title" })],
  });
  const json = JSON.stringify(range);
  assert.equal(json.includes("Secret Window Title"), false);
  assert.equal(range.days[0].cards[0].title, undefined);
});

test("privacy boundary: includeObservations keeps titles in range exports", () => {
  const range = okRange({
    startDate: "2026-08-17",
    endDate: "2026-08-17",
    timezone: TZ,
    cards: [card({ id: "a", dayKey: "2026-08-17", title: "Secret Window Title" })],
    includeObservations: true,
  });
  assert.equal(range.days[0].cards[0].title, "Secret Window Title");
});

test("markdown: redacted days render card ids, never titles", () => {
  const rendered = renderDeterministicJournalRange({
    startDate: "2026-08-17",
    endDate: "2026-08-17",
    timezone: TZ,
    cards: [card({ id: "card-a", dayKey: "2026-08-17", title: "Secret Window Title" })],
  });
  assert.ok(rendered.ok);
  assert.ok(rendered.ok);
  assert.equal(rendered.markdown.includes("Secret Window Title"), false);
  assert.equal(rendered.markdown.includes("- 60m card-a"), true);
});

test("markdown: a single-day range equals the single-day renderer", () => {
  const cards = [card({ id: "a", dayKey: "2026-08-17", title: "Terminal" })];
  const rendered = renderDeterministicJournalRange({
    startDate: "2026-08-17",
    endDate: "2026-08-17",
    timezone: TZ,
    cards,
    includeObservations: true,
  });
  assert.ok(rendered.ok);
  assert.ok(rendered.ok);
  assert.equal(
    rendered.markdown,
    renderDeterministicJournal(cards, { date: "2026-08-17", timezone: TZ }),
  );
});

test("markdown: multi-day ranges emit ascending per-day sections", () => {
  const rendered = renderDeterministicJournalRange({
    startDate: "2026-08-17",
    endDate: "2026-08-19",
    timezone: TZ,
    cards: [],
  });
  assert.ok(rendered.ok);
  assert.ok(rendered.ok);
  assert.equal(rendered.dayCount, 3);
  const headings = rendered.markdown
    .split("\n")
    .filter((line) => line.startsWith("# Journal — "));
  assert.deepEqual(headings, [
    "# Journal — 2026-08-17 (UTC)",
    "# Journal — 2026-08-18 (UTC)",
    "# Journal — 2026-08-19 (UTC)",
  ]);
});

test("invalid and inverted ranges fail with typed errors", () => {
  const cases: Array<
    [Parameters<typeof exportDeterministicRecapRange>[0], string]
  > = [
    [{ startDate: "", endDate: "2026-08-18", timezone: TZ, cards: [] }, "invalid_start_date"],
    [{ startDate: "2026-8-17", endDate: "2026-08-18", timezone: TZ, cards: [] }, "invalid_start_date"],
    [{ startDate: "2026-02-30", endDate: "2026-03-01", timezone: TZ, cards: [] }, "invalid_start_date"],
    [{ startDate: "2026-08-17", endDate: "2026-13-01", timezone: TZ, cards: [] }, "invalid_end_date"],
    [{ startDate: "2026-08-18", endDate: "2026-08-17", timezone: TZ, cards: [] }, "end_before_start"],
  ];
  for (const [options, error] of cases) {
    const result = exportDeterministicRecapRange(options);
    assert.equal(result.ok, false, JSON.stringify(options));
    assert.ok(!result.ok);
    assert.deepEqual(
      { error: result.error, limit: result.limit },
      { error, limit: undefined },
    );
  }
});

test("range bound: spans past the default 366 days fail with the limit", () => {
  const result = exportDeterministicRecapRange({
    startDate: "2026-01-01",
    endDate: "2027-01-02",
    timezone: TZ,
    cards: [],
  });
  assert.ok(!result.ok);
  assert.deepEqual(
    { error: result.error, limit: result.limit },
    { error: "range_too_large", limit: DEFAULT_RECAP_RANGE_MAX_DAYS },
  );
  // Exactly the bound still passes.
  const atBound = exportDeterministicRecapRange({
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    timezone: TZ,
    cards: [],
  });
  assert.ok(atBound.ok);
  assert.ok(atBound.ok);
  assert.equal(atBound.range.days.length, 365);
});

test("range bound: maxDays override is enforced and validated", () => {
  const denied = exportDeterministicRecapRange({
    startDate: "2026-08-17",
    endDate: "2026-08-20",
    timezone: TZ,
    cards: [],
    maxDays: 2,
  });
  assert.ok(!denied.ok);
  assert.equal(denied.error, "range_too_large");
  assert.equal(denied.limit, 2);
  assert.throws(
    () =>
      exportDeterministicRecapRange({
        startDate: "2026-08-17",
        endDate: "2026-08-17",
        timezone: TZ,
        cards: [],
        maxDays: 0,
      }),
    RangeError,
  );
});

test("a card spanning midnight attributes only to its stored dayKey", () => {
  const range = okRange({
    startDate: "2026-08-17",
    endDate: "2026-08-18",
    timezone: TZ,
    cards: [
      card({
        id: "spans",
        dayKey: "2026-08-17",
        startUtc: "2026-08-17T23:00:00.000Z",
        endUtc: "2026-08-18T01:00:00.000Z",
      }),
    ],
    includeObservations: true,
  });
  assert.deepEqual(
    range.days.map((d) => d.cards.map((c) => c.id)),
    [["spans"], []],
  );
  // The markdown render clips the spanning card to each day window: it
  // contributes 60m to day 1 and nothing to day 2.
  const day2 = renderDeterministicJournalRange({
    startDate: "2026-08-18",
    endDate: "2026-08-18",
    timezone: TZ,
    cards: [
      card({
        id: "spans",
        dayKey: "2026-08-17",
        startUtc: "2026-08-17T23:00:00.000Z",
        endUtc: "2026-08-18T01:00:00.000Z",
      }),
    ],
  });
  assert.ok(day2.ok);
  assert.ok(day2.ok);
  assert.equal(day2.markdown.includes("- 60m spans"), false);
});
