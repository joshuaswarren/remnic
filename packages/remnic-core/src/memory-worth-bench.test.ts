import test from "node:test";
import assert from "node:assert/strict";

import { runMemoryWorthBench } from "./memory-worth-bench.js";

/**
 * Issue #560 PR 5 — bench verifies the filter wins against a no-filter
 * baseline on synthetic cases. If this test ever fails, do NOT ship the
 * default flip — something changed in the scorer math.
 */

test("memory-worth bench: filter improves precision@5 on every seed case", () => {
  const result = runMemoryWorthBench({ cases: 50, seed: 0xdeadbeef });
  // Sanity.
  assert.equal(result.cases, 50);
  assert.equal(result.k, 5);
  // The synthetic corpus is designed so the "true positives" only reach the
  // top 5 when the filter is applied — filter-off precision should be 0,
  // filter-on should land near the 3/5 ceiling (all three gold items
  // promoted). Pinning the boundary both ways catches scorer regressions.
  assert.equal(result.precisionAtK_off, 0, "baseline must leave zero gold in top 5");
  assert.ok(
    result.precisionAtK_on >= 0.58,
    `filter-on precision ${result.precisionAtK_on} should be ≥ 0.58`,
  );
  assert.ok(
    result.delta > 0.5,
    `delta ${result.delta} must be a substantial lift, not a tie`,
  );
  assert.equal(
    result.filterWinsOrTies,
    true,
    "filter-on must win or tie on every case in the seeded set",
  );
});

test("memory-worth bench: result object shape is stable", () => {
  // If a new field lands on MemoryWorthBenchResult, the default-flip
  // decision should consciously re-evaluate — pin the shape here so that
  // review catches the change.
  const result = runMemoryWorthBench({ cases: 5 });
  const keys = Object.keys(result).sort();
  assert.deepEqual(keys, [
    "cases",
    "delta",
    "filterWinsOrTies",
    "k",
    "precisionAtK_off",
    "precisionAtK_on",
  ]);
});

test("memory-worth bench: rejects non-positive-integer case counts", () => {
  // Codex P2: 0 would divide by zero and return NaN; fractional inputs
  // inflate the average. Both would produce misleading default-flip
  // justification — fail loudly instead.
  assert.throws(() => runMemoryWorthBench({ cases: 0 }), /positive integer/);
  assert.throws(() => runMemoryWorthBench({ cases: -5 }), /positive integer/);
  assert.throws(() => runMemoryWorthBench({ cases: 2.5 }), /positive integer/);
  assert.throws(() => runMemoryWorthBench({ cases: Number.NaN }), /positive integer/);
  assert.throws(
    () => runMemoryWorthBench({ cases: Number.POSITIVE_INFINITY }),
    /positive integer/,
  );
});

test("memory-worth bench: deterministic under fixed seed", () => {
  const a = runMemoryWorthBench({ cases: 20, seed: 42 });
  const b = runMemoryWorthBench({ cases: 20, seed: 42 });
  assert.deepEqual(a, b, "identical seed + cases must produce identical results");
});
