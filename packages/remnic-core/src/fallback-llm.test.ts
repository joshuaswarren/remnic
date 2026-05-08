import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { FallbackLlmClient } from "./fallback-llm.js";
import { __codexCliFallbackTestHooks } from "./codex-cli-fallback.js";
import { clearModelsJsonCache, __setModelsJsonForTest } from "./models-json.js";
import {
  __setGatewayRuntimeAuthForModelForTest,
  __setGatewayResolverForTest,
  clearSecretCache,
} from "./resolve-provider-secret.js";

test("fallback llm prefers the active gateway provider config over models.json", { concurrency: false }, async () => {
  __setModelsJsonForTest({
    "custom-provider": {
      baseUrl: "https://materialized.example/v1",
      api: "openai-completions",
      apiKey: "materialized-key",
      models: [],
    },
  });
  clearSecretCache();

  const llm = new FallbackLlmClient({
    agents: {
      defaults: {
        model: {
          primary: "custom-provider/demo-model",
        },
      },
    },
    models: {
      providers: {
        "custom-provider": {
          baseUrl: "https://raw.example",
          api: "openai-completions",
          apiKey: "raw-key",
          models: [],
        },
      },
    },
  });

  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  globalThis.fetch = (async (url, init) => {
    capturedUrl = String(url);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const response = await llm.chatCompletion(
      [{ role: "user", content: "Say OK" }],
      { temperature: 0, maxTokens: 16 },
    );

    assert.equal(response?.content, "ok");
    assert.equal(capturedUrl, "https://raw.example/v1/chat/completions");
  } finally {
    globalThis.fetch = originalFetch;
    clearModelsJsonCache();
    clearSecretCache();
  }
});

test("fallback llm passes the OpenClaw workspace to runtime auth", { concurrency: false }, async () => {
  clearModelsJsonCache();
  clearSecretCache();

  const previousHome = process.env.HOME;
  process.env.HOME = "/tmp/remnic-openclaw-home";
  let capturedWorkspaceDir: string | undefined;
  __setGatewayRuntimeAuthForModelForTest(async ({ workspaceDir }) => {
    capturedWorkspaceDir = workspaceDir;
    return {
      apiKey: "runtime-key",
      baseUrl: "https://runtime.example/v1",
      source: "test-runtime",
      mode: "oauth",
    };
  });

  const llm = new FallbackLlmClient({
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
          baseUrl: "https://raw.example/v1",
          api: "openai-completions",
          apiKey: "secretref-managed",
          models: [],
        },
      },
    },
  });

  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedAuth = "";
  globalThis.fetch = (async (url, init) => {
    capturedUrl = String(url);
    capturedAuth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const response = await llm.chatCompletion(
      [{ role: "user", content: "Say OK" }],
      { temperature: 0, maxTokens: 16 },
    );

    assert.equal(response?.content, "ok");
    assert.equal(capturedUrl, "https://runtime.example/v1/chat/completions");
    assert.equal(capturedAuth, "Bearer runtime-key");
    assert.equal(
      capturedWorkspaceDir,
      path.join("/tmp/remnic-openclaw-home", ".openclaw", "workspace"),
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    clearSecretCache();
  }
});

test("fallback llm prefers a configured workspace for runtime auth", { concurrency: false }, async () => {
  clearModelsJsonCache();
  clearSecretCache();

  const previousHome = process.env.HOME;
  process.env.HOME = "/tmp/remnic-configured-home";
  let capturedWorkspaceDir: string | undefined;
  __setGatewayRuntimeAuthForModelForTest(async ({ workspaceDir }) => {
    capturedWorkspaceDir = workspaceDir;
    return {
      apiKey: "runtime-key",
      baseUrl: "https://runtime.example/v1",
      source: "test-runtime",
      mode: "oauth",
    };
  });

  const llm = new FallbackLlmClient(
    {
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
            baseUrl: "https://raw.example/v1",
            api: "openai-completions",
            apiKey: "secretref-managed",
            models: [],
          },
        },
      },
    },
    { workspaceDir: "~/custom-openclaw-workspace" },
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    )) as typeof fetch;

  try {
    const response = await llm.chatCompletion(
      [{ role: "user", content: "Say OK" }],
      { temperature: 0, maxTokens: 16 },
    );

    assert.equal(response?.content, "ok");
    assert.equal(
      capturedWorkspaceDir,
      path.join("/tmp/remnic-configured-home", "custom-openclaw-workspace"),
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    clearSecretCache();
  }
});

test("fallback llm falls back to models.json for built-in providers missing from the active config", { concurrency: false }, async () => {
  __setModelsJsonForTest({
    "built-in-provider": {
      baseUrl: "https://materialized.example/v1",
      api: "openai-completions",
      apiKey: "materialized-key",
      models: [],
    },
  });
  clearSecretCache();

  const llm = new FallbackLlmClient({
    agents: {
      defaults: {
        model: {
          primary: "built-in-provider/demo-model",
        },
      },
    },
    models: {
      providers: {},
    },
  });

  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  globalThis.fetch = (async (url) => {
    capturedUrl = String(url);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const response = await llm.chatCompletion(
      [{ role: "user", content: "Say OK" }],
      { temperature: 0, maxTokens: 16 },
    );

    assert.equal(response?.content, "ok");
    assert.equal(capturedUrl, "https://materialized.example/v1/chat/completions");
  } finally {
    globalThis.fetch = originalFetch;
    clearModelsJsonCache();
    clearSecretCache();
  }
});

test("fallback llm resolves legacy openai-codex model refs through the codex provider", { concurrency: false }, async () => {
  clearModelsJsonCache();
  clearSecretCache();

  const llm = new FallbackLlmClient({
    agents: {
      defaults: {
        model: {
          primary: "openai-codex/gpt-5.5",
        },
      },
    },
    models: {
      providers: {
        codex: {
          baseUrl: "https://codex.example/v1",
          api: "openai-codex-responses",
          apiKey: "codex-test-key",
          models: [],
        },
      },
    },
  });

  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  globalThis.fetch = (async (url) => {
    capturedUrl = String(url);
    return new Response(
      JSON.stringify({
        output_text: "ok from codex alias",
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const response = await llm.chatCompletion(
      [{ role: "user", content: "Say OK" }],
      { temperature: 0, maxTokens: 16 },
    );

    assert.equal(response?.content, "ok from codex alias");
    assert.equal(response?.modelUsed, "openai-codex/gpt-5.5");
    assert.equal(capturedUrl, "https://codex.example/v1/responses");
  } finally {
    globalThis.fetch = originalFetch;
    clearModelsJsonCache();
    clearSecretCache();
  }
});

test("fallback llm prefers requested canonical models.json provider before legacy aliases", { concurrency: false }, async () => {
  __setModelsJsonForTest({
    codex: {
      baseUrl: "https://codex.example/v1",
      api: "openai-responses",
      apiKey: "codex-test-key",
      models: [],
    },
    "openai-codex": {
      baseUrl: "https://legacy-codex.example/v1",
      api: "openai-responses",
      apiKey: "secretref-managed",
      models: [],
    },
  });
  clearSecretCache();

  const llm = new FallbackLlmClient({
    agents: {
      defaults: {
        model: {
          primary: "codex/gpt-5.5",
        },
      },
    },
    models: {
      providers: {},
    },
  });

  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  globalThis.fetch = (async (url) => {
    capturedUrl = String(url);
    return new Response(
      JSON.stringify({
        output_text: "ok from canonical codex",
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const response = await llm.chatCompletion(
      [{ role: "user", content: "Say OK" }],
      { temperature: 0, maxTokens: 16 },
    );

    assert.equal(response?.content, "ok from canonical codex");
    assert.equal(capturedUrl, "https://codex.example/v1/responses");
  } finally {
    globalThis.fetch = originalFetch;
    clearModelsJsonCache();
    clearSecretCache();
  }
});

test("fallback llm invokes registered codex-cli fallback runner", { concurrency: false }, async () => {
  clearModelsJsonCache();
  clearSecretCache();

  const captured: {
    modelId?: string;
    messages?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    apiKey?: string | Record<string, unknown>;
    executable?: unknown;
    reasoningEffort?: unknown;
    timeoutMs?: number;
  } = {};
  const restoreRunner = __codexCliFallbackTestHooks.setRunCodexCliForTest(
    async (request) => {
      captured.modelId = request.modelId;
      captured.messages = request.messages;
      captured.apiKey = request.config.apiKey;
      captured.executable = request.config.executable;
      captured.reasoningEffort = request.config.reasoningEffort;
      captured.timeoutMs = request.config.retryOptions?.timeoutMs as number | undefined;
      return {
        content: "final codex answer",
        usage: {
          inputTokens: 40,
          outputTokens: 4,
          totalTokens: 44,
        },
      };
    },
  );

  const llm = new FallbackLlmClient({
    agents: {
      defaults: {
        model: {
          primary: "codex-cli/gpt-custom",
        },
      },
    },
    models: {
      providers: {
        "codex-cli": {
          baseUrl: "",
          api: "codex-cli",
          apiKey: "codex-test-key",
          executable: "codex-test-bin",
          reasoningEffort: "high",
          retryOptions: { timeoutMs: 1234 },
          models: [],
        },
      },
    },
  });

  try {
    const response = await llm.chatCompletion(
      [
        { role: "system", content: "Return concise JSON." },
        { role: "user", content: "Say OK" },
      ],
      { temperature: 0, maxTokens: 16, timeoutMs: 5000 },
    );

    assert.equal(response?.content, "final codex answer");
    assert.equal(response?.modelUsed, "codex-cli/gpt-custom");
    assert.equal(response?.usage?.totalTokens, 44);
    assert.equal(captured.modelId, "gpt-custom");
    assert.deepEqual(captured.messages, [
      { role: "system", content: "Return concise JSON." },
      { role: "user", content: "Say OK" },
    ]);
    assert.equal(captured.apiKey, "codex-test-key");
    assert.equal(captured.executable, "codex-test-bin");
    assert.equal(captured.reasoningEffort, "high");
    assert.equal(captured.timeoutMs, 1234);
  } finally {
    restoreRunner();
    clearModelsJsonCache();
    clearSecretCache();
  }
});

test("fallback llm aborts codex-cli fallback requests when timeout wins", { concurrency: false }, async () => {
  clearModelsJsonCache();
  clearSecretCache();

  let capturedSignal: AbortSignal | undefined;
  let sawAbort = false;
  const restoreRunner = __codexCliFallbackTestHooks.setRunCodexCliForTest(
    async (request) => {
      capturedSignal = request.options.signal;
      return await new Promise<never>((_resolve, reject) => {
        const onAbort = (): void => {
          sawAbort = true;
          reject(request.options.signal?.reason ?? new Error("aborted"));
        };
        if (request.options.signal?.aborted) {
          onAbort();
          return;
        }
        request.options.signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  );

  const llm = new FallbackLlmClient({
    agents: {
      defaults: {
        model: {
          primary: "codex-cli/gpt-custom",
        },
      },
    },
    models: {
      providers: {
        "codex-cli": {
          baseUrl: "",
          api: "codex-cli",
          apiKey: "codex-test-key",
          models: [],
        },
      },
    },
  });

  try {
    const response = await llm.chatCompletion(
      [{ role: "user", content: "Say OK" }],
      { temperature: 0, maxTokens: 16, timeoutMs: 10 },
    );

    assert.equal(response, null);
    assert.equal(capturedSignal?.aborted, true);
    assert.equal(sawAbort, true);
  } finally {
    restoreRunner();
    clearModelsJsonCache();
    clearSecretCache();
  }
});

test("fallback llm can call Ollama native chat and suppress thinking", { concurrency: false }, async () => {
  clearModelsJsonCache();
  clearSecretCache();

  const llm = new FallbackLlmClient({
    agents: {
      defaults: {
        model: {
          primary: "ollama-internal/gemma4:31b-cloud",
        },
      },
    },
    models: {
      providers: {
        "ollama-internal": {
          baseUrl: "https://ollama.example/api",
          api: "ollama-chat",
          apiKey: "ollama-key",
          disableThinking: true,
          models: [],
        },
      },
    },
  });

  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedAuth = "";
  let capturedBody = "";
  globalThis.fetch = (async (url, init) => {
    capturedUrl = String(url);
    capturedAuth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
    capturedBody = String(init?.body ?? "");
    return new Response(
      JSON.stringify({
        message: { content: "ok from ollama" },
        prompt_eval_count: 7,
        eval_count: 3,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const response = await llm.chatCompletion(
      [{ role: "user", content: "Say OK" }],
      { temperature: 0, maxTokens: 16 },
    );

    assert.equal(response?.content, "ok from ollama");
    assert.equal(response?.usage?.totalTokens, 10);
    assert.equal(capturedUrl, "https://ollama.example/api/chat");
    assert.equal(capturedAuth, "Bearer ollama-key");
    const parsedBody = JSON.parse(capturedBody) as {
      model?: string;
      think?: boolean;
      options?: { num_predict?: number };
    };
    assert.equal(parsedBody.model, "gemma4:31b-cloud");
    assert.equal(parsedBody.think, false);
    assert.equal(parsedBody.options?.num_predict, 16);
  } finally {
    globalThis.fetch = originalFetch;
    clearModelsJsonCache();
    clearSecretCache();
  }
});

test("fallback llm has built-in anthropic defaults when the gateway provider catalog is unavailable", { concurrency: false }, async () => {
  clearModelsJsonCache();
  clearSecretCache();
  disableGatewaySecretResolverForTest();

  const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "anthropic-test-key";

  const llm = new FallbackLlmClient({
    agents: {
      defaults: {
        model: {
          primary: "anthropic/claude-sonnet-4-6",
        },
      },
    },
    models: {
      providers: {},
    },
  });

  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedAuth = "";
  globalThis.fetch = (async (url, init) => {
    capturedUrl = String(url);
    capturedAuth = String((init?.headers as Record<string, string> | undefined)?.["x-api-key"] ?? "");
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: "ok from anthropic default" }],
        usage: { input_tokens: 2, output_tokens: 3 },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const response = await llm.chatCompletion(
      [{ role: "user", content: "Say OK" }],
      { temperature: 0, maxTokens: 16 },
    );

    assert.equal(response?.content, "ok from anthropic default");
    assert.equal(capturedUrl, "https://api.anthropic.com/v1/messages");
    assert.equal(capturedAuth, "anthropic-test-key");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousAnthropicKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
    }
    clearModelsJsonCache();
    clearSecretCache();
  }
});

test("fallback llm prefers configured alias providers before built-in defaults", { concurrency: false }, async () => {
  __setModelsJsonForTest({
    "claude-cli": {
      baseUrl: "https://materialized-claude-cli.example/v1",
      api: "anthropic-messages",
      apiKey: "materialized-claude-cli-key",
      models: [],
    },
  });
  clearSecretCache();
  disableGatewaySecretResolverForTest();

  const llm = new FallbackLlmClient({
    agents: {
      defaults: {
        model: {
          primary: "claude-cli/claude-sonnet-4-6",
        },
      },
    },
    models: {
      providers: {
        anthropic: {
          baseUrl: "https://configured-anthropic.example/custom",
          api: "anthropic-messages",
          apiKey: "configured-anthropic-key",
          models: [],
        },
      },
    },
  });

  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedAuth = "";
  globalThis.fetch = (async (url, init) => {
    capturedUrl = String(url);
    capturedAuth = String((init?.headers as Record<string, string> | undefined)?.["x-api-key"] ?? "");
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: "ok from configured alias" }],
        usage: { input_tokens: 2, output_tokens: 3 },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const response = await llm.chatCompletion(
      [{ role: "user", content: "Say OK" }],
      { temperature: 0, maxTokens: 16 },
    );

    assert.equal(response?.content, "ok from configured alias");
    assert.equal(capturedUrl, "https://configured-anthropic.example/custom/v1/messages");
    assert.equal(capturedAuth, "configured-anthropic-key");
  } finally {
    globalThis.fetch = originalFetch;
    clearModelsJsonCache();
    clearSecretCache();
  }
});

test("fallback llm resolves claude-cli refs through the anthropic built-in fallback", { concurrency: false }, async () => {
  __setModelsJsonForTest({
    "claude-cli": {
      baseUrl: "https://materialized-claude-cli.example/v1",
      api: "anthropic-messages",
      apiKey: "secretref-managed",
      models: [],
    },
  });
  clearSecretCache();
  disableGatewaySecretResolverForTest();

  const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "anthropic-test-key";

  const llm = new FallbackLlmClient({
    agents: {
      defaults: {
        model: {
          primary: "claude-cli/claude-sonnet-4-6",
        },
      },
    },
    models: {
      providers: {},
    },
  });

  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedAuth = "";
  globalThis.fetch = (async (url, init) => {
    capturedUrl = String(url);
    capturedAuth = String((init?.headers as Record<string, string> | undefined)?.["x-api-key"] ?? "");
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: "ok from anthropic alias default" }],
        usage: { input_tokens: 2, output_tokens: 3 },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const response = await llm.chatCompletion(
      [{ role: "user", content: "Say OK" }],
      { temperature: 0, maxTokens: 16 },
    );

    assert.equal(response?.content, "ok from anthropic alias default");
    assert.equal(response?.modelUsed, "claude-cli/claude-sonnet-4-6");
    assert.equal(capturedUrl, "https://api.anthropic.com/v1/messages");
    assert.equal(capturedAuth, "anthropic-test-key");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousAnthropicKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
    }
    clearModelsJsonCache();
    clearSecretCache();
  }
});

test("fallback llm uses the Responses API for openai-responses transports", { concurrency: false }, async () => {
  clearModelsJsonCache();
  clearSecretCache();

  const llm = new FallbackLlmClient({
    agents: {
      defaults: {
        model: {
          primary: "responses-provider/demo-model",
        },
      },
    },
    models: {
      providers: {
        "responses-provider": {
          baseUrl: "https://responses.example/v1",
          api: "openai-responses",
          apiKey: "responses-key",
          models: [],
        },
      },
    },
  });

  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedBody = "";
  globalThis.fetch = (async (url, init) => {
    capturedUrl = String(url);
    capturedBody = String(init?.body ?? "");
    return new Response(
      JSON.stringify({
        output_text: "ok from responses",
        usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const response = await llm.chatCompletion(
      [
        { role: "system", content: "Reply with OK only." },
        { role: "user", content: "Say OK" },
        { role: "assistant", content: "Previous answer" },
      ],
      { temperature: 0, maxTokens: 16 },
    );

    assert.equal(response?.content, "ok from responses");
    assert.equal(response?.usage?.inputTokens, 2);
    assert.equal(response?.usage?.outputTokens, 3);
    assert.equal(response?.usage?.totalTokens, 5);
    assert.equal(capturedUrl, "https://responses.example/v1/responses");

    const parsedBody = JSON.parse(capturedBody) as {
      instructions?: string;
      input?: Array<{ role: string; content: Array<{ type: string; text: string }> }>;
      max_output_tokens?: number;
    };
    assert.equal(parsedBody.instructions, "Reply with OK only.");
    assert.equal(parsedBody.max_output_tokens, 16);
    assert.deepEqual(parsedBody.input, [
      {
        role: "user",
        content: [{ type: "input_text", text: "Say OK" }],
      },
      {
        role: "assistant",
        content: [{ type: "output_text", text: "Previous answer" }],
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    clearModelsJsonCache();
    clearSecretCache();
  }
});

test("fallback llm ignores echoed input_text blocks in responses output extraction", { concurrency: false }, async () => {
  clearModelsJsonCache();
  clearSecretCache();

  const llm = new FallbackLlmClient({
    agents: {
      defaults: {
        model: {
          primary: "responses-provider/demo-model",
        },
      },
    },
    models: {
      providers: {
        "responses-provider": {
          baseUrl: "https://responses.example/v1",
          api: "openai-responses",
          apiKey: "responses-key",
          models: [],
        },
      },
    },
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        output: [
          {
            type: "message",
            content: [
              { type: "input_text", text: "repeat the prompt" },
              { type: "output_text", text: "real answer" },
            ],
          },
        ],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    )) as typeof fetch;

  try {
    const response = await llm.chatCompletion(
      [{ role: "user", content: "Say OK" }],
      { temperature: 0, maxTokens: 16 },
    );

    assert.equal(response?.content, "real answer");
  } finally {
    globalThis.fetch = originalFetch;
    clearModelsJsonCache();
    clearSecretCache();
  }
});

test("fallback llm normalizes anthropic-compatible base URLs that omit /v1", { concurrency: false }, async () => {
  clearModelsJsonCache();
  clearSecretCache();

  const llm = new FallbackLlmClient({
    agents: {
      defaults: {
        model: {
          primary: "anthropic-provider/demo-model",
        },
      },
    },
    models: {
      providers: {
        "anthropic-provider": {
          baseUrl: "https://anthropic.example/api",
          api: "anthropic-messages",
          apiKey: "anthropic-key",
          models: [],
        },
      },
    },
  });

  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  globalThis.fetch = (async (url) => {
    capturedUrl = String(url);
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: "ok from anthropic" }],
        usage: { input_tokens: 2, output_tokens: 3 },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const response = await llm.chatCompletion(
      [{ role: "user", content: "Say OK" }],
      { temperature: 0, maxTokens: 16 },
    );

    assert.equal(response?.content, "ok from anthropic");
    assert.equal(capturedUrl, "https://anthropic.example/api/v1/messages");
  } finally {
    globalThis.fetch = originalFetch;
    clearModelsJsonCache();
    clearSecretCache();
  }
});

function disableGatewaySecretResolverForTest(): void {
  __setGatewayResolverForTest(async () => null);
}
