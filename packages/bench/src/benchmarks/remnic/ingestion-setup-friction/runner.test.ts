import assert from "node:assert/strict";
import test from "node:test";

import {
  ingestionSetupFrictionDefinition,
  runIngestionSetupFrictionBenchmark,
} from "./runner.ts";

test("setup friction reports missing ingestion adapter clearly", async () => {
  await assert.rejects(
    runIngestionSetupFrictionBenchmark({
      benchmark: ingestionSetupFrictionDefinition,
      mode: "quick",
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
    }),
    /ingestionAdapter is required for ingestion benchmarks/,
  );
});
