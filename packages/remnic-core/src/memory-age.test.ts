import assert from "node:assert/strict";
import test from "node:test";

import {
  applyRecencyBoost,
  assessMtimeTrust,
  collectMtimeFallbackContext,
  resolveMemoryAge,
  utcDayKey,
} from "./memory-age.js";

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-08-25T12:00:00.000Z");

function spreadDays(count: number, startMs = NOW): number[] {
  return Array.from({ length: count }, (_unused, i) => startMs + i * DAY_MS);
}

test("resolveMemoryAge: content dates win over a fresh mtime (#2976)", () => {
  const created = new Date(NOW - 40 * DAY_MS).toISOString();
  const resolved = resolveMemoryAge({ created });
  assert.equal(resolved.source, "content");
  assert.equal(resolved.referenceMs, Date.parse(created), "ages by the content date, not the fresh mtime");
});

test("resolveMemoryAge: created wins over updated; updated backs a missing created", () => {
  const created = new Date(NOW - 90 * DAY_MS).toISOString();
  const updated = new Date(NOW - 1 * DAY_MS).toISOString();
  assert.equal(resolveMemoryAge({ created, updated }).referenceMs, Date.parse(created));
  assert.equal(resolveMemoryAge({ created: undefined, updated }).referenceMs, Date.parse(updated));
});

test("resolveMemoryAge: unparsable content dates never produce a reference", () => {
  for (const bad of ["not-a-date", "", "2026-13-45"] as const) {
    const resolved = resolveMemoryAge({ created: bad, updated: bad });
    assert.equal(resolved.referenceMs, null, `unparsable date ${JSON.stringify(bad)} must not resolve`);
    assert.equal(resolved.source, "unknown");
  }
});

test("resolveMemoryAge: mtime backs age only when trusted and no content date exists", () => {
  const mtimeMs = NOW - 2 * DAY_MS;
  const trusted = assessMtimeTrust([mtimeMs, NOW - 9 * DAY_MS]);
  assert.equal(resolveMemoryAge({}, mtimeMs, trusted).source, "mtime");
  assert.equal(resolveMemoryAge({ created: "garbage" }, mtimeMs, trusted).source, "mtime");
  assert.equal(resolveMemoryAge({ created: new Date(NOW).toISOString() }, mtimeMs, trusted).source, "content");
  const distrusted = assessMtimeTrust([mtimeMs, mtimeMs, NOW - 9 * DAY_MS, NOW - 11 * DAY_MS]);
  assert.equal(distrusted.bulkTouchDays.has(utcDayKey(mtimeMs)), true, "two of four same-day files cluster");
  const refused = resolveMemoryAge({}, mtimeMs, distrusted);
  assert.equal(refused.source, "unknown", "an untrusted mtime is unknown age, never fresh");
  assert.equal(refused.referenceMs, null);
});

test("assessMtimeTrust: the measured distill-kura shape (50 of 214 files on one day) is a bulk touch", () => {
  const bulkDay = NOW - 400 * DAY_MS;
  const sample = [...Array<number>(50).fill(bulkDay), ...spreadDays(164, NOW - 200 * DAY_MS)];
  const trust = assessMtimeTrust(sample);
  assert.equal(trust.bulkTouchDays.size, 1);
  assert.equal(trust.bulkTouchDays.has(utcDayKey(bulkDay)), true);
  assert.equal(trust.isTrusted(bulkDay), false);
  assert.equal(trust.isTrusted(sample[sample.length - 1]!), true);
});

test("assessMtimeTrust: the 20% boundary is inclusive", () => {
  // 43 of 214 = 20.09% -> flagged; 42 of 214 = 19.6% -> not flagged.
  const flagged = assessMtimeTrust([...Array<number>(43).fill(NOW), ...spreadDays(171, NOW - 400 * DAY_MS)]);
  assert.equal(flagged.bulkTouchDays.has(utcDayKey(NOW)), true, "43/214 on one day is >= 20%");
  const clear = assessMtimeTrust([...Array<number>(42).fill(NOW), ...spreadDays(172, NOW - 400 * DAY_MS)]);
  assert.equal(clear.bulkTouchDays.has(utcDayKey(NOW)), false, "42/214 on one day is < 20%");
});

test("assessMtimeTrust: a single file never forms a cluster (min 2)", () => {
  const trust = assessMtimeTrust([NOW]);
  assert.equal(trust.bulkTouchDays.size, 0);
  assert.equal(trust.isTrusted(NOW), true);
  const pair = assessMtimeTrust([NOW, NOW]);
  assert.equal(pair.bulkTouchDays.size, 1, "two files on one day meet the min-2 rule");
});

test("applyRecencyBoost: exact blend, unknown age untouched, weight 0 untouched, future clamped", () => {
  const memory = {
    path: "facts/a.md",
    frontmatter: { created: new Date(NOW - 14 * DAY_MS).toISOString() },
  };
  const expected = 1 * 0.5 + Math.pow(0.5, 14 / 7) * 0.5;
  assert.ok(Math.abs(applyRecencyBoost(1, memory, 0.5, NOW) - expected) < 1e-12);
  // Unknown age (no dates, no trusted mtime) leaves the score alone.
  assert.equal(applyRecencyBoost(0.7, { path: "facts/b.md", frontmatter: {} }, 0.5, NOW), 0.7);
  assert.equal(applyRecencyBoost(0.7, memory, 0, NOW), 0.7);
  // A corrupt future date clamps to age zero instead of boosting past 1.
  const future = {
    path: "facts/c.md",
    frontmatter: { created: new Date(NOW + 30 * DAY_MS).toISOString() },
  };
  assert.equal(applyRecencyBoost(1, future, 0.5, NOW), 1);
});

test("collectMtimeFallbackContext: fully dated memories skip it entirely (no stats)", async () => {
  // The paths do not exist: any stat would surface below as a null mtime
  // instead of the documented null short-circuit.
  const context = await collectMtimeFallbackContext([
    { path: "/nonexistent/facts/a.md", created: new Date(NOW).toISOString() },
    { path: "/nonexistent/facts/b.md", updated: new Date(NOW).toISOString() },
  ]);
  assert.equal(context, null);
});
