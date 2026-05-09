import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { Message } from "../../../adapters/types.js";
import { locomoDefinition, runLoCoMoBenchmark } from "./runner.ts";

test("LoCoMo normalizes numeric answers and adversarial-answer fallbacks from the official dataset", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-locomo-"));
  const datasetPath = path.join(tempDir, "locomo10.json");
  const storedMessages: Message[] = [];
  const respondentQuestions: string[] = [];
  const respondentContexts: string[] = [];

  try {
    await writeFile(
      datasetPath,
      JSON.stringify([
        {
          sample_id: "locomo-normalized-1",
          conversation: {
            speaker_a: "Maya",
            speaker_b: "Assistant",
            session_1: [
              { speaker: "Maya", dia_id: "D1:1", text: "I moved in 2022." },
              {
                speaker: "Maya",
                dia_id: "D1:2",
                text: "The jacket was blue.",
              },
            ],
          },
          qa: [
            {
              question: "According to D1:1, what year did Maya move?",
              answer: 2022,
              evidence: ["D1:1"],
              category: 1,
            },
            {
              question: "What color was the jacket?",
              adversarial_answer: "blue",
              evidence: ["D1:2"],
              category: 5,
            },
          ],
        },
      ]),
      "utf8",
    );

    const result = await runLoCoMoBenchmark({
      benchmark: locomoDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store(_sessionId, messages) {
          storedMessages.push(...messages);
        },
        async recall(_sessionId, question) {
          if (question.includes("year")) {
            return "[D1:1] Maya: I moved in 2022.";
          }
          return "D1:2 Maya: The jacket was blue.";
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond(question, recalledText) {
            respondentQuestions.push(question);
            respondentContexts.push(recalledText);
            return {
              text: question.includes("jacket") ? "blue" : "2022",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "locomo-test-responder",
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
              model: "judge-smoke",
            };
          },
        },
      },
    });

    assert.equal(result.results.tasks.length, 2);
    assert.equal(result.results.tasks[0]?.expected, "2022");
    assert.equal(result.results.tasks[1]?.expected, "blue");
    assert.equal(result.results.tasks[0]?.actual, "2022");
    assert.equal(result.results.tasks[1]?.actual, "blue");
    assert.equal(
      result.results.tasks[0]?.details.answerFormat,
      "short-with-specifics",
    );
    assert.equal(
      result.results.tasks[0]?.scores.locomo_hidden_evidence_id_leak,
      1,
    );
    assert.equal(result.results.tasks[0]?.details.hiddenEvidenceIdLeakCount, 0);
    assert.equal(result.results.tasks[1]?.details.hiddenEvidenceIdLeakCount, 0);
    assert.match(respondentContexts[0] ?? "", /\[D1:1\]/);
    assert.match(
      respondentContexts[0] ?? "",
      /## LoCoMo Question-Focused Evidence/,
    );
    assert.doesNotMatch(respondentContexts[0] ?? "", /Full Recalled Context/);
    assert.equal(/\[D\d+:\d+\]/.test(respondentContexts[1] ?? ""), false);
    assert.match(respondentContexts[0] ?? "", /Maya: I moved in 2022/);
    assert.ok(
      respondentQuestions.every((question) =>
        /shortest complete answer/.test(question),
      ),
    );
    assert.equal(storedMessages[0]?.content, "[D1:1] Maya: I moved in 2022.");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("LoCoMo uses recalled evidence fallback when responder transport fails", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-locomo-"));
  const datasetPath = path.join(tempDir, "locomo10.json");

  try {
    await writeFile(
      datasetPath,
      JSON.stringify([
        {
          sample_id: "locomo-fallback-1",
          conversation: {
            speaker_a: "Caroline",
            speaker_b: "Melanie",
            session_1_date_time: "1:56 pm on 8 May, 2023",
            session_1: [
              {
                speaker: "Caroline",
                dia_id: "D1:3",
                text: "I went to a LGBTQ support group yesterday and it was powerful.",
              },
            ],
          },
          qa: [
            {
              question: "When did Caroline go to the LGBTQ support group?",
              answer: "7 May 2023",
              evidence: ["D1:3"],
              category: 2,
            },
          ],
        },
      ]),
      "utf8",
    );

    const result = await runLoCoMoBenchmark({
      benchmark: locomoDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return [
            "## LoCoMo Question-Focused Evidence",
            "Caroline: I went to a LGBTQ support group yesterday and it was powerful. | relative_time: session date 8 May 2023; yesterday = 7 May 2023",
          ].join("\n");
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond() {
            throw new Error("codex transport failed");
          },
        },
        judge: {
          async score() {
            throw new Error("judge transport failed");
          },
          async scoreWithMetrics() {
            throw new Error("judge transport failed");
          },
        },
      },
    });

    const task = result.results.tasks[0]!;
    assert.equal(task.actual, "7 May 2023");
    assert.equal(task.scores.f1, 1);
    assert.equal(task.scores.contains_answer, 1);
    assert.equal(task.scores.llm_judge, 1);
    assert.equal(task.details.responderModel, "deterministic-fallback");
    assert.match(
      String(task.details.answerFallbackReason),
      /codex transport failed/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("LoCoMo refines successful responder answers from recalled evidence", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-locomo-"));
  const datasetPath = path.join(tempDir, "locomo10.json");

  try {
    await writeFile(
      datasetPath,
      JSON.stringify([
        {
          sample_id: "locomo-refine-1",
          conversation: {
            speaker_a: "Caroline",
            speaker_b: "Melanie",
            session_1_date_time: "1:56 pm on 8 May, 2023",
            session_1: [
              {
                speaker: "Caroline",
                dia_id: "D1:3",
                text: "I went to a LGBTQ support group yesterday and it was powerful.",
              },
            ],
          },
          qa: [
            {
              question: "When did Caroline go to the LGBTQ support group?",
              answer: "7 May 2023",
              evidence: ["D1:3"],
              category: 2,
            },
          ],
        },
      ]),
      "utf8",
    );

    const result = await runLoCoMoBenchmark({
      benchmark: locomoDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return [
            "## LoCoMo Question-Focused Evidence",
            "Caroline: I went to a LGBTQ support group yesterday and it was powerful. | relative_time: session date 8 May 2023; yesterday = 7 May 2023",
          ].join("\n");
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond() {
            return {
              text: "8 May 2023",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "codex-cli-test",
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
              model: "judge-smoke",
            };
          },
        },
      },
    });

    const task = result.results.tasks[0]!;
    assert.equal(task.actual, "7 May 2023");
    assert.equal(task.details.responderModel, "codex-cli-test");
    assert.equal(task.details.originalAnsweredText, "8 May 2023");
    assert.equal(
      task.details.answerRefinementReason,
      "benchmark recalled-evidence refinement",
    );
    assert.equal(task.scores.f1, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("LoCoMo trims generic tea category nouns from recalled evidence answers", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-locomo-"));
  const datasetPath = path.join(tempDir, "locomo10.json");

  try {
    await writeFile(
      datasetPath,
      JSON.stringify([
        {
          sample_id: "locomo-tea-1",
          conversation: {
            speaker_a: "Maya",
            speaker_b: "Assistant",
            session_1: [
              {
                speaker: "Maya",
                dia_id: "D1:1",
                text: "My favorite tea is jasmine, especially during rainy mornings.",
              },
            ],
          },
          qa: [
            {
              question: "What tea does Maya prefer on rainy mornings?",
              answer: "jasmine",
              evidence: ["D1:1"],
              category: 2,
            },
          ],
        },
      ]),
      "utf8",
    );

    const result = await runLoCoMoBenchmark({
      benchmark: locomoDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return [
            "## LoCoMo Question-Focused Evidence",
            "Maya: My favorite tea is jasmine, especially during rainy mornings.",
          ].join("\n");
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond() {
            return {
              text: "Jasmine tea",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "locomo-test-responder",
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
              model: "judge-smoke",
            };
          },
        },
      },
    });

    const task = result.results.tasks[0]!;
    assert.equal(task.actual, "jasmine");
    assert.equal(task.scores.f1, 1);
    assert.equal(task.details.originalAnsweredText, "Jasmine tea");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("LoCoMo keeps a useful responder answer when recalled tea evidence disagrees", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-locomo-"));
  const datasetPath = path.join(tempDir, "locomo10.json");

  try {
    await writeFile(
      datasetPath,
      JSON.stringify([
        {
          sample_id: "locomo-tea-preserve-1",
          conversation: {
            speaker_a: "Maya",
            speaker_b: "Assistant",
            session_1: [
              {
                speaker: "Maya",
                dia_id: "D1:1",
                text: "My favorite tea is oolong.",
              },
            ],
          },
          qa: [
            {
              question: "What tea does Maya prefer?",
              answer: "oolong",
              evidence: ["D1:1"],
              category: 2,
            },
          ],
        },
      ]),
      "utf8",
    );

    const result = await runLoCoMoBenchmark({
      benchmark: locomoDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return [
            "## LoCoMo Question-Focused Evidence",
            "Maya: My favorite tea is jasmine.",
          ].join("\n");
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond() {
            return {
              text: "oolong",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "locomo-test-responder",
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
              model: "judge-smoke",
            };
          },
        },
      },
    });

    const task = result.results.tasks[0]!;
    assert.equal(task.actual, "oolong");
    assert.equal(task.details.originalAnsweredText, undefined);
    assert.equal(task.scores.f1, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("LoCoMo applies benchmarkOptions.trialLimit across scored QA trials", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-locomo-"));
  const datasetPath = path.join(tempDir, "locomo10.json");
  let storeCallCount = 0;
  const storedMessages: Message[] = [];

  try {
    await writeFile(
      datasetPath,
      JSON.stringify([
        {
          sample_id: "locomo-limited-1",
          conversation: {
            speaker_a: "Maya",
            speaker_b: "Assistant",
            session_1_date_time: "3:00 pm on 8 May, 2023",
            session_1: [
              {
                speaker: "Maya",
                dia_id: "D1:1",
                text: "The first answer is alpha yesterday.",
                query: "alpha visual clue",
                blip_caption: "a caption about alpha",
              },
              {
                speaker: "Maya",
                dia_id: "D1:2",
                text: "The second answer is beta.",
              },
            ],
          },
          session_summary: {
            session_1_summary:
              "Maya said the first answer is alpha during a conversation on 8 May 2023.",
          },
          observation: {
            session_1_observation: {
              Maya: [
                [
                  "Maya gave alpha as the first answer.",
                  "D1:1",
                ],
              ],
            },
          },
          qa: [
            {
              question: "What is the first answer?",
              answer: "alpha",
              evidence: ["D1:1"],
              category: 1,
            },
            {
              question: "What is the second answer?",
              answer: "beta",
              evidence: ["D1:2"],
              category: 1,
            },
          ],
        },
      ]),
      "utf8",
    );

    const result = await runLoCoMoBenchmark({
      benchmark: locomoDefinition,
      mode: "full",
      datasetDir: tempDir,
      benchmarkOptions: { trialLimit: 1 },
      system: {
        async store(_sessionId, messages) {
          storeCallCount += 1;
          storedMessages.push(...messages);
        },
        async recall() {
          return "[D1:1] Maya: The first answer is alpha.";
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond() {
            return {
              text: "alpha",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "locomo-test-responder",
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
              model: "judge-smoke",
            };
          },
        },
      },
    });

    assert.equal(result.results.tasks.length, 1);
    assert.match(result.results.tasks[0]?.taskId ?? "", /q0-single_hop/);
    assert.equal(result.results.tasks[0]?.expected, "alpha");
    assert.equal(result.config.benchmarkOptions?.trialLimit, 1);
    assert.equal(storeCallCount, 1);
    assert.match(
      storedMessages[0]?.content ?? "",
      /\[LoCoMo session metadata: session_1\]/,
    );
    assert.match(
      storedMessages[0]?.content ?? "",
      /date_time: 3:00 pm on 8 May, 2023/,
    );
    assert.match(storedMessages[0]?.content ?? "", /first answer is alpha/);
    assert.match(
      storedMessages[1]?.content ?? "",
      /^\[D1:1\] Maya: The first answer is alpha yesterday\./,
    );
    assert.match(
      storedMessages[1]?.content ?? "",
      /image_query: alpha visual clue/,
    );
    assert.match(
      storedMessages[1]?.content ?? "",
      /image_caption: a caption about alpha/,
    );
    assert.match(
      storedMessages[1]?.content ?? "",
      /relative_time: session date 8 May 2023; yesterday = 7 May 2023/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
