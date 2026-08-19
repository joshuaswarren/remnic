import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clipCardsToRecapWindow,
  type RecapWindowCard,
} from "./recap-window.js";

const MINUTE = 60_000;
const DAY_START = Date.UTC(2026, 0, 15); // 2026-01-15T00:00:00Z
const DAY_END = DAY_START + 24 * 60 * 60_000;

const iso = (ms: number): string => new Date(ms).toISOString();

const card = (id: string, startMs: number, endMs: number): RecapWindowCard => ({
  id,
  startUtc: iso(startMs),
  endUtc: iso(endMs),
});

describe("clipCardsToRecapWindow", () => {
  it("returns [] for empty input", () => {
    assert.deepEqual(clipCardsToRecapWindow([], DAY_START, DAY_END), []);
  });

  it("excludes a card ending exactly at windowStart and one starting exactly at windowEnd", () => {
    const before = card("before", DAY_START - 2 * MINUTE, DAY_START);
    const after = card("after", DAY_END, DAY_END + 2 * MINUTE);
    const inside = card("inside", DAY_START, DAY_END);

    const result = clipCardsToRecapWindow([before, after, inside], DAY_START, DAY_END);

    assert.deepEqual(
      result.map((c) => c.id),
      ["inside"],
    );
    assert.equal(result[0]?.startMs, DAY_START);
    assert.equal(result[0]?.endMs, DAY_END);
    assert.equal(result[0]?.durationMs, DAY_END - DAY_START);

    // Each midnight-touching card lands in exactly one adjacent window.
    const prevDay = clipCardsToRecapWindow([before], DAY_START - DAY_END, DAY_START);
    const nextDay = clipCardsToRecapWindow([after], DAY_END, DAY_END + (DAY_END - DAY_START));
    assert.equal(prevDay[0]?.id, "before");
    assert.equal(nextDay[0]?.id, "after");
  });

  it("clips a card straddling the window start", () => {
    const straddle = card("straddle", DAY_START - 30 * MINUTE, DAY_START + 90 * MINUTE);

    const result = clipCardsToRecapWindow([straddle], DAY_START, DAY_END);

    assert.equal(result.length, 1);
    assert.equal(result[0]?.startMs, DAY_START);
    assert.equal(result[0]?.endMs, DAY_START + 90 * MINUTE);
    assert.equal(result[0]?.durationMs, 90 * MINUTE);
  });

  it("clips a card straddling the window end", () => {
    const straddle = card("tail", DAY_END - 5 * MINUTE, DAY_END + 45 * MINUTE);

    const result = clipCardsToRecapWindow([straddle], DAY_START, DAY_END);

    assert.equal(result.length, 1);
    assert.equal(result[0]?.endMs, DAY_END);
    assert.equal(result[0]?.durationMs, 5 * MINUTE);
  });

  it("skips cards with unparseable timestamps without throwing", () => {
    const good = card("good", DAY_START + MINUTE, DAY_START + 10 * MINUTE);
    const bad: RecapWindowCard[] = [
      { id: "bad-start", startUtc: "not-a-date", endUtc: iso(DAY_START + 5 * MINUTE) },
      { id: "bad-end", startUtc: iso(DAY_START), endUtc: "" },
      good,
    ];

    const result = clipCardsToRecapWindow(bad, DAY_START, DAY_END);

    assert.deepEqual(
      result.map((c) => c.id),
      ["good"],
    );
    assert.equal(result[0]?.durationMs, 9 * MINUTE);
  });

  it("throws RangeError on inverted or empty window", () => {
    assert.throws(
      () => clipCardsToRecapWindow([], DAY_END, DAY_START),
      RangeError,
    );
    assert.throws(
      () => clipCardsToRecapWindow([], DAY_START, DAY_START),
      RangeError,
    );
  });

  it("sorts by startMs then id, byte-identical across calls", () => {
    const same = DAY_START + 60 * MINUTE;
    const cards: RecapWindowCard[] = [
      card("z-late", DAY_START + 120 * MINUTE, DAY_START + 130 * MINUTE),
      card("b-tie", same, same + 10 * MINUTE),
      card("a-tie", same, same + 10 * MINUTE),
      card("early", DAY_START + 5 * MINUTE, DAY_START + 6 * MINUTE),
    ];

    const first = clipCardsToRecapWindow(cards, DAY_START, DAY_END);
    const second = clipCardsToRecapWindow(cards, DAY_START, DAY_END);

    assert.deepEqual(
      first.map((c) => c.id),
      ["early", "a-tie", "b-tie", "z-late"],
    );
    assert.deepEqual(first, second);
  });
});
