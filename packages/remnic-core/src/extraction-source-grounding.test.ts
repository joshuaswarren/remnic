import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";
import { ExtractionEngine } from "./extraction.js";
import { filterExtractionResultBySource } from "./extraction-source-grounding.js";
import type { ExtractionResult } from "./types.js";

const OBSERVED_TURN = {
  role: "user" as const,
  content: "Moonlight's theme color is green, not blue. The deployment finished yesterday.",
  timestamp: "2026-07-25T12:00:00.000Z",
};

const CONTEXT_ONLY_TURN = {
  role: "user" as const,
  content: "The user prefers dark mode in all editors.",
  timestamp: "2026-07-25T12:00:01.000Z",
  extractionContextOnly: true as const,
};

const MODEL_RESULT: ExtractionResult = {
  facts: [
    {
      category: "correction",
      content: "Moonlight uses green rather than blue for its theme color.",
      confidence: 0.95,
      tags: [],
    },
    {
      category: "fact",
      content: "The user prefers dark mode in all editors.",
      confidence: 0.9,
      tags: [],
    },
    {
      category: "fact",
      content: "The deployment finished yesterday.",
      confidence: 0.9,
      tags: [],
    },
    {
      category: "fact",
      content: "Moonlight uses blue for its theme color.",
      confidence: 0.9,
      tags: [],
    },
  ],
  profileUpdates: [
    "The user corrected Moonlight's theme color to green.",
    "User prefers dark mode in all editors",
    "Moonlight's theme color is blue.",
  ],
  entities: [],
  questions: [
    {
      question: "What is Moonlight's theme color?",
      context: "Theme color discussion",
      priority: 0.5,
    },
    {
      question: "Which cloud provider hosts the staging environment?",
      context: "Deployment discussion",
      priority: 0.5,
    },
    {
      question: "What is Moonlight's theme color?",
      context: "Deployment discussion",
      priority: 0.5,
    },
  ],
};

function assertGroundedResult(result: ExtractionResult): void {
  assert.deepEqual(
    result.facts.map((fact) => fact.content),
    [
      "Moonlight uses green rather than blue for its theme color.",
      "The deployment finished on 2026-07-24.",
    ],
  );

  assert.deepEqual(
    result.profileUpdates,
    ["The user corrected Moonlight's theme color to green."],
  );
  assert.deepEqual(result.questions, [MODEL_RESULT.questions[0]]);
}

test("contradictory source polarity is rejected instead of passing token overlap", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [
        {
          category: "fact",
          content: "Moonlight uses blue for its theme color.",
          confidence: 0.9,
          tags: [],
        },
        {
          category: "fact",
          content: "blue",
          confidence: 0.9,
          tags: [],
        },
      ],
      profileUpdates: ["Moonlight's theme color is blue."],
      entities: [],
      questions: [],
    },
    OBSERVED_TURN.content,
  );

  assert.deepEqual(result.facts, []);
  assert.deepEqual(result.profileUpdates, []);
});

test("source-language corrections remain grounded when the model copies a source span", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [
        {
          category: "correction",
          content: "Moonlightのテーマカラーは青ではなく緑です。",
          confidence: 0.95,
          tags: [],
        },
        {
          category: "fact",
          content: "The user prefers dark mode in all editors.",
          confidence: 0.9,
          tags: [],
        },
      ],
      profileUpdates: [
        "Moonlightのテーマカラーは青ではなく緑です。",
        "User prefers dark mode in all editors",
      ],
      entities: [],
      questions: [],
    },
    "Moonlightのテーマカラーは青です。訂正します。Moonlightのテーマカラーは青ではなく緑です。",
  );

  assert.deepEqual(result.facts.map((fact) => fact.content), ["Moonlightのテーマカラーは青ではなく緑です。"]);
  assert.deepEqual(result.profileUpdates, ["Moonlightのテーマカラーは青ではなく緑です。"]);
});

function fixtureEngine(configInput: Record<string, unknown>): ExtractionEngine {
  return new ExtractionEngine(parseConfig(configInput));
}

test("local extraction drops unsupported facts, profile updates, and questions but keeps paraphrases", async () => {
  const engine = fixtureEngine({
    localLlmEnabled: true,
    localLlmModel: "fixture-local",
    localLlmFallback: false,
  });
  Object.assign(engine, {
    localLlm: {
      async chatCompletion() {
        return { content: JSON.stringify(MODEL_RESULT) };
      },
    },
    modelRegistry: {
      calculateContextSizes: () => ({
        maxInputChars: 8_000,
        maxOutputTokens: 1_000,
        description: "fixture",
      }),
    },
  });

  const result = await engine.extract([OBSERVED_TURN, CONTEXT_ONLY_TURN]);

  assertGroundedResult(result);
});

test("source grounding can be disabled for legacy extraction behavior", async () => {
  const engine = fixtureEngine({
    extractionSourceGroundingEnabled: "false",
    localLlmEnabled: true,
    localLlmModel: "fixture-local",
    localLlmFallback: false,
  });
  Object.assign(engine, {
    localLlm: {
      async chatCompletion() {
        return { content: JSON.stringify(MODEL_RESULT) };
      },
    },
    modelRegistry: {
      calculateContextSizes: () => ({
        maxInputChars: 8_000,
        maxOutputTokens: 1_000,
        description: "fixture",
      }),
    },
  });

  const result = await engine.extract([OBSERVED_TURN, CONTEXT_ONLY_TURN]);

  assert.equal(result.facts.length, MODEL_RESULT.facts.length);
  assert.ok(result.facts.some((fact) => fact.content === "Moonlight uses blue for its theme color."));
  assert.ok(result.profileUpdates.includes("Moonlight's theme color is blue."));
  assert.equal(result.questions.length, MODEL_RESULT.questions.length);
});

test("direct extraction applies source grounding to the same output contract", async () => {
  const engine = fixtureEngine({ openaiApiKey: "fixture-key" });
  Object.assign(engine, {
    client: {
      chat: {
        completions: {
          async create() {
            return { choices: [{ message: { content: JSON.stringify(MODEL_RESULT) } }] };
          },
        },
      },
    },
  });

  const result = await engine.extract([OBSERVED_TURN, CONTEXT_ONLY_TURN]);

  assertGroundedResult(result);
});

test("gateway extraction applies source grounding to the same output contract", async () => {
  const engine = fixtureEngine({ modelSource: "gateway" });
  Object.assign(engine, {
    fallbackLlm: {
      async parseWithSchemaDetailed() {
        return { modelUsed: "fixture-gateway", result: MODEL_RESULT };
      },
    },
  });

  const result = await engine.extract([OBSERVED_TURN, CONTEXT_ONLY_TURN]);

  assertGroundedResult(result);
});
