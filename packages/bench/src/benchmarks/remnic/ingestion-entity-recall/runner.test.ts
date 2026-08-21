import assert from "node:assert/strict";
import test from "node:test";

import {
  ingestionEntityRecallDefinition,
  runIngestionEntityRecallBenchmark,
} from "./runner.ts";
import { EMAIL_GOLD_GRAPH } from "../../../fixtures/inbox/email-gold.ts";

test("entity recall fails the task when ingestion reports errors", async () => {
  let getMemoryGraphCalls = 0;

  const result = await runIngestionEntityRecallBenchmark({
    benchmark: ingestionEntityRecallDefinition,
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
    ingestionAdapter: {
      async reset() {},
      async destroy() {},
      async ingest() {
        return {
          commandsIssued: [],
          promptsShown: [],
          errors: ["store unavailable"],
          durationMs: 1,
        };
      },
      async getMemoryGraph() {
        getMemoryGraphCalls += 1;
        return {
          entities: [
            { name: "Marcus", type: "person", sourceFile: "Project Beacon.md" },
            { name: "Project Beacon", type: "project", sourceFile: "Project Beacon.md" },
          ],
          links: [],
          pages: [],
        };
      },
    },
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.entity_recall, -1);
  assert.equal(result.results.aggregates.entity_recall?.mean, -1);
  assert.match(task.actual, /ingestion error: store unavailable/);
  assert.deepEqual(task.details?.ingestionErrors, ["store unavailable"]);
  assert.equal(getMemoryGraphCalls, 0);
});

test("entity recall drains asynchronous ingestion work before scoring graph", async () => {
  let drained = false;
  let getMemoryGraphCalls = 0;

  const result = await runIngestionEntityRecallBenchmark({
    benchmark: ingestionEntityRecallDefinition,
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
    ingestionAdapter: {
      async reset() {
        drained = false;
      },
      async destroy() {},
      async ingest() {
        return {
          commandsIssued: [],
          promptsShown: [],
          errors: [],
          durationMs: 1,
        };
      },
      async drain() {
        drained = true;
      },
      async getMemoryGraph() {
        getMemoryGraphCalls += 1;
        return {
          entities: drained
            ? EMAIL_GOLD_GRAPH.entities.map((entity) => ({
                name: entity.name,
                type: entity.type,
                sourceFile: "fixture.mbox",
              }))
            : [],
          links: [],
          pages: [],
        };
      },
    },
  });

  const task = result.results.tasks[0]!;
  assert.equal(getMemoryGraphCalls, 1);
  assert.equal(task.scores.entity_recall, 1);
  assert.equal(task.details?.extractedEntityCount, EMAIL_GOLD_GRAPH.entities.length);
});

test("entity recall reports drain failures before reading graph", async () => {
  let getMemoryGraphCalls = 0;

  const result = await runIngestionEntityRecallBenchmark({
    benchmark: ingestionEntityRecallDefinition,
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
    ingestionAdapter: {
      async reset() {},
      async destroy() {},
      async ingest() {
        return {
          commandsIssued: ["ingest"],
          promptsShown: [],
          errors: [],
          durationMs: 1,
        };
      },
      async drain() {
        throw new Error("flush timed out");
      },
      async getMemoryGraph() {
        getMemoryGraphCalls += 1;
        return { entities: [], links: [], pages: [] };
      },
    },
  });

  const task = result.results.tasks[0]!;
  assert.equal(getMemoryGraphCalls, 0);
  assert.equal(task.scores.entity_recall, -1);
  assert.match(task.actual, /ingestion drain error: flush timed out/);
  assert.equal(task.details?.drainError, "flush timed out");
});
