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
  assert.deepEqual(result.questions, []);
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

test("extraction uses context-only turns to resolve asserted target references", async () => {
  const engine = fixtureEngine({
    localLlmEnabled: true,
    localLlmModel: "fixture-local",
    localLlmFallback: false,
  });
  Object.assign(engine, {
    localLlm: {
      async chatCompletion() {
        return {
          content: JSON.stringify({
            facts: [
              {
                category: "fact",
                content: "The database uses PostgreSQL.",
                confidence: 0.9,
                tags: [],
              },
              {
                category: "fact",
                content: "The user prefers dark mode in all editors.",
                confidence: 0.9,
                tags: [],
              },
            ],
            profileUpdates: [],
            entities: [],
            questions: [],
          }),
        };
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

  const result = await engine.extract([
    {
      role: "user",
      content: "Should the database use PostgreSQL?",
      timestamp: "2026-07-25T12:00:00.000Z",
      extractionContextOnly: true,
    },
    {
      role: "user",
      content: "Yes, use that.",
      timestamp: "2026-07-25T12:00:01.000Z",
    },
  ]);

  assert.deepEqual(result.facts.map((fact) => fact.content), ["The database uses PostgreSQL."]);
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
test("grounding matches the relevant repeated source occurrence", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [
        {
          category: "fact",
          content: "Blue is supported for accents.",
          confidence: 0.9,
          tags: [],
        },
        {
          category: "fact",
          content: "Blue is supported for backgrounds.",
          confidence: 0.9,
          tags: [],
        },
        {
          category: "fact",
          content: "Blue is not supported for backgrounds.",
          confidence: 0.9,
          tags: [],
        },
      ],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Blue is supported for accents. Blue is not supported for backgrounds.",
  );

  assert.deepEqual(
    result.facts.map((fact) => fact.content),
    ["Blue is supported for accents.", "Blue is not supported for backgrounds."],
  );
});

test("grounding filters unsupported durable fact fields and nested entity facts", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [
        {
          category: "fact",
          content: "The deployment finished yesterday.",
          confidence: 0.9,
          tags: [],
          structuredAttributes: {
            status: "complete",
            provider: "unknown-cloud",
          },
          eventTime: "yesterday",
        },
        {
          category: "procedure",
          content: "How to deploy staging",
          confidence: 0.9,
          tags: [],
          procedureSteps: [
            {
              order: 1,
              intent: "first run tests",
              expectedOutcome: "tests pass",
              toolCall: { kind: "shell", signature: "run-tests" },
            },
            {
              order: 2,
              intent: "invent a secret deployment step",
            },
            {
              order: 3,
              intent: "then deploy service",
              expectedOutcome: "secret outcome",
              toolCall: { kind: "shell", signature: "invent-secret-command" },
            },
          ],
        },
        {
          category: "reasoning_trace",
          content: "How I debugged latency",
          confidence: 0.9,
          tags: [],
          reasoningTrace: {
            steps: [
              { order: 1, description: "first inspect logs" },
              { order: 2, description: "then compare traces" },
            ],
            finalAnswer: "increase timeout",
            observedOutcome: "the service recovered",
          },
        },
      ],
      profileUpdates: [],
      entities: [
        {
          name: "Moonlight",
          type: "project",
          facts: ["Moonlight's theme color is green.", "Moonlight has a secret plan."],
          structuredSections: [
            {
              key: "appearance",
              title: "Appearance",
              facts: ["Moonlight's theme color is green.", "Moonlight runs on Mars."],
            },
          ],
        },
      ],
      questions: [],
    },
    [
      "The deployment finished yesterday; its status is complete.",
      "To deploy staging, first run tests, then deploy the service. Tests pass. The shell command is run-tests.",
      "How I debugged latency: first inspect logs, then compare traces. The answer is increase timeout.",
      "Moonlight's theme color is green.",
    ].join(" "),
  );

  assert.deepEqual(result.facts[0]?.structuredAttributes, { status: "complete" });
  assert.equal(result.facts[0]?.eventTime, "yesterday");
  assert.deepEqual(result.facts[1]?.procedureSteps, [
    {
      order: 1,
      intent: "first run tests",
      expectedOutcome: "tests pass",
      toolCall: { kind: "shell", signature: "run-tests" },
    },
    {
      order: 3,
      intent: "then deploy service",
    },
  ]);
  assert.deepEqual(result.facts[2]?.reasoningTrace, {
    steps: [
      { order: 1, description: "first inspect logs" },
      { order: 2, description: "then compare traces" },
    ],
    finalAnswer: "increase timeout",
  });
  assert.deepEqual(result.entities, [
    {
      name: "Moonlight",
      type: "project",
      facts: ["Moonlight's theme color is green."],
      structuredSections: [
        {
          key: "appearance",
          title: "Appearance",
          facts: ["Moonlight's theme color is green."],
        },
      ],
    },
  ]);
});

test("grounding drops entities with no grounded facts", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [],
      profileUpdates: [],
      entities: [
        {
          name: "Moonlight",
          type: "project",
          facts: ["Moonlight has an unsupported secret plan."],
          structuredSections: [
            {
              key: "details",
              title: "Details",
              facts: ["Moonlight runs on Mars."],
            },
          ],
        },
      ],
      questions: [],
    },
    "Moonlight is a project.",
  );

  assert.deepEqual(result.entities, []);
});

test("grounding rejects an unsupported appended clause", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [
        {
          category: "fact",
          content: "Alice works at Acme and secretly owns Mars.",
          confidence: 0.9,
          tags: [],
        },
      ],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Alice works at Acme.",
  );

  assert.deepEqual(result.facts, []);
});

test("grounding matches normalized entity identifiers", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [],
      profileUpdates: [],
      entities: [
        {
          name: "acme-corp",
          type: "company",
          facts: ["Acme Corp uses PostgreSQL."],
        },
        {
          name: "art",
          type: "project",
          facts: ["Cart is shipped."],
        },
      ],
      relationships: [
        {
          source: "company-acme-corp",
          target: "tool-postgresql",
          label: "uses",
        },
      ],

      questions: [],
    },
    "Acme Corp uses PostgreSQL. Cart is shipped.",
  );

  assert.deepEqual(result.entities.map((entity) => entity.name), ["acme-corp"]);
  assert.deepEqual(result.relationships, [
    {
      source: "company-acme-corp",
      target: "tool-postgresql",
      label: "uses",
    },
  ]);
});

test("grounding rejects a relationship label unsupported by the source span", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [],
      profileUpdates: [],
      entities: [],
      relationships: [
        {
          source: "person-alice",
          target: "company-acme",
          label: "works at",
        },
      ],
      questions: [],
    },
    "Alice criticized Acme.",
  );

  assert.deepEqual(result.relationships, []);
});

test("grounding does not treat questions or hypotheticals as factual evidence", () => {
  const questionResult = filterExtractionResultBySource(
    {
      facts: [
        {
          category: "fact",
          content: "Alice is the CEO at Acme.",
          confidence: 0.9,
          tags: [],
        },
      ],
      profileUpdates: ["Alice is the CEO at Acme."],
      entities: [],
      questions: [{ question: "Is Alice the CEO at Acme?", context: "", priority: 0.5 }],
    },
    "Is Alice the CEO at Acme?",
    "Is Alice the CEO at Acme?",
  );
  assert.deepEqual(questionResult.facts, []);
  assert.deepEqual(questionResult.profileUpdates, []);
  assert.deepEqual(questionResult.questions, [
    { question: "Is Alice the CEO at Acme?", context: "", priority: 0.5 },
  ]);

  const answeredResult = filterExtractionResultBySource(
    {
      facts: [],
      profileUpdates: [],
      entities: [],
      questions: [{ question: "Does Alice work at Acme?", context: "", priority: 0.5 }],
    },
    "Alice works at Acme.",
  );
  assert.deepEqual(answeredResult.questions, []);

  const partialOverlapResult = filterExtractionResultBySource(
    {
      facts: [],
      profileUpdates: [],
      entities: [],
      questions: [{ question: "Does Alice work at Globex?", context: "", priority: 0.5 }],
    },
    "Alice works at Acme. Globex is a company.",
  );
  assert.deepEqual(partialOverlapResult.questions, [
    { question: "Does Alice work at Globex?", context: "", priority: 0.5 },
  ]);

  const unknownAnswerResult = filterExtractionResultBySource(
    {
      facts: [],
      profileUpdates: [],
      entities: [],
      questions: [{ question: "What is the deployment deadline?", context: "", priority: 0.5 }],
    },
    "The deployment deadline is unknown.",
  );
  assert.deepEqual(unknownAnswerResult.questions, [
    { question: "What is the deployment deadline?", context: "", priority: 0.5 },
  ]);

  const hypotheticalResult = filterExtractionResultBySource(
    {
      facts: [
        {
          category: "fact",
          content: "Alice is the CEO at Acme.",
          confidence: 0.9,
          tags: [],
        },
      ],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "If Alice were the CEO at Acme, we could proceed.",
  );
  assert.deepEqual(hypotheticalResult.facts, []);
});

test("grounding preserves exact dotted identifiers", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [
        {
          category: "fact",
          content: "The package is com.example.platform.billing.service.",
          confidence: 0.9,
          tags: [],
        },
      ],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "The package is com.example.platform.billing.service.",
  );

  assert.equal(result.facts.length, 1);
});

test("grounding joins context questions to asserted target turns", () => {
  const source = "Should the database use PostgreSQL? Yes, use that.";
  const result = filterExtractionResultBySource(
    {
      facts: [
        {
          category: "fact",
          content: "The database uses PostgreSQL.",
          confidence: 0.9,
          tags: [],
        },
      ],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    source,
    "Yes, use that.",
  );
  assert.equal(result.facts.length, 1);

  const unsupported = filterExtractionResultBySource(
    {
      facts: [
        {
          category: "fact",
          content: "The database uses PostgreSQL.",
          confidence: 0.9,
          tags: [],
        },
      ],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    source,
    "I do not know.",
  );
  assert.deepEqual(unsupported.facts, []);
});

test("proactive extraction grounds before delinearization", async () => {
  const engine = fixtureEngine({
    localLlmEnabled: true,
    localLlmModel: "fixture-local",
    localLlmFallback: false,
    proactiveExtractionEnabled: true,
    maxProactiveQuestionsPerExtraction: 1,
  });
  Object.assign(engine, {
    localLlm: {
      async chatCompletion(messages: Array<{ role: string; content: string }>) {
        const prompt = messages[1]?.content ?? "";
        if (prompt.startsWith("You are doing a proactive second-pass")) {
          return {
            content: JSON.stringify({
              questions: [{ question: "When did the deployment finish?", context: "", priority: 0.5 }],
            }),
          };
        }
        if (prompt.startsWith("You are answering proactive memory follow-up questions")) {
          return {
            content: JSON.stringify({
              facts: [
                {
                  category: "fact",
                  content: "The deployment finished yesterday.",
                  confidence: 0.95,
                  tags: [],
                },
              ],
              profileUpdates: [],
              entities: [],
              relationships: [],
            }),
          };
        }
        return { content: JSON.stringify({ facts: [], profileUpdates: [], entities: [], questions: [] }) };
      },
      isBackgroundLaneContended: () => false,
    },
    modelRegistry: {
      calculateContextSizes: () => ({
        maxInputChars: 8_000,
        maxOutputTokens: 1_000,
        description: "fixture",
      }),
    },
  });

  const result = await engine.extract([{
    ...OBSERVED_TURN,
    content: "The deployment finished yesterday.",
  }]);

  assert.deepEqual(result.facts.map((fact) => fact.content), ["The deployment finished on 2026-07-24."]);
});
