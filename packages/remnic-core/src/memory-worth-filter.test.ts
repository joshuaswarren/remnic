import test from "node:test";
import assert from "node:assert/strict";

import {
  applyMemoryWorthFilter,
  buildMemoryWorthCounterMap,
  type MemoryWorthCounters,
} from "./memory-worth-filter.js";

/**
 * Issue #560 PR 4 — recall filter unit tests.
 *
 * These pin the behavior the orchestrator relies on when the feature flag
 * is enabled:
 *   - Uninstrumented memories are untouched (multiplier 1.0).
 *   - Memories with many failures sink in the ranking.
 *   - Memories with many successes rise in the ranking.
 *   - Stable ordering among ties, including the neutral-prior tie.
 *   - `buildMemoryWorthCounterMap` only indexes instrumented memories.
 */

const NOW = new Date("2026-01-01T00:00:00.000Z");

test("uninstrumented memories pass through with multiplier 1.0", () => {
  const out = applyMemoryWorthFilter(
    [
      { path: "a.md", score: 10 },
      { path: "b.md", score: 5 },
      { path: "c.md", score: 1 },
    ],
    {
      counters: new Map<string, MemoryWorthCounters>(),
      now: NOW,
    },
  );
  // All multipliers are 1.0 and scores are unchanged; order preserved.
  for (const item of out) {
    assert.equal(item.multiplier, 1);
    assert.equal(item.score, item.originalScore);
  }
  assert.deepEqual(
    out.map((o) => o.path),
    ["a.md", "b.md", "c.md"],
  );
});

test("memory with heavy failure history sinks below a neutral peer", () => {
  const counters = new Map<string, MemoryWorthCounters>([
    // 0 successes, 10 failures. Laplace score ≈ 1/12 ≈ 0.083.
    // Multiplier ≈ 0.083 / 0.5 ≈ 0.167. Scaled score ≈ 10 * 0.167 = 1.67.
    ["bad.md", { mw_success: 0, mw_fail: 10 }],
  ]);
  const out = applyMemoryWorthFilter(
    [
      { path: "bad.md", score: 10 },
      { path: "neutral.md", score: 5 },
    ],
    { counters, now: NOW },
  );
  assert.equal(out[0]!.path, "neutral.md", "neutral peer must outrank the bad memory");
  const bad = out.find((o) => o.path === "bad.md")!;
  assert.ok(bad.multiplier < 0.5, `bad multiplier ${bad.multiplier} should be < 0.5`);
  assert.ok(bad.score < 5, `bad scaled score ${bad.score} should be < the neutral 5`);
});

test("memory with heavy success history rises above a neutral peer", () => {
  const counters = new Map<string, MemoryWorthCounters>([
    // 10 successes, 0 failures. Laplace score ≈ 11/12 ≈ 0.917.
    // Multiplier ≈ 0.917 / 0.5 ≈ 1.833.
    ["good.md", { mw_success: 10, mw_fail: 0 }],
  ]);
  const out = applyMemoryWorthFilter(
    [
      { path: "neutral.md", score: 5 },
      { path: "good.md", score: 3 },
    ],
    { counters, now: NOW },
  );
  // good.md was ranked second by raw score but should move up once its
  // history kicks in (3 * ~1.83 ≈ 5.5 > 5).
  assert.equal(out[0]!.path, "good.md");
  const good = out.find((o) => o.path === "good.md")!;
  assert.ok(good.multiplier > 1.5);
});

test("ordering is stable for ties on the neutral prior", () => {
  const out = applyMemoryWorthFilter(
    [
      { path: "a.md", score: 5 },
      { path: "b.md", score: 5 },
      { path: "c.md", score: 5 },
    ],
    { counters: new Map<string, MemoryWorthCounters>(), now: NOW },
  );
  assert.deepEqual(
    out.map((o) => o.path),
    ["a.md", "b.md", "c.md"],
    "ties must preserve input order (stable sort, CLAUDE.md rule 19)",
  );
});

test("reorder:false preserves original order but still applies multiplier", () => {
  const counters = new Map<string, MemoryWorthCounters>([
    ["good.md", { mw_success: 10, mw_fail: 0 }],
  ]);
  const out = applyMemoryWorthFilter(
    [
      { path: "neutral.md", score: 5 },
      { path: "good.md", score: 3 },
    ],
    { counters, now: NOW, reorder: false },
  );
  // Order preserved — good.md stays second even though its scaled score
  // is higher.
  assert.deepEqual(
    out.map((o) => o.path),
    ["neutral.md", "good.md"],
  );
  // But the score field still reflects the multiplier.
  assert.ok(out[1]!.score > out[1]!.originalScore);
});

test("multiplier is exactly 1.0 for a memory with no counter data", () => {
  const out = applyMemoryWorthFilter(
    [{ path: "x.md", score: 7.25 }],
    {
      // Entry exists in the map but with empty counters (e.g. after
      // decay wiped effective counts). Should still hit neutral.
      counters: new Map<string, MemoryWorthCounters>([["x.md", {}]]),
      now: NOW,
    },
  );
  assert.equal(out[0]!.multiplier, 1);
  assert.equal(out[0]!.score, 7.25);
});

test("worth block is populated for observability", () => {
  const counters = new Map<string, MemoryWorthCounters>([
    ["x.md", { mw_success: 3, mw_fail: 1 }],
  ]);
  const out = applyMemoryWorthFilter(
    [{ path: "x.md", score: 10 }],
    { counters, now: NOW },
  );
  const item = out[0]!;
  assert.ok(item.worth.score > 0 && item.worth.score < 1);
  assert.equal(item.worth.p_success, item.worth.score);
  assert.equal(item.worth.confidence, 4);
});

test("decay is applied when halfLifeMs is supplied", () => {
  const dayMs = 24 * 60 * 60 * 1000;
  const tenDaysAgo = new Date(NOW.getTime() - 10 * dayMs).toISOString();
  const counters = new Map<string, MemoryWorthCounters>([
    ["stale.md", { mw_success: 10, mw_fail: 0, lastAccessed: tenDaysAgo }],
  ]);
  // With a 1-day half-life, 10-day-old outcomes decay by 2^-10 ≈ 1/1024,
  // dragging the score back to ~prior and the multiplier back to ~1.
  const decayed = applyMemoryWorthFilter(
    [{ path: "stale.md", score: 5 }],
    { counters, now: NOW, halfLifeMs: dayMs },
  );
  // And without decay, the same 10/0 counts boost the score.
  const fresh = applyMemoryWorthFilter(
    [{ path: "stale.md", score: 5 }],
    { counters, now: NOW },
  );
  assert.ok(
    decayed[0]!.multiplier < fresh[0]!.multiplier,
    `decay should reduce multiplier (decayed=${decayed[0]!.multiplier}, fresh=${fresh[0]!.multiplier})`,
  );
  assert.ok(Math.abs(decayed[0]!.multiplier - 1) < 0.05, "extremely decayed ⇒ near-prior");
});

test("buildMemoryWorthCounterMap only indexes memories with counter data", () => {
  const map = buildMemoryWorthCounterMap([
    { path: "a.md", frontmatter: { mw_success: 1, mw_fail: 0 } },
    { path: "b.md", frontmatter: {} }, // legacy, no counters
    { path: "c.md", frontmatter: { mw_success: undefined, mw_fail: 2 } },
  ]);
  assert.equal(map.size, 2, "legacy memories must not bloat the map");
  assert.ok(map.has("a.md"));
  assert.ok(map.has("c.md"));
  assert.ok(!map.has("b.md"));
});

test("negative candidate scores do not invert filter direction", () => {
  // Codex P2: if upstream penalties push a score below zero, the
  // multiplier must not flip sign. A high-worth memory (multiplier > 1)
  // must NOT move further negative (worse rank), and a low-worth memory
  // (multiplier < 1) must NOT move toward zero (better rank). Clamping
  // base at 0 before multiplying preserves "failure-prone sinks".
  const counters = new Map<string, MemoryWorthCounters>([
    ["good.md", { mw_success: 10, mw_fail: 0 }],
    ["bad.md", { mw_success: 0, mw_fail: 10 }],
  ]);
  const out = applyMemoryWorthFilter(
    [
      { path: "good.md", score: -1 },
      { path: "bad.md", score: -2 },
      { path: "neutral.md", score: -3 },
    ],
    { counters, now: NOW, reorder: false },
  );
  // All scaled scores must be non-negative (bases clamped to 0).
  for (const item of out) {
    assert.ok(item.score >= 0, `${item.path} score should be >= 0, got ${item.score}`);
  }
});
