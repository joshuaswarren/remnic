import assert from "node:assert/strict";
import test from "node:test";

import type { BenchMemoryAdapter } from "../../../adapters/types.js";
import {
  entityConsolidationDefinition,
  runEntityConsolidationBenchmark,
} from "./runner.js";
import { ENTITY_CONSOLIDATION_FIXTURE } from "./fixture.js";

const noopAdapter: BenchMemoryAdapter = {
  async store() {},
  async recall() {
    return "";
  },
  async search() {
    return [];
  },
  async reset() {},
  async getStats() {
    return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
  },
  async destroy() {},
};

test("entity consolidation benchmark scores all quick fixture scenarios", async () => {
  const result = await runEntityConsolidationBenchmark({
    benchmark: entityConsolidationDefinition,
    mode: "quick",
    system: noopAdapter,
  });

  assert.equal(result.results.tasks.length, 3);
  assert.equal(result.results.aggregates.exact_match?.mean, 1);

  for (const sample of ENTITY_CONSOLIDATION_FIXTURE) {
    const task = result.results.tasks.find((entry) => entry.taskId === sample.id);
    assert.ok(task, `missing task ${sample.id}`);
    assert.equal(task.scores.exact_match, 1);
    assert.equal(task.scores.timeline_count_match, 1);
    assert.equal(task.scores.structured_fact_count_match, 1);
    assert.equal(task.scores.stale_flag_match, 1);
    assert.equal(task.details?.scenario, sample.scenario);

    const actual = JSON.parse(task.actual) as { stale: boolean };
    assert.equal(actual.stale, sample.expected.stale);
  }
});

test("entity consolidation benchmark applies limit before running cases", async () => {
  const result = await runEntityConsolidationBenchmark({
    benchmark: entityConsolidationDefinition,
    mode: "quick",
    limit: 1,
    system: noopAdapter,
  });

  assert.equal(result.results.tasks.length, 1);
  assert.equal(result.results.tasks[0]?.taskId, ENTITY_CONSOLIDATION_FIXTURE[0]?.id);
  assert.equal(result.results.aggregates.exact_match?.mean, 1);
});
