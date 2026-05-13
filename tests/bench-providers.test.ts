import test from "node:test";
import assert from "node:assert/strict";
import {
  createAnthropicProvider,
  createLiteLlmProvider,
  createOllamaProvider,
  createProvider,
  createOpenAiCompatibleProvider,
  discoverAllProviders,
} from "../packages/bench/src/index.ts";

type FetchCall = {
  url: string;
  init?: RequestInit;
};

function withFetchStub(
  implementation: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
) {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    calls.push({ url, init });
    return implementation(input, init);
  }) as typeof fetch;

  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

test("Anthropic provider maps responses and usage counters", async () => {
  const stub = withFetchStub(async () =>
    new Response(
      JSON.stringify({
        model: "claude-3-7-sonnet",
        content: [{ type: "text", text: "done" }],
        usage: { input_tokens: 12, output_tokens: 5 },
      }),
      { status: 200 },
    ));

  try {
    const provider = createAnthropicProvider({
      model: "claude-3-7-sonnet",
      apiKey: "secret",
    });
    const result = await provider.complete("hello");

    assert.equal(result.text, "done");
    assert.equal(result.tokens.input, 12);
    assert.equal(result.tokens.output, 5);
    assert.equal(provider.getUsage().totalTokens, 17);
    assert.match(stub.calls[0]!.url, /api\.anthropic\.com\/v1\/messages$/);
  } finally {
    stub.restore();
  }
});

test("Ollama provider supports local model discovery", async () => {
  const stub = withFetchStub(async () =>
    new Response(
      JSON.stringify({
        models: [
          {
            name: "llama3.2",
            details: {
              parameter_size: "8B",
              quantization_level: "Q4_K_M",
            },
          },
        ],
      }),
      { status: 200 },
    ));

  try {
    const provider = createOllamaProvider({ model: "llama3.2" });
    const models = await provider.discover?.();

    assert.deepEqual(models, [
      {
        id: "llama3.2",
        name: "llama3.2",
        contextLength: 0,
        capabilities: ["completion"],
        quantization: "Q4_K_M",
        parameterCount: "8B",
      },
    ]);
    assert.match(stub.calls[0]!.url, /localhost:11434\/api\/tags$/);
  } finally {
    stub.restore();
  }
});

test("LiteLLM provider uses the LiteLLM local default base URL", async () => {
  const stub = withFetchStub(async () =>
    new Response(
      JSON.stringify({
        model: "gpt-4o-mini",
        usage: { prompt_tokens: 3, completion_tokens: 2 },
        choices: [{ message: { content: "ok" } }],
      }),
      { status: 200 },
    ));

  try {
    const provider = createLiteLlmProvider({ model: "gpt-4o-mini" });
    const result = await provider.complete("ping");

    assert.equal(result.text, "ok");
    assert.match(stub.calls[0]!.url, /localhost:4000\/chat\/completions$/);
  } finally {
    stub.restore();
  }
});

test("provider factory returns concrete providers for each supported backend", async () => {
  const openai = createProvider({ provider: "openai", model: "gpt-5.4" });
  const litellm = createProvider({ provider: "litellm", model: "gpt-4o-mini" });
  const anthropic = createProvider({ provider: "anthropic", model: "claude-3-7-sonnet" });
  const ollama = createProvider({ provider: "ollama", model: "llama3.2" });

  assert.equal(openai.provider, "openai");
  assert.equal(litellm.provider, "litellm");
  assert.equal(anthropic.provider, "anthropic");
  assert.equal(ollama.provider, "ollama");
});

test("discoverAllProviders skips unavailable endpoints and returns successful discoveries", async () => {
  const stub = withFetchStub(async (input) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    if (url.includes("11434")) {
      return new Response(
        JSON.stringify({
          models: [{ name: "llama3.2" }],
        }),
        { status: 200 },
      );
    }

    if (url.includes("1234")) {
      return new Response(
        JSON.stringify({
          data: [{ id: "local-model", context_length: 32768 }],
        }),
        { status: 200 },
      );
    }

    return new Response("unavailable", { status: 503 });
  });

  try {
    const discovered = await discoverAllProviders({ includeCodexCli: false });
    assert.deepEqual(
      discovered.map((entry) => entry.provider),
      ["ollama", "openai"],
    );
  } finally {
    stub.restore();
  }
});

test("OpenAI-compatible provider still tracks usage through the shared config type", async () => {
  const stub = withFetchStub(async () =>
    new Response(
      JSON.stringify({
        model: "gpt-5.4",
        usage: { prompt_tokens: 9, completion_tokens: 4 },
        choices: [{ message: { content: "done" } }],
      }),
      { status: 200 },
    ));

  try {
    const provider = createOpenAiCompatibleProvider({ model: "gpt-5.4" });
    const result = await provider.complete("hello");

    assert.equal(result.text, "done");
    assert.equal(provider.getUsage().totalTokens, 13);
  } finally {
    stub.restore();
  }
});
