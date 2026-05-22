import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  memoryAgentBenchDefinition,
  runMemoryAgentBenchBenchmark,
} from "./runner.ts";

test("MemoryAgentBench refines EventQA destinations from recalled event evidence", async () => {
  const result = await runMemoryAgentBenchBenchmark({
    benchmark: memoryAgentBenchDefinition,
    mode: "quick",
    limit: 1,
    system: {
      async reset() {},
      async store() {},
      async recall() {
        return [
          "Event log:",
          "1. Maya boarded the blue tram to the museum.",
          "2. She bought a ticket for the modern art exhibit.",
          "3. After lunch, she walked to the riverside market.",
        ].join("\n");
      },
      async search() {
        return [];
      },
      async destroy() {},
      async getStats() {
        return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
      },
      responder: {
        async respond() {
          return {
            text: "She walked to the riverside market.",
            tokens: { input: 1, output: 1 },
            latencyMs: 1,
            model: "mab-test-responder",
          };
        },
      },
      judge: {
        async score() {
          return 1;
        },
        async scoreWithMetrics() {
          return {
            score: 1,
            tokens: { input: 0, output: 0 },
            latencyMs: 0,
            model: "mab-test-judge",
          };
        },
      },
    },
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.actual, "the riverside market");
  assert.equal(task.scores.official_exact_match, 1);
  assert.equal(task.scores.official_f1, 1);
  assert.equal(task.details.originalAnsweredText, "She walked to the riverside market.");
});

test("MemoryAgentBench ReDial scoring can rank mapped movies from recalled evidence", async () => {
  const datasetDir = await mkdtemp(path.join(tmpdir(), "remnic-mab-redial-"));

  try {
    await writeFile(
      path.join(datasetDir, "entity2id.json"),
      JSON.stringify({
        "http://dbpedia.org/resource/The_Matrix_(1999_film)": 1,
        "http://dbpedia.org/resource/Titanic_(1997_film)": 2,
      }),
      "utf8",
    );
    await writeFile(
      path.join(datasetDir, "memoryagentbench.json"),
      JSON.stringify([
        {
          context:
            "The user asked for cyberpunk action movies. The recommender suggested The Matrix (1999) as the best fit.",
          questions: [
            "User: I want a cyberpunk action movie. Recommender:",
          ],
          answers: [["1"]],
          metadata: {
            source: "recsys_redial",
            qa_pair_ids: ["redial-1"],
            question_types: ["recommendation"],
          },
        },
      ]),
      "utf8",
    );

    const result = await runMemoryAgentBenchBenchmark({
      benchmark: memoryAgentBenchDefinition,
      mode: "full",
      datasetDir,
      system: {
        async reset() {},
        async store() {},
        async recall() {
          return "The recalled ReDial evidence says to recommend The Matrix (1999).";
        },
        async search() {
          return [];
        },
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond() {
            return {
              text: "1. Titanic (1997)",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "mab-test-responder",
            };
          },
        },
        judge: {
          async score() {
            return 1;
          },
          async scoreWithMetrics() {
            return {
              score: 1,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "mab-test-judge",
            };
          },
        },
      },
    });

    const task = result.results.tasks[0]!;
    assert.match(task.actual, /^1\. The Matrix \(1999\)/);
    assert.equal(task.scores.official_protocol_ready, 1);
    assert.equal(task.scores.recsys_recall_at_1, 1);
    assert.deepEqual(task.details?.recsysGroundTruthMovies, ["The Matrix (1999)"]);
    assert.equal(task.details?.originalAnsweredText, "1. Titanic (1997)");
  } finally {
    await rm(datasetDir, { recursive: true, force: true });
  }
});

test("MemoryAgentBench ReDial scoring rejects malformed numeric gold IDs", async () => {
  const datasetDir = await mkdtemp(path.join(tmpdir(), "remnic-mab-redial-bad-id-"));

  try {
    await writeFile(
      path.join(datasetDir, "entity2id.json"),
      JSON.stringify({
        "http://dbpedia.org/resource/The_Matrix_(1999_film)": 1,
      }),
      "utf8",
    );
    await writeFile(
      path.join(datasetDir, "memoryagentbench.json"),
      JSON.stringify([
        {
          context: "The recommender suggested The Matrix (1999) as the best fit.",
          questions: [
            "User: I want a cyberpunk action movie. Recommender:",
          ],
          answers: [["1abc"]],
          metadata: {
            source: "recsys_redial",
            qa_pair_ids: ["redial-bad-id"],
            question_types: ["recommendation"],
          },
        },
      ]),
      "utf8",
    );

    const result = await runMemoryAgentBenchBenchmark({
      benchmark: memoryAgentBenchDefinition,
      mode: "full",
      datasetDir,
      system: {
        async reset() {},
        async store() {},
        async recall() {
          return "The recalled ReDial evidence says to recommend The Matrix (1999).";
        },
        async search() {
          return [];
        },
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond() {
            return {
              text: "1. The Matrix (1999)",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "mab-test-responder",
            };
          },
        },
        judge: {
          async score() {
            return 1;
          },
          async scoreWithMetrics() {
            return {
              score: 1,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "mab-test-judge",
            };
          },
        },
      },
    });

    const task = result.results.tasks[0]!;
    assert.equal(task.scores.official_protocol_ready, 0);
    assert.equal(task.scores.recsys_recall_at_1, undefined);
    assert.equal(task.details?.recsysGroundTruthMovies, undefined);
  } finally {
    await rm(datasetDir, { recursive: true, force: true });
  }
});

test("MemoryAgentBench ReDial refinement preserves a recalled responder top movie", async () => {
  const datasetDir = await mkdtemp(path.join(tmpdir(), "remnic-mab-redial-preserve-"));

  try {
    await writeFile(
      path.join(datasetDir, "entity2id.json"),
      JSON.stringify({
        "http://dbpedia.org/resource/The_Matrix_(1999_film)": 1,
        "http://dbpedia.org/resource/Titanic_(1997_film)": 2,
      }),
      "utf8",
    );
    await writeFile(
      path.join(datasetDir, "memoryagentbench.json"),
      JSON.stringify([
        {
          context:
            "The user mentioned Titanic (1997), then the recommender suggested The Matrix (1999) as the best fit.",
          questions: [
            "User: I want a cyberpunk action movie. Recommender:",
          ],
          answers: [["1"]],
          metadata: {
            source: "recsys_redial",
            qa_pair_ids: ["redial-preserve"],
            question_types: ["recommendation"],
          },
        },
      ]),
      "utf8",
    );

    const result = await runMemoryAgentBenchBenchmark({
      benchmark: memoryAgentBenchDefinition,
      mode: "full",
      datasetDir,
      system: {
        async reset() {},
        async store() {},
        async recall() {
          return "The user mentioned Titanic (1997), then the recommender suggested The Matrix (1999) as the best fit.";
        },
        async search() {
          return [];
        },
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond() {
            return {
              text: "1. The Matrix (1999)",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "mab-test-responder",
            };
          },
        },
        judge: {
          async score() {
            return 1;
          },
          async scoreWithMetrics() {
            return {
              score: 1,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "mab-test-judge",
            };
          },
        },
      },
    });

    const task = result.results.tasks[0]!;
    assert.match(task.actual, /^1\. The Matrix \(1999\)/);
    assert.equal(task.scores.official_protocol_ready, 1);
    assert.equal(task.scores.recsys_recall_at_1, 1);
    assert.deepEqual(task.details?.recsysPredictedMovies, ["The Matrix (1999)"]);
  } finally {
    await rm(datasetDir, { recursive: true, force: true });
  }
});

test("MemoryAgentBench ReDial refinement ignores numbered non-recommendation recall lines", async () => {
  const datasetDir = await mkdtemp(path.join(tmpdir(), "remnic-mab-redial-numbered-"));

  try {
    await writeFile(
      path.join(datasetDir, "entity2id.json"),
      JSON.stringify({
        "http://dbpedia.org/resource/The_Matrix_(1999_film)": 1,
        "http://dbpedia.org/resource/Titanic_(1997_film)": 2,
      }),
      "utf8",
    );
    await writeFile(
      path.join(datasetDir, "memoryagentbench.json"),
      JSON.stringify([
        {
          context:
            "The user mentioned Titanic (1997), then the recommender suggested The Matrix (1999) as the best fit.",
          questions: [
            "User: I want a cyberpunk action movie. Recommender:",
          ],
          answers: [["1"]],
          metadata: {
            source: "recsys_redial",
            qa_pair_ids: ["redial-numbered"],
            question_types: ["recommendation"],
          },
        },
      ]),
      "utf8",
    );

    const result = await runMemoryAgentBenchBenchmark({
      benchmark: memoryAgentBenchDefinition,
      mode: "full",
      datasetDir,
      system: {
        async reset() {},
        async store() {},
        async recall() {
          return [
            "Retrieved ReDial evidence:",
            "1. user mentioned Titanic (1997) earlier but did not ask for it.",
            "2. recommender suggested The Matrix (1999) as the best fit.",
          ].join("\n");
        },
        async search() {
          return [];
        },
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond() {
            return {
              text: "1. Unknown Movie",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "mab-test-responder",
            };
          },
        },
        judge: {
          async score() {
            return 1;
          },
          async scoreWithMetrics() {
            return {
              score: 1,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "mab-test-judge",
            };
          },
        },
      },
    });

    const task = result.results.tasks[0]!;
    assert.match(task.actual, /^1\. The Matrix \(1999\)/);
    assert.equal(task.scores.recsys_recall_at_1, 1);
    assert.deepEqual(task.details?.recsysPredictedMovies, ["The Matrix (1999)"]);
  } finally {
    await rm(datasetDir, { recursive: true, force: true });
  }
});

test("MemoryAgentBench ReDial datasets require entity mapping before adapter work", async () => {
  const datasetDir = await mkdtemp(path.join(tmpdir(), "remnic-mab-redial-missing-map-"));
  let resetCalled = false;

  try {
    await writeFile(
      path.join(datasetDir, "memoryagentbench.json"),
      JSON.stringify([
        {
          context: "The user asked for cyberpunk action movies.",
          questions: ["User: I want a cyberpunk action movie. Recommender:"],
          answers: [["1"]],
          metadata: {
            source: "recsys_redial",
            qa_pair_ids: ["redial-missing-map"],
            question_types: ["recommendation"],
          },
        },
      ]),
      "utf8",
    );

    await assert.rejects(
      runMemoryAgentBenchBenchmark({
        benchmark: memoryAgentBenchDefinition,
        mode: "full",
        datasetDir,
        adapterMode: "dry-run",
        system: {
          async reset() {
            resetCalled = true;
          },
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
          responder: {
            async respond() {
              return {
                text: "",
                tokens: { input: 0, output: 0 },
                latencyMs: 0,
                model: "mab-test-responder",
              };
            },
          },
          judge: {
            async score() {
              return 0;
            },
            async scoreWithMetrics() {
              return {
                score: 0,
                tokens: { input: 0, output: 0 },
                latencyMs: 0,
                model: "mab-test-judge",
              };
            },
          },
        },
      }),
      /ReDial samples require a valid ReDial entity mapping/,
    );
    assert.equal(resetCalled, false);
  } finally {
    await rm(datasetDir, { recursive: true, force: true });
  }
});

test("MemoryAgentBench rejects malformed primary dataset instead of falling back", async () => {
  const datasetDir = await mkdtemp(path.join(tmpdir(), "remnic-mab-malformed-primary-"));
  let resetCalled = false;

  try {
    await writeFile(path.join(datasetDir, "memoryagentbench.json"), "{", "utf8");
    await writeFile(
      path.join(datasetDir, "memoryagentbench.jsonl"),
      JSON.stringify({
        context: "Valid fallback context.",
        questions: ["What is stored?"],
        answers: [["Valid fallback context"]],
        metadata: {
          source: "eventqa_full",
          qa_pair_ids: ["fallback-q1"],
        },
      }),
      "utf8",
    );

    await assert.rejects(
      runMemoryAgentBenchBenchmark({
        benchmark: memoryAgentBenchDefinition,
        mode: "full",
        datasetDir,
        system: {
          async reset() {
            resetCalled = true;
          },
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
          responder: {
            async respond() {
              return {
                text: "",
                tokens: { input: 0, output: 0 },
                latencyMs: 0,
                model: "mab-test-responder",
              };
            },
          },
          judge: {
            async score() {
              return 0;
            },
            async scoreWithMetrics() {
              return {
                score: 0,
                tokens: { input: 0, output: 0 },
                latencyMs: 0,
                model: "mab-test-judge",
              };
            },
          },
        },
      }),
      /memoryagentbench\.json contains invalid JSON/,
    );
    assert.equal(resetCalled, false);
  } finally {
    await rm(datasetDir, { recursive: true, force: true });
  }
});

test("MemoryAgentBench trialLimit caps scored questions before extra adapter work", async () => {
  let resetCount = 0;

  const result = await runMemoryAgentBenchBenchmark({
    benchmark: memoryAgentBenchDefinition,
    mode: "quick",
    benchmarkOptions: { trialLimit: 2 },
    system: {
      async reset() {
        resetCount += 1;
      },
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
      responder: {
        async respond() {
          return {
            text: "unknown",
            tokens: { input: 1, output: 1 },
            latencyMs: 1,
            model: "mab-test-responder",
          };
        },
      },
      judge: {
        async score() {
          return 0;
        },
        async scoreWithMetrics() {
          return {
            score: 0,
            tokens: { input: 0, output: 0 },
            latencyMs: 0,
            model: "mab-test-judge",
          };
        },
      },
    },
  });

  assert.equal(result.results.tasks.length, 2);
  assert.deepEqual(
    result.results.tasks.map((task) => task.taskId),
    ["mab-smoke-ar-q1", "mab-smoke-ttl-q1"],
  );
  assert.equal(result.config.benchmarkOptions?.trialLimit, 2);
  assert.equal(resetCount, 2);
});

test("MemoryAgentBench does not score a sample after drain fails", async () => {
  let recallCount = 0;
  let responderCount = 0;
  let judgeCount = 0;
  const completedTaskIds: string[] = [];

  const result = await runMemoryAgentBenchBenchmark({
    benchmark: memoryAgentBenchDefinition,
    mode: "quick",
    limit: 1,
    system: {
      async reset() {},
      async store() {},
      async drain() {
        throw new Error("drain backend unavailable");
      },
      async recall() {
        recallCount += 1;
        return "stale recall";
      },
      async search() {
        return [];
      },
      async destroy() {},
      async getStats() {
        return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
      },
      responder: {
        async respond() {
          responderCount += 1;
          return {
            text: "unknown",
            tokens: { input: 1, output: 1 },
            latencyMs: 1,
            model: "mab-test-responder",
          };
        },
      },
      judge: {
        async score() {
          judgeCount += 1;
          return 0;
        },
        async scoreWithMetrics() {
          judgeCount += 1;
          return {
            score: 0,
            tokens: { input: 0, output: 0 },
            latencyMs: 0,
            model: "mab-test-judge",
          };
        },
      },
    },
    onTaskComplete(task) {
      completedTaskIds.push(task.taskId);
    },
  });

  assert.equal(recallCount, 0);
  assert.equal(responderCount, 0);
  assert.equal(judgeCount, 0);
  assert.deepEqual(completedTaskIds, ["mab-smoke-ar-q1"]);

  const task = result.results.tasks[0]!;
  assert.equal(task.taskId, "mab-smoke-ar-q1");
  assert.match(task.actual, /drain failed before scoring/);
  assert.equal(task.scores.f1, -1);
  assert.equal(task.details.drainFailed, true);
  assert.equal(task.details.error, "memoryagentbench drain failed before scoring: drain backend unavailable");
});

test("MemoryAgentBench trialLimit null is treated as unlimited", async () => {
  const result = await runMemoryAgentBenchBenchmark({
    benchmark: memoryAgentBenchDefinition,
    mode: "quick",
    benchmarkOptions: { trialLimit: null },
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
      responder: {
        async respond() {
          return {
            text: "unknown",
            tokens: { input: 1, output: 1 },
            latencyMs: 1,
            model: "mab-test-responder",
          };
        },
      },
      judge: {
        async score() {
          return 0;
        },
        async scoreWithMetrics() {
          return {
            score: 0,
            tokens: { input: 0, output: 0 },
            latencyMs: 0,
            model: "mab-test-judge",
          };
        },
      },
    },
  });

  assert.deepEqual(
    result.results.tasks.map((task) => task.taskId),
    [
      "mab-smoke-ar-q1",
      "mab-smoke-ttl-q1",
      "mab-smoke-lru-q1",
      "mab-smoke-cr-q1",
    ],
  );
});

test("MemoryAgentBench trialLimit 0 runs zero scored questions", async () => {
  let resetCalled = false;

  const result = await runMemoryAgentBenchBenchmark({
    benchmark: memoryAgentBenchDefinition,
    mode: "quick",
    benchmarkOptions: { trialLimit: 0 },
    system: {
      async reset() {
        resetCalled = true;
      },
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
      responder: {
        async respond() {
          return {
            text: "",
            tokens: { input: 0, output: 0 },
            latencyMs: 0,
            model: "mab-test-responder",
          };
        },
      },
      judge: {
        async score() {
          return 0;
        },
        async scoreWithMetrics() {
          return {
            score: 0,
            tokens: { input: 0, output: 0 },
            latencyMs: 0,
            model: "mab-test-judge",
          };
        },
      },
    },
  });

  assert.equal(result.results.tasks.length, 0);
  assert.equal(resetCalled, false);
});
