import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";
import { ExtractionEngine } from "./extraction.js";
import type { BufferTurn } from "./types.js";
import { ExtractionResultSchema } from "./schemas.js";

const EMPTY_EXTRACTION = {
  facts: [],
  profileUpdates: [],
  entities: [],
  questions: [],
};

const SOURCE_TURN: BufferTurn = {
  role: "user",
  content: "Moonlight's theme color is green, not blue.",
  timestamp: "2026-07-25T12:00:00.000Z",
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
  assert.match(prompt, /operational noise/i);
  assert.doesNotMatch(prompt, /dark mode|cloud provider|staging environment/i);
  assert.doesNotMatch(prompt, /React over Vue|rate limiting at 1000/i);
}

function assertStructuralResponseShape(prompt: string): void {
  assert.match(prompt, /"structuredSections"/);
  assert.match(prompt, /"procedureSteps": \[\{"order": 0, "intent": "<step>"\}, \{"order": 1, "intent": "<step>"\}\]/);
  assert.match(prompt, /"reasoningTrace":\s*\{\s*"steps": \[\{"order": 0, "description": "<step>"\}, \{"order": 1, "description": "<step>"\}\]/s);
  assert.match(prompt, /"quote"/);
  assert.match(prompt, /"scope"/);
  assert.match(prompt, /"eventTime"/);
  assert.match(prompt, /"identityReflection"/);
}

test("local extraction prompt uses placeholders and accepts an empty question list", async () => {
  const engine = new ExtractionEngine(parseConfig({
    localLlmEnabled: true,
    localLlmModel: "fixture-local",
    localLlmFallback: false,
  }));
  let prompt = "";

  const localLlm: LocalLlmFixture = {
    async chatCompletion(messages: ChatMessage[]) {
      prompt = messages[1]?.content ?? "";
      return { content: JSON.stringify(EMPTY_EXTRACTION) };
    },
  };
  const modelRegistry = {
    calculateContextSizes: () => ({ maxInputChars: 8_000, maxOutputTokens: 1_000, description: "fixture" }),
  };
  assert.equal(Reflect.set(engine, "localLlm", localLlm), true);
  assert.equal(Reflect.set(engine, "modelRegistry", modelRegistry), true);

  const result = await engine.extract([SOURCE_TURN]);

  assert.deepEqual(result.questions, []);
  assertSafeExtractionPrompt(prompt);
  assertStructuralResponseShape(prompt);
  assert.doesNotMatch(prompt, /^- rule:/m);
});

test("gateway extraction prompt uses placeholders and accepts an empty question list", async () => {
  const engine = new ExtractionEngine(parseConfig({ modelSource: "gateway" }));
  let prompt = "";

  const fallbackLlm: GatewayFixture = {
    async parseWithSchemaDetailed(messages: ChatMessage[]) {
      prompt = messages[0]?.content ?? "";
      return { modelUsed: "fixture-gateway", result: EMPTY_EXTRACTION };
    },
  };
  assert.equal(Reflect.set(engine, "fallbackLlm", fallbackLlm), true);

  const result = await engine.extract([SOURCE_TURN]);

  assert.deepEqual(result.questions, []);
  assertSafeExtractionPrompt(prompt);
});

test("direct extraction prompt uses placeholders and accepts an empty question list", async () => {
  const engine = new ExtractionEngine(parseConfig({ openaiApiKey: "fixture-key" }));
  let prompt = "";

  const client: DirectClientFixture = {
    chat: {
      completions: {
        async create(request: { messages: ChatMessage[] }) {
          prompt = request.messages[0]?.content ?? "";
          return { choices: [{ message: { content: JSON.stringify(EMPTY_EXTRACTION) } }] };
        },
      },
    },
  };
  assert.equal(Reflect.set(engine, "client", client), true);

  const result = await engine.extract([SOURCE_TURN]);

  assert.deepEqual(result.questions, []);
  assertStructuralResponseShape(prompt);
  assertSafeExtractionPrompt(prompt);
});

test("extraction schema permits empty optional question output", () => {
  const parsed = ExtractionResultSchema.safeParse(EMPTY_EXTRACTION);

  assert.equal(parsed.success, true);
  assert.match(ExtractionResultSchema.shape.questions.description ?? "", /zero to three/i);
});
