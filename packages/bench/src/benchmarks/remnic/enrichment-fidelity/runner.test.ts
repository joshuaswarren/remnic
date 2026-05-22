import assert from "node:assert/strict";
import test from "node:test";

import type { ResolvedRunBenchmarkOptions } from "../../../types.js";
import { ENRICHMENT_FIDELITY_SMOKE_FIXTURE } from "./fixture.js";
import {
  enrichmentFidelityDefinition,
  runEnrichmentFidelityBenchmark,
} from "./runner.js";

function buildOptions(
  overrides: Partial<ResolvedRunBenchmarkOptions> = {},
): ResolvedRunBenchmarkOptions {
  return {
    benchmark: {
      ...enrichmentFidelityDefinition,
      run: runEnrichmentFidelityBenchmark,
    },
    mode: "quick",
    ...overrides,
  } as ResolvedRunBenchmarkOptions;
}

test("runEnrichmentFidelityBenchmark emits per-task completion callbacks", async () => {
  const progress: Array<{ taskId: string; completedCount: number; totalCount: number }> = [];
  const result = await runEnrichmentFidelityBenchmark(
    buildOptions({
      onTaskComplete(task, completedCount, totalCount) {
        progress.push({ taskId: task.taskId, completedCount, totalCount });
      },
    }),
  );

  assert.equal(result.results.tasks.length, ENRICHMENT_FIDELITY_SMOKE_FIXTURE.length);
  assert.deepEqual(
    progress.map((entry) => entry.completedCount),
    [1, 2, 3],
  );
  assert.deepEqual(
    progress.map((entry) => entry.totalCount),
    ENRICHMENT_FIDELITY_SMOKE_FIXTURE.map(() => ENRICHMENT_FIDELITY_SMOKE_FIXTURE.length),
  );
  assert.deepEqual(
    progress.map((entry) => entry.taskId),
    result.results.tasks.map((task) => task.taskId),
  );
});
