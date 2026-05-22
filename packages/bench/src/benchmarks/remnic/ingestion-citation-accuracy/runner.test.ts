import assert from "node:assert/strict";
import test from "node:test";

import {
  ingestionCitationAccuracyDefinition,
  runIngestionCitationAccuracyBenchmark,
} from "./runner.ts";
import { createSyntheticEmailIngestionAdapter } from "../../../ingestion-adapters/synthetic-email-adapter.ts";

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

test("citation accuracy accounts for judge tokens in task and cost totals", async () => {
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
          return 1;
        },
        async scoreWithMetrics() {
          return {
            score: 1,
            tokens: { input: 17, output: 5 },
            latencyMs: 11,
            model: "citation-judge-test",
          };
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
  assert.deepEqual(task.tokens, { input: 17, output: 5 });
  assert.equal(result.cost.inputTokens, 17);
  assert.equal(result.cost.outputTokens, 5);
  assert.equal(result.cost.totalTokens, 22);
  assert.equal(task.details?.judgeLatencyMs, 11);
  assert.deepEqual(task.details?.judgeModels, ["citation-judge-test"]);
});

test("citation accuracy does not score unresolved page backlinks against the full corpus", async () => {
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
              seeAlso: ["Project Horizon"],
              content:
                "Marcus should coordinate with Project Beacon on shared data-pipeline components.",
            },
          ],
        };
      },
    },
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.valid_citations, 0);
  assert.equal(task.scores.citation_accuracy, 0);

  const details = task.details as {
    claimOutcomes: Array<{
      deterministicSupport: number;
      valid: boolean;
    }>;
  };
  assert.equal(details.claimOutcomes[0]?.deterministicSupport, 0);
  assert.equal(details.claimOutcomes[0]?.valid, false);
});

test("citation accuracy does not fall back to fixture sources for explicit empty source refs", async () => {
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
              sourceRefs: [],
              seeAlso: ["inbox.mbox"],
              content:
                "Marcus should coordinate with Project Beacon on shared data-pipeline components.",
            },
            {
              path: "Project Beacon Blank.md",
              title: "Project Beacon Blank",
              frontmatter: {},
              hasExecSummary: true,
              hasTimeline: false,
              sourceRefs: [""],
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
  assert.equal(task.scores.valid_citations, 0);
  assert.equal(task.scores.citation_accuracy, 0);

  const details = task.details as {
    claimOutcomes: Array<{
      deterministicSupport: number;
      valid: boolean;
    }>;
  };
  assert.equal(details.claimOutcomes.length, 2);
  assert.deepEqual(
    details.claimOutcomes.map((outcome) => outcome.deterministicSupport),
    [0, 0],
  );
  assert.deepEqual(
    details.claimOutcomes.map((outcome) => outcome.valid),
    [false, false],
  );
});

test("citation accuracy fails before scoring when ingestion reports errors", async () => {
  let judgeCalled = false;
  let graphRead = false;

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
          judgeCalled = true;
          return 1;
        },
      },
    },
    ingestionAdapter: {
      async reset() {},
      async destroy() {},
      async ingest() {
        return {
          commandsIssued: ["ingest"],
          promptsShown: [],
          errors: ["ingest failed"],
          durationMs: 1,
        };
      },
      async getMemoryGraph() {
        graphRead = true;
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
              sourceRefs: ["inbox.mbox"],
              seeAlso: [],
              content:
                "Marcus should coordinate with Project Beacon on shared data-pipeline components.",
            },
          ],
        };
      },
    },
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.valid_citations, 0);
  assert.equal(task.scores.citation_accuracy, -1);
  assert.equal(judgeCalled, false);
  assert.equal(graphRead, false);
  assert.match(task.actual, /ingestion error: ingest failed/);
  assert.deepEqual(task.details?.ingestionErrors, ["ingest failed"]);
});

test("citation accuracy scores synthetic adapter source refs without abusing backlinks", async () => {
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
    ingestionAdapter: createSyntheticEmailIngestionAdapter(),
  });

  const task = result.results.tasks[0]!;
  assert.ok((task.scores.valid_citations ?? 0) > 0);
  assert.ok((task.scores.citation_accuracy ?? 0) > 0);
});
