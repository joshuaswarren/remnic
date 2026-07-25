import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";
import { ExtractionEngine } from "./extraction.js";
import { ExtractionResultSchema } from "./schemas.js";
import type { BufferTurn, ExtractionResult } from "./types.js";

const SOURCE_TURN: BufferTurn = {
  role: "user",
  content: "Moonlight's theme color is green, not blue.",
  timestamp: "2026-07-25T12:00:00.000Z",
};

const SOURCE_GROUNDED_EXTRACTION = {
  facts: [{
    category: "fact",
    content: SOURCE_TURN.content,
    confidence: 0.95,
    tags: ["theme"],
  }],
  profileUpdates: [],
  entities: [],
  questions: [],
};
const STRUCTURAL_PLACEHOLDER_EXTRACTION = {
  facts: [{
    category: "<category>",
    content: "<source-grounded statement>",
    confidence: 0,
    tags: ["<tag>"],
    entityRef: "<optional normalized-name>",
    promptedByQuestion: "<optional source-grounded question>",
    quote: "<optional exact contiguous source span>",
  }],
  profileUpdates: ["<source-grounded profile update>"],
  entities: [{
    name: "<normalized-name>",
    type: "<entity-type>",
    facts: ["<source-grounded statement>"],
    promptedByQuestion: "<optional source-grounded question>",
  }],
  questions: [{
    question: "<source-grounded unresolved question>",
    context: "<source-grounded context>",
    priority: 0,
  }],
  identityReflection: "<conversation-grounded agent reflection>",
  relationships: [{
    source: "<normalized-name>",
    target: "<normalized-name>",
    label: "<source-grounded relationship>",
  }],
};

const GATEWAY_PLACEHOLDER_EXTRACTION = {
  ...STRUCTURAL_PLACEHOLDER_EXTRACTION,
  facts: [{
    ...STRUCTURAL_PLACEHOLDER_EXTRACTION.facts[0],
    category: "fact",
  }],
  entities: [{
    ...STRUCTURAL_PLACEHOLDER_EXTRACTION.entities[0],
    type: "other",
  }],
};

type ChatMessage = { role: string; content: string };

type LocalLlmFixture = {
  chatCompletion(messages: ChatMessage[]): Promise<{ content: string }>;
};

type GatewayFixture = {
  parseWithSchemaDetailed(messages: ChatMessage[]): Promise<unknown>;
};

type DirectClientFixture = {
  chat: {
    completions: {
      create(request: { messages: ChatMessage[] }): Promise<unknown>;
    };
  };
};

function assertSafeExtractionPrompt(prompt: string): void {
  assert.match(prompt, /Questions are optional/i);
  assert.match(prompt, /return an empty array/i);
  assert.match(prompt, /\[context user\].*reference context only|reference context only.*\[context user\]/is);
  assert.match(prompt, /may resolve references or complete a question-and-answer pair/i);
  assert.match(prompt, /Explicit \(0\.95-1\.0\).*Speculative \(0\.00-0\.39\)/is);
  assert.match(prompt, /operational noise/i);
  assert.doesNotMatch(prompt, /dark mode|cloud provider|staging environment/i);
  assert.doesNotMatch(prompt, /React over Vue|rate limiting at 1000/i);
}

function assertStructuralResponseShape(prompt: string): void {
  assert.match(prompt, /"structuredSections"/);
  assert.match(prompt, /"procedureSteps": \[\{"order": 1, "intent": "<step>"\}, \{"order": 2, "intent": "<step>"\}\]/);
  assert.match(prompt, /"reasoningTrace":\s*\{\s*"steps": \[\{"order": 1, "description": "<step>"\}, \{"order": 2, "description": "<step>"\}\]/s);
  assert.match(prompt, /"quote"/);
  assert.match(prompt, /"scope"/);
  assert.match(prompt, /"eventTime"/);
  assert.match(prompt, /"identityReflection"/);
}

function assertSourceGroundedResult(result: ExtractionResult): void {
  assert.equal(result.facts[0]?.content, SOURCE_TURN.content);
  assert.equal(result.facts[0]?.category, "fact");
  assert.deepEqual(result.questions, []);
}

test("local extraction prompt uses placeholders and accepts an empty question list", async () => {
  const engine = new ExtractionEngine(parseConfig({
    localLlmEnabled: true,
    localLlmModel: "fixture-local",
    localLlmFallback: false,
  }));
  let calls = 0;
  let prompt = "";

  const localLlm: LocalLlmFixture = {
    async chatCompletion(messages: ChatMessage[]) {
      calls += 1;
      prompt = messages[1]?.content ?? "";
      return { content: JSON.stringify(SOURCE_GROUNDED_EXTRACTION) };
    },
  };
  const modelRegistry = {
    calculateContextSizes: () => ({ maxInputChars: 8_000, maxOutputTokens: 1_000, description: "fixture" }),
  };
  assert.equal(Reflect.set(engine, "localLlm", localLlm), true);
  assert.equal(Reflect.set(engine, "modelRegistry", modelRegistry), true);

  const result = await engine.extract([SOURCE_TURN]);

  assert.equal(calls, 1);
  assertSourceGroundedResult(result);
  assertSafeExtractionPrompt(prompt);
  assertStructuralResponseShape(prompt);
  assert.doesNotMatch(prompt, /^- rule:/m);
});

test("local extraction discards literal structural placeholders", async () => {
  const engine = new ExtractionEngine(parseConfig({
    localLlmEnabled: true,
    localLlmModel: "fixture-local",
    localLlmFallback: false,
  }));
  const localLlm: LocalLlmFixture = {
    async chatCompletion() {
      return { content: JSON.stringify(STRUCTURAL_PLACEHOLDER_EXTRACTION) };
    },
  };
  const modelRegistry = {
    calculateContextSizes: () => ({ maxInputChars: 8_000, maxOutputTokens: 1_000, description: "fixture" }),
  };
  assert.equal(Reflect.set(engine, "localLlm", localLlm), true);
  assert.equal(Reflect.set(engine, "modelRegistry", modelRegistry), true);

  const result = await engine.extract([SOURCE_TURN]);

  assert.deepEqual(result.facts, []);
  assert.deepEqual(result.profileUpdates, []);
  assert.deepEqual(result.entities, []);
  assert.deepEqual(result.questions, []);
  assert.deepEqual(result.relationships, []);
  assert.equal(result.identityReflection, undefined);
});

test("gateway extraction discards literal structural placeholders", async () => {
  const engine = new ExtractionEngine(parseConfig({ modelSource: "gateway" }));
  const fallbackLlm: GatewayFixture = {
    async parseWithSchemaDetailed() {
      return { modelUsed: "fixture-gateway", result: GATEWAY_PLACEHOLDER_EXTRACTION };
    },
  };
  assert.equal(Reflect.set(engine, "fallbackLlm", fallbackLlm), true);

  const result = await engine.extract([SOURCE_TURN]);

  assert.deepEqual(result.facts, []);
  assert.deepEqual(result.profileUpdates, []);
  assert.deepEqual(result.entities, []);
  assert.deepEqual(result.questions, []);
  assert.deepEqual(result.relationships, []);
  assert.equal(result.identityReflection, undefined);
});

test("gateway extraction prompt uses placeholders and accepts an empty question list", async () => {
  const engine = new ExtractionEngine(parseConfig({ modelSource: "gateway" }));
  let calls = 0;
  let prompt = "";

  const fallbackLlm: GatewayFixture = {
    async parseWithSchemaDetailed(messages: ChatMessage[]) {
      calls += 1;
      prompt = messages[0]?.content ?? "";
      return { modelUsed: "fixture-gateway", result: SOURCE_GROUNDED_EXTRACTION };
    },
  };
  assert.equal(Reflect.set(engine, "fallbackLlm", fallbackLlm), true);

  const result = await engine.extract([SOURCE_TURN]);

  assert.equal(calls, 1);
  assertSourceGroundedResult(result);
  assertSafeExtractionPrompt(prompt);
});

test("direct extraction prompt uses placeholders and accepts an empty question list", async () => {
  const engine = new ExtractionEngine(parseConfig({ openaiApiKey: "fixture-key" }));
  let calls = 0;
  let prompt = "";

  const client: DirectClientFixture = {
    chat: {
      completions: {
        async create(request: { messages: ChatMessage[] }) {
          calls += 1;
          prompt = request.messages[0]?.content ?? "";
          return { choices: [{ message: { content: JSON.stringify(SOURCE_GROUNDED_EXTRACTION) } }] };
        },
      },
    },
  };
  assert.equal(Reflect.set(engine, "client", client), true);

  const result = await engine.extract([SOURCE_TURN]);

  assert.equal(calls, 1);
  assertSourceGroundedResult(result);
  assertStructuralResponseShape(prompt);
  assertSafeExtractionPrompt(prompt);
});

test("extraction schema permits empty optional question output", () => {
  const parsed = ExtractionResultSchema.safeParse(SOURCE_GROUNDED_EXTRACTION);

  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.data?.questions, []);
  assert.match(ExtractionResultSchema.shape.questions.description ?? "", /zero to three/i);
});
