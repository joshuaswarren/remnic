import path from "node:path";
import { readFile } from "node:fs/promises";

import {
  type FallbackLlmRuntimeContext,
  resolveRemnicPluginEntry,
  setCodexCliFallbackRunnerForProcess,
  type GatewayConfig,
  type CodexCliFallbackRunner,
} from "@remnic/core";
import type {
  BenchJudge,
  BenchResponder,
} from "./adapters/types.js";
import { buildBenchBaselineRemnicConfig } from "./adapters/remnic-adapter.js";
import {
  ASSISTANT_AGENT_CONFIG_KEY,
  ASSISTANT_JUDGE_CONFIG_KEY,
} from "./benchmarks/remnic/_assistant-common/default-agent.js";
import type { AssistantAgent } from "./benchmarks/remnic/_assistant-common/types.js";
import {
  createGatewayResponder,
  createProviderBackedJudge,
  createProviderBackedResponder,
  createProviderBackedStructuredJudge,
} from "./responders.js";
import type { ProviderFactoryConfig } from "./providers/types.js";
import { createProvider } from "./providers/factory.js";
import { isSecretKey } from "./security/secret-keys.js";
import type { BenchRuntimeProfile, BuiltInProvider, ProviderConfig } from "./types.js";
export type BenchModelSource = "plugin" | "gateway";

export interface ResolveBenchRuntimeProfileOptions {
  runtimeProfile?: BenchRuntimeProfile;
  remnicConfigPath?: string;
  openclawConfigPath?: string;
  modelSource?: BenchModelSource;
  gatewayAgentId?: string;
  fastGatewayAgentId?: string;
  systemProvider?: BuiltInProvider;
  systemModel?: string;
  systemBaseUrl?: string;
  systemApiKey?: string;
  systemCodexReasoningEffort?: ProviderConfig["reasoningEffort"];
  judgeProvider?: BuiltInProvider;
  judgeModel?: string;
  judgeBaseUrl?: string;
  judgeApiKey?: string;
  judgeCodexReasoningEffort?: ProviderConfig["reasoningEffort"];
  internalProvider?: BuiltInProvider;
  internalModel?: string;
  internalBaseUrl?: string;
  internalApiKey?: string;
  internalDisableThinking?: boolean;
  internalCodexReasoningEffort?: ProviderConfig["reasoningEffort"];
  requestTimeout?: number;
  max429WaitMs?: number;
  disableThinking?: boolean;
}

export interface ResolvedBenchRuntimeProfile {
  profile: BenchRuntimeProfile;
  remnicConfig: Record<string, unknown>;
  effectiveRemnicConfig: Record<string, unknown>;
  adapterOptions: {
    configOverrides: Record<string, unknown>;
    preserveRuntimeDefaults?: boolean;
    responder?: BenchResponder;
    judge?: BenchJudge;
  };
  systemProvider: ProviderConfig | null;
  judgeProvider: ProviderConfig | null;
  internalProvider: ProviderConfig | null;
}

const REDACTED_CONFIG_VALUE = "[redacted]";
const INTERNAL_GATEWAY_AGENT_ID = "remnic-bench-internal";
let codexCliFallbackRegistered = false;

export async function resolveBenchRuntimeProfile(
  options: ResolveBenchRuntimeProfileOptions,
): Promise<ResolvedBenchRuntimeProfile> {
  const profile = options.runtimeProfile ?? "baseline";
  const systemProvider = profile === "openclaw-chain"
    ? null
    : resolveProviderConfig(
      "system",
      options.systemProvider,
      options.systemModel,
      options.systemBaseUrl,
      options.requestTimeout,
      options.disableThinking,
      options.systemApiKey,
      options.max429WaitMs,
      options.systemCodexReasoningEffort,
    );
  const judgeProvider = resolveProviderConfig(
    "judge",
    options.judgeProvider,
    options.judgeModel,
    options.judgeBaseUrl,
    options.requestTimeout,
    options.disableThinking,
    options.judgeApiKey,
    options.max429WaitMs,
    options.judgeCodexReasoningEffort,
  );
  const internalProvider = applyInternalProviderDefaults(
    resolveProviderConfig(
      "internal",
      options.internalProvider,
      options.internalModel,
      options.internalBaseUrl,
      options.requestTimeout,
      options.internalDisableThinking,
      options.internalApiKey,
      options.max429WaitMs,
      options.internalCodexReasoningEffort,
    ),
  );
  const internalConfigOverrides = buildInternalRemnicConfigOverrides(
    internalProvider,
    { disableThinking: options.internalDisableThinking === true },
  );
  registerCodexCliFallbackRunnerIfNeeded(internalProvider);
  const responderFactoryConfig = systemProvider
    ? asProviderFactoryConfig(systemProvider)
    : undefined;
  const judgeFactoryConfig = judgeProvider
    ? asProviderFactoryConfig(judgeProvider)
    : undefined;
  const judgeProviderInstance = judgeFactoryConfig
    ? createProvider(judgeFactoryConfig)
    : undefined;
  const judge = judgeFactoryConfig
    ? createProviderBackedJudge(judgeFactoryConfig, judgeProviderInstance)
    : undefined;
  const structuredJudge = judgeFactoryConfig
    ? createProviderBackedStructuredJudge(judgeFactoryConfig, judgeProviderInstance)
    : undefined;

  if (profile === "baseline") {
    const responder = responderFactoryConfig
      ? createProviderBackedResponder(responderFactoryConfig)
      : undefined;
    const baselineConfig = buildBenchBaselineRemnicConfig();
    const baselineWithInternalLlm = {
      ...baselineConfig,
      ...internalConfigOverrides,
    };
    const effectiveRemnicConfig = withAssistantHooks(
      baselineWithInternalLlm,
      responder,
      structuredJudge,
    );
    return {
      profile,
      remnicConfig: sanitizePersistedConfig(baselineWithInternalLlm),
      effectiveRemnicConfig,
      adapterOptions: {
        configOverrides: effectiveRemnicConfig,
        responder,
        judge,
      },
      systemProvider,
      judgeProvider,
      internalProvider: internalProvider ? sanitizeProviderConfig(internalProvider) : null,
    };
  }

  if (profile === "real") {
    const responder = responderFactoryConfig
      ? createProviderBackedResponder(responderFactoryConfig)
      : undefined;
    const fileConfig = options.remnicConfigPath
      ? await loadRemnicConfigFile(options.remnicConfigPath)
      : {};
    const realProfileOverrides = {
      lcmEnabled: true,
      ...(options.modelSource ? { modelSource: options.modelSource } : {}),
      ...(options.gatewayAgentId ? { gatewayAgentId: options.gatewayAgentId } : {}),
      ...(options.fastGatewayAgentId
        ? { fastGatewayAgentId: options.fastGatewayAgentId }
        : {}),
      ...internalConfigOverrides,
    };
    const persistedRemnicConfig = sanitizePersistedConfig({
      ...fileConfig,
      ...realProfileOverrides,
    });
    const effectiveRemnicConfig = withAssistantHooks(
      {
        ...fileConfig,
        ...realProfileOverrides,
      },
      responder,
      structuredJudge,
    );
    return {
      profile,
      remnicConfig: persistedRemnicConfig,
      effectiveRemnicConfig,
      adapterOptions: {
        configOverrides: effectiveRemnicConfig,
        preserveRuntimeDefaults: true,
        responder,
        judge,
      },
      systemProvider,
      judgeProvider,
      internalProvider: internalProvider ? sanitizeProviderConfig(internalProvider) : null,
    };
  }

  const openclawRuntime = await loadOpenclawRuntimeConfig(options.openclawConfigPath);
  const gatewayConfig = openclawRuntime.gatewayConfig;
  const gatewayAgentId =
    options.gatewayAgentId ??
    asNonEmptyString(openclawRuntime.remnicConfig.gatewayAgentId);
  const fastGatewayAgentId =
    options.fastGatewayAgentId ??
    asNonEmptyString(openclawRuntime.remnicConfig.fastGatewayAgentId);
  const gatewayResponder = createGatewayResponder({
    gatewayConfig,
    agentId: gatewayAgentId,
    ...openclawRuntime.runtimeContext,
  });
  const persistedRemnicConfig = sanitizePersistedConfig(
    {
      ...openclawRuntime.remnicConfig,
      lcmEnabled: true,
      gatewayConfig: openclawRuntime.persistedGatewayConfig,
      modelSource: "gateway",
      ...(gatewayAgentId ? { gatewayAgentId } : {}),
      ...(fastGatewayAgentId ? { fastGatewayAgentId } : {}),
      ...internalConfigOverrides,
    },
  );
  const effectiveRemnicConfig = withAssistantHooks(
    {
      ...openclawRuntime.remnicConfig,
      lcmEnabled: true,
      gatewayConfig,
      modelSource: "gateway",
      ...(gatewayAgentId ? { gatewayAgentId } : {}),
      ...(fastGatewayAgentId ? { fastGatewayAgentId } : {}),
      ...internalConfigOverrides,
    },
    gatewayResponder,
    structuredJudge,
  );

  return {
    profile,
    remnicConfig: persistedRemnicConfig,
    effectiveRemnicConfig,
    adapterOptions: {
      configOverrides: effectiveRemnicConfig,
      preserveRuntimeDefaults: true,
      responder: gatewayResponder,
      judge,
    },
    systemProvider: null,
    judgeProvider,
    internalProvider: internalProvider ? sanitizeProviderConfig(internalProvider) : null,
  };
}

async function loadRemnicConfigFile(
  filePath: string,
): Promise<Record<string, unknown>> {
  const parsed = await loadJsonObject(filePath, "Remnic config");
  const remnic = parsed.remnic;
  if (isPlainObject(remnic)) {
    return { ...remnic };
  }
  const engram = parsed.engram;
  if (isPlainObject(engram)) {
    return { ...engram };
  }
  return parsed;
}

async function loadOpenclawRuntimeConfig(
  filePath: string | undefined,
): Promise<{
  remnicConfig: Record<string, unknown>;
  gatewayConfig: GatewayConfig;
  persistedGatewayConfig: GatewayConfig;
  runtimeContext: FallbackLlmRuntimeContext;
}> {
  if (!filePath) {
    throw new Error("openclaw-chain runtime profile requires an OpenClaw config path");
  }

  const parsed = await loadJsonObject(filePath, "OpenClaw config");
  const entry = resolveRemnicPluginEntry(parsed);
  const remnicConfig =
    isPlainObject(entry?.config) ? { ...entry.config } : {};

  const gatewayConfig: GatewayConfig = {
    ...(isPlainObject(parsed.agents) ? { agents: parsed.agents as GatewayConfig["agents"] } : {}),
    ...(isPlainObject(parsed.models) ? { models: parsed.models as GatewayConfig["models"] } : {}),
  };

  return {
    remnicConfig,
    gatewayConfig,
    persistedGatewayConfig: sanitizeGatewayConfig(gatewayConfig),
    runtimeContext: deriveOpenclawRuntimeContext(filePath),
  };
}

export function deriveOpenclawRuntimeContext(
  configPath: string,
): FallbackLlmRuntimeContext {
  const rootDir = path.dirname(path.resolve(configPath));
  return {
    agentDir: path.join(rootDir, "agents", "main", "agent"),
    workspaceDir: path.join(rootDir, "workspace"),
  };
}

async function loadJsonObject(
  filePath: string,
  label: string,
): Promise<Record<string, unknown>> {
  const raw = await readFile(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${label} at ${filePath} contains invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`${label} at ${filePath} must be a JSON object`);
  }

  return parsed;
}

function resolveProviderConfig(
  kind: "system" | "judge" | "internal",
  provider: BuiltInProvider | undefined,
  model: string | undefined,
  baseUrl: string | undefined,
  requestTimeout?: number,
  disableThinking?: boolean,
  apiKey?: string,
  max429WaitMs?: number,
  reasoningEffort?: ProviderConfig["reasoningEffort"],
): ProviderConfig | null {
  const hasProvider = typeof provider === "string";
  const hasModel = typeof model === "string" && model.trim().length > 0;
  const hasBaseUrl = typeof baseUrl === "string" && baseUrl.trim().length > 0;
  const hasApiKey = typeof apiKey === "string" && apiKey.trim().length > 0;
  const hasReasoningEffort = reasoningEffort !== undefined;

  if (!hasProvider && !hasModel && !hasBaseUrl && !hasApiKey && !hasReasoningEffort) {
    return null;
  }

  if (!hasProvider || !hasModel) {
    throw new Error(`${kind} provider requires both provider and model`);
  }

  // Issue #566 slice 5 — defense in depth: the CLI rejects
  // `--provider local-llm` without `--base-url`, but programmatic
  // callers that bypass the CLI must also get a clear error rather
  // than silently falling through to an OpenAI default URL in the
  // provider factory.
  if (provider === "local-llm" && !hasBaseUrl) {
    throw new Error(
      `${kind} provider "local-llm" requires a baseUrl ` +
        "(e.g. http://localhost:8080/v1 for llama.cpp).",
    );
  }
  if (reasoningEffort !== undefined && provider !== "codex-cli") {
    throw new Error(
      `${kind} Codex reasoning effort requires provider "codex-cli"`,
    );
  }

  return {
    provider,
    model: model.trim(),
    ...(hasBaseUrl ? { baseUrl: baseUrl!.trim() } : {}),
    ...(hasApiKey ? { apiKey: apiKey!.trim() } : {}),
    ...(requestTimeout != null || max429WaitMs != null
      ? { retryOptions: {
          ...(requestTimeout != null ? { timeoutMs: requestTimeout } : {}),
          ...(max429WaitMs != null ? { max429WaitMs } : {}),
        } }
      : {}),
    ...(disableThinking ? { disableThinking: true } : {}),
    ...(provider === "codex-cli" ? { reasoningEffort: reasoningEffort ?? "xhigh" } : {}),
  };
}

function applyInternalProviderDefaults(
  config: ProviderConfig | null,
): ProviderConfig | null {
  if (!config || config.baseUrl) {
    return config;
  }

  const baseUrl = defaultInternalBaseUrl(config.provider);
  return baseUrl ? { ...config, baseUrl } : config;
}

function buildInternalRemnicConfigOverrides(
  config: ProviderConfig | null,
  options: { disableThinking: boolean },
): Record<string, unknown> {
  const thinkingOverrides = options.disableThinking
    ? {
        localLlmDisableThinking: true,
        reasoningEffort: "none",
      }
    : {};

  if (!config) {
    return thinkingOverrides;
  }

  if (config.provider === "local-llm") {
    return {
      ...thinkingOverrides,
      modelSource: "plugin",
      localLlmEnabled: true,
      localLlmFallback: false,
      localLlmUrl: config.baseUrl,
      localLlmModel: config.model,
      ...(config.apiKey ? { localLlmApiKey: config.apiKey } : {}),
      ...(config.retryOptions?.timeoutMs
        ? { localLlmTimeoutMs: config.retryOptions.timeoutMs }
        : {}),
    };
  }

  return {
    ...thinkingOverrides,
    modelSource: "gateway",
    localLlmEnabled: false,
    gatewayConfig: buildInternalGatewayConfig(config, options),
    gatewayAgentId: INTERNAL_GATEWAY_AGENT_ID,
    fastGatewayAgentId: INTERNAL_GATEWAY_AGENT_ID,
  };
}

function buildInternalGatewayConfig(
  config: ProviderConfig,
  options: { disableThinking: boolean },
): GatewayConfig {
  const providerId = INTERNAL_GATEWAY_AGENT_ID;
  const modelRef = `${providerId}/${config.model}`;
  const timeoutMs = config.retryOptions?.timeoutMs;

  return {
    agents: {
      defaults: {
        model: { primary: modelRef },
        ...(options.disableThinking ? { thinking: { mode: "off" as const } } : {}),
      },
      list: [
        {
          id: INTERNAL_GATEWAY_AGENT_ID,
          name: "Remnic bench internal provider",
          model: { primary: modelRef },
        },
      ],
    },
    models: {
      providers: {
        [providerId]: {
          baseUrl: config.baseUrl ?? defaultInternalBaseUrl(config.provider) ?? "",
          api: gatewayProviderApi(config.provider),
          ...(config.apiKey ? { apiKey: config.apiKey } : {}),
          ...(config.disableThinking || options.disableThinking ? { disableThinking: true } : {}),
          ...(config.reasoningEffort ? { codexCliReasoningEffort: config.reasoningEffort } : {}),
          ...(timeoutMs ? { retryOptions: { timeoutMs } } : {}),
          models: [{ id: config.model, name: config.model }],
        },
      },
    },
  };
}

function gatewayProviderApi(provider: BuiltInProvider): string {
  if (provider === "anthropic") {
    return "anthropic-messages";
  }
  if (provider === "codex-cli") {
    return "codex-cli";
  }
  if (provider === "ollama") {
    return "ollama-chat";
  }
  if (provider === "openai") {
    return "openai-responses";
  }
  return "openai-completions";
}

function defaultInternalBaseUrl(provider: BuiltInProvider): string | undefined {
  switch (provider) {
    case "openai":
      return "https://api.openai.com/v1";
    case "anthropic":
      return "https://api.anthropic.com/v1";
    case "litellm":
      return "http://localhost:4000";
    case "ollama":
      return "http://localhost:11434/api";
    case "codex-cli":
      return "codex-cli://local";
    case "local-llm":
      return undefined;
    default: {
      const exhaustive: never = provider;
      return exhaustive;
    }
  }
}

function sanitizeProviderConfig(config: ProviderConfig): ProviderConfig {
  return {
    ...config,
    ...(config.apiKey ? { apiKey: REDACTED_CONFIG_VALUE } : {}),
  };
}

function registerCodexCliFallbackRunnerIfNeeded(config: ProviderConfig | null): void {
  if (!config || config.provider !== "codex-cli" || codexCliFallbackRegistered) {
    return;
  }

  const runner: CodexCliFallbackRunner = async (request) => {
    const reasoningEffort = asCodexReasoningEffort(
      request.config.codexCliReasoningEffort ?? request.config.reasoningEffort,
    );
    const provider = createProvider({
      provider: "codex-cli",
      model: request.modelId,
      ...(typeof request.config.apiKey === "string"
        ? { apiKey: request.config.apiKey }
        : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(typeof request.config.codexCliExecutable === "string"
        ? { executable: request.config.codexCliExecutable }
        : typeof request.config.executable === "string"
          ? { executable: request.config.executable }
          : {}),
      ...(typeof request.config.retryOptions?.timeoutMs === "number" ||
        typeof request.options.timeoutMs === "number"
        ? {
            retryOptions: {
              timeoutMs:
                typeof request.config.retryOptions?.timeoutMs === "number"
                  ? request.config.retryOptions.timeoutMs
                  : request.options.timeoutMs,
            },
          }
        : {}),
    });
    const split = splitCodexFallbackMessages(request.messages);
    const completion = await provider.complete(split.prompt, {
      systemPrompt: split.systemPrompt,
      temperature: 0.3,
      maxTokens: 4096,
    });
    return {
      content: completion.text,
      usage: {
        inputTokens: completion.tokens.input,
        outputTokens: completion.tokens.output,
        totalTokens: completion.tokens.input + completion.tokens.output,
      },
    };
  };

  setCodexCliFallbackRunnerForProcess(runner);
  codexCliFallbackRegistered = true;
}

function asCodexReasoningEffort(
  value: unknown,
): ProviderConfig["reasoningEffort"] | undefined {
  return value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
    ? value
    : undefined;
}

function splitCodexFallbackMessages(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
): { systemPrompt?: string; prompt: string } {
  const systemPrompt = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n")
    .trim();
  const prompt = messages
    .filter((message) => message.role !== "system")
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n\n")
    .trim();
  return {
    ...(systemPrompt ? { systemPrompt } : {}),
    prompt: prompt || messages.map((message) => message.content).join("\n\n"),
  };
}

function withAssistantHooks(
  config: Record<string, unknown>,
  responder: BenchResponder | undefined,
  structuredJudge: ReturnType<typeof createProviderBackedStructuredJudge> | undefined,
): Record<string, unknown> {
  const next = { ...config };

  if (responder) {
    next[ASSISTANT_AGENT_CONFIG_KEY] = createAssistantAgentFromResponder(responder);
  }
  if (structuredJudge) {
    next[ASSISTANT_JUDGE_CONFIG_KEY] = structuredJudge;
  }

  return next;
}

function createAssistantAgentFromResponder(
  responder: BenchResponder,
): AssistantAgent {
  return {
    async respond(request) {
      const response = await responder.respond(request.prompt, request.memoryView);
      return response.text;
    },
  };
}

function asProviderFactoryConfig(config: ProviderConfig): ProviderFactoryConfig {
  return {
    provider: config.provider,
    model: config.model,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(config.retryOptions ? { retryOptions: config.retryOptions } : {}),
    ...(config.disableThinking ? { disableThinking: config.disableThinking } : {}),
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
  } as ProviderFactoryConfig;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function sanitizeGatewayConfig(config: GatewayConfig): GatewayConfig {
  const sanitized = sanitizePersistedConfig(config);
  return isPlainObject(sanitized) ? sanitized as GatewayConfig : {};
}

function sanitizePersistedConfig(config: unknown): Record<string, unknown> {
  const sanitized = sanitizePersistedValue(config);
  return isPlainObject(sanitized) ? sanitized : {};
}

function sanitizePersistedValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizePersistedValue(entry));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isSecretKey(key)) {
      next[key] = REDACTED_CONFIG_VALUE;
      continue;
    }
    next[key] = sanitizePersistedValue(entry);
  }
  return next;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
