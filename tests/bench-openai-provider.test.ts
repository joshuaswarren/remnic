import test from "node:test";
import assert from "node:assert/strict";
import { createOpenAiCompatibleProvider } from "../packages/bench/src/index.js";

test("OpenAI-compatible provider completes prompts and tracks token usage", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request) => {
    assert.match(String(input), /\/chat\/completions$/);

    return new Response(
      JSON.stringify({
        model: "gpt-test",
        usage: {
          prompt_tokens: 11,
          completion_tokens: 7,
        },
        choices: [
          {
            message: {
              content: "Synthetic answer",
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const provider = createOpenAiCompatibleProvider({
      model: "gpt-test",
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
    });

    const result = await provider.complete("Explain the answer.");
    const usage = provider.getUsage();

    assert.equal(result.text, "Synthetic answer");
    assert.equal(result.model, "gpt-test");
    assert.equal(result.tokens.input, 11);
    assert.equal(result.tokens.output, 7);
    assert.equal(usage.inputTokens, 11);
    assert.equal(usage.outputTokens, 7);
    assert.equal(usage.totalTokens, 18);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI-compatible provider discovers models from /v1/models", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request) => {
    assert.match(String(input), /\/models$/);

    return new Response(
      JSON.stringify({
        data: [
          {
            id: "gpt-test",
            name: "GPT Test",
            context_length: 128000,
            capabilities: ["completion", "embedding"],
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const provider = createOpenAiCompatibleProvider({
      model: "gpt-test",
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
    });

    assert.ok(provider.discover, "provider exposes discover()");
    const discovered = await provider.discover();

    assert.deepEqual(discovered, [
      {
        id: "gpt-test",
        name: "GPT Test",
        contextLength: 128000,
        capabilities: ["completion", "embedding"],
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
