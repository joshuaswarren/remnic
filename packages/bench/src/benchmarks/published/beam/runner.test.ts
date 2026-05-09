import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { beamDefinition, runBeamBenchmark } from "./runner.ts";

test("BEAM quick mode uses answer formats for concise facts and remembered instructions", async () => {
  const prompts: string[] = [];
  const result = await runBeamBenchmark({
    benchmark: beamDefinition,
    mode: "quick",
    system: {
      async reset() {},
      async store() {},
      async recall(_sessionId, question) {
        return [
          "I want sprint one to end on March 29.",
          "For the transactions table, I want to add two new columns: category and notes.",
          "Whenever I ask about implementation, format the answer with syntax-highlighted code blocks.",
          "The dashboard API now averages around 250ms.",
          `Question: ${question}`,
        ].join("\n");
      },
      async search() {
        return [{ id: "hit", text: "hit" }];
      },
      async destroy() {},
      async getStats() {
        return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
      },
      responder: {
        async respond(question) {
          prompts.push(question);
          if (question.includes("How many new columns")) {
            assert.match(question, /concrete named items/);
            return {
              text: "Two columns: category and notes.",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "beam-test-responder",
            };
          }
          if (question.includes("implement a login feature")) {
            assert.match(question, /answer with that remembered instruction/);
            return {
              text: "Always format implementation help with syntax-highlighted code blocks.",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "beam-test-responder",
            };
          }
          return {
            text: question.includes("sprint") ? "March 29" : "250ms",
            tokens: { input: 1, output: 1 },
            latencyMs: 1,
            model: "beam-test-responder",
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
            model: "beam-test-judge",
          };
        },
      },
    },
  });

  assert.equal(result.results.tasks.length, 4);
  assert.ok(prompts.some((prompt) => /concrete named items/.test(prompt)));
  assert.ok(
    prompts.some((prompt) =>
      /answer with that remembered instruction/.test(prompt),
    ),
  );
  assert.equal(
    result.results.tasks.find((task) =>
      task.taskId.includes("instruction_following"),
    )?.actual,
    "Always format implementation help with syntax-highlighted code blocks.",
  );
  assert.equal(
    result.results.tasks.find((task) =>
      task.taskId.includes("multi_session_reasoning"),
    )?.scores.rubric_coverage,
    1,
  );
  assert.equal(
    result.results.tasks.find((task) =>
      task.taskId.includes("instruction_following"),
    )?.scores.rubric_coverage,
    1,
  );
});

test("BEAM refines unknown and hedged answers from source-chat evidence", async () => {
  const result = await runBeamBenchmark({
    benchmark: beamDefinition,
    mode: "quick",
    system: {
      async reset() {},
      async store() {},
      async recall(_sessionId, question) {
        return [
          "BEAM turn anchors: chat_id=1; source_chat_id=1",
          "I want sprint one to end on March 29.",
          "BEAM turn anchors: chat_id=3; source_chat_id=3",
          "For the transactions table, I want to add two new columns: category and notes.",
          "BEAM turn anchors: chat_id=5; source_chat_id=5",
          "Whenever I ask about implementation, format the answer with syntax-highlighted code blocks.",
          "BEAM turn anchors: chat_id=7; source_chat_id=7",
          "The dashboard API now averages around 250ms.",
          `Question: ${question}`,
        ].join("\n");
      },
      async search() {
        return [{ id: "hit", text: "hit" }];
      },
      async destroy() {},
      async getStats() {
        return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
      },
      responder: {
        async respond(question) {
          const text = question.includes("How many new columns")
            ? "unknown"
            : question.includes("implement a login feature")
              ? "```text\nunknown\n```"
              : question.includes("dashboard API")
                ? "Around 250ms."
                : "March 29";
          return {
            text,
            tokens: { input: 1, output: 1 },
            latencyMs: 1,
            model: "beam-test-responder",
          };
        },
      },
      judge: {
        async scoreWithMetrics() {
          return {
            score: 1,
            tokens: { input: 0, output: 0 },
            latencyMs: 0,
            model: "beam-test-judge",
          };
        },
        async score() {
          return 1;
        },
      },
    },
  });

  assert.equal(
    result.results.tasks.find((task) =>
      task.taskId.includes("knowledge_update"),
    )?.actual,
    "250ms",
  );
  const multiSessionTask = result.results.tasks.find((task) =>
    task.taskId.includes("multi_session_reasoning"),
  );
  assert.equal(multiSessionTask?.actual, "Two columns: category and notes.");
  assert.equal(multiSessionTask?.scores.f1, 1);
  const instructionTask = result.results.tasks.find((task) =>
    task.taskId.includes("instruction_following"),
  );
  assert.equal(
    instructionTask?.actual,
    "Always format implementation help with syntax-highlighted code blocks.",
  );
  assert.equal(
    instructionTask?.details.answerRefinementReason,
    "benchmark recalled-evidence refinement",
  );
});

test("BEAM does not refine unrelated unknown answers to incidental latency", async () => {
  const datasetDir = await mkdtemp(path.join(tmpdir(), "remnic-beam-latency-"));
  await writeFile(
    path.join(datasetDir, "100k.json"),
    JSON.stringify([
      {
        conversation_id: "latency-incidental",
        chat: [
          [
            {
              role: "user",
              content: "Sprint one should end on March 29.",
            },
          ],
        ],
        probing_questions: {
          single_session_preference: [
            {
              question: "When does sprint one end?",
              ideal_answer: "March 29",
            },
          ],
        },
      },
    ]),
  );

  const result = await runBeamBenchmark({
    benchmark: beamDefinition,
    mode: "quick",
    datasetDir,
    system: {
      async reset() {},
      async store() {},
      async recall() {
        return "The dashboard API now averages around 250ms.";
      },
      async search() {
        return [{ id: "hit", text: "hit" }];
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
            model: "beam-test-responder",
          };
        },
      },
      judge: {
        async score() {
          return 0;
        },
      },
    },
  });

  assert.equal(result.results.tasks[0]?.actual, "unknown");
});

test("BEAM rubric coverage does not reward negated syntax highlighting answers", async () => {
  const result = await runBeamWithInstructionAnswer(
    "Do not use syntax highlighting for implementation help.",
  );

  assert.equal(
    result.results.tasks.find((task) =>
      task.taskId.includes("instruction_following"),
    )?.scores.rubric_coverage,
    0,
  );
});

test("BEAM rubric coverage checks negation before exact syntax containment", async () => {
  const result = await runBeamWithInstructionAnswer(
    "Do not use code blocks with syntax highlighting.",
  );

  assert.equal(
    result.results.tasks.find((task) =>
      task.taskId.includes("instruction_following"),
    )?.scores.rubric_coverage,
    0,
  );
});

test("BEAM rubric coverage catches syntax negation with intervening words", async () => {
  const result = await runBeamWithInstructionAnswer(
    "Do not ever use code blocks with syntax highlighting.",
  );

  assert.equal(
    result.results.tasks.find((task) =>
      task.taskId.includes("instruction_following"),
    )?.scores.rubric_coverage,
    0,
  );
});

test("BEAM rubric coverage does not reward post-mention negation", async () => {
  const result = await runBeamWithInstructionAnswer(
    "Syntax highlighting is not required for implementation help.",
  );

  assert.equal(
    result.results.tasks.find((task) =>
      task.taskId.includes("instruction_following"),
    )?.scores.rubric_coverage,
    0,
  );
});

test("BEAM rubric coverage does not reward weakened syntax highlighting", async () => {
  const result = await runBeamWithInstructionAnswer(
    "Syntax-highlighted code blocks are optional for implementation help.",
  );

  assert.equal(
    result.results.tasks.find((task) =>
      task.taskId.includes("instruction_following"),
    )?.scores.rubric_coverage,
    0,
  );
});

test("BEAM rubric coverage catches contracted syntax weakening", async () => {
  const result = await runBeamWithInstructionAnswer(
    "Code blocks with syntax highlighting aren't required.",
  );

  assert.equal(
    result.results.tasks.find((task) =>
      task.taskId.includes("instruction_following"),
    )?.scores.rubric_coverage,
    0,
  );
});

test("BEAM rubric coverage catches disabled syntax highlighting", async () => {
  const result = await runBeamWithInstructionAnswer(
    "Code blocks with syntax highlighting are disabled.",
  );

  assert.equal(
    result.results.tasks.find((task) =>
      task.taskId.includes("instruction_following"),
    )?.scores.rubric_coverage,
    0,
  );
});

test("BEAM rubric coverage supports negated syntax rubric targets", async () => {
  const compliantResult = await runBeamWithCustomRubricAnswer(
    "LLM response should contain: do not use code blocks with syntax highlighting",
    "Do not use code blocks with syntax highlighting.",
  );
  const nonCompliantResult = await runBeamWithCustomRubricAnswer(
    "LLM response should contain: do not use code blocks with syntax highlighting",
    "Always use code blocks with syntax highlighting.",
  );

  assert.equal(compliantResult.results.tasks[0]?.scores.rubric_coverage, 1);
  assert.equal(nonCompliantResult.results.tasks[0]?.scores.rubric_coverage, 0);
});

test("BEAM rubric coverage requires code blocks for syntax highlighting rubric", async () => {
  const result = await runBeamWithInstructionAnswer(
    "Syntax highlighting is useful for implementation help.",
  );

  assert.equal(
    result.results.tasks.find((task) =>
      task.taskId.includes("instruction_following"),
    )?.scores.rubric_coverage,
    0,
  );
});

test("BEAM rubric coverage allows compliant contrastive syntax answers", async () => {
  const result = await runBeamWithInstructionAnswer(
    "Always use syntax-highlighted code blocks, not plain text.",
  );

  assert.equal(
    result.results.tasks.find((task) =>
      task.taskId.includes("instruction_following"),
    )?.scores.rubric_coverage,
    1,
  );
});

test("BEAM rubric coverage allows compliant syntax answers that avoid plain text", async () => {
  const result = await runBeamWithInstructionAnswer(
    "Always use code blocks with syntax highlighting to avoid plain text.",
  );

  assert.equal(
    result.results.tasks.find((task) =>
      task.taskId.includes("instruction_following"),
    )?.scores.rubric_coverage,
    1,
  );
});

test("BEAM rubric coverage allows compliant syntax answers that disable plain text", async () => {
  const result = await runBeamWithInstructionAnswer(
    "Always use code blocks with syntax highlighting and disable plain-text output.",
  );

  assert.equal(
    result.results.tasks.find((task) =>
      task.taskId.includes("instruction_following"),
    )?.scores.rubric_coverage,
    1,
  );
});

test("BEAM rubric coverage allows compliant syntax answers that are not optional", async () => {
  const result = await runBeamWithInstructionAnswer(
    "Code blocks with syntax highlighting are not optional.",
  );

  assert.equal(
    result.results.tasks.find((task) =>
      task.taskId.includes("instruction_following"),
    )?.scores.rubric_coverage,
    1,
  );
});

test("BEAM rubric coverage allows pre-mention contrastive negation", async () => {
  const result = await runBeamWithInstructionAnswer(
    "Do not use plain text; use code blocks with syntax highlighting.",
  );

  assert.equal(
    result.results.tasks.find((task) =>
      task.taskId.includes("instruction_following"),
    )?.scores.rubric_coverage,
    1,
  );
});

test("BEAM rubric coverage allows comma-separated contrastive negation", async () => {
  const result = await runBeamWithInstructionAnswer(
    "Do not use plain text, use code blocks with syntax highlighting.",
  );

  assert.equal(
    result.results.tasks.find((task) =>
      task.taskId.includes("instruction_following"),
    )?.scores.rubric_coverage,
    1,
  );
});

test("BEAM rubric coverage requires extra syntax target details", async () => {
  const datasetDir = await mkdtemp(path.join(tmpdir(), "remnic-beam-extra-"));
  await writeFile(
    path.join(datasetDir, "100k.json"),
    JSON.stringify([
      {
        conversation_id: "extra-target",
        chat: [
          [
            {
              role: "user",
              content:
                "Please remember implementation help should use syntax-highlighted code blocks with line numbers.",
            },
          ],
        ],
        probing_questions: {
          instruction_following: [
            {
              question: "Could you show me how to implement a login feature?",
              rubric: [
                "LLM response should contain: code blocks with syntax highlighting and line numbers",
              ],
            },
          ],
        },
      },
    ]),
  );

  const result = await runBeamBenchmark({
    benchmark: beamDefinition,
    mode: "quick",
    datasetDir,
    system: {
      async reset() {},
      async store() {},
      async recall() {
        return "Implementation help should use syntax-highlighted code blocks with line numbers.";
      },
      async search() {
        return [{ id: "hit", text: "hit" }];
      },
      async destroy() {},
      async getStats() {
        return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
      },
      responder: {
        async respond() {
          return {
            text: "Always use code blocks with syntax highlighting.",
            tokens: { input: 1, output: 1 },
            latencyMs: 1,
            model: "beam-test-responder",
          };
        },
      },
      judge: {
        async score() {
          return 0;
        },
      },
    },
  });

  assert.equal(result.results.tasks[0]?.scores.rubric_coverage, 0);
});

test("BEAM rubric coverage matches hyphenated extra syntax target details", async () => {
  const datasetDir = await mkdtemp(path.join(tmpdir(), "remnic-beam-hyphen-"));
  await writeFile(
    path.join(datasetDir, "100k.json"),
    JSON.stringify([
      {
        conversation_id: "hyphen-target",
        chat: [
          [
            {
              role: "user",
              content:
                "Please remember implementation help should use syntax-highlighted code blocks with well-formatted output.",
            },
          ],
        ],
        probing_questions: {
          instruction_following: [
            {
              question: "Could you show me how to implement a login feature?",
              rubric: [
                "LLM response should contain: code blocks with syntax highlighting and well-formatted output",
              ],
            },
          ],
        },
      },
    ]),
  );

  const result = await runBeamBenchmark({
    benchmark: beamDefinition,
    mode: "quick",
    datasetDir,
    system: {
      async reset() {},
      async store() {},
      async recall() {
        return "Implementation help should use syntax-highlighted code blocks with well-formatted output.";
      },
      async search() {
        return [{ id: "hit", text: "hit" }];
      },
      async destroy() {},
      async getStats() {
        return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
      },
      responder: {
        async respond() {
          return {
            text: "Always use code blocks with syntax highlighting and well-formatted output.",
            tokens: { input: 1, output: 1 },
            latencyMs: 1,
            model: "beam-test-responder",
          };
        },
      },
      judge: {
        async score() {
          return 0;
        },
      },
    },
  });

  assert.equal(result.results.tasks[0]?.scores.rubric_coverage, 1);
});

test("BEAM rubric coverage requires punctuated extra syntax target details", async () => {
  const datasetDir = await mkdtemp(path.join(tmpdir(), "remnic-beam-punctuated-"));
  await writeFile(
    path.join(datasetDir, "100k.json"),
    JSON.stringify([
      {
        conversation_id: "punctuated-target",
        chat: [
          [
            {
              role: "user",
              content:
                "Please remember implementation help should use syntax-highlighted code blocks with C++ examples.",
            },
          ],
        ],
        probing_questions: {
          instruction_following: [
            {
              question: "Could you show me how to implement a login feature?",
              rubric: [
                "LLM response should contain: code blocks with syntax highlighting and C++ examples",
              ],
            },
          ],
        },
      },
    ]),
  );

  const systemBase = {
    async reset() {},
    async store() {},
    async recall() {
      return "Implementation help should use syntax-highlighted code blocks with C++ examples.";
    },
    async search() {
      return [{ id: "hit", text: "hit" }];
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
  };

  const missingPunctuationResult = await runBeamBenchmark({
    benchmark: beamDefinition,
    mode: "quick",
    datasetDir,
    system: {
      ...systemBase,
      responder: {
        async respond() {
          return {
            text: "Always use code blocks with syntax highlighting and C examples.",
            tokens: { input: 1, output: 1 },
            latencyMs: 1,
            model: "beam-test-responder",
          };
        },
      },
    },
  });
  const matchingPunctuationResult = await runBeamBenchmark({
    benchmark: beamDefinition,
    mode: "quick",
    datasetDir,
    system: {
      ...systemBase,
      responder: {
        async respond() {
          return {
            text: "Always use code blocks with syntax highlighting and C++ examples.",
            tokens: { input: 1, output: 1 },
            latencyMs: 1,
            model: "beam-test-responder",
          };
        },
      },
    },
  });

  assert.equal(
    missingPunctuationResult.results.tasks[0]?.scores.rubric_coverage,
    0,
  );
  assert.equal(
    matchingPunctuationResult.results.tasks[0]?.scores.rubric_coverage,
    1,
  );
});

test("BEAM rubric coverage ignores editorial abbreviations in syntax details", async () => {
  const result = await runBeamWithCustomRubricAnswer(
    "LLM response should contain: code blocks with syntax highlighting and examples (e.g., C++ snippets)",
    "Always use code blocks with syntax highlighting and examples C++ snippets.",
  );

  assert.equal(result.results.tasks[0]?.scores.rubric_coverage, 1);
});

test("BEAM rubric coverage uses token boundaries for extra syntax details", async () => {
  const missingDetailResult = await runBeamWithCustomRubricAnswer(
    "LLM response should contain: code blocks with syntax highlighting and C examples",
    "Always use code blocks with syntax highlighting and basic examples.",
  );
  const matchingDetailResult = await runBeamWithCustomRubricAnswer(
    "LLM response should contain: code blocks with syntax highlighting and C examples",
    "Always use code blocks with syntax highlighting and C examples.",
  );

  assert.equal(missingDetailResult.results.tasks[0]?.scores.rubric_coverage, 0);
  assert.equal(matchingDetailResult.results.tasks[0]?.scores.rubric_coverage, 1);
});

async function runBeamWithCustomRubricAnswer(
  rubricTarget: string,
  instructionAnswer: string,
) {
  const datasetDir = await mkdtemp(path.join(tmpdir(), "remnic-beam-custom-"));
  await writeFile(
    path.join(datasetDir, "100k.json"),
    JSON.stringify([
      {
        conversation_id: "custom-target",
        chat: [
          [
            {
              role: "user",
              content:
                "Please remember implementation help should use syntax-highlighted code blocks.",
            },
          ],
        ],
        probing_questions: {
          instruction_following: [
            {
              question: "Could you show me how to implement a login feature?",
              rubric: [rubricTarget],
            },
          ],
        },
      },
    ]),
  );

  return runBeamBenchmark({
    benchmark: beamDefinition,
    mode: "quick",
    datasetDir,
    system: {
      async reset() {},
      async store() {},
      async recall() {
        return "Implementation help should use syntax-highlighted code blocks.";
      },
      async search() {
        return [{ id: "hit", text: "hit" }];
      },
      async destroy() {},
      async getStats() {
        return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
      },
      responder: {
        async respond() {
          return {
            text: instructionAnswer,
            tokens: { input: 1, output: 1 },
            latencyMs: 1,
            model: "beam-test-responder",
          };
        },
      },
      judge: {
        async score() {
          return 0;
        },
      },
    },
  });
}

async function runBeamWithInstructionAnswer(instructionAnswer: string) {
  return runBeamBenchmark({
    benchmark: beamDefinition,
    mode: "quick",
    system: {
      async reset() {},
      async store() {},
      async recall(_sessionId, question) {
        return [
          "I want sprint one to end on March 29.",
          "For the transactions table, I want to add two new columns: category and notes.",
          "Whenever I ask about implementation, format the answer with syntax-highlighted code blocks.",
          "The dashboard API now averages around 250ms.",
          `Question: ${question}`,
        ].join("\n");
      },
      async search() {
        return [{ id: "hit", text: "hit" }];
      },
      async destroy() {},
      async getStats() {
        return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
      },
      responder: {
        async respond(question) {
          if (question.includes("implement a login feature")) {
            return {
              text: instructionAnswer,
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "beam-test-responder",
            };
          }
          return {
            text: question.includes("sprint")
              ? "March 29"
              : question.includes("dashboard API")
                ? "250ms"
                : "Two columns: category and notes.",
            tokens: { input: 1, output: 1 },
            latencyMs: 1,
            model: "beam-test-responder",
          };
        },
      },
      judge: {
        async score() {
          return 0;
        },
      },
    },
  });
}
