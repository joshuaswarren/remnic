import test from "node:test";
import assert from "node:assert/strict";
import {
  buildChatCompletionTemperature,
  buildChatCompletionTokenLimit,
  shouldAssumeOpenAiChatCompletions,
  supportsTemperature,
  usesMaxCompletionTokens,
} from "@remnic/core/openai-chat-compat";
import { parseConfig } from "@remnic/core/config";
import { ExtractionEngine } from "@remnic/core/extraction";
import { FallbackLlmClient } from "@remnic/core/fallback-llm";
import type { GatewayConfig } from "@remnic/core/types";

test("usesMaxCompletionTokens detects newer OpenAI chat-completions models", () => {
  assert.equal(usesMaxCompletionTokens("gpt-5.5", { assumeOpenAI: true }), true);
  assert.equal(usesMaxCompletionTokens("gpt-5-mini", { assumeOpenAI: true }), true);
  assert.equal(usesMaxCompletionTokens("gpt-4o", { assumeOpenAI: true }), true);
  assert.equal(usesMaxCompletionTokens("gpt-4o-mini", { assumeOpenAI: true }), true);
  assert.equal(usesMaxCompletionTokens("gpt-4.1", { assumeOpenAI: true }), true);
  assert.equal(usesMaxCompletionTokens("gpt-4.1-mini", { assumeOpenAI: true }), true);
  assert.equal(usesMaxCompletionTokens("o3-mini", { assumeOpenAI: true }), true);
  assert.equal(usesMaxCompletionTokens("gpt-5.5"), false);
  assert.equal(usesMaxCompletionTokens("o3-mini"), false);
  assert.equal(usesMaxCompletionTokens("gpt-4orca", { assumeOpenAI: true }), false);
  assert.equal(usesMaxCompletionTokens("gpt-5compat", { assumeOpenAI: true }), false);
  assert.equal(usesMaxCompletionTokens("o2-local", { assumeOpenAI: true }), false);
  assert.equal(usesMaxCompletionTokens("orca2"), false);
  assert.equal(usesMaxCompletionTokens("llama3.2"), false);
});

test("buildChatCompletionTokenLimit selects max_completion_tokens for gpt-5 models", () => {
  assert.deepEqual(buildChatCompletionTokenLimit("gpt-5.5", 4096, { assumeOpenAI: true }), {
    max_completion_tokens: 4096,
  });
  assert.deepEqual(buildChatCompletionTokenLimit("gpt-4o-mini", 1024, { assumeOpenAI: true }), {
    max_completion_tokens: 1024,
  });
  assert.deepEqual(buildChatCompletionTokenLimit("gpt-4.1", 2048, { assumeOpenAI: true }), {
    max_completion_tokens: 2048,
  });
  assert.deepEqual(buildChatCompletionTokenLimit("o2-local", 2048, { assumeOpenAI: true }), {
    max_tokens: 2048,
  });
});

test("buildChatCompletionTemperature omits temperature for native OpenAI gpt-5 chat completions", () => {
  assert.equal(supportsTemperature("gpt-5.4-mini", { assumeOpenAI: true }), false);
  assert.equal(supportsTemperature("gpt-5.4-mini"), true);
  assert.deepEqual(buildChatCompletionTemperature("gpt-5.4-mini", 0.3, { assumeOpenAI: true }), {});
  assert.deepEqual(buildChatCompletionTemperature("gpt-4o-mini", 0.3, { assumeOpenAI: true }), {
    temperature: 0.3,
  });
  assert.deepEqual(buildChatCompletionTemperature("gpt-5.4-mini", 0.3), {
    temperature: 0.3,
  });
});

test("shouldAssumeOpenAiChatCompletions only enables native OpenAI endpoints", () => {
  assert.equal(shouldAssumeOpenAiChatCompletions(), true);
  assert.equal(shouldAssumeOpenAiChatCompletions("https://api.openai.com/v1"), true);
  assert.equal(shouldAssumeOpenAiChatCompletions("https://api.example.test/v1"), false);
  assert.equal(shouldAssumeOpenAiChatCompletions("http://localhost:11434/v1"), false);
});

test("extractWithDirectClient uses max_completion_tokens for gpt-5 chat completions", async () => {
  const engine = new ExtractionEngine(
    parseConfig({
      memoryDir: ".tmp/memory",
      workspaceDir: ".tmp/workspace",
      openaiApiKey: "test-key",
      model: "gpt-5.5",
    }),
  ) as any;

  const capturedBodyBox: { value: Record<string, unknown> | null } = { value: null };
  engine.client = {
    chat: {
      completions: {
        create: async (body: Record<string, unknown>) => {
          capturedBodyBox.value = body;
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    facts: [],
                    entities: [],
                    profileUpdates: [],
                    questions: [],
                    relationships: [],
                  }),
                },
              },
            ],
          };
        },
      },
    },
  };

  const result = await engine.extractWithDirectClient("hello world");
  assert.ok(result);
  const capturedBody = capturedBodyBox.value;
  assert.equal(capturedBody?.model, "gpt-5.5");
  assert.equal("max_completion_tokens" in (capturedBody ?? {}), true);
  assert.equal("max_tokens" in (capturedBody ?? {}), false);
});

test("extractWithDirectClient keeps max_tokens for custom chat-compatible base URLs", async () => {
  const engine = new ExtractionEngine(
    parseConfig({
      memoryDir: ".tmp/memory",
      workspaceDir: ".tmp/workspace",
      openaiApiKey: "test-key",
      openaiBaseUrl: "https://api.example.test/v1",
      model: "gpt-5.5",
    }),
  ) as any;

  const capturedBodyBox: { value: Record<string, unknown> | null } = { value: null };
  engine.client = {
    chat: {
      completions: {
        create: async (body: Record<string, unknown>) => {
          capturedBodyBox.value = body;
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    facts: [],
                    entities: [],
                    profileUpdates: [],
                    questions: [],
                    relationships: [],
                  }),
                },
              },
            ],
          };
        },
      },
    },
  };

  const result = await engine.extractWithDirectClient("hello world");
  assert.ok(result);
  const capturedBody = capturedBodyBox.value;
  assert.equal(capturedBody?.model, "gpt-5.5");
  assert.equal("max_completion_tokens" in (capturedBody ?? {}), false);
  assert.equal("max_tokens" in (capturedBody ?? {}), true);
});

test("fallback OpenAI client uses max_completion_tokens for gpt-5 providers", async () => {
  const gatewayConfig: GatewayConfig = {
    agents: {
      defaults: {
        model: {
          primary: "openai/gpt-5.5",
        },
      },
    },
    models: {
      providers: {
        openai: {
          api: "openai-completions",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "test-key",
          models: [],
        },
      },
    },
  };

  const client = new FallbackLlmClient(gatewayConfig);
  const originalFetch = globalThis.fetch;
  const requestBodyBox: { value: Record<string, unknown> | null } = { value: null };
  globalThis.fetch = (async (_input, init) => {
    requestBodyBox.value = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "{\"ok\":true}" } }],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const response = await client.chatCompletion([{ role: "user", content: "hello" }], {
      maxTokens: 1234,
    });
    assert.ok(response);
    const requestBody = requestBodyBox.value;
    assert.equal(requestBody?.model, "gpt-5.5");
    assert.equal(requestBody?.max_completion_tokens, 1234);
    assert.equal("max_tokens" in (requestBody ?? {}), false);
    assert.equal("temperature" in (requestBody ?? {}), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fallback OpenAI client uses max_completion_tokens for gpt-4o providers", async () => {
  const gatewayConfig: GatewayConfig = {
    agents: {
      defaults: {
        model: {
          primary: "openai/gpt-4o-mini",
        },
      },
    },
    models: {
      providers: {
        openai: {
          api: "openai-completions",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "test-key",
          models: [],
        },
      },
    },
  };

  const client = new FallbackLlmClient(gatewayConfig);
  const originalFetch = globalThis.fetch;
  const requestBodyBox: { value: Record<string, unknown> | null } = { value: null };
  globalThis.fetch = (async (_input, init) => {
    requestBodyBox.value = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "{\"ok\":true}" } }],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const response = await client.chatCompletion([{ role: "user", content: "hello" }], {
      maxTokens: 512,
    });
    assert.ok(response);
    const requestBody = requestBodyBox.value;
    assert.equal(requestBody?.model, "gpt-4o-mini");
    assert.equal(requestBody?.max_completion_tokens, 512);
    assert.equal("max_tokens" in (requestBody ?? {}), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fallback OpenAI client keeps max_tokens for custom base URLs", async () => {
  const gatewayConfig: GatewayConfig = {
    agents: {
      defaults: {
        model: {
          primary: "openai/gpt-5.5",
        },
      },
    },
    models: {
      providers: {
        openai: {
          api: "openai-completions",
          baseUrl: "https://api.example.test/v1",
          apiKey: "test-key",
          models: [],
        },
      },
    },
  };

  const client = new FallbackLlmClient(gatewayConfig);
  const originalFetch = globalThis.fetch;
  const requestBodyBox: { value: Record<string, unknown> | null } = { value: null };
  globalThis.fetch = (async (_input, init) => {
    requestBodyBox.value = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "{\"ok\":true}" } }],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const response = await client.chatCompletion([{ role: "user", content: "hello" }], {
      maxTokens: 256,
    });
    assert.ok(response);
    const requestBody = requestBodyBox.value;
    assert.equal(requestBody?.model, "gpt-5.5");
    assert.equal(requestBody?.max_tokens, 256);
    assert.equal("max_completion_tokens" in (requestBody ?? {}), false);
    assert.equal(requestBody?.temperature, 0.3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
