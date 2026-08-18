import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";
import { ExtractionEngine } from "./extraction.js";
import {
  applyExtractionSourceGrounding,
  filterExtractionResultBySource,
} from "./extraction-source-grounding.js";
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

test("grounding does not let context questions establish unsupported facts", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "Alice works at Acme.",
        confidence: 0.9,
        tags: [],
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Does Alice work at Acme?\n\nAlice joined the call.",
    "Alice joined the call.",
  );

  assert.deepEqual(result.facts, []);
});

test("grounding splits unpunctuated turns before evaluating facts", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "PostgreSQL is the selected database.",
        confidence: 0.9,
        tags: [],
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "What database should we select\n\nPostgreSQL is the selected database.",
    "PostgreSQL is the selected database.",
  );

  assert.deepEqual(result.facts.map((fact) => fact.content), ["PostgreSQL is the selected database."]);
});

test("grounding excludes auxiliary fields sourced only from questions", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "The deployment finished.",
        confidence: 0.9,
        tags: [],
        structuredAttributes: { owner: "Alice" },
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "The deployment finished.\nIs Alice the owner?",
    "The deployment finished.",
  );

  assert.deepEqual(result.facts.map((fact) => fact.content), ["The deployment finished."]);
  assert.equal(result.facts[0]?.structuredAttributes, undefined);
});

test("grounding rejects swapped role-normalized fact arguments", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "The user supports Acme.",
        confidence: 0.9,
        tags: [],
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Acme supports me.",
    "Acme supports me.",
    { profile: "Acme supports me." },
  );

  assert.deepEqual(result.facts, []);
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

  const affirmativeFactResult = filterExtractionResultBySource(
    {
      facts: [
        {
          category: "fact",
          content: "Alice works at Acme.",
          confidence: 0.9,
          tags: [],
        },
      ],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Does Alice work at Acme?\nYes.",
  );
  assert.deepEqual(affirmativeFactResult.facts, [
    {
      category: "fact",
      content: "Alice works at Acme.",
      confidence: 0.9,
      tags: [],
    },
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

  const bareAnswerResult = filterExtractionResultBySource(
    {
      facts: [],
      profileUpdates: [],
      entities: [],
      questions: [{ question: "Does Alice work at Acme?", context: "", priority: 0.5 }],
    },
    "Does Alice work at Acme?\nYes.",
  );
  assert.deepEqual(bareAnswerResult.questions, []);

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


  const nonAnswerResult = filterExtractionResultBySource(
    {
      facts: [],
      profileUpdates: [],
      entities: [],
      questions: [{ question: "What is the Acme deployment deadline?", context: "", priority: 0.5 }],
    },
    "Acme deployment is delayed.",
  );
  assert.deepEqual(nonAnswerResult.questions, [
    { question: "What is the Acme deployment deadline?", context: "", priority: 0.5 },
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

test("grounding splits turn-delimited questions before affirmative answers", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "The database uses PostgreSQL.",
        confidence: 0.9,
        tags: [],
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Should the database use PostgreSQL\n\nYes, use that.",
    "Yes, use that.",
  );

  assert.equal(result.facts.length, 1);
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

test("grounding evaluates exact matches in their source sentence", () => {
  const result = filterExtractionResultBySource(
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
      questions: [],
    },
    "We discussed staffing. Do we know that Alice is the CEO at Acme? Bob joined the call.",
  );

  assert.deepEqual(result.facts, []);
  assert.deepEqual(result.profileUpdates, []);
});

test("grounding rejects embedded whether questions as factual evidence", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [
        {
          category: "fact",
          content: "Alice uses PostgreSQL.",
          confidence: 0.9,
          tags: [],
        },
      ],
      profileUpdates: ["Alice uses PostgreSQL."],
      entities: [],
      questions: [],
    },
    "We need to determine whether Alice uses PostgreSQL.",
  );

  assert.deepEqual(result.facts, []);
  assert.deepEqual(result.profileUpdates, []);
});
test("grounding rejects comma-spliced unsupported claims", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "Alice works at Acme, Bob owns Mars.",
        confidence: 0.9,
        tags: [],
      }],
      profileUpdates: ["Alice works at Acme, Bob owns Mars."],
      entities: [],
      questions: [],
    },
    "Alice works at Acme.",
  );

  assert.deepEqual(result.facts, []);
  assert.deepEqual(result.profileUpdates, []);
});

test("grounding preserves a supported question while clearing unsupported context", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [],
      profileUpdates: [],
      entities: [],
      questions: [{
        question: "Which database should we use?",
        context: "This blocks the launch schedule.",
        priority: 0.5,
      }],
    },
    "Which database should we use?",
  );

  assert.deepEqual(result.questions, [{
    question: "Which database should we use?",
    context: "",
    priority: 0.5,
  }]);
});

test("grounding keeps affirmative facts answered by context-only questions", () => {
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
    "Should the database use PostgreSQL?\nYes.",
    "Yes.",
  );

  assert.deepEqual(result.facts.map((fact) => fact.content), ["The database uses PostgreSQL."]);
});

test("speaker-aware grounding keeps profile and identity evidence from their own roles", async () => {
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
            facts: [],
            profileUpdates: [
              "The user works at Acme.",
              "The user works at Globex.",
            ],
            entities: [],
            questions: [],
            identityReflection: "The assistant works at Acme.",
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
      role: "assistant",
      content: "I work at Acme.",
      timestamp: "2026-07-25T12:00:00.000Z",
    },
    {
      role: "user",
      content: "I work at Globex.",
      timestamp: "2026-07-25T12:00:01.000Z",
    },
  ]);

  assert.deepEqual(result.profileUpdates, ["The user works at Globex."]);
  assert.equal(result.identityReflection, "The assistant works at Acme.");
});

test("grounding rejects substring matches that do not preserve token boundaries", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [
        {
          category: "fact",
          content: "Art is archived.",
          confidence: 0.9,
          tags: [],
        },
      ],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Cart is archived.",
  );

  assert.deepEqual(result.facts, []);
});
test("grounding rejects subject-swapped overlap claims", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [
        {
          category: "fact",
          content: "Bob works at Acme.",
          confidence: 0.9,
          tags: [],
        },
      ],
      profileUpdates: ["Bob works at Acme."],
      entities: [],
      questions: [],
    },
    "Alice works at Acme.",
  );

  assert.deepEqual(result.facts, []);
  assert.deepEqual(result.profileUpdates, []);
});

test("grounding rejects claims with unsupported object values", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "Alice uses Windows.",
        confidence: 0.9,
        tags: [],
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Alice uses Linux.",
  );

  assert.deepEqual(result.facts, []);
});

test("grounding rejects claims with reversed argument order", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "Alice supports Acme.",
        confidence: 0.9,
        tags: [],
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Acme supports Alice.",
  );

  assert.deepEqual(result.facts, []);
});

test("grounding compares polarity within one source occurrence", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "Alice works at Acme.",
        confidence: 0.9,
        tags: [],
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Alice does not work at Acme, but Alice works at Globex.",
  );

  assert.deepEqual(result.facts, []);
});

test("grounding rejects overlap with a differing object", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "Alice works at Acme.",
        confidence: 0.9,
        tags: [],
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Alice works at Globex.",
  );

  assert.deepEqual(result.facts, []);
});

test("grounding rejects structured attributes sourced only from unanswered questions", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "The deployment finished.",
        confidence: 0.9,
        tags: [],
        structuredAttributes: { owner: "Alice" },
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "The deployment finished. Is Alice the owner?",
  );

  assert.deepEqual(result.facts, [{
    category: "fact",
    content: "The deployment finished.",
    confidence: 0.9,
    tags: [],
  }]);
});

test("grounding removes unsupported fact entity references", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "Alice works at Acme.",
        confidence: 0.9,
        tags: [],
        entityRef: "person-bob",
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Alice works at Acme.",
  );

  assert.deepEqual(result.facts, [{
    category: "fact",
    content: "Alice works at Acme.",
    confidence: 0.9,
    tags: [],
  }]);
});

test("grounding preserves short role-normalized profile traits", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [],
      profileUpdates: ["The user is vegan."],
      entities: [],
      questions: [],
    },
    "I am vegan.",
  );

  assert.deepEqual(result.profileUpdates, ["The user is vegan."]);
});

test("grounding rejects role-normalized profile claims with swapped arguments", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [],
      profileUpdates: ["The user supports Acme."],
      entities: [],
      questions: [],
    },
    "Acme supports me.",
  );

  assert.deepEqual(result.profileUpdates, []);
});

test("grounding rejects punctuation-delimited appended claims", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "Alice works at Acme. Bob owns Mars.",
        confidence: 0.9,
        tags: [],
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Alice works at Acme.",
  );

  assert.deepEqual(result.facts, []);
});

test("grounding rejects context-only claims with a subject-only assertion anchor", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "Alice works at Acme.",
        confidence: 0.9,
        tags: [],
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Alice works at Acme. Alice called Bob.",
    "Alice called Bob.",
  );

  assert.deepEqual(result.facts, []);
});
test("grounding keeps bare negative answers as negative facts", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "The database does not use PostgreSQL.",
        confidence: 0.9,
        tags: [],
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Does the database use PostgreSQL?\nNo.",
    "No.",
  );

  assert.deepEqual(result.facts.map((fact) => fact.content), ["The database does not use PostgreSQL."]);
});

test("grounding scopes fact role normalization to the matching speaker", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [
        {
          category: "fact",
          content: "The user is vegan.",
          confidence: 0.9,
          tags: [],
        },
        {
          category: "fact",
          content: "The user is a cyclist.",
          confidence: 0.9,
          tags: [],
        },
      ],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "I am vegan.\nI am a cyclist.",
    undefined,
    {
      profile: "I am vegan.",
      identity: "I am a cyclist.",
    },
  );

  assert.deepEqual(result.facts.map((fact) => fact.content), ["The user is vegan."]);
});

test("grounding drops fact entity refs found only in context source", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "Alice works at Acme.",
        confidence: 0.9,
        tags: [],
        entityRef: "company-globex",
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Alice works at Acme.\nWhich company is Globex?",
    "Alice works at Acme.",
  );

  assert.deepEqual(result.facts, [{
    category: "fact",
    content: "Alice works at Acme.",
    confidence: 0.9,
    tags: [],
  }]);
});

test("grounding preserves identifier terminal s instead of stemming names", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [
        {
          category: "fact",
          content: "Alice uses Redi.",
          confidence: 0.9,
          tags: [],
        },
        {
          category: "fact",
          content: "Jame works at Acme.",
          confidence: 0.9,
          tags: [],
        },
      ],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Alice uses Redis. James works at Acme.",
  );

  assert.deepEqual(result.facts, []);
});
test("grounding rejects exact propositions embedded in explicit denials", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "Alice works at Acme.",
        confidence: 0.9,
        tags: [],
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "The claim that Alice works at Acme is false.",
  );

  assert.deepEqual(result.facts, []);
});

test("grounding preserves wh-questions when an assertion reverses their roles", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [],
      profileUpdates: [],
      entities: [],
      questions: [{ question: "Who employs Alice?", context: "", priority: 0.5 }],
    },
    "Who employs Alice? Alice employs Acme.",
  );

  assert.deepEqual(result.questions, [{
    question: "Who employs Alice?",
    context: "",
    priority: 0.5,
  }]);
});

test("grounding clears question context that is supported only by the question", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [],
      profileUpdates: [],
      entities: [],
      questions: [{
        question: "Does Alice use PostgreSQL?",
        context: "Alice uses PostgreSQL.",
        priority: 0.5,
      }],
    },
    "Does Alice use PostgreSQL?",
  );

  assert.deepEqual(result.questions, [{
    question: "Does Alice use PostgreSQL?",
    context: "",
    priority: 0.5,
  }]);
});
test("grounding rejects predicate mismatches with shared subject and object", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "Alice supports Acme.",
        confidence: 0.9,
        tags: [],
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Alice criticized Acme.",
  );

  assert.deepEqual(result.facts, []);
});

test("grounding keeps eventTime tied to the fact's supporting sentence", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "Alice deployed Acme.",
        confidence: 0.9,
        tags: [],
        eventTime: "yesterday",
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Alice deployed Acme today. Bob left yesterday.",
  );

  assert.deepEqual(result.facts, [{
    category: "fact",
    content: "Alice deployed Acme.",
    confidence: 0.9,
    tags: [],
  }]);
});

test("grounding rejects colon-suffixed unresolved questions", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "Alice works at Acme.",
        confidence: 0.9,
        tags: [],
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Alice works at Acme: yes or no?",
  );

  assert.deepEqual(result.facts, []);
});
test("grounding accepts doubled-consonant verb inflection paraphrases", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "Alice runs Redis.",
        confidence: 0.9,
        tags: [],
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Alice is running Redis.",
  );

  assert.deepEqual(result.facts.map((fact) => fact.content), ["Alice runs Redis."]);
});

test("grounding accepts qualified affirmative answers", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "Alice works at Acme.",
        confidence: 0.9,
        tags: [],
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Does Alice work at Acme?\nYes, absolutely.",
  );

  assert.deepEqual(result.facts.map((fact) => fact.content), ["Alice works at Acme."]);
});

test("grounding answers object wh-questions with aligned evidence", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [],
      profileUpdates: [],
      entities: [],
      questions: [{ question: "What database does Alice use?", context: "", priority: 0.5 }],
    },
    "What database does Alice use?\nAlice uses PostgreSQL as the database.",
  );

  assert.deepEqual(result.questions, []);
});

test("grounding accepts e-dropping past-tense verb paraphrases", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "Alice agreed with Acme.",
        confidence: 0.9,
        tags: [],
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Alice agree with Acme.",
  );

  assert.deepEqual(result.facts.map((fact) => fact.content), ["Alice agreed with Acme."]);
});

test("grounding does not swallow factual yes-or-no-prefixed sentences", () => {
  const yesResult = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "The release is Friday.",
        confidence: 0.9,
        tags: [],
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Yes, the release is Friday.",
  );
  const noResult = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "No one is on call.",
        confidence: 0.9,
        tags: [],
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "No one is on call.",
  );

  assert.deepEqual(yesResult.facts.map((fact) => fact.content), ["The release is Friday."]);
  assert.deepEqual(noResult.facts.map((fact) => fact.content), ["No one is on call."]);
});

test("grounding binds affirmative answer support to the asserted answer turn", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "Alice works at Acme.",
        confidence: 0.9,
        tags: [],
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Does Alice work at Acme?\nYes.\nYes, Bob joined the call.",
    "Yes, Bob joined the call.",
  );

  assert.deepEqual(result.facts, []);
});

test("grounding excludes unanswered questions from procedure evidence", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "procedure",
        content: "The deployment runbook is documented.",
        confidence: 0.9,
        tags: [],
        procedureSteps: [{ order: 1, intent: "delete backups first" }],
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "The deployment runbook is documented. Should operators delete backups first?",
  );

  assert.deepEqual(result.facts[0]?.procedureSteps ?? [], []);
});

test("grounding selects eventTime from the supporting fact sentence", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "Alice deployed Acme.",
        confidence: 0.9,
        tags: [],
        eventTime: "yesterday",
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Alice deployed Acme. Alice deployed Acme yesterday.",
  );

  assert.equal(result.facts[0]?.eventTime, "yesterday");
});

test("grounding scopes reasoning traces to the fact's role source", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "User works at Acme.",
        confidence: 0.9,
        tags: [],
        reasoningTrace: {
          steps: [{ order: 1, description: "User uses PostgreSQL." }],
          finalAnswer: "User uses PostgreSQL.",
        },
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "I work at Acme.\nI use PostgreSQL.",
    undefined,
    {
      profile: "I work at Acme.",
      identity: "",
    },
  );

  assert.equal(result.facts[0]?.content, "User works at Acme.");
  assert.equal(result.facts[0]?.reasoningTrace, undefined);
});

test("grounding excludes unanswered questions from reasoning traces", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "The incident analysis is recorded.",
        confidence: 0.9,
        tags: [],
        reasoningTrace: {
          steps: [{ order: 1, description: "Alice deleted backups." }],
          finalAnswer: "Alice deleted backups.",
        },
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "The incident analysis is recorded. Did Alice delete backups?",
  );

  assert.equal(result.facts[0]?.content, "The incident analysis is recorded.");
  assert.equal(result.facts[0]?.reasoningTrace, undefined);
});

test("extraction grounds de-linearized facts after resolving coreferences", async () => {
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
            facts: [{
              category: "fact",
              content: "He works at Acme.",
              confidence: 0.9,
              tags: [],
            }],
            profileUpdates: [],
            entities: [{
              name: "Bob",
              type: "person",
              facts: ["Alice introduced Bob."],
            }],
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

  const result = await engine.extract([{
    role: "user",
    content: "Alice introduced Bob. He works at Acme.",
    timestamp: "2026-07-25T12:00:00.000Z",
  }]);

  assert.deepEqual(result.facts.map((fact) => fact.content), ["Bob works at Acme."]);
});

test("grounding rejects topical overlap for short copular claims", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "Alice is vegan.",
        confidence: 0.9,
        tags: [],
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Alice likes vegan food.",
  );

  assert.deepEqual(result.facts, []);
});

test("grounding preserves proper identifiers before inflectional stemming", () => {
  const factResult = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "Alice uses Spr.",
        confidence: 0.9,
        tags: [],
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Alice uses Spring.",
  );
  const entityResult = filterExtractionResultBySource(
    {
      facts: [],
      profileUpdates: [],
      entities: [{
        name: "Spr",
        type: "tool",
        facts: ["Spr is deployed."],
      }],
      questions: [],
    },
    "Spring is deployed.",
  );

  assert.deepEqual(factResult.facts, []);
  assert.deepEqual(entityResult.entities, []);
});

test("grounding requires entity identifiers in one coherent source span", () => {
  const splitResult = filterExtractionResultBySource(
    {
      facts: [],
      profileUpdates: [],
      entities: [{
        name: "Alice Bob",
        type: "person",
        facts: ["Alice works at Acme."],
      }],
      questions: [],
    },
    "Alice works at Acme. Bob owns Mars.",
  );
  const coherentResult = filterExtractionResultBySource(
    {
      facts: [],
      profileUpdates: [],
      entities: [{
        name: "Alice Bob",
        type: "person",
        facts: ["Alice Bob joined Acme."],
      }],
      questions: [],
    },
    "Alice Bob joined Acme.",
  );

  assert.deepEqual(splitResult.entities, []);
  assert.deepEqual(coherentResult.entities.map((entity) => entity.name), ["Alice Bob"]);
});

test("grounding preserves explicit cross-speaker facts", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "The assistant uses PostgreSQL.",
        confidence: 0.9,
        tags: [],
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "The assistant uses PostgreSQL.",
    "The assistant uses PostgreSQL.",
    { profile: "", identity: "" },
  );

  assert.deepEqual(result.facts.map((fact) => fact.content), ["The assistant uses PostgreSQL."]);
});

test("grounding anchors relative eventTime for matching and preserves its source value", () => {
  const result = applyExtractionSourceGrounding(
    {
      facts: [{
        category: "fact",
        content: "Alice deployed Acme.",
        confidence: 0.9,
        tags: [],
        eventTime: "yesterday",
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Alice deployed Acme. Alice deployed Acme yesterday.",
    undefined,
    undefined,
    new Date("2026-07-26T12:00:00.000Z"),
    { sourceGrounding: true, anchorTemporalExpressions: true },
  );

  assert.equal(result.facts[0]?.eventTime, "yesterday");
});

test("grounding keeps declarative conditional facts", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "Alice uses PostgreSQL if available.",
        confidence: 0.9,
        tags: [],
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Alice uses PostgreSQL if available.",
  );

  assert.deepEqual(result.facts.map((fact) => fact.content), ["Alice uses PostgreSQL if available."]);
});

test("grounding rejects unsupported propositions after common delimiters", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "Alice works at Acme: Bob owns Mars.",
        confidence: 0.9,
        tags: [],
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Alice works at Acme.",
    "Alice works at Acme.",
  );

  assert.deepEqual(result.facts, []);
});

test("grounding does not keep context-only event times", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "Alice deployed Acme.",
        confidence: 0.9,
        tags: [],
        eventTime: "yesterday",
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Alice deployed Acme yesterday.\nAlice deployed Acme today.",
    "Alice deployed Acme today.",
  );

  assert.equal(result.facts[0]?.eventTime, undefined);
});

test("grounding drops unresolved questions sourced only from context turns", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [],
      profileUpdates: [],
      entities: [],
      questions: [{
        question: "Does Alice work at Acme?",
        context: "",
        priority: 0.5,
      }],
    },
    "Does Alice work at Acme?\nYes.\nAlice still needs confirmation.",
    "Alice still needs confirmation.",
  );

  assert.deepEqual(result.questions, []);
});

test("grounding aligns supported facts after leading modifiers", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "Alice runs Redis.",
        confidence: 0.9,
        tags: [],
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Currently, Alice is running Redis.",
  );

  assert.deepEqual(result.facts.map((fact) => fact.content), ["Alice runs Redis."]);
});

test("grounding binds structured attributes to the fact support span", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "Alice deployed Acme successfully.",
        confidence: 0.9,
        tags: [],
        structuredAttributes: { status: "failed" },
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Alice deployed Acme successfully. Bob reported status: failed.",
  );

  assert.equal(result.facts[0]?.structuredAttributes, undefined);
});

test("grounding binds fact entity references to the fact support span", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "Alice deployed Acme.",
        confidence: 0.9,
        tags: [],
        entityRef: "person-bob",
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Alice deployed Acme. Bob joined the meeting.",
  );

  assert.equal(result.facts[0]?.entityRef, undefined);
});

test("grounding preserves paraphrased conjunctions across source clauses", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "Alice works at Acme but does not work at Globex.",
        confidence: 0.9,
        tags: [],
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Alice worked at Acme but did not work at Globex.",
  );

  assert.deepEqual(
    result.facts.map((fact) => fact.content),
    ["Alice works at Acme but does not work at Globex."],
  );
});

test("grounding scopes nested entity facts to the enclosing entity", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [],
      profileUpdates: [],
      entities: [{
        name: "Alice",
        type: "person",
        facts: ["Alice works at Acme.", "Bob owns Mars."],
        structuredSections: [{
          key: "work",
          title: "Work",
          facts: ["Alice uses PostgreSQL.", "Bob uses MySQL."],
        }],
      }],
      questions: [],
    },
    "Alice works at Acme. Bob owns Mars. Alice uses PostgreSQL. Bob uses MySQL.",
  );

  assert.deepEqual(result.entities, [{
    name: "Alice",
    type: "person",
    facts: ["Alice works at Acme."],
    structuredSections: [{
      key: "work",
      title: "Work",
      facts: ["Alice uses PostgreSQL."],
    }],
  }]);
});


test("grounding requires unresolved questions on the asserted target turn", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [],
      profileUpdates: [],
      entities: [],
      questions: [{ question: "Does Alice work at Acme?", context: "", priority: 0.5 }],
    },
    "Does Alice work at Acme?\nBob joined the call.",
    "Bob joined the call.",
  );

  assert.deepEqual(result.questions, []);
});

test("grounding preserves affirmative not-only claims", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "Alice works at Acme.",
        confidence: 0.9,
        tags: [],
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Alice not only works at Acme but also owns Mars.",
  );

  assert.deepEqual(result.facts.map((fact) => fact.content), ["Alice works at Acme."]);
});

test("grounding rejects propositions embedded in denial reports", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "Bob works at Acme.",
        confidence: 0.9,
        tags: [],
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Alice denied that Bob works at Acme.",
  );

  assert.deepEqual(result.facts, []);
});

test("grounding rejects imperative hypothetical premises", () => {
  for (const source of ["Assume Alice works at Acme.", "Imagine Alice works at Acme."]) {
    const result = filterExtractionResultBySource(
      {
        facts: [{
          category: "fact",
          content: "Alice works at Acme.",
          confidence: 0.9,
          tags: [],
        }],
        profileUpdates: [],
        entities: [],
        questions: [],
      },
      source,
    );

    assert.deepEqual(result.facts, []);
  }
});

test("grounding requires temporal evidence to answer when questions", () => {
  const question = "When did Alice deploy Acme?";
  const unresolved = filterExtractionResultBySource(
    {
      facts: [],
      profileUpdates: [],
      entities: [],
      questions: [{ question, context: "", priority: 0.5 }],
    },
    `${question}\nAlice deployed Acme for cost savings.`,
  );
  const resolved = filterExtractionResultBySource(
    {
      facts: [],
      profileUpdates: [],
      entities: [],
      questions: [{ question, context: "", priority: 0.5 }],
    },
    `${question}\nAlice deployed Acme yesterday.`,
  );

  assert.deepEqual(unresolved.questions, [{ question, context: "", priority: 0.5 }]);
  assert.deepEqual(resolved.questions, []);
});

test("grounding rejects unsupported trailing fact modifiers", () => {
  for (const content of [
    "Alice works at Acme as CEO.",
    "Alice works at Acme every Monday.",
    "Alice works at Acme using Rust.",
  ]) {
    const result = filterExtractionResultBySource(
      {
        facts: [{ category: "fact", content, confidence: 0.9, tags: [] }],
        profileUpdates: [],
        entities: [],
        questions: [],
      },
      "Alice works at Acme.",
    );
    assert.deepEqual(result.facts, []);
  }
});

test("grounding binds procedure steps to the parent fact span", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "procedure",
        content: "Alice deployed Acme.",
        confidence: 0.9,
        tags: [],
        procedureSteps: [{ order: 1, intent: "delete backups" }],
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Alice deployed Acme. Bob instructed operators to delete backups.",
  );

  assert.deepEqual(result.facts[0]?.procedureSteps ?? [], []);
});

test("grounding rejects propositions in non-assertive reporting scopes", () => {
  for (const source of [
    "Alice alleged that Bob stole funds.",
    "Alice suspects Bob stole funds.",
  ]) {
    const result = filterExtractionResultBySource(
      {
        facts: [{ category: "fact", content: "Bob stole funds.", confidence: 0.9, tags: [] }],
        profileUpdates: [],
        entities: [],
        questions: [],
      },
      source,
    );
    assert.deepEqual(result.facts, []);
  }
});

test("grounding aligns predicates after medial source modifiers", () => {
  for (const [source, content] of [
    ["Alice currently works at Acme.", "Alice works at Acme."],
    ["Alice successfully deployed Acme.", "Alice deployed Acme."],
    ["Alice now works at Acme.", "Alice works at Acme."],
  ]) {
    const result = filterExtractionResultBySource(
      {
        facts: [{ category: "fact", content, confidence: 0.9, tags: [] }],
        profileUpdates: [],
        entities: [],
        questions: [],
      },
      source,
    );
    assert.deepEqual(result.facts.map((fact) => fact.content), [content]);
  }
});

test("grounding normalizes regular third-person verb inflections", () => {
  for (const [source, content] of [
    ["Alice deploys Acme.", "Alice deployed Acme."],
    ["Alice designs Atlas.", "Alice designed Atlas."],
    ["Alice manages Beacon.", "Alice managed Beacon."],
    ["Alice plans Atlas.", "Alice planned Atlas."],
    ["Alice stops Beacon.", "Alice stopped Beacon."],
    ["Alice tries again.", "Alice tried again."],
    ["They add tags.", "They added tags."],
    ["They call Alice.", "They called Alice."],
    ["They fill forms.", "They filled forms."],
    ["Alice Smith plans Atlas.", "Alice Smith planned Atlas."],
    ["Alice King works at Acme.", "Alice King worked at Acme."],
  ]) {
    const result = filterExtractionResultBySource(
      {
        facts: [{ category: "fact", content, confidence: 0.9, tags: [] }],
        profileUpdates: [],
        entities: [],
        questions: [],
      },
      source,
    );
    assert.deepEqual(result.facts.map((fact) => fact.content), [content]);
  }
});

test("grounding keeps silent-e compatibility out of proper identifiers", () => {
  for (const [source, content] of [
    ["Alice works at Strip.", "Alice works at Stripe."],
    ["Alice met Kat.", "Alice met Kate."],
    ["Alice owns Plan.", "Alice planned."],
  ]) {
    const result = filterExtractionResultBySource(
      {
        facts: [{ category: "fact", content, confidence: 0.9, tags: [] }],
        profileUpdates: [],
        entities: [],
        questions: [],
      },
      source,
    );
    assert.deepEqual(result.facts, []);
  }
});

test("grounding preserves lowercase identifier tokens ending in s", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{ category: "fact", content: "alice deployed atla.", confidence: 0.9, tags: [] }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "alice deployed atlas.",
  );

  assert.deepEqual(result.facts, []);
});

test("grounding role normalization matches exact-marked identifiers case-insensitively", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [],
      profileUpdates: ["User works at Stripe."],
      entities: [],
      questions: [],
    },
    "I work at stripe.",
    undefined,
    { profile: "I work at stripe.", identity: "" },
  );

  assert.deepEqual(result.profileUpdates, ["User works at Stripe."]);
});

test("grounding does not stem role-source identifiers ending in s", () => {
  for (const content of ["User uses Redi.", "User uses Redis."]) {
    const result = filterExtractionResultBySource(
      {
        facts: [],
        profileUpdates: [content],
        entities: [],
        questions: [],
      },
      "I use redis.",
      undefined,
      { profile: "I use redis.", identity: "" },
    );
    assert.deepEqual(
      result.profileUpdates,
      content.endsWith("Redis.") ? [content] : [],
    );
  }
});

test("grounding does not treat role-source object plurals as predicates", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [],
      profileUpdates: ["User planned."],
      entities: [],
      questions: [],
    },
    "I own plans.",
    undefined,
    { profile: "I own plans.", identity: "" },
  );

  assert.deepEqual(result.profileUpdates, []);
});

test("grounding falls back to explicitly role-labeled source sentences", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [],
      profileUpdates: ["User prefers tea."],
      entities: [],
      questions: [],
    },
    "User prefers tea.",
    undefined,
    { profile: "", identity: "" },
  );

  assert.deepEqual(result.profileUpdates, ["User prefers tea."]);
});

test("grounding uses the main source when a role source is omitted", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [],
      profileUpdates: ["User prefers tea."],
      entities: [],
      questions: [],
    },
    "I prefer tea.",
    undefined,
    { identity: "" },
  );

  assert.deepEqual(result.profileUpdates, ["User prefers tea."]);
});

test("grounding keeps C, C++, and C# identifiers pairwise distinct", () => {
  const identifiers = ["C", "C++", "C#"];
  for (const sourceIdentifier of identifiers) {
    for (const candidateIdentifier of identifiers) {
      const content = `Alice uses ${candidateIdentifier}.`;
      const result = filterExtractionResultBySource(
        {
          facts: [{ category: "fact", content, confidence: 0.9, tags: [] }],
          profileUpdates: [],
          entities: [],
          questions: [],
        },
        `Alice uses ${sourceIdentifier}.`,
      );
      assert.deepEqual(
        result.facts.map((fact) => fact.content),
        sourceIdentifier === candidateIdentifier ? [content] : [],
      );
    }
  }
});


test("grounding inherits coordinated subjects and predicates", () => {
  for (const [source, content] of [
    ["Alice works at Acme and owns Mars.", "Alice owns Mars."],
    ["Alice uses PostgreSQL, Redis, and Kafka.", "Alice uses Kafka."],
  ]) {
    const result = filterExtractionResultBySource(
      {
        facts: [{ category: "fact", content, confidence: 0.9, tags: [] }],
        profileUpdates: [],
        entities: [],
        questions: [],
      },
      source,
    );
    assert.deepEqual(result.facts.map((fact) => fact.content), [content]);
  }
});

test("grounding does not inherit across explicit coordinated subjects", () => {
  for (const [source, content] of [
    ["Alice works at Acme and Bob owns Mars.", "Alice owns Mars."],
    ["Alice works at Acme and Bob sleeps.", "Alice sleeps."],
    ["Alice works at Acme, Bob called Alice, and designed Mars.", "Alice designed Mars."],
    ["Alice works at Acme and Bob can swim.", "Alice can swim."],
    ["Acme works with Alice, Acme Labs called Bob, and designed Mars.", "Acme designed Mars."],
    ["Alice works at Acme and Bob went home.", "Alice went home."],
    ["Alice works at Acme and Bob ate lunch.", "Alice ate lunch."],
  ]) {
    const result = filterExtractionResultBySource(
      {
        facts: [{ category: "fact", content, confidence: 0.9, tags: [] }],
        profileUpdates: [],
        entities: [],
        questions: [],
      },
      source,
    );
    assert.deepEqual(result.facts, []);
  }
});

test("grounding requires causal evidence before removing why questions", () => {
  const question = { question: "Why did Alice deploy Acme?", context: "", priority: 0.5 };
  const unanswered = filterExtractionResultBySource(
    { facts: [], profileUpdates: [], entities: [], questions: [question] },
    "Why did Alice deploy Acme?\nAlice deployed Acme.",
  );
  assert.deepEqual(unanswered.questions, [question]);

  const answered = filterExtractionResultBySource(
    { facts: [], profileUpdates: [], entities: [], questions: [question] },
    "Why did Alice deploy Acme?\nAlice deployed Acme because customers requested it.",
  );
  assert.deepEqual(answered.questions, []);
});

test("grounding rejects partial assertions from source disjunctions", () => {
  for (const source of [
    "Alice uses Redis or PostgreSQL.",
    "Does Alice use Redis or PostgreSQL?\nYes.",
  ]) {
    for (const content of ["Alice uses Redis.", "Alice uses PostgreSQL."]) {
      const result = filterExtractionResultBySource(
        {
          facts: [{ category: "fact", content, confidence: 0.9, tags: [] }],
          profileUpdates: [],
          entities: [],
          questions: [],
        },
        source,
      );
      assert.deepEqual(result.facts, []);
    }
  }

  for (const source of [
    "Alice uses Redis or PostgreSQL.",
    "Does Alice use Redis or PostgreSQL?\nYes.",
  ]) {
    const content = "Alice uses Redis or PostgreSQL.";
    const result = filterExtractionResultBySource(
      {
        facts: [{ category: "fact", content, confidence: 0.9, tags: [] }],
        profileUpdates: [],
        entities: [],
        questions: [],
      },
      source,
    );
    assert.deepEqual(result.facts.map((fact) => fact.content), [content]);
  }

  const commonPrefix = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "Alice uses Redis.",
        confidence: 0.9,
        tags: [],
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Alice uses Redis for cache hits or misses.",
  );
  assert.deepEqual(
    commonPrefix.facts.map((fact) => fact.content),
    ["Alice uses Redis."],
  );
});

test("grounding aligns object wh-question answers by subject and predicate", () => {
  for (const [questionText, answer, roleReversedAnswer] of [
    [
      "What database does Alice use?",
      "Alice uses PostgreSQL as the database.",
      "PostgreSQL uses Alice as the database.",
    ],
    ["Who does Alice employ?", "Alice employs Bob.", "Bob employs Alice."],
    ["Whom does Alice employ?", "Alice employs Bob.", "Bob employs Alice."],
    ["Who does Alice work with?", "Alice works with Bob.", "Bob works with Alice."],
    ["Whom does Alice connect to?", "Alice connects to Bob.", "Bob connects to Alice."],
  ]) {
    const question = { question: questionText, context: "", priority: 0.5 };
    const answered = filterExtractionResultBySource(
      { facts: [], profileUpdates: [], entities: [], questions: [question] },
      `${questionText}\n${answer}`,
    );
    assert.deepEqual(answered.questions, []);

    const roleReversed = filterExtractionResultBySource(
      { facts: [], profileUpdates: [], entities: [], questions: [question] },
      `${questionText}\n${roleReversedAnswer}`,
    );
    assert.deepEqual(roleReversed.questions, [question]);
  }
});

test("grounding does not stem verb-like object plurals", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "Alice sells the plan.",
        confidence: 0.9,
        tags: [],
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Alice sells plans.",
  );

  assert.deepEqual(result.facts, []);
});

test("grounding recognizes capitalized predicates in subjectless role fragments", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [],
      profileUpdates: ["User uses Redis."],
      entities: [],
      questions: [],
    },
    "Uses Redis.",
    undefined,
    { profile: "Uses Redis.", identity: "" },
  );

  assert.deepEqual(result.profileUpdates, ["User uses Redis."]);
});

test("grounding keeps sentence-initial plural subjects distinct", () => {
  const result = filterExtractionResultBySource(
    {
      facts: [{
        category: "fact",
        content: "Plan is active.",
        confidence: 0.9,
        tags: [],
      }],
      profileUpdates: [],
      entities: [],
      questions: [],
    },
    "Plans are active.",
  );

  assert.deepEqual(result.facts, []);
});

test("grounding preserves plural identifiers after a proper-name copular subject", () => {
  for (const [source, content] of [
    ["Alice is atlas.", "Alice is atla."],
    ["Alice is the atlas.", "Alice is the atla."],
  ]) {
    const result = filterExtractionResultBySource(
      {
        facts: [{ category: "fact", content, confidence: 0.9, tags: [] }],
        profileUpdates: [],
        entities: [],
        questions: [],
      },
      source,
    );
    assert.deepEqual(result.facts, []);
  }
});

const JAPANESE_OBSERVED_TURN = {
  role: "user" as const,
  content: "田中さんは東京に住んでいます。毎日電車で会社に行きます。",
  timestamp: "2026-07-25T12:00:00.000Z",
};

test("script-aware grounding keeps CJK paraphrased facts and embedded entity names", async () => {
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
                content: "田中さんは東京に住んでいる",
                confidence: 0.9,
                tags: [],
              },
              {
                category: "fact",
                content: "田中さんは大阪に住んでいる",
                confidence: 0.9,
                tags: [],
              },
            ],
            profileUpdates: [],
            entities: [{
              name: "田中",
              type: "person",
              facts: ["東京に住んでいる"],
            }],
            questions: [],
          }),
        };
      },
    },
  });

  const result = await engine.extract([JAPANESE_OBSERVED_TURN]);

  assert.deepEqual(result.facts.map((fact) => fact.content), ["田中さんは東京に住んでいる"]);
  assert.equal(result.entities.length, 1);
  assert.equal(result.entities[0]?.name, "田中");
  assert.deepEqual(result.entities[0]?.facts, ["東京に住んでいる"]);
});
