import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { longMemEvalDefinition, runLongMemEvalBenchmark } from "./runner.ts";

/**
 * Smoke test for the LongMemEval runner after issue #566 PR 2 migrated
 * the per-item lifecycle into the shared harness. Verifies:
 *
 *   1. Dataset → plan → harness path emits one task per item.
 *   2. `search_hits` is computed via the post-answer hook (so it uses
 *      the live system under test, not a pre-ingest state).
 *   3. Task IDs, expected answers, and extra detail fields are
 *      propagated faithfully.
 */
test("LongMemEval runner wires the shared harness with per-item postAnswerHook", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-lme-"));
  try {
    await writeFile(
      path.join(tempDir, "longmemeval_oracle.json"),
      JSON.stringify([
        {
          question_id: "q-1",
          question_type: "single-session-user",
          question: "Which city does the user live in?",
          answer: "Paris",
          question_date: "2025-01-01",
          haystack_sessions: [
            [
              { role: "user", content: "I live in Paris." },
              { role: "assistant", content: "Got it, Paris." },
            ],
          ],
          haystack_session_ids: ["s-1"],
          haystack_dates: ["2025-01-01"],
          answer_session_ids: ["s-1"],
        },
      ]),
      "utf8",
    );

    let searchCalls = 0;
    const storedSessions = new Map<string, string[]>();
    const result = await runLongMemEvalBenchmark({
      benchmark: longMemEvalDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store(sessionId, messages) {
          storedSessions.set(
            sessionId,
            messages.map((message) => message.content),
          );
        },
        async recall(sessionId, _question) {
          return (storedSessions.get(sessionId) ?? []).join("\n");
        },
        async search(_query, _limit) {
          searchCalls += 1;
          return [{ id: "r", text: "Paris" }];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond(question, recalled) {
            return {
              text: `${question}:${recalled}`,
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "smoke-responder",
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
              model: "smoke-judge",
            };
          },
          async scoreBinaryPrompt() {
            return {
              score: 1,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "smoke-judge",
            };
          },
        },
      },
    });

    assert.equal(result.results.tasks.length, 1);
    const task = result.results.tasks[0]!;
    assert.equal(task.taskId, "qq-1");
    assert.equal(task.expected, "Paris");
    assert.equal(task.scores.search_hits, 1);
    assert.equal(
      searchCalls,
      1,
      "search should be invoked exactly once via postAnswerHook",
    );
    // Verify extra details were propagated.
    assert.equal(
      (task.details as Record<string, unknown>).questionType,
      "single-session-user",
    );
    assert.equal(
      storedSessions.get("s-1")?.[0],
      "I live in Paris.",
      "non-temporal questions should keep the original answer surface",
    );
    const audit = (task.details as Record<string, unknown>)
      .temporalRecallAudit as Record<string, unknown>;
    assert.deepEqual(audit.matchedSourceDates, []);
    assert.equal(audit.answerSessionIdsUsedForRecall, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("LongMemEval runner preserves temporal source metadata without narrowing recall to gold sessions", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-lme-temporal-"));
  let judgePrompt = "";
  try {
    await writeFile(
      path.join(tempDir, "longmemeval_oracle.json"),
      JSON.stringify([
        {
          question_id: "temporal-1",
          question_type: "multi-session-update",
          question:
            "As of 2025-02-01, what was the latest allergy update?",
          answer: "shellfish",
          question_date: "2025-02-02",
          haystack_sessions: [
            [
              { role: "user", content: "My allergy is pollen." },
              { role: "assistant", content: "I will remember pollen." },
            ],
            [
              { role: "user", content: "Latest allergy update: shellfish." },
              { role: "assistant", content: "I will remember shellfish." },
            ],
          ],
          haystack_session_ids: ["old-session", "latest-session"],
          haystack_dates: ["2025-01-01", "2025-02-01"],
          answer_session_ids: ["latest-session"],
        },
      ]),
      "utf8",
    );

    const storedSessions = new Map<string, string[]>();
    const recallSessionIds: string[] = [];
    const result = await runLongMemEvalBenchmark({
      benchmark: longMemEvalDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store(sessionId, messages) {
          storedSessions.set(
            sessionId,
            messages.map((message) => message.content),
          );
        },
        async recall(sessionId, _question) {
          recallSessionIds.push(sessionId);
          return (storedSessions.get(sessionId) ?? []).join("\n");
        },
        async search(_query, _limit) {
          return [
            {
              id: "latest",
              text: storedSessions.get("latest-session")?.join("\n") ?? "",
            },
          ];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond() {
            return {
              text: "shellfish",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "smoke-responder",
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
              model: "smoke-judge",
            };
          },
          async scoreBinaryPrompt(prompt) {
            judgePrompt = prompt;
            return {
              score: 1,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "smoke-judge",
            };
          },
        },
      },
    });

    assert.deepEqual(recallSessionIds, ["old-session", "latest-session"]);
    assert.match(
      storedSessions.get("latest-session")?.[0] ?? "",
      /^\[source_session: latest-session\] \[source_date: 2025-02-01\]/,
    );

    const task = result.results.tasks[0]!;
    const audit = (task.details as Record<string, unknown>)
      .temporalRecallAudit as Record<string, unknown>;
    assert.deepEqual(audit.questionDates, ["2025-02-01"]);
    assert.deepEqual(audit.temporalCues, ["as of", "latest"]);
    assert.deepEqual(audit.matchedQuestionDates, ["2025-02-01"]);
    assert.deepEqual(audit.matchedSourceDates, [
      "2025-01-01",
      "2025-02-01",
    ]);
    assert.deepEqual(audit.matchedSourceSessionIds, [
      "old-session",
      "latest-session",
    ]);
    assert.equal(audit.answerSessionIdsUsedForRecall, false);
    assert.match(judgePrompt, /updated answer/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("LongMemEval search_hits falls back to session-scoped search", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-lme-search-"));
  try {
    await writeFile(
      path.join(tempDir, "longmemeval_oracle.json"),
      JSON.stringify([
        {
          question_id: "search-1",
          question_type: "single-session-user",
          question: "What city does the user live in?",
          answer: "Paris",
          question_date: "2025-01-01",
          haystack_sessions: [
            [{ role: "user", content: "I moved to Paris last year." }],
          ],
          haystack_session_ids: ["city-session"],
          haystack_dates: ["2025-01-01"],
          answer_session_ids: ["city-session"],
        },
      ]),
      "utf8",
    );

    const searchSessionIds: Array<string | undefined> = [];
    const result = await runLongMemEvalBenchmark({
      benchmark: longMemEvalDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "I moved to Paris last year.";
        },
        async search(_query, _limit, sessionId) {
          searchSessionIds.push(sessionId);
          return sessionId === "city-session"
            ? [
                {
                  turnIndex: 0,
                  role: "user",
                  snippet: "I moved to Paris last year.",
                  sessionId,
                },
              ]
            : [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond() {
            return {
              text: "Paris",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "smoke-responder",
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
              model: "smoke-judge",
            };
          },
          async scoreBinaryPrompt() {
            return {
              score: 1,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "smoke-judge",
            };
          },
        },
      },
    });

    assert.deepEqual(searchSessionIds, [undefined, "city-session"]);
    assert.equal(result.results.tasks[0]?.scores.search_hits, 1);
    assert.equal(result.results.tasks[0]?.details.directSearchHits, 1);
    assert.equal(result.results.tasks[0]?.details.recallEvidenceHits, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("LongMemEval search_hits survives rejecting unscoped search", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-lme-search-reject-"));
  try {
    await writeFile(
      path.join(tempDir, "longmemeval_oracle.json"),
      JSON.stringify([
        {
          question_id: "search-reject-1",
          question_type: "single-session-user",
          question: "What city does the user live in?",
          answer: "Paris",
          question_date: "2025-01-01",
          haystack_sessions: [
            [{ role: "user", content: "I moved to Paris last year." }],
          ],
          haystack_session_ids: ["city-session"],
          haystack_dates: ["2025-01-01"],
          answer_session_ids: ["city-session"],
        },
      ]),
      "utf8",
    );

    const searchSessionIds: Array<string | undefined> = [];
    const result = await runLongMemEvalBenchmark({
      benchmark: longMemEvalDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "I moved to Paris last year.";
        },
        async search(_query, _limit, sessionId) {
          searchSessionIds.push(sessionId);
          if (sessionId === undefined) {
            throw new Error("global search unavailable");
          }
          return sessionId === "city-session"
            ? [
                {
                  turnIndex: 0,
                  role: "user",
                  snippet: "I moved to Paris last year.",
                  sessionId,
                },
              ]
            : [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond() {
            return {
              text: "Paris",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "smoke-responder",
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
              model: "smoke-judge",
            };
          },
          async scoreBinaryPrompt() {
            return {
              score: 1,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "smoke-judge",
            };
          },
        },
      },
    });

    const task = result.results.tasks[0]!;
    assert.deepEqual(searchSessionIds, [undefined, "city-session"]);
    assert.equal(task.scores.f1, 1);
    assert.equal(task.scores.judge_accuracy, 1);
    assert.equal(task.scores.search_hits, 1);
    assert.equal(task.details.directSearchHits, 1);
    assert.equal(task.details.recallEvidenceHits, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("LongMemEval search_hits counts recalled evidence when direct search is empty", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-lme-recall-hit-"));
  try {
    await writeFile(
      path.join(tempDir, "longmemeval_oracle.json"),
      JSON.stringify([
        {
          question_id: "recall-hit-1",
          question_type: "single-session-user",
          question: "What city does the user live in?",
          answer: "Paris",
          question_date: "2025-01-01",
          haystack_sessions: [
            [{ role: "user", content: "I moved to Paris last year." }],
          ],
          haystack_session_ids: ["city-session"],
          haystack_dates: ["2025-01-01"],
          answer_session_ids: ["city-session"],
        },
      ]),
      "utf8",
    );

    const result = await runLongMemEvalBenchmark({
      benchmark: longMemEvalDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "I moved to Paris last year.";
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
              text: "Paris",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "smoke-responder",
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
              model: "smoke-judge",
            };
          },
          async scoreBinaryPrompt() {
            return {
              score: 1,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "smoke-judge",
            };
          },
        },
      },
    });

    const task = result.results.tasks[0]!;
    assert.equal(task.scores.search_hits, 1);
    assert.equal(task.details.directSearchHits, 0);
    assert.equal(task.details.recallEvidenceHits, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("LongMemEval official judge prompt handles numeric question_id", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-lme-numeric-id-"));
  try {
    await writeFile(
      path.join(tempDir, "longmemeval_oracle.json"),
      JSON.stringify([
        {
          question_id: 42,
          question_type: "single-session-user",
          question: "What city does the user live in?",
          answer: "Paris",
          question_date: "2025-01-01",
          haystack_sessions: [
            [{ role: "user", content: "I live in Paris." }],
          ],
          haystack_session_ids: ["city-session"],
          haystack_dates: ["2025-01-01"],
          answer_session_ids: ["city-session"],
        },
      ]),
      "utf8",
    );

    const result = await runLongMemEvalBenchmark({
      benchmark: longMemEvalDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "I live in Paris.";
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
              text: "Paris",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "smoke-responder",
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
              model: "smoke-judge",
            };
          },
          async scoreBinaryPrompt() {
            return {
              score: 1,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "smoke-judge",
            };
          },
        },
      },
    });

    const task = result.results.tasks[0]!;
    assert.equal(task.taskId, "q42");
    assert.equal(task.scores.judge_accuracy, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("LongMemEval official judge prompt handles abstention question ids", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-lme-abs-id-"));
  try {
    await writeFile(
      path.join(tempDir, "longmemeval_oracle.json"),
      JSON.stringify([
        {
          question_id: "2655_abs",
          question_type: "single-session-user",
          question: "What city did the user say they are moving to?",
          answer: "The conversation does not contain the user's moving city.",
          question_date: "2025-01-01",
          haystack_sessions: [
            [{ role: "user", content: "I need to pick a moving date." }],
          ],
          haystack_session_ids: ["move-session"],
          haystack_dates: ["2025-01-01"],
          answer_session_ids: ["move-session"],
        },
      ]),
      "utf8",
    );

    let capturedPrompt = "";
    const result = await runLongMemEvalBenchmark({
      benchmark: longMemEvalDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "I need to pick a moving date.";
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
              text: "The conversation does not say.",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "smoke-responder",
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
              model: "smoke-judge",
            };
          },
          async scoreBinaryPrompt(prompt) {
            capturedPrompt = prompt;
            return {
              score: 1,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "smoke-judge",
            };
          },
        },
      },
    });

    const task = result.results.tasks[0]!;
    assert.equal(task.taskId, "q2655_abs");
    assert.equal(task.scores.judge_accuracy, 1);
    assert.match(capturedPrompt, /unanswerable question/);
    assert.match(capturedPrompt, /Explanation:/);
    assert.doesNotMatch(capturedPrompt, /Correct Answer:/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("LongMemEval official judge prompt treats only _abs suffix as abstention", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-lme-abs-substring-"));
  try {
    await writeFile(
      path.join(tempDir, "longmemeval_oracle.json"),
      JSON.stringify([
        {
          question_id: "no_abs_here",
          question_type: "single-session-user",
          question: "What city does the user live in?",
          answer: "Paris",
          question_date: "2025-01-01",
          haystack_sessions: [
            [{ role: "user", content: "I live in Paris." }],
          ],
          haystack_session_ids: ["city-session"],
          haystack_dates: ["2025-01-01"],
          answer_session_ids: ["city-session"],
        },
      ]),
      "utf8",
    );

    let capturedPrompt = "";
    await runLongMemEvalBenchmark({
      benchmark: longMemEvalDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "I live in Paris.";
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
              text: "Paris",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "smoke-responder",
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
              model: "smoke-judge",
            };
          },
          async scoreBinaryPrompt(prompt) {
            capturedPrompt = prompt;
            return {
              score: 1,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "smoke-judge",
            };
          },
        },
      },
    });

    assert.match(capturedPrompt, /Correct Answer:/);
    assert.doesNotMatch(capturedPrompt, /unanswerable question/);
    assert.doesNotMatch(capturedPrompt, /Explanation:/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("LongMemEval failed trials retain judge_accuracy in aggregates", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-lme-failed-trial-"));
  try {
    await writeFile(
      path.join(tempDir, "longmemeval_oracle.json"),
      JSON.stringify([
        {
          question_id: "fail-1",
          question_type: "single-session-user",
          question: "What city does the user live in?",
          answer: "Paris",
          question_date: "2025-01-01",
          haystack_sessions: [
            [{ role: "user", content: "I live in Paris." }],
          ],
          haystack_session_ids: ["city-session"],
          haystack_dates: ["2025-01-01"],
          answer_session_ids: ["city-session"],
        },
      ]),
      "utf8",
    );

    const result = await runLongMemEvalBenchmark({
      benchmark: longMemEvalDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          throw new Error("forced recall failure");
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
              text: "Paris",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "smoke-responder",
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
              model: "smoke-judge",
            };
          },
          async scoreBinaryPrompt() {
            return {
              score: 1,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "smoke-judge",
            };
          },
        },
      },
    });

    const task = result.results.tasks[0]!;
    assert.deepEqual(task.scores, {
      f1: -1,
      contains_answer: -1,
      llm_judge: -1,
      judge_accuracy: -1,
    });
    assert.equal(result.results.aggregates.judge_accuracy?.mean, -1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
