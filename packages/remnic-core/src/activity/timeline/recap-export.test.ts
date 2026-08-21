import assert from "node:assert/strict";
import test from "node:test";

import type { TimelineCard } from "./types.js";
import { exportDeterministicRecap } from "./recap-export.js";

const DATE = "2026-08-17";

function card(
  overrides: Partial<TimelineCard> & Pick<TimelineCard, "id">,
): TimelineCard {
  return {
    kind: "activity",
    title: "Title",
    summary: "Summary",
    categoryId: "work",
    confidence: 0.9,
    startUtc: "2026-08-17T09:00:00.000Z",
    endUtc: "2026-08-17T10:00:00.000Z",
    dayKey: DATE,
    timezone: "UTC",
    machine: "machine-a",
    evidenceIds: [1],
    evidenceRange: null,
    ...overrides,
  };
}

test("empty cards export date and timezone with an empty card list", () => {
  const recap = exportDeterministicRecap({
    date: DATE,
    timezone: "UTC",
    cards: [],
  });
  assert.deepEqual(recap, { date: DATE, timezone: "UTC", cards: [] });
  assert.equal(JSON.stringify(recap), `{"date":"${DATE}","timezone":"UTC","cards":[]}`);
});

test("cards are sorted by id regardless of input order", () => {
  const recap = exportDeterministicRecap({
    date: DATE,
    timezone: "UTC",
    cards: [
      card({ id: "card-c" }),
      card({ id: "card-a" }),
      card({ id: "card-b" }),
    ],
  });
  assert.deepEqual(
    recap.cards.map((c) => c.id),
    ["card-a", "card-b", "card-c"],
  );
});

test("timezone is echoed verbatim, not normalized", () => {
  const recap = exportDeterministicRecap({
    date: DATE,
    timezone: "America/Chicago",
    cards: [],
  });
  assert.equal(recap.timezone, "America/Chicago");
});

test("input cards are not mutated and reruns are stable", () => {
  const input = [card({ id: "card-b" }), card({ id: "card-a" })];
  const first = exportDeterministicRecap({
    date: DATE,
    timezone: "UTC",
    cards: input,
  });
  const second = exportDeterministicRecap({
    date: DATE,
    timezone: "UTC",
    cards: input,
  });
  assert.deepEqual(input.map((c) => c.id), ["card-b", "card-a"]);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});
