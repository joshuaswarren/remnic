import assert from "node:assert/strict";
import test from "node:test";

import { renderRecapMarkdown } from "./recap-markdown.js";
import type { TimelineCard } from "./types.js";

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

test("empty cards print heading plus (empty)", () => {
  assert.equal(
    renderRecapMarkdown({ date: DATE, timezone: "UTC", cards: [] }),
    [`# Recap — ${DATE} (UTC)`, "", "(empty)", ""].join("\n"),
  );
});

test("cards are sorted by id regardless of input order", () => {
  const input = [card({ id: "card-c" }), card({ id: "card-a" }), card({ id: "card-b" })];
  const first = renderRecapMarkdown({ date: DATE, timezone: "UTC", cards: input });
  const second = renderRecapMarkdown({ date: DATE, timezone: "UTC", cards: input });
  assert.equal(
    first,
    [`# Recap — ${DATE} (UTC)`, "", "- card-a", "- card-b", "- card-c", ""].join("\n"),
  );
  assert.deepEqual(
    input.map((row) => row.id),
    ["card-c", "card-a", "card-b"],
  );
  assert.equal(first, second);
});

test("timezone is echoed verbatim, not normalized", () => {
  assert.equal(
    renderRecapMarkdown({ date: DATE, timezone: "America/Chicago", cards: [] }),
    [`# Recap — ${DATE} (America/Chicago)`, "", "(empty)", ""].join("\n"),
  );
});
