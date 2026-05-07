import assert from "node:assert/strict";
import test from "node:test";

import {
  answerBenchmarkQuestion,
  buildAgenticMemoryBenchmarkQuestion,
  buildStrictBenchmarkQuestion,
  buildUnknownRetryQuestion,
  hasExplicitTrajectoryEvidence,
  inferAnswerFormat,
  isUnknownOnlyAnswer,
} from "./answering.ts";

test("without a responder the benchmark answer falls back to recalled text", async () => {
  const result = await answerBenchmarkQuestion({
    question: "What happened?",
    recalledText: "The recalled memory.",
  });

  assert.equal(result.finalAnswer, "The recalled memory.");
  assert.equal(result.recalledText, "The recalled memory.");
  assert.equal(result.answeredText, "The recalled memory.");
  assert.deepEqual(result.tokens, {
    input: 0,
    output: 0,
  });
  assert.equal(result.latencyMs, 0);
});

test("with a responder the benchmark answer uses the generated final answer and preserves usage", async () => {
  const result = await answerBenchmarkQuestion({
    question: "What happened?",
    recalledText: "The recalled memory.",
    answerMode: "strict",
    responder: {
      async respond(question, recalledText) {
        assert.match(question, /What happened\?/);
        assert.match(question, /Benchmark answer protocol:/);
        assert.equal(recalledText, "The recalled memory.");
        return {
          text: "The generated answer.",
          tokens: {
            input: 32,
            output: 9,
          },
          latencyMs: 44,
          model: "gpt-5.4-mini",
        };
      },
    },
  });

  assert.equal(result.finalAnswer, "The generated answer.");
  assert.equal(result.recalledText, "The recalled memory.");
  assert.equal(result.answeredText, "The generated answer.");
  assert.deepEqual(result.tokens, {
    input: 32,
    output: 9,
  });
  assert.equal(result.latencyMs, 44);
  assert.equal(result.model, "gpt-5.4-mini");
});

test("default answering preserves legacy exact questions", async () => {
  const result = await answerBenchmarkQuestion({
    question: "What happened?",
    recalledText: "The recalled memory.",
    answerMode: "default",
    responder: {
      async respond(question) {
        assert.equal(question, "What happened?");
        return {
          text: "The generated answer.",
          tokens: { input: 1, output: 1 },
          latencyMs: 1,
          model: "test-model",
        };
      },
    },
  });

  assert.equal(result.finalAnswer, "The generated answer.");
});

test("agentic-memory answering asks responders to synthesize grounded trajectory inferences", async () => {
  const result = await answerBenchmarkQuestion({
    question: "What strategic goal did the up/up/right/right maneuver accomplish?",
    recalledText: "[Action 39]: up\n[Observation 39]: ball blocks the row",
    answerMode: "agentic-memory",
    responder: {
      async respond(question, recalledText) {
        assert.match(question, /Agentic trajectory protocol:/);
        assert.match(question, /causal, strategic, and temporal reasoning/);
        assert.match(question, /requires inference/);
        assert.match(question, /step numbers, action names, object names/);
        assert.match(question, /anchor the answer to those exact numbers/);
        assert.match(question, /state at the start of Step N is the prior observation/);
        assert.match(question, /enumerate each action in that inclusive range/);
        assert.match(question, /exclude Action\/Observation N/);
        assert.match(question, /include Action\/Observation N/);
        assert.match(question, /count all matching action verbs/);
        assert.match(question, /container, inventory, and object-location histories/);
        assert.match(question, /adjacent trajectory evidence contains the named action/);
        assert.match(question, /next concrete maneuver it enables/);
        assert.match(question, /treat an object on the direct path as a blocker/);
        assert.match(question, /prefer rule-text positioning over chasing ordinary objects/);
        assert.match(question, /prefer pushing nearby rule-word blocks/);
        assert.match(question, /temporary rule formation\/break/);
        assert.match(question, /do not count a temporary closer position/);
        assert.match(question, /Answer every clause in the question/);
        assert.match(question, /Do not assume an object disappeared/);
        assert.equal(
          recalledText,
          "[Action 39]: up\n[Observation 39]: ball blocks the row",
        );
        return {
          text: "It repositioned around the blocking ball.",
          tokens: { input: 12, output: 7 },
          latencyMs: 3,
          model: "test-model",
        };
      },
    },
  });

  assert.equal(result.finalAnswer, "It repositioned around the blocking ball.");
});

test("agentic-memory answering includes benchmark context when provided", async () => {
  const result = await answerBenchmarkQuestion({
    question: "What did the rule manipulation accomplish?",
    recalledText: "[Action 4]: push IS\n[Observation 4]: ROCK IS PUSH",
    answerMode: "agentic-memory",
    questionContext: {
      benchmark: "AMA-Bench",
      domain: "Games",
      task: "Baba Is You trajectory",
      taskType: "game",
      qaType: "reasoning",
    },
    responder: {
      async respond(question) {
        assert.match(question, /Benchmark context:/);
        assert.match(question, /Benchmark: AMA-Bench/);
        assert.match(question, /Domain: Games/);
        assert.match(question, /Task type: game/);
        assert.match(question, /QA type: reasoning/);
        assert.match(question, /Task setting: Baba Is You trajectory/);
        return {
          text: "It changed the active rock rule.",
          tokens: { input: 10, output: 6 },
          latencyMs: 5,
          model: "test-model",
        };
      },
    },
  });

  assert.equal(result.finalAnswer, "It changed the active rock rule.");
});

test("agentic-memory answering retries one unknown answer when explicit trajectory evidence is present", async () => {
  const questions: string[] = [];
  const result = await answerBenchmarkQuestion({
    question: "Why did the agent move right after step 12?",
    recalledText: [
      "## Explicit Cue Evidence",
      "[Action 12]: right",
      "[Observation 12]: The wall is now one tile to the left.",
    ].join("\n"),
    answerMode: "agentic-memory",
    retryUnknownWithEvidence: true,
    responder: {
      async respond(question) {
        questions.push(question);
        if (questions.length === 1) {
          return {
            text: "unknown",
            tokens: { input: 11, output: 1 },
            latencyMs: 7,
            model: "first-model",
          };
        }
        assert.match(question, /prior answer was only "unknown"/);
        assert.match(question, /trajectory evidence/);
        return {
          text: "It moved right, making the wall shift to the left relative to the agent.",
          tokens: { input: 13, output: 12 },
          latencyMs: 9,
          model: "retry-model",
        };
      },
    },
  });

  assert.equal(questions.length, 2);
  assert.equal(
    result.finalAnswer,
    "It moved right, making the wall shift to the left relative to the agent.",
  );
  assert.deepEqual(result.tokens, { input: 24, output: 13 });
  assert.equal(result.latencyMs, 16);
  assert.equal(result.model, "retry-model");
});

test("agentic-memory answering retries unknown when trajectory markers appear outside explicit cue sections", async () => {
  const questions: string[] = [];
  const result = await answerBenchmarkQuestion({
    question: "What inventory changes occurred before step 80?",
    recalledText: [
      "## Remnic recall pipeline",
      "[Action 20]: take cd 3",
      "[Observation 20]: Inventory: cd 3.",
      "[Action 24]: move cd 3 to safe 1",
      "[Observation 24]: Inventory: empty.",
      "[Action 80]: take cd 2",
      "[Observation 80]: Inventory: cd 2.",
    ].join("\n"),
    answerMode: "agentic-memory",
    retryUnknownWithEvidence: true,
    responder: {
      async respond(question) {
        questions.push(question);
        if (questions.length === 1) {
          return {
            text: "unknown",
            tokens: { input: 11, output: 1 },
            latencyMs: 7,
            model: "first-model",
          };
        }
        assert.match(question, /prior answer was only "unknown"/);
        assert.match(question, /trajectory evidence/);
        return {
          text: "cd 3 was added at step 20, removed at step 24, and cd 2 was added at step 80.",
          tokens: { input: 13, output: 12 },
          latencyMs: 9,
          model: "retry-model",
        };
      },
    },
  });

  assert.equal(questions.length, 2);
  assert.equal(
    result.finalAnswer,
    "cd 3 was added at step 20, removed at step 24, and cd 2 was added at step 80.",
  );
});

test("agentic-memory answering does not retry unknown without explicit trajectory evidence", async () => {
  let calls = 0;
  const result = await answerBenchmarkQuestion({
    question: "What happened?",
    recalledText: "## Remnic recall pipeline\nNo exact trajectory cue was found.",
    answerMode: "agentic-memory",
    retryUnknownWithEvidence: true,
    responder: {
      async respond() {
        calls += 1;
        return {
          text: "unknown",
          tokens: { input: 3, output: 1 },
          latencyMs: 4,
          model: "test-model",
        };
      },
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.finalAnswer, "unknown");
  assert.deepEqual(result.tokens, { input: 3, output: 1 });
});

test("agentic-memory answering preserves the first unknown answer when the optional retry fails", async () => {
  let calls = 0;
  const result = await answerBenchmarkQuestion({
    question: "Why did the agent move right after step 12?",
    recalledText: [
      "## Explicit Cue Evidence",
      "[Action 12]: right",
      "[Observation 12]: The wall is now one tile to the left.",
    ].join("\n"),
    answerMode: "agentic-memory",
    retryUnknownWithEvidence: true,
    responder: {
      async respond() {
        calls += 1;
        if (calls === 2) {
          throw new Error("retry timed out");
        }
        return {
          text: "unknown",
          tokens: { input: 5, output: 1 },
          latencyMs: 6,
          model: "first-model",
        };
      },
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.finalAnswer, "unknown");
  assert.deepEqual(result.tokens, { input: 5, output: 1 });
  assert.equal(result.latencyMs, 6);
  assert.equal(result.model, "first-model");
});

test("strict question builder preserves structured protocols", () => {
  assert.equal(
    inferAnswerFormat("Choices:\nA. Tea\nB. Coffee\nPlease output the correct option"),
    "choice-letter",
  );
  assert.equal(
    inferAnswerFormat("Answer choices:\n1. Tea\n2. Coffee"),
    "choice-number",
  );
  assert.match(
    buildStrictBenchmarkQuestion("Final output format:\n=== Traveler Plan ==="),
    /Preserve the requested structured output format exactly/,
  );
});

test("agentic-memory question builder preserves strict safety while allowing trajectory inference", () => {
  const prompt = buildAgenticMemoryBenchmarkQuestion(
    "What would have happened if the agent moved down?",
  );

  assert.match(prompt, /Use only the supplied Remnic memory context as evidence/);
  assert.match(prompt, /what would have happened/);
  assert.match(prompt, /synthesize the best-supported explanation/);
  assert.match(prompt, /do not name a later action outside the range/);
  assert.match(prompt, /reconcile the mismatch from the adjacent evidence/);
  assert.match(prompt, /Action N causes Observation N/);
  assert.match(prompt, /opposing movement sequences/);
  assert.match(prompt, /Do not answer "unknown" merely because the answer requires inference/);
});

test("unknown retry helper preserves the original prompt and answer format constraints", () => {
  const prompt = buildUnknownRetryQuestion(
    "What happened?\n\nBenchmark answer protocol:",
    "structured",
  );

  assert.match(prompt, /What happened\?/);
  assert.match(prompt, /prior answer was only "unknown"/);
  assert.match(prompt, /Preserve the requested structured output format exactly/);
});

test("unknown and explicit trajectory evidence helpers are conservative", () => {
  assert.equal(isUnknownOnlyAnswer("unknown"), true);
  assert.equal(isUnknownOnlyAnswer("\"The answer is unknown.\""), true);
  assert.equal(
    isUnknownOnlyAnswer(`${'"'.repeat(5_000)}unknown${'"'.repeat(5_000)}`),
    true,
  );
  assert.equal(isUnknownOnlyAnswer("unknown from the context"), false);
  assert.equal(
    hasExplicitTrajectoryEvidence(
      "## Explicit Cue Evidence\n[Action 3]: up\n[Observation 3]: the key moved closer",
    ),
    true,
  );
  assert.equal(
    hasExplicitTrajectoryEvidence(
      "## Explicit Cue Evidence\nThe key moved closer without cited steps",
    ),
    false,
  );
  assert.equal(
    hasExplicitTrajectoryEvidence(
      "## Remnic recall pipeline\n[Action 3]: up\n[Observation 3]: the key moved closer",
    ),
    true,
  );
  assert.equal(
    hasExplicitTrajectoryEvidence(
      "##Explicit Cue Evidence\n[Action 3]: up",
    ),
    false,
  );
  assert.equal(
    hasExplicitTrajectoryEvidence(
      '## Search evidence\nThe note quoted "[Action 3]: up" as an example label.',
    ),
    false,
  );
  assert.equal(
    hasExplicitTrajectoryEvidence(
      [
        "## Search evidence",
        "[ama-ep-1, turn 6, user]: The note quoted an example.",
        "[Action 3]: up",
      ].join("\n"),
    ),
    false,
  );
  assert.equal(
    hasExplicitTrajectoryEvidence(
      "##\tExplicit Cue Evidence\r\n[Observation 12]: the key moved closer",
    ),
    true,
  );
  assert.equal(
    hasExplicitTrajectoryEvidence(
      "## Explicit Cue Evidence\n[Action\t12]: the key moved closer",
    ),
    true,
  );
  assert.equal(
    hasExplicitTrajectoryEvidence(
      "## Explicit Cue Evidence\n[Action  12]: the key moved closer",
    ),
    true,
  );
});

test("strict question builder preserves free-form summarization prompts", () => {
  const question = [
    "You are given a book above and you are tasked to summarize it.",
    "Now summarize the book.",
  ].join("\n");

  assert.equal(inferAnswerFormat(question), "auto");
  assert.doesNotMatch(
    buildStrictBenchmarkQuestion(question),
    /shortest complete answer/,
  );
  assert.match(
    buildStrictBenchmarkQuestion(question, "short"),
    /shortest complete answer/,
  );
});

test("strict question builder reserves unknown for genuinely missing evidence", () => {
  const prompt = buildStrictBenchmarkQuestion("What code did I save?");

  assert.match(prompt, /best supported answer/);
  assert.match(prompt, /only when the supplied context has no relevant evidence/);
  assert.doesNotMatch(prompt, /If the context is insufficient, answer "unknown"/);
});

test("strict question builder supports concise answers with required specifics", () => {
  const question = "How many columns did I add?";
  const prompt = buildStrictBenchmarkQuestion(question, "short-with-specifics");

  assert.match(prompt, /shortest complete answer/);
  assert.match(prompt, /concrete named items/);
  assert.match(prompt, /Two columns: category and notes/);
  assert.match(prompt, /without hedge words/);
  assert.match(prompt, /Prefer exact values/);
});

test("strict question builder can answer remembered instructions", () => {
  const prompt = buildStrictBenchmarkQuestion(
    "Could you show me how to implement a login feature?",
    "instruction",
  );

  assert.match(prompt, /answer with that remembered instruction/);
  assert.match(prompt, /instead of performing the requested task/);
  assert.match(prompt, /Always format implementation help/);
  assert.match(prompt, /Do not quote a "please remember" request verbatim/);
  assert.match(prompt, /code blocks with syntax highlighting/);
  assert.match(prompt, /do not answer "unknown"/);
});
