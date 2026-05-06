import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildBenchBaselineRemnicConfig } from "./adapters/remnic-adapter.ts";
import {
  deriveOpenclawRuntimeContext,
  resolveBenchRuntimeProfile,
} from "./runtime-profiles.ts";

test("baseline runtime profile keeps the stripped retrieval-only config", async () => {
  const resolved = await resolveBenchRuntimeProfile({
    runtimeProfile: "baseline",
  });

  assert.equal(resolved.profile, "baseline");
  assert.deepEqual(resolved.remnicConfig, buildBenchBaselineRemnicConfig());
  assert.deepEqual(resolved.effectiveRemnicConfig, buildBenchBaselineRemnicConfig());
  assert.equal(resolved.remnicConfig.qmdEnabled, false);
  assert.equal(resolved.remnicConfig.queryExpansionEnabled, false);
  assert.equal(resolved.remnicConfig.rerankEnabled, false);
  assert.equal(resolved.remnicConfig.verifiedRecallEnabled, false);
  assert.equal(resolved.remnicConfig.knowledgeIndexEnabled, false);
});

test("real runtime profile preserves the configured Remnic retrieval settings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-runtime-"));
  const configPath = path.join(root, "remnic.config.json");

  await writeFile(
    configPath,
    JSON.stringify({
      remnic: {
        qmdEnabled: true,
        queryExpansionEnabled: true,
        rerankEnabled: true,
      verifiedRecallEnabled: true,
      openaiApiKey: "super-secret",
      secretKey: "secondary-secret",
      refreshToken: "oauth-refresh-token",
      apikey: "compact-secret",
      authtoken: "compact-token",
      clientsecret: "compact-client-secret",
      oauthToken: "oauth-token",
      sessionTokenCount: 3,
    },
  }),
  );

  const resolved = await resolveBenchRuntimeProfile({
    runtimeProfile: "real",
    remnicConfigPath: configPath,
  });

  assert.equal(resolved.profile, "real");
  assert.equal(resolved.remnicConfig.qmdEnabled, true);
  assert.equal(resolved.remnicConfig.queryExpansionEnabled, true);
  assert.equal(resolved.remnicConfig.rerankEnabled, true);
  assert.equal(resolved.remnicConfig.verifiedRecallEnabled, true);
  assert.equal(resolved.remnicConfig.openaiApiKey, "[redacted]");
  assert.equal(resolved.remnicConfig.secretKey, "[redacted]");
  assert.equal(resolved.remnicConfig.refreshToken, "[redacted]");
  assert.equal(resolved.remnicConfig.apikey, "[redacted]");
  assert.equal(resolved.remnicConfig.authtoken, "[redacted]");
  assert.equal(resolved.remnicConfig.clientsecret, "[redacted]");
  assert.equal(resolved.remnicConfig.oauthToken, "[redacted]");
  assert.equal(resolved.remnicConfig.sessionTokenCount, 3);
  assert.equal(resolved.effectiveRemnicConfig.openaiApiKey, "super-secret");
  assert.equal(resolved.effectiveRemnicConfig.secretKey, "secondary-secret");
  assert.equal(resolved.effectiveRemnicConfig.refreshToken, "oauth-refresh-token");
  assert.equal(resolved.effectiveRemnicConfig.apikey, "compact-secret");
  assert.equal(resolved.effectiveRemnicConfig.authtoken, "compact-token");
  assert.equal(resolved.effectiveRemnicConfig.clientsecret, "compact-client-secret");
  assert.equal(resolved.effectiveRemnicConfig.oauthToken, "oauth-token");
  assert.equal(resolved.effectiveRemnicConfig.sessionTokenCount, 3);
  assert.equal(
    (resolved.adapterOptions.configOverrides as { openaiApiKey?: string }).openaiApiKey,
    "super-secret",
  );
  assert.equal(resolved.adapterOptions.preserveRuntimeDefaults, true);
  assert.equal(resolved.systemProvider, null);
  assert.equal(resolved.judgeProvider, null);
});

test("openclaw-chain runtime profile loads OpenClaw config and forces gateway routing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-openclaw-"));
  const configPath = path.join(root, "openclaw.json");

  await writeFile(
    configPath,
    JSON.stringify({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4-mini",
          },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "test-key",
          },
        },
      },
      plugins: {
        slots: {
          memory: "openclaw-remnic",
        },
        entries: {
          "openclaw-remnic": {
            config: {
              qmdEnabled: true,
              queryExpansionEnabled: true,
            },
          },
        },
      },
    }),
  );

  const resolved = await resolveBenchRuntimeProfile({
    runtimeProfile: "openclaw-chain",
    openclawConfigPath: configPath,
    gatewayAgentId: "memory-primary",
    fastGatewayAgentId: "memory-fast",
  });

  assert.equal(resolved.profile, "openclaw-chain");
  assert.equal(resolved.remnicConfig.qmdEnabled, true);
  assert.equal(resolved.remnicConfig.queryExpansionEnabled, true);
  assert.equal(resolved.remnicConfig.modelSource, "gateway");
  assert.equal(resolved.remnicConfig.gatewayAgentId, "memory-primary");
  assert.equal(resolved.remnicConfig.fastGatewayAgentId, "memory-fast");
  assert.deepEqual(
    (resolved.remnicConfig.gatewayConfig as { agents?: { defaults?: { model?: { primary?: string } } } }).agents?.defaults?.model,
    {
      primary: "openai/gpt-5.4-mini",
    },
  );
  assert.equal(
    (resolved.remnicConfig.gatewayConfig as {
      models?: { providers?: { openai?: { apiKey?: string } } };
    }).models?.providers?.openai?.apiKey,
    "[redacted]",
  );
  assert.equal(
    (resolved.effectiveRemnicConfig.gatewayConfig as {
      models?: { providers?: { openai?: { apiKey?: string } } };
    }).models?.providers?.openai?.apiKey,
    "test-key",
  );
  assert.equal(resolved.adapterOptions.preserveRuntimeDefaults, true);
});

test("deriveOpenclawRuntimeContext keeps gateway auth scoped to the selected config root", () => {
  const runtimeContext = deriveOpenclawRuntimeContext(
    "/tmp/custom-openclaw-profile/openclaw.json",
  );

  assert.deepEqual(runtimeContext, {
    agentDir: "/tmp/custom-openclaw-profile/agents/main/agent",
    workspaceDir: "/tmp/custom-openclaw-profile/workspace",
  });
});

test("openclaw-chain ignores direct system-provider overrides and keeps gateway routing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-openclaw-override-"));
  const configPath = path.join(root, "openclaw.json");

  await writeFile(
    configPath,
    JSON.stringify({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4-mini",
          },
        },
      },
      plugins: {
        slots: {
          memory: "openclaw-remnic",
        },
        entries: {
          "openclaw-remnic": {
            config: {
              qmdEnabled: true,
            },
          },
        },
      },
    }),
  );

  const resolved = await resolveBenchRuntimeProfile({
    runtimeProfile: "openclaw-chain",
    openclawConfigPath: configPath,
    systemProvider: "openai",
    systemModel: "gpt-5.4",
  });

  assert.equal(resolved.profile, "openclaw-chain");
  assert.equal(resolved.remnicConfig.modelSource, "gateway");
  assert.equal(resolved.systemProvider, null);
});

test("openclaw-chain does not instantiate a direct provider-backed responder", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-openclaw-lazy-"));
  const configPath = path.join(root, "openclaw.json");

  await writeFile(
    configPath,
    JSON.stringify({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4-mini",
          },
        },
      },
      plugins: {
        slots: {
          memory: "openclaw-remnic",
        },
        entries: {
          "openclaw-remnic": {
            config: {
              qmdEnabled: true,
            },
          },
        },
      },
    }),
  );

  const resolved = await resolveBenchRuntimeProfile({
    runtimeProfile: "openclaw-chain",
    openclawConfigPath: configPath,
    systemProvider: "unsupported-provider" as never,
    systemModel: "ignored-model",
  });

  assert.equal(resolved.profile, "openclaw-chain");
  assert.equal(resolved.systemProvider, null);
  assert.equal(resolved.remnicConfig.modelSource, "gateway");
});

test("openclaw-chain ignores incomplete direct system-provider config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-openclaw-ignore-system-"));
  const configPath = path.join(root, "openclaw.json");

  await writeFile(
    configPath,
    JSON.stringify({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4-mini",
          },
        },
      },
      plugins: {
        slots: {
          memory: "openclaw-remnic",
        },
        entries: {
          "openclaw-remnic": {
            config: {
              qmdEnabled: true,
            },
          },
        },
      },
    }),
  );

  const resolved = await resolveBenchRuntimeProfile({
    runtimeProfile: "openclaw-chain",
    openclawConfigPath: configPath,
    systemProvider: "openai",
  });

  assert.equal(resolved.profile, "openclaw-chain");
  assert.equal(resolved.systemProvider, null);
  assert.equal(resolved.remnicConfig.modelSource, "gateway");
});

test("provider-backed runtime resolution rejects incomplete provider configuration", async () => {
  await assert.rejects(
    () =>
      resolveBenchRuntimeProfile({
        runtimeProfile: "real",
        systemProvider: "openai",
      }),
    /system provider requires both provider and model/i,
  );

  await assert.rejects(
    () =>
      resolveBenchRuntimeProfile({
        runtimeProfile: "real",
        judgeModel: "gpt-5.4-mini",
      }),
    /judge provider requires both provider and model/i,
  );
});

test("provider-backed runtime resolution configures codex-cli with xhigh reasoning", async () => {
  const resolved = await resolveBenchRuntimeProfile({
    runtimeProfile: "baseline",
    systemProvider: "codex-cli",
    systemModel: "gpt-5.5",
    judgeProvider: "codex-cli",
    judgeModel: "gpt-5.5",
  });

  assert.deepEqual(resolved.systemProvider, {
    provider: "codex-cli",
    model: "gpt-5.5",
    reasoningEffort: "xhigh",
  });
  assert.deepEqual(resolved.judgeProvider, {
    provider: "codex-cli",
    model: "gpt-5.5",
    reasoningEffort: "xhigh",
  });
  assert.equal(typeof resolved.adapterOptions.responder?.respond, "function");
  assert.equal(typeof resolved.adapterOptions.judge?.score, "function");
});

test("provider-backed runtime resolution can override codex-cli reasoning effort", async () => {
  const resolved = await resolveBenchRuntimeProfile({
    runtimeProfile: "baseline",
    systemProvider: "codex-cli",
    systemModel: "gpt-5.5",
    systemCodexReasoningEffort: "high",
    judgeProvider: "codex-cli",
    judgeModel: "gpt-5.5",
    judgeCodexReasoningEffort: "medium",
  });

  assert.equal(resolved.systemProvider?.reasoningEffort, "high");
  assert.equal(resolved.judgeProvider?.reasoningEffort, "medium");
});

test("runtime profile can route Remnic internal LLM calls through codex-cli", async () => {
  const resolved = await resolveBenchRuntimeProfile({
    runtimeProfile: "baseline",
    internalProvider: "codex-cli",
    internalModel: "gpt-5.5",
    internalCodexReasoningEffort: "xhigh",
  });

  assert.deepEqual(resolved.internalProvider, {
    provider: "codex-cli",
    model: "gpt-5.5",
    baseUrl: "codex-cli://local",
    reasoningEffort: "xhigh",
  });
  assert.equal(resolved.remnicConfig.modelSource, "gateway");
  assert.equal(resolved.effectiveRemnicConfig.modelSource, "gateway");
  assert.equal(resolved.remnicConfig.gatewayAgentId, "remnic-bench-internal");
  const gatewayConfig = resolved.effectiveRemnicConfig.gatewayConfig as {
    agents?: { defaults?: { model?: { primary?: string } } };
    models?: { providers?: Record<string, { api?: string; codexCliReasoningEffort?: string }> };
  };
  assert.equal(
    gatewayConfig.agents?.defaults?.model?.primary,
    "remnic-bench-internal/gpt-5.5",
  );
  assert.equal(
    gatewayConfig.models?.providers?.["remnic-bench-internal"]?.api,
    "codex-cli",
  );
  assert.equal(
    gatewayConfig.models?.providers?.["remnic-bench-internal"]?.codexCliReasoningEffort,
    "xhigh",
  );
});

test("runtime profile can route Remnic internal LLM calls through Ollama native chat", async () => {
  const resolved = await resolveBenchRuntimeProfile({
    runtimeProfile: "baseline",
    internalProvider: "ollama",
    internalModel: "gemma4:31b-cloud",
    internalBaseUrl: "https://ollama.example/api",
    internalApiKey: "secret-ollama-key",
    internalDisableThinking: true,
  });

  assert.deepEqual(resolved.internalProvider, {
    provider: "ollama",
    model: "gemma4:31b-cloud",
    baseUrl: "https://ollama.example/api",
    apiKey: "[redacted]",
    disableThinking: true,
  });
  const persistedGateway = resolved.remnicConfig.gatewayConfig as {
    models?: { providers?: Record<string, { apiKey?: string; api?: string; disableThinking?: boolean }> };
  };
  assert.equal(
    persistedGateway.models?.providers?.["remnic-bench-internal"]?.apiKey,
    "[redacted]",
  );
  const effectiveGateway = resolved.effectiveRemnicConfig.gatewayConfig as {
    models?: { providers?: Record<string, { apiKey?: string; api?: string; disableThinking?: boolean }> };
  };
  assert.equal(
    effectiveGateway.models?.providers?.["remnic-bench-internal"]?.api,
    "ollama-chat",
  );
  assert.equal(
    effectiveGateway.models?.providers?.["remnic-bench-internal"]?.apiKey,
    "secret-ollama-key",
  );
  assert.equal(
    effectiveGateway.models?.providers?.["remnic-bench-internal"]?.disableThinking,
    true,
  );
});

test("runtime profile routes OpenAI internal LLM calls through Responses API", async () => {
  const resolved = await resolveBenchRuntimeProfile({
    runtimeProfile: "baseline",
    internalProvider: "openai",
    internalModel: "gpt-5.5",
    internalApiKey: "secret-openai-key",
  });

  assert.deepEqual(resolved.internalProvider, {
    provider: "openai",
    model: "gpt-5.5",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "[redacted]",
  });
  const persistedGateway = resolved.remnicConfig.gatewayConfig as {
    models?: { providers?: Record<string, { apiKey?: string; api?: string }> };
  };
  assert.equal(
    persistedGateway.models?.providers?.["remnic-bench-internal"]?.apiKey,
    "[redacted]",
  );
  const effectiveGateway = resolved.effectiveRemnicConfig.gatewayConfig as {
    models?: { providers?: Record<string, { apiKey?: string; api?: string }> };
  };
  assert.equal(
    effectiveGateway.models?.providers?.["remnic-bench-internal"]?.api,
    "openai-responses",
  );
  assert.equal(
    effectiveGateway.models?.providers?.["remnic-bench-internal"]?.apiKey,
    "secret-openai-key",
  );
});
