import assert from "node:assert/strict";
import test from "node:test";
import {
  clearVerdictCache,
  judgeFactDurability,
  parseConfig,
  verdictCacheSize,
} from "@remnic/core";

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

test("Extraction judge calibration reports the effective forced judge config", async () => {
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
    remnicConfig: {
      extractionJudgeEnabled: false,
      extractionJudgeBatchSize: 99,
      extractionJudgeShadow: true,
      extractionJudgeMaxDeferrals: 0,
      modelSource: "gateway",
    },
  });

  assert.deepEqual(result.config.remnicConfig, {
    extractionJudgeEnabled: true,
    extractionJudgeBatchSize: 4,
    extractionJudgeShadow: false,
    extractionJudgeMaxDeferrals: 2,
    extractionJudgeModel: "",
  });
});

test("Extraction judge calibration does not clear the process-wide verdict cache", async () => {
  clearVerdictCache();
  try {
    const config = parseConfig({
      memoryDir: "/tmp/remnic-bench-cache-test",
      openaiApiKey: "bench-test-key",
      extractionJudgeEnabled: true,
      extractionJudgeBatchSize: 4,
      extractionJudgeShadow: false,
    });
    await judgeFactDurability(
      [
        {
          text: "The user wants a durable cached benchmark sentinel.",
          category: "fact",
          confidence: 0.5,
        },
      ],
      config,
      {
        chatCompletion: async () => ({
          content: JSON.stringify([
            {
              index: 0,
              durable: true,
              reason: "seed default cache",
            },
          ]),
        }),
      } as never,
      null,
    );
    assert.equal(verdictCacheSize(), 1);

    await runExtractionJudgeCalibrationBenchmark({
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

    assert.equal(verdictCacheSize(), 1);
  } finally {
    clearVerdictCache();
  }
});
