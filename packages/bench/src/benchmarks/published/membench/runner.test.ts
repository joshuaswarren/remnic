import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { memBenchDefinition, runMemBenchBenchmark } from "./runner.ts";

test("MemBench open-ended official accuracy tolerates terminal answer punctuation", async () => {
  const result = await runMemBenchBenchmark({
    benchmark: memBenchDefinition,
    mode: "quick",
    limit: 1,
    system: {
      async reset() {},
      async store() {},
      async recall() {
        return "I moved to Lisbon last spring to work from the waterfront.";
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
            text: "Lisbon.",
            tokens: { input: 1, output: 1 },
            latencyMs: 1,
            model: "membench-test-responder",
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
            model: "membench-test-judge",
          };
        },
      },
    },
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.actual, "Lisbon.");
  assert.equal(task.scores.membench_accuracy, 1);
  assert.equal(
    result.results.aggregates.membench_accuracy_factual_participant?.mean,
    1,
  );
});

test("MemBench adds recommendation cues without exposing them to answer context", async () => {
  const datasetDir = await mkdtemp(path.join(tmpdir(), "remnic-membench-rec-"));
  const storedMessages: string[] = [];
  const recallQueries: string[] = [];

  try {
    await writeFile(
      path.join(datasetDir, "membench.json"),
      JSON.stringify([
        {
          id: "recommendation-1",
          memoryType: "factual",
          scenario: "participant",
          level: "surface",
          turns: [
            {
              role: "user",
              content:
                "For late-night coding, I recommended hojicha because it is mellow.",
            },
            {
              role: "assistant",
              content: "Hojicha for late-night coding, noted.",
            },
          ],
          question: "What tea recommendation should I use for late-night coding?",
          answer: "hojicha",
        },
      ]),
      "utf8",
    );

    const result = await runMemBenchBenchmark({
      benchmark: memBenchDefinition,
      mode: "full",
      datasetDir,
      system: {
        async reset() {
          storedMessages.length = 0;
        },
        async store(_sessionId, messages) {
          storedMessages.push(...messages.map((message) => message.content));
        },
        async recall(_sessionId, query) {
          recallQueries.push(query);
          return storedMessages.join("\n\n");
        },
        async search() {
          return [];
        },
        async destroy() {},
        async getStats() {
          return { totalMessages: storedMessages.length, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond(question, context) {
            assert.match(question, /Return only the exact recommended item/);
            assert.match(context, /hojicha/);
            assert.doesNotMatch(context, /MemBench semantic cues/);
            return {
              text: "hojicha",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "membench-test-responder",
            };
          },
        },
        judge: {
          async score() {
            return 1;
          },
          async scoreWithMetrics(_question, predicted, expected) {
            return {
              score: predicted === expected ? 1 : 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "membench-test-judge",
            };
          },
        },
      },
    });

    const task = result.results.tasks[0]!;
    assert.match(storedMessages.join("\n"), /MemBench semantic cues:/);
    assert.match(recallQueries[0] ?? "", /exact recommendation/);
    assert.equal(task.scores.membench_accuracy, 1);
    assert.equal(task.scores.f1, 1);
    assert.equal(task.details.predictedAnswer, "hojicha");
  } finally {
    await rm(datasetDir, { recursive: true, force: true });
  }
});

test("MemBench normalizes upstream JSONL trajectory QA records", async () => {
  const datasetDir = await mkdtemp(path.join(tmpdir(), "remnic-membench-jsonl-"));
  const storedMessages: string[] = [];

  try {
    await writeFile(
      path.join(datasetDir, "FirstAgentDataLowLevel.jsonl"),
      `${JSON.stringify({
        trajectory: ["I moved to Lisbon."],
        qa: [
          {
            question: "Where did I move?",
            answer: "Lisbon",
          },
        ],
      })}\n`,
      "utf8",
    );

    const result = await runMemBenchBenchmark({
      benchmark: memBenchDefinition,
      mode: "full",
      datasetDir,
      system: {
        async reset() {
          storedMessages.length = 0;
        },
        async store(_sessionId, messages) {
          storedMessages.push(...messages.map((message) => message.content));
        },
        async recall() {
          return storedMessages.join("\n\n");
        },
        async search() {
          return [];
        },
        async destroy() {},
        async getStats() {
          return { totalMessages: storedMessages.length, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond() {
            return {
              text: "Lisbon",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "membench-test-responder",
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
              model: "membench-test-judge",
            };
          },
        },
      },
    });

    assert.equal(result.results.tasks.length, 1);
    const task = result.results.tasks[0]!;
    assert.equal(task.question, "Where did I move?");
    assert.equal(task.expected, "Lisbon");
    assert.equal(task.details.memoryType, "factual");
    assert.equal(task.details.scenario, "participant");
    assert.equal(task.details.level, "low_level");
    assert.match(storedMessages.join("\n"), /I moved to Lisbon/);
    assert.equal(task.scores.membench_accuracy, 1);
  } finally {
    await rm(datasetDir, { recursive: true, force: true });
  }
});

test("MemBench scores direct multiple-choice recall without a responder", async () => {
  const datasetDir = await mkdtemp(path.join(tmpdir(), "remnic-membench-choice-direct-"));

  try {
    await writeFile(
      path.join(datasetDir, "membench.json"),
      JSON.stringify([
        {
          id: "choice-direct-1",
          memoryType: "factual",
          scenario: "participant",
          level: "surface",
          turns: [
            {
              role: "user",
              content: "I keep the launch checklist in the blue folder.",
            },
          ],
          question: "Where is the launch checklist?",
          choices: {
            A: "blue folder",
            B: "red folder",
            C: "green binder",
            D: "archive box",
          },
          correctChoice: "A",
        },
      ]),
      "utf8",
    );

    const result = await runMemBenchBenchmark({
      benchmark: memBenchDefinition,
      mode: "full",
      datasetDir,
      system: {
        async reset() {},
        async store() {},
        async recall() {
          return "A";
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
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "membench-test-judge",
            };
          },
        },
      },
    });

    const task = result.results.tasks[0]!;
    assert.equal(task.actual, "A");
    assert.equal(task.details.predictedChoice, "A");
    assert.equal(task.details.predictedAnswer, "blue folder");
    assert.equal(task.scores.membench_accuracy, 1);
  } finally {
    await rm(datasetDir, { recursive: true, force: true });
  }
});

test("MemBench matches multiple-choice option text without treating prose articles as choices", async () => {
  const datasetDir = await mkdtemp(path.join(tmpdir(), "remnic-membench-choice-prose-"));

  try {
    await writeFile(
      path.join(datasetDir, "membench.json"),
      JSON.stringify([
        {
          id: "choice-prose-1",
          memoryType: "factual",
          scenario: "participant",
          level: "surface",
          turns: [
            {
              role: "user",
              content: "I keep the launch checklist in the blue folder.",
            },
          ],
          question: "Where is the launch checklist?",
          choices: {
            A: "red folder",
            B: "blue folder",
            C: "green binder",
            D: "archive box",
          },
          correctChoice: "B",
        },
      ]),
      "utf8",
    );

    const result = await runMemBenchBenchmark({
      benchmark: memBenchDefinition,
      mode: "full",
      datasetDir,
      system: {
        async reset() {},
        async store() {},
        async recall() {
          return "It is a blue folder.";
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
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "membench-test-judge",
            };
          },
        },
      },
    });

    const task = result.results.tasks[0]!;
    assert.equal(task.actual, "B");
    assert.equal(task.details.predictedChoice, "B");
    assert.equal(task.details.predictedAnswer, "blue folder");
    assert.equal(task.scores.membench_accuracy, 1);
  } finally {
    await rm(datasetDir, { recursive: true, force: true });
  }
});

test("MemBench records a task failure when ingestion drain fails before scoring", async () => {
  let completedTasks = 0;
  let recallCalls = 0;
  let responderCalls = 0;
  let judgeCalls = 0;

  const result = await runMemBenchBenchmark({
    benchmark: memBenchDefinition,
    mode: "quick",
    limit: 1,
    onTaskComplete() {
      completedTasks += 1;
    },
    system: {
      async reset() {},
      async store() {},
      async drain() {
        throw new Error("drain timed out");
      },
      async recall() {
        recallCalls += 1;
        return "Lisbon";
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
          responderCalls += 1;
          return {
            text: "Lisbon",
            tokens: { input: 1, output: 1 },
            latencyMs: 1,
            model: "membench-test-responder",
          };
        },
      },
      judge: {
        async score() {
          judgeCalls += 1;
          return 1;
        },
        async scoreWithMetrics() {
          judgeCalls += 1;
          return {
            score: 1,
            tokens: { input: 0, output: 0 },
            latencyMs: 0,
            model: "membench-test-judge",
          };
        },
      },
    },
  });

  assert.equal(completedTasks, 1);
  assert.equal(recallCalls, 0);
  assert.equal(responderCalls, 0);
  assert.equal(judgeCalls, 0);

  const task = result.results.tasks[0]!;
  assert.match(task.actual, /MemBench drain failed for factual-participant-1/);
  assert.deepEqual(task.scores, {
    f1: -1,
    contains_answer: -1,
    llm_judge: -1,
    membench_accuracy: -1,
  });
  assert.equal(task.details?.error, "MemBench drain failed for factual-participant-1: drain timed out");
});
