import assert from "node:assert/strict";
import test from "node:test";

import type { TimelineCard } from "./types.js";
import {
  exportDeterministicRecap,
  projectCardForRecapExport,
} from "./recap-export.js";

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

test("privacy boundary: default export omits observation-derived titles", () => {
  const recap = exportDeterministicRecap({
    date: DATE,
    timezone: "UTC",
    cards: [card({ id: "card-a", title: "Secret Window Title" })],
  });
  const json = JSON.stringify(recap);
  assert.equal(json.includes("Secret Window Title"), false);
  assert.equal(recap.cards[0].title, undefined);
  // Evidence references survive: the export points at content, never copies it.
  assert.deepEqual(recap.cards[0].evidenceIds, [1]);
  assert.equal(recap.cards[0].dayKey, DATE);
});

test("privacy boundary: includeObservations keeps the title", () => {
  const recap = exportDeterministicRecap({
    date: DATE,
    timezone: "UTC",
    cards: [card({ id: "card-a", title: "Secret Window Title" })],
    includeObservations: true,
  });
  assert.equal(recap.cards[0].title, "Secret Window Title");
});

test("manualEdit provenance is kept and sorts last in the projected card", () => {
  const projected = projectCardForRecapExport(
    card({
      id: "card-a",
      manualEdit: { categoryId: "focus", editedAtUtc: "2026-08-17T12:00:00.000Z" },
    }),
    false,
  );
  assert.equal(projected.manualEdit?.categoryId, "focus");
  assert.equal(Object.keys(projected).at(-1), "manualEdit");
});
test("projectCardForRecapExport emits a fixed key order without the title", () => {
  const projected = projectCardForRecapExport(card({ id: "card-a" }), false);
  assert.deepEqual(Object.keys(projected), [
    "id",
    "kind",
    "summary",
    "categoryId",
    "confidence",
    "startUtc",
    "endUtc",
    "dayKey",
    "timezone",
    "machine",
    "evidenceIds",
    "evidenceRange",
  ]);
});


test("projected exports are byte-identical across reruns and shuffled input", () => {
  const cards = [card({ id: "c3" }), card({ id: "c1" }), card({ id: "c2" })];
  const first = JSON.stringify(
    exportDeterministicRecap({ date: DATE, timezone: "UTC", cards }),
  );
  const second = JSON.stringify(
    exportDeterministicRecap({
      date: DATE,
      timezone: "UTC",
      cards: [cards[2], cards[0], cards[1]],
    }),
  );
  assert.equal(first, second);
});
