import assert from "node:assert/strict";
import test from "node:test";

import { normalizeDiffChangedLines, pageVersioningDefinition, runPageVersioningBenchmark } from "./runner.ts";

const dummySystem = {
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
};

test("normalizeDiffChangedLines preserves unexpected changed lines", () => {
  const observed = normalizeDiffChangedLines(
    ["--- version 1", "+++ version 2", " line 1", "-line 2", "+line 2 changed", "-line 3", " line 3", "+line 4"].join(
      "\n"
    )
  );

  assert.equal(observed, "-line 2|+line 2 changed|-line 3|+line 4");
});

test("prune-window rethrows unexpected getVersion failures", async () => {
  await assert.rejects(
    runPageVersioningBenchmark(
      {
        benchmark: pageVersioningDefinition,
        mode: "full",
        system: dummySystem,
      },
      {
        getVersion: async (_pagePath, versionId) => {
          if (versionId === "3") {
            return "modified content";
          }
          throw new Error("backend unavailable during getVersion");
        },
      }
    ),
    /backend unavailable during getVersion/
  );
});
