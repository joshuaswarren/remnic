import test from "node:test";
import assert from "node:assert/strict";
import {
  CANARY_FIXED_RECALL,
  CANARY_SCORE_FLOOR,
  assertCanaryUnderFloor,
  createCanaryAdapter,
  parseCanaryFloor,
  resolveCanaryFloorFromEnv,
  resolveEffectiveCanaryFloor,
} from "./canary-adapter.ts";

test("canary adapter returns the fixed response for every query", async () => {
  const adapter = createCanaryAdapter();
  const recall = await adapter.recall("session-1", "what is the answer?", 1024);
  assert.equal(recall, CANARY_FIXED_RECALL);

  const differentQuery = await adapter.recall("session-2", "other prompt");
  assert.equal(differentQuery, CANARY_FIXED_RECALL);
});

test("canary adapter no-ops on store/reset/destroy", async () => {
  const adapter = createCanaryAdapter();
  await adapter.store("s", [{ role: "user", content: "hi" }]);
  await adapter.reset("s");
  await adapter.destroy();
  const stats = await adapter.getStats();
  assert.deepEqual(stats, {
    totalMessages: 0,
    totalSummaryNodes: 0,
    maxDepth: 0,
  });
});

test("canary adapter search returns a single decoy hit by default", async () => {
  const adapter = createCanaryAdapter();
  const hits = await adapter.search("query", 5);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.snippet, CANARY_FIXED_RECALL);
});

test("canary adapter can return no search hits when configured", async () => {
  const adapter = createCanaryAdapter({ emptySearch: true });
  const hits = await adapter.search("query", 5);
  assert.deepEqual(hits, []);
});

test("canary adapter honors custom response override", async () => {
  const adapter = createCanaryAdapter({ response: "CANARY_X" });
  const recall = await adapter.recall("s", "q");
  assert.equal(recall, "CANARY_X");
});

test("assertCanaryUnderFloor passes when score is at or below the floor", () => {
  const pass = assertCanaryUnderFloor("benchmark-a", 0.05);
  assert.equal(pass.passed, true);
  assert.equal(pass.floor, CANARY_SCORE_FLOOR);

  const edge = assertCanaryUnderFloor("benchmark-a", CANARY_SCORE_FLOOR);
  assert.equal(edge.passed, true);
});

test("assertCanaryUnderFloor fails when score exceeds the floor", () => {
  const fail = assertCanaryUnderFloor("benchmark-b", 0.5);
  assert.equal(fail.passed, false);
  assert.equal(fail.score, 0.5);
});

test("assertCanaryUnderFloor rejects malformed floors", () => {
  assert.throws(() => assertCanaryUnderFloor("b", 0.1, -1));
  assert.throws(() => assertCanaryUnderFloor("b", 0.1, Number.NaN));
});

test("assertCanaryUnderFloor fails on non-finite scores", () => {
  const result = assertCanaryUnderFloor("b", Number.NaN);
  assert.equal(result.passed, false);
});

test("resolveCanaryFloorFromEnv returns the canonical default when the override is unset", () => {
  const saved = process.env.REMNIC_BENCH_CANARY_FLOOR;
  try {
    delete process.env.REMNIC_BENCH_CANARY_FLOOR;
    assert.equal(resolveCanaryFloorFromEnv(), CANARY_SCORE_FLOOR);
    assert.equal(resolveEffectiveCanaryFloor(), CANARY_SCORE_FLOOR);
  } finally {
    if (saved === undefined) {
      delete process.env.REMNIC_BENCH_CANARY_FLOOR;
    } else {
      process.env.REMNIC_BENCH_CANARY_FLOOR = saved;
    }
  }
});

test("resolveCanaryFloorFromEnv accepts valid non-negative overrides", () => {
  const saved = process.env.REMNIC_BENCH_CANARY_FLOOR;
  try {
    process.env.REMNIC_BENCH_CANARY_FLOOR = "0.05";
    assert.equal(resolveCanaryFloorFromEnv(), 0.05);

    process.env.REMNIC_BENCH_CANARY_FLOOR = "0";
    assert.equal(resolveCanaryFloorFromEnv(), 0);
    assert.equal(resolveEffectiveCanaryFloor(), 0);
  } finally {
    if (saved === undefined) {
      delete process.env.REMNIC_BENCH_CANARY_FLOOR;
    } else {
      process.env.REMNIC_BENCH_CANARY_FLOOR = saved;
    }
  }
});

test("resolveCanaryFloorFromEnv rejects empty, invalid, non-finite, or negative overrides", () => {
  const saved = process.env.REMNIC_BENCH_CANARY_FLOOR;
  const invalid = ["", "abc", "-1", "NaN", "Infinity", "1e999"];
  try {
    for (const raw of invalid) {
      process.env.REMNIC_BENCH_CANARY_FLOOR = raw;
      assert.throws(() => resolveCanaryFloorFromEnv(), /Invalid REMNIC_BENCH_CANARY_FLOOR/, raw);
      assert.throws(() => resolveEffectiveCanaryFloor(), /Invalid REMNIC_BENCH_CANARY_FLOOR/, raw);
    }
  } finally {
    if (saved === undefined) {
      delete process.env.REMNIC_BENCH_CANARY_FLOOR;
    } else {
      process.env.REMNIC_BENCH_CANARY_FLOOR = saved;
    }
  }
});

test("resolveEffectiveCanaryFloor prefers a valid preset and rejects a malformed one", () => {
  const saved = process.env.REMNIC_BENCH_CANARY_FLOOR;
  try {
    process.env.REMNIC_BENCH_CANARY_FLOOR = "abc";
    assert.equal(resolveEffectiveCanaryFloor(0.2), 0.2);
    assert.equal(resolveEffectiveCanaryFloor(0), 0);
    assert.throws(() => parseCanaryFloor(-1), /Invalid canary floor/);
    assert.throws(() => parseCanaryFloor(Number.NaN), /Invalid canary floor/);
    assert.throws(() => parseCanaryFloor(Number.POSITIVE_INFINITY), /Invalid canary floor/);
    assert.throws(() => parseCanaryFloor("0.2"), /Invalid canary floor/);
    assert.throws(() => resolveEffectiveCanaryFloor(-1), /Invalid canary floor/);
    assert.throws(() => resolveEffectiveCanaryFloor(Number.NaN), /Invalid canary floor/);
    assert.throws(() => resolveEffectiveCanaryFloor("0.2"), /Invalid canary floor/);
  } finally {
    if (saved === undefined) {
      delete process.env.REMNIC_BENCH_CANARY_FLOOR;
    } else {
      process.env.REMNIC_BENCH_CANARY_FLOOR = saved;
    }
  }
});
