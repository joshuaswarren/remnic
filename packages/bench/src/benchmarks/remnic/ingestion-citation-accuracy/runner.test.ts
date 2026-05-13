import assert from "node:assert/strict";
import test from "node:test";

import {
  ingestionCitationAccuracyDefinition,
  runIngestionCitationAccuracyBenchmark,
} from "./runner.ts";

test("citation accuracy accepts deterministic source support when the LLM judge false-negatives", async () => {
  const result = await runIngestionCitationAccuracyBenchmark({
    benchmark: ingestionCitationAccuracyDefinition,
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
      judge: {
        async score() {
          return 0;
        },
      },
    },
    ingestionAdapter: {
      async reset() {},
      async destroy() {},
      async ingest() {
        return {
          commandsIssued: [],
          promptsShown: [],
          errors: [],
          durationMs: 1,
        };
      },
      async getMemoryGraph() {
        return {
          entities: [],
          links: [],
          pages: [
            {
              path: "Project Beacon.md",
              title: "Project Beacon",
              frontmatter: {},
              hasExecSummary: true,
              hasTimeline: false,
              seeAlso: ["inbox.mbox"],
              content:
                "Marcus should coordinate with Project Beacon on shared data-pipeline components.",
            },
          ],
        };
      },
    },
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.valid_citations, 1);
  assert.equal(task.scores.citation_accuracy, 1);

  const details = task.details as {
    claimOutcomes: Array<{
      judgeScore: number;
      deterministicSupport: number;
      valid: boolean;
    }>;
  };
  assert.equal(details.claimOutcomes[0]?.judgeScore, 0);
  assert.ok((details.claimOutcomes[0]?.deterministicSupport ?? 0) >= 0.72);
  assert.equal(details.claimOutcomes[0]?.valid, true);
});
