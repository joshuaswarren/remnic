import assert from "node:assert/strict";
import test from "node:test";

import {
  containsAnswer,
  llmBinaryJudgeScoreDetailed,
  llmJudgeScoreDetailed,
  recallAtK,
} from "./scorer.ts";
import {
  BenchmarkRunBlockedError,
  BenchmarkRunBlockReason,
} from "./benchmark-run-blocked-error.ts";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("llmJudgeScoreDetailed falls back deterministically after score failure", async () => {
  const result = await llmJudgeScoreDetailed(
    {
      async score() {
        await delay(40);
        throw new Error("judge timeout");
      },
    },
    "question",
    "predicted",
    "expected",
  );

  assert.equal(result.score, 0);
  assert.equal(result.model, "deterministic-fallback");
  assert.equal(result.tokens.input, 0);
  assert.equal(result.tokens.output, 0);
  assert.equal(result.latencyMs >= 10, true);
});

test("llmJudgeScoreDetailed includes failed scoreWithMetrics wall time in latency metrics", async () => {
  const result = await llmJudgeScoreDetailed(
    {
      async score() {
        throw new Error("unreachable fallback");
      },
      async scoreWithMetrics() {
        await delay(40);
        throw new Error("structured judge timeout");
      },
    },
    "question",
    "The answer is 7 May 2023.",
    "expected",
  );

  assert.equal(result.score, 0);
  assert.equal(result.tokens.input, 0);
  assert.equal(result.tokens.output, 0);
  assert.equal(result.latencyMs >= 10, true);
});

test("llmJudgeScoreDetailed deterministic fallback can award obvious matches", async () => {
  const result = await llmJudgeScoreDetailed(
    {
      async score() {
        throw new Error("unreachable fallback");
      },
      async scoreWithMetrics() {
        await delay(10);
        throw new Error("structured judge timeout");
      },
    },
    "question",
    "The answer is 7 May 2023.",
    "7 May 2023",
  );

  assert.equal(result.score, 1);
  assert.equal(result.model, "deterministic-fallback");
});

test("llmBinaryJudgeScoreDetailed falls back deterministically after prompt judge failure", async () => {
  const result = await llmBinaryJudgeScoreDetailed(
    {
      async scoreBinaryPrompt() {
        await delay(40);
        throw new Error("binary judge timeout");
      },
    },
    "Official yes/no prompt",
    {
      predicted: "The answer is 7 May 2023.",
      expected: "7 May 2023",
    },
  );

  assert.equal(result.score, 1);
  assert.equal(result.model, "deterministic-fallback");
  assert.equal(result.tokens.input, 0);
  assert.equal(result.tokens.output, 0);
  assert.equal(result.latencyMs >= 10, true);
});

test("llmJudgeScoreDetailed rethrows a terminal marker wrapped by scoreWithMetrics", async () => {
  const blocked = new BenchmarkRunBlockedError(
    BenchmarkRunBlockReason.ManualReconciliationRequired,
    "judge credits require reconciliation",
  );

  await assert.rejects(
    llmJudgeScoreDetailed(
      {
        async score() {
          throw new Error("unreachable fallback");
        },
        async scoreWithMetrics() {
          throw new Error("structured judge wrapper", { cause: blocked });
        },
      },
      "question",
      "predicted",
      "expected",
    ),
    (error: unknown) => error === blocked,
  );
});

test("llmJudgeScoreDetailed rethrows a terminal marker from scalar score", async () => {
  const blocked = new BenchmarkRunBlockedError(
    BenchmarkRunBlockReason.InfrastructureUnavailable,
    "scalar judge infrastructure is unavailable",
  );

  await assert.rejects(
    llmJudgeScoreDetailed(
      {
        async score() {
          throw blocked;
        },
      },
      "question",
      "predicted",
      "expected",
    ),
    (error: unknown) => error === blocked,
  );
});

test("llmBinaryJudgeScoreDetailed rethrows a terminal marker from the binary judge", async () => {
  const blocked = new BenchmarkRunBlockedError(
    BenchmarkRunBlockReason.SpendHeadroomExhausted,
    "judge credit headroom is exhausted",
  );

  await assert.rejects(
    llmBinaryJudgeScoreDetailed(
      {
        async scoreBinaryPrompt() {
          throw blocked;
        },
      },
      "Official yes/no prompt",
      { predicted: "predicted", expected: "expected" },
    ),
    (error: unknown) => error === blocked,
  );
});

test("containsAnswer ignores punctuation-only differences", () => {
  assert.equal(
    containsAnswer(
      "Two columns: category and notes",
      "Two columns: category and notes.",
    ),
    1,
  );
});

test("containsAnswer preserves semantic punctuation", () => {
  assert.equal(containsAnswer("I use C", "C++"), 0);
  assert.equal(containsAnswer("I went on a run", "N/A"), 0);
  assert.equal(containsAnswer("The selected language is C++.", "C++"), 1);
  assert.equal(containsAnswer("I use the internet daily", ".NET"), 0);
  assert.equal(containsAnswer("I use .NET daily", ".NET"), 1);
});

test("containsAnswer does not match short labels inside unrelated words", () => {
  assert.equal(containsAnswer("March 29", "A."), 0);
  assert.equal(containsAnswer("The answer is A.", "A."), 1);
  assert.equal(containsAnswer("Option B is selected.", "B."), 1);
  assert.equal(containsAnswer("nobody knows", "No."), 0);
  assert.equal(containsAnswer("yesterday", "Yes."), 0);
  assert.equal(containsAnswer("No, that was not discussed.", "No."), 1);
  assert.equal(containsAnswer("The answer is yes.", "Yes."), 1);
});

test("containsAnswer allows short numeric answers with attached units", () => {
  assert.equal(containsAnswer("250ms", "250"), 1);
  assert.equal(containsAnswer("$50", "50"), 1);
});

test("recallAtK rejects invalid cutoff values", () => {
  assert.equal(recallAtK(["a", "b"], ["a"], -1), 0);
  assert.equal(recallAtK(["a"], ["a"], 0), 0);
  assert.equal(recallAtK(["a"], ["a"], 1.5), 0);
  assert.equal(recallAtK(["a"], ["a"], 1), 1);
});
