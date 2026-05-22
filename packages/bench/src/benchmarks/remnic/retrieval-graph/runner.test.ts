import assert from "node:assert/strict";
import test from "node:test";

import type { ResolvedRunBenchmarkOptions } from "../../../types.js";
import {
  retrievalGraphDefinition,
  runRetrievalGraphBenchmark,
} from "./runner.js";
import { RETRIEVAL_GRAPH_FIXTURE } from "./fixture.js";

function buildOptions(
  overrides: Partial<ResolvedRunBenchmarkOptions> = {},
): ResolvedRunBenchmarkOptions {
  return {
    benchmark: { ...retrievalGraphDefinition, run: runRetrievalGraphBenchmark },
    mode: "full",
    ...overrides,
  } as ResolvedRunBenchmarkOptions;
}

test("retrievalGraphDefinition is registered with the expected shape", () => {
  assert.equal(retrievalGraphDefinition.id, "retrieval-graph");
  assert.equal(retrievalGraphDefinition.tier, "remnic");
  assert.equal(retrievalGraphDefinition.runnerAvailable, true);
});

test("runRetrievalGraphBenchmark produces a task per fixture case", async () => {
  const result = await runRetrievalGraphBenchmark(buildOptions({ mode: "full" }));
  assert.equal(result.results.tasks.length, RETRIEVAL_GRAPH_FIXTURE.length);
  for (const task of result.results.tasks) {
    assert.ok(typeof task.scores.p_at_3_on === "number");
    assert.ok(typeof task.scores.p_at_3_off === "number");
  }
});

test("runRetrievalGraphBenchmark aggregates report graph-on vs graph-off", async () => {
  const result = await runRetrievalGraphBenchmark(buildOptions({ mode: "full" }));
  const agg = result.results.aggregates;
  // Each metric is a MetricAggregate { mean, median, stdDev, min, max }.
  assert.ok(agg.p_at_3_on && typeof agg.p_at_3_on.mean === "number");
  assert.ok(agg.p_at_3_off && typeof agg.p_at_3_off.mean === "number");
  assert.ok(agg.delta_p_at_3 && typeof agg.delta_p_at_3.mean === "number");
  assert.ok(agg.graph_on_win && typeof agg.graph_on_win.mean === "number");
});

test("runRetrievalGraphBenchmark graph-on beats or ties graph-off on the fixture", async () => {
  const result = await runRetrievalGraphBenchmark(buildOptions({ mode: "full" }));
  const agg = result.results.aggregates;
  // Primary ship criterion: mean of delta_p_at_3 >= 0.
  assert.ok(
    agg.p_at_3_on.mean >= agg.p_at_3_off.mean,
    `graph-on precision (${agg.p_at_3_on.mean}) regressed below graph-off (${agg.p_at_3_off.mean})`,
  );
});

test("runRetrievalGraphBenchmark branching supersession case reaches both branch tips and canonical predecessor", async () => {
  const result = await runRetrievalGraphBenchmark(buildOptions({ mode: "full" }));
  const task = result.results.tasks.find((entry) => entry.taskId === "supersession-branches");
  assert.ok(task);

  const actual = JSON.parse(task.actual) as string[];
  assert.equal(actual.includes("update-1"), true);
  assert.equal(actual.includes("update-2"), true);
  assert.equal(actual.includes("canonical"), true);
  assert.equal(task.scores.p_at_3_on, 1);
});

test("runRetrievalGraphBenchmark quick mode runs the smoke subset", async () => {
  const full = await runRetrievalGraphBenchmark(buildOptions({ mode: "full" }));
  const quick = await runRetrievalGraphBenchmark(buildOptions({ mode: "quick" }));
  assert.ok(quick.results.tasks.length < full.results.tasks.length);
  assert.ok(quick.results.tasks.length > 0);
});

test("runRetrievalGraphBenchmark rejects non-integer / non-positive limit", async () => {
  await assert.rejects(() =>
    runRetrievalGraphBenchmark(buildOptions({ limit: 0 })),
  );
  await assert.rejects(() =>
    runRetrievalGraphBenchmark(buildOptions({ limit: 1.5 })),
  );
  await assert.rejects(() =>
    runRetrievalGraphBenchmark(buildOptions({ limit: -1 })),
  );
});
