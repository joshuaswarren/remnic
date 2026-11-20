import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLocalLlmRoutingHeaders,
  formatLocalLlmPoolKey,
  getLocalLlmTrippedBackendPoolState,
  markLocalLlmBackendPoolUnavailable,
} from "@remnic/core/local-llm-helpers";
import { LocalLlmClient } from "@remnic/core/local-llm";
import { initLogger } from "@remnic/core/logger";
import type { PluginConfig } from "@remnic/core/types";

const DEFAULT_CHAT_URL = "http://127.0.0.1:1234/v1/chat/completions";
const DEFAULT_CIRCUIT_OP = "entity_summary";

function poolCircuitState(chatUrl = DEFAULT_CHAT_URL, operation = DEFAULT_CIRCUIT_OP) {
  return getLocalLlmTrippedBackendPoolState(Date.now(), chatUrl, operation);
}

function clearPoolCircuit(chatUrl = DEFAULT_CHAT_URL, operation = DEFAULT_CIRCUIT_OP) {
  markLocalLlmBackendPoolUnavailable("", 0, chatUrl, operation);
}

function buildConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
  return {
    localLlmEnabled: true,
    localLlmUrl: "http://127.0.0.1:1234/v1",
    localLlmModel: "local-test-model",
    localLlmFallback: true,
    localLlmTimeoutMs: 50,
    localLlmRetry5xxCount: 1,
    localLlmRetryBackoffMs: 0,
    localLlm400TripThreshold: 3,
    localLlm400CooldownMs: 10_000,
    localLlmAuthHeader: true,
    debug: false,
    slowLogEnabled: false,
    slowLogThresholdMs: 30_000,
    ...overrides,
  } as PluginConfig;
}

function abortError(): Error {
  const err = new Error("This operation was aborted");
  Object.defineProperty(err, "name", { value: "AbortError" });
  return err;
}

test("LocalLlmClient retries abort errors and preserves availability", async () => {
  const warns: string[] = [];
  initLogger(
    {
      info() {},
      warn(msg: string) {
        warns.push(msg);
      },
      error() {},
      debug() {},
    },
    true,
  );

  const client = new LocalLlmClient(buildConfig());
  (client as any).isAvailable = true;
  (client as any).lastHealthCheck = Date.now();

  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) throw abortError();
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "{\"ok\":true}" } }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const out = await client.chatCompletion(
      [{ role: "user", content: "hello" }],
      { operation: "entity_summary", maxTokens: 100 },
    );
    assert.ok(out);
    assert.equal(calls, 2);
    assert.equal((client as any).isAvailable, true);
    assert.ok(warns.some((w) => w.includes("op=entity_summary")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LocalLlmClient abort exhaustion returns null without marking unavailable", async () => {
  initLogger(
    {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    true,
  );

  const client = new LocalLlmClient(buildConfig());
  (client as any).isAvailable = true;
  (client as any).lastHealthCheck = Date.now();

  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw abortError();
  }) as typeof fetch;

  try {
    const out = await client.chatCompletion(
      [{ role: "user", content: "hello" }],
      { operation: "extraction" },
    );
    assert.equal(out, null);
    assert.equal(calls, 2);
    assert.equal((client as any).isAvailable, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LocalLlmClient checkAvailability sends auth headers to health probes", async () => {
  initLogger(
    {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    true,
  );

  const client = new LocalLlmClient(buildConfig({
    localLlmApiKey: "top-secret",
    localLlmUrl: "http://localhost:11434",
  }));
  const originalFetch = globalThis.fetch;
  const authHeaders: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    const headers = new Headers(init?.headers);
    authHeaders.push(headers.get("authorization") ?? "");
    return new Response("Ollama", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }) as typeof fetch;

  try {
    const available = await client.checkAvailability();
    assert.equal(available, true);
    assert.deepEqual(authHeaders, ["Bearer top-secret"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LocalLlmClient detects llama.cpp from health response with /v1 config URL", async () => {
  initLogger(
    {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    true,
  );

  const client = new LocalLlmClient(buildConfig({ localLlmUrl: "http://localhost:8081/v1" }));
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    urls.push(url);
    if (url.endsWith("/health")) {
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/props")) {
      return new Response(
        JSON.stringify({
          default_generation_settings: {},
          total_slots: 1,
          model_path: "/models/qwen.gguf",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    if (url.endsWith("/v1/models")) {
      return new Response(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: "/models/qwen.gguf",
              object: "model",
              owned_by: "llamacpp",
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    return new Response("not found", {
      status: 404,
      headers: { "content-type": "text/plain" },
    });
  }) as typeof fetch;

  try {
    const available = await client.checkAvailability();
    assert.equal(available, true);
    assert.equal(client.getDetectedType(), "llamacpp");
    assert.ok(urls.includes("http://127.0.0.1:8081/health"));
    assert.ok(urls.includes("http://127.0.0.1:8081/props"));
    assert.ok(urls.includes("http://127.0.0.1:8081/v1/models"));
    assert.equal(
      urls.some((url) => url.includes("/v1/health") || url.includes("/v1/v1/models")),
      false,
      "availability probes should normalize configured /v1 URLs back to the server root",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LocalLlmClient preserves LM Studio detection for /v1 config URLs", async () => {
  initLogger(
    {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    true,
  );

  const client = new LocalLlmClient(buildConfig({ localLlmUrl: "http://localhost:1234/v1" }));
  client.disableThinking = true;
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    urls.push(url);
    if (url.endsWith("/v1/models")) {
      return new Response(
        JSON.stringify({
          object: "list",
          data: [{ id: "lm-studio-model", object: "model", owned_by: "lmstudio" }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    if (url.endsWith("/v1/chat/completions")) {
      if (init?.body) {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "{\"ok\":true}" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    return new Response("not found", {
      status: 404,
      headers: { "content-type": "text/plain" },
    });
  }) as typeof fetch;

  try {
    const available = await client.checkAvailability();
    assert.equal(available, true);
    assert.equal(client.getDetectedType(), "lmstudio");
    assert.equal(urls[0], "http://127.0.0.1:1234/v1/models");

    const out = await client.chatCompletion(
      [{ role: "user", content: "hello" }],
      { operation: "extraction" },
    );
    assert.ok(out);
    assert.deepEqual(bodies[0]?.chat_template_kwargs, { enable_thinking: false });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LocalLlmClient preserves LM Studio detection on custom /v1 ports", async () => {
  initLogger(
    {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    true,
  );

  const client = new LocalLlmClient(buildConfig({ localLlmUrl: "http://127.0.0.1:8081/v1" }));
  client.disableThinking = true;
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    urls.push(url);
    if (url.endsWith("/api/v1/models")) {
      return new Response(
        JSON.stringify({
          models: [
            {
              type: "llm",
              publisher: "google",
              key: "google/gemma-4-26b-a4b",
              display_name: "Gemma 4 26B A4B",
              format: "gguf",
              max_context_length: 262144,
              loaded_instances: [],
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    if (url.endsWith("/v1/models")) {
      return new Response(
        JSON.stringify({
          object: "list",
          data: [{ id: "lm-studio-model", object: "model", owned_by: "organization_owner" }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    if (url.endsWith("/v1/chat/completions")) {
      if (init?.body) {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "{\"ok\":true}" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    return new Response("not found", {
      status: 404,
      headers: { "content-type": "text/plain" },
    });
  }) as typeof fetch;

  try {
    const available = await client.checkAvailability();
    assert.equal(available, true);
    assert.equal(client.getDetectedType(), "lmstudio");
    assert.ok(urls.includes("http://127.0.0.1:8081/api/v1/models"));

    const out = await client.chatCompletion(
      [{ role: "user", content: "hello" }],
      { operation: "extraction" },
    );
    assert.ok(out);
    assert.deepEqual(bodies[0]?.chat_template_kwargs, { enable_thinking: false });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LocalLlmClient does not accept public llama.cpp health when authenticated models reject", async () => {
  const warns: string[] = [];
  initLogger(
    {
      info() {},
      warn(msg: string) {
        warns.push(msg);
      },
      error() {},
      debug() {},
    },
    true,
  );

  const client = new LocalLlmClient(
    buildConfig({
      localLlmUrl: "http://127.0.0.1:8081/v1",
      localLlmApiKey: "wrong-key",
      localLlmAuthHeader: true,
    }),
  );
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    urls.push(url);
    if (url.endsWith("/health")) {
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/v1/models")) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "content-type": "text/plain" },
      });
    }
    return new Response("not found", {
      status: 404,
      headers: { "content-type": "text/plain" },
    });
  }) as typeof fetch;

  try {
    const available = await client.checkAvailability();
    assert.equal(available, false);
    assert.equal(client.getDetectedType(), null);
    assert.ok(urls.includes("http://127.0.0.1:8081/health"));
    assert.ok(urls.includes("http://127.0.0.1:8081/props"));
    assert.ok(urls.includes("http://127.0.0.1:8081/v1/models"));
    assert.ok(
      warns.some((msg) => msg.includes("availability probe was unauthorized")),
      "expected unauthorized warning when authenticated llama.cpp model probe rejects",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LocalLlmClient rejects unauthorized llama.cpp models probes with custom auth headers", async () => {
  const warns: string[] = [];
  initLogger(
    {
      info() {},
      warn(msg: string) {
        warns.push(msg);
      },
      error() {},
      debug() {},
    },
    true,
  );

  const client = new LocalLlmClient(
    buildConfig({
      localLlmUrl: "http://127.0.0.1:8081/v1",
      localLlmAuthHeader: false,
      localLlmHeaders: { Authorization: "Bearer wrong-custom-token" },
    }),
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/health")) {
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/props")) {
      return new Response(
        JSON.stringify({
          default_generation_settings: {},
          total_slots: 1,
          model_path: "/models/qwen.gguf",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    if (url.endsWith("/v1/models")) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "content-type": "text/plain" },
      });
    }
    return new Response("not found", {
      status: 404,
      headers: { "content-type": "text/plain" },
    });
  }) as typeof fetch;

  try {
    const available = await client.checkAvailability();
    assert.equal(available, false);
    assert.equal(client.getDetectedType(), null);
    assert.ok(
      warns.some((msg) => msg.includes("availability probe was unauthorized")),
      "expected unauthorized warning for custom-auth llama.cpp model probe rejection",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LocalLlmClient does not treat generic status health as llama.cpp", async () => {
  initLogger(
    {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    true,
  );

  const client = new LocalLlmClient(buildConfig({ localLlmUrl: "http://127.0.0.1:8081/v1" }));
  client.disableThinking = true;
  const originalFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/health")) {
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/props")) {
      return new Response("not found", {
        status: 404,
        headers: { "content-type": "text/plain" },
      });
    }
    if (url.endsWith("/v1/models")) {
      return new Response(
        JSON.stringify({
          object: "list",
          models: [{ id: "native-style-field-that-is-not-llama-cpp" }],
          data: [{ id: "strict-proxy-model", object: "model", owned_by: "proxy" }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    if (url.endsWith("/v1/chat/completions")) {
      if (init?.body) {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "{\"ok\":true}" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    return new Response("not found", {
      status: 404,
      headers: { "content-type": "text/plain" },
    });
  }) as typeof fetch;

  try {
    const available = await client.checkAvailability();
    assert.equal(available, true);
    assert.notEqual(client.getDetectedType(), "llamacpp");
    const out = await client.chatCompletion(
      [{ role: "user", content: "hello" }],
      { operation: "extraction" },
    );
    assert.ok(out);
    assert.equal("chat_template_kwargs" in (bodies[0] ?? {}), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LocalLlmClient still detects vLLM from empty health response", async () => {
  initLogger(
    {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    true,
  );

  const client = new LocalLlmClient(buildConfig({ localLlmUrl: "http://127.0.0.1:8000" }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/health")) {
      return new Response("", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }
    return new Response("not found", {
      status: 404,
      headers: { "content-type": "text/plain" },
    });
  }) as typeof fetch;

  try {
    const available = await client.checkAvailability();
    assert.equal(available, true);
    assert.equal(client.getDetectedType(), "vllm");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LocalLlmClient trips plain-text backend failures using configured cooldown", async () => {
  initLogger(
    {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    true,
  );

  const client = new LocalLlmClient(buildConfig({ localLlm400CooldownMs: 25 }));
  (client as any).isAvailable = true;
  (client as any).lastHealthCheck = Date.now();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("Failed to load model", {
      status: 503,
      headers: { "content-type": "text/plain" },
    })) as typeof fetch;

  try {
    const out = await client.chatCompletion([{ role: "user", content: "hello" }], {
      operation: "entity_summary",
    });
    assert.equal(out, null);
    const state = poolCircuitState();
    assert.ok(state);
    assert.match(state.reason, /Failed to load model/i);
    assert.ok(state.untilMs > Date.now());
  } finally {
    clearPoolCircuit();
    globalThis.fetch = originalFetch;
  }
});

test("LocalLlmClient warns when authenticated availability probes are unauthorized", async () => {
  const warns: string[] = [];
  initLogger(
    {
      info() {},
      warn(msg: string) {
        warns.push(msg);
      },
      error() {},
      debug() {},
    },
    true,
  );

  const client = new LocalLlmClient(buildConfig({ localLlmApiKey: "wrong-key" }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("Unauthorized", {
      status: 401,
      headers: { "content-type": "text/plain" },
    })) as typeof fetch;

  try {
    const available = await client.checkAvailability();
    assert.equal(available, false);
    assert.ok(
      warns.some((msg) => msg.includes("availability probe was unauthorized")),
      "expected unauthorized health probe warning",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LocalLlmClient does not retry non-recoverable 5xx backend failures", async () => {
  initLogger(
    {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    true,
  );

  const client = new LocalLlmClient(buildConfig({ localLlm400CooldownMs: 25, localLlmRetry5xxCount: 3 }));
  (client as any).isAvailable = true;
  (client as any).lastHealthCheck = Date.now();

  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response("Failed to load model", {
      status: 503,
      headers: { "content-type": "text/plain" },
    });
  }) as typeof fetch;

  try {
    const out = await client.chatCompletion([{ role: "user", content: "hello" }], {
      operation: "entity_summary",
    });
    assert.equal(out, null);
    assert.equal(calls, 1);
    const state = poolCircuitState();
    assert.ok(state);
    assert.match(state.reason, /Failed to load model/i);
    assert.ok(state.untilMs > Date.now());
  } finally {
    clearPoolCircuit();
    globalThis.fetch = originalFetch;
  }
});

test("LocalLlmClient probes immediately after zero-duration backend trip", async () => {
  initLogger(
    {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    true,
  );

  const client = new LocalLlmClient(buildConfig({ localLlm400CooldownMs: 0 }));
  (client as any).isAvailable = false;
  // SAFETY: test forces an immediate probe by clearing the cached health timestamp.
  (client as any).lastHealthCheck = 0;
  markLocalLlmBackendPoolUnavailable("Failed to load model", 0, DEFAULT_CHAT_URL, DEFAULT_CIRCUIT_OP);

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response(
      JSON.stringify({
        data: [{ id: "local-test-model" }],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const available = await client.checkAvailability();
    assert.equal(available, true);
    assert.ok(fetchCalls > 0, "expected an immediate availability probe after circuit expiry");
  } finally {
    clearPoolCircuit();
    globalThis.fetch = originalFetch;
  }
});

test("LocalLlmClient shares backend circuit state across models on equivalent endpoint URLs", () => {
  initLogger(
    {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    true,
  );

  const primary = new LocalLlmClient(
    buildConfig({ localLlmModel: "primary-model", localLlmUrl: "http://127.0.0.1:1234/v1" }),
  );
  const fast = new LocalLlmClient(
    buildConfig({ localLlmModel: "fast-model", localLlmUrl: "http://127.0.0.1:1234" }),
  );

  const sharedChatUrl = "http://127.0.0.1:1234/v1/chat/completions";
  const circuitOp = DEFAULT_CIRCUIT_OP;
  markLocalLlmBackendPoolUnavailable("Failed to load model", 25, sharedChatUrl, circuitOp);

  try {
    assert.equal(
      formatLocalLlmPoolKey("http://127.0.0.1:1234/v1/chat/completions", circuitOp),
      formatLocalLlmPoolKey("http://127.0.0.1:1234", circuitOp),
    );
    const sharedState = getLocalLlmTrippedBackendPoolState(Date.now(), sharedChatUrl, circuitOp);
    assert.ok(sharedState);
    assert.equal(sharedState.reason, "Failed to load model");
  } finally {
    clearPoolCircuit(sharedChatUrl, circuitOp);
  }
});

test("LocalLlmClient stores a matched backend failure reason instead of raw error text", async () => {
  initLogger(
    {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    true,
  );

  const client = new LocalLlmClient(buildConfig({ localLlm400CooldownMs: 25 }));
  (client as any).isAvailable = true;
  (client as any).lastHealthCheck = Date.now();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("Internal error while loading backend. Failed to load model due to Team IDs mismatch.", {
      status: 503,
      headers: { "content-type": "text/plain" },
    })) as typeof fetch;

  try {
    const out = await client.chatCompletion([{ role: "user", content: "hello" }], {
      operation: "entity_summary",
    });
    assert.equal(out, null);
    const state = poolCircuitState();
    assert.ok(state);
    assert.equal(state.reason, "Failed to load model");
  } finally {
    clearPoolCircuit();
    globalThis.fetch = originalFetch;
  }
});

test("LocalLlmClient clears peer health cache while a shared backend circuit is open", async () => {
  initLogger(
    {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    true,
  );

  const primary = new LocalLlmClient(buildConfig({ localLlmModel: "primary-model" }));
  const peer = new LocalLlmClient(buildConfig({ localLlmModel: "peer-model" }));
  (peer as any).isAvailable = false;
  (peer as any).lastHealthCheck = Date.now();
  markLocalLlmBackendPoolUnavailable("Failed to load model", 25, DEFAULT_CHAT_URL, DEFAULT_CIRCUIT_OP);

  try {
    const available = await peer.checkAvailability(undefined, DEFAULT_CHAT_URL, DEFAULT_CIRCUIT_OP);
    assert.equal(available, false);
    assert.equal((peer as any).lastHealthCheck, 0);
  } finally {
    clearPoolCircuit();
  }
});

test("LocalLlmClient getLoadedModelInfo sends auth headers to models probe", async () => {
  initLogger(
    {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    true,
  );

  const client = new LocalLlmClient(buildConfig({ localLlmApiKey: "top-secret" }));
  const originalFetch = globalThis.fetch;
  let authHeader = "";
  globalThis.fetch = (async (_input, init) => {
    authHeader = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(
      JSON.stringify({
        data: [{ id: "local-test-model", max_context_length: 32768 }],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const modelInfo = await client.getLoadedModelInfo();
    assert.ok(modelInfo);
    assert.equal(modelInfo.id, "local-test-model");
    assert.equal(authHeader, "Bearer top-secret");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/**
 * Issue #2210: a busy event loop can burn the health probe's fixed 2s budget
 * before the socket is even scheduled. The probe aborts, and the client used to
 * record that as "backend unavailable" and cache it — taking extraction offline
 * while the backend was answering other callers in single-digit milliseconds.
 */
test("a timed-out availability probe leaves availability unknown instead of caching a blackout", async () => {
  initLogger(undefined, false);
  const client = new LocalLlmClient(buildConfig());
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw abortError();
  }) as typeof fetch;
  try {
    assert.equal(await client.checkAvailability(), false, "this call still fails");
    const afterFirst = calls;
    assert.ok(afterFirst > 0, "probes ran");

    // The point: the next call must RE-PROBE. A cached false would serve the
    // stale verdict for the whole health-check interval with no new requests.
    assert.equal(await client.checkAvailability(), false);
    assert.ok(calls > afterFirst, "a timed-out probe must not be cached as a verdict");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a definitive probe failure IS cached for the health-check interval", async () => {
  initLogger(undefined, false);
  const client = new LocalLlmClient(buildConfig());
  const originalFetch = globalThis.fetch;
  let calls = 0;
  // A backend that ANSWERS and says no is a real verdict, unlike a timeout.
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response("nope", { status: 500, headers: { "content-type": "text/plain" } });
  }) as unknown as typeof fetch;
  try {
    assert.equal(await client.checkAvailability(), false);
    const afterFirst = calls;
    assert.ok(afterFirst > 0, "probes ran");
    assert.equal(await client.checkAvailability(), false);
    assert.equal(calls, afterFirst, "a definitive failure must be cached, not re-probed every request");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("concurrent availability checks share one probe sequence", async () => {
  initLogger(undefined, false);
  const client = new LocalLlmClient(buildConfig());
  const originalFetch = globalThis.fetch;
  let probes = 0;
  let releaseProbes!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseProbes = resolve;
  });
  // Hold every probe open so all five callers are genuinely in flight at once.
  globalThis.fetch = (async () => {
    probes += 1;
    await gate;
    return new Response("nope", { status: 500, headers: { "content-type": "text/plain" } });
  }) as unknown as typeof fetch;
  try {
    const callers = [1, 2, 3, 4, 5].map(() => client.checkAvailability());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const concurrentProbes = probes;
    releaseProbes();
    const results = await Promise.all(callers);
    assert.deepEqual(results, [false, false, false, false, false]);
    assert.equal(
      concurrentProbes,
      1,
      "five concurrent callers must not each start their own probe sequence",
    );
  } finally {
    releaseProbes();
    globalThis.fetch = originalFetch;
  }
});

test("one caller cancelling does not abort a probe the others still await", async () => {
  initLogger(undefined, false);
  const client = new LocalLlmClient(buildConfig());
  const originalFetch = globalThis.fetch;
  let releaseProbes!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseProbes = resolve;
  });
  let completedProbes = 0;
  globalThis.fetch = (async () => {
    await gate;
    completedProbes += 1;
    return new Response(JSON.stringify({ models: [{ id: "m" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const quitter = new AbortController();
  try {
    const abandoned = client.checkAvailability(quitter.signal);
    const stayer = client.checkAvailability();
    await new Promise((resolve) => setTimeout(resolve, 20));
    quitter.abort();
    assert.equal(await abandoned, false, "the cancelling caller gets a prompt negative");
    releaseProbes();
    assert.equal(await stayer, true, "the remaining caller still gets a real verdict");
    assert.ok(completedProbes > 0, "the shared probe was not aborted out from under the stayer");
  } finally {
    releaseProbes();
    globalThis.fetch = originalFetch;
  }
});

test("a caller arriving after the last waiter cancels starts a fresh probe", async () => {
  initLogger(undefined, false);
  const client = new LocalLlmClient(buildConfig());
  const originalFetch = globalThis.fetch;
  let sequences = 0;
  // Ignore cancellation entirely: the doomed sequence stays pending, which is
  // exactly the window where a late caller could join it.
  globalThis.fetch = (async () => {
    sequences += 1;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return new Response(JSON.stringify({ models: [{ id: "m" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const quitter = new AbortController();
  try {
    const abandoned = client.checkAvailability(quitter.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    quitter.abort();
    assert.equal(await abandoned, false);
    const late = await client.checkAvailability();
    assert.equal(late, true, "a late caller must get a real verdict, not the aborted one's false");
    assert.ok(sequences >= 2, "the late caller must start its own sequence, not join the doomed one");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LocalLlmClient sends a terminal recall-pool 503 once, with the proxy's real payload", async () => {
  // wAN on #3474: the proxy answers {"error":"recall pool missing or disabled; ..."}
  // — an error field, no code — and the client still ran the generic 5xx retry.
  initLogger(
    {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    true,
  );

  const client = new LocalLlmClient(buildConfig({ localLlmRetry5xxCount: 2, localLlmRetryBackoffMs: 0 }));
  // SAFETY: test seeds the private health cache so the first request goes straight to fetch.
  (client as any).isAvailable = true;
  // SAFETY: same seeding — a fresh timestamp keeps the cache inside its minute window.
  (client as any).lastHealthCheck = Date.now();

  const originalFetch = globalThis.fetch;
  let calls = 0;
  // SAFETY: the stub replaces global fetch for this test and is restored in finally.
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({ error: "recall pool missing or disabled; recall ops must not use the extraction pool" }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const out = await client.chatCompletion([{ role: "user", content: "hello" }], {
      operation: "entity_summary",
    });
    assert.equal(out, null);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LocalLlmClient pool expiry invalidates every client's cached verdict, not just the first", async () => {
  initLogger(
    {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    true,
  );

  const first = new LocalLlmClient(buildConfig());
  const second = new LocalLlmClient(buildConfig());
  // The second client holds a genuine probe verdict from while the pool was down.
  // SAFETY: test seeds the private health cache with the stale verdict under test.
  (second as any).isAvailable = false;
  // SAFETY: same seeding — a fresh timestamp keeps the stale verdict inside its minute window.
  (second as any).lastHealthCheck = Date.now();
  markLocalLlmBackendPoolUnavailable("Failed to load model", 5, DEFAULT_CHAT_URL, DEFAULT_CIRCUIT_OP);
  await new Promise((resolve) => setTimeout(resolve, 25));

  const originalFetch = globalThis.fetch;
  // SAFETY: the stub replaces global fetch for this test and is restored in finally.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: [{ id: "local-test-model" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  try {
    assert.equal(await first.checkAvailability(undefined, DEFAULT_CHAT_URL, DEFAULT_CIRCUIT_OP), true);
    assert.equal(await second.checkAvailability(undefined, DEFAULT_CHAT_URL, DEFAULT_CIRCUIT_OP), true);
  } finally {
    clearPoolCircuit();
    globalThis.fetch = originalFetch;
  }
});

test("LocalLlmClient honors the pool circuit for an empty operation label", async () => {
  initLogger(
    {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    true,
  );

  const client = new LocalLlmClient(buildConfig());
  // SAFETY: test seeds the private health cache so a probe would count as a fetch call.
  (client as any).isAvailable = true;
  // SAFETY: same seeding — a fresh timestamp keeps the cache inside its minute window.
  (client as any).lastHealthCheck = Date.now();
  markLocalLlmBackendPoolUnavailable("Failed to load model", 10_000, DEFAULT_CHAT_URL, "");

  const originalFetch = globalThis.fetch;
  let calls = 0;
  // SAFETY: the stub replaces global fetch for this test and is restored in finally.
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  try {
    assert.equal(await client.checkAvailability(undefined, DEFAULT_CHAT_URL, ""), false);
    assert.equal(calls, 0);
  } finally {
    markLocalLlmBackendPoolUnavailable("", 0, DEFAULT_CHAT_URL, "");
    globalThis.fetch = originalFetch;
  }
});

test("buildLocalLlmRoutingHeaders drops a label fetch cannot send", () => {
  // Kilo on #3474: Headers takes a ByteString — \u0100 is out, \u00e9 is fine.
  const latin = buildLocalLlmRoutingHeaders("caf\u00e9-op", undefined);
  assert.equal(latin["X-Remnic-Operation"], "caf\u00e9-op");
  const unsendable = buildLocalLlmRoutingHeaders("bad\u0100op", undefined);
  assert.equal("X-Remnic-Operation" in unsendable, false);
  const control = buildLocalLlmRoutingHeaders("bad\u0007op", undefined);
  assert.equal("X-Remnic-Operation" in control, false);
});
