import assert from "node:assert/strict";
import test from "node:test";
import { analyzeInjectionSuiteUtility, type InjectionSuiteUtilityObservation } from "./utility-stats.js";

function paired(delta: number): InjectionSuiteUtilityObservation[] {
  const rows: InjectionSuiteUtilityObservation[] = [];
  for (let seed = 1; seed <= 5; seed += 1) {
    for (let index = 1; index <= 100; index += 1) {
      for (const benchmark of ["locomo", "drift-gen"] as const) {
        const itemId = `${benchmark}-${index}`;
        rows.push({ benchmark, itemId, seed, arm: "none", score: 1 });
        rows.push({ benchmark, itemId, seed, arm: "fencing", score: 1 + delta });
      }
    }
  }
  return rows;
}

test("identical paired utility proves equivalence inside one percent", () => {
  const result = analyzeInjectionSuiteUtility(paired(0));
  assert.equal(result.pairs, 1_000);
  assert.equal(result.relativeDelta, 0);
  assert.deepEqual(result.relativeBootstrap90, { lower: 0, upper: 0 });
  assert.equal(result.equivalent, true);
});

test("two percent relative loss rejects utility equivalence", () => {
  const result = analyzeInjectionSuiteUtility(paired(-0.02));
  assert.ok(result.relativeDelta !== null && result.relativeDelta < -0.01);
  assert.equal(result.equivalent, false);
});

test("unpaired observations are not invented", () => {
  const result = analyzeInjectionSuiteUtility([
    { benchmark: "locomo", itemId: "a", seed: 1, arm: "none", score: 1 },
  ]);
  assert.equal(result.pairs, 0);
  assert.equal(result.equivalent, null);
});

test("a single missing (item, seed, arm) observation makes equivalence not estimable", () => {
  const complete = analyzeInjectionSuiteUtility(paired(0));
  assert.equal(complete.missingObservations, 0);
  assert.equal(complete.equivalent, true);

  const rows = paired(0);
  const dropped = rows.findIndex((row) => row.arm === "fencing" && row.seed === 3 && row.itemId === "locomo-42");
  assert.ok(dropped >= 0);
  rows.splice(dropped, 1);
  const partial = analyzeInjectionSuiteUtility(rows);
  assert.equal(partial.missingObservations, 1);
  assert.equal(partial.equivalent, null, "one missing arm observation must not yield an equivalence verdict");
});

test("a planned benchmark, item, or seed with no observations makes equivalence not estimable", () => {
  const observed = paired(0);
  const plan = {
    benchmarks: ["locomo", "drift-gen"] as const,
    seeds: [1, 2, 3, 4, 5],
    items: [...new Set(observed.map((o) => `${o.benchmark}\0${o.itemId}`))].map((key) => {
      const [benchmark, itemId] = key.split("\0") as ["locomo" | "drift-gen", string];
      return { benchmark, itemId };
    }),
  };
  assert.equal(analyzeInjectionSuiteUtility(observed, plan).equivalent, true);
  const extraSeed = analyzeInjectionSuiteUtility(observed, { ...plan, seeds: [1, 2, 3, 4, 5, 6] });
  assert.equal(extraSeed.equivalent, null);
  assert.ok(extraSeed.missingObservations > 0, "an unobserved planned seed is missing");
  const extraItem = analyzeInjectionSuiteUtility(observed, {
    ...plan,
    items: [...plan.items, { benchmark: "locomo", itemId: "never-ran" }],
  });
  assert.equal(extraItem.missingObservations, 10, "one item x five seeds x two arms");
  const extraBenchmark = analyzeInjectionSuiteUtility(observed, {
    ...plan,
    benchmarks: ["locomo", "drift-gen", "longmemeval"],
  });
  assert.equal(extraBenchmark.equivalent, null, "a benchmark that produced nothing is missing");
  const unplanned = analyzeInjectionSuiteUtility(
    [...observed, { benchmark: "locomo", itemId: "surprise", seed: 1, arm: "none", score: 1 }],
    plan,
  );
  assert.equal(unplanned.equivalent, null, "an observation outside the plan is unexpected");
});
