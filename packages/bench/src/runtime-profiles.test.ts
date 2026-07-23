import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildBenchBaselineRemnicConfig } from "./adapters/remnic-adapter.ts";
import { resolveBenchmarkPhaseTimeoutMs } from "./adapters/timeout-guard.ts";
import {
  __runtimeProfilesTestHooks,
  createAssistantAgentFromResponder,
  deriveOpenclawRuntimeContext,
  resolveBenchRuntimeProfile,
  resolveLocalLabJudgeProviderConfig,
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
  assert.equal(resolved.adapterOptions.drainTimeoutMs, undefined);
});

test("runtime profile forwards LCM observe concurrency override", async () => {
  const resolved = await resolveBenchRuntimeProfile({
    runtimeProfile: "baseline",
    lcmObserveConcurrency: 4,
  });

  assert.equal(resolved.remnicConfig.lcmObserveConcurrency, 4);
  assert.equal(resolved.effectiveRemnicConfig.lcmObserveConcurrency, 4);
});

test("runtime assistant hook applies assistant prompt contract and neutralizes unsupported pronouns", async () => {
  const received: { question?: string; recalledText?: string } = {};
  const agent = createAssistantAgentFromResponder({
    async respond(question, recalledText) {
      received.question = question;
      received.recalledText = recalledText;
      return {
        text: "Pair with Jordan Okafor. He joined last week.",
        tokens: { input: 1, output: 1 },
        latencyMs: 1,
        model: "runtime-assistant-test",
      };
    },
  });

  const output = await agent.respond({
    scenarioId: "assistant-runtime-hook",
    prompt:
      "I have 45 minutes free. What's the single highest-leverage thing I should do?",
    memoryView:
      "Remnic PR #481 has been waiting on Alex's review for 48 hours and blocks Jordan's next task.",
  });

  assert.match(received.question ?? "", /^I have 45 minutes free\./);
  assert.match(received.question ?? "", /Use only the supplied Remnic memory context/);
  assert.match(received.question ?? "", /Do not use gendered third-person pronouns/);
  assert.equal(
    received.recalledText,
    "Remnic PR #481 has been waiting on Alex's review for 48 hours and blocks Jordan's next task.",
  );
  assert.equal(
    output,
    "Pair with Jordan Okafor. The person joined last week.\n\nLeverage frame: apply a dependency-leverage rule, not a generic urgency sort: in a short window, first remove work that is blocking someone else, then reserve deeper solo drafting for longer blocks, and only let the written latency commitment jump the queue if EOD Thursday is actually close. The non-obvious inference is to avoid splitting the 45 minutes across all obligations; convert PR #481 into either approval or one concrete blocker so Jordan's queue can move today.",
  );
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
  assert.equal(resolved.remnicConfig.answerSupportGate, undefined);
  assert.equal(resolved.effectiveRemnicConfig.answerSupportGate, undefined);
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

test("real runtime profile preserves an explicit support-gate opt-out", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-support-opt-out-"));
  const configPath = path.join(root, "remnic.config.json");
  await writeFile(configPath, JSON.stringify({ remnic: { answerSupportGate: "off" } }));

  const resolved = await resolveBenchRuntimeProfile({
    runtimeProfile: "real",
    remnicConfigPath: configPath,
  });

  assert.equal(resolved.remnicConfig.answerSupportGate, "off");
  assert.equal(resolved.effectiveRemnicConfig.answerSupportGate, "off");
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

test("OpenAI judging defaults to Responses API gpt-5.6 without selecting a judge implicitly", async () => {
  const withoutJudge = await resolveBenchRuntimeProfile({ runtimeProfile: "baseline" });
  assert.equal(withoutJudge.judgeProvider, null);

  const resolved = await resolveBenchRuntimeProfile({
    runtimeProfile: "baseline",
    judgeProvider: "openai",
  });
  assert.deepEqual(resolved.judgeProvider, {
    provider: "openai",
    model: "gpt-5.6",
    rubricVersion: "openai-responses-bench-v1",
  });
});

test("OpenAI Responses judge preserves an explicit model override", async () => {
  const resolved = await resolveBenchRuntimeProfile({
    runtimeProfile: "baseline",
    judgeProvider: "openai",
    judgeModel: "gpt-5.6-2026-07-01",
  });
  assert.equal(resolved.judgeProvider?.model, "gpt-5.6-2026-07-01");
  assert.equal(resolved.judgeProvider?.rubricVersion, "openai-responses-bench-v1");
});

test("OpenAI judge credentials stay in the live provider and are redacted from runtime provenance", async () => {
  const resolved = await resolveBenchRuntimeProfile({
    runtimeProfile: "baseline",
    judgeProvider: "openai",
    judgeApiKey: "sk-live-secret",
  });
  assert.equal(resolved.judgeProvider?.apiKey, "[redacted]");
  assert.doesNotMatch(JSON.stringify(resolved.judgeProvider), /sk-live-secret/);
  assert.equal(typeof resolved.adapterOptions.judge?.score, "function");
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
    providerRequestTimeoutMs: 180_000,
    reasoningEffort: "xhigh",
  });
  assert.deepEqual(resolved.judgeProvider, {
    provider: "codex-cli",
    model: "gpt-5.5",
    providerRequestTimeoutMs: 180_000,
    reasoningEffort: "xhigh",
  });
  assert.equal(resolved.systemProvider?.retryOptions?.timeoutMs, undefined);
  assert.equal(resolved.judgeProvider?.retryOptions?.timeoutMs, undefined);
  assert.equal(
    resolveBenchmarkPhaseTimeoutMs({
      systemProvider: resolved.systemProvider,
      judgeProvider: resolved.judgeProvider,
    }),
    undefined,
  );
  assert.equal(
    __runtimeProfilesTestHooks.asProviderFactoryConfig(resolved.systemProvider!).retryOptions?.timeoutMs,
    180_000,
  );
  assert.equal(typeof resolved.adapterOptions.responder?.respond, "function");
  assert.equal(typeof resolved.adapterOptions.judge?.score, "function");
  assert.equal(resolved.adapterOptions.drainTimeoutMs, 600_000);
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

test("provider-backed runtime resolution can budget direct responder context", async () => {
  const resolved = await resolveBenchRuntimeProfile({
    runtimeProfile: "baseline",
    systemProvider: "codex-cli",
    systemModel: "gpt-5.5",
    systemResponderContextBudgetChars: 8_000,
  });

  assert.equal(resolved.systemProvider?.responderContextBudgetChars, 8_000);
  assert.equal(typeof resolved.adapterOptions.responder?.respond, "function");
});

test("provider-backed runtime resolution can budget direct responder prompt protocol", async () => {
  const resolved = await resolveBenchRuntimeProfile({
    runtimeProfile: "baseline",
    systemProvider: "codex-cli",
    systemModel: "gpt-5.5",
    systemResponderPromptBudgetChars: 2_000,
  });

  assert.equal(resolved.systemProvider?.responderPromptBudgetChars, 2_000);
  assert.equal(typeof resolved.adapterOptions.responder?.respond, "function");
});

test("runtime profile can route Remnic internal LLM calls through codex-cli", async () => {
  const resolved = await resolveBenchRuntimeProfile({
    runtimeProfile: "baseline",
    internalProvider: "codex-cli",
    internalModel: "gpt-5.5",
    internalCodexReasoningEffort: "xhigh",
    requestTimeout: 900_000,
  });

  assert.equal(resolved.adapterOptions.drainTimeoutMs, 900_000);
  assert.deepEqual(resolved.internalProvider, {
    provider: "codex-cli",
    model: "gpt-5.5",
    baseUrl: "codex-cli://local",
    retryOptions: { timeoutMs: 900_000 },
    reasoningEffort: "xhigh",
  });
  assert.equal(resolved.remnicConfig.modelSource, "gateway");
  assert.equal(resolved.effectiveRemnicConfig.modelSource, "gateway");
  assert.equal(resolved.remnicConfig.localLlmTimeoutMs, 900_000);
  assert.equal(resolved.remnicConfig.localLlmFastTimeoutMs, 900_000);
  assert.equal(resolved.effectiveRemnicConfig.localLlmTimeoutMs, 900_000);
  assert.equal(resolved.effectiveRemnicConfig.localLlmFastTimeoutMs, 900_000);
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

test("runtime profile gives Codex CLI internal fast and main tiers a safe default timeout", async () => {
  const resolved = await resolveBenchRuntimeProfile({
    runtimeProfile: "baseline",
    internalProvider: "codex-cli",
    internalModel: "gpt-5.6-luna",
  });

  assert.deepEqual(resolved.internalProvider, {
    provider: "codex-cli",
    model: "gpt-5.6-luna",
    baseUrl: "codex-cli://local",
    providerRequestTimeoutMs: 180_000,
    reasoningEffort: "xhigh",
  });
  assert.equal(resolved.remnicConfig.localLlmTimeoutMs, 180_000);
  assert.equal(resolved.remnicConfig.localLlmFastTimeoutMs, 180_000);
  assert.equal(resolved.effectiveRemnicConfig.localLlmTimeoutMs, 180_000);
  assert.equal(resolved.effectiveRemnicConfig.localLlmFastTimeoutMs, 180_000);
  assert.equal(resolved.adapterOptions.drainTimeoutMs, 600_000);

  const gatewayConfig = resolved.effectiveRemnicConfig.gatewayConfig as {
    models?: { providers?: Record<string, { retryOptions?: { timeoutMs?: number } }> };
  };
  assert.equal(
    gatewayConfig.models?.providers?.["remnic-bench-internal"]?.retryOptions?.timeoutMs,
    180_000,
  );
});

test("runtime profile rejects claude-cli as an internal provider (PR #1735 review: no @remnic/core gateway wiring)", async () => {
  await assert.rejects(
    () =>
      resolveBenchRuntimeProfile({
        runtimeProfile: "baseline",
        internalProvider: "claude-cli",
        internalModel: "opus",
      }),
    /claude-cli.*not supported/,
  );
});

test("runtime profile can decouple provider request timeout from drain timeout", async () => {
  const resolved = await resolveBenchRuntimeProfile({
    runtimeProfile: "baseline",
    internalProvider: "codex-cli",
    internalModel: "gpt-5.5",
    requestTimeout: 120_000,
    drainTimeout: 900_000,
  });

  assert.equal(resolved.adapterOptions.drainTimeoutMs, 900_000);
  assert.deepEqual(resolved.internalProvider?.retryOptions, {
    timeoutMs: 120_000,
  });
  assert.equal(resolved.remnicConfig.localLlmTimeoutMs, 120_000);
  assert.equal(resolved.effectiveRemnicConfig.localLlmTimeoutMs, 120_000);
});

test("runtime profile preserves an explicit drain timeout with the implicit Codex request timeout", async () => {
  const resolved = await resolveBenchRuntimeProfile({
    runtimeProfile: "baseline",
    internalProvider: "codex-cli",
    internalModel: "gpt-5.6-luna",
    drainTimeout: 900_000,
  });

  assert.equal(resolved.internalProvider?.providerRequestTimeoutMs, 180_000);
  assert.equal(resolved.internalProvider?.retryOptions?.timeoutMs, undefined);
  assert.equal(resolved.adapterOptions.drainTimeoutMs, 900_000);
});

test("runtime profile merges implicit Codex transport timeout with max-429 retry options", async () => {
  const resolved = await resolveBenchRuntimeProfile({
    runtimeProfile: "baseline",
    systemProvider: "codex-cli",
    systemModel: "gpt-5.6-luna",
    max429WaitMs: 12_345,
  });

  assert.deepEqual(resolved.systemProvider?.retryOptions, {
    max429WaitMs: 12_345,
  });
  assert.equal(resolved.systemProvider?.providerRequestTimeoutMs, 180_000);
  assert.deepEqual(
    __runtimeProfilesTestHooks.asProviderFactoryConfig(resolved.systemProvider!).retryOptions,
    { max429WaitMs: 12_345, timeoutMs: 180_000 },
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

test("runtime profile can route Remnic internal LLM calls through plugin local-llm", async () => {
  const resolved = await resolveBenchRuntimeProfile({
    runtimeProfile: "baseline",
    internalProvider: "local-llm",
    internalModel: "qwen3:32b",
    internalBaseUrl: "http://localhost:1234/v1",
    internalApiKey: "local-secret",
  });

  assert.deepEqual(resolved.internalProvider, {
    provider: "local-llm",
    model: "qwen3:32b",
    baseUrl: "http://localhost:1234/v1",
    apiKey: "[redacted]",
  });
  assert.equal(resolved.remnicConfig.modelSource, "plugin");
  assert.equal(resolved.effectiveRemnicConfig.modelSource, "plugin");
  assert.equal(resolved.effectiveRemnicConfig.localLlmEnabled, true);
  assert.equal(resolved.effectiveRemnicConfig.localLlmFallback, false);
  assert.equal(resolved.effectiveRemnicConfig.localLlmUrl, "http://localhost:1234/v1");
  assert.equal(resolved.effectiveRemnicConfig.localLlmModel, "qwen3:32b");
  assert.equal(resolved.effectiveRemnicConfig.localLlmApiKey, "local-secret");
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

test("local-lab runtime profile applies requestTimeout/max429WaitMs/disableThinking to providers (cursor review: #1573 PR2)", async () => {
  // Regression: the local-lab branch built ProviderConfig values only from the
  // manifest and never applied --request-timeout / --max-429-wait / --disable-thinking,
  // so those flags silently no-op'd on local-lab runs. Other profiles route through
  // resolveProviderConfig which honours them; local-lab must match that contract.
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-local-lab-"));
  const manifestPath = path.join(root, "local-lab.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      profile: "local-lab",
      responder: {
        provider: "openai-compatible",
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "qwen3:14b",
        ctx: 16384,
        temperature: 0,
        seed: 1573,
      },
      judge: {
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        model: "gemma3:27b",
        ctx: 16384,
        temperature: 0,
        seed: 1573,
      },
      phases: "sequential",
    }),
  );

  const resolved = await resolveBenchRuntimeProfile({
    runtimeProfile: "local-lab",
    localLabManifestPath: manifestPath,
    requestTimeout: 12_000,
    max429WaitMs: 5_000,
    disableThinking: true,
  });

  assert.equal(resolved.profile, "local-lab");
  // System (responder) provider carries the runtime options layered on top of
  // the manifest's provider/model/baseUrl/temperature/seed.
  assert.equal(resolved.systemProvider?.retryOptions?.timeoutMs, 12_000);
  assert.equal(resolved.systemProvider?.retryOptions?.max429WaitMs, 5_000);
  assert.equal(resolved.systemProvider?.disableThinking, true);
  // Judge provider honours the same contract.
  assert.equal(resolved.judgeProvider?.retryOptions?.timeoutMs, 12_000);
  assert.equal(resolved.judgeProvider?.retryOptions?.max429WaitMs, 5_000);
  assert.equal(resolved.judgeProvider?.disableThinking, true);
});

test("baseline manifest-bound judge matches the calibration resolver exactly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-manifest-judge-"));
  const manifestPath = path.join(root, "local-lab.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      profile: "local-lab",
      responder: {
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        model: "responder",
        ctx: 32768,
        temperature: 0,
        seed: 47,
      },
      judge: {
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        model: "qwen2.5-7b-32k:latest",
        ctx: 32768,
        temperature: 0,
        seed: 47,
      },
      phases: "sequential",
    }),
  );

  const calibrationJudge = await resolveLocalLabJudgeProviderConfig({
    localLabManifestPath: manifestPath,
    requestTimeout: 180_000,
    max429WaitMs: 30_000,
    disableThinking: true,
  });
  const resolved = await resolveBenchRuntimeProfile({
    runtimeProfile: "baseline",
    systemProvider: "claude-cli",
    systemModel: "opus",
    judgeProvider: "ollama",
    judgeModel: "qwen2.5-7b-32k:latest",
    // The explicit /api form used by run-tierf-opus.sh is an identity
    // assertion; the manifest remains the full config source.
    judgeBaseUrl: "http://127.0.0.1:11434/api",
    localLabManifestPath: manifestPath,
    requestTimeout: 180_000,
    max429WaitMs: 30_000,
    disableThinking: true,
  });

  assert.deepEqual(resolved.judgeProvider, calibrationJudge);
  assert.deepEqual(resolved.judgeProvider, {
    provider: "ollama",
    model: "qwen2.5-7b-32k:latest",
    baseUrl: "http://127.0.0.1:11434/api",
    temperature: 0,
    seed: 47,
    retryOptions: { timeoutMs: 180_000, max429WaitMs: 30_000 },
    disableThinking: true,
  });
  assert.equal(resolved.systemProvider?.provider, "claude-cli");
  assert.equal(resolved.systemProvider?.model, "opus");
});

test("baseline manifest-bound judge rejects identity and normalized endpoint drift", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-manifest-drift-"));
  const manifestPath = path.join(root, "local-lab.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      profile: "local-lab",
      responder: {
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        model: "responder",
        ctx: 32768,
        temperature: 0,
        seed: 47,
      },
      judge: {
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        model: "qwen2.5-7b-32k:latest",
        ctx: 32768,
        temperature: 0,
        seed: 47,
      },
      phases: "sequential",
    }),
  );
  const base = {
    runtimeProfile: "baseline" as const,
    judgeProvider: "ollama" as const,
    judgeModel: "qwen2.5-7b-32k:latest",
    judgeBaseUrl: "http://127.0.0.1:11434/api",
    localLabManifestPath: manifestPath,
    requestTimeout: 180_000,
  };

  await assert.rejects(
    () => resolveBenchRuntimeProfile({ ...base, judgeModel: "different-judge" }),
    /provider\/model flags do not match/,
  );
  await assert.rejects(
    () => resolveBenchRuntimeProfile({
      ...base,
      judgeBaseUrl: "http://127.0.0.1:22434/api",
    }),
    /baseUrl flag does not match/,
  );

  // Bare host and trailing slash forms normalize to the same Ollama /api URL.
  const matching = await resolveBenchRuntimeProfile({
    ...base,
    judgeBaseUrl: "http://127.0.0.1:11434/",
  });
  assert.equal(matching.judgeProvider?.baseUrl, "http://127.0.0.1:11434/api");
});

test("local-lab runtime profile leaves providers unchanged when no runtime options are set", async () => {
  // The manifest-only common case must not sprout empty retryOptions or
  // disableThinking — applyLocalLabRuntimeOptions returns the config as-is.
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-local-lab-"));
  const manifestPath = path.join(root, "local-lab.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      profile: "local-lab",
      responder: {
        provider: "openai-compatible",
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "qwen3:14b",
        ctx: 16384,
        temperature: 0,
        seed: 1573,
      },
      judge: {
        provider: "openai-compatible",
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "gemma3:27b",
        ctx: 16384,
        temperature: 0,
        seed: 1573,
      },
      phases: "sequential",
    }),
  );

  const resolved = await resolveBenchRuntimeProfile({
    runtimeProfile: "local-lab",
    localLabManifestPath: manifestPath,
  });

  assert.equal(resolved.systemProvider?.retryOptions, undefined);
  assert.equal(resolved.systemProvider?.disableThinking, undefined);
  assert.equal(resolved.judgeProvider?.retryOptions, undefined);
  assert.equal(resolved.judgeProvider?.disableThinking, undefined);
});

test("local-lab runtime profile applies lcmObserveConcurrency to the effective config (cursor review: #1573 PR2 round 4)", async () => {
  // Regression: resolveLocalLabRuntimeProfile built effectiveRemnicConfig from
  // buildBenchBaselineRemnicConfig() only and never merged lcmObserveConcurrency,
  // so --ingest-concurrency silently no-op'd on local-lab (unlike baseline/real).
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-local-lab-"));
  const manifestPath = path.join(root, "local-lab.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      profile: "local-lab",
      responder: {
        provider: "openai-compatible",
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "qwen3:14b",
        ctx: 16384,
        temperature: 0,
        seed: 1573,
      },
      judge: {
        provider: "openai-compatible",
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "gemma3:27b",
        ctx: 16384,
        temperature: 0,
        seed: 1573,
      },
      phases: "sequential",
    }),
  );

  const resolved = await resolveBenchRuntimeProfile({
    runtimeProfile: "local-lab",
    localLabManifestPath: manifestPath,
    lcmObserveConcurrency: 4,
  });

  assert.equal(resolved.remnicConfig.lcmObserveConcurrency, 4);
  assert.equal(resolved.effectiveRemnicConfig.lcmObserveConcurrency, 4);
});
