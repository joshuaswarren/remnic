import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { FallbackLlmClient } from "@remnic/core/fallback-llm";
import { clearModelsJsonCache, __setModelsJsonForTest } from "@remnic/core/models-json";
import type { GatewayConfig, ModelProviderConfig } from "@remnic/core/types";

/**
 * Helper: create a gateway config with explicit providers and a model chain.
 */
function makeConfig(
  providers: GatewayConfig["models"],
  primary: string,
  fallbacks: string[] = [],
): GatewayConfig {
  return {
    models: providers,
    agents: {
      defaults: {
        model: { primary, fallbacks },
      },
    },
  };
}

/**
 * Helper: inject test providers into the models.json cache.
 */
function setModelsJson(providers: Record<string, ModelProviderConfig>): void {
  clearModelsJsonCache();
  __setModelsJsonForTest(providers);
}

// Reset the models.json cache before each test.
beforeEach(() => {
  clearModelsJsonCache();
});

test("FallbackLlmClient resolves built-in openai-codex provider from models.json", () => {
  setModelsJson({
    "openai-codex": {
      baseUrl: "https://chatgpt.com/backend-api",
      api: "openai-codex-responses",
      models: [],
    },
  });

  const config = makeConfig({ providers: {} }, "openai-codex/gpt-5.4");
  const client = new FallbackLlmClient(config);
  assert.ok(client.isAvailable(), "client should report available for built-in provider");
});

test("FallbackLlmClient resolves anthropic provider from models.json with correct API format", () => {
  setModelsJson({
    anthropic: {
      baseUrl: "https://api.anthropic.com",
      api: "anthropic-messages",
      apiKey: "secretref-managed",
      models: [],
    },
  });

  const config = makeConfig({ providers: {} }, "anthropic/claude-opus-4-6");
  const client = new FallbackLlmClient(config);
  const chain = (client as any).getModelChain();
  assert.equal(chain.length, 1);
  assert.equal(chain[0].providerConfig.api, "anthropic-messages");
  assert.equal(chain[0].providerConfig.baseUrl, "https://api.anthropic.com");
});

test("FallbackLlmClient returns unavailable when provider not in config or models.json", () => {
  setModelsJson({});

  const config = makeConfig({ providers: {} }, "nonexistent-provider/some-model");
  const client = new FallbackLlmClient(config);
  assert.equal(client.isAvailable(), false);
});

test("FallbackLlmClient prefers explicit provider config over models.json", () => {
  setModelsJson({
    "openai-codex": {
      baseUrl: "https://chatgpt.com/backend-api",
      api: "openai-codex-responses",
      models: [],
    },
  });

  const config = makeConfig(
    {
      providers: {
        "openai-codex": {
          baseUrl: "https://custom.endpoint.example.com/v1",
          apiKey: "sk-test-key",
          api: "openai-completions",
          models: [],
        },
      },
    },
    "openai-codex/gpt-5.4",
  );

  const client = new FallbackLlmClient(config);
  const chain = (client as any).getModelChain();
  assert.equal(chain.length, 1);
  assert.equal(chain[0].providerConfig.baseUrl, "https://custom.endpoint.example.com/v1");
  assert.equal(chain[0].providerConfig.apiKey, "sk-test-key");
});

test("FallbackLlmClient builds mixed chain with explicit and models.json providers", () => {
  setModelsJson({
    "openai-codex": {
      baseUrl: "https://chatgpt.com/backend-api",
      api: "openai-codex-responses",
      models: [],
    },
    anthropic: {
      baseUrl: "https://api.anthropic.com",
      api: "anthropic-messages",
      apiKey: "secretref-managed",
      models: [],
    },
  });

  const config = makeConfig(
    {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-real",
          api: "openai-completions",
          models: [],
        },
      },
    },
    "openai/gpt-5.5",
    ["openai-codex/gpt-5.4", "anthropic/claude-opus-4-6"],
  );

  const client = new FallbackLlmClient(config);
  const chain = (client as any).getModelChain();
  assert.equal(chain.length, 3);

  // First: explicit provider
  assert.equal(chain[0].providerId, "openai");
  assert.equal(chain[0].providerConfig.apiKey, "sk-real");

  // Second: from models.json (openai-codex)
  assert.equal(chain[1].providerId, "openai-codex");
  assert.equal(chain[1].providerConfig.api, "openai-codex-responses");
  assert.equal(chain[1].providerConfig.baseUrl, "https://chatgpt.com/backend-api");

  // Third: from models.json (anthropic)
  assert.equal(chain[2].providerId, "anthropic");
  assert.equal(chain[2].providerConfig.api, "anthropic-messages");
});

test("FallbackLlmClient resolves google provider from models.json", () => {
  setModelsJson({
    google: {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      api: "google-generative-ai",
      apiKey: "secretref-managed",
      models: [],
    },
  });

  const config = makeConfig({ providers: {} }, "google/gemini-pro");
  const client = new FallbackLlmClient(config);
  const chain = (client as any).getModelChain();
  assert.equal(chain.length, 1);
  assert.equal(chain[0].providerConfig.api, "google-generative-ai");
});

test("FallbackLlmClient resolves models.json provider when config has no providers key", () => {
  setModelsJson({
    "openai-codex": {
      baseUrl: "https://chatgpt.com/backend-api",
      api: "openai-codex-responses",
      models: [],
    },
  });

  // Config with no providers property at all (models key is missing)
  const config: GatewayConfig = {
    agents: {
      defaults: {
        model: { primary: "openai-codex/gpt-5.4" },
      },
    },
  };
  const client = new FallbackLlmClient(config);
  assert.ok(client.isAvailable(), "client should be available via models.json even without explicit providers");
  const chain = (client as any).getModelChain();
  assert.equal(chain.length, 1);
  assert.equal(chain[0].providerConfig.api, "openai-codex-responses");
});

test("FallbackLlmClient chatCompletion attempts built-in provider and invokes tryModel", async () => {
  setModelsJson({
    "openai-codex": {
      baseUrl: "https://chatgpt.com/backend-api",
      api: "openai-codex-responses",
      models: [],
    },
  });

  const config = makeConfig({ providers: {} }, "openai-codex/gpt-5.4");
  const client = new FallbackLlmClient(config);

  // Stub tryModel to verify it's called with the correct model ref
  // (without actually making HTTP calls)
  const triedModelBox: { value: { providerId: string; modelId: string; api?: string } | null } = { value: null };
  (client as any).tryModel = async (model: any) => {
    triedModelBox.value = {
      providerId: model.providerId,
      modelId: model.modelId,
      api: model.providerConfig.api,
    };
    return { content: '{"test": true}', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
  };

  const result = await client.chatCompletion([
    { role: "user", content: "test" },
  ]);

  assert.ok(result, "chatCompletion should return a result");
  assert.equal(result.modelUsed, "openai-codex/gpt-5.4");
  const triedModel = triedModelBox.value;
  assert.ok(triedModel, "tryModel should have been called");
  assert.equal(triedModel!.providerId, "openai-codex");
  assert.equal(triedModel!.modelId, "gpt-5.4");
  assert.equal(triedModel!.api, "openai-codex-responses");
});
