import assert from "node:assert/strict";
import test from "node:test";

import { startLocalLlmMockServer } from "../fixtures/local-llm/mock-server.ts";
import { createLocalLlmProvider } from "./local-llm.ts";

test("local-llm provider rejects missing baseUrl with a listed-option error", () => {
  assert.throws(
    () =>
      createLocalLlmProvider({
        provider: "local-llm",
        model: "local-llm-fixture-small",
        baseUrl: "",
      }),
    /requires --base-url[\s\S]*llama\.cpp[\s\S]*vLLM[\s\S]*LM Studio/,
  );
});

test("local-llm provider replays chat completions against the mock server", async () => {
  const server = await startLocalLlmMockServer();
  try {
    const provider = createLocalLlmProvider({
      provider: "local-llm",
      model: "local-llm-fixture-small",
      baseUrl: server.baseUrl,
    });

    const result = await provider.complete("hello");

    assert.equal(result.text, "The canonical bench smoke response is: ok.");
    assert.equal(result.tokens.input, 9);
    assert.equal(result.tokens.output, 7);
    assert.equal(result.model, "local-llm-fixture");
    assert.ok(result.latencyMs >= 0);

    // The provider must have talked to THIS mock, not api.openai.com.
    // CLAUDE.md rule 55: end-to-end wiring needs a test.
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].method, "POST");
    assert.equal(server.requests[0].pathname, "/v1/chat/completions");
    const payload = JSON.parse(server.requests[0].body);
    assert.equal(payload.model, "local-llm-fixture-small");
    assert.deepEqual(payload.messages, [{ role: "user", content: "hello" }]);

    const usage = provider.getUsage();
    assert.equal(usage.inputTokens, 9);
    assert.equal(usage.outputTokens, 7);
    assert.equal(usage.totalTokens, 16);
  } finally {
    await server.close();
  }
});

test("local-llm provider discovers models from the mock /v1/models route", async () => {
  const server = await startLocalLlmMockServer();
  try {
    const provider = createLocalLlmProvider({
      provider: "local-llm",
      model: "local-llm-fixture-small",
      baseUrl: server.baseUrl,
    });

    const models = await provider.discover?.();
    assert.ok(models, "discover() should return models for local-llm");
    assert.equal(models.length, 2);
    assert.equal(models[0].id, "local-llm-fixture-small");
    assert.equal(models[0].contextLength, 8192);
    assert.equal(models[1].id, "local-llm-fixture-large");
    assert.equal(models[1].contextLength, 32768);

    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].method, "GET");
    assert.equal(server.requests[0].pathname, "/v1/models");
  } finally {
    await server.close();
  }
});

test("local-llm provider surfaces non-2xx errors with base-url + model in the message", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("model not loaded", {
      status: 503,
      statusText: "Service Unavailable",
      headers: { "content-type": "text/plain" },
    });

  try {
    const provider = createLocalLlmProvider({
      provider: "local-llm",
      model: "my-local-model",
      baseUrl: "http://127.0.0.1:9876/v1",
      retryOptions: { maxAttempts: 1, baseBackoffMs: 0 },
    });

    await assert.rejects(
      provider.complete("hello"),
      /local-llm completion failed:.*503.*model not loaded.*base-url=http:\/\/127\.0\.0\.1:9876\/v1, model=my-local-model/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("local-llm provider auto-appends /v1 when baseUrl omits it (Codex P1 on PR #613)", async () => {
  const server = await startLocalLlmMockServer();
  try {
    // The mock server serves /v1/chat/completions; the real complaint
    // was that a user passing the bare host (`http://host:port`) would
    // hit /chat/completions which 404s on most OpenAI-compatible
    // servers. Strip `/v1` from the mock's baseUrl and confirm the
    // provider re-appends it before the request is dispatched.
    const strippedBase = server.baseUrl.replace(/\/v1$/, "");
    assert.ok(!strippedBase.endsWith("/v1"), "fixture must strip /v1");

    const provider = createLocalLlmProvider({
      provider: "local-llm",
      model: "local-llm-fixture-small",
      baseUrl: strippedBase,
    });

    const result = await provider.complete("hello");
    assert.equal(result.text, "The canonical bench smoke response is: ok.");
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].pathname, "/v1/chat/completions");
  } finally {
    await server.close();
  }
});

test("local-llm provider does not double-apply /v1 when baseUrl already ends with it", async () => {
  const server = await startLocalLlmMockServer();
  try {
    const provider = createLocalLlmProvider({
      provider: "local-llm",
      model: "local-llm-fixture-small",
      baseUrl: server.baseUrl, // already ends in /v1
    });

    await provider.complete("hello");
    assert.equal(server.requests[0].pathname, "/v1/chat/completions");
    assert.ok(
      !server.requests[0].pathname.startsWith("/v1/v1/"),
      "must not produce /v1/v1/",
    );
  } finally {
    await server.close();
  }
});

test("local-llm provider forwards Authorization header when apiKey is set", async () => {
  let seenAuth: string | null = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    seenAuth = headers.get("authorization");
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        model: "any",
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };

  try {
    const provider = createLocalLlmProvider({
      provider: "local-llm",
      model: "m",
      baseUrl: "http://127.0.0.1:8080/v1",
      apiKey: "test-token",
    });
    await provider.complete("hi");
    assert.equal(seenAuth, "Bearer test-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("local-llm provider sends chat_template_kwargs when disableThinking is true", async () => {
  let capturedBody: string | null = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    capturedBody = init?.body as string;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        model: "test",
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };

  try {
    const provider = createLocalLlmProvider({
      provider: "local-llm",
      model: "google/gemma-4-26b-a4b",
      baseUrl: "http://127.0.0.1:1234/v1",
      disableThinking: true,
    });

    await provider.complete("hello");
    const parsed = JSON.parse(capturedBody!);
    assert.deepEqual(parsed.chat_template_kwargs, { enable_thinking: false });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("local-llm provider sends chat_template_kwargs for vLLM when baseUrl omits /v1", async () => {
  let capturedBody: string | null = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    capturedBody = init?.body as string;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        model: "test",
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };

  try {
    const provider = createLocalLlmProvider({
      provider: "local-llm",
      model: "google/gemma-4-26b-a4b",
      baseUrl: "http://127.0.0.1:8000",
      disableThinking: true,
    });

    await provider.complete("hello");
    const parsed = JSON.parse(capturedBody!);
    assert.deepEqual(parsed.chat_template_kwargs, { enable_thinking: false });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("local-llm provider does not send chat_template_kwargs for generic backends", async () => {
  let capturedBody: string | null = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    capturedBody = init?.body as string;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        model: "test",
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };

  try {
    const provider = createLocalLlmProvider({
      provider: "local-llm",
      model: "generic-model",
      baseUrl: "http://127.0.0.1:8080/v1",
      disableThinking: true,
    });

    await provider.complete("hello");
    const parsed = JSON.parse(capturedBody!);
    assert.equal(parsed.chat_template_kwargs, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("local-llm provider does not send chat_template_kwargs when disableThinking is omitted", async () => {
  let capturedBody: string | null = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    capturedBody = init?.body as string;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        model: "test",
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };

  try {
    const provider = createLocalLlmProvider({
      provider: "local-llm",
      model: "some-model",
      baseUrl: "http://127.0.0.1:1234/v1",
    });

    await provider.complete("hello");
    const parsed = JSON.parse(capturedBody!);
    assert.equal(parsed.chat_template_kwargs, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
