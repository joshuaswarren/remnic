import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Message } from "../../../adapters/types.js";
import { buildLoCoMoPlan, locomoDefinition, runLoCoMoBenchmark } from "./runner.ts";
import { deriveLoCoMoGoldMemories } from "./gold-memories.ts";
import { selectLoCoMoTasks } from "./task-selection.js";

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
      result.results.tasks[0]?.details?.answerFormat,
      "short-with-specifics",
    );
    assert.equal(
      result.results.tasks[0]?.scores.locomo_hidden_evidence_id_leak,
      1,
    );
    assert.equal(result.results.tasks[0]?.details?.hiddenEvidenceIdLeakCount, 0);
    assert.equal(result.results.tasks[1]?.details?.hiddenEvidenceIdLeakCount, 0);
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
    assert.equal(task.details?.responderModel, "deterministic-fallback");
    assert.match(
      String(task.details?.answerFallbackReason),
      /codex transport failed/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("LoCoMo rejects malformed session turns before runner side effects", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-locomo-malformed-"));
  const datasetPath = path.join(tempDir, "locomo10.json");
  let resetCalls = 0;
  let storeCalls = 0;

  try {
    await writeFile(
      datasetPath,
      JSON.stringify([
        {
          sample_id: "locomo-malformed-1",
          conversation: {
            speaker_a: "Maya",
            speaker_b: "Assistant",
            session_1: [
              { speaker: "Maya", dia_id: "D1:1" },
            ],
          },
          qa: [
            {
              question: "What did Maya say?",
              answer: "nothing",
              evidence: ["D1:1"],
              category: 1,
            },
          ],
        },
      ]),
      "utf8",
    );

    await assert.rejects(
      () => runLoCoMoBenchmark({
        benchmark: locomoDefinition,
        mode: "full",
        datasetDir: tempDir,
        system: {
          async store() { storeCalls += 1; },
          async recall() { return ""; },
          async search() { return []; },
          async reset() { resetCalls += 1; },
          async destroy() {},
          async getStats() {
            return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
          },
          responder: {
            async respond() {
              throw new Error("responder should not run");
            },
          },
          judge: {
            async score() {
              throw new Error("judge should not run");
            },
          },
        },
      }),
      /conversation\.session_1\[0\]\.text must be a string/,
    );

    assert.equal(resetCalls, 0);
    assert.equal(storeCalls, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("LoCoMo uses relative-time fallback for year-based temporal questions", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-locomo-"));
  const datasetPath = path.join(tempDir, "locomo10.json");

  try {
    await writeFile(
      datasetPath,
      JSON.stringify([
        {
          sample_id: "locomo-year-fallback-1",
          conversation: {
            speaker_a: "Maya",
            speaker_b: "Assistant",
            session_1_date_time: "1:56 pm on 8 May, 2023",
            session_1: [
              {
                speaker: "Maya",
                dia_id: "D1:4",
                text: "I painted the sunrise last year near the lake.",
              },
            ],
          },
          qa: [
            {
              question: "What year did Maya paint the sunrise?",
              answer: "2022",
              evidence: ["D1:4"],
              category: 3,
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
            "Maya: I painted the sunrise last year near the lake. | relative_time: session date 8 May 2023; last year = 2022",
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
    assert.equal(task.actual, "2022");
    assert.equal(task.scores.f1, 1);
    assert.equal(task.scores.contains_answer, 1);
    assert.equal(task.details?.responderModel, "deterministic-fallback");
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
    assert.equal(task.details?.responderModel, "codex-cli-test");
    assert.equal(task.details?.originalAnsweredText, "8 May 2023");
    assert.equal(
      task.details?.answerRefinementReason,
      "benchmark recalled-evidence refinement",
    );
    assert.equal(task.scores.f1, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("LoCoMo preserves useful temporal responder answers when recall has unrelated anchors", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-locomo-"));
  const datasetPath = path.join(tempDir, "locomo10.json");

  try {
    await writeFile(
      datasetPath,
      JSON.stringify([
        {
          sample_id: "locomo-refine-preserve-1",
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
            session_2_date_time: "6:55 pm on 20 October, 2023",
            session_2: [
              {
                speaker: "Melanie",
                dia_id: "D2:1",
                text: "Yesterday I visited the pottery studio.",
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
            "session_summary: Caroline and Melanie had a conversation on 8 May 2023. Caroline mentioned that she attended an LGBTQ support group.",
            "Melanie: Yesterday I visited the pottery studio. | relative_time: session date 20 October 2023; yesterday = 19 October 2023",
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
              text: "May 7, 2023",
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
    assert.equal(task.actual, "May 7, 2023");
    assert.equal(task.details?.originalAnsweredText, undefined);
    assert.equal(task.details?.answerRefinementReason, undefined);
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
    assert.equal(task.details?.originalAnsweredText, "Jasmine tea");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("LoCoMo keeps multi-word favorite tea names from recalled evidence", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-locomo-"));
  const datasetPath = path.join(tempDir, "locomo10.json");

  try {
    await writeFile(
      datasetPath,
      JSON.stringify([
        {
          sample_id: "locomo-tea-multi-word-1",
          conversation: {
            speaker_a: "Maya",
            speaker_b: "Assistant",
            session_1: [
              {
                speaker: "Maya",
                dia_id: "D1:1",
                text: "My favorite tea is Earl Grey on rainy mornings.",
              },
            ],
          },
          qa: [
            {
              question: "What tea does Maya prefer on rainy mornings?",
              answer: "earl grey",
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
            "Maya: My favorite tea is Earl Grey on rainy mornings.",
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
              text: "Earl Grey tea",
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
    assert.equal(task.actual, "earl grey");
    assert.equal(task.scores.f1, 1);
    assert.equal(task.details?.originalAnsweredText, "Earl Grey tea");
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
    assert.equal(task.details?.originalAnsweredText, undefined);
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

test("LoCoMo task selection scores canonical dataset order while retaining complete selected-conversation ingest", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-locomo-selected-"));
  const datasetPath = path.join(tempDir, "locomo10.json");
  const calls: string[] = [];
  const candidateTaskIds = [
    "conversation-a-q0-single_hop",
    "conversation-a-q1-multi_hop",
    "conversation-b-q0-multi_hop",
    "conversation-unused-q0-single_hop",
  ];
  const selection = selectLoCoMoTasks(
    candidateTaskIds.map((taskId) => ({ taskId })),
    {
      taskIds: [
        "conversation-b-q0-multi_hop",
        "conversation-a-q1-multi_hop",
      ],
    },
  );

  try {
    await writeFile(
      datasetPath,
      JSON.stringify([
        {
          sample_id: "conversation-a",
          conversation: {
            speaker_a: "Maya",
            session_1: [
              { speaker: "Maya", dia_id: "D1:1", text: "Alpha context." },
            ],
            session_2: [
              { speaker: "Maya", dia_id: "D2:1", text: "Beta context." },
            ],
          },
          qa: [
            {
              question: "What is alpha?",
              answer: "alpha",
              evidence: ["D1:1"],
              category: 1,
            },
            {
              question: "What is beta?",
              answer: "beta",
              evidence: ["D2:1"],
              category: 2,
            },
          ],
        },
        {
          sample_id: "conversation-b",
          conversation: {
            speaker_a: "Noah",
            session_1: [
              { speaker: "Noah", dia_id: "D3:1", text: "Gamma context." },
            ],
          },
          qa: [
            {
              question: "What is gamma?",
              answer: "gamma",
              evidence: ["D3:1"],
              category: 2,
            },
          ],
        },
        {
          sample_id: "conversation-unused",
          conversation: {
            speaker_a: "Unused",
            session_1: [
              { speaker: "Unused", dia_id: "D4:1", text: "Unused context." },
            ],
          },
          qa: [
            {
              question: "What is unused?",
              answer: "unused",
              evidence: ["D4:1"],
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
      benchmarkOptions: {
        taskSelector: {
          kind: "explicit-task-ids",
          taskIds: [
            "conversation-b-q0-multi_hop",
            "conversation-a-q1-multi_hop",
          ],
          expectedSelectedTaskIdsSha256: selection.selectedTaskIdsSha256,
        },
      },
      system: {
        async reset() {
          calls.push("reset");
        },
        async store(sessionId) {
          calls.push(`store:${sessionId}`);
        },
        async recall(_sessionId, question) {
          return `${question} alpha beta gamma`;
        },
        async search() {
          return [];
        },
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond(question) {
            return {
              text: question.includes("beta") ? "beta" : "gamma",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "selector-test-responder",
            };
          },
        },
        judge: {
          async score() {
            return 1;
          },
        },
      },
    });

    assert.deepEqual(
      result.results.tasks.map((task) => task.taskId),
      ["conversation-a-q1-multi_hop", "conversation-b-q0-multi_hop"],
    );
    assert.deepEqual(calls, [
      "reset",
      "store:conversation-a-session_1",
      "store:conversation-a-session_2",
      "reset",
      "store:conversation-b-session_1",
    ]);
    assert.deepEqual(result.config.benchmarkOptions?.taskSelection, selection);
    assert.equal(result.config.benchmarkOptions?.taskSelector, undefined);
    assert.match(result.meta.datasetHash ?? "", /^[0-9a-f]{64}$/u);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("LoCoMo task selection fails before adapter side effects on invalid or incompatible selectors", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-locomo-selector-invalid-"));
  const datasetPath = path.join(tempDir, "locomo10.json");
  let sideEffects = 0;
  const taskId = "selector-validation-q0-multi_hop";
  const validHash = selectLoCoMoTasks([{ taskId }], { taskIds: [taskId] })
    .selectedTaskIdsSha256;
  const system = {
    async reset() {
      sideEffects += 1;
    },
    async store() {
      sideEffects += 1;
    },
    async recall() {
      sideEffects += 1;
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

  try {
    await writeFile(
      datasetPath,
      JSON.stringify([
        {
          sample_id: "selector-validation",
          conversation: {
            speaker_a: "Maya",
            session_1: [
              { speaker: "Maya", dia_id: "D1:1", text: "Selector context." },
            ],
          },
          qa: [
            {
              question: "Which selector?",
              answer: "selector",
              evidence: ["D1:1"],
              category: 2,
            },
          ],
        },
      ]),
      "utf8",
    );

    const selector = {
      kind: "explicit-task-ids",
      taskIds: [taskId],
      expectedSelectedTaskIdsSha256: validHash,
    };
    const base = {
      benchmark: locomoDefinition,
      mode: "full" as const,
      datasetDir: tempDir,
      system,
    };
    await assert.rejects(
      runLoCoMoBenchmark({
        ...base,
        benchmarkOptions: {
          taskSelector: {
            ...selector,
            expectedSelectedTaskIdsSha256: "0".repeat(64),
          },
        },
      }),
      /selected task-id hash does not match/,
    );
    await assert.rejects(
      runLoCoMoBenchmark({
        ...base,
        benchmarkOptions: {
          taskSelector: { ...selector, taskIds: ["unknown"] },
        },
      }),
      /Unknown/,
    );
    await assert.rejects(
      runLoCoMoBenchmark({
        ...base,
        benchmarkOptions: {
          taskSelector: { ...selector, taskIds: [taskId, taskId] },
        },
      }),
      /duplicates/,
    );
    for (const incompatible of [
      { ...base, mode: "quick" as const, benchmarkOptions: { taskSelector: selector } },
      { ...base, limit: 1, benchmarkOptions: { taskSelector: selector } },
      { ...base, benchmarkOptions: { taskSelector: selector, trialLimit: 1 } },
      {
        ...base,
        benchmarkOptions: { taskSelector: selector, trialConcurrency: 2 },
      },
    ]) {
      await assert.rejects(runLoCoMoBenchmark(incompatible), /task selection/);
    }
    await assert.rejects(
      runLoCoMoBenchmark({
        ...base,
        benchmarkOptions: { taskSelection: { selectedCount: 1 } },
      }),
      /runner-owned/,
    );
    assert.equal(sideEffects, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
test("deriveLoCoMoGoldMemories derives correct statements in evidence order, deduped, and omits when none match", () => {
  const observation = {
    session_1_observation: {
      Alice: [
        ["Alice moved to Seattle in 2022.", "D1:1"],
        ["Alice prefers jasmine tea on rainy mornings.", ["D1:2", "D1:3"]],
        ["Alice loves rainy mornings.", "D1:3"],
      ],
    },
    session_2_observation: {
      Bob: [
        ["Bob is a librarian.", "D2:1"],
      ],
    },
  };

  // Evidence order: D1:2 then D1:1
  const derivedOrder = deriveLoCoMoGoldMemories(observation, ["D1:2", "D1:1"]);
  assert.deepEqual(derivedOrder, [
    "Alice prefers jasmine tea on rainy mornings.",
    "Alice moved to Seattle in 2022.",
  ]);

  // Deduplication: D1:2 and D1:3 both map to "Alice prefers jasmine tea..."
  const derivedDedupe = deriveLoCoMoGoldMemories(observation, ["D1:2", "D1:3"]);
  assert.deepEqual(derivedDedupe, [
    "Alice prefers jasmine tea on rainy mornings.",
    "Alice loves rainy mornings.",
  ]);

  // Omit when no evidence matches
  const derivedNone = deriveLoCoMoGoldMemories(observation, ["D9:99"]);
  assert.equal(derivedNone, undefined);

  // Empty evidence
  const derivedEmptyEv = deriveLoCoMoGoldMemories(observation, []);
  assert.equal(derivedEmptyEv, undefined);
});

test("deriveLoCoMoGoldMemories handles malformed annotation shapes defensively without throwing", () => {
  const malformedObservations = [
    null,
    undefined,
    123,
    "not an object",
    [],
    { session_1_observation: null },
    { session_1_observation: 123 },
    { session_1_observation: "string" },
    { session_1_observation: [] },
    { session_1_observation: { Alice: "not an array" } },
    { session_1_observation: { Alice: [null, 123, "not a tuple", [], [123, "D1:1"], ["stmt", 456]] } },
  ];

  for (const obs of malformedObservations) {
    assert.doesNotThrow(() => {
      const res = deriveLoCoMoGoldMemories(obs, ["D1:1"]);
      assert.equal(res, undefined);
    });
  }

  // Well-formed item alongside malformed items in same observation
  const mixedObs = {
    bad_session: "invalid",
    session_1_observation: {
      bad_speaker: null,
      Alice: [
        "bad item",
        [123, "D1:1"],
        ["Valid observation statement.", "D1:1"],
      ],
    },
  };
  assert.deepEqual(deriveLoCoMoGoldMemories(mixedObs, ["D1:1"]), ["Valid observation statement."]);
});

test("buildLoCoMoPlan attaches goldMemories to trial from synthetic conversation", () => {
  const conversation = {
    sample_id: "synthetic-locomo-gold",
    conversation: {
      speaker_a: "Alice",
      speaker_b: "Bob",
      session_1: [
        { speaker: "Alice", dia_id: "D1:1", text: "I like hiking." },
      ],
    },
    observation: {
      session_1_observation: {
        Alice: [
          ["Alice enjoys hiking in mountains.", "D1:1"],
        ],
      },
    },
    qa: [
      {
        question: "What does Alice enjoy?",
        answer: "hiking",
        evidence: ["D1:1"],
        category: 1,
      },
      {
        question: "Where is Bob from?",
        answer: "unknown",
        evidence: ["D9:9"],
        category: 1,
      },
    ],
  };

  const plan = buildLoCoMoPlan(conversation, false);
  assert.equal(plan.trials.length, 2);
  assert.deepEqual(plan.trials[0]?.goldMemories, ["Alice enjoys hiking in mountains."]);
  assert.equal(plan.trials[1]?.goldMemories, undefined);
});

test("deriveLoCoMoGoldMemories skips blank or whitespace-only statements", () => {
  const observation = {
    session_1_observation: {
      Avery: [
        ["", "D1:1"],
        ["   ", "D1:1"],
        ["A substantive statement.", "D1:1"],
      ],
    },
  };
  assert.deepEqual(deriveLoCoMoGoldMemories(observation, ["D1:1"]), [
    "A substantive statement.",
  ]);
});
