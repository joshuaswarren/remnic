import assert from "node:assert/strict";
import test from "node:test";

import { createOllamaProvider } from "./ollama.ts";

function mockOllamaFetch(responseBody: Record<string, unknown>) {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
  globalThis.fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    requests.push({
      url: String(url),
      headers: Object.fromEntries(headers.entries()),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    requests,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

test("ollama provider forwards Authorization header when apiKey is set", async () => {
  const mock = mockOllamaFetch({ response: "ok", prompt_eval_count: 1, eval_count: 1 });
  try {
    const provider = createOllamaProvider({
      provider: "ollama",
      model: "gemma4:31b",
      apiKey: "test-cloud-key",
    });
    await provider.complete("hello");
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0].headers.authorization, "Bearer test-cloud-key");
  } finally {
    mock.restore();
  }
});

test("ollama provider omits Authorization header when apiKey is not set", async () => {
  const mock = mockOllamaFetch({ response: "ok", prompt_eval_count: 1, eval_count: 1 });
  try {
    const provider = createOllamaProvider({
      provider: "ollama",
      model: "gemma4:26b",
    });
    await provider.complete("hello");
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0].headers.authorization, undefined);
  } finally {
    mock.restore();
  }
});

test("ollama provider uses custom baseUrl for cloud endpoints", async () => {
  const mock = mockOllamaFetch({ response: "cloud ok", prompt_eval_count: 2, eval_count: 3 });
  try {
    const provider = createOllamaProvider({
      provider: "ollama",
      model: "gemma4:31b",
      baseUrl: "https://ollama.com/api",
      apiKey: "cloud-key",
    });
    const result = await provider.complete("test");
    assert.equal(result.text, "cloud ok");
    assert.equal(result.tokens.input, 2);
    assert.equal(result.tokens.output, 3);
    assert.ok(mock.requests[0].url.startsWith("https://ollama.com/api/generate"));
    assert.equal(mock.requests[0].headers.authorization, "Bearer cloud-key");
  } finally {
    mock.restore();
  }
});

test("ollama provider defaults to localhost when baseUrl is omitted", async () => {
  const mock = mockOllamaFetch({ response: "local ok" });
  try {
    const provider = createOllamaProvider({
      provider: "ollama",
      model: "gemma4:26b",
    });
    await provider.complete("hello");
    assert.ok(mock.requests[0].url.startsWith("http://localhost:11434/api/generate"));
  } finally {
    mock.restore();
  }
});

test("ollama provider forwards config seed into the /api/generate options (issue #1573 PR2)", async () => {
  const mock = mockOllamaFetch({ response: "seeded ok", prompt_eval_count: 1, eval_count: 1 });
  try {
    const provider = createOllamaProvider({
      provider: "ollama",
      model: "gemma4:26b",
      temperature: 0,
      seed: 1573,
    });
    await provider.complete("hello");
    const body = mock.requests[0].body as { options: { seed?: number; temperature?: number } };
    assert.equal(body.options.seed, 1573, "manifest seed must reach the Ollama options.seed");
    assert.equal(body.options.temperature, 0, "manifest temperature must reach the Ollama options.temperature");
  } finally {
    mock.restore();
  }
});

test("ollama provider omits seed from options when config does not set it", async () => {
  const mock = mockOllamaFetch({ response: "ok", prompt_eval_count: 1, eval_count: 1 });
  try {
    const provider = createOllamaProvider({
      provider: "ollama",
      model: "gemma4:26b",
    });
    await provider.complete("hello");
    const body = mock.requests[0].body as { options: Record<string, unknown> };
    assert.equal(body.options.seed, undefined, "no seed key when config omits it");
  } finally {
    mock.restore();
  }
});
