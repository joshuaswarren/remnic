import assert from "node:assert/strict";
import test from "node:test";

import {
  extractionJudgeCalibrationDefinition,
  runExtractionJudgeCalibrationBenchmark,
} from "./runner.ts";

test("Extraction judge calibration treats absent negative class as neutral", async () => {
  const result = await runExtractionJudgeCalibrationBenchmark({
    benchmark: extractionJudgeCalibrationDefinition,
    mode: "quick",
    limit: 1,
    system: {
      async reset() {},
      async store() {},
      async recall() {
        return "";
      },
      async search() {
        return [];
      },
      async destroy() {},
      async getStats() {
        return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
      },
    },
  });

  assert.equal(result.results.tasks.length, 1);
  assert.equal(result.results.aggregates.specificity.mean, 1);
  assert.equal(result.results.aggregates.sensitivity.mean, 1);
});
