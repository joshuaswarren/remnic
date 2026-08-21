import test from "node:test";
import assert from "node:assert/strict";
import { parseBriefingWindow } from "../src/briefing.js";

// Fixed reference instant so assertions are deterministic regardless of when
// the suite runs. Chose a non-DST UTC midnight boundary.
const NOW = new Date("2026-04-11T12:34:56.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

test("parseBriefingWindow handles 'yesterday'", () => {
  const parsed = parseBriefingWindow("yesterday", NOW);
  assert.ok(parsed, "expected a parsed window");
  assert.equal(parsed!.label, "yesterday");
  // Start of window = midnight of previous UTC day.
  assert.equal(parsed!.from.toISOString(), "2026-04-10T00:00:00.000Z");
  // End of window = midnight of today UTC (exclusive).
  assert.equal(parsed!.to.toISOString(), "2026-04-11T00:00:00.000Z");
});

test("parseBriefingWindow handles 'today'", () => {
  const parsed = parseBriefingWindow("today", NOW);
  assert.ok(parsed);
  assert.equal(parsed!.label, "today");
  assert.equal(parsed!.from.toISOString(), "2026-04-11T00:00:00.000Z");
  assert.equal(parsed!.to.toISOString(), NOW.toISOString());
});

test("parseBriefingWindow handles 'NNh' (hours)", () => {
  const parsed24 = parseBriefingWindow("24h", NOW);
  assert.ok(parsed24);
  assert.equal(parsed24!.label, "last 24h");
  assert.equal(parsed24!.to.toISOString(), NOW.toISOString());
  assert.equal(parsed24!.from.getTime(), NOW.getTime() - 24 * 60 * 60 * 1000);

  const parsed48 = parseBriefingWindow("48h", NOW);
  assert.ok(parsed48);
  assert.equal(parsed48!.from.getTime(), NOW.getTime() - 48 * 60 * 60 * 1000);
});

test("parseBriefingWindow handles 'NNd' (days)", () => {
  const parsed3d = parseBriefingWindow("3d", NOW);
  assert.ok(parsed3d);
  assert.equal(parsed3d!.label, "last 3d");
  assert.equal(parsed3d!.from.getTime(), NOW.getTime() - 3 * DAY_MS);

  const parsed7d = parseBriefingWindow("7d", NOW);
  assert.ok(parsed7d);
  assert.equal(parsed7d!.from.getTime(), NOW.getTime() - 7 * DAY_MS);
});

test("parseBriefingWindow handles 'NNw' (weeks)", () => {
  const parsed1w = parseBriefingWindow("1w", NOW);
  assert.ok(parsed1w);
  assert.equal(parsed1w!.label, "last 1w");
  assert.equal(parsed1w!.from.getTime(), NOW.getTime() - 7 * DAY_MS);

  const parsed2w = parseBriefingWindow("2w", NOW);
  assert.ok(parsed2w);
  assert.equal(parsed2w!.from.getTime(), NOW.getTime() - 14 * DAY_MS);
});

test("parseBriefingWindow is case-insensitive and tolerates whitespace", () => {
  const a = parseBriefingWindow("  YESTERDAY  ", NOW);
  assert.ok(a);
  assert.equal(a!.label, "yesterday");

  const b = parseBriefingWindow(" 3D ", NOW);
  assert.ok(b);
  assert.equal(b!.label, "last 3d");
});

test("parseBriefingWindow rejects invalid tokens", () => {
  const cases: unknown[] = [
    "",
    " ",
    "nope",
    "0d",
    "-3d",
    "3x",
    "d3",
    "3 months",
    // non-string arguments
    null,
    undefined,
    42,
    {},
  ];
  for (const token of cases) {
    assert.equal(
      parseBriefingWindow(token as string, NOW),
      null,
      `expected null for token ${JSON.stringify(token)}`,
    );
  }
});
