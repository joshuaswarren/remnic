import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assistantNextBestActionDefinition,
  runAssistantNextBestActionBenchmark,
} from "./runner.ts";

function baseOptions(
  spotCheckDir: string,
): Parameters<typeof runAssistantNextBestActionBenchmark>[0] {
  return {
    benchmark: assistantNextBestActionDefinition,
    mode: "full",
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
      judge: {
        async score() {
          return 0;
        },
      },
    },
    remnicConfig: {
      assistantSeeds: [1],
      assistantSpotCheckDir: spotCheckDir,
    },
  };
}

test("assistant next-best-action applies a positive integer limit", async () => {
  const spotCheckDir = await mkdtemp(path.join(tmpdir(), "remnic-nba-spot-"));

  try {
    const result = await runAssistantNextBestActionBenchmark({
      ...baseOptions(spotCheckDir),
      limit: 1,
    });

    assert.equal(result.results.tasks.length, 1);
    assert.equal(result.meta.runCount, 1);
  } finally {
    await rm(spotCheckDir, { recursive: true, force: true });
  }
});

test("assistant next-best-action rejects invalid limits", async () => {
  const spotCheckDir = await mkdtemp(path.join(tmpdir(), "remnic-nba-spot-"));

  try {
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(
        () => runAssistantNextBestActionBenchmark({
          ...baseOptions(spotCheckDir),
          limit,
        }),
        /assistant-next-best-action limit must be a positive integer/,
      );
    }
  } finally {
    await rm(spotCheckDir, { recursive: true, force: true });
  }
});
