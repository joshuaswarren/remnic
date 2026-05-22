import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { personaMemDefinition, runPersonaMemBenchmark } from "./runner.ts";

test("PersonaMem normalizes tea category nouns when recall supports the phrase", async () => {
  const result = await runPersonaMemBenchmark({
    benchmark: personaMemDefinition,
    mode: "quick",
    limit: 1,
    system: {
      async reset() {},
      async store() {},
      async recall() {
        return "I like to journal every morning with a mug of Earl Grey tea.";
      },
      async search() {
        return [
          {
            turnIndex: 1,
            role: "user",
            snippet: "Earl Grey tea",
            sessionId: "personamem-personamem-smoke-1",
          },
        ];
      },
      async destroy() {},
      async getStats() {
        return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
      },
      responder: {
        async respond() {
          return {
            text: "Earl Grey tea.",
            tokens: { input: 1, output: 1 },
            latencyMs: 1,
            model: "personamem-test-responder",
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
            model: "personamem-test-judge",
          };
        },
      },
    },
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.actual, "Earl Grey");
  assert.equal(task.scores.f1, 1);
  assert.equal(task.details.originalAnsweredText, "Earl Grey tea.");
});

test("PersonaMem scores MCQ letters against option text for semantic metrics", async () => {
  const result = await runPersonaMemBenchmark({
    benchmark: personaMemDefinition,
    mode: "quick",
    limit: 2,
    system: {
      async reset() {},
      async store() {},
      async recall() {
        return "On Sunday evenings I usually cook pasta with soft jazz piano playing in the background.";
      },
      async search() {
        return [
          {
            turnIndex: 1,
            role: "user",
            snippet: "jazz piano",
            sessionId: "personamem-personamem-smoke-1",
          },
        ];
      },
      async destroy() {},
      async getStats() {
        return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
      },
      responder: {
        async respond(question) {
          const option = question.match(/^([A-D])\. jazz piano$/m)?.[1] ?? "A";
          return {
            text: option,
            tokens: { input: 1, output: 1 },
            latencyMs: 1,
            model: "personamem-test-responder",
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
            model: "personamem-test-judge",
          };
        },
      },
    },
  });

  const task = result.results.tasks[1]!;
  assert.equal(task.expected, "jazz piano");
  assert.match(task.actual, /^[A-D]$/);
  assert.equal(task.details.scoredAnswer, "jazz piano");
  assert.equal(task.scores.mcq_accuracy, 1);
  assert.equal(task.scores.f1, 1);
  assert.equal(task.scores.contains_answer, 1);
  assert.equal(task.scores.llm_judge, 1);
});

test("PersonaMem scores MCQ option text answers as the matching option", async () => {
  const result = await runPersonaMemBenchmark({
    benchmark: personaMemDefinition,
    mode: "quick",
    limit: 2,
    system: {
      async reset() {},
      async store() {},
      async recall() {
        return "On Sunday evenings I usually cook pasta with soft jazz piano playing in the background.";
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
            text: "Final Answer: jazz piano",
            tokens: { input: 1, output: 1 },
            latencyMs: 1,
            model: "personamem-test-responder",
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
            model: "personamem-test-judge",
          };
        },
      },
    },
  });

  const task = result.results.tasks[1]!;
  assert.equal(task.expected, "jazz piano");
  assert.equal(task.actual, "Final Answer: jazz piano");
  assert.equal(task.details.scoredAnswer, "jazz piano");
  assert.equal(task.scores.mcq_accuracy, 1);
  assert.equal(task.scores.llm_judge, 1);
});

test("PersonaMem records drain failure before scoring calls", async () => {
  let recallCalls = 0;
  let responderCalls = 0;
  let judgeCalls = 0;

  const result = await runPersonaMemBenchmark({
    benchmark: personaMemDefinition,
    mode: "quick",
    limit: 1,
    system: {
      async reset() {},
      async store() {},
      async drain() {
        throw new Error("drain unavailable");
      },
      async recall() {
        recallCalls += 1;
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
          responderCalls += 1;
          return {
            text: "",
            tokens: { input: 0, output: 0 },
            latencyMs: 0,
            model: "personamem-test-responder",
          };
        },
      },
      judge: {
        async score() {
          judgeCalls += 1;
          return 0;
        },
        async scoreWithMetrics() {
          judgeCalls += 1;
          return {
            score: 0,
            tokens: { input: 0, output: 0 },
            latencyMs: 0,
            model: "personamem-test-judge",
          };
        },
      },
    },
  });

  const task = result.results.tasks[0]!;
  assert.match(String(task.details.error), /personamem drain failed.*drain unavailable/);
  assert.equal(recallCalls, 0);
  assert.equal(responderCalls, 0);
  assert.equal(judgeCalls, 0);
});

test("PersonaMem failed MCQ tasks include mcq_accuracy in aggregates", async () => {
  let drainCalls = 0;
  let recallCalls = 0;
  let responderCalls = 0;
  let judgeCalls = 0;

  const result = await runPersonaMemBenchmark({
    benchmark: personaMemDefinition,
    mode: "quick",
    limit: 2,
    system: {
      async reset() {},
      async store() {},
      async drain() {
        drainCalls += 1;
        if (drainCalls === 2) {
          throw new Error("drain unavailable for mcq");
        }
      },
      async recall() {
        recallCalls += 1;
        return "I like to journal every morning with a mug of Earl Grey tea.";
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
            text: "Earl Grey tea.",
            tokens: { input: 1, output: 1 },
            latencyMs: 1,
            model: "personamem-test-responder",
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
            model: "personamem-test-judge",
          };
        },
      },
    },
  });

  assert.equal(recallCalls, 1);
  assert.equal(responderCalls, 1);
  assert.equal(judgeCalls, 1);

  const failedMcqTask = result.results.tasks[1]!;
  assert.equal(failedMcqTask.scores.mcq_accuracy, -1);
  assert.equal(result.results.aggregates.mcq_accuracy?.mean, -1);
});

test("PersonaMem rejects malformed primary dataset candidate instead of falling back", async () => {
  const datasetDir = await mkdtemp(path.join(tmpdir(), "remnic-personamem-"));
  let storeCalls = 0;

  try {
    await mkdir(path.join(datasetDir, "benchmark", "text"), { recursive: true });
    await writeFile(
      path.join(datasetDir, "benchmark", "text", "benchmark.csv"),
      "persona_id,chat_history_32k_link,user_query\np1,history.json,question\n",
      "utf8",
    );
    await writeFile(
      path.join(datasetDir, "benchmark.csv"),
      [
        "persona_id,chat_history_32k_link,user_query,correct_answer",
        "p2,history.json,question,answer",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(datasetDir, "history.json"),
      JSON.stringify({ chat_history: [] }),
      "utf8",
    );

    await assert.rejects(
      runPersonaMemBenchmark({
        benchmark: personaMemDefinition,
        mode: "full",
        datasetDir,
        system: {
          async reset() {},
          async store() {
            storeCalls += 1;
          },
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
            async scoreWithMetrics() {
              return {
                score: 0,
                tokens: { input: 0, output: 0 },
                latencyMs: 0,
                model: "personamem-test-judge",
              };
            },
          },
        },
      }),
      /benchmark\/text\/benchmark\.csv.*missing required column "correct_answer"/,
    );
  } finally {
    await rm(datasetDir, { recursive: true, force: true });
  }

  assert.equal(storeCalls, 0);
});
